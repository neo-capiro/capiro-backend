/*
 * Legislative-calendar editor — /strategies/:strategyId/legislative-calendar.
 *
 * Ported functionally from the legacy planner's `RefCalendarConfig.tsx`
 * (kind='congress'): a plain row list — label + a FROM-quarter and TO-quarter
 * select, add/remove, Save/Cancel — not date typing, not dragging on the
 * timeline. That is a deliberate match to the legacy UX, not a simplification
 * of it: this IS how app.capiro.ai's "Edit calendar" link works today, and
 * it is far more discoverable than a hover-revealed drag handle on the
 * timeline bar itself (the previous vNext attempt, which buried editing
 * behind an opacity:0-until-hover micro-button).
 *
 * Save forks the tenant's congress override via the same
 * `PUT /strategy-api/reference-calendars/congress` route the legacy editor's
 * `usePutReference('congress')` calls — here as `useForkReferenceCalendar`
 * (strategies-api.ts), which already existed and already works; this file
 * only adds the missing, easy-to-find UI in front of it.
 *
 * No "Ask Meri" instruction box (legacy's optional `meriEnabled` branch): that
 * posts to `/reference-calendars/congress/assist`, a route api-strategy does
 * not implement (confirmed 404 — see StrategyEditorVNext.tsx's prior removal
 * of the same dead endpoint). Omitted here for the same reason.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CapiroButton, CapiroIconButton } from '../../../components/actions/index.js';
import { CapiroErrorState, CapiroSkeleton } from '../../../components/feedback/index.js';
import { CapiroPlusIcon } from '../../../components/icons/index.js';
import {
  buildCalendar,
  parseDbDate,
  qOfDate,
  quarterStartDateIso,
  type FiscalCalendar,
} from '../lib/timeline.js';
import { useReferenceCalendars, useForkReferenceCalendar, type ReferenceForkRow } from '../strategies-api.js';
import { StrategiesModalShell } from './StrategiesModalShell.js';

interface Row {
  _key: string;
  label: string;
  from: number; // inclusive quarter index into cal.quarters
  to: number; // exclusive quarter index
  tone: string;
}

let seq = 0;
const newKey = () => `r-${(seq += 1)}`;

/** A stored (possibly non-quarter-aligned) real date -> a valid inclusive/exclusive
 * quarter-index pair, floored/ceil'd so an unmodified baseline row always loads as
 * a legal `from < to` selection (mirrors legacy RefCalendarConfig's own load logic). */
function toRow(row: { label: string; startsOn: string | null; endsOn: string | null; tone: string | null }, cal: FiscalCalendar, lastIdx: number): Row {
  const todayIdx = Math.round(cal.todayQ);
  const from = row.startsOn
    ? Math.max(0, Math.min(lastIdx - 1, Math.floor(qOfDate(parseDbDate(row.startsOn), cal))))
    : todayIdx;
  const toRaw = row.endsOn ? Math.ceil(qOfDate(parseDbDate(row.endsOn), cal)) : from + 1;
  return { _key: newKey(), label: row.label, from, to: Math.max(from + 1, Math.min(lastIdx, toRaw)), tone: row.tone ?? 'info' };
}

function toForkRows(rows: Row[], cal: FiscalCalendar): ReferenceForkRow[] {
  return rows.map((r) => ({
    label: r.label.trim(),
    startsOn: quarterStartDateIso(r.from, cal),
    endsOn: quarterStartDateIso(r.to, cal),
    tone: r.tone,
  }));
}

export function EditLegislativeCalendarOverlay() {
  const { strategyId } = useParams<{ strategyId: string }>();
  const navigate = useNavigate();
  const closeTo = strategyId ? `/strategies/${strategyId}` : '/strategies';

  const calendars = useReferenceCalendars();
  const fork = useForkReferenceCalendar('congress');
  // One calendar per mount: `now` must not drift mid-edit (a save partway
  // through a session should not silently re-anchor "today").
  const calendar = useMemo(() => buildCalendar(), []);
  const lastIdx = calendar.quarters.length;

  const [rows, setRows] = useState<Row[] | null>(null);
  const [baseline, setBaseline] = useState('');

  useEffect(() => {
    if (calendars.data && rows === null) {
      const next = calendars.data.congress.map((r) => toRow(r, calendar, lastIdx));
      setRows(next);
      setBaseline(JSON.stringify(toForkRows(next, calendar)));
    }
  }, [calendars.data, rows, calendar, lastIdx]);

  const dirty = rows !== null && JSON.stringify(toForkRows(rows, calendar)) !== baseline;

  const problems = useMemo(() => {
    if (!rows) return [];
    const out: string[] = [];
    if (rows.length === 0) out.push('Add at least one milestone, or cancel.');
    if (rows.some((r) => !r.label.trim())) out.push('Every milestone needs a label.');
    if (rows.some((r) => r.to <= r.from)) out.push('Every milestone must end after it starts.');
    if (rows.length > 60) out.push('The legislative calendar holds at most 60 milestones.');
    return out;
  }, [rows]);

  const canSave = dirty && problems.length === 0 && !fork.isPending;

  const updateRow = (key: string, patch: Partial<Row>) =>
    setRows((cur) => (cur ?? []).map((r) => (r._key === key ? { ...r, ...patch } : r)));

  const addRow = () => {
    const todayIdx = Math.round(calendar.todayQ);
    setRows((cur) => [
      ...(cur ?? []),
      { _key: newKey(), label: 'New milestone', from: todayIdx, to: Math.min(lastIdx, todayIdx + 1), tone: 'info' },
    ]);
  };

  const removeRow = (key: string) => setRows((cur) => (cur ?? []).filter((r) => r._key !== key));

  const save = () => {
    if (!canSave || !rows) return;
    fork.mutate(toForkRows(rows, calendar), {
      onSuccess: () => navigate(closeTo),
    });
  };

  const isFork = calendars.data?.source?.congress === 'override';

  return (
    <StrategiesModalShell
      eyebrow="Legislative calendar"
      title="Edit the legislative calendar"
      subtitle="Capiro-maintained reference — your edits override it for your firm and apply to every strategy."
      closeTo={closeTo}
      maxWidth={720}
      dirty={dirty && !fork.isPending}
      primaryLabel="Save changes"
      onPrimary={save}
      primaryDisabled={!canSave}
      primaryBusy={fork.isPending}
      footerNote={
        fork.isPending
          ? 'Saving…'
          : fork.isError
            ? 'Save failed — your edits are still here. Fix and retry.'
            : !dirty && rows !== null
              ? isFork
                ? 'All changes saved.'
                : 'Showing the Capiro baseline — saving forks it into your firm’s own calendar.'
              : dirty
                ? 'Unsaved changes'
                : null
      }
    >
      {fork.isError ? (
        <p className="st-modal__alert" role="alert">
          The calendar could not be saved. {(fork.error as Error)?.message || 'Please try again.'}
        </p>
      ) : null}

      {calendars.isLoading || rows === null ? (
        <div className="st-skel-stack">
          <CapiroSkeleton height={40} />
          <CapiroSkeleton height={40} />
          <CapiroSkeleton height={40} />
        </div>
      ) : calendars.isError ? (
        <CapiroErrorState
          title="The legislative calendar could not be loaded"
          description="Nothing here was changed."
          onRetry={() => void calendars.refetch()}
        />
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--st-gray-400)',
              padding: '8px 4px',
            }}
          >
            <span style={{ flex: 1 }}>Milestone</span>
            <span style={{ width: 240 }}>Runs (quarters)</span>
            <span style={{ width: 30 }} />
          </div>
          <div className="st-phases__list">
            {rows.map((row) => (
              <div className="st-phase-row" key={row._key} style={{ gridTemplateColumns: 'minmax(0, 1fr) auto auto' }}>
                <input
                  className={`st-phase-row__input${!row.label.trim() ? ' is-dupe' : ''}`}
                  aria-label="Milestone label"
                  placeholder="Milestone label"
                  value={row.label}
                  onChange={(e) => updateRow(row._key, { label: e.target.value })}
                />
                <span className="st-phase-row__fields">
                  <select
                    className="st-phase-row__select"
                    aria-label={`${row.label || 'Milestone'} — start quarter`}
                    value={row.from}
                    onChange={(e) => updateRow(row._key, { from: Number.parseInt(e.target.value, 10) })}
                  >
                    {calendar.quarters.map((q, qi) => (
                      <option key={qi} value={qi}>
                        {q.fy} {q.q}
                      </option>
                    ))}
                  </select>
                  <span aria-hidden="true" style={{ color: 'var(--st-gray-400)' }}>→</span>
                  <select
                    className={`st-phase-row__select${row.to <= row.from ? ' is-dupe' : ''}`}
                    aria-label={`${row.label || 'Milestone'} — end quarter`}
                    value={row.to}
                    onChange={(e) => updateRow(row._key, { to: Number.parseInt(e.target.value, 10) })}
                  >
                    {calendar.quarters.map((q, qi) => (
                      <option key={qi + 1} value={qi + 1}>
                        {q.fy} {q.q}
                      </option>
                    ))}
                  </select>
                </span>
                <CapiroIconButton
                  label={`Remove ${row.label || 'milestone'}`}
                  icon={<CloseGlyph size={14} />}
                  onClick={() => removeRow(row._key)}
                />
              </div>
            ))}
          </div>

          <div style={{ marginTop: 12 }}>
            <CapiroButton
              variant="secondary"
              size="compact"
              disabled={rows.length >= 60}
              onClick={addRow}
              style={{ width: '100%' }}
              leadingIcon={<CapiroPlusIcon style={{ width: 16, height: 16, color: 'var(--st-gray-500)' }} />}
            >
              Add milestone
            </CapiroButton>
          </div>

          {problems.length > 0 ? (
            <div style={{ marginTop: 16 }}>
              {problems.map((p) => (
                <p className="st-rule" role="alert" key={p} style={{ color: 'var(--st-error-fg)' }}>
                  · {p}
                </p>
              ))}
            </div>
          ) : null}
        </>
      )}
    </StrategiesModalShell>
  );
}

function CloseGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
