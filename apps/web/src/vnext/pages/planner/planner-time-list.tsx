import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Flag } from 'lucide-react';
import {
  PLANNER_STATUS_LABELS,
  plannerTaskOverdue,
  plannerTimeLabel,
  plannerTimeRollups,
  plannerTimeTotal,
  type PlannerTask,
  type PlannerTimeTreeNode,
} from '@capiro/strategy-verifier';
import { PlannerList, TaskCheck, plannerDueLabel, type TaskViewProps } from './planner-views.js';
import { plannerError, usePlannerKey, usePlannerTasks } from './planner-api.js';
import { usePlannerTimeTree, type PlannerTimeTreeScope } from './planner-time-tree-api.js';
type ListProps = TaskViewProps & {
  groupBy?: string;
  onReorder?: (id: string, targetId: string) => void;
  timeSort?: 'estimated' | 'actual';
};
export function PlannerTimeList(
  props: ListProps & { scope: PlannerTimeTreeScope; complete: boolean },
) {
  const key = usePlannerKey(),
    query = usePlannerTimeTree(props.scope, props.complete);
  if (query.isError)
    return (
      <div className="planner-time-tree-error">
        <p role="alert">Time totals unavailable. {plannerError(query.error)}</p>
        <button type="button" onClick={() => void query.refetch()}>
          Retry time totals
        </button>
      </div>
    );
  if (!props.complete || query.isPending || !query.data)
    return (
      <>
        <p role="status" className="planner-muted">
          Loading complete task time…
        </p>
        <PlannerList {...props} />
      </>
    );
  return (
    <>
      {query.isFetching && (
        <p role="status" className="planner-muted">
          Refreshing task time…
        </p>
      )}
      <PlannerHierarchyList
        key={key.join(':') + JSON.stringify(props.scope)}
        {...props}
        nodes={query.data}
        renderChildren={(parent, render) => (
          <SubtaskBranch key={parent.id} parent={parent} render={render} nodes={query.data} />
        )}
      />
    </>
  );
}
export function PlannerTaskTimeRollup({ task }: { task: PlannerTask }) {
  const query = usePlannerTimeTree(
    { taskId: task.id, ...(task.archived ? { archived: 'true' } : {}) },
    true,
  );
  if (query.isError)
    return (
      <div className="planner-task-time-rollup">
        <p role="alert">Subtask totals unavailable. {plannerError(query.error)}</p>
        <button type="button" onClick={() => void query.refetch()}>
          Retry subtask totals
        </button>
      </div>
    );
  if (query.isPending || !query.data)
    return (
      <p role="status" className="planner-muted">
        Loading subtask totals…
      </p>
    );
  const rollup = plannerTimeRollups(query.data).values.get(task.id);
  if (!rollup || !rollup.childCount) return null;
  return (
    <p className="planner-task-time-rollup" aria-label="Time including subtasks">
      With {rollup.descendantCount} accessible{' '}
      {rollup.descendantCount === 1 ? 'subtask' : 'subtasks'}: Estimated{' '}
      {plannerTimeLabel(rollup.estimateMinutes)} · Actual {plannerTimeLabel(rollup.actualMinutes)}.
      <span> Time entries below belong to this task.</span>
    </p>
  );
}
function SubtaskBranch({
  parent,
  render,
  nodes,
}: {
  parent: PlannerTask;
  render: (tasks: PlannerTask[]) => ReactNode;
  nodes: PlannerTimeTreeNode[];
}) {
  const query = usePlannerTasks({ parentId: parent.id });
  useEffect(() => {
    if (query.hasNextPage && !query.isFetchingNextPage && !query.isError)
      void query.fetchNextPage();
  }, [query.hasNextPage, query.isFetchingNextPage, query.isError, query.fetchNextPage]);
  if (query.isError)
    return (
      <div className="planner-subtask-status">
        <p role="alert">Subtasks unavailable. {plannerError(query.error)}</p>
        <button type="button" onClick={() => void query.refetch()}>
          Retry subtasks
        </button>
      </div>
    );
  if (query.isPending || query.hasNextPage)
    return (
      <p role="status" className="planner-subtask-status">
        Loading all subtasks…
      </p>
    );
  const direct = new Set(nodes.filter((n) => n.parentId === parent.id).map((n) => n.id));
  const tasks =
    query.data?.pages.flatMap((page) => page.items).filter((task) => direct.has(task.id)) ?? [];
  // The qualified time tree controls visibility even if a child query has older cached records.
  if (tasks.length !== direct.size)
    return (
      <p role="status" className="planner-subtask-status">
        Subtask access or time changed. Refresh Planner.
      </p>
    );
  return <>{render(tasks)}</>;
}
export function PlannerHierarchyList(
  props: ListProps & {
    nodes: PlannerTimeTreeNode[];
    renderChildren: (parent: PlannerTask, render: (tasks: PlannerTask[]) => ReactNode) => ReactNode;
  },
) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [dragging, setDragging] = useState<string | null>(null);
  const tree = useMemo(() => plannerTimeRollups(props.nodes), [props.nodes]);
  const byId = useMemo(() => new Map(props.nodes.map((node) => [node.id, node])), [props.nodes]);
  const groupBy = props.groupBy ?? 'section';
  const groupKey = (task: PlannerTask) =>
    groupBy === 'status'
      ? task.status
      : groupBy === 'priority'
        ? task.priority
        : groupBy === 'assignee'
          ? (task.assigneeId ?? '')
          : groupBy === 'none'
            ? ''
            : props.personal
              ? (props.personal.placements.find((p) => p.taskId === task.id)?.sectionId ?? '')
              : (task.memberships.find((m) => m.projectId === props.project?.id)?.sectionId ?? '');
  const groups =
    groupBy === 'status'
      ? Object.entries(PLANNER_STATUS_LABELS).map(([id, name]) => ({ id, name }))
      : groupBy === 'priority'
        ? ['high', 'medium', 'low', 'none'].map((id) => ({
            id,
            name: id === 'none' ? 'No priority' : id,
          }))
        : groupBy === 'assignee'
          ? [
              ...props.people.map((p) => ({ id: p.id, name: p.name })),
              { id: '', name: 'Unassigned' },
            ]
          : groupBy === 'none'
            ? [{ id: '', name: 'Tasks' }]
            : props.personal
              ? [{ id: '', name: 'Recently assigned' }, ...props.personal.sections]
              : props.project
                ? [...props.project.sections, { id: '', name: 'Unsectioned' }]
                : [{ id: '', name: 'Tasks' }];
  const toggle = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  const renderRows = (input: PlannerTask[], depth: number): ReactNode => {
    const tasks = props.timeSort
      ? [...input].sort((a, b) => {
          const value = (task: PlannerTask) => {
            const rollup = tree.values.get(task.id);
            return props.timeSort === 'estimated'
              ? (rollup?.estimateMinutes ?? 0)
              : (rollup?.actualMinutes ?? 0);
          };
          return value(b) - value(a) || a.name.localeCompare(b.name);
        })
      : input;
    return tasks.map((task) => {
      const node = byId.get(task.id),
        rollup = tree.values.get(task.id);
      if (!node || !rollup) return null;
      const open = expanded.has(task.id),
        canReorder = depth === 0 && !!props.onReorder && ['editor', 'admin'].includes(task.access);
      const estimate = open ? node.estimateMinutes : rollup.estimateMinutes;
      const actual = open ? node.actualMinutes : rollup.actualMinutes;
      return (
        <Fragment key={task.id}>
          <div
            role="row"
            aria-level={depth + 1}
            aria-expanded={rollup.childCount > 0 ? open : undefined}
            className={`planner-list-row ${task.status === 'done' ? 'is-done' : ''}`}
            draggable={canReorder && !props.disabled}
            onDragStart={() => setDragging(task.id)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => {
              if (canReorder) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (canReorder && dragging && dragging !== task.id)
                props.onReorder?.(dragging, task.id);
              setDragging(null);
            }}
          >
            <span
              role="cell"
              className="planner-task-name"
              style={{ paddingLeft: Math.min(depth, 12) * 18 }}
            >
              {rollup.childCount > 0 ? (
                <button
                  type="button"
                  className="planner-expand-task"
                  aria-label={`${open ? 'Collapse' : 'Expand'} subtasks of ${task.name}`}
                  aria-expanded={open}
                  onClick={() => toggle(task.id)}
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : (
                <span className="planner-expand-spacer" />
              )}
              <TaskCheck {...props} task={task} />
              {canReorder && (
                <span className="planner-order-controls">
                  <button
                    aria-label={`Move ${task.name} up`}
                    disabled={props.disabled || tasks.indexOf(task) === 0}
                    onClick={() => props.onReorder?.(task.id, tasks[tasks.indexOf(task) - 1]!.id)}
                  >
                    ↑
                  </button>
                  <button
                    aria-label={`Move ${task.name} down`}
                    disabled={props.disabled || tasks.indexOf(task) === tasks.length - 1}
                    onClick={() => props.onReorder?.(tasks[tasks.indexOf(task) + 1]!.id, task.id)}
                  >
                    ↓
                  </button>
                </span>
              )}
              <button type="button" aria-label={task.name} onClick={() => props.onOpen(task.id)}>
                {task.subtype === 'milestone' && <Flag size={14} />} {task.name}
                {task.parentId && <small>Subtask</small>}
              </button>
              {props.personal && node.scoped && (
                <select
                  aria-label={`Personal section for ${task.name}`}
                  value={
                    props.personal.placements.find((p) => p.taskId === task.id)?.sectionId ?? ''
                  }
                  disabled={props.disabled}
                  onChange={(event) => props.personal!.onMove(task, event.target.value || null)}
                >
                  <option value="">Recently assigned</option>
                  {props.personal.sections.map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.name}
                    </option>
                  ))}
                </select>
              )}
            </span>
            <span role="cell">
              {props.people.find((p) => p.id === task.assigneeId)?.name ?? 'Unassigned'}
            </span>
            <span role="cell" className={plannerTaskOverdue(task) ? 'planner-overdue' : ''}>
              {plannerDueLabel(task)}
            </span>
            <span role="cell">
              <span className={`planner-tag planner-priority-${task.priority}`}>
                {task.priority === 'none' ? '—' : task.priority}
              </span>
            </span>
            <span role="cell">
              <span className={`planner-tag planner-status-${task.status}`}>
                {PLANNER_STATUS_LABELS[task.status]}
              </span>
            </span>
            <span
              role="cell"
              aria-label={`Estimated time for ${task.name}`}
              title={open ? 'This task’s own estimated time' : 'This task and accessible subtasks'}
            >
              {plannerTimeLabel(estimate)}
            </span>
            <span role="cell">
              <button
                type="button"
                className="planner-time-cell"
                aria-label={`Actual time for ${task.name}: ${plannerTimeLabel(actual)}`}
                title={
                  open
                    ? 'This task’s own actual time; open its history'
                    : 'This task and accessible subtasks; open its history'
                }
                onClick={() => props.onOpen(task.id)}
              >
                {plannerTimeLabel(actual)}
              </button>
            </span>
          </div>
          {open &&
            rollup.childCount > 0 &&
            props.renderChildren(task, (children) => renderRows(children, depth + 1))}
        </Fragment>
      );
    });
  };
  const total = plannerTimeTotal(
    props.nodes,
    props.tasks.map((task) => task.id),
  );
  return (
    <div className="planner-time-list">
      <p className="planner-muted">
        Time is shown as hours:minutes. Collapsed parents include accessible subtasks; expanded rows
        show their own time.
      </p>
      <div className="planner-list planner-hierarchy-list" role="treegrid" aria-label="Tasks">
        <div role="row" className="planner-list-head">
          {[
            'Task name',
            'Assignee',
            'Due date',
            'Priority',
            'Status',
            'Estimated time',
            'Actual time',
          ].map((name) => (
            <span role="columnheader" key={name}>
              {name}
            </span>
          ))}
        </div>
        {groups.map((group) => {
          const matches = props.tasks.filter(
              (task) => byId.get(task.id)?.scoped && groupKey(task) === group.id,
            ),
            ids = new Set(matches.map((task) => task.id));
          const roots = matches.filter((task) => {
            let parent = byId.get(task.id)?.parentId;
            while (parent) {
              if (ids.has(parent)) return false;
              parent = byId.get(parent)?.parentId;
            }
            return true;
          });
          const sum = plannerTimeTotal(
            props.nodes,
            matches.map((task) => task.id),
          );
          return (
            <section aria-label={group.name} key={group.id}>
              <h3>
                {group.name}
                <span>{roots.length}</span>
              </h3>
              {!!roots.length && (
                <p className="planner-section-time" aria-label={`Time totals for ${group.name}`}>
                  Estimated {plannerTimeLabel(sum.estimateMinutes)} · Actual{' '}
                  {plannerTimeLabel(sum.actualMinutes)}
                  <span>Includes accessible subtasks, counted once.</span>
                </p>
              )}
              {renderRows(roots, 0)}
              {!roots.length && <p className="planner-empty-row">No tasks in this section.</p>}
            </section>
          );
        })}
      </div>
      <p className="planner-section-time" aria-label="Total task time">
        Estimated {plannerTimeLabel(total.estimateMinutes)} · Actual{' '}
        {plannerTimeLabel(total.actualMinutes)} · {total.tasks} tasks and subtasks, counted once.
      </p>
    </div>
  );
}
