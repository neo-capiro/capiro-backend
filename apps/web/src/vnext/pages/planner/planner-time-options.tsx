import { plannerBudgetCurrency, type PlannerTimeOptions } from '@capiro/strategy-verifier';

export function PlannerTimeOptionsFields({
  value,
  onChange,
  categories,
  onCategories,
}: {
  value: PlannerTimeOptions;
  onChange: (value: PlannerTimeOptions) => void;
  categories: string;
  onCategories: (value: string) => void;
}) {
  return (
    <>
      <h3>Time tracking and submission</h3>
      <label className="planner-field">
        <span>Default budget currency</span>
        <input
          aria-label="Default budget currency"
          value={value.budgetCurrency ?? 'USD'}
          maxLength={3}
          onChange={(e) => onChange({ ...value, budgetCurrency: e.target.value.toUpperCase() })}
        />
      </label>
      {!plannerBudgetCurrency(value.budgetCurrency ?? 'USD') && (
        <p role="alert">Enter a supported three-letter currency code.</p>
      )}
      <p className="planner-muted">
        Used for newly configured project budgets. Existing budgets keep their saved currency.
      </p>
      {(
        [
          ['timeTrackingEnabled', 'Enable time tracking'],
          ['billableEnabled', 'Enable billable time'],
          ['billableDefault', 'New entries are billable by default'],
          ['generalWorkEnabled', 'Allow general project time'],
        ] as const
      ).map(([key, label]) => (
        <label className="planner-check" key={key}>
          <input
            type="checkbox"
            checked={value[key]}
            disabled={key === 'billableDefault' && !value.billableEnabled}
            onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
          />
          {label}
        </label>
      ))}
      <label className="planner-field">
        <span>Submission workflow</span>
        <select
          aria-label="Submission workflow"
          value={value.approvalProcess}
          onChange={(e) =>
            onChange({ ...value, approvalProcess: e.target.value as 'simple' | 'full' })
          }
        >
          <option value="full">Submit, approve or reject</option>
          <option value="simple">Submit without approval</option>
        </select>
      </label>
      <h3>Submission reminders</h3>
      <label className="planner-check">
        <input
          type="checkbox"
          checked={!!value.submissionReminder}
          onChange={(e) =>
            onChange({
              ...value,
              submissionReminder: e.target.checked
                ? { weekday: 5, time: '17:00', week: 'current' }
                : null,
            })
          }
        />
        Send a weekly submission reminder
      </label>
      {value.submissionReminder && (
        <div className="planner-config-grid">
          <label className="planner-field">
            <span>Day</span>
            <select
              aria-label="Submission reminder day"
              value={value.submissionReminder.weekday}
              onChange={(e) =>
                onChange({
                  ...value,
                  submissionReminder: {
                    ...value.submissionReminder!,
                    weekday: Number(e.target.value),
                  },
                })
              }
            >
              {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(
                (day, i) => (
                  <option key={day} value={i + 1}>
                    {day}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="planner-field">
            <span>Time</span>
            <input
              type="time"
              aria-label="Submission reminder time"
              value={value.submissionReminder.time}
              onInput={(e) =>
                onChange({
                  ...value,
                  submissionReminder: { ...value.submissionReminder!, time: e.currentTarget.value },
                })
              }
              onChange={(e) =>
                onChange({
                  ...value,
                  submissionReminder: { ...value.submissionReminder!, time: e.target.value },
                })
              }
            />
          </label>
          <label className="planner-field">
            <span>Timesheet week</span>
            <select
              aria-label="Submission reminder week"
              value={value.submissionReminder.week}
              onChange={(e) =>
                onChange({
                  ...value,
                  submissionReminder: {
                    ...value.submissionReminder!,
                    week: e.target.value as 'current' | 'previous',
                  },
                })
              }
            >
              <option value="current">Current week</option>
              <option value="previous">Previous week</option>
            </select>
          </label>
        </div>
      )}
      <p className="planner-muted">
        Reminders use the time rules zone and appear in Planner Inbox and the notification bell.
        Full approval reminds active assigned submitters; simple submission reminds active
        organization members. Submitted and approved weeks are skipped.
      </p>
      <h3>Entry dates</h3>
      <label className="planner-field">
        <span>Time rules zone</span>
        <input
          aria-label="Time rules zone"
          value={value.timeZone}
          maxLength={100}
          onChange={(e) => onChange({ ...value, timeZone: e.target.value })}
        />
      </label>
      <div className="planner-config-grid">
        <label className="planner-field">
          <span>Past weeks that remain editable</span>
          <input
            aria-label="Past editable weeks"
            type="number"
            min={0}
            max={520}
            placeholder="No limit"
            value={value.pastLockWeeks ?? ''}
            onChange={(e) =>
              onChange({
                ...value,
                pastLockWeeks: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </label>
        <label className="planner-field">
          <span>Future weeks available for logging</span>
          <input
            aria-label="Future logging weeks"
            type="number"
            min={0}
            max={520}
            placeholder="No limit"
            value={value.futureWeeks ?? ''}
            onChange={(e) =>
              onChange({
                ...value,
                futureWeeks: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </label>
      </div>
      <p className="planner-muted">
        Leave a limit blank for unrestricted dates. Zero allows the current calendar week. Weeks run
        Monday–Sunday in the rules zone. Organization admins can correct locked past entries; future
        limits apply to everyone.
      </p>
      <h3>Time categories</h3>
      <label className="planner-field">
        <span>Configured categories</span>
        <textarea
          aria-label="Configured time categories"
          rows={4}
          maxLength={10100}
          placeholder={'Research\nPlanning\nDelivery'}
          value={categories}
          onChange={(e) => onCategories(e.target.value)}
        />
      </label>
      <p className="planner-muted">
        One category per line. Leave blank for free-text categories. Existing entries keep retired
        labels.
      </p>
    </>
  );
}
