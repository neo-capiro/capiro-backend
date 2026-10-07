import type { PlannerGoalData, PlannerResource } from '@capiro/strategy-verifier';
import {
  plannerGoalCycle,
  plannerGoalProgress,
  plannerGoalWeights,
  plannerGoalPercentage,
} from './planner-goals.js';
import { validateResource } from './planner-resources.js';

const id = (n: number) => `21000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const goalData = (patch: Partial<PlannerGoalData> = {}): PlannerGoalData => ({
  description: '',
  privacy: 'private',
  members: [],
  projectIds: [],
  ownerId: null,
  dueOn: null,
  status: 'on_track',
  progress: 'manual',
  current: 0,
  target: 100,
  unit: '%',
  ...patch,
});
const goal = (
  n: number,
  patch: Partial<PlannerGoalData> = {},
  archived = false,
): PlannerResource => ({
  id: id(n),
  kind: 'goal',
  projectId: null,
  ownerId: 'owner',
  name: `Goal ${n}`,
  data: goalData(patch) as unknown as Record<string, unknown>,
  version: 1,
  archived,
  access: 'admin',
});
describe('Planner goal progress and graph contracts', () => {
  it('distinguishes an average of project percentages from a global task ratio and counts milestones separately', () => {
    const projects = new Set([id(10), id(11)]);
    const tasks = [
      { id: id(20), status: 'done', kind: 'task', projectIds: [id(10), id(11)] },
      { id: id(21), status: 'todo', kind: 'milestone', projectIds: [id(11)] },
      { id: id(22), status: 'todo', kind: 'approval', projectIds: [id(11)] },
      { id: id(23), status: 'done', kind: 'milestone', projectIds: [id(11)] },
    ];
    const result = plannerGoalProgress(
      [
        goal(1, { progress: 'project_task_completion', projectIds: [id(10), id(11)] }),
        goal(2, { progress: 'task_completion', projectIds: [id(10), id(11)] }),
        goal(3, { progress: 'project_milestone_completion', projectIds: [id(11)] }),
      ],
      projects,
      tasks,
    );
    expect(result.get(id(1))?.percentage).toBe(75);
    expect(result.get(id(2))?.percentage).toBe(50);
    expect(result.get(id(3))?.percentage).toBe(50);
  });
  it('rolls up weighted subgoals in dependency order and totals compatible numeric values', () => {
    const result = plannerGoalProgress(
      [
        goal(1, {
          progress: 'subgoal_percentage',
          subgoalIds: [id(2), id(3)],
          weightMode: 'custom',
          weights: [
            { sourceId: id(2), weight: 75 },
            { sourceId: id(3), weight: 25 },
          ],
        }),
        goal(2, { current: 50 }),
        goal(3, { current: 100 }),
        goal(4, {
          progress: 'subgoal_total',
          subgoalIds: [id(5), id(6)],
          unit: 'USD',
          target: 1000,
        }),
        goal(5, { current: 100, target: 200, unit: 'USD' }),
        goal(6, { current: 200, target: 500, unit: 'USD' }),
      ],
      new Set(),
      [],
    );
    expect(result.get(id(1))).toMatchObject({ value: 62.5, percentage: 62.5 });
    expect(result.get(id(4))).toMatchObject({ value: 300, percentage: 30 });
  });
  it('uses selected tasks directly, ignores unavailable/archived sources and normalizes only visible weights', () => {
    const data = goalData({
      progress: 'task_list_completion',
      taskIds: [id(20), id(21)],
      weightMode: 'custom',
      weights: [
        { sourceId: id(20), weight: 25 },
        { sourceId: id(21), weight: 75 },
      ],
    });
    expect(plannerGoalWeights(data, [id(20)])).toEqual([{ sourceId: id(20), weight: 100 }]);
    const result = plannerGoalProgress(
      [
        goal(1, data),
        goal(2, { progress: 'subgoal_percentage', subgoalIds: [id(3), id(4)] }),
        goal(3, { current: 50 }),
        goal(4, { current: 100 }, true),
      ],
      new Set(),
      [{ id: id(20), status: 'done', kind: 'task', projectIds: [] }],
    );
    expect(result.get(id(1))?.percentage).toBe(100);
    expect(result.get(id(1))?.sources).toHaveLength(1);
    expect(result.get(id(2))?.percentage).toBe(50);
    expect(result.has(id(4))).toBe(false);
  });
  it('detects self/indirect cycles and safely handles a deep hierarchy without recursion', () => {
    expect(plannerGoalCycle([{ id: id(1), data: { subgoalIds: [id(1)] } }])).toBe(true);
    expect(
      plannerGoalCycle([
        { id: id(1), data: { subgoalIds: [id(2)] } },
        { id: id(2), data: { subgoalIds: [id(1)] } },
      ]),
    ).toBe(true);
    const goals = Array.from({ length: 3000 }, (_, i) =>
      goal(i + 1, { subgoalIds: i < 2999 ? [id(i + 2)] : [], progress: 'subgoal_percentage' }),
    );
    expect(
      plannerGoalCycle(
        goals.map((g) => ({ id: g.id, data: g.data as unknown as PlannerGoalData })),
      ),
    ).toBe(false);
    expect(plannerGoalProgress(goals, new Set(), []).size).toBe(3000);
  });
  it('measures increasing and decreasing intervals from their original starting value', () => {
    const increasing = goalData({ startValue: 100, target: 200, current: 150 });
    const decreasing = goalData({ startValue: 100, target: 0, current: 25, direction: 'decrease' });
    expect(plannerGoalPercentage(increasing)).toBe(50);
    expect(plannerGoalPercentage(decreasing)).toBe(75);
    expect(plannerGoalPercentage(decreasing, 120)).toBe(0);
    expect(plannerGoalPercentage(decreasing, -10)).toBe(100);
    const result = plannerGoalProgress(
      [
        goal(1, decreasing),
        goal(2, { current: 25 }),
        goal(3, { progress: 'subgoal_percentage', subgoalIds: [id(1), id(2)] }),
        goal(4, {
          progress: 'subgoal_total',
          subgoalIds: [id(1), id(2)],
          startValue: 100,
          target: 0,
          direction: 'decrease',
        }),
      ],
      new Set(),
      [],
    );
    expect(result.get(id(3))?.percentage).toBe(50);
    expect(result.get(id(4))).toMatchObject({ value: 50, percentage: 50 });
  });
  it('validates directional intervals while keeping legacy measurements compatible', () => {
    expect(
      validateResource('goal', goalData({ startValue: 100, target: 0, direction: 'decrease' })),
    ).toBeDefined();
    expect(validateResource('goal', goalData({ startValue: -100, target: 0 }))).toBeDefined();
    for (const patch of [
      { startValue: 100, target: 100 },
      { startValue: 0, target: 100, direction: 'decrease' },
      { startValue: 100, target: 0, direction: 'increase' },
      { startValue: NaN },
      { target: 0 },
      { progress: 'project_task_completion', direction: 'decrease' },
      { progress: 'project_task_completion', startValue: 10 },
    ])
      expect(() => validateResource('goal', goalData(patch as Partial<PlannerGoalData>))).toThrow();
    expect(validateResource('goal', goalData())).toBeDefined();
  });
  it('validates complete custom weights, source identities, supported modes and date ordering', () => {
    const valid = goalData({
      progress: 'subgoal_percentage',
      subgoalIds: [id(2), id(3)],
      weightMode: 'custom',
      weights: [
        { sourceId: id(2), weight: 70 },
        { sourceId: id(3), weight: 30 },
      ],
      startOn: '2026-10-01',
      dueOn: '2026-12-31',
      timePeriod: 'Q4 2026',
      goalType: 'company',
    });
    expect(validateResource('goal', valid)).toEqual(valid);
    for (const patch of [
      {
        weights: [
          { sourceId: id(2), weight: 70 },
          { sourceId: id(3), weight: 31 },
        ],
      },
      { weights: [{ sourceId: id(2), weight: 100 }] },
      {
        weights: [
          { sourceId: id(2), weight: 70 },
          { sourceId: id(9), weight: 30 },
        ],
      },
      {
        weights: [
          { sourceId: id(2), weight: NaN },
          { sourceId: id(3), weight: 30 },
        ],
      },
      { progress: 'manual' },
      { progress: 'subgoal_total' },
      { weightMode: 'equal' },
      { subgoalIds: [id(2), id(2)] },
      { taskIds: ['invalid'] },
      { startOn: '2026-02-30' },
      { startOn: '2027-01-01' },
      { goalType: 'other' },
    ])
      expect(() => validateResource('goal', { ...valid, ...patch })).toThrow();
  });
});
