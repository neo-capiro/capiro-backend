import type { PlannerGoalData, PlannerGoalProgress, PlannerResource } from './planner.js';

export const PLANNER_WEIGHTED_GOAL_MODES = [
  'subgoal_percentage',
  'project_task_completion',
  'project_milestone_completion',
  'task_list_completion',
] as const;
export function plannerGoalSourceIds(data: PlannerGoalData): string[] {
  if (data.progress.startsWith('subgoal_')) return data.subgoalIds ?? [];
  if (data.progress === 'task_list_completion') return data.taskIds ?? [];
  if (data.progress.startsWith('project_')) return data.projectIds;
  return [];
}
export function plannerGoalCycle(
  goals: { id: string; data: Pick<PlannerGoalData, 'subgoalIds'> }[],
): boolean {
  const byId = new Map(goals.map((g) => [g.id, g]));
  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const goal of goals) {
    const children = (goal.data.subgoalIds ?? []).filter((id) => byId.has(id));
    remaining.set(goal.id, children.length);
    for (const child of children) {
      const parents = dependents.get(child);
      if (parents) parents.push(goal.id);
      else dependents.set(child, [goal.id]);
    }
  }
  const ready = goals.filter((g) => remaining.get(g.id) === 0).map((g) => g.id);
  let count = 0;
  for (let i = 0; i < ready.length; i++) {
    count++;
    for (const parent of dependents.get(ready[i]!) ?? []) {
      const next = remaining.get(parent)! - 1;
      remaining.set(parent, next);
      if (!next) ready.push(parent);
    }
  }
  return count !== goals.length;
}
export function plannerGoalWeights(data: PlannerGoalData, visibleIds = plannerGoalSourceIds(data)) {
  if (!visibleIds.length) return [];
  if (data.weightMode !== 'custom')
    return visibleIds.map((sourceId) => ({ sourceId, weight: 100 / visibleIds.length }));
  const visible = new Set(visibleIds);
  const weights = (data.weights ?? []).filter((w) => visible.has(w.sourceId));
  const total = weights.reduce((sum, item) => sum + item.weight, 0);
  return weights.map((item) => ({ ...item, weight: total ? (item.weight / total) * 100 : 0 }));
}
const percentage = (value: number, target: number) =>
  Math.min(100, Math.max(0, (value / target) * 100));
type GoalTask = { id: string; status: string; kind: string; projectIds: string[] };

/** Inputs have already been filtered by current access; never traverse hidden records here. */
export function plannerGoalProgress(
  goals: PlannerResource[],
  projects: Set<string>,
  tasks: GoalTask[],
): Map<string, PlannerGoalProgress> {
  const active = goals.filter((g) => g.kind === 'goal' && !g.archived);
  if (
    plannerGoalCycle(active.map((g) => ({ id: g.id, data: g.data as unknown as PlannerGoalData })))
  )
    throw new Error('Goal connections cannot form a cycle');
  const result = new Map<string, PlannerGoalProgress>();
  const byId = new Map(active.map((g) => [g.id, g]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const projectStats = new Map<
    string,
    { total: number; done: number; milestones: number; milestonesDone: number }
  >();
  for (const task of tasks)
    for (const projectId of new Set(task.projectIds)) {
      if (!projects.has(projectId)) continue;
      const stats = projectStats.get(projectId) ?? {
        total: 0,
        done: 0,
        milestones: 0,
        milestonesDone: 0,
      };
      stats.total++;
      if (task.status === 'done') stats.done++;
      if (task.kind === 'milestone') {
        stats.milestones++;
        if (task.status === 'done') stats.milestonesDone++;
      }
      projectStats.set(projectId, stats);
    }
  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const goal of active) {
    const data = goal.data as unknown as PlannerGoalData;
    const children = (data.subgoalIds ?? []).filter((id) => byId.has(id));
    remaining.set(goal.id, children.length);
    for (const child of children) {
      const parents = dependents.get(child);
      if (parents) parents.push(goal.id);
      else dependents.set(child, [goal.id]);
    }
  }
  const ready = active.filter((g) => !remaining.get(g.id)).map((g) => g.id);
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i]!;
    const data = byId.get(id)!.data as unknown as PlannerGoalData;
    let value = data.current;
    let sources: PlannerGoalProgress['sources'] = [];
    if (data.progress === 'task_completion') {
      const projectIds = new Set(data.projectIds.filter((p) => projects.has(p)));
      const matching = tasks.filter((t) => t.projectIds.some((p) => projectIds.has(p)));
      value =
        (matching.filter((t) => t.status === 'done').length / Math.max(1, matching.length)) * 100;
    } else if (data.progress !== 'manual') {
      const sourceIds = plannerGoalSourceIds(data).filter((sourceId) =>
        data.progress.startsWith('subgoal_')
          ? result.has(sourceId)
          : data.progress === 'task_list_completion'
            ? taskById.has(sourceId)
            : projects.has(sourceId),
      );
      const weights = new Map(
        plannerGoalWeights(data, sourceIds).map((w) => [w.sourceId, w.weight]),
      );
      sources = sourceIds.map((sourceId) => {
        const weight = weights.get(sourceId) ?? 0;
        if (data.progress.startsWith('subgoal_')) {
          const child = result.get(sourceId)!;
          return {
            id: sourceId,
            kind: 'goal',
            value: child.value,
            percentage: child.percentage,
            weight,
          };
        }
        if (data.progress === 'task_list_completion') {
          const completion = taskById.get(sourceId)!.status === 'done' ? 100 : 0;
          return { id: sourceId, kind: 'task', value: completion, percentage: completion, weight };
        }
        const stats = projectStats.get(sourceId);
        const milestones = data.progress === 'project_milestone_completion';
        const completion =
          (((milestones ? stats?.milestonesDone : stats?.done) ?? 0) /
            Math.max(1, (milestones ? stats?.milestones : stats?.total) ?? 0)) *
          100;
        return { id: sourceId, kind: 'project', value: completion, percentage: completion, weight };
      });
      value =
        data.progress === 'subgoal_total'
          ? sources.reduce((sum, source) => sum + source.value, 0)
          : sources.reduce((sum, source) => sum + (source.percentage * source.weight) / 100, 0);
    }
    result.set(id, {
      value,
      percentage: percentage(
        value,
        data.progress === 'manual' || data.progress === 'subgoal_total' ? data.target : 100,
      ),
      sources,
    });
    for (const parent of dependents.get(id) ?? []) {
      const next = remaining.get(parent)! - 1;
      remaining.set(parent, next);
      if (!next) ready.push(parent);
    }
  }
  return result;
}
