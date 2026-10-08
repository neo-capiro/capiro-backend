import { useEffect, useRef, useState } from 'react';
import { Frame } from './planner-capacity-editor.js';
import { plannerError } from './planner-api.js';

export type CapacityLimitsDraft = {
  revision: string;
  people: { id: string; name: string; weeklyMinutes: number; canEdit: boolean }[];
};
export function PlannerCapacityLimits({
  draft,
  onClose,
  onSave,
}: {
  draft: CapacityLimitsDraft;
  onClose: () => void;
  onSave: (revision: string, changes: { id: string; weeklyMinutes: number }[]) => Promise<unknown>;
}) {
  // Keep the opening revision and values even when the plan refreshes in the background.
  const [opening] = useState(draft);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [values, setValues] = useState(() =>
    Object.fromEntries(draft.people.map((p) => [p.id, String(p.weeklyMinutes / 60)])),
  );
  const [common, setCommon] = useState('40');
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>();
  const allEditable = opening.people.length > 0 && opening.people.every((p) => p.canEdit);
  const minutes = (text: string) => {
    const value = text.trim() ? Number(text) * 60 : NaN;
    return Math.abs(value - Math.round(value)) < 1e-7 ? Math.round(value) : NaN;
  };
  const changes = opening.people
    .filter((p) => p.canEdit && minutes(values[p.id]!) !== p.weeklyMinutes)
    .map((p) => ({ id: p.id, weeklyMinutes: minutes(values[p.id]!) }));
  return (
    <Frame title="Weekly capacity" onClose={() => !pending && onClose()}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          if (!changes.length) return;
          if (
            changes.length > 1000 ||
            changes.some(
              (c) =>
                !Number.isInteger(c.weeklyMinutes) ||
                c.weeklyMinutes < 0 ||
                c.weeklyMinutes > 10080,
            )
          ) {
            setError(new Error('Choose 0–168 hours in whole minutes for at most 1000 people.'));
            return;
          }
          setPending(true);
          try {
            await onSave(opening.revision, changes);
            if (alive.current) onClose();
          } catch (err) {
            if (alive.current) setError(err);
          } finally {
            if (alive.current) setPending(false);
          }
        }}
      >
        <p className="planner-muted">
          Weekly limits are shared across Planner plans and Workload. Percentage allocations use the
          new limit; total-hour allocations keep their effort.
        </p>
        {opening.people.length > 1 && (
          <fieldset disabled={pending || !allEditable}>
            <legend>Same capacity for everyone shown</legend>
            <label className="planner-field">
              Weekly hours for everyone
              <input
                type="number"
                min={0}
                max={168}
                step="any"
                value={common}
                onInput={(e) => setCommon(e.currentTarget.value)}
              />
            </label>
            <button
              type="button"
              onClick={() => {
                if (
                  !Number.isInteger(minutes(common)) ||
                  minutes(common) < 0 ||
                  minutes(common) > 10080
                ) {
                  setError(new Error('Choose 0–168 hours in whole minutes.'));
                  return;
                }
                setValues(Object.fromEntries(opening.people.map((p) => [p.id, common])));
                setError(null);
              }}
            >
              Apply to everyone shown
            </button>
          </fieldset>
        )}
        {opening.people.map((p) => (
          <label className="planner-field" key={p.id}>
            {p.name} weekly hours
            <input
              type="number"
              min={0}
              max={168}
              step="any"
              aria-label={`${p.name} weekly hours`}
              disabled={pending || !p.canEdit}
              value={values[p.id]}
              onInput={(e) => setValues({ ...values, [p.id]: e.currentTarget.value })}
            />
            {!p.canEdit && <small>Read only</small>}
          </label>
        ))}
        {error ? (
          <p className="planner-error" role="alert">
            {plannerError(error)}
          </p>
        ) : null}
        <button className="planner-primary" disabled={pending || !changes.length}>
          Save weekly capacity
        </button>
      </form>
    </Frame>
  );
}
