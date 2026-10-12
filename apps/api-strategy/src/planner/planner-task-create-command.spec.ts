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

describe('durable Planner task create command', () => {
  it('creates through the canonical task owner and read-only recovery survives a lost response', async () => {
    const h = harness();
    const result = await h.service.createTaskCommand(ctx, command, 'Bearer synthetic');
    expect(result).toEqual({
      requestId: REQUEST,
      status: 'completed',
      taskId: h.state().tasks[0]!.id,
    });
    expect(h.state().tasks[0]!.data.dueOn).toBe('2026-11-01');
    expect(h.state().tasks[0]!.data.dueTime).toBeNull();
    expect(h.state().receipts[0]).toMatchObject({
      tenantId: ctx.tenantId,
      ownerId: ctx.clerkUserId,
      kind: TASK_CREATE_RECEIPT,
      data: { requestId: REQUEST, receiptVersion: 1, taskId: result.taskId },
    });
    const before = structuredClone(h.state());
    h.tx.$executeRaw.mockClear();
    expect(await h.service.taskCreateCommand(ctx, REQUEST, 'Bearer synthetic')).toEqual(result);
    expect(h.state()).toEqual(before);
    expect(h.tx.$executeRaw).not.toHaveBeenCalled();
    expect(Object.keys(result).sort()).toEqual(['requestId', 'status', 'taskId']);
  });
  it('replays equivalent object key order once, including concurrent synthetic requests', async () => {
    const h = harness();
    const reordered = {
      requestId: REQUEST.toUpperCase(),
      data: { assigneeId: 'user_assignee', dueOn: '2026-11-01', name: 'Synthetic follow-up' },
    };
    const results = await Promise.all([
      h.service.createTaskCommand(ctx, command),
      h.service.createTaskCommand(ctx, reordered),
      h.service.createTaskCommand(ctx, command),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    expect(h.state().tasks).toHaveLength(1);
    expect(h.state().receipts).toHaveLength(1);
    expect(h.state().events).toHaveLength(1);
    expect(h.state().inbox).toHaveLength(1);
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(3);
    expect(h.tx.$executeRaw.mock.calls[0]).toEqual([
      expect.arrayContaining([expect.stringContaining('pg_advisory_xact_lock')]),
      `planner:${ctx.tenantId}`,
    ]);
  });
  it('rejects changed data without repeated task, event or inbox writes', async () => {
    const h = harness();
    await h.service.createTaskCommand(ctx, command);
    const before = structuredClone(h.state());
    await expect(
      h.service.createTaskCommand(ctx, { ...command, data: { ...command.data, name: 'Changed' } }),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.state()).toEqual(before);
  });
  it('rolls back task/events/inbox when receipt write fails, then safely retries', async () => {
    const h = harness();
    h.tx.spPlannerResource.create.mockRejectedValueOnce(new Error('synthetic receipt failure'));
    await expect(h.service.createTaskCommand(ctx, command)).rejects.toThrow(
      'synthetic receipt failure',
    );
    expect(h.state()).toEqual({ tasks: [], receipts: [], events: [], inbox: [] });
    await expect(h.service.taskCreateCommand(ctx, REQUEST)).rejects.toMatchObject({ status: 404 });
    await h.service.createTaskCommand(ctx, command);
    expect(h.state().tasks).toHaveLength(1);
    expect(h.state().receipts).toHaveLength(1);
  });
  it.each(['tenant', 'actor'])(
    'scopes the same request key to its authenticated %s',
    async (kind) => {
      const h = harness();
      const first = await h.service.createTaskCommand(ctx, command);
      const other =
        kind === 'tenant'
          ? { ...ctx, tenantId: '10000000-0000-4000-8000-000000000002' }
          : { ...ctx, clerkUserId: 'user_other' };
      await expect(h.service.taskCreateCommand(other, REQUEST)).rejects.toMatchObject({
        status: 404,
      });
      const second = await h.service.createTaskCommand(other, command);
      expect(second.taskId).not.toBe(first.taskId);
      expect(h.state().receipts).toHaveLength(2);
    },
  );
  it.each([null, '', 'malformed', '30000000-0000-0000-0000-000000000001'])(
    'refuses malformed request ID %s before writes',
    async (requestId) => {
      const h = harness();
      await expect(
        h.service.createTaskCommand(ctx, { ...command, requestId }),
      ).rejects.toMatchObject({ status: 400 });
      expect(h.tx.spPlannerTask.create).not.toHaveBeenCalled();
    },
  );
  it.each(['tenantId', 'actorId', 'version', 'archived', 'sourceType'])(
    'refuses caller-controlled %s authority',
    async (field) => {
      const h = harness();
      await expect(
        h.service.createTaskCommand(ctx, { ...command, [field]: 'forged' }),
      ).rejects.toMatchObject({ status: 400 });
      expect(h.tx.spPlannerTask.create).not.toHaveBeenCalled();
    },
  );
  it.each(['create', 'replay', 'recover'])('refuses inactive actor on %s', async (mode) => {
    const h = harness();
    if (mode !== 'create') await h.service.createTaskCommand(ctx, command);
    h.people.splice(0, 1);
    await expect(
      mode === 'recover'
        ? h.service.taskCreateCommand(ctx, REQUEST)
        : h.service.createTaskCommand(ctx, command),
    ).rejects.toMatchObject({ status: mode === 'create' ? 400 : 403 });
    expect(h.state().tasks).toHaveLength(mode === 'create' ? 0 : 1);
  });
  it('uses canonical active Clerk assignee membership checks', async () => {
    const h = harness();
    await expect(
      h.service.createTaskCommand(ctx, {
        ...command,
        data: { ...command.data, assigneeId: 'foreign_or_core_uuid' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.state().receipts).toHaveLength(0);
  });
  it.each(['create', 'replay', 'recover'])(
    'enforces current project grants on %s',
    async (mode) => {
      const h = harness();
      const scoped = {
        ...command,
        data: {
          name: 'Project task',
          memberships: [{ projectId: PROJECT, sectionId: null, position: 0 }],
        },
      };
      if (mode !== 'create') await h.service.createTaskCommand(ctx, scoped);
      h.projects[0]!.ownerId = 'user_other';
      await expect(
        mode === 'recover'
          ? h.service.taskCreateCommand(ctx, REQUEST)
          : h.service.createTaskCommand(ctx, scoped),
      ).rejects.toMatchObject({ status: 404 });
      expect(h.state().tasks).toHaveLength(mode === 'create' ? 0 : 1);
    },
  );
  it.each(['replay', 'recover'])(
    'rechecks current task links on %s, even after task editing',
    async (mode) => {
      const h = harness();
      await h.service.createTaskCommand(ctx, command);
      h.state().tasks[0]!.data.clientId = CLIENT;
      h.links.validate.mockRejectedValue(new ForbiddenException('Client revoked'));
      await expect(
        mode === 'recover'
          ? h.service.taskCreateCommand(ctx, REQUEST, 'Bearer synthetic')
          : h.service.createTaskCommand(ctx, command, 'Bearer synthetic'),
      ).rejects.toMatchObject({ status: 403 });
      expect(h.links.validate).toHaveBeenLastCalledWith(
        { clientId: CLIENT, meetingId: null },
        'Bearer synthetic',
      );
      expect(h.state().tasks).toHaveLength(1);
    },
  );
  it('never recreates a task missing behind its durable receipt', async () => {
    const h = harness();
    await h.service.createTaskCommand(ctx, command);
    h.state().tasks.length = 0;
    await expect(h.service.createTaskCommand(ctx, command)).rejects.toMatchObject({ status: 404 });
    expect(h.state().tasks).toHaveLength(0);
    expect(h.state().receipts).toHaveLength(1);
  });
  it('hides internal receipts from generic resource reads and modifications', async () => {
    const h = harness();
    await h.service.createTaskCommand(ctx, command);
    expect(await h.service.resources(ctx)).toEqual([]);
    const receipt = h.state().receipts[0]!;
    await expect(
      h.service.saveResource(ctx, receipt.id, { version: 1, data: {} }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      h.service.saveResource(ctx, null, { kind: TASK_CREATE_RECEIPT, name: 'forged', data: {} }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it.each([
    { dueOn: '2026-02-30' },
    { dueOn: '2026-11-01', dueTime: '09:00', timeZone: 'Invalid/Zone' },
  ])('retains canonical date/time rejection for %j', async (due) => {
    const h = harness();
    await expect(
      h.service.createTaskCommand(ctx, { ...command, data: { ...command.data, ...due } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.state().tasks).toHaveLength(0);
  });
  it.each([
    ['2026-03-08', '02:30', '2026-03-08T07:30:00.000Z'],
    ['2026-11-01', '01:30', '2026-11-01T05:30:00.000Z'],
  ])('preserves canonical DST policy for %s %s', async (dueOn, dueTime, deadlineAt) => {
    const h = harness();
    await h.service.createTaskCommand(ctx, {
      ...command,
      data: { ...command.data, dueOn, dueTime, timeZone: 'America/New_York' },
    });
    expect(h.state().tasks[0]!.data).toMatchObject({
      dueOn,
      dueTime,
      timeZone: 'America/New_York',
      deadlineAt,
    });
  });
});
