import { useState } from 'react';
import type {
  PlannerProject,
  PlannerTask,
  PlannerPerson,
  PlannerStatus,
  PlannerMyTasksData,
} from '@capiro/strategy-verifier';
import { PLANNER_STATUS_LABELS } from '@capiro/strategy-verifier';
import { Check, Circle, Flag, MessageSquare } from 'lucide-react';

export function plannerToday(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function plannerDate(date: string | null) {
  return date
    ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
        new Date(`${date}T12:00:00`),
      )
    : '—';
}
export function shiftPlannerDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export type TaskViewProps = {
  tasks: PlannerTask[];
  people: PlannerPerson[];
  project?: PlannerProject;
  onOpen: (id: string) => void;
  onPatch: (task: PlannerTask, data: Partial<PlannerTask>) => void;
  disabled: boolean;
  personal?: PlannerMyTasksData & { onMove: (task: PlannerTask, sectionId: string | null) => void };
};
export function TaskCheck({
  task,
  onPatch,
  disabled,
}: Pick<TaskViewProps, 'onPatch' | 'disabled'> & { task: PlannerTask }) {
  return (
    <button
      type="button"
      className={`planner-check ${task.status === 'done' ? 'is-done' : ''}`}
      aria-label={`${task.status === 'done' ? 'Reopen' : 'Complete'} ${task.name}`}
      disabled={disabled || ['viewer', 'commenter'].includes(task.access)}
      onClick={() => onPatch(task, { status: task.status === 'done' ? 'todo' : 'done' })}
    >
      {task.status === 'done' ? <Check size={15} /> : <Circle size={17} />}
    </button>
  );
}
export function PlannerList(
  props: TaskViewProps & { groupBy?: string; onReorder?: (id: string, targetId: string) => void },
) {
  const groupBy = props.groupBy ?? 'section';
  const reorder = props.onReorder;
  const [dragging, setDragging] = useState<string | null>(null);
  const key = (task: PlannerTask) =>
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
  return (
    <div className="planner-list" role="table" aria-label="Tasks">
      <div className="planner-list-head" role="row">
        <span>Task name</span>
        <span>Assignee</span>
        <span>Due date</span>
        <span>Priority</span>
        <span>Status</span>
      </div>
      {groups.map((section) => {
        const rows = props.tasks.filter((t) => key(t) === section.id);
        return (
          <section key={section.id} aria-label={section.name}>
            <h3>
              {section.name}
              <span>{rows.length}</span>
            </h3>
            {rows.map((task) => (
              <div
                className={`planner-list-row ${task.status === 'done' ? 'is-done' : ''}`}
                role="row"
                key={task.id}
                draggable={Boolean(reorder) && !props.disabled}
                onDragStart={() => setDragging(task.id)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => {
                  if (reorder) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragging && dragging !== task.id) reorder?.(dragging, task.id);
                  setDragging(null);
                }}
              >
                <span role="cell" className="planner-task-name">
                  <TaskCheck {...props} task={task} />
                  {reorder && (
                    <span className="planner-order-controls">
                      <button
                        aria-label={`Move ${task.name} up`}
                        disabled={props.disabled || rows.indexOf(task) === 0}
                        onClick={() => reorder(task.id, rows[rows.indexOf(task) - 1]!.id)}
                      >
                        ↑
                      </button>
                      <button
                        aria-label={`Move ${task.name} down`}
                        disabled={props.disabled || rows.indexOf(task) === rows.length - 1}
                        onClick={() => reorder(rows[rows.indexOf(task) + 1]!.id, task.id)}
                      >
                        ↓
                      </button>
                    </span>
                  )}
                  <button type="button" onClick={() => props.onOpen(task.id)}>
                    {task.subtype === 'milestone' && <Flag size={14} />} {task.name}
                    {task.parentId && <small>Subtask</small>}
                  </button>
                  {props.personal && (
                    <select
                      aria-label={`Personal section for ${task.name}`}
                      value={
                        props.personal.placements.find((p) => p.taskId === task.id)?.sectionId ?? ''
                      }
                      disabled={props.disabled}
                      onChange={(e) => props.personal!.onMove(task, e.target.value || null)}
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
                <span
                  role="cell"
                  className={
                    task.dueOn && task.dueOn < plannerToday() && task.status !== 'done'
                      ? 'planner-overdue'
                      : ''
                  }
                >
                  {plannerDate(task.dueOn)}
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
              </div>
            ))}
            {rows.length === 0 && <p className="planner-empty-row">No tasks in this section.</p>}
          </section>
        );
      })}
    </div>
  );
}
export function PlannerBoard(props: TaskViewProps) {
  const columns = props.personal
    ? [{ id: '', name: 'Recently assigned' }, ...props.personal.sections]
    : props.project?.sections.length
      ? props.project.sections.map((s) => ({ id: s.id, name: s.name }))
      : Object.entries(PLANNER_STATUS_LABELS).map(([id, name]) => ({ id, name }));
  if (!props.personal && props.project?.sections.length)
    columns.push({ id: '', name: 'Unsectioned' });
  const [dragging, setDragging] = useState<string | null>(null);
  return (
    <div className="planner-board">
      {columns.map((column) => {
        const tasks = props.tasks.filter((t) =>
          props.personal
            ? (props.personal.placements.find((p) => p.taskId === t.id)?.sectionId ?? '') ===
              column.id
            : props.project?.sections.length
              ? (t.memberships.find((m) => m.projectId === props.project!.id)?.sectionId ?? '') ===
                column.id
              : t.status === column.id,
        );
        return (
          <section
            key={column.id}
            className="planner-column"
            aria-label={column.name}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const task = props.tasks.find((t) => t.id === dragging);
              if (!task || props.disabled) return;
              if (props.personal) {
                props.personal.onMove(task, column.id || null);
                setDragging(null);
                return;
              }
              props.onPatch(
                task,
                props.project?.sections.length
                  ? {
                      memberships: task.memberships.map((m) =>
                        m.projectId === props.project!.id
                          ? { ...m, sectionId: column.id || null, position: tasks.length }
                          : m,
                      ),
                    }
                  : { status: column.id as PlannerStatus },
              );
              setDragging(null);
            }}
          >
            <h3>
              {column.name}
              <span>{tasks.length}</span>
            </h3>
            {tasks.map((task) => (
              <article
                key={task.id}
                className="planner-board-card"
                draggable={
                  !props.disabled &&
                  (Boolean(props.personal) || !['viewer', 'commenter'].includes(task.access))
                }
                onDragStart={() => setDragging(task.id)}
                onDragEnd={() => setDragging(null)}
              >
                <div className="planner-task-name">
                  <TaskCheck {...props} task={task} />
                  <button type="button" onClick={() => props.onOpen(task.id)}>
                    {task.name}
                  </button>
                </div>
                <div className="planner-card-meta">
                  <span className={`planner-tag planner-priority-${task.priority}`}>
                    {task.priority === 'none' ? 'No priority' : task.priority}
                  </span>
                  <span>{plannerDate(task.dueOn)}</span>
                </div>
                <div className="planner-card-meta">
                  <span>
                    {props.people.find((p) => p.id === task.assigneeId)?.name ?? 'Unassigned'}
                  </span>
                  <MessageSquare size={14} />
                </div>
              </article>
            ))}
          </section>
        );
      })}
    </div>
  );
}
export function PlannerCalendar(props: TaskViewProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [month, setMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  start.setDate(1 - start.getDay());
  const days = Array.from({ length: 42 }, (_, i) => {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    return day;
  });
  const dateKey = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return (
    <div className="planner-calendar">
      <div className="planner-calendar-title">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
        >
          ←
        </button>
        <h3>{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
        >
          →
        </button>
        <button
          type="button"
          onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
        >
          Today
        </button>
      </div>
      <div className="planner-calendar-grid">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
          <strong key={day}>{day}</strong>
        ))}
        {days.map((day) => (
          <section
            key={dateKey(day)}
            className={day.getMonth() !== month.getMonth() ? 'is-other-month' : ''}
            aria-label={day.toDateString()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const task = props.tasks.find((t) => t.id === dragging);
              if (!task || props.disabled) return;
              const dueOn = dateKey(day);
              const delta = task.dueOn
                ? Math.round(
                    (new Date(`${dueOn}T12:00:00Z`).getTime() -
                      new Date(`${task.dueOn}T12:00:00Z`).getTime()) /
                      86400000,
                  )
                : 0;
              props.onPatch(task, {
                dueOn,
                ...(task.startOn ? { startOn: shiftPlannerDate(task.startOn, delta) } : {}),
              });
              setDragging(null);
            }}
          >
            <span className={dateKey(day) === plannerToday() ? 'is-today' : ''}>
              {day.getDate()}
            </span>
            {props.tasks
              .filter((t) => t.dueOn === dateKey(day))
              .map((task) => (
                <button
                  type="button"
                  className={`planner-calendar-task planner-status-${task.status}`}
                  key={task.id}
                  draggable={!props.disabled && !['viewer', 'commenter'].includes(task.access)}
                  onDragStart={() => setDragging(task.id)}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => props.onOpen(task.id)}
                >
                  {task.name}
                </button>
              ))}
          </section>
        ))}
      </div>
      {props.tasks.some((t) => !t.dueOn) && (
        <p className="planner-muted">
          {props.tasks.filter((t) => !t.dueOn).length} tasks have no due date. Set a due date to
          show them here.
        </p>
      )}
    </div>
  );
}
export function PlannerTimeline(props: TaskViewProps & { gantt: boolean }) {
  const [drag, setDrag] = useState<{
    id: string;
    x: number;
    edge: 'move' | 'start' | 'due';
  } | null>(null);
  const dated = props.tasks
    .filter((t) => t.dueOn)
    .sort((a, b) => (a.startOn ?? a.dueOn!).localeCompare(b.startOn ?? b.dueOn!));
  if (!dated.length)
    return (
      <p className="planner-empty">Give your tasks start and due dates to plan this timeline.</p>
    );
  const day = 86_400_000;
  const timestamp = (date: string) => new Date(`${date}T12:00:00Z`).getTime();
  const start = Math.min(...dated.map((t) => timestamp(t.startOn ?? t.dueOn!)));
  const end = Math.max(...dated.map((t) => timestamp(t.dueOn!)));
  const length = Math.max(14, Math.round((end - start) / day) + 1);
  const scale = Math.max(2, Math.min(70, 1200 / length));
  const width = length * scale;
  const tickStep = Math.max(1, Math.ceil(length / 120));
  const schedule = (task: PlannerTask, delta: number, edge: 'move' | 'start' | 'due') => {
    if (!delta || props.disabled || ['viewer', 'commenter'].includes(task.access)) return;
    const dueOn = edge === 'start' ? task.dueOn! : shiftPlannerDate(task.dueOn!, delta);
    const startOn =
      edge === 'due' ? task.startOn : shiftPlannerDate(task.startOn ?? task.dueOn!, delta);
    if (startOn && startOn > dueOn) return;
    props.onPatch(task, { startOn, dueOn });
  };
  return (
    <div className="planner-timeline-scroll">
      <div className="planner-timeline" style={{ width: width + 260, position: 'relative' }}>
        <div className="planner-timeline-head">
          <span>Task</span>
          <div style={{ width }}>
            {Array.from({ length: Math.ceil(length / tickStep) }, (_, i) => (
              <span key={i} style={{ width: scale * tickStep }}>
                {new Date(start + i * tickStep * day).toLocaleDateString(undefined, {
                  day: 'numeric',
                  month: i % 7 === 0 ? 'short' : undefined,
                })}
              </span>
            ))}
          </div>
        </div>
        {dated.map((task) => {
          const left = Math.round((timestamp(task.startOn ?? task.dueOn!) - start) / day) * scale;
          const span = Math.max(
            1,
            Math.round((timestamp(task.dueOn!) - timestamp(task.startOn ?? task.dueOn!)) / day) + 1,
          );
          return (
            <div className="planner-timeline-row" key={task.id}>
              <button type="button" onClick={() => props.onOpen(task.id)}>
                {task.name}
              </button>
              <div
                style={{ width }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (drag) {
                    const moved = dated.find((t) => t.id === drag.id);
                    if (moved) schedule(moved, Math.round((e.clientX - drag.x) / scale), drag.edge);
                    setDrag(null);
                  }
                }}
              >
                <button
                  type="button"
                  className={`planner-timeline-bar planner-status-${task.status}`}
                  style={{ left, width: Math.max(12, span * scale - 4) }}
                  onClick={() => props.onOpen(task.id)}
                  draggable={!props.disabled && !['viewer', 'commenter'].includes(task.access)}
                  onDragStart={(e) => setDrag({ id: task.id, x: e.clientX, edge: 'move' })}
                  onDragEnd={() => setDrag(null)}
                  onKeyDown={(e) => {
                    if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                      e.preventDefault();
                      schedule(task, e.key === 'ArrowLeft' ? -1 : 1, e.shiftKey ? 'due' : 'move');
                    }
                  }}
                  title="Drag to move. Arrow keys move one day; Shift + arrow keys adjust the due date."
                >
                  {task.name}
                </button>
                {!props.disabled && editableTask(task) && (
                  <>
                    <button
                      type="button"
                      className="planner-timeline-handle"
                      aria-label={`Resize start of ${task.name}`}
                      style={{ left }}
                      draggable
                      onDragStart={(e) => setDrag({ id: task.id, x: e.clientX, edge: 'start' })}
                      onDragEnd={() => setDrag(null)}
                      onKeyDown={(e) => {
                        if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                          e.preventDefault();
                          schedule(task, e.key === 'ArrowLeft' ? -1 : 1, 'start');
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="planner-timeline-handle"
                      aria-label={`Resize due date of ${task.name}`}
                      style={{ left: left + span * scale - 12 }}
                      draggable
                      onDragStart={(e) => setDrag({ id: task.id, x: e.clientX, edge: 'due' })}
                      onDragEnd={() => setDrag(null)}
                      onKeyDown={(e) => {
                        if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                          e.preventDefault();
                          schedule(task, e.key === 'ArrowLeft' ? -1 : 1, 'due');
                        }
                      }}
                    />
                  </>
                )}
                {props.gantt && task.dependencies.length > 0 && (
                  <span
                    className="planner-timeline-deps"
                    style={{ left }}
                    title={task.dependencies
                      .map((id) => props.tasks.find((t) => t.id === id)?.name ?? 'Dependency')
                      .join(', ')}
                  >
                    ↳ {task.dependencies.length} dependencies
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {props.gantt && (
          <svg
            className="planner-gantt-connectors"
            width={width}
            height={dated.length * 56}
            style={{ position: 'absolute', left: 260, top: 42, pointerEvents: 'none' }}
            aria-label="Task dependency connections"
          >
            <defs>
              <marker
                id="planner-arrow"
                markerWidth="6"
                markerHeight="6"
                refX="5"
                refY="3"
                orient="auto"
              >
                <path d="M0,0 L6,3 L0,6" fill="#857aa8" />
              </marker>
            </defs>
            {dated.flatMap((task, i) =>
              task.dependencies.map((id) => {
                const j = dated.findIndex((t) => t.id === id);
                if (j < 0) return null;
                const predecessor = dated[j]!;
                const x1 = (Math.round((timestamp(predecessor.dueOn!) - start) / day) + 1) * scale;
                const x2 =
                  Math.round((timestamp(task.startOn ?? task.dueOn!) - start) / day) * scale;
                const y1 = j * 56 + 22,
                  y2 = i * 56 + 22;
                const bend = Math.max(x1 + 12, x2 - 12);
                return (
                  <path
                    key={`${task.id}:${id}`}
                    d={`M${x1},${y1} H${bend} V${y2} H${x2}`}
                    stroke="#857aa8"
                    strokeWidth="1.5"
                    fill="none"
                    markerEnd="url(#planner-arrow)"
                  >
                    <title>
                      {predecessor.name} → {task.name}
                    </title>
                  </path>
                );
              }),
            )}
          </svg>
        )}
      </div>
    </div>
  );
}
function editableTask(task: PlannerTask) {
  return ['admin', 'editor'].includes(task.access);
}
