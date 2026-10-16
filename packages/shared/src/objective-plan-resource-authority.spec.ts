import {
  lockObjectivePlanResource,
  readObjectivePlanResource,
} from './objective-plan-resource-authority.js';
import {
  plannerProjectAccessDecision,
  plannerTaskAccessDecision,
} from './planner-resource-access.js';
import { tenantFeatureEnabled } from './tenant-feature.js';
import {
  plannerResourceScheduledInstant,
  plannerResourceTaskOverdue,
  plannerResourceDueTimestamp,
} from './planner-resource-schedule.js';
import type {
  ObjectiveOperationalActor,
  ObjectiveOperationalBinding,
  ObjectiveOperationalSelection,
  ObjectiveOperationalTx,
} from './objective-operational-resource.js';

// Shared builds in isolation without Node/Jest dependencies. The owning API's
// coordinated Jest runner supplies these globals; no test dependency is added.
declare const describe: (name: string, run: () => void) => void;
declare const it: any;
declare const expect: any;
declare const require: (path: string) => any;

const TENANT = '10000000-0000-4000-8000-000000000001';
const OTHER_TENANT = '10000000-0000-4000-8000-000000000002';
const CLIENT = '20000000-0000-4000-8000-000000000001';
const OTHER_CLIENT = '20000000-0000-4000-8000-000000000002';
const PROJECT = '30000000-0000-4000-8000-000000000001';
const SHARED_PROJECT = '30000000-0000-4000-8000-000000000002';
const TASK = '40000000-0000-4000-8000-000000000001';
const STRATEGY = '50000000-0000-4000-8000-000000000001';
const actor: ObjectiveOperationalActor = {
  tenantId: TENANT,
  tenantSlug: 'synthetic',
  userId: '60000000-0000-4000-8000-000000000001',
  clerkUserId: 'user_reader',
  role: 'standard_user',
};
const binding: ObjectiveOperationalBinding = {
  clientId: CLIENT,
  objectiveId: '70000000-0000-4000-8000-000000000001',
  objectiveVersion: 4,
  objectiveRevisionId: '80000000-0000-4000-8000-000000000001',
};
const observedAt = '2026-10-08T03:01:00.000Z';
interface Row {
  id: string;
  tenantId: string;
  ownerId: string;
  data: any;
  version: number;
  archived: boolean;
  createdAt: Date | string;
  projectIds?: string[];
}
function project(patch: Record<string, unknown> = {}, fields: Partial<Row> = {}): Row {
  return {
    id: PROJECT,
    tenantId: TENANT,
    ownerId: 'user_owner',
    version: 7,
    archived: false,
    createdAt: new Date('2026-10-01T10:00:00Z'),
    data: {
      name: 'Current human project',
      clientId: CLIENT,
      privacy: 'private',
      members: [{ userId: actor.clerkUserId, role: 'viewer' }],
      ...patch,
    },
    ...fields,
  };
}
function task(patch: Record<string, unknown> = {}, fields: Partial<Row> = {}): Row {
  return {
    id: TASK,
    tenantId: TENANT,
    ownerId: 'user_owner',
    version: 11,
    archived: false,
    createdAt: new Date('2026-10-02T10:00:00Z'),
    projectIds: [PROJECT],
    data: {
      name: 'Current human task',
      clientId: CLIENT,
      status: 'blocked',
      subtype: 'approval',
      approval: 'changes_requested',
      dueOn: '2026-10-07',
      dueTime: '20:00',
      timeZone: 'America/Los_Angeles',
      memberships: [{ projectId: PROJECT }],
      assigneeId: null,
      collaborators: [],
      ...patch,
    },
    ...fields,
  };
}
interface Query {
  sql: string;
  values: unknown[];
  method: 'query' | 'execute';
}
function fixture(projects = [project()], tasks = [task()], scope = binding) {
  const queries: Query[] = [];
  let afterSnapshot: (() => void) | undefined;
  const tenant: { settings: unknown } = {
    settings: { clioFeatureFlags: { 'strategyPlanner.enabled': true } },
  };
  const strategies = [
    {
      id: STRATEGY,
      tenantId: TENANT,
      clientId: CLIENT,
      title: 'Edited Strategy',
      type: 'coalition',
      updatedAt: new Date('2026-10-07T10:00:00Z'),
      archivedAt: null,
    },
  ];
  const tx: ObjectiveOperationalTx = {
    $executeRaw: async (strings, ...values) => {
      queries.push({ sql: strings.join('?'), values, method: 'execute' });
      return 1;
    },
    $queryRaw: async <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> => {
      const sql = strings.join('?');
      queries.push({ sql, values, method: 'query' });
      if (sql.includes('WITH requested AS')) {
        const [tenantId, clientId, resourceId, kind] = values;
        const selected =
          kind === 'planner_project'
            ? projects.filter(
                (row) =>
                  row.tenantId === tenantId &&
                  row.id === resourceId &&
                  !row.archived &&
                  typeof row.data?.clientId === 'string' &&
                  row.data.clientId.toLowerCase() === clientId,
              )
            : [];
        const candidates = tasks.filter((row) => {
          if (
            row.tenantId !== tenantId ||
            row.archived ||
            typeof row.data?.clientId !== 'string' ||
            row.data.clientId.toLowerCase() !== clientId
          )
            return false;
          if (kind === 'planner_task') return row.id === resourceId;
          return (
            selected.length > 0 &&
            (row.projectIds?.includes(resourceId as string) ||
              (Array.isArray(row.data?.memberships) &&
                row.data.memberships.some(
                  (m: any) =>
                    typeof m?.projectId === 'string' && m.projectId.toLowerCase() === resourceId,
                )))
          );
        });
        const referencedIds = new Set(
          candidates.flatMap((row) =>
            Array.isArray(row.data?.memberships)
              ? row.data.memberships.map((m: any) => m?.projectId)
              : [],
          ),
        );
        const grants = projects.filter(
          (row) => row.tenantId === tenantId && referencedIds.has(row.id),
        );
        const snapshot = JSON.parse(
          JSON.stringify([
            ...selected.map((row) => ({ ...row, rowKind: 'selected_project' })),
            ...candidates.map((row) => ({ ...row, rowKind: 'task' })),
            ...grants.map((row) => ({ ...row, rowKind: 'project' })),
          ]),
        );
        afterSnapshot?.();
        return snapshot as T;
      }
      if (sql.includes('FROM sp_strategy'))
        return strategies.filter(
          (row) =>
            row.tenantId === values[0] &&
            row.id === values[1] &&
            (!sql.includes('client_id=') || row.clientId === values[2]) &&
            (!sql.includes('archived_at IS NULL') || !row.archivedAt) &&
            (!sql.includes('strategyPlanner.enabled') ||
              tenantFeatureEnabled(tenant.settings, 'strategyPlanner.enabled', false)),
        ) as T;
      if (sql.includes('FROM sp_planner_projects') && sql.includes('FOR SHARE'))
        return projects.filter((row) => row.tenantId === values[0] && row.id === values[1]) as T;
      if (sql.includes('FROM sp_planner_tasks') && sql.includes('FOR SHARE'))
        return tasks.filter((row) => row.tenantId === values[0] && row.id === values[1]) as T;
      throw new Error('Unexpected owner SQL');
    },
  };
  const read = (selection: ObjectiveOperationalSelection, asOf = observedAt) =>
    readObjectivePlanResource(tx, actor, scope, selection, observedAt, asOf);
  return {
    tx,
    read,
    queries,
    projects,
    tasks,
    strategies,
    tenant,
    afterSnapshot: (run: () => void) => {
      afterSnapshot = run;
    },
  };
}

describe('Objective Strategy/Planner owner port (synthetic tagged SQL only)', () => {
  it('takes the existing Planner tenant gate before exact parent/task row locks and Core authority', async () => {
    for (const kind of ['planner_project', 'planner_task'] as const) {
      const f = fixture();
      const selection = { kind, id: kind === 'planner_project' ? PROJECT : TASK };
      await lockObjectivePlanResource(f.tx, actor, selection);
      const coreAuthorityAfterLocks = f.queries.length;
      await f.read(selection);
      expect(coreAuthorityAfterLocks).toBe(2);
      expect(f.queries[0]).toEqual({
        method: 'execute',
        sql: 'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
        values: [`planner:${TENANT}`],
      });
      expect(f.queries[1]!.sql).toContain('tenant_id=?::uuid AND id=?::uuid FOR SHARE');
      expect(f.queries[1]!.values).toEqual([TENANT, selection.id]);
      expect(f.queries).toHaveLength(3);
      expect(f.queries[2]!.sql).not.toMatch(/FOR\s+(SHARE|UPDATE)|pg_advisory/i);
      expect(f.queries.every((query) => query.method === 'query' || query === f.queries[0])).toBe(
        true,
      );
    }
  });

  it('locks and reads only the exact same-client nonarchived Strategy and actual metadata', async () => {
    const f = fixture();
    await lockObjectivePlanResource(f.tx, actor, { kind: 'strategy', id: STRATEGY });
    expect(f.queries[0]!.sql).toContain('FROM sp_strategy');
    expect(f.queries[0]!.sql).toContain('FOR SHARE');
    expect(f.queries[0]!.values).toEqual([TENANT, STRATEGY]);
    await expect(f.read({ kind: 'strategy', id: STRATEGY })).resolves.toEqual({
      resource: {
        selection: { kind: 'strategy', id: STRATEGY },
        title: 'Edited Strategy',
        observedAt,
        ownerVersion: { kind: 'timestamp', value: '2026-10-07T10:00:00.000Z' },
      },
      strategyType: 'coalition',
    });
    expect(f.queries[1]!.values).toEqual([TENANT, STRATEGY, CLIENT]);
    expect(f.queries[1]!.sql).toContain('client_id=?::uuid AND archived_at IS NULL');
    expect(f.queries[1]!.sql).toContain(
      "t.settings_jsonb->'clioFeatureFlags'->'strategyPlanner.enabled'='true'::jsonb",
    );
    expect(f.queries[1]!.sql).not.toMatch(/FOR\s+(SHARE|UPDATE)|pg_advisory/i);
    f.strategies[0]!.clientId = OTHER_CLIENT;
    await expect(f.read({ kind: 'strategy', id: STRATEGY })).resolves.toBeNull();
    f.strategies[0]!.clientId = CLIENT;
    f.strategies[0]!.archivedAt = '2026-10-08T00:00:00Z' as any;
    await expect(f.read({ kind: 'strategy', id: STRATEGY })).resolves.toBeNull();
  });

  it.each([
    null,
    {},
    [],
    { clioFeatureFlags: {} },
    { clioFeatureFlags: [] },
    { clioFeatureFlags: { 'strategyPlanner.enabled': false } },
    { clioFeatureFlags: { 'strategyPlanner.enabled': 'true' } },
    { clioFeatureFlags: { 'strategyPlanner.enabled': [true] } },
  ])(
    'requires the current strict boolean Strategy rollout flag for reads and final link validation: %j',
    async (settings: unknown) => {
      const f = fixture();
      f.tenant.settings = settings;
      await lockObjectivePlanResource(f.tx, actor, { kind: 'strategy', id: STRATEGY });
      await expect(f.read({ kind: 'strategy', id: STRATEGY })).resolves.toBeNull();
      const projectRead = await f.read({ kind: 'planner_project', id: PROJECT });
      expect(projectRead!.tasks).toHaveLength(1);
      expect(f.queries[2]!.sql).not.toContain('strategyPlanner.enabled');
    },
  );

  it('observes a disabled Strategy flag on the next read rather than a cached observation', async () => {
    const f = fixture();
    expect(await f.read({ kind: 'strategy', id: STRATEGY })).not.toBeNull();
    f.tenant.settings = { clioFeatureFlags: { 'strategyPlanner.enabled': false } };
    await expect(f.read({ kind: 'strategy', id: STRATEGY })).resolves.toBeNull();
  });

  it('returns the full same-client current task union with shared task IDs deduplicated', async () => {
    const extra = project({}, { id: SHARED_PROJECT });
    const shared = task({
      memberships: [
        { projectId: PROJECT },
        { projectId: SHARED_PROJECT },
        { projectId: SHARED_PROJECT },
      ],
    });
    const all = Array.from({ length: 137 }, (_, index) =>
      task(
        {},
        {
          id: `40000000-0000-4000-8000-${(index + 2).toString(16).padStart(12, '0')}`,
        },
      ),
    );
    const f = fixture(
      [project(), extra],
      [
        shared,
        shared,
        ...all,
        task({ clientId: OTHER_CLIENT }, { id: '40000000-0000-4000-8000-000000009999' }),
        task({}, { id: '40000000-0000-4000-8000-000000009998', archived: true }),
      ],
    );
    const result = await f.read({ kind: 'planner_project', id: PROJECT });
    expect(result!.resource).toEqual({
      selection: { kind: 'planner_project', id: PROJECT },
      title: 'Current human project',
      observedAt,
      ownerVersion: { kind: 'counter', value: 7 },
    });
    expect(result!.tasks).toHaveLength(138);
    expect(result!.tasks!.find((row) => row.resource.selection.id === TASK)).toMatchObject({
      resource: { title: 'Current human task', ownerVersion: { kind: 'counter', value: 11 } },
      status: 'blocked',
      subtype: 'approval',
      approval: 'changes_requested',
      overdue: true,
      createdAt: '2026-10-02T10:00:00.000Z',
      projectIds: [PROJECT, SHARED_PROJECT],
    });
    expect(f.queries).toHaveLength(1);
    const taskSql = f.queries[0]!;
    expect(taskSql.values).toEqual([TENANT, CLIENT, PROJECT, 'planner_project']);
    expect(taskSql.sql).toContain('s.resource_id=ANY(t.project_ids)');
    expect(taskSql.sql).toContain("lower(p.data->>'clientId')=s.client_id");
    expect(taskSql.sql).toContain("lower(t.data->>'clientId')=s.client_id");
    expect(taskSql.sql).toContain(
      "lower(candidate_membership.value->>'projectId')=s.resource_id::text",
    );
    expect(taskSql.sql).not.toMatch(
      /LIMIT|OFFSET|FOR\s+(SHARE|UPDATE)|pg_advisory|sp_draft_job|sp_version|sp_planner_resources/i,
    );
    expect(f.queries.every((query) => query.method === 'query')).toBe(true);
  });

  it('reads valid uppercase stored client UUIDs using the existing Objective destination identity normalization', async () => {
    const clientId = '2abcdef0-0000-4000-8000-000000000001';
    const f = fixture(
      [project({ clientId: clientId.toUpperCase() })],
      [task({ clientId: clientId.toUpperCase() })],
      { ...binding, clientId },
    );
    const projectRead = await f.read({ kind: 'planner_project', id: PROJECT });
    expect(projectRead!.resource.selection).toEqual({ kind: 'planner_project', id: PROJECT });
    expect(projectRead!.tasks).toHaveLength(1);
    expect(projectRead!.tasks![0]!.projectIds).toEqual([PROJECT]);
    expect((await f.read({ kind: 'planner_task', id: TASK }))!.tasks).toHaveLength(1);
    f.tasks[0]!.data.clientId = '2abcdef0-0000-4000-8000-000000000002'.toUpperCase();
    await expect(f.read({ kind: 'planner_task', id: TASK })).resolves.toBeNull();
    expect((await f.read({ kind: 'planner_project', id: PROJECT }))!.tasks).toHaveLength(0);
  });

  it('discovers uppercase membership candidates conservatively without widening canonical parent grants', async () => {
    const projectId = '3abcdef0-0000-4000-8000-000000000001';
    const p = project({}, { id: projectId });
    const t = task({ memberships: [{ projectId: projectId.toUpperCase() }] }, { projectIds: [] });
    expect(plannerTaskAccessDecision(t, [p], actor.clerkUserId)).toBeNull();
    const f = fixture([p], [t]);
    await expect(f.read({ kind: 'planner_task', id: TASK })).resolves.toBeNull();
    const projectRead = await f.read({ kind: 'planner_project', id: projectId });
    expect(projectRead!.tasks).toEqual([]);
    expect(projectRead!.taskSourceUnavailable).toBe(true);
    t.data.assigneeId = actor.clerkUserId;
    expect(plannerTaskAccessDecision(t, [p], actor.clerkUserId)).toBe('editor');
    const directTaskRead = await f.read({ kind: 'planner_task', id: TASK });
    expect(directTaskRead!.tasks).toHaveLength(1);
    expect(directTaskRead!.tasks![0]!.projectIds).toEqual([]);
  });

  it('reads selected metadata, candidate tasks and every referenced grant from one coherent statement', async () => {
    const f = fixture();
    f.afterSnapshot(() => {
      f.projects[0]!.data = { ...f.projects[0]!.data, name: 'Changed project', members: [] };
      f.projects[0]!.version = 8;
      f.tasks[0]!.data = { ...f.tasks[0]!.data, name: 'Changed task', status: 'done' };
      f.tasks[0]!.version = 12;
    });
    const result = await f.read({ kind: 'planner_project', id: PROJECT });
    expect(f.queries).toHaveLength(1);
    expect(result!.resource).toMatchObject({
      title: 'Current human project',
      ownerVersion: { kind: 'counter', value: 7 },
    });
    expect(result!.tasks![0]).toMatchObject({
      resource: { title: 'Current human task', ownerVersion: { kind: 'counter', value: 11 } },
      status: 'blocked',
      projectIds: [PROJECT],
    });
    await expect(f.read({ kind: 'planner_project', id: PROJECT })).resolves.toBeNull();
    expect(f.queries).toHaveLength(2);
  });

  it('re-reads human edits and completion state without changing source fields', async () => {
    const f = fixture();
    const initial = JSON.stringify(f.tasks[0]);
    const before = await f.read({ kind: 'planner_task', id: TASK });
    expect(before!.tasks).toHaveLength(1);
    expect(before!.tasks![0]!.overdue).toBe(true);
    expect(JSON.stringify(f.tasks[0])).toBe(initial);
    f.tasks[0]!.data = {
      ...f.tasks[0]!.data,
      name: 'Human revised milestone',
      status: 'done',
      subtype: 'milestone',
      approval: 'approved',
    };
    f.tasks[0]!.version = 12;
    const after = await f.read({ kind: 'planner_task', id: TASK });
    expect(after!.resource).toMatchObject({
      title: 'Human revised milestone',
      ownerVersion: { kind: 'counter', value: 12 },
    });
    expect(after!.tasks![0]).toMatchObject({
      status: 'done',
      subtype: 'milestone',
      approval: 'approved',
      overdue: false,
    });
    expect(f.queries.every((query) => query.method === 'query')).toBe(true);
  });

  it('orders observations by actual owner creation time, then stable task ID', async () => {
    const laterId = '40000000-0000-4000-8000-000000000009';
    const earlier = task({}, { id: laterId, createdAt: '2026-10-01T10:00:00Z' });
    const f = fixture([project()], [task(), earlier]);
    expect(
      (await f.read({ kind: 'planner_project', id: PROJECT }))!.tasks!.map(
        (row) => row.resource.selection.id,
      ),
    ).toEqual([laterId, TASK]);
    f.tasks[0]!.createdAt = earlier.createdAt;
    expect(
      (await f.read({ kind: 'planner_project', id: PROJECT }))!.tasks!.map(
        (row) => row.resource.selection.id,
      ),
    ).toEqual([TASK, laterId]);
  });

  it('preserves private project, membershipless owner, assignee, collaborator and highest-role decisions', () => {
    const privateProject = project({ members: [] });
    expect(plannerProjectAccessDecision(privateProject, 'user_outsider')).toBeNull();
    expect(plannerProjectAccessDecision(privateProject, 'user_owner')).toBe('admin');
    expect(plannerProjectAccessDecision(project({ privacy: 'team' }), actor.clerkUserId)).toBe(
      'viewer',
    );
    expect(
      plannerProjectAccessDecision(project({ privacy: 'team', members: [] }), 'user_outsider'),
    ).toBe('editor');
    expect(plannerTaskAccessDecision(task({ memberships: [] }), [], 'user_owner')).toBe('editor');
    expect(plannerTaskAccessDecision(task(), [privateProject], 'user_owner')).toBe('admin');
    expect(plannerTaskAccessDecision(task(), [privateProject], actor.clerkUserId)).toBeNull();
    expect(
      plannerTaskAccessDecision(task({ assigneeId: actor.clerkUserId }), [], actor.clerkUserId),
    ).toBe('editor');
    expect(
      plannerTaskAccessDecision(
        task({ collaborators: [actor.clerkUserId] }),
        [],
        actor.clerkUserId,
      ),
    ).toBe('commenter');
    expect(
      plannerTaskAccessDecision(
        task({ assigneeId: actor.clerkUserId, collaborators: [actor.clerkUserId] }),
        [project()],
        actor.clerkUserId,
      ),
    ).toBe('editor');
    expect(plannerTaskAccessDecision(task(), [], 'user_owner')).toBeNull();
  });

  it('denies ungranted project/task disclosure and preserves direct task grants', async () => {
    const f = fixture([project({ members: [] })]);
    await expect(f.read({ kind: 'planner_project', id: PROJECT })).resolves.toBeNull();
    expect(f.queries).toHaveLength(1);
    await expect(f.read({ kind: 'planner_task', id: TASK })).resolves.toBeNull();
    f.tasks[0]!.data.assigneeId = actor.clerkUserId;
    expect((await f.read({ kind: 'planner_task', id: TASK }))!.tasks![0]!.projectIds).toEqual([]);
    f.tasks[0]!.data.assigneeId = null;
    f.tasks[0]!.data.collaborators = [actor.clerkUserId];
    expect((await f.read({ kind: 'planner_task', id: TASK }))!.tasks).toHaveLength(1);
    f.tasks[0]!.data = { ...f.tasks[0]!.data, memberships: [], collaborators: [] };
    f.tasks[0]!.ownerId = actor.clerkUserId;
    expect((await f.read({ kind: 'planner_task', id: TASK }))!.tasks).toHaveLength(1);
  });

  it('keeps canonical archived/cross-client parent grants without exposing their metadata or IDs', async () => {
    const f = fixture([project({ clientId: OTHER_CLIENT }, { archived: true })]);
    const result = await f.read({ kind: 'planner_task', id: TASK });
    expect(result!.tasks).toHaveLength(1);
    expect(result!.tasks![0]!.projectIds).toEqual([]);
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0]!.values).toEqual([TENANT, CLIENT, TASK, 'planner_task']);
    expect(f.queries[0]!.sql).toContain("WHERE membership.value->>'projectId'=p.id::text");
    expect(f.queries[0]!.sql).toContain("WHEN jsonb_typeof(t.data->'memberships')='array'");
    expect(f.queries[0]!.sql).not.toMatch(/FOR\s+(SHARE|UPDATE)|pg_advisory/i);
  });

  it.each([
    { members: 'not-an-array' },
    { members: [{ userId: 'user_reader', role: 'invented' }] },
    { privacy: 'public' },
    { clientId: { id: CLIENT } },
  ])(
    'fails closed for malformed stored project JSON %j',
    async (patch: Record<string, unknown>) => {
      const f = fixture([project(patch)]);
      await expect(f.read({ kind: 'planner_project', id: PROJECT })).resolves.toBeNull();
    },
  );

  it.each([
    { collaborators: 'user_reader' },
    { memberships: [{ projectId: 7 }] },
    { memberships: null },
    { assigneeId: true },
    { status: 'closed' },
    { subtype: 'generated' },
    { approval: 'accepted' },
    { dueOn: '2026-02-30' },
    { dueTime: '24:00' },
    { timeZone: 'Bogus/Zone' },
    { dueTime: '12:00', timeZone: null },
  ])('fails closed for malformed stored task JSON %j', async (patch: Record<string, unknown>) => {
    const f = fixture([project()], [task(patch)]);
    await expect(f.read({ kind: 'planner_task', id: TASK })).resolves.toBeNull();
    await expect(f.read({ kind: 'planner_project', id: PROJECT })).resolves.toMatchObject({
      resource: { selection: { kind: 'planner_project', id: PROJECT } },
      tasks: [],
      taskSourceUnavailable: true,
    });
  });

  it('marks an incomplete eligible task source without hiding authorized current observations', async () => {
    const malformed = task({ status: 'unknown' }, { id: '40000000-0000-4000-8000-000000000009' });
    const f = fixture([project()], [task(), malformed]);
    const result = await f.read({ kind: 'planner_project', id: PROJECT });
    expect(result!.taskSourceUnavailable).toBe(true);
    expect(result!.tasks!.map((row) => row.resource.selection.id)).toEqual([TASK]);
    expect(JSON.stringify(result)).not.toContain(malformed.id);
  });

  it('keeps legacy missing optional task metadata on the canonical defaults', async () => {
    const f = fixture(
      [],
      [
        task(
          {},
          { ownerId: actor.clerkUserId, data: { clientId: CLIENT, name: 'Legacy personal work' } },
        ),
      ],
    );
    const result = await f.read({ kind: 'planner_task', id: TASK });
    expect(result!.tasks![0]).toMatchObject({
      status: 'todo',
      subtype: 'task',
      approval: 'pending',
      overdue: false,
      projectIds: [],
    });
  });

  it('returns null for removed, moved, foreign tenant, invalid and unsupported selections', async () => {
    for (const fields of [{ archived: true }, { tenantId: OTHER_TENANT }]) {
      const f = fixture([project()], [task({}, fields)]);
      await expect(f.read({ kind: 'planner_task', id: TASK })).resolves.toBeNull();
    }
    const f = fixture([project()], [task({ clientId: OTHER_CLIENT })]);
    await expect(f.read({ kind: 'planner_task', id: TASK })).resolves.toBeNull();
    await expect(f.read({ kind: 'planner_task', id: PROJECT })).resolves.toBeNull();
    await expect(f.read({ kind: 'planner_task', id: 'invalid' })).resolves.toBeNull();
    await expect(f.read({ kind: 'meeting', id: TASK })).resolves.toBeNull();
    await expect(f.read({ kind: 'planner_task', id: TASK }, 'not-a-date')).resolves.toBeNull();
    const missing = fixture([], []);
    await expect(
      lockObjectivePlanResource(missing.tx, actor, { kind: 'planner_task', id: TASK }),
    ).resolves.toBeUndefined();
    await expect(missing.read({ kind: 'planner_task', id: TASK })).resolves.toBeNull();
  });

  it('propagates source/gate failures so the caller cannot report partial success', async () => {
    const failure = new Error('Synthetic owner source unavailable');
    const tx: ObjectiveOperationalTx = {
      $queryRaw: async () => {
        throw failure;
      },
      $executeRaw: async () => {
        throw failure;
      },
    };
    await expect(
      lockObjectivePlanResource(tx, actor, { kind: 'planner_task', id: TASK }),
    ).rejects.toBe(failure);
    await expect(
      readObjectivePlanResource(
        tx,
        actor,
        binding,
        { kind: 'strategy', id: STRATEGY },
        observedAt,
        observedAt,
      ),
    ).rejects.toBe(failure);
  });
});

describe('Shared Planner runtime scheduling compatibility fixtures', () => {
  // A test-only compatibility import avoids a Shared runtime/package dependency.
  const canonical = require('../../strategy-verifier/src/planner-schedule');
  it.each([
    ['2026-03-08', '02:30', 'America/New_York', '2026-03-08T07:30:00.000Z'],
    ['2026-11-01', '01:30', 'America/New_York', '2026-11-01T05:30:00.000Z'],
    ['2026-10-06', '09:00', 'Asia/Kolkata', '2026-10-06T03:30:00.000Z'],
    ['2026-11-01', '09:00', 'America/New_York', '2026-11-01T14:00:00.000Z'],
  ])(
    'matches canonical gap/fold/zone instant %s %s %s',
    (date: string, time: string, zone: string, expected: string) => {
      const actual = plannerResourceScheduledInstant(date, time, zone);
      expect(actual.toISOString()).toBe(expected);
      expect(actual.getTime()).toBe(canonical.plannerScheduledInstant(date, time, zone).getTime());
    },
  );

  it('matches every canonical status and strict due-time threshold', () => {
    const due = { dueOn: '2026-11-01', dueTime: '01:30', timeZone: 'America/New_York' };
    const instant = new Date('2026-11-01T05:30:00.000Z').getTime();
    for (const status of ['todo', 'in_progress', 'blocked', 'done']) {
      for (const offset of [-1, 0, 1]) {
        const now = new Date(instant + offset);
        expect(plannerResourceTaskOverdue({ ...due, status }, now)).toBe(
          canonical.plannerTaskOverdue({ ...due, status }, now),
        );
        expect(plannerResourceTaskOverdue({ ...due, status }, now)).toBe(
          status !== 'done' && offset > 0,
        );
      }
    }
  });

  it('matches date-only local midnight, default host zone, undated and end-of-day behavior', () => {
    const fixtures = [
      { dueOn: '2026-11-01', dueTime: null, timeZone: 'America/New_York' },
      { dueOn: '2026-10-07', dueTime: null, timeZone: 'America/Los_Angeles' },
      { dueOn: '2026-10-07', dueTime: null, timeZone: null },
      { dueOn: '2026-10-07' },
      { dueOn: null },
    ];
    for (const due of fixtures) {
      expect(plannerResourceDueTimestamp(due)).toBe(canonical.plannerDueTimestamp(due));
      for (const instant of ['2026-11-02T04:59:59.999Z', '2026-11-02T05:00:00.000Z', observedAt]) {
        const now = new Date(instant);
        expect(plannerResourceTaskOverdue({ ...due, status: 'todo' }, now)).toBe(
          canonical.plannerTaskOverdue({ ...due, status: 'todo' }, now),
        );
      }
    }
    const dateOnly = { dueOn: '2026-11-01', timeZone: 'America/New_York', status: 'todo' };
    expect(plannerResourceTaskOverdue(dateOnly, new Date('2026-11-02T04:59:59.999Z'))).toBe(false);
    expect(plannerResourceTaskOverdue(dateOnly, new Date('2026-11-02T05:00:00.000Z'))).toBe(true);
    expect(plannerResourceDueTimestamp(dateOnly)).toBe(
      new Date('2026-11-02T04:59:59.999Z').getTime(),
    );
    expect(plannerResourceDueTimestamp({ dueOn: null })).toBe(Number.POSITIVE_INFINITY);
  });
});
