import { useMemo, type ReactNode } from 'react';
import {
  PLANNER_WEIGHTED_GOAL_MODES,
  plannerGoalSourceIds,
  type PlannerBootstrap,
  type PlannerGoalData,
  type PlannerResource,
  type PlannerTask,
} from '@capiro/strategy-verifier';

export const PLANNER_GOAL_PROGRESS_LABELS: Record<PlannerGoalData['progress'], string> = {
  manual: 'Manual value',
  task_completion: 'All tasks in linked projects',
  project_task_completion: 'Project task completion',
  project_milestone_completion: 'Project milestone completion',
  task_list_completion: 'Selected task completion',
  subgoal_percentage: 'Average subgoal progress',
  subgoal_total: 'Total subgoal values',
};
export const PLANNER_GOAL_STATUS_LABELS: Record<PlannerGoalData['status'], string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
  achieved: 'Achieved',
  partial: 'Partial',
  missed: 'Missed',
  dropped: 'Dropped',
};
function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <label className="planner-field">
      <span>{name}</span>
      {children}
    </label>
  );
}
export function PlannerGoalEditor({
  goal,
  id,
  goals,
  bootstrap,
  tasks,
  edit,
}: {
  goal: PlannerGoalData;
  id?: string;
  goals: PlannerResource[];
  bootstrap: PlannerBootstrap;
  tasks: PlannerTask[];
  edit: (patch: Partial<PlannerGoalData>) => void;
}) {
  const sourceIds = plannerGoalSourceIds(goal);
  const weighted = (PLANNER_WEIGHTED_GOAL_MODES as readonly string[]).includes(goal.progress);
  const numeric = goal.progress === 'manual' || goal.progress === 'subgoal_total';
  const sources = goal.progress.startsWith('subgoal_')
    ? (goal.subgoalIds ?? [])
    : goal.progress === 'task_list_completion'
      ? (goal.taskIds ?? [])
      : goal.projectIds;
  const sourceName = (sourceId: string) =>
    goal.progress.startsWith('subgoal_')
      ? goals.find((g) => g.id === sourceId)?.name
      : goal.progress === 'task_list_completion'
        ? tasks.find((t) => t.id === sourceId)?.name
        : bootstrap.projects.find((p) => p.id === sourceId)?.name;
  const sourceKey = goal.progress.startsWith('subgoal_')
    ? 'subgoalIds'
    : goal.progress === 'task_list_completion'
      ? 'taskIds'
      : 'projectIds';
  const updateSources = (key: 'projectIds' | 'subgoalIds' | 'taskIds', ids: string[]) =>
    edit({
      [key]: ids,
      ...(goal.weightMode === 'custom' && sourceKey === key
        ? {
            weights: ids.map((sourceId) => ({ sourceId, weight: 100 / Math.max(1, ids.length) })),
            ...(ids.length ? {} : { weightMode: 'equal' }),
          }
        : {}),
    });
  const ancestors = useMemo(() => {
    const parents = new Map<string, string[]>();
    for (const g of goals.filter((g) => g.kind === 'goal'))
      for (const child of (g.data as unknown as PlannerGoalData).subgoalIds ?? []) {
        const linked = parents.get(child);
        if (linked) linked.push(g.id);
        else parents.set(child, [g.id]);
      }
    const found = new Set<string>();
    const queue = id ? [id] : [];
    for (let i = 0; i < queue.length; i++)
      for (const parent of parents.get(queue[i]!) ?? [])
        if (!found.has(parent)) {
          found.add(parent);
          queue.push(parent);
        }
    return found;
  }, [goals, id]);
  return (
    <>
      <div className="planner-form-grid">
        <Field name="Owner">
          <select
            value={goal.ownerId ?? ''}
            onChange={(e) => edit({ ownerId: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            {bootstrap.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field name="Goal type">
          <select
            value={goal.goalType ?? 'team'}
            onChange={(e) => edit({ goalType: e.target.value as PlannerGoalData['goalType'] })}
          >
            <option value="company">Company</option>
            <option value="team">Team</option>
            <option value="individual">Individual</option>
          </select>
        </Field>
        <Field name="Time period">
          <input
            maxLength={100}
            placeholder="e.g. Q4 2026"
            value={goal.timePeriod ?? ''}
            onChange={(e) => edit({ timePeriod: e.target.value })}
          />
        </Field>
        <Field name="Start date">
          <input
            type="date"
            value={goal.startOn ?? ''}
            onInput={(e) => edit({ startOn: e.currentTarget.value || null })}
            onChange={(e) => edit({ startOn: e.target.value || null })}
          />
        </Field>
        <Field name="Due date">
          <input
            type="date"
            value={goal.dueOn ?? ''}
            onInput={(e) => edit({ dueOn: e.currentTarget.value || null })}
            onChange={(e) => edit({ dueOn: e.target.value || null })}
          />
        </Field>
        <Field name="Status">
          <select
            value={goal.status}
            onChange={(e) => edit({ status: e.target.value as PlannerGoalData['status'] })}
          >
            {Object.entries(PLANNER_GOAL_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field name="Progress measurement">
          <select
            value={goal.progress}
            onChange={(e) => {
              const progress = e.target.value as PlannerGoalData['progress'];
              edit({
                progress,
                weightMode: 'equal',
                weights: [],
                ...(progress === 'manual' || progress === 'subgoal_total'
                  ? {}
                  : { target: 100, unit: '%', startValue: 0, direction: 'increase' }),
              });
            }}
          >
            {Object.entries(PLANNER_GOAL_PROGRESS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        {goal.progress === 'manual' && (
          <Field name="Current value">
            <input
              type="number"
              min={-1000000}
              max={1000000}
              step="any"
              value={goal.current}
              onChange={(e) => edit({ current: Number(e.target.value) })}
            />
          </Field>
        )}
        {numeric && (
          <>
            <Field name="Goal direction">
              <select
                value={goal.direction ?? 'increase'}
                onChange={(e) => edit({ direction: e.target.value as 'increase' | 'decrease' })}
              >
                <option value="increase">Increase value</option>
                <option value="decrease">Decrease value</option>
              </select>
            </Field>
            <Field name="Starting value">
              <input
                type="number"
                required
                min={-1000000}
                max={1000000}
                step="any"
                value={goal.startValue ?? 0}
                onChange={(e) => edit({ startValue: Number(e.target.value) })}
              />
            </Field>
            <Field name="Target">
              <input
                type="number"
                required
                min={-1000000}
                max={1000000}
                step="any"
                value={goal.target}
                onChange={(e) => edit({ target: Number(e.target.value) })}
              />
            </Field>
            <Field name="Unit">
              <input
                required
                maxLength={100}
                value={goal.unit}
                onChange={(e) => edit({ unit: e.target.value })}
              />
            </Field>
          </>
        )}
      </div>
      <h3>Connected work</h3>
      <Field name="Connected projects">
        <select
          multiple
          value={goal.projectIds}
          onChange={(e) =>
            updateSources(
              'projectIds',
              Array.from(e.target.selectedOptions, (o) => o.value),
            )
          }
        >
          {bootstrap.projects
            .filter((p) => !p.archived || goal.projectIds.includes(p.id))
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.archived ? ' (archived)' : ''}
              </option>
            ))}
        </select>
      </Field>
      <Field name="Connected subgoals">
        <select
          multiple
          value={goal.subgoalIds ?? []}
          onChange={(e) =>
            updateSources(
              'subgoalIds',
              Array.from(e.target.selectedOptions, (o) => o.value),
            )
          }
        >
          {goals
            .filter(
              (g) =>
                g.kind === 'goal' &&
                g.id !== id &&
                (!g.archived || (goal.subgoalIds ?? []).includes(g.id)),
            )
            .map((g) => (
              <option
                key={g.id}
                value={g.id}
                disabled={
                  ancestors.has(g.id) ||
                  (goal.progress === 'subgoal_total' &&
                    g.data.unit !== goal.unit &&
                    !(goal.subgoalIds ?? []).includes(g.id))
                }
              >
                {g.name}
                {g.archived ? ' (archived)' : ''}
              </option>
            ))}
        </select>
      </Field>
      <Field name="Connected tasks">
        <select
          multiple
          value={goal.taskIds ?? []}
          onChange={(e) =>
            updateSources(
              'taskIds',
              Array.from(e.target.selectedOptions, (o) => o.value),
            )
          }
        >
          {(goal.taskIds ?? [])
            .filter((id) => !tasks.some((t) => t.id === id))
            .map((id) => (
              <option key={id} value={id}>
                Connected task (loading name)
              </option>
            ))}
          {tasks
            .filter((t) => !t.archived)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
      </Field>
      {weighted && (
        <>
          <Field name="Progress weights">
            <select
              value={goal.weightMode ?? 'equal'}
              onChange={(e) =>
                edit({
                  weightMode: e.target.value as 'equal' | 'custom',
                  weights:
                    e.target.value === 'custom'
                      ? sourceIds.map((sourceId) => ({ sourceId, weight: 100 / sourceIds.length }))
                      : [],
                })
              }
            >
              <option value="equal">Equal shares</option>
              <option value="custom" disabled={!sourceIds.length}>
                Custom weights
              </option>
            </select>
          </Field>
          {goal.weightMode === 'custom' && sources.length > 0 && (
            <div role="group" aria-label="Custom goal weights">
              {sources.map((sourceId) => (
                <Field
                  key={sourceId}
                  name={`Weight for ${sourceName(sourceId) ?? 'Connected work'} (%)`}
                >
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="any"
                    value={goal.weights?.find((w) => w.sourceId === sourceId)?.weight ?? 0}
                    onChange={(e) => {
                      const weight = Number(e.target.value);
                      edit({
                        weights: sourceIds.map((id) => ({
                          sourceId: id,
                          weight:
                            id === sourceId
                              ? weight
                              : (goal.weights?.find((w) => w.sourceId === id)?.weight ?? 0),
                        })),
                      });
                    }}
                  />
                </Field>
              ))}
              <p role="status">
                Total: {(goal.weights ?? []).reduce((sum, w) => sum + w.weight, 0).toFixed(2)}% ·
                Must equal 100%.
              </p>
              <p className="planner-muted">
                Adding or removing a progress source resets its custom weights to equal shares.
              </p>
            </div>
          )}
        </>
      )}
      <p className="planner-muted">
        Automatic progress reflects work you can access. Connecting work keeps its existing privacy
        and permissions. Connections remain available when you change the progress measurement.
      </p>
    </>
  );
}
