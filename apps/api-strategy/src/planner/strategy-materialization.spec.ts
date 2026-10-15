import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PlannerService } from './planner.service.js';
import {
  materializationPlan,
  parseMaterialization,
  materializationReceiptId,
  STRATEGY_MATERIALIZATION_RECEIPT,
} from './strategy-materialization.js';
import { objectiveFixture, id } from '../meri/objective-generation.fixture.js';
import { requestKey } from '../meri/objective-generation.types.js';
import { RESOURCE_KINDS } from './planner-resources.js';
import type { SnapshotNode } from '../strategy/versioning.js';

// Explicit non-live transaction/SQL fixture. Real Planner helpers and shared
// Objective authority execute; rollback here models atomicity, not PG proof.
function fixture() {
  const base = objectiveFixture();
  const f = { ...base, receipt: base.input.objectiveGeneration!.receipt };
  const input = {
    requestId: id(100),
    generationJobId: id(101),
    expected: {
      strategyId: id(102),
      strategyVersionId: id(103),
      objectiveRevisionId: f.source.objectiveRevisionId,
    },
  };
  const node = (n: number, kind = 'action', dependsOnIds: string[] = []): SnapshotNode => ({
    id: id(n),
    kind,
    subject: 'deliverable',
    title: 'Saved ' + kind,
    note: 'Exact saved note',
    ownerUserId: 'user_other',
    status: 'completed',
    startsOn: '2026-10-16',
    endsOn: null,
    openEnded: false,
    dependsOnIds,
    meriAuthored: true,
    createdByUserId: f.actor.clerkUserId,
    createdAt: '2026-10-15T00:00:00Z',
    provenance: { source: 'saved' },
    targetRef: null,
  });
  const snapshot = {
    meta: {
      id: input.expected.strategyId,
      clientId: f.source.clientId,
      title: 'Saved Strategy title',
    },
    nodes: [
      node(110),
      node(111, 'milestone', [id(110)]),
      node(112, 'risk'),
      node(113, 'decision'),
      node(114, 'gate'),
      node(115),
    ],
  };
  f.receipt.context.reobservedAt = '2026-10-15T00:01:00Z';
  f.receipt.result = {
    strategyId: input.expected.strategyId,
    strategyVersionId: input.expected.strategyVersionId,
    savedAt: '2026-10-15T00:02:00Z',
    sourceDigest: f.receipt.context.sourceDigest!,
    coverageDigest: f.receipt.context.coverageDigest!,
    inputDigest: f.receipt.context.inputDigest!,
    contextPacketId: f.receipt.context.packetId!,
  };
  const job = {
    id: input.generationJobId,
    tenantId: f.actor.tenantId,
    ownerUserId: f.actor.clerkUserId,
    clientId: f.source.clientId,
    requestKey: requestKey(f.actor.tenantId, f.actor.clerkUserId, f.request.requestId),
    status: 'completed',
    strategyId: input.expected.strategyId,
    errorMessage: null,
    input: { objectiveGeneration: { request: f.request, receipt: f.receipt } },
  };
  const version = {
    id: input.expected.strategyVersionId,
    tenantId: f.actor.tenantId,
    strategyId: input.expected.strategyId,
    coalescible: false,
    authorKind: 'meri',
    snapshot,
  };
  let state: { projects: any[]; tasks: any[]; resources: any[]; events: any[]; inbox: any[] } = {
    projects: [],
    tasks: [],
    resources: [],
    events: [],
    inbox: [],
  };
  const flags = {
    member: true,
    memoryWall: false,
    grant: true,
    objectiveVersion: f.source.objectiveVersion,
    objectiveDeleted: false,
    strategyArchived: false,
    loseReply: false,
    fail: '',
  };
  const sql: string[] = [];
  function match(row: any, where: any): boolean {
    return Object.entries(where ?? {}).every(([k, v]) =>
      typeof v === 'object' && v !== null && 'in' in v
        ? (v as { in: unknown[] }).in.includes(row[k])
        : row[k] === v,
    );
  }
  const tx: any = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      sql.push(strings.join('?'));
      return 1;
    }),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = strings.join('?');
      sql.push(q);
      if (q.includes('FROM sp_draft_job'))
        return values.includes(job.id) &&
          values.includes(job.tenantId) &&
          values.includes(job.ownerUserId)
          ? [{ id: job.id }]
          : [];
      if (q.includes('FROM sp_strategy'))
        return !flags.strategyArchived &&
          values.includes(input.expected.strategyId) &&
          values.includes(job.clientId)
          ? [{ id: input.expected.strategyId }]
          : [];
      if (q.includes('FROM sp_version'))
        return values.includes(version.id) && values.includes(version.strategyId)
          ? [{ id: version.id }]
          : [];
      if (q.includes('FROM tenants'))
        return flags.member ? [{ userId: id(150), memoryWall: flags.memoryWall }] : [];
      if (q.includes('FROM client_memory_access')) return flags.grant ? [{ id: id(151) }] : [];
      if (q.includes('FROM client_objectives'))
        return flags.objectiveDeleted ? [] : [{ version: flags.objectiveVersion }];
      if (q.includes('FROM client_objective_revisions'))
        return [{ id: f.source.objectiveRevisionId }];
      if (q.includes('FROM users'))
        return flags.member ? [{ id: f.actor.clerkUserId, name: 'Fixture' }] : [];
      throw new Error('Unmodelled SQL');
    }),
    spDraftJob: { findFirst: jest.fn(async ({ where }: any) => (match(job, where) ? job : null)) },
    spVersion: {
      findFirst: jest.fn(async ({ where }: any) => (match(version, where) ? version : null)),
    },
    spNode: {
      findMany: jest.fn(async () =>
        snapshot.nodes.map((n) => ({ id: n.id, archivedAt: n.id === id(115) ? new Date() : null })),
      ),
    },
  };
  for (const [model, collection] of [
    ['spPlannerProject', 'projects'],
    ['spPlannerTask', 'tasks'],
    ['spPlannerResource', 'resources'],
    ['spPlannerEvent', 'events'],
    ['spPlannerInbox', 'inbox'],
  ] as const) {
    tx[model] = {
      findMany: jest.fn(async ({ where }: any = {}) =>
        state[collection].filter((r) => match(r, where)),
      ),
      findFirst: jest.fn(
        async ({ where }: any) => state[collection].find((r) => match(r, where)) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: randomUUID(),
          archived: false,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state[collection].push(row);
        if (flags.fail === collection) throw new Error('Injected ' + collection);
        return row;
      }),
      createMany: jest.fn(async ({ data }: any) => {
        state[collection].push(...data);
        return { count: data.length };
      }),
    };
  }
  const prisma: any = {
    withTenant: jest.fn(async (tenant: string, run: (tx: any) => Promise<unknown>) => {
      expect(tenant).toBe(f.actor.tenantId);
      const before = structuredClone(state);
      let result;
      try {
        result = await run(tx);
      } catch (e) {
        state = before;
        throw e;
      }
      if (flags.loseReply) {
        flags.loseReply = false;
        throw new Error('Lost commit response');
      }
      return result;
    }),
  };
  const links: any = { validate: jest.fn(async () => undefined) };
  return {
    input,
    snapshot,
    job,
    version,
    f,
    flags,
    tx,
    sql,
    links,
    prisma,
    node,
    get state() {
      return state;
    },
    service: new PlannerService(prisma, links),
  };
}
const projections: unknown[] = [];
afterAll(() => {
  if (process.env.PLANNER_PROJECTIONS)
    writeFileSync(process.env.PLANNER_PROJECTIONS, JSON.stringify(projections, null, 2));
});

describe('Objective saved version to atomic Planner materialization', () => {
  test('uses exact saved text/dates, canonical defaults and context without activation', async () => {
    const x = fixture();
    const result = await x.service.prepareStrategyPlan(x.f.actor, x.input);
    projections.push(result);
    expect(result.status).toBe('prepared');
    expect(result.counts).toEqual({
      savedNodes: 6,
      actionableNodes: 2,
      contextNodes: 3,
      archivedNodes: 1,
      createdProjects: 1,
      createdTasks: 2,
    });
    expect(x.state.projects[0].data).toMatchObject({
      name: 'Saved Strategy title',
      privacy: 'private',
      health: 'on_track',
      defaultView: 'list',
      members: [],
      sections: [],
      fields: [],
      clientId: x.f.source.clientId,
      startOn: null,
      dueOn: null,
    });
    expect(x.state.tasks[0].data).toMatchObject({
      name: 'Saved action',
      description: 'Exact saved note',
      startOn: '2026-10-16',
      dueOn: '2026-10-16',
      status: 'todo',
      assigneeId: null,
      collaborators: [],
      recurrence: null,
      meetingId: null,
      estimateMinutes: 0,
      priority: 'none',
      subtype: 'task',
      clientId: x.f.source.clientId,
    });
    expect(x.state.tasks[1].data.subtype).toBe('milestone');
    expect(x.state.tasks[1].data.dependencies).toEqual([x.state.tasks[0].id]);
    expect(x.state.inbox).toEqual([]);
    expect(x.state.events).toHaveLength(3);
    expect(x.links.validate).not.toHaveBeenCalled();
    expect(x.state.resources.map((r) => r.kind)).toEqual([STRATEGY_MATERIALIZATION_RECEIPT]);
    expect(x.sql[0]).toContain('pg_advisory_xact_lock');
    expect(x.sql.find((q) => q.includes('FROM sp_version'))).toContain('FOR SHARE');
    expect(x.state.resources[0].data.snapshot).toEqual(x.snapshot);
  });
  test('multiple groups and multihoming create one task per node and support cross-group dependencies', async () => {
    const x = fixture();
    const input = {
      ...x.input,
      groups: [
        { key: 'a', name: 'A', nodeIds: [id(110)] },
        { key: 'b', name: 'B', nodeIds: [id(110), id(111)] },
      ],
    };
    const result = await x.service.prepareStrategyPlan(x.f.actor, input);
    projections.push(result);
    expect(result.projects).toHaveLength(2);
    expect(result.tasks).toHaveLength(2);
    expect(x.state.tasks[0].data.memberships).toHaveLength(2);
    expect(x.state.tasks[1].data.dependencies).toEqual([x.state.tasks[0].id]);
  });
  test('replay preserves text edits and valid regrouping; GET never creates', async () => {
    const x = fixture();
    await x.service.prepareStrategyPlan(x.f.actor, x.input);
    const t = x.state.tasks[0];
    t.data.name = 'Human edit';
    t.data.memberships = [];
    t.projectIds = [];
    t.version = 4;
    const result = await x.service.strategyMaterialization(x.f.actor, x.input.requestId);
    projections.push(result);
    expect(result.status).toBe('prepared');
    expect(result.tasks[0]!.currentGroupKeys).toEqual([]);
    expect(result.tasks[0]!.originalGroupKeys).toEqual(['default']);
    expect(result.tasks[0]!.output.currentVersion).toBe(4);
    const replay = await x.service.prepareStrategyPlan(x.f.actor, x.input);
    expect(replay.replayed).toBe(true);
    expect(x.state.tasks).toHaveLength(2);
    expect(t.data.name).toBe('Human edit');
  });
  test('archives, changed client links, deletion and lost output ACL report truthful partial, no repair', async () => {
    const x = fixture();
    await x.service.prepareStrategyPlan(x.f.actor, x.input);
    x.state.projects[0].archived = true;
    x.state.tasks[0].data.clientId = id(180);
    x.state.tasks.splice(1, 1);
    const result = await x.service.prepareStrategyPlan(x.f.actor, x.input);
    projections.push(result);
    expect(result.status).toBe('partial');
    expect(result.projects[0]!.output.availability).toBe('archived');
    expect(result.tasks.map((t) => t.output.id)).toEqual([null, null]);
    expect(x.state.tasks).toHaveLength(1);
  });
  test('lost commit reply recovers same request and never duplicates', async () => {
    const x = fixture();
    x.flags.loseReply = true;
    await expect(x.service.prepareStrategyPlan(x.f.actor, x.input)).rejects.toMatchObject({
      response: { code: 'MATERIALIZATION_OUTCOME_UNCONFIRMED', outcome: 'unconfirmed' },
    });
    const result = await x.service.prepareStrategyPlan(x.f.actor, x.input);
    expect(result.replayed).toBe(true);
    expect(x.state.projects).toHaveLength(1);
    expect(x.state.tasks).toHaveLength(2);
  });
  test.each(['projects', 'tasks', 'events', 'resources'])(
    'failure at %s rolls back all outputs and receipt',
    async (stage) => {
      const x = fixture();
      x.flags.fail = stage;
      await expect(x.service.prepareStrategyPlan(x.f.actor, x.input)).rejects.toMatchObject({
        response: { code: 'MATERIALIZATION_OUTCOME_UNCONFIRMED' },
      });
      expect(Object.values(x.state).every((a) => a.length === 0)).toBe(true);
    },
  );
  test('same UUID changed payload conflicts; different explicit UUID may create another plan', async () => {
    const x = fixture();
    await x.service.prepareStrategyPlan(x.f.actor, x.input);
    await expect(
      x.service.prepareStrategyPlan(x.f.actor, {
        ...x.input,
        groups: [{ key: 'different', name: 'Other', nodeIds: [id(110), id(111)] }],
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'MATERIALIZATION_REQUEST_CONFLICT',
        recordedAttempt: true,
        outcome: 'recorded',
      },
    });
    await x.service.prepareStrategyPlan(x.f.actor, { ...x.input, requestId: id(190) });
    expect(x.state.projects).toHaveLength(2);
    expect(x.state.tasks).toHaveLength(4);
  });
  test('stale current Objective distinguishes new and previously recorded attempts', async () => {
    const x = fixture();
    x.flags.objectiveVersion++;
    await expect(x.service.prepareStrategyPlan(x.f.actor, x.input)).rejects.toMatchObject({
      response: { code: 'MATERIALIZATION_SOURCE_STALE', recordedAttempt: null },
    });
    x.flags.objectiveVersion--;
    await x.service.prepareStrategyPlan(x.f.actor, x.input);
    x.flags.objectiveVersion++;
    await expect(
      x.service.strategyMaterialization(x.f.actor, x.input.requestId),
    ).rejects.toMatchObject({
      response: { code: 'MATERIALIZATION_SOURCE_STALE', recordedAttempt: true },
    });
  });
  test.each([
    'member',
    'wall',
    'archive',
    'deleted',
    'actor',
    'tenant',
    'version',
    'receipt',
    'coalescible',
  ])('refuses %s authority/lineage fault before writes', async (which) => {
    const x = fixture();
    let actor = x.f.actor;
    if (which === 'member') x.flags.member = false;
    if (which === 'wall') {
      x.flags.memoryWall = true;
      x.flags.grant = false;
    }
    if (which === 'archive') x.flags.strategyArchived = true;
    if (which === 'deleted') x.flags.objectiveDeleted = true;
    if (which === 'actor') actor = { ...actor, clerkUserId: 'other' };
    if (which === 'tenant') x.job.tenantId = id(199);
    if (which === 'version') x.version.id = id(198);
    if (which === 'receipt') x.f.receipt.result!.strategyVersionId = id(197);
    if (which === 'coalescible') x.version.coalescible = true;
    await expect(x.service.prepareStrategyPlan(actor, x.input)).rejects.toMatchObject({
      response: { code: 'MATERIALIZATION_NOT_AVAILABLE' },
    });
    expect(x.state.projects).toEqual([]);
  });
  test('exact historical snapshot and digest are used even if current content differs', async () => {
    const x = fixture();
    const result = await x.service.prepareStrategyPlan(x.f.actor, x.input);
    x.snapshot.nodes[0]!.title = 'Illicit version mutation';
    await expect(
      x.service.strategyMaterialization(x.f.actor, x.input.requestId),
    ).rejects.toMatchObject({ response: { code: 'MATERIALIZATION_OUTCOME_UNCONFIRMED' } });
    expect(result.tasks[0]!.sourceNodeId).toBe(id(110));
  });
  test('context-only zero work creates a named project and no fabricated task', async () => {
    const x = fixture();
    x.snapshot.nodes = [x.node(112, 'risk')];
    const result = await x.service.prepareStrategyPlan(x.f.actor, x.input);
    projections.push(result);
    expect(result.status).toBe('prepared_with_issues');
    expect(result.issues[0]!.code).toBe('NO_ACTIONABLE_WORK');
    expect(x.state.tasks).toEqual([]);
    expect(x.state.projects).toHaveLength(1);
  });
  test('context/archive edges stay explicit issues, not fabricated task dependencies', async () => {
    const x = fixture();
    x.snapshot.nodes[0]!.dependsOnIds = [id(112), id(115)];
    const result = await x.service.prepareStrategyPlan(x.f.actor, x.input);
    projections.push(result);
    expect(result.issues.map((i) => i.code)).toEqual([
      'CONTEXT_ONLY_DEPENDENCY',
      'ARCHIVED_SOURCE_DEPENDENCY',
    ]);
    expect(x.state.tasks[0].data.dependencies).toEqual([]);
    expect(result.edges).toHaveLength(3);
  });
  test.each(['cycle', 'contextCycle', 'missing', 'malformed', 'date', 'oversize', 'group'])(
    'blocks %s graph/source before all writes',
    async (which) => {
      const x = fixture();
      let input: any = x.input;
      if (which === 'cycle') x.snapshot.nodes[0]!.dependsOnIds = [id(111)];
      if (which === 'contextCycle') {
        x.snapshot.nodes[2]!.dependsOnIds = [id(113)];
        x.snapshot.nodes[3]!.dependsOnIds = [id(112)];
      }
      if (which === 'missing') x.snapshot.nodes[0]!.dependsOnIds = [id(999)];
      if (which === 'malformed') x.snapshot.nodes[0]!.kind = 'unknown';
      if (which === 'date') x.snapshot.nodes[1]!.endsOn = '2026-10-17';
      if (which === 'oversize') x.snapshot.nodes[2]!.note = 'x'.repeat(50001);
      if (which === 'group')
        input = { ...input, groups: [{ key: 'a', name: 'A', nodeIds: [id(110)] }] };
      await expect(x.service.prepareStrategyPlan(x.f.actor, input)).rejects.toMatchObject({
        response: {
          httpStatus: 422,
          code: 'MATERIALIZATION_SOURCE_INVALID',
          recordedAttempt: null,
        },
      });
      expect(Object.values(x.state).every((a) => a.length === 0)).toBe(true);
    },
  );
  test('missing GET never proves rollback; private kind stays outside generic registry', async () => {
    const x = fixture();
    await expect(
      x.service.strategyMaterialization(x.f.actor, x.input.requestId),
    ).rejects.toMatchObject({
      response: {
        code: 'MATERIALIZATION_NOT_AVAILABLE',
        outcome: 'unconfirmed',
        recordedAttempt: null,
      },
    });
    expect(RESOURCE_KINDS).not.toContain(STRATEGY_MATERIALIZATION_RECEIPT);
    expect(materializationReceiptId(x.f.actor.tenantId, 'one', x.input.requestId)).not.toBe(
      materializationReceiptId(x.f.actor.tenantId, 'two', x.input.requestId),
    );
  });
  test.each(['tenantId', 'actorId', 'data', 'activate', 'taskCap', 'outputIds'])(
    'rejects caller field %s',
    (key) => {
      const x = fixture();
      expect(() => parseMaterialization({ ...x.input, [key]: 'forged' })).toThrow();
    },
  );
  test('handles more than any arbitrary work cap without truncation', () => {
    const x = fixture();
    x.snapshot.nodes = Array.from({ length: 150 }, (_, i) => x.node(i + 1000));
    const plan = materializationPlan(
      x.snapshot,
      x.snapshot.nodes.map((n) => ({ id: n.id, archivedAt: null })),
      x.input,
    );
    expect(plan.actionable).toHaveLength(150);
  });
  test.each(['kind', 'subject', 'status'])(
    'refuses coerced %s values with zero writes',
    async (field) => {
      for (const shape of ['array', 'nestedArray', 'object']) {
        const x = fixture();
        const row = x.snapshot.nodes[0] as unknown as Record<string, unknown>;
        const value = row[field];
        row[field] =
          shape === 'array' ? [value] : shape === 'nestedArray' ? [[value]] : { toString: value };
        await expect(x.service.prepareStrategyPlan(x.f.actor, x.input)).rejects.toMatchObject({
          response: {
            httpStatus: 422,
            code: 'MATERIALIZATION_SOURCE_INVALID',
            issues: [{ code: 'INVALID_SOURCE_NODE' }],
          },
        });
        expect(Object.values(x.state).every((a) => a.length === 0)).toBe(true);
      }
    },
  );
  test.each([
    'tasks',
    'counts',
    'remap',
    'memberships',
    'edge',
    'context',
    'extra',
    'archiveWitness',
  ])('rejects malformed durable %s on both recovery paths', async (which) => {
    const x = fixture();
    await x.service.prepareStrategyPlan(x.f.actor, x.input);
    const receipt = x.state.resources[0].data;
    if (which === 'tasks') receipt.result.tasks = [];
    if (which === 'counts') receipt.result.counts.createdTasks = 99;
    if (which === 'remap') receipt.result.tasks[0].output.id = x.state.tasks[1].id;
    if (which === 'memberships') receipt.result.tasks[0].originalGroupKeys = [];
    if (which === 'edge') receipt.result.edges = [];
    if (which === 'context') receipt.result.context[0].kind = ['risk'];
    if (which === 'extra') receipt.result.privateExtra = 'never public';
    if (which === 'archiveWitness') receipt.archivedSourceNodeIds = [id(110)];
    for (const recovery of [
      () => x.service.strategyMaterialization(x.f.actor, x.input.requestId),
      () => x.service.prepareStrategyPlan(x.f.actor, x.input),
    ])
      await expect(recovery()).rejects.toMatchObject({
        response: { code: 'MATERIALIZATION_OUTCOME_UNCONFIRMED', httpStatus: 503 },
      });
    expect(x.state.projects).toHaveLength(1);
    expect(x.state.tasks).toHaveLength(2);
  });
});
