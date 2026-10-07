import { useState } from 'react';
import {
  PLANNER_DEFAULT_TIME_OPTIONS,
  plannerTimeDateBounds,
  plannerTimeToday,
} from '@capiro/strategy-verifier';
import type {
  PlannerProject,
  PlannerTask,
  PlannerTimeDetails,
  PlannerTimeEntry,
  PlannerTimeOptions,
} from '@capiro/strategy-verifier';
import { plannerError } from './planner-api.js';

export function PlannerTimeFields({
  value,
  onChange,
  projects,
  options = PLANNER_DEFAULT_TIME_OPTIONS,
  canManage = false,
}: {
  value: PlannerTimeDetails;
  onChange: (value: PlannerTimeDetails) => void;
  projects: PlannerProject[];
  options?: PlannerTimeOptions;
  canManage?: boolean;
}) {
  const bounds = plannerTimeDateBounds(options, canManage);
  return (
    <div className="planner-config-grid">
      <label className="planner-field">
        <span>Work date</span>
        <input
          aria-label="Work date"
          type="date"
          min={bounds.minOn ?? undefined}
          max={bounds.maxOn ?? undefined}
          value={value.workedOn}
          onInput={(e) => onChange({ ...value, workedOn: e.currentTarget.value })}
          onChange={(e) => onChange({ ...value, workedOn: e.currentTarget.value })}
        />
      </label>
      <label className="planner-field">
        <span>Time zone</span>
        <input
          aria-label="Time entry time zone"
          value={value.timeZone}
          maxLength={100}
          onChange={(e) => onChange({ ...value, timeZone: e.target.value })}
        />
      </label>
      <label className="planner-field">
        <span>Project for time</span>
        <select
          aria-label="Project for time"
          value={value.projectId ?? ''}
          onChange={(e) => onChange({ ...value, projectId: e.target.value || null })}
        >
          <option value="">{projects.length ? 'Choose a project' : 'Personal task'}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="planner-field">
        <span>Time category</span>
        {options.categories.length ? (
          <select
            aria-label="Time category"
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
            aria-label="Time category"
            maxLength={100}
            value={value.category}
            onChange={(e) => onChange({ ...value, category: e.target.value })}
          />
        )}
      </label>
      <label className="planner-check">
        <input
          type="checkbox"
          checked={value.billable}
          disabled={!options.billableEnabled && !value.billable}
          onChange={(e) => onChange({ ...value, billable: e.target.checked })}
        />
        Billable time
      </label>
    </div>
  );
}
export function PlannerTimeForm({
  projects,
  task,
  projectId,
  initial,
  workedOn,
  onSave,
  onCancel,
  options = PLANNER_DEFAULT_TIME_OPTIONS,
  canManage = false,
}: {
  projects: PlannerProject[];
  task?: PlannerTask;
  projectId?: string;
  initial?: PlannerTimeEntry;
  workedOn?: string;
  onSave: (input: { minutes: number; text: string; time: PlannerTimeDetails }) => Promise<unknown>;
  onCancel?: () => void;
  options?: PlannerTimeOptions;
  canManage?: boolean;
}) {
  const available = task
    ? projects.filter(
        (p) =>
          task.memberships.some((m) => m.projectId === p.id) || p.id === initial?.time.projectId,
      )
    : projectId
      ? projects.filter((p) => p.id === projectId)
      : projects;
  const [time, setTime] = useState<PlannerTimeDetails>(
    () =>
      initial?.time ?? {
        workedOn: workedOn ?? plannerTimeToday(options.timeZone),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        billable: options.billableEnabled && options.billableDefault,
        projectId: projectId ?? (available.length === 1 ? available[0]!.id : null),
        category: '',
      },
  );
  const [minutes, setMinutes] = useState(initial?.minutes ?? 30),
    [text, setText] = useState(initial?.text ?? ''),
    [error, setError] = useState<unknown>(),
    [pending, setPending] = useState(false);
  const bounds = plannerTimeDateBounds(options, canManage);
  const dateOutsideRules = !!(
    (bounds.minOn && time.workedOn < bounds.minOn) ||
    (bounds.maxOn && time.workedOn > bounds.maxOn)
  );
  const save = async () => {
    setError(null);
    setPending(true);
    try {
      await onSave({ minutes, text: text.trim() || 'Logged time', time });
      if (!initial) setText('');
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="planner-time-form">
      <PlannerTimeFields
        value={time}
        onChange={setTime}
        projects={available}
        options={options}
        canManage={canManage}
      />
      <label className="planner-field">
        <span>Minutes</span>
        <input
          aria-label={initial ? 'Edit logged minutes' : 'Log minutes'}
          type="number"
          min={1}
          max={1440}
          value={minutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
        />
      </label>
      <label className="planner-field">
        <span>Time note</span>
        <textarea
          aria-label="Time note"
          maxLength={20000}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {error != null && (
        <p role="alert" className="planner-error">
          {plannerError(error)}
        </p>
      )}
      <div className="planner-actions">
        <button
          type="button"
          className="planner-primary"
          disabled={
            pending ||
            !options.timeTrackingEnabled ||
            dateOutsideRules ||
            !time.workedOn ||
            !Number.isInteger(minutes) ||
            minutes < 1 ||
            minutes > 1440 ||
            (available.length > 0 && !time.projectId)
          }
          onClick={() => void save()}
        >
          {pending ? 'Saving…' : initial ? 'Save time entry' : 'Log time'}
        </button>
        {onCancel && (
          <button type="button" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
