import type { PlannerTemplateData } from '@capiro/strategy-verifier';

export function plannerTemplateOffsets(
  config: PlannerTemplateData,
  anchor: 'start' | 'due',
): NonNullable<PlannerTemplateData['schedule']> {
  const dates = config.tasks
    .flatMap((task) => [task.startOn, task.dueOn])
    .filter((date): date is string => Boolean(date))
    .sort();
  const reference =
    (anchor === 'start' ? config.project.startOn : config.project.dueOn) ??
    (anchor === 'start' ? dates[0] : dates.at(-1));
  const offset = (date: string | null) =>
    date && reference ? Math.round((Date.parse(date) - Date.parse(reference)) / 86400000) : null;
  return {
    anchor,
    skipWeekends: false,
    dates: config.tasks.map((task) => ({
      startOffset: offset(task.startOn),
      dueOffset: offset(task.dueOn),
    })),
  };
}

export function PlannerTemplateScheduleEditor({
  config,
  onChange,
}: {
  config: PlannerTemplateData;
  onChange: (schedule: PlannerTemplateData['schedule']) => void;
}) {
  const schedule = config.schedule;
  return (
    <fieldset className="planner-template-schedule">
      <legend>Template schedule</legend>
      <label className="planner-field">
        <span>Schedule dates from</span>
        <select
          value={schedule?.anchor ?? 'fixed'}
          onChange={(e) => {
            const anchor = e.target.value;
            onChange(
              anchor === 'fixed'
                ? undefined
                : schedule
                  ? { ...schedule, anchor: anchor as 'start' | 'due' }
                  : plannerTemplateOffsets(config, anchor as 'start' | 'due'),
            );
          }}
        >
          <option value="fixed">Keep fixed dates</option>
          <option value="start">Project start date</option>
          <option value="due">Project due date</option>
        </select>
      </label>
      {schedule && (
        <>
          <label>
            <input
              type="checkbox"
              checked={schedule.skipWeekends}
              onChange={(e) => {
                const skipWeekends = e.target.checked;
                onChange({ ...schedule, skipWeekends });
              }}
            />
            Count working days and skip weekends
          </label>
          <p className="planner-muted">
            Enter negative days for dates before the reference date and positive days for dates
            after it. Leave blank for no date.
          </p>
          <div className="planner-template-offsets">
            {config.tasks.map((task, index) => (
              <div className="planner-config-row" key={index}>
                <strong>{task.name}</strong>
                {(['startOffset', 'dueOffset'] as const).map((field) => (
                  <label key={field}>
                    {field === 'startOffset' ? 'Start' : 'Due'}
                    <input
                      aria-label={`${task.name} ${field === 'startOffset' ? 'start' : 'due'} offset`}
                      type="number"
                      min={-3650}
                      max={3650}
                      step={1}
                      value={schedule.dates[index]?.[field] ?? ''}
                      onChange={(e) => {
                        const value = e.target.value === '' ? null : Number(e.target.value);
                        onChange({
                          ...schedule,
                          dates: schedule.dates.map((date, i) =>
                            i === index ? { ...date, [field]: value } : date,
                          ),
                        });
                      }}
                    />
                  </label>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </fieldset>
  );
}
