import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { PLANNER_DEFAULT_PROJECT } from '@capiro/strategy-verifier';
import { PlannerService } from './planner.service.js';
import { TASK_CREATE_RECEIPT } from './planner-task-create-command.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { PlannerLinksService } from './planner-links.service.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';

const ctx: AuthTenantContext = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  clerkUserId: 'user_owner',
  role: 'org:member',
};
const REQUEST = '20000000-0000-4000-8000-000000000001';
const PROJECT = '30000000-0000-4000-8000-000000000001';
const CLIENT = '40000000-0000-4000-8000-000000000001';
const command = {
  requestId: REQUEST,
  data: { name: 'Synthetic follow-up', dueOn: '2026-11-01', assigneeId: 'user_assignee' },
};
// Real task validation, ACLs, rule evaluation, persistence and receipt paths.
// This rollback/serialization double models the existing tenant transaction lock;
// it is not native Prisma/RLS/MVCC qualification. No network or database is opened.
function harness() {
  type Row = Record<string, any>;
  let state: Record<'tasks' | 'receipts' | 'events' | 'inbox', Row[]> = {
    tasks: [],
    receipts: [],
    events: [],
    inbox: [],
  };
  const people = [
    { id: 'user_owner', name: 'Owner' },
    { id: 'user_assignee', name: 'Assignee' },
    { id: 'user_other', name: 'Other' },
  ];
  const projects: Row[] = [
    {
      id: PROJECT,
      tenantId: ctx.tenantId,
      ownerId: ctx.clerkUserId,
      version: 1,
      archived: false,
      data: { ...PLANNER_DEFAULT_PROJECT, name: 'Project', privacy: 'private' },
    },
  ];
  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'data') return row.data?.requestId === value.equals;
      if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key]);
      return row[key] === value;
    });
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async () => people),
    spPlannerProject: {
      findMany: jest.fn(async ({ where }) => projects.filter((r) => matches(r, where))),
    },
    spPlannerTask: {
      findFirst: jest.fn(async ({ where }) => state.tasks.find((r) => matches(r, where)) ?? null),
      findMany: jest.fn(async ({ where }) => state.tasks.filter((r) => matches(r, where))),
      create: jest.fn(async ({ data }) => {
        const row = {
          id: randomUUID(),
          version: 1,
          archived: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.tasks.push(row);
        return row;
      }),
    },
    spPlannerResource: {
      findFirst: jest.fn(
        async ({ where }) => state.receipts.find((r) => matches(r, where)) ?? null,
      ),
      findMany: jest.fn(async ({ where }) => state.receipts.filter((r) => matches(r, where))),
      create: jest.fn(async ({ data }) => {
        const row = { id: randomUUID(), version: 1, archived: false, ...data };
        state.receipts.push(row);
        return row;
      }),
    },
    spPlannerEvent: {
      create: jest.fn(async ({ data }) => {
        const row = { id: randomUUID(), createdAt: new Date(), ...data };
        state.events.push(row);
        return row;
      }),
      findMany: jest.fn(async () => []),
    },
    spPlannerInbox: {
      create: jest.fn(async ({ data }) => {
        state.inbox.push(data);
        return data;
      }),
    },
  };
  let pending = Promise.resolve();
  const prisma = {
    withTenant: jest.fn(async (_tenant, fn) => {
      const beforeLock = pending;
      let release!: () => void;
      pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await beforeLock;
      const snapshot = structuredClone(state);
      try {
        return await fn(tx);
      } catch (error) {
        state = snapshot;
        throw error;
      } finally {
        release();
      }
    }),
  };
  const links = { validate: jest.fn(async () => undefined) };
  return {
    service: new PlannerService(
      prisma as unknown as PrismaService,
      links as unknown as PlannerLinksService,
    ),
    tx,
    links,
    people,
    projects,
    state: () => state,
  };
}

// Independent assertions; reuse the author's synthetic transaction store only.
describe('independent durable task command recovery', () => {
  it('recovers a committed task when the transaction response is lost, with no duplicate effects', async () => {
    const h = harness();
    const prisma = (h.service as unknown as { prisma: { withTenant: jest.Mock } }).prisma;
    const original = prisma.withTenant.getMockImplementation()!;
    let loseResponse = true;
    prisma.withTenant.mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args);
      if (loseResponse) { loseResponse = false; throw new Error('Synthetic committed-response loss'); }
      return result;
    });
    await expect(h.service.createTaskCommand(ctx, command)).rejects.toThrow('Synthetic committed-response loss');
    expect(h.state().tasks).toHaveLength(1);
    expect(h.state().receipts).toHaveLength(1);
    const before = structuredClone(h.state());
    const recovered = await h.service.taskCreateCommand(ctx, REQUEST);
    expect(await h.service.createTaskCommand(ctx, command)).toEqual(recovered);
    expect(h.state()).toEqual(before);
  });
  it('rolls back task and receipt if current task projection fails after receipt insertion', async () => {
    const h = harness();
    const originalQuery = h.tx.$queryRaw.getMockImplementation()!;
    let failProjection = true;
    (h.tx.$queryRaw as jest.Mock).mockImplementation(async (...args: unknown[]) => {
      if (failProjection && String(args[0]).includes('FROM sp_planner_events')) {
        failProjection = false;
        throw new Error('Synthetic projection failure');
      }
      return originalQuery();
    });
    await expect(h.service.createTaskCommand(ctx, command)).rejects.toThrow('Synthetic projection failure');
    expect(h.tx.spPlannerResource.create).toHaveBeenCalledTimes(1);
    expect(h.state()).toEqual({ tasks: [], receipts: [], events: [], inbox: [] });
    await expect(h.service.taskCreateCommand(ctx, REQUEST)).rejects.toMatchObject({ status: 404 });
    await h.service.createTaskCommand(ctx, command);
    expect(h.state().tasks).toHaveLength(1);
    expect(h.state().receipts).toHaveLength(1);
  });
  it('replays against current authorized links after an obsolete original link is removed and revoked', async () => {
    const h = harness();
    const linked = { ...command, data: { ...command.data, clientId: CLIENT } };
    const receipt = await h.service.createTaskCommand(ctx, linked, 'Bearer synthetic');
    h.state().tasks[0]!.data.clientId = null;
    (h.links.validate as jest.Mock).mockImplementation(async (data: { clientId: string | null }) => {
      if (data.clientId === CLIENT) throw new ForbiddenException('Original client revoked');
    });
    const before = structuredClone(h.state());
    expect(await h.service.taskCreateCommand(ctx, REQUEST, 'Bearer synthetic')).toEqual(receipt);
    await expect(h.service.createTaskCommand(ctx, linked, 'Bearer synthetic')).resolves.toEqual(receipt);
    expect(h.state()).toEqual(before);
  });
  it('refuses replay and recovery while the revoked original link remains current', async () => {
    const h = harness();
    const linked = { ...command, data: { ...command.data, clientId: CLIENT } };
    await h.service.createTaskCommand(ctx, linked, 'Bearer synthetic');
    h.links.validate.mockRejectedValue(new ForbiddenException('Current client revoked'));
    await expect(h.service.taskCreateCommand(ctx, REQUEST, 'Bearer synthetic')).rejects.toMatchObject({ status: 403 });
    await expect(h.service.createTaskCommand(ctx, linked, 'Bearer synthetic')).rejects.toMatchObject({ status: 403 });
    expect(h.state().tasks).toHaveLength(1);
    expect(h.state().receipts).toHaveLength(1);
  });
  it.each([
    [{ tags: ['alpha', 'beta'] }, { tags: ['beta', 'alpha'] }],
    [{}, { clientId: null }],
  ])('does not conflate array order or omitted/null payloads %j versus %j', async (first, second) => {
    const h = harness();
    await h.service.createTaskCommand(ctx, { ...command, data: { ...command.data, ...first } });
    const before = structuredClone(h.state());
    await expect(h.service.createTaskCommand(ctx, { ...command, data: { ...command.data, ...second } })).rejects.toMatchObject({ status: 409 });
    expect(h.state()).toEqual(before);
  });
  it.each(['tenantId', 'ownerId', 'kind'])('defensively rejects a receipt with foreign %s even if persistence returns it', async (key) => {
    const h = harness();
    await h.service.createTaskCommand(ctx, command);
    const receipt = h.state().receipts[0]!;
    h.tx.spPlannerResource.findFirst.mockResolvedValue({ ...receipt, [key]: 'foreign' });
    await expect(h.service.taskCreateCommand(ctx, REQUEST)).rejects.toMatchObject({ status: 404 });
  });
});

it('independent input bound: rejects deeply nested invalid task data before recursive hashing', async () => {
  const h = harness();
  // Valid 30KB JSON, well below the server body limit. Task values cannot contain this nesting.
  const nested = JSON.parse('{"name":"Synthetic","customValues":{"50000000-0000-4000-8000-000000000001":' + '{"x":'.repeat(5000) + 'null' + '}'.repeat(5000) + '}}');
  await expect(h.service.createTaskCommand(ctx, { requestId: REQUEST, data: nested })).rejects.toMatchObject({ status: 400 });
  expect(h.tx.spPlannerTask.create).not.toHaveBeenCalled();
  expect(h.tx.$executeRaw).not.toHaveBeenCalled();
});
