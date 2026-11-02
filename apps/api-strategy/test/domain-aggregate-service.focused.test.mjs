// Actual owner method bodies and validation/ACL/date helpers; synthetic ORM/Core
// transport only. No native SQL, HTTP, DI, DB, semantic typecheck or deployment claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const data = (text) => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const moduleUrl = (text) => data(stripTypeScriptTypes(text));
const nest = data(
  'export class BadRequestException extends Error {}; export class ForbiddenException extends Error {}; export class ServiceUnavailableException extends Error {};',
);
const { ForbiddenException, ServiceUnavailableException } = await import(nest);
const aggregate = moduleUrl(
  (await read('../src/strategy/domain-aggregate.ts')).replace(
    "'@nestjs/common'",
    JSON.stringify(nest),
  ),
);
const defaults = moduleUrl(await read('../../../packages/strategy-verifier/src/planner.ts'));
const schedule = moduleUrl(
  (await read('../../../packages/strategy-verifier/src/planner-schedule.ts')).replace(
    "'./planner.js'",
    JSON.stringify(defaults),
  ),
);
const verifier = data(
  `export * from ${JSON.stringify(defaults)}; export * from ${JSON.stringify(schedule)};`,
);
const access = moduleUrl(await read('../../../packages/shared/src/planner-resource-access.ts'));
const dates = moduleUrl(await read('../../../packages/shared/src/planner-resource-schedule.ts'));
const validation = moduleUrl(
  (await read('../src/planner/planner.validation.ts'))
    .replace("'@nestjs/common'", JSON.stringify(nest))
    .replace("'@capiro/strategy-verifier'", JSON.stringify(verifier)),
);
const { PLANNER_DEFAULT_TASK, PLANNER_DEFAULT_PROJECT } = await import(defaults);
const plannerSource = await read('../src/planner/planner.service.ts');
const strategySource = await read('../src/strategy/strategy.service.ts');
const section = (text, start, end) => {
  assert.equal(text.split(start).length, 2);
  assert.ok(text.includes(end));
  return text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
};
const imports = `import {aggregateQuery,aggregateRows,aggregateFingerprint,aggregateSourceKey,observeDomainAggregate,requireAggregateActor} from ${JSON.stringify(aggregate)};
import {PLANNER_DEFAULT_TASK,PLANNER_DEFAULT_PROJECT} from ${JSON.stringify(defaults)};
import {validateTask,validateProject} from ${JSON.stringify(validation)};
import {plannerTaskAccessDecision,plannerProjectAccessDecision} from ${JSON.stringify(access)};
import {plannerResourceTaskOverdue} from ${JSON.stringify(dates)};
const Prisma={TransactionIsolationLevel:{RepeatableRead:'RepeatableRead'}};`;
const ownerSource = `${imports}
${section(plannerSource, 'const projectData =', 'const missing =')}
export class PlannerOwner {
 constructor(prisma,links){this.prisma=prisma;this.links=links;}
 ${section(plannerSource, '  private scope<T>', '  private async people')}
 ${section(plannerSource, '  private projects(', '  private projectView(')}
 ${section(plannerSource, '  async overdueAggregate(', '  async tasks(')}
}
export class StrategyOwner {
 constructor(prisma,links){this.prisma=prisma;this.links=links;}
 ${section(strategySource, '  async activeAggregate(', '  async objectiveDestination(')}
}`;
const { PlannerOwner, StrategyOwner } = await import(moduleUrl(ownerSource));
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = { tenantId: id(1), clerkUserId: 'user_actor', role: 'standard_user' };
const client = id(2),
  foreignClient = id(3),
  projectId = id(4);
const task = (n, props = {}, extra = {}) => ({
  id: id(n),
  tenantId: ctx.tenantId,
  ownerId: ctx.clerkUserId,
  archived: false,
  version: 1,
  data: {
    ...structuredClone(PLANNER_DEFAULT_TASK),
    name: `Task ${n}`,
    dueOn: '2020-01-01',
    ...props,
  },
  ...extra,
});
const project = (n, props = {}) => ({
  id: id(n),
  tenantId: ctx.tenantId,
  ownerId: 'user_other',
  version: 1,
  archived: false,
  data: { ...structuredClone(PLANNER_DEFAULT_PROJECT), name: `Project ${n}`, ...props },
});
function fixture(tasks = [], projects = [], strategies = []) {
  let actor = true,
    pass = 0;
  const denied = new Set(),
    queries = [],
    locks = [];
  const tx = {
    $queryRaw: async () => (actor ? [{ id: id(90) }] : []),
    $executeRaw: async (...args) => {
      locks.push(args);
    },
    spPlannerProject: {
      findMany: async (args) => {
        queries.push(args);
        return structuredClone(
          projects
            .filter(
              (row) =>
                row.tenantId === args.where.tenantId &&
                (!args.where.id || row.id > args.where.id.gt),
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, args.take),
        );
      },
    },
    spPlannerTask: {
      findMany: async (args) => {
        queries.push(args);
        assert.equal(args.take, 256);
        assert.equal(args.cursor, undefined);
        return structuredClone(
          tasks
            .filter(
              (row) =>
                row.tenantId === args.where.tenantId &&
                row.archived === args.where.archived &&
                (!args.where.id || row.id > args.where.id.gt),
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, args.take),
        );
      },
    },
    spStrategy: {
      findMany: async (args) => {
        queries.push(args);
        assert.equal(args.take, 256);
        return structuredClone(
          strategies
            .filter(
              (row) =>
                row.tenantId === args.where.tenantId &&
                row.archivedAt === null &&
                (!args.where.id || row.id > args.where.id.gt) &&
                (!args.where.clientId || row.clientId === args.where.clientId),
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, args.take),
        );
      },
    },
  };
  const prisma = {
    withTenant: async (tenant, run, options) => {
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 10_000);
      assert.equal(tenant, ctx.tenantId);
      pass++;
      return run(tx);
    },
    withTenantUser: async (tenant, actorId, run, options) => {
      assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 10_000);
      assert.equal(tenant, ctx.tenantId);
      assert.equal(actorId, ctx.clerkUserId);
      pass++;
      return run(tx);
    },
  };
  const links = {
    validate: async (source) => {
      if (denied.has(source.clientId) || denied.has(source.meetingId))
        throw new ForbiddenException();
    },
  };
  return {
    planner: new PlannerOwner(prisma, links),
    strategy: new StrategyOwner(prisma, links),
    denied,
    queries,
    locks,
    setActor: (value) => {
      actor = value;
    },
    passes: () => pass,
  };
}
const run = (f, query = {}) => f.planner.overdueAggregate(ctx, query, 'Bearer synthetic');
test('Planner counts full >101 population once per ID, including subtasks and supported subtypes', async () => {
  const rows = Array.from({ length: 601 }, (_, i) =>
    task(100 + i, {
      subtype: ['task', 'approval', 'milestone'][i % 3],
      parentId: i ? id(100) : null,
    }),
  );
  const f = fixture(rows);
  const result = await run(f);
  assert.equal(result.count, 601);
  assert.equal(result.complete, true);
  assert.equal(
    f.locks.filter((call) => call[0].join('').includes('pg_advisory_xact_lock')).length,
    3,
  );
});
test('Planner excludes archived/done/undated/future/foreign tenant while including unfinished blocked work', async () => {
  const f = fixture([
    task(10),
    task(11, { status: 'done' }),
    task(12, { dueOn: null }),
    task(13, {}, { archived: true }),
    task(14, { dueOn: '2099-01-01' }),
    task(15, { status: 'blocked' }),
    task(16, {}, { tenantId: id(99) }),
  ]);
  assert.equal((await run(f)).count, 2);
});
test('canonical owner/assignee/collaborator/project ACLs and multihoming contribute one distinct task', async () => {
  const projects = [project(4, { privacy: 'team' }), project(5)];
  const membership = (n) => ({ projectId: id(n), sectionId: null, position: 0 });
  const f = fixture(
    [
      task(10, { memberships: [membership(4), membership(5)] }),
      task(11, { memberships: [membership(5)] }),
      task(12, {}, { ownerId: 'user_other' }),
      task(13, { assigneeId: ctx.clerkUserId }, { ownerId: 'user_other' }),
      task(14, { collaborators: [ctx.clerkUserId] }, { ownerId: 'user_other' }),
    ],
    projects,
  );
  assert.equal((await run(f)).count, 3);
});
test('exact saved task client filters; project client association does not retarget General tasks', async () => {
  const f = fixture(
    [
      task(10, { clientId: client.toUpperCase() }),
      task(11, { clientId: foreignClient }),
      task(12, { memberships: [{ projectId, sectionId: null, position: 0 }] }),
    ],
    [project(4, { privacy: 'team', clientId: client })],
  );
  assert.equal((await run(f, { clientId: client })).count, 1);
  assert.equal((await run(f)).count, 3);
});
test('denied task client/meeting and denied project sources do not grant aggregate visibility', async () => {
  const f = fixture(
    [
      task(10, { clientId: client }),
      task(11, { meetingId: id(50) }),
      task(12, { memberships: [{ projectId, sectionId: null, position: 0 }] }),
      task(13),
    ],
    [project(4, { privacy: 'team', clientId: client })],
  );
  f.denied.add(client);
  f.denied.add(id(50));
  assert.equal((await run(f)).count, 1);
  await assert.rejects(() => run(f, { clientId: client }), ForbiddenException);
});
test('malformed persisted task or grant data withholds count rather than inventing status/access', async () => {
  for (const f of [
    fixture([task(10, { status: 'cancelled' })]),
    fixture([task(10)], [project(4, { members: 'broken' })]),
  ]) {
    const result = await run(f);
    assert.equal(result.state, 'incomplete');
    assert.equal(result.count, null);
  }
});
test('current actor denial holds even with no tasks or Strategies', async () => {
  const f = fixture();
  f.setActor(false);
  await assert.rejects(() => run(f), ForbiddenException);
  await assert.rejects(
    () => f.strategy.activeAggregate(ctx, {}, 'Bearer synthetic'),
    ForbiddenException,
  );
});
test('Strategy counts >101 nonarchived canonical IDs independent of nodes, versions and client lifecycle', async () => {
  const rows = Array.from({ length: 205 }, (_, i) => ({
    id: id(100 + i),
    tenantId: ctx.tenantId,
    clientId: i % 2 ? foreignClient : client,
    archivedAt: null,
    updatedAt: new Date('2026-10-01'),
    nodes: [],
    versions: [1, 2],
  }));
  rows.push(
    { ...rows[0], id: id(900), archivedAt: new Date() },
    { ...rows[0], id: id(901), tenantId: id(9) },
  );
  const f = fixture([], [], rows);
  assert.equal((await f.strategy.activeAggregate(ctx, {}, 'Bearer synthetic')).count, 205);
  assert.equal(
    (await f.strategy.activeAggregate(ctx, { clientId: client }, 'Bearer synthetic')).count,
    103,
  );
  f.denied.add(foreignClient);
  assert.equal((await f.strategy.activeAggregate(ctx, {}, 'Bearer synthetic')).count, 103);
});
test('canonical overdue handles exact timed boundary, local date midnight, DST folds/gaps and default UTC', async () => {
  const { plannerResourceTaskOverdue: overdue } = await import(dates);
  const value = {
    status: 'todo',
    dueOn: '2026-11-01',
    dueTime: '01:30',
    timeZone: 'America/New_York',
  };
  assert.equal(overdue(value, new Date('2026-11-01T05:30:00Z')), false);
  assert.equal(overdue(value, new Date('2026-11-01T05:30:00.001Z')), true);
  const dateOnly = { ...value, dueTime: null };
  assert.equal(overdue(dateOnly, new Date('2026-11-02T04:59:59.999Z')), false);
  assert.equal(overdue(dateOnly, new Date('2026-11-02T05:00:00Z')), true);
  const gap = { ...value, dueOn: '2026-03-08', dueTime: '02:30' };
  assert.equal(overdue(gap, new Date('2026-03-08T07:30:00Z')), false);
  assert.equal(overdue(gap, new Date('2026-03-08T07:30:00.001Z')), true);
  assert.equal(overdue({ ...dateOnly, timeZone: 'UTC' }, new Date('2026-11-02T00:00:00Z')), true);
  assert.match(ownerSource, /timeZone: row.data.timeZone \?\? 'UTC'/);
});
test('routes are additive no-store reads under existing guards and required Strategy dependency is provided', async () => {
  for (const [path, route, method] of [
    ['../src/planner/planner.controller.ts', 'metrics/overdue', 'overdueAggregate'],
    ['../src/strategy/strategy.controller.ts', 'metrics/active', 'activeAggregate'],
  ]) {
    const source = await read(path);
    assert.ok(source.includes(`@Get('${route}')`));
    const handler = source.slice(
      source.indexOf(`@Get('${route}')`),
      source.indexOf(`@Get('${route}')`) + 430,
    );
    assert.match(handler, /private, no-store/);
    assert.ok(handler.includes(method));
    assert.match(handler, /req.headers.authorization/);
    assert.match(source, /@UseGuards\(TenantGuard,/);
  }
  const module = await read('../src/strategy/strategy.module.ts');
  assert.match(module, /providers:\s*\[\s*StrategyService,\s*PlannerLinksService,/);
});

test('P2: 205 locally unreadable tasks perform zero Core fetches rather than820', async () => {
  const rows = Array.from({ length: 205 }, (_, i) =>
    task(100 + i, { clientId: client, meetingId: id(2000 + i) }, { ownerId: 'user_other' }),
  );
  const f = fixture(rows);
  const transportNest = data(`export const Injectable=()=>value=>value;
    export class ForbiddenException extends Error {};
    export class ServiceUnavailableException extends Error {};`);
  const config = data('export class ConfigService {}');
  const raw = await read('../src/planner/planner-links.service.ts');
  const { PlannerLinksService } = await import(
    moduleUrl(
      raw
        .replace('@Injectable()', '')
        .replace("'@nestjs/common'", JSON.stringify(transportNest))
        .replace("'@nestjs/config'", JSON.stringify(config)),
    )
  );
  f.planner.links = new PlannerLinksService({ get: () => undefined });
  let requests = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      requests++;
      return new Response(null, { status: 200 });
    };
    const result = await run(f);
    assert.equal(result.count, 0);
    assert.equal(requests, 0, `unexpected canonical source fanout: ${requests}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('P2: 205 readable distinct meeting sources refuse capacity without a partial count or Core fanout', async () => {
  const f = fixture(
    Array.from({ length: 205 }, (_, i) =>
      task(100 + i, { clientId: client, meetingId: id(2000 + i) }),
    ),
  );
  let requests = 0;
  f.planner.links = {
    validate: async () => {
      requests++;
    },
  };
  await assert.rejects(() => run(f), ServiceUnavailableException);
  assert.equal(requests, 0);
  assert.equal(f.passes(), 1);
});

test('P2: already canceled owner calls launch no database snapshot or source read', async () => {
  const f = fixture();
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(
    () => f.planner.overdueAggregate(ctx, {}, 'Bearer synthetic', canceled.signal),
    ServiceUnavailableException,
  );
  await assert.rejects(
    () => f.strategy.activeAggregate(ctx, {}, 'Bearer synthetic', canceled.signal),
    ServiceUnavailableException,
  );
  assert.equal(f.passes(), 0);
});
