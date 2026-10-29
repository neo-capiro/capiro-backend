import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PLANNER_DEFAULT_PROJECT, PLANNER_DEFAULT_TASK } from '@capiro/strategy-verifier';
import { createHash } from 'node:crypto';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StrategyFlagsService } from '../flags/strategy-flags.service.js';
import { PlannerService } from '../planner/planner.service.js';
import { PlannerLinksService } from '../planner/planner-links.service.js';
import { SavedHistoryService } from './saved-history.service.js';
import { SavedReadsService } from './saved-reads.service.js';
import {
  parseSavedRead,
  savedAfter,
  savedCursor,
  savedReadPage,
  SAVED_READ_MAX_BYTES,
} from './saved-reads.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ctx: AuthTenantContext = {
  tenantId: id(1),
  clerkUserId: 'user_synthetic',
  role: 'standard_user',
};
const clientId = id(10),
  otherClient = id(11),
  now = new Date('2026-10-27T00:00:00Z');
const bearer = 'Bearer synthetic-only';
const request = { kind: 'planner_projects' as const, clientId };

function fixture() {
  const project = {
    id: id(20),
    tenantId: ctx.tenantId,
    ownerId: ctx.clerkUserId,
    version: 2,
    archived: false,
    createdAt: now,
    updatedAt: now,
    data: { ...PLANNER_DEFAULT_PROJECT, name: 'Saved project', clientId },
  };
  const task = {
    ...project,
    id: id(30),
    assigneeId: null,
    parentId: null,
    projectIds: [],
    completedAt: null,
    data: { ...PLANNER_DEFAULT_TASK, name: 'Saved task', clientId },
  };
  const event = {
    id: id(40),
    tenantId: ctx.tenantId,
    taskId: task.id,
    projectId: null,
    resourceId: null,
    actorId: ctx.clerkUserId,
    kind: 'comment',
    text: 'Original',
    minutes: null,
    details: {},
    createdAt: now,
  };
  const state = {
    project,
    task,
    event,
    objective: true,
    member: true,
    wallGrant: true,
    status: 200,
  };
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      calls.push({ text, values });
      if (text.includes('FROM tenants'))
        return state.member ? [{ userId: id(2), memoryWall: true }] : [];
      if (text.includes('FROM client_memory_access')) return state.wallGrant ? [{ id: id(3) }] : [];
      if (text.includes('FROM client_objectives')) return state.objective ? [{ version: 5 }] : [];
      if (text.includes('FROM client_objective_revisions'))
        return [
          {
            id: id(50),
            clientId,
            objectiveId: id(51),
            version: 1,
            operation: 'created',
            actorUserId: id(2),
            snapshot: { outcome: 'Saved original outcome' },
            createdAt: now,
          },
        ];
      if (text.includes('FROM sp_planner_projects')) return [project];
      if (text.includes('FROM sp_planner_tasks')) return [task];
      if (text.includes('FROM unnest'))
        return [
          {
            id: id(41),
            eventId: event.id,
            version: 2,
            text: 'Authoritative correction',
            removed: false,
            actorId: ctx.clerkUserId,
            createdAt: now,
          },
        ];
      return [];
    }),
    spPlannerProject: {
      findFirst: jest.fn(async () => project),
      findMany: jest.fn(async () => [project]),
    },
    spPlannerTask: { findFirst: jest.fn(async () => task), findMany: jest.fn(async () => []) },
    spPlannerEvent: {
      findFirst: jest.fn(async () => event),
      findMany: jest.fn(async () => [event]),
    },
    spStrategy: { findFirst: jest.fn(async () => ({ id: id(60) })) },
    spVersion: {
      findFirst: jest.fn(async () => ({ id: id(61) })),
      findMany: jest.fn(async () => [
        {
          id: id(61),
          strategyId: id(60),
          snapshot: { meta: { id: id(60), clientId, title: 'Saved title' }, nodes: [] },
          note: 'Saved edit',
          authorKind: 'person',
          authorUserId: ctx.clerkUserId,
          coalescible: true,
          restoredFromVersionId: null,
          createdAt: now,
        },
      ]),
    },
    spActivityLog: {
      findFirst: jest.fn(async () => ({ id: id(70) })),
      findMany: jest.fn(async () => [
        {
          id: id(70),
          entityType: 'strategy',
          entityId: id(60),
          action: 'version.restored',
          actorUserId: ctx.clerkUserId,
          authorKind: 'person',
          occurredAt: now,
        },
      ]),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant, run) => run(tx)),
    withTenantUser: jest.fn(async (_tenant, _user, run) => run(tx)),
  } as unknown as PrismaService;
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      ({
        status: state.status,
        ok: state.status === 200,
        body: { cancel: jest.fn() },
      }) as unknown as Response,
  );
  const links = new PlannerLinksService(
    new ConfigService({ API_INTERNAL_URL: 'https://synthetic.invalid' }),
  );
  const flags = { isEnabled: jest.fn(async () => true) };
  const planner = new PlannerService(prisma, links);
  const history = new SavedHistoryService(prisma);
  const service = new SavedReadsService(
    planner,
    links,
    history,
    flags as unknown as StrategyFlagsService,
  );
  return { state, tx, prisma, fetch, links, flags, planner, history, service, calls };
}
afterEach(() => jest.restoreAllMocks());

describe('closed selected-client read and bounded record envelope', () => {
  it.each([
    {},
    { ...request, tenantId: id(1) },
    { ...request, clientId: null },
    { ...request, archived: 'true' },
    { ...request, sql: 'select *' },
    { kind: 'planner_task', clientId },
    { kind: 'strategy_versions', clientId },
  ])('refuses invalid selector %p', (raw) => {
    expect(() => parseSavedRead(raw)).toThrow(BadRequestException);
  });
  it('binds continuation to the complete selector and refuses cross-client/kind/parent reuse', () => {
    const cursor = savedCursor(request, id(100));
    expect(savedAfter({ ...request, cursor })).toBe(id(100));
    for (const changed of [
      { clientId: otherClient },
      { kind: 'planner_tasks' as const },
      { archived: true },
    ])
      expect(() => savedAfter({ ...request, ...changed, cursor })).toThrow(BadRequestException);
  });
  it('packs whole multibyte rows and resumes at the last emitted identity', () => {
    const page = savedReadPage(request, {
      items: [1, 2, 3].map((n) => ({ id: id(n), text: '界'.repeat(40_000) })),
      nextCursor: null,
    });
    expect(page.items).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(
      SAVED_READ_MAX_BYTES,
    );
    expect(page.coverage.byteTruncated).toBe(true);
    expect(savedAfter({ ...request, cursor: page.nextCursor! })).toBe(id(2));
    expect(page.items[0]!.record.text).toHaveLength(40_000);
    expect(() =>
      savedReadPage(request, {
        items: [{ id: id(1), text: '界'.repeat(90_000) }],
        nextCursor: null,
      }),
    ).toThrow(PayloadTooLargeException);
  });
});

describe('actual saved owners with finite database/HTTP doubles', () => {
  it('returns owner project fields and requires the canonical client check on both sides', async () => {
    const f = fixture(),
      result = await f.service.read(ctx, request, bearer);
    expect(result.items[0]!.record).toMatchObject({
      id: id(20),
      name: 'Saved project',
      access: 'admin',
      version: 2,
    });
    expect(result.items[0]!.source.relation).toBe('sp_planner_projects');
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls[0]).toEqual([
      'https://synthetic.invalid/api/clients/' + clientId,
      expect.objectContaining({ headers: { authorization: bearer }, redirect: 'error' }),
    ]);
    expect(f.calls[0]!.text).toContain("lower(data->>'clientId')");
    expect(f.calls[0]!.text).toContain('LIMIT 101');
    expect(f.calls[0]!.values).toContain(ctx.tenantId);
  });
  it.each([401, 403, 404, 503])(
    'refuses initial client authority %s without reading owner data',
    async (status) => {
      const f = fixture();
      f.state.status = status;
      await expect(f.service.read(ctx, request, bearer)).rejects.toThrow();
      expect(f.prisma.withTenant).not.toHaveBeenCalled();
    },
  );
  it('discards successful content if canonical authority is revoked during the owner read', async () => {
    const f = fixture();
    jest.spyOn(f.planner, 'savedProjects').mockImplementation(async () => {
      f.state.status = 403;
      return { items: [], nextCursor: null };
    });
    await expect(f.service.read(ctx, request, bearer)).rejects.toThrow(ForbiddenException);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it('uses the task owner and hides references and project custom fields without grants', async () => {
    const f = fixture();
    f.state.task.data = {
      ...f.state.task.data,
      dependencies: [id(99)],
      customValues: { [id(90)]: 'Hidden' },
    };
    const result = await f.service.read(ctx, { kind: 'planner_tasks', clientId }, bearer);
    expect(result.items[0]!.record).toMatchObject({
      id: id(30),
      dependencies: [],
      customValues: {},
      access: 'editor',
    });
    expect(
      f.calls.some(
        (c) => c.text.includes("lower(data->>'clientId')") && c.text.includes('collaborators'),
      ),
    ).toBe(true);
  });
  it('pages the new client-filtered task query and binds UUID case, tenant and cursor as values', async () => {
    const f = fixture(),
      input = { kind: 'planner_tasks' as const, clientId };
    f.state.task.data.clientId = clientId.toUpperCase();
    const raw = f.tx.$queryRaw.getMockImplementation()!;
    let reads = 0;
    f.tx.$queryRaw.mockImplementation(async (strings, ...values) => {
      if (!strings.join('?').includes('FROM sp_planner_tasks')) return raw(strings, ...values);
      f.calls.push({ text: strings.join('?'), values });
      const start = reads++ === 0 ? 0 : 100,
        count = start === 0 ? 101 : 5;
      return Array.from({ length: count }, (_, n) => ({
        ...f.state.task,
        id: id(1000 + start + n),
      }));
    });
    const first = await f.service.read(ctx, input, bearer);
    const second = await f.service.read(ctx, { ...input, cursor: first.nextCursor }, bearer);
    expect([first.items.length, second.items.length, second.nextCursor]).toEqual([100, 5, null]);
    const calls = f.calls.filter((c) => c.text.includes('FROM sp_planner_tasks'));
    expect(calls[1]!.values).toEqual(
      expect.arrayContaining([ctx.tenantId, clientId.toLowerCase(), id(1099)]),
    );
    expect(calls[0]!.text).toContain("lower(data->>'clientId')");
    expect(first.items[0]!.record.clientId).toBe(clientId.toUpperCase());
  });
  it('refuses an inaccessible task and a task from a different client', async () => {
    const f = fixture();
    f.state.task.ownerId = 'someone_else';
    await expect(
      f.service.read(ctx, { kind: 'planner_task', clientId, id: id(30) }, bearer),
    ).rejects.toThrow(NotFoundException);
    f.state.task.ownerId = ctx.clerkUserId;
    f.state.task.data.clientId = otherClient;
    await expect(
      f.service.read(ctx, { kind: 'planner_task', clientId, id: id(30) }, bearer),
    ).rejects.toThrow(NotFoundException);
  });
  it('returns the revised event body and refuses target reassignment before release', async () => {
    const f = fixture(),
      input = { kind: 'planner_events', clientId, id: id(30), target: 'task' };
    const result = await f.service.read(ctx, input, bearer);
    expect(result.items[0]!.record).toMatchObject({ text: 'Authoritative correction', version: 2 });
    const events = f.tx.spPlannerEvent.findMany;
    events.mockImplementation(async () => {
      f.state.task.data.clientId = otherClient;
      return [f.state.event];
    });
    await expect(f.service.read(ctx, input, bearer)).rejects.toThrow(NotFoundException);
  });
  it('preserves full version content and hashes the actual returned snapshot, including coalesced edits', async () => {
    const f = fixture(),
      input = { kind: 'strategy_versions', clientId, strategyId: id(60) };
    const first = await f.service.read(ctx, input, bearer);
    expect(first.items[0]!.record).toMatchObject({
      coalescible: true,
      snapshot: { meta: { title: 'Saved title' }, nodes: [] },
    });
    expect(first.items[0]!.source.contentSha256).toBe(
      createHash('sha256').update(JSON.stringify(first.items[0]!.record)).digest('hex'),
    );
    expect(f.tx.spStrategy.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: ctx.tenantId, clientId, id: id(60) } }),
    );
    const row = await f.tx.spVersion.findMany();
    row[0]!.snapshot.meta.title = 'Later saved title';
    f.tx.spVersion.findMany.mockResolvedValue(row);
    const later = await f.service.read(ctx, input, bearer);
    expect(later.items[0]!.source.contentSha256).not.toBe(first.items[0]!.source.contentSha256);
  });
  it('fences a disabled Strategy feature and an unknown parent before version selection', async () => {
    const f = fixture(),
      input = { kind: 'strategy_versions', clientId, strategyId: id(60) };
    f.flags.isEnabled.mockResolvedValue(false);
    await expect(f.service.read(ctx, input, bearer)).rejects.toThrow(ForbiddenException);
    expect(f.tx.spStrategy.findFirst).not.toHaveBeenCalled();
    f.flags.isEnabled.mockResolvedValue(true);
    f.tx.spStrategy.findFirst.mockResolvedValue(null as never);
    await expect(f.service.read(ctx, input, bearer)).rejects.toThrow(NotFoundException);
    expect(f.tx.spVersion.findMany).not.toHaveBeenCalled();
  });
  it('uses canonical Objective membership/wall authority before full saved revisions', async () => {
    const f = fixture(),
      input = { kind: 'objective_versions', clientId, objectiveId: id(51) };
    const result = await f.service.read(ctx, input, bearer);
    expect(result.items[0]!.record).toMatchObject({
      version: 1,
      snapshot: { outcome: 'Saved original outcome' },
    });
    expect(result.items[0]!.source.relation).toBe('client_objective_revisions');
    expect(
      f.calls.some((c) => c.text.includes('FROM tenants') && c.text.includes('FOR SHARE')),
    ).toBe(true);
    for (const field of ['member', 'wallGrant', 'objective'] as const) {
      f.state[field] = false;
      f.calls.length = 0;
      await expect(f.service.read(ctx, input, bearer)).rejects.toThrow(NotFoundException);
      expect(f.calls.some((c) => c.text.includes('FROM client_objective_revisions'))).toBe(false);
      f.state[field] = true;
    }
  });
  it('pages saved versions past100 using scoped stable identity and rejects foreign cursors', async () => {
    const f = fixture(),
      input = { kind: 'strategy_versions' as const, clientId, strategyId: id(60) };
    const template = (await f.tx.spVersion.findMany())[0]!;
    f.tx.spVersion.findMany.mockImplementation(async (query?: unknown) => {
      const after = (query as { where?: { id?: { gt?: string } } })?.where?.id?.gt;
      return Array.from({ length: 205 }, (_, n) => ({ ...template, id: id(1000 + n) }))
        .filter((r) => !after || r.id > after)
        .slice(0, 101);
    });
    const one = await f.service.read(ctx, input, bearer);
    const two = await f.service.read(ctx, { ...input, cursor: one.nextCursor }, bearer);
    const three = await f.service.read(ctx, { ...input, cursor: two.nextCursor }, bearer);
    expect([one.items.length, two.items.length, three.items.length]).toEqual([100, 100, 5]);
    expect(new Set([...one.items, ...two.items, ...three.items].map((r) => r.source.id)).size).toBe(
      205,
    );
    expect(three.nextCursor).toBeNull();
    f.tx.spVersion.findFirst.mockResolvedValue(null as never);
    await expect(f.service.read(ctx, { ...input, cursor: one.nextCursor }, bearer)).rejects.toThrow(
      BadRequestException,
    );
  });
  it('labels activity summaries and does not select protected before/after JSON', async () => {
    const f = fixture();
    const page = await f.service.read(
      ctx,
      { kind: 'strategy_activity', clientId, strategyId: id(60) },
      bearer,
    );
    expect(page.coverage.representation).toBe('activity_summaries');
    const args = f.tx.spActivityLog.findMany.mock.calls[0] as unknown as [
      { where: unknown; select: Record<string, unknown> },
    ];
    expect(args[0].where).toMatchObject({
      tenantId: ctx.tenantId,
      entityType: 'strategy',
      entityId: id(60),
    });
    expect(args[0].select).not.toHaveProperty('before');
    expect(args[0].select).not.toHaveProperty('after');
  });
});
