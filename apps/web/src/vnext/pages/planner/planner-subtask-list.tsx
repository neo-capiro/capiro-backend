import { useMemo, useState } from 'react';
import type { PlannerPerson, PlannerTask } from '@capiro/strategy-verifier';
import { PLANNER_STATUS_LABELS } from '@capiro/strategy-verifier';
import { plannerDueLabel, TaskCheck } from './planner-views.js';

export function PlannerSubtaskList({
  tasks,
  people,
  loading,
  failed,
  disabled,
  onOpen,
  onPatch,
}: {
  tasks: PlannerTask[];
  people: PlannerPerson[];
  loading: boolean;
  failed: boolean;
  disabled: boolean;
  onOpen: (id: string) => void;
  onPatch: (task: PlannerTask, data: Partial<PlannerTask>) => void;
}) {
  const [hideCompleted, setHideCompleted] = useState(false);
  const [assignee, setAssignee] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState('position');
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const invalidDates = Boolean(from && to && from > to);
  const visible = useMemo(() => {
    if (loading || failed || invalidDates) return [];
    const rows = tasks.filter(
      (task) =>
        (!hideCompleted || task.status !== 'done') &&
        (!assignee ||
          (assignee === 'unassigned' ? !task.assigneeId : task.assigneeId === assignee)) &&
        (!from || Boolean(task.dueOn && task.dueOn >= from)) &&
        (!to || Boolean(task.dueOn && task.dueOn <= to)),
    );
    if (sort !== 'position')
      rows.sort((a, b) => {
        const value = (t: PlannerTask) =>
          sort === 'due'
            ? (t.dueOn ?? '9999-99-99')
            : sort === 'assignee'
              ? (names.get(t.assigneeId ?? '') ?? '\uffff')
              : t.name;
        return value(a).localeCompare(value(b)) || a.id.localeCompare(b.id);
      });
    return rows;
  }, [tasks, loading, failed, invalidDates, hideCompleted, assignee, from, to, sort, names]);
  return (
    <section aria-label="Subtask list">
      <div className="planner-subtask-controls">
        <label>
          <input
            type="checkbox"
            checked={hideCompleted}
            onChange={(e) => setHideCompleted(e.target.checked)}
          />{' '}
          Hide completed subtasks
        </label>
        <label className="planner-field">
          <span>Subtask assignee</span>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">All assignees</option>
            <option value="unassigned">Unassigned</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="planner-field">
          <span>Subtasks due from</span>
          <input type="date" value={from} onInput={(e) => setFrom(e.currentTarget.value)} />
        </label>
        <label className="planner-field">
          <span>Subtasks due through</span>
          <input type="date" value={to} onInput={(e) => setTo(e.currentTarget.value)} />
        </label>
        <label className="planner-field">
          <span>Sort subtasks</span>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="position">Subtask order</option>
            <option value="name">Name</option>
            <option value="due">Due date</option>
            <option value="assignee">Assignee</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            setHideCompleted(false);
            setAssignee('');
            setFrom('');
            setTo('');
            setSort('position');
          }}
        >
          Reset subtask controls
        </button>
      </div>
      {invalidDates && (
        <p role="alert" className="planner-error">
          The first due date must be on or before the last due date.
        </p>
      )}
      {loading ? (
        <p role="status">Loading all subtasks…</p>
      ) : failed ? null : (
        !invalidDates && (
          <>
            <p className="planner-muted">
              {visible.length} of {tasks.length} subtasks
            </p>
            {visible.map((task) => (
              <div key={task.id} className="planner-subtask">
                <TaskCheck task={task} onPatch={onPatch} disabled={disabled} />
                <button type="button" onClick={() => onOpen(task.id)}>
                  {task.name}
                </button>
                <span>{names.get(task.assigneeId ?? '') ?? 'Unassigned'}</span>
                <span>{plannerDueLabel(task)}</span>
                <span>{PLANNER_STATUS_LABELS[task.status]}</span>
              </div>
            ))}
            {!visible.length && (
              <p className="planner-muted">
                {tasks.length ? 'No subtasks match these controls.' : 'No subtasks yet.'}
              </p>
            )}
          </>
        )
      )}
    </section>
  );
}
