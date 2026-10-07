import {
  nextPlannerSchedule,
  plannerTimeZone,
  type PlannerTaskData,
  type PlannerRecurrence,
} from '@capiro/strategy-verifier';

export function PlannerTaskSchedule({
  data,
  disabled,
  onChange,
}: {
  data: PlannerTaskData;
  disabled: boolean;
  onChange: (patch: Partial<PlannerTaskData>) => void;
}) {
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zone = data.timeZone ?? browserZone;
  const zones = [
    ...new Set([
      zone,
      browserZone,
      'UTC',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'Europe/London',
      'Europe/Paris',
      'Asia/Tokyo',
      'Asia/Kolkata',
      'Australia/Sydney',
    ]),
  ];
  const repeat = (patch: Partial<PlannerRecurrence>) =>
    onChange({ recurrence: { ...data.recurrence!, ...patch } });
  const next =
    data.recurrence &&
    data.dueOn &&
    Number.isInteger(data.recurrence.interval) &&
    data.recurrence.interval >= 1 &&
    data.recurrence.interval <= 365 &&
    plannerTimeZone(zone)
      ? nextPlannerSchedule(data, new Date())
      : null;
  return (
    <fieldset className="planner-schedule" disabled={disabled}>
      <legend>Schedule</legend>
      <div className="planner-form-grid">
        <label className="planner-field">
          <span>Start date</span>
          <input
            type="date"
            value={data.startOn ?? ''}
            onInput={(e) => {
              const startOn = e.currentTarget.value || null;
              onChange({ startOn, ...(!startOn ? { startTime: null } : {}) });
            }}
          />
        </label>
        <label className="planner-field">
          <span>Due date</span>
          <input
            type="date"
            min={data.startOn ?? undefined}
            required={Boolean(data.recurrence)}
            value={data.dueOn ?? ''}
            onInput={(e) => {
              const dueOn = e.currentTarget.value || null;
              onChange({
                dueOn,
                ...(!dueOn ? { dueTime: null } : {}),
                ...(dueOn && data.recurrence
                  ? { recurrence: { ...data.recurrence, anchorOn: dueOn } }
                  : {}),
              });
            }}
          />
        </label>
        <label className="planner-field">
          <span>Start time</span>
          <input
            type="time"
            disabled={disabled || !data.startOn}
            value={data.startTime ?? ''}
            onInput={(e) => onChange({ startTime: e.currentTarget.value || null, timeZone: zone })}
          />
        </label>
        <label className="planner-field">
          <span>Due time</span>
          <input
            type="time"
            disabled={disabled || !data.dueOn}
            value={data.dueTime ?? ''}
            onInput={(e) => onChange({ dueTime: e.currentTarget.value || null, timeZone: zone })}
          />
        </label>
        <label className="planner-field">
          <span>Time zone</span>
          <input
            list="planner-time-zones"
            value={zone}
            onChange={(e) => onChange({ timeZone: e.target.value })}
          />
          <datalist id="planner-time-zones">
            {zones.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
        <label className="planner-field">
          <span>Repeat</span>
          <select
            value={data.recurrence?.frequency ?? ''}
            onChange={(e) => {
              const frequency = e.target.value as PlannerRecurrence['frequency'];
              onChange({
                recurrence: frequency
                  ? {
                      frequency,
                      interval: data.recurrence?.interval ?? 1,
                      basedOn:
                        frequency === 'periodically'
                          ? 'completion_date'
                          : (data.recurrence?.basedOn ?? 'due_date'),
                      endsOn: data.recurrence?.endsOn ?? null,
                      ...(data.dueOn ? { anchorOn: data.dueOn } : {}),
                    }
                  : null,
                timeZone: zone,
              });
            }}
          >
            <option value="">Does not repeat</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
            <option value="periodically">Periodically after completion</option>
          </select>
        </label>
        {data.recurrence && (
          <>
            <label className="planner-field">
              <span>Repeat interval</span>
              <input
                type="number"
                min={1}
                max={365}
                required
                value={data.recurrence.interval}
                onChange={(e) => repeat({ interval: Number(e.target.value) })}
              />
            </label>
            <label className="planner-field">
              <span>Repeat from</span>
              <select
                disabled={data.recurrence.frequency === 'periodically'}
                value={
                  data.recurrence.frequency === 'periodically'
                    ? 'completion_date'
                    : (data.recurrence.basedOn ?? 'due_date')
                }
                onChange={(e) =>
                  repeat({ basedOn: e.target.value as PlannerRecurrence['basedOn'] })
                }
              >
                <option value="due_date">Scheduled due date</option>
                <option value="completion_date">Date completed</option>
              </select>
            </label>
            <label className="planner-field">
              <span>Repeat until</span>
              <input
                type="date"
                min={data.dueOn ?? undefined}
                value={data.recurrence.endsOn ?? ''}
                onInput={(e) => repeat({ endsOn: e.currentTarget.value || null })}
              />
            </label>
          </>
        )}
      </div>
      {data.recurrence?.frequency === 'weekly' && (
        <fieldset className="planner-weekdays">
          <legend>Repeat on</legend>
          {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
            (name, day) => (
              <label key={name}>
                <input
                  type="checkbox"
                  checked={data.recurrence?.weekdays?.includes(day) ?? false}
                  onChange={(e) =>
                    repeat({
                      weekdays: e.target.checked
                        ? [...(data.recurrence?.weekdays ?? []), day].sort()
                        : (data.recurrence?.weekdays ?? []).filter((value) => value !== day),
                    })
                  }
                />
                {name}
              </label>
            ),
          )}
          <small>Leave blank to repeat on the due date’s weekday.</small>
        </fieldset>
      )}
      {data.recurrence && (
        <p className="planner-help">
          One next task is created when this task is completed.
          {data.recurrence.frequency === 'periodically' && ' The interval is in days.'}
          {next
            ? ` Next due date: ${next.dueOn}.`
            : data.dueOn
              ? ' The next date is beyond the repeat end date.'
              : ' Choose a due date to repeat.'}
        </p>
      )}
      {(data.startTime || data.dueTime) && (
        <p className="planner-help">
          Times follow {zone}. During daylight saving changes, skipped times move forward and
          repeated times use their first occurrence.
        </p>
      )}
    </fieldset>
  );
}
