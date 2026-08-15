/*
 * §7.10b — Firm phases overlay. Route: /strategies/phases (over the library).
 *
 * The firm-wide phase ladder every strategy timeline hangs on. Full-replace
 * PUT: the body edits a local copy of the rows and saves the whole set at
 * once (usePutFirmPhases → PUT /firm-phases { rows: FirmPhaseInput[] }).
 * §8.4 rules are enforced client-side BEFORE the save is offered: 3–12 rows,
 * unique names, Q1–Q4 quarters, 4-digit fiscal years. End FY·Q is the
 * EXCLUSIVE boundary (FirmPhaseInput contract) — the derived pill says so.
 *
 * Focus trap / Escape / dirty guard / route sync live in StrategiesModalShell.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { CapiroButton, CapiroIconButton } from '../../../components/actions/index.js';
import { CapiroErrorState, CapiroSkeleton } from '../../../components/feedback/index.js';
import { relativeTime } from '../../../../pages/strategy/constants.js';
import type { FirmPhase, FirmPhaseInput } from '../../../../pages/strategy/types.js';
import { memberName, useFirmPhases, usePutFirmPhases, useTenantMembers } from '../strategies-api.js';
import { StrategiesModalShell } from './StrategiesModalShell.js';

const MIN_PHASES = 3;
const MAX_PHASES = 12;

type Row = FirmPhaseInput & { _key: string };

function toRow(phase: FirmPhase): Row {
  return {
    _key: phase.id,
    label: phase.label,
    startFy: phase.startFy,
    startQ: phase.startQ,
    endFy: phase.endFy,
    endQ: phase.endQ,
  };
}

function toInputs(rows: Row[]): FirmPhaseInput[] {
  return rows.map(({ label, startFy, startQ, endFy, endQ }) => ({
    label: label.trim(),
    startFy,
    startQ,
    endFy,
    endQ,
  }));
}

/** Quarter count spanned (end-exclusive); null when the span is not computable. */
function spanQuarters(row: Row): number | null {
  const span = (row.endFy - row.startFy) * 4 + (row.endQ - row.startQ);
  return Number.isFinite(span) && span > 0 ? span : null;
}

export function FirmPhasesOverlay() {
  const phases = useFirmPhases();
  const members = useTenantMembers();
  const put = usePutFirmPhases();

  const [rows, setRows] = useState<Row[] | null>(null);
  const [baseline, setBaseline] = useState<string>('');
  const keyCounter = useRef(0);

  /* Adopt the server rows once (and again after each successful save). */
  useEffect(() => {
    if (phases.data && rows === null) {
      const next = phases.data.map(toRow);
      setRows(next);
      setBaseline(JSON.stringify(toInputs(next)));
    }
  }, [phases.data, rows]);

  const dirty = rows !== null && JSON.stringify(toInputs(rows)) !== baseline;

  const dupeKeys = useMemo(() => {
    const seen = new Map<string, number>();
    for (const row of rows ?? []) {
      const name = row.label.trim().toLowerCase();
      if (!name) continue;
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
    const dupes = new Set<string>();
    for (const row of rows ?? []) {
      const name = row.label.trim().toLowerCase();
      if (name && (seen.get(name) ?? 0) > 1) dupes.add(row._key);
    }
    return dupes;
  }, [rows]);

  const problems = useMemo(() => {
    if (!rows) return [];
    const out: string[] = [];
    if (rows.length < MIN_PHASES) out.push(`At least ${MIN_PHASES} firm phases are required.`);
    if (rows.length > MAX_PHASES) out.push(`No more than ${MAX_PHASES} firm phases are allowed.`);
    if (rows.some((r) => !r.label.trim())) out.push('Every phase needs a name.');
    if (dupeKeys.size > 0) out.push('Phase names must be unique — highlighted rows are duplicates.');
    if (rows.some((r) => !Number.isInteger(r.startQ) || r.startQ < 1 || r.startQ > 4 || !Number.isInteger(r.endQ) || r.endQ < 1 || r.endQ > 4)) {
      out.push('Quarters run Q1–Q4.');
    }
    if (
      rows.some(
        (r) =>
          !Number.isInteger(r.startFy) ||
          String(Math.abs(r.startFy)).length !== 4 ||
          !Number.isInteger(r.endFy) ||
          String(Math.abs(r.endFy)).length !== 4,
      )
    ) {
      out.push('Fiscal years must be 4-digit years (e.g. 2027).');
    }
    return out;
  }, [rows, dupeKeys]);

  /* "Updated by X · date" — the most recent stamp across the saved rows. */
  const stamp = useMemo(() => {
    let latest: FirmPhase | null = null;
    for (const phase of phases.data ?? []) {
      if (!phase.updatedAt) continue;
      if (!latest || (phase.updatedAt ?? '') > (latest.updatedAt ?? '')) latest = phase;
    }
    return latest;
  }, [phases.data]);

  const updateRow = (key: string, patch: Partial<FirmPhaseInput>) => {
    setRows((current) =>
      (current ?? []).map((row) => (row._key === key ? { ...row, ...patch } : row)),
    );
  };

  const parseQuarter = (value: string) => Number.parseInt(value, 10);

  const addRow = () => {
    setRows((current) => {
      const rowsNow = current ?? [];
      if (rowsNow.length >= MAX_PHASES) return rowsNow;
      const last = rowsNow[rowsNow.length - 1];
      keyCounter.current += 1;
      const startFy = last ? last.endFy : new Date().getFullYear();
      const startQ = last ? last.endQ : 1;
      return [
        ...rowsNow,
        { _key: `new-${keyCounter.current}`, label: '', startFy, startQ, endFy: startFy + 1, endQ: startQ },
      ];
    });
  };

  const removeRow = (key: string) => {
    setRows((current) => {
      const rowsNow = current ?? [];
      if (rowsNow.length <= MIN_PHASES) return rowsNow;
      return rowsNow.filter((row) => row._key !== key);
    });
  };

  const canSave = dirty && problems.length === 0 && !put.isPending;

  const save = () => {
    if (!canSave || !rows) return;
    put.mutate(toInputs(rows), {
      onSuccess: (saved) => {
        const next = saved.map(toRow);
        setRows(next);
        setBaseline(JSON.stringify(toInputs(next)));
      },
    });
  };

  const fyInput = (row: Row, field: 'startFy' | 'endFy', label: string) => (
    <input
      className="st-phase-row__input"
      style={{ width: 56, textAlign: 'center' }}
      type="number"
      inputMode="numeric"
      aria-label={`${row.label || 'Phase'} — ${label} fiscal year`}
      value={Number.isNaN(row[field]) ? '' : row[field]}
      onChange={(event) =>
        updateRow(row._key, { [field]: event.target.value === '' ? Number.NaN : parseQuarter(event.target.value) })
      }
    />
  );

  const qInput = (row: Row, field: 'startQ' | 'endQ', label: string) => (
    <input
      className="st-phase-row__input"
      style={{ width: 40, textAlign: 'center' }}
      type="number"
      min={1}
      max={4}
      inputMode="numeric"
      aria-label={`${row.label || 'Phase'} — ${label} quarter`}
      value={Number.isNaN(row[field]) ? '' : row[field]}
      onChange={(event) =>
        updateRow(row._key, { [field]: event.target.value === '' ? Number.NaN : parseQuarter(event.target.value) })
      }
    />
  );

  return (
    <StrategiesModalShell
      eyebrow="Firm phases"
      title="The firm's shared phase ladder"
      subtitle="These phases underlie every strategy timeline. Saving replaces the whole ladder at once."
      closeTo="/strategies"
      size="lg"
      dirty={dirty && !put.isPending}
      primaryLabel="Save phases"
      onPrimary={save}
      primaryDisabled={!canSave}
      primaryBusy={put.isPending}
      footerNote={
        put.isPending
          ? 'Saving…'
          : put.isError
            ? 'Save failed — your edits are still here. Fix and retry.'
            : !dirty && rows !== null && baseline !== ''
              ? stamp
                ? `Updated by ${memberName(members.data, stamp.updatedByUserId)} · ${relativeTime(stamp.updatedAt ?? null)}`
                : 'All changes saved.'
              : dirty
                ? 'Unsaved changes'
                : null
      }
    >
      {put.isError ? (
        <p className="st-modal__alert" role="alert">
          The phases could not be saved. {(put.error as Error)?.message || 'Please try again.'}
        </p>
      ) : null}

      {phases.isLoading || rows === null ? (
        <div className="st-skel-stack">
          <CapiroSkeleton height={40} />
          <CapiroSkeleton height={40} />
          <CapiroSkeleton height={40} />
          <CapiroSkeleton height={40} width="70%" />
        </div>
      ) : phases.isError ? (
        <CapiroErrorState
          title="Firm phases could not be loaded"
          description="The shared phase ladder is unavailable. Nothing here was changed."
          onRetry={() => void phases.refetch()}
        />
      ) : (
        <>
          <div className="st-phases__list">
            {rows.map((row, index) => {
              const quarters = spanQuarters(row);
              return (
                <div className="st-phase-row" key={row._key}>
                  <span className="st-phase-row__num">{index + 1}</span>
                  <input
                    className={`st-phase-row__input${dupeKeys.has(row._key) ? ' is-dupe' : ''}`}
                    aria-label={`Phase ${index + 1} name`}
                    placeholder="Phase name"
                    value={row.label}
                    onChange={(event) => updateRow(row._key, { label: event.target.value })}
                  />
                  <span className="st-phase-row__editor">
                    <span className="st-phase-row__fields">
                      FY{fyInput(row, 'startFy', 'start')} Q{qInput(row, 'startQ', 'start')}
                      <span aria-hidden="true">→</span>
                      FY{fyInput(row, 'endFy', 'end')} Q{qInput(row, 'endQ', 'end')}
                    </span>
                    <span className="st-phase-row__span">
                      {quarters === null ? '—' : `${quarters} quarter${quarters === 1 ? '' : 's'}`} · end exclusive
                    </span>
                  </span>
                  <span className="st-phase-row__actions">
                    <CapiroIconButton
                      label={`Remove phase ${index + 1}`}
                      icon="×"
                      disabled={rows.length <= MIN_PHASES}
                      onClick={() => removeRow(row._key)}
                    />
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 12 }}>
            <CapiroButton
              variant="secondary"
              size="compact"
              disabled={rows.length >= MAX_PHASES}
              onClick={addRow}
            >
              Add phase
            </CapiroButton>
          </div>

          <div style={{ marginTop: 16 }}>
            <p className="st-rule">· Between {MIN_PHASES} and {MAX_PHASES} phases; names must be unique.</p>
            <p className="st-rule">· The end FY·Q is exclusive — a phase runs up to, not through, that quarter.</p>
            {problems.map((problem) => (
              <p className="st-rule" role="alert" key={problem} style={{ color: 'var(--st-error-fg)' }}>
                · {problem}
              </p>
            ))}
          </div>
        </>
      )}
    </StrategiesModalShell>
  );
}
