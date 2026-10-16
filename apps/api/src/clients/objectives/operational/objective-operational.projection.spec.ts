import { HttpException } from '@nestjs/common';
import type {
  ObjectiveOperationalResource,
  ObjectiveOperationalSourceRead,
  ObjectiveOperationalTaskObservation,
} from '@capiro/shared';
import { ObjectiveOperationalCursors } from './objective-operational.cursor.js';
import {
  assembleOperationalProjection,
  type OperationalProjectionInput,
} from './objective-operational.projection.js';
import { operationalDigest } from './objective-operational.rules.js';
import type { OperationalLinkRecord } from './objective-operational.store.js';
import type { OperationalResourceKind } from './objective-operational.types.js';

function id(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}
const asOf = '2026-10-15T12:00:00.000Z';
const observedAt = '2026-10-15T12:00:01.000Z';
const later = '2026-10-15T12:01:00.000Z';
function resource(
  kind: OperationalResourceKind,
  value: number,
  title: string | null = `Resource ${value}`,
): ObjectiveOperationalResource {
  return {
    selection: { kind, id: id(value) },
    title,
    ownerVersion: { kind: 'counter', value: 3 },
    observedAt,
  };
}
function link(
  kind: OperationalResourceKind,
  value: number,
  association = value + 1000,
): OperationalLinkRecord {
  return {
    id: id(association),
    resourceKind: kind,
    resourceId: id(value),
    linkedRevisionId: id(80),
    linkedObjectiveVersion: 2,
    linkedAt: new Date('2026-10-01T00:00:00.000Z'),
    cycles: [],
    removedAt: null,
  };
}
function task(
  value: number,
  projects: number[],
  overrides: Partial<ObjectiveOperationalTaskObservation> = {},
): ObjectiveOperationalTaskObservation {
  return {
    resource: resource('planner_task', value),
    status: 'todo',
    subtype: 'task',
    approval: 'pending',
    overdue: false,
    projectIds: projects.map(id),
    createdAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}
function observation(
  kind: OperationalResourceKind,
  value: number,
  source: Partial<ObjectiveOperationalSourceRead> = {},
) {
  return { link: link(kind, value), source: { resource: resource(kind, value), ...source } };
}
function input(
  observations: OperationalProjectionInput['observations'] = [],
): OperationalProjectionInput {
  return {
    actor: {
      tenantId: id(1),
      tenantSlug: 'fixture',
      userId: id(2),
      clerkUserId: 'user_fixture',
      role: 'standard_user',
    },
    scope: {
      clientId: id(3),
      objectiveId: id(4),
      currentRevisionId: id(5),
      objectiveVersion: 9,
      objectiveStatus: 'ready',
      ownerUserId: null,
    },
    setVersion: 0,
    request: {
      schemaVersion: 1,
      clientId: id(3),
      objectiveId: id(4),
      limit: 20,
      cursors: { strategies: null, projects: null, decisions: null, engagements: null },
    },
    asOf,
    observedAt,
    observations,
  };
}
function expectStale(action: () => unknown): void {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(409);
    expect((error as HttpException).getResponse()).toMatchObject({ code: 'CURSOR_STALE' });
    return;
  }
  throw new Error('Expected stale cursor rejection');
}

describe('Objective operational pure receiving projection', () => {
  it('distinguishes an implemented empty set from unavailable owners and preserves explicit gaps', () => {
    const result = assembleOperationalProjection(input(), new ObjectiveOperationalCursors());
    for (const name of ['strategies', 'projects', 'decisions', 'engagements'] as const) {
      expect(result.sections[name]).toMatchObject({
        coverage: 'complete',
        reasons: [],
        total: 0,
        nextCursor: null,
        items: [],
      });
      expect(result.sections[name].snapshotId).toMatch(
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
      );
    }
    expect(result.associationSetVersion).toBe(0);
    expect(result.plannerMetrics).toMatchObject({
      coverage: 'complete',
      taskCount: 0,
      doneCount: 0,
      overdueCount: 0,
      asOf,
    });
    expect(result.sections.questions).toMatchObject({
      coverage: 'not_implemented',
      total: null,
      items: [],
    });
    expect(result.automation).toEqual({ availability: 'not_implemented', projection: null });
    expect(result.actions).toEqual([{ kind: 'edit_objective', expectedObjectiveVersion: 9 }]);
    const { projectionDigest, ...publicResponse } = result;
    expect(projectionDigest).toBe(operationalDigest(publicResponse));
  });

  it('keeps original link revision/via, merges explicit cycles and never manufactures saved-version pins', () => {
    const first = observation('strategy', 10, { strategyType: 'appropriations' });
    first.link.cycles = [
      { fiscalYear: 2028, authorityTrack: null, basis: 'human_annotation', context: null },
    ];
    const second = {
      ...first,
      link: {
        ...first.link,
        id: id(2000),
        cycles: [
          first.link.cycles[0]!,
          {
            fiscalYear: 2027,
            authorityTrack: 'explicit',
            basis: 'human_annotation' as const,
            context: null,
          },
        ],
      },
    };
    const result = assembleOperationalProjection(
      input([first, second]),
      new ObjectiveOperationalCursors(),
    );
    const row = result.sections.strategies.items[0]!;
    expect(result.sections.strategies.total).toBe(1);
    expect(row.savedVersions).toEqual([]);
    expect(row.cycles.map((cycle) => cycle.fiscalYear).sort()).toEqual([2027, 2028]);
    expect(row.provenance).toHaveLength(2);
    expect(row.provenance[0]).toMatchObject({
      kind: 'manual',
      linkedRevision: { id: id(80), version: 2 },
      via: { kind: 'strategy', id: id(10) },
    });
    expect(result.actions.every((action) => action.kind !== 'open_generated_strategy')).toBe(true);
  });

  it('uses source title then ID ordering without changing nullable or empty titles', () => {
    const observations = [30, 20, 10].map((value) =>
      observation('strategy', value, {
        resource: resource('strategy', value, value === 30 ? 'Zed' : value === 20 ? '' : null),
        strategyType: 'coalition',
      }),
    );
    const result = assembleOperationalProjection(
      input(observations),
      new ObjectiveOperationalCursors(),
    );
    expect(
      result.sections.strategies.items.map((row) => [
        row.resource.selection.id,
        row.resource.title,
      ]),
    ).toEqual([
      [id(10), null],
      [id(20), ''],
      [id(30), 'Zed'],
    ]);
  });

  it('counts the complete unique task union independently of project pagination and default approval fields', () => {
    const shared = task(100, [10, 20], { subtype: 'approval', overdue: true });
    const done = task(101, [10], { status: 'done', overdue: true });
    const normal = task(102, [20]);
    const direct = task(103, [], { subtype: 'approval', createdAt: '2026-10-01T00:00:00.000Z' });
    const request = input([
      observation('planner_project', 10, { tasks: [shared, done] }),
      observation('planner_project', 20, { tasks: [shared, normal] }),
      observation('planner_task', 100, { tasks: [shared] }),
      observation('planner_task', 103, { tasks: [direct] }),
    ]);
    request.request.limit = 1;
    const result = assembleOperationalProjection(request, new ObjectiveOperationalCursors());
    expect(result.sections.projects.items).toHaveLength(1);
    expect(result.sections.projects.total).toBe(2);
    expect(result.plannerMetrics).toMatchObject({
      coverage: 'complete',
      taskCount: 4,
      doneCount: 1,
      overdueCount: 1,
    });
    expect(result.sections.decisions.total).toBe(2);
    expect(result.sections.decisions.items[0]).toMatchObject({
      kind: 'planner_approval',
      task: { selection: { id: id(103) } },
    });
    expect(result.actions).toContainEqual({
      kind: 'review_planner_approval',
      taskId: id(103),
      taskVersion: 3,
    });
    expect(JSON.stringify(result.sections.decisions.items)).not.toContain(id(102));
  });

  it('preserves each actual project/direct selection in shared-task provenance', () => {
    const shared = task(100, [10, 20], { subtype: 'approval' });
    const result = assembleOperationalProjection(
      input([
        observation('planner_project', 10, { tasks: [shared] }),
        observation('planner_project', 20, { tasks: [shared] }),
        observation('planner_task', 100, { tasks: [shared] }),
      ]),
      new ObjectiveOperationalCursors(),
    );
    const row = result.sections.decisions.items[0]!;
    expect(row.provenance.map((entry) => (entry.kind === 'manual' ? entry.via : null))).toEqual(
      expect.arrayContaining([
        { kind: 'planner_project', id: id(10) },
        { kind: 'planner_project', id: id(20) },
        { kind: 'planner_task', id: id(100) },
      ]),
    );
    expect(row.provenance).toHaveLength(3);
  });

  it('never attributes an unrelated task to a project and refuses contradictory task observations', () => {
    const unbound = assembleOperationalProjection(
      input([observation('planner_project', 10, { tasks: [task(100, [99])] })]),
      new ObjectiveOperationalCursors(),
    );
    expect(unbound.plannerMetrics).toMatchObject({
      coverage: 'partial',
      taskCount: null,
      doneCount: null,
      overdueCount: null,
    });
    expect(unbound.sections.decisions.items).toEqual([]);
    const conflicting = assembleOperationalProjection(
      input([
        observation('planner_project', 10, {
          tasks: [task(100, [10, 20], { subtype: 'approval' })],
        }),
        observation('planner_project', 20, {
          tasks: [task(100, [10, 20], { subtype: 'approval', status: 'done' })],
        }),
      ]),
      new ObjectiveOperationalCursors(),
    );
    expect(conflicting.plannerMetrics.taskCount).toBeNull();
    expect(conflicting.sections.decisions.items).toEqual([]);
  });

  it('retains authorized partial project rows with null totals and omits all hidden provenance and IDs', () => {
    const hidden = link('planner_project', 999, 888);
    const result = assembleOperationalProjection(
      input([observation('planner_project', 10, { tasks: [] }), { link: hidden, source: null }]),
      new ObjectiveOperationalCursors(),
    );
    expect(result.sections.projects).toMatchObject({ coverage: 'partial', total: null });
    expect(result.sections.projects.items).toHaveLength(1);
    expect(result.plannerMetrics).toMatchObject({
      taskCount: null,
      doneCount: null,
      overdueCount: null,
    });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(id(999));
    expect(encoded).not.toContain(id(888));
    expect(result.sections.decisions).toMatchObject({
      coverage: 'unavailable',
      total: null,
      snapshotId: null,
      items: [],
    });
  });

  it('does not manufacture proposal titles/dates or scheduled meetings from Outreach sessions', () => {
    const result = assembleOperationalProjection(
      input([
        observation('outreach_session', 10, {
          resource: resource('outreach_session', 10, null),
          pendingProposals: [],
          decisionSourceUnavailable: true,
        }),
      ]),
      new ObjectiveOperationalCursors(),
    );
    expect(result.sections.decisions).toMatchObject({
      coverage: 'unavailable',
      total: null,
      items: [],
    });
    expect(result.sections.engagements).toMatchObject({
      coverage: 'complete',
      total: 0,
      items: [],
    });
    expect(result.actions).toHaveLength(1);
  });

  it('selects real future starts in order and withholds next engagement under incomplete meeting coverage', () => {
    const observations = [
      observation('meeting', 11, { startsAt: '2026-10-16T12:00:00.000Z', endsAt: null }),
      observation('meeting', 10, { startsAt: asOf, endsAt: null }),
      observation('meeting', 12, { startsAt: '2026-10-14T12:00:00.000Z', endsAt: null }),
    ];
    const complete = assembleOperationalProjection(
      input(observations),
      new ObjectiveOperationalCursors(),
    );
    expect(complete.sections.engagements.items.map((row) => row.resource.selection.id)).toEqual([
      id(10),
      id(11),
    ]);
    const partial = assembleOperationalProjection(
      input([...observations, { link: link('meeting', 99), source: null }]),
      new ObjectiveOperationalCursors(),
    );
    expect(partial.sections.engagements).toMatchObject({
      coverage: 'unavailable',
      total: null,
      snapshotId: null,
      nextCursor: null,
      items: [],
    });
  });
});

describe('Objective operational independent page cursors', () => {
  function fixture(): OperationalProjectionInput {
    const request = input(
      [30, 10, 20].map((value) => observation('planner_project', value, { tasks: [] })),
    );
    request.request.limit = 1;
    return request;
  }

  it('continues every page under fresh observation times and accounts for the exact complete total', () => {
    const cursors = new ObjectiveOperationalCursors();
    const request = fixture();
    const first = assembleOperationalProjection(request, cursors);
    const ids = first.sections.projects.items.map((row) => row.resource.selection.id);
    const snapshot = first.sections.projects.snapshotId;
    let next = first.sections.projects.nextCursor;
    while (next !== null) {
      request.request.cursors.projects = next;
      request.observedAt = later;
      for (const entry of request.observations)
        if (entry.source) entry.source.resource.observedAt = later;
      const result = assembleOperationalProjection(request, cursors);
      expect(result.sections.projects.total).toBe(3);
      expect(result.sections.projects.snapshotId).toBe(snapshot);
      ids.push(...result.sections.projects.items.map((row) => row.resource.selection.id));
      next = result.sections.projects.nextCursor;
    }
    expect(ids).toEqual([id(10), id(20), id(30)]);
    expect(first.plannerMetrics.taskCount).toBe(0);
  });

  it.each(['actor', 'scope', 'set', 'limit', 'section', 'source', 'tasks', 'asOf'] as const)(
    'rejects %s drift',
    (drift) => {
      const cursors = new ObjectiveOperationalCursors();
      const request = fixture();
      const token = assembleOperationalProjection(request, cursors).sections.projects.nextCursor!;
      request.request.cursors.projects = token;
      if (drift === 'actor') request.actor.userId = id(88);
      if (drift === 'scope') request.scope.currentRevisionId = id(88);
      if (drift === 'set') request.setVersion += 1;
      if (drift === 'limit') request.request.limit = 2;
      if (drift === 'section') {
        request.request.cursors.projects = null;
        request.request.cursors.strategies = token;
      }
      if (drift === 'source') request.observations[0]!.source!.resource.title = 'Edited';
      if (drift === 'tasks') request.observations[0]!.source!.tasks = [task(100, [30])];
      if (drift === 'asOf') request.asOf = later;
      expectStale(() => assembleOperationalProjection(request, cursors));
    },
  );

  it('refuses end/out-of-range offsets and a newly hidden owner', () => {
    const cursors = new ObjectiveOperationalCursors();
    const request = fixture();
    const first = assembleOperationalProjection(request, cursors);
    for (const offset of [3, 99]) {
      request.request.cursors.projects = cursors.encode(
        request.actor.tenantId,
        request.actor.userId,
        request.scope,
        request.setVersion,
        'projects',
        first.sections.projects.snapshotId!,
        request.asOf,
        1,
        offset,
      );
      expectStale(() => assembleOperationalProjection(request, cursors));
    }
    request.request.cursors.projects = first.sections.projects.nextCursor;
    request.observations[0]!.source = null;
    expectStale(() => assembleOperationalProjection(request, cursors));
  });

  it('never emits actions for rows outside the requested page', () => {
    const result = assembleOperationalProjection(fixture(), new ObjectiveOperationalCursors());
    const opened = result.actions.filter((action) => action.kind === 'open_resource');
    expect(opened).toEqual([
      {
        kind: 'open_resource',
        resource: { kind: 'planner_project', id: id(10) },
        ownerVersion: { kind: 'counter', value: 3 },
        contentView: 'current',
      },
    ]);
  });

  it('refuses tampered, noncanonical signature and previous-process cursors', () => {
    const cursors = new ObjectiveOperationalCursors();
    const value = fixture();
    const token = assembleOperationalProjection(value, cursors).sections.projects.nextCursor!;
    for (const altered of [token + '\n', token + '=', 'x' + token, token.slice(0, -3)]) {
      value.request.cursors.projects = altered;
      expectStale(() => assembleOperationalProjection(value, cursors));
    }
    value.request.cursors.projects = token;
    expectStale(() => assembleOperationalProjection(value, new ObjectiveOperationalCursors()));
  });
});
