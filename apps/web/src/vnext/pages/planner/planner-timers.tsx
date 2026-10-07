import { useEffect, useMemo, useState } from 'react';
import { Clock3 } from 'lucide-react';
import {
  PLANNER_DEFAULT_TIME_OPTIONS,
  type PlannerBootstrap,
  type PlannerTask,
  type PlannerTimer,
  type PlannerTimerDetails,
  type PlannerTimerStart,
  type PlannerTimerStop,
} from '@capiro/strategy-verifier';
import { plannerError, usePlannerKey, usePlannerTask } from './planner-api.js';
import { usePlannerTimer, usePlannerTimerActions } from './planner-timers-api.js';

function TimerClock({ timer }: { timer: PlannerTimer }) {
  const anchor = useMemo(
    () => ({ elapsed: timer.elapsedMilliseconds, received: performance.now() }),
    [timer.serverNow, timer.id],
  );
  const [, tick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);
  const seconds = Math.floor(
    Math.max(0, anchor.elapsed + performance.now() - anchor.received) / 1000,
  );
  return (
    <span role="timer" aria-label="Elapsed timer" className="planner-timer-clock">
      {String(Math.floor(seconds / 3600)).padStart(2, '0')}:
      {String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:
      {String(seconds % 60).padStart(2, '0')}
    </span>
  );
}
function TimerFields({
  bootstrap,
  task,
  value,
  onChange,
  disabled,
}: {
  bootstrap: PlannerBootstrap;
  task?: PlannerTask;
  value: PlannerTimerDetails;
  onChange: (value: PlannerTimerDetails) => void;
  disabled: boolean;
}) {
  const options = bootstrap.timeOptions ?? PLANNER_DEFAULT_TIME_OPTIONS;
  const projects = bootstrap.projects.filter(
    (p) =>
      task?.memberships.some((m) => m.projectId === p.id) && ['editor', 'admin'].includes(p.access),
  );
  return (
    <fieldset disabled={disabled} className="planner-timer-fields">
      <legend>Timer details</legend>
      <p className="planner-muted">
        Work dates follow {value.timeZone}. Nonzero elapsed time rounds up to a whole minute.
      </p>
      <label className="planner-field">
        <span>Timer project</span>
        <select
          aria-label="Timer project"
          value={value.projectId ?? ''}
          onChange={(e) => onChange({ ...value, projectId: e.target.value || null })}
        >
          <option value="">
            {task?.memberships.length ? 'Choose a project' : 'Personal task'}
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="planner-field">
        <span>Timer category</span>
        {options.categories.length ? (
          <select
            aria-label="Timer category"
            value={value.category}
            onChange={(e) => onChange({ ...value, category: e.target.value })}
          >
            <option value="">Uncategorized</option>
            {value.category && !options.categories.includes(value.category) && (
              <option value={value.category}>{value.category} (no longer configured)</option>
            )}
            {options.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label="Timer category"
            maxLength={100}
            value={value.category}
            onChange={(e) => onChange({ ...value, category: e.target.value })}
          />
        )}
      </label>
      <label className="planner-check">
        <input
          type="checkbox"
          aria-label="Billable timer"
          checked={value.billable}
          disabled={!options.billableEnabled && !value.billable}
          onChange={(e) => onChange({ ...value, billable: e.target.checked })}
        />
        Billable timer
      </label>
    </fieldset>
  );
}
function TimerControls({
  timer,
  bootstrap,
  task,
  refresh,
}: {
  timer: PlannerTimer;
  bootstrap: PlannerBootstrap;
  task?: PlannerTask;
  refresh: () => Promise<{ data?: PlannerTimer | null }>;
}) {
  const actions = usePlannerTimerActions();
  const [editing, setEditing] = useState(false);
  const [details, setDetails] = useState<PlannerTimerDetails>(
    () =>
      timer.time ?? {
        timeZone: bootstrap.timeOptions?.timeZone ?? 'UTC',
        projectId: null,
        billable: false,
        category: '',
      },
  );
  const [attempt, setAttempt] = useState<(PlannerTimerStop & { id: string }) | null>(null);
  const pending = actions.stop.isPending || actions.discard.isPending;
  const stop = async () => {
    const request = attempt ?? {
      id: timer.id,
      version: timer.version,
      ...(editing
        ? {
            time: {
              projectId: details.projectId,
              billable: details.billable,
              category: details.category,
            },
          }
        : {}),
    };
    setAttempt(request);
    try {
      await actions.stop.mutateAsync(request);
    } catch {
      /* Keep the exact request for a lost-response retry. */
    }
  };
  return (
    <div className="planner-timer-controls">
      <TimerClock timer={timer} />
      {timer.notice && <p>{timer.notice}</p>}
      {timer.canStop && !attempt && (
        <button type="button" disabled={pending} onClick={() => setEditing(!editing)}>
          {editing ? 'Keep captured timer details' : 'Adjust timer details'}
        </button>
      )}
      {editing && timer.time && (
        <TimerFields
          bootstrap={bootstrap}
          task={task}
          value={details}
          onChange={setDetails}
          disabled={pending || !!attempt}
        />
      )}
      <div className="planner-activity-actions">
        <button
          type="button"
          className="planner-primary"
          disabled={pending || !timer.canStop}
          onClick={() => void stop()}
        >
          {actions.stop.isPending
            ? 'Logging timer…'
            : attempt
              ? 'Retry stopping timer'
              : 'Stop and log time'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            void actions.discard
              .mutateAsync({ id: timer.id, version: timer.version })
              .catch(() => {})
          }
        >
          Discard timer
        </button>
      </div>
      {(actions.stop.error || actions.discard.error) && (
        <p role="alert" className="planner-error">
          {plannerError(actions.stop.error ?? actions.discard.error)}
        </p>
      )}
      {actions.stop.error && (
        <button
          type="button"
          disabled={pending}
          onClick={async () => {
            const current = await refresh();
            if (current.data?.id === timer.id && current.data.version === timer.version) {
              actions.stop.reset();
              setAttempt(null);
              setEditing(true);
            }
          }}
        >
          Revise timer details
        </button>
      )}
      <p className="planner-muted">
        Time is logged in whole minutes, rounded up once. Discard stops this session without logging
        time.
      </p>
    </div>
  );
}
export function PlannerTimerWidget({
  bootstrap,
  onOpen,
}: {
  bootstrap: PlannerBootstrap;
  onOpen: (id: string) => void;
}) {
  const query = usePlannerTimer();
  const task = usePlannerTask(query.data?.taskId ?? '');
  if (query.isError)
    return (
      <aside className="planner-timer-widget" aria-label="Running timer">
        <p role="alert">Timer unavailable. {plannerError(query.error)}</p>
        <button type="button" onClick={() => void query.refetch()}>
          Retry timer
        </button>
      </aside>
    );
  if (!query.data) return null;
  return (
    <aside className="planner-timer-widget" aria-label="Running timer">
      <div className="planner-timer-heading">
        <Clock3 size={18} />
        <strong>Running timer</strong>
      </div>
      {query.data.taskId ? (
        <button
          type="button"
          className="planner-timer-task"
          onClick={() => onOpen(query.data!.taskId!)}
        >
          {query.data.taskName}
        </button>
      ) : (
        <p>Unavailable task</p>
      )}
      <TimerControls
        key={`${query.data.id}:${query.data.version}`}
        timer={query.data}
        bootstrap={bootstrap}
        task={task.isError ? undefined : task.data}
        refresh={query.refetch}
      />
    </aside>
  );
}
export function PlannerTaskTimer(props: {
  task: PlannerTask;
  bootstrap: PlannerBootstrap;
  onOpen: (id: string) => void;
}) {
  const key = usePlannerKey();
  return <TaskTimerState key={`${key.join(':')}:${props.task.id}`} {...props} />;
}
function TaskTimerState({
  task,
  bootstrap,
  onOpen,
}: {
  task: PlannerTask;
  bootstrap: PlannerBootstrap;
  onOpen: (id: string) => void;
}) {
  const query = usePlannerTimer(),
    actions = usePlannerTimerActions();
  const options = bootstrap.timeOptions ?? PLANNER_DEFAULT_TIME_OPTIONS;
  const available = bootstrap.projects.filter(
    (p) =>
      task.memberships.some((m) => m.projectId === p.id) && ['editor', 'admin'].includes(p.access),
  );
  const [details, setDetails] = useState<PlannerTimerDetails>(() => ({
    timeZone: options.timeZone,
    projectId: task.memberships.length === 1 ? (available[0]?.id ?? null) : null,
    billable: options.billableEnabled && options.billableDefault,
    category: '',
  }));
  const [attempt, setAttempt] = useState<PlannerTimerStart | null>(null);
  useEffect(() => {
    if (attempt && query.data?.taskId === task.id) {
      setAttempt(null);
      actions.start.reset();
    }
  }, [attempt, query.data?.taskId, task.id, actions.start.reset]);
  const canStart =
    !task.archived && ['editor', 'admin'].includes(task.access) && options.timeTrackingEnabled;
  if (query.isError)
    return (
      <div className="planner-task-timer">
        <p role="alert">Timer unavailable. {plannerError(query.error)}</p>
        <button type="button" onClick={() => void query.refetch()}>
          Retry timer
        </button>
      </div>
    );
  if (query.data)
    return (
      <div className="planner-task-timer">
        <h4>
          {query.data.taskId === task.id
            ? 'Timer running for this task'
            : 'Another timer is running'}
        </h4>
        {query.data.taskId === task.id ? (
          <TimerControls
            key={`${query.data.id}:${query.data.version}`}
            timer={query.data}
            bootstrap={bootstrap}
            task={task}
            refresh={query.refetch}
          />
        ) : query.data.taskId ? (
          <button type="button" onClick={() => onOpen(query.data!.taskId!)}>
            Open running timer’s task
          </button>
        ) : (
          <TimerControls
            key={`${query.data.id}:${query.data.version}`}
            timer={query.data}
            bootstrap={bootstrap}
            refresh={query.refetch}
          />
        )}
      </div>
    );
  if (!canStart) return null;
  return (
    <div className="planner-task-timer">
      <details>
        <summary>Timer details</summary>
        <TimerFields
          bootstrap={bootstrap}
          task={task}
          value={details}
          onChange={setDetails}
          disabled={!!attempt || actions.start.isPending}
        />
      </details>
      <button
        type="button"
        disabled={
          query.isPending ||
          actions.start.isPending ||
          (!!task.memberships.length && !details.projectId)
        }
        onClick={async () => {
          const request = attempt ?? {
            startKey: crypto.randomUUID(),
            taskId: task.id,
            time: { ...details },
          };
          setAttempt(request);
          try {
            await actions.start.mutateAsync(request);
            setAttempt(null);
          } catch {
            /* The same start key survives a retry. */
          }
        }}
      >
        {actions.start.isPending
          ? 'Starting timer…'
          : attempt
            ? 'Retry timer start'
            : 'Start timer'}
      </button>
      {actions.start.error && (
        <>
          <p role="alert" className="planner-error">
            {plannerError(actions.start.error)}
          </p>
          <button
            type="button"
            disabled={actions.start.isPending}
            onClick={() => {
              setAttempt(null);
              actions.start.reset();
            }}
          >
            Cancel start attempt
          </button>
        </>
      )}
    </div>
  );
}
