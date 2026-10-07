import { useState } from 'react';
import type {
  PlannerBootstrap,
  PlannerGoalData,
  PlannerResource,
  PlannerTask,
} from '@capiro/strategy-verifier';
import { PLANNER_GOAL_PROGRESS_LABELS, PLANNER_GOAL_STATUS_LABELS } from './planner-goal-editor.js';
import { PlannerFormattedText } from './planner-rich-text.js';
export function PlannerGoalDetail({
  goal,
  goals,
  bootstrap,
  tasks,
  onGoal,
  onProject,
  onTask,
  onEdit,
}: {
  goal: PlannerResource;
  goals: PlannerResource[];
  bootstrap: PlannerBootstrap;
  tasks: PlannerTask[];
  onGoal: (id: string) => void;
  onProject: (id: string) => void;
  onTask: (id: string) => void;
  onEdit: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const data = goal.data as unknown as PlannerGoalData;
  const percentage =
    goal.goalProgress?.percentage ??
    (data.progress === 'manual' ? (data.current / data.target) * 100 : 0);
  const linkedGoals = (ids: string[]) =>
    ids
      .map((id) => goals.find((g) => g.kind === 'goal' && g.id === id))
      .filter((g): g is PlannerResource => !!g);
  const parents = linkedGoals(goal.parentGoalIds ?? []),
    children = linkedGoals(data.subgoalIds ?? []);
  return (
    <div className="planner-dialog-body planner-goal-detail">
      <p className="planner-muted">
        {
          ({ company: 'Company', team: 'Team', individual: 'Individual' } as const)[
            data.goalType ?? 'team'
          ]
        }
        {data.timePeriod ? ` · ${data.timePeriod}` : ''} ·{' '}
        {bootstrap.people.find((p) => p.id === data.ownerId)?.name ?? 'Unassigned'}
      </p>
      <h3>{goal.name}</h3>
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(
              `${window.location.origin}/planner?scope=goals&goal=${encodeURIComponent(goal.id)}`,
            );
            setCopyState('copied');
          } catch {
            setCopyState('failed');
          }
        }}
      >
        {copyState === 'copied' ? 'Link copied' : 'Copy goal link'}
      </button>
      {copyState === 'failed' && (
        <p role="alert">Unable to copy the link. Copy this page�s address from your browser.</p>
      )}
      <p>
        {PLANNER_GOAL_STATUS_LABELS[data.status]}
        {data.startOn ? ` · From ${data.startOn}` : ''}
        {data.dueOn ? ` · Due ${data.dueOn}` : ''}
      </p>
      <strong>{percentage.toFixed(1)}%</strong>
      <progress max={100} value={Math.min(100, percentage)} aria-label={`${goal.name} progress`} />
      <p>
        {PLANNER_GOAL_PROGRESS_LABELS[data.progress]}
        {data.progress === 'manual' || data.progress === 'subgoal_total'
          ? ` · ${goal.goalProgress?.value ?? data.current} / ${data.target} ${data.unit}`
          : ''}
      </p>
      {data.description.trim() && <PlannerFormattedText text={data.description} />}
      {!!parents.length && (
        <section aria-label="Parent goals">
          <h3>Parent goals</h3>
          {parents.map((g) => (
            <button className="planner-related-link" key={g.id} onClick={() => onGoal(g.id)}>
              {g.name}
            </button>
          ))}
        </section>
      )}
      {!!children.length && (
        <section aria-label="Subgoals">
          <h3>Subgoals</h3>
          {children.map((g) => (
            <button className="planner-related-link" key={g.id} onClick={() => onGoal(g.id)}>
              {g.name}
              {g.archived ? ' · Archived' : ` · ${(g.goalProgress?.percentage ?? 0).toFixed(0)}%`}
            </button>
          ))}
        </section>
      )}
      {(goal.goalProgress?.sources.length ?? 0) > 0 && (
        <section aria-label="Progress contributions">
          <h3>Progress contributions</h3>
          <table className="planner-table">
            <thead>
              <tr>
                <th>Work</th>
                <th>Progress</th>
                <th>{data.progress === 'subgoal_total' ? 'Value' : 'Weight'}</th>
              </tr>
            </thead>
            <tbody>
              {goal.goalProgress!.sources.map((source) => {
                const name =
                  source.kind === 'goal'
                    ? goals.find((g) => g.id === source.id)?.name
                    : source.kind === 'project'
                      ? bootstrap.projects.find((p) => p.id === source.id)?.name
                      : tasks.find((t) => t.id === source.id)?.name;
                return (
                  <tr key={source.id}>
                    <td>
                      <button
                        className="planner-related-link"
                        onClick={() =>
                          source.kind === 'goal'
                            ? onGoal(source.id)
                            : source.kind === 'project'
                              ? onProject(source.id)
                              : onTask(source.id)
                        }
                      >
                        {name ?? 'Open connected work'}
                      </button>
                    </td>
                    <td>{source.percentage.toFixed(1)}%</td>
                    <td>
                      {data.progress === 'subgoal_total'
                        ? `${source.value} ${data.unit}`
                        : `${source.weight.toFixed(2)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      {data.projectIds.length > 0 && (
        <section aria-label="Related projects">
          <h3>Related projects</h3>
          {data.projectIds
            .map((id) => bootstrap.projects.find((p) => p.id === id))
            .filter((p): p is PlannerBootstrap['projects'][number] => !!p)
            .map((p) => (
              <button key={p.id} className="planner-related-link" onClick={() => onProject(p.id)}>
                {p.name}
              </button>
            ))}
        </section>
      )}
      {(data.taskIds?.length ?? 0) > 0 && (
        <section aria-label="Related tasks">
          <h3>Related tasks</h3>
          {(data.taskIds ?? []).map((id) => (
            <button key={id} className="planner-related-link" onClick={() => onTask(id)}>
              {tasks.find((t) => t.id === id)?.name ?? 'Open connected task'}
            </button>
          ))}
        </section>
      )}
      <p className="planner-muted">Progress reflects the connected work you can access.</p>
      {['admin', 'editor'].includes(goal.access) && (
        <button className="planner-primary" onClick={onEdit}>
          Edit goal
        </button>
      )}
    </div>
  );
}
