import type { PlannerTimeOptions } from '@capiro/strategy-verifier';

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
