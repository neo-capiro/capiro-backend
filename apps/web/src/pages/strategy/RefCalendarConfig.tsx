/*
 * Reference-calendar editor (REF-2,3,5,6) — ported from the prototype sp-app
 * RefCalendarConfig. Kind-aware: congress milestones (label + from/to quarter
 * selects, converted to real dates on save — REF-6/D2) or PPBE current-phase
 * rows (fiscal year + phase text). Save forks the tenant override (REF-5);
 * Cancel discards. When Meri is enabled, the "Ask Meri" assist (REF-4) edits
 * the working rows in place — it never saves; the user still reviews and hits
 * Save (which forks the override).
 */
import { useState } from 'react';
import { App } from 'antd';
import { Overlay, Icon, btnPrimary, btnGhost, iconBtn } from './strategy-ui.js';
import { quarterStartDateIso, qOfDate, parseDbDate, type FiscalCalendar } from './fiscal.js';
import { usePutReference, useRefAssist } from './api.js';
import type { ReferenceCalendars, ReferenceForkRow } from './types.js';

interface EditorRow {
  key: string;
  label: string;
  from?: number; // congress: inclusive quarter idx
  to?: number; // congress: exclusive quarter idx
  fy?: number; // ppbe
  tone: string;
}

let seqId = 0;
const newKey = () => `r-${seqId++}`;

export function RefCalendarConfig({
  kind,
  calendars,
  calendar,
  meriEnabled = false,
  onClose,
  onSaved,
}: {
  kind: 'congress' | 'ppbe';
  calendars: ReferenceCalendars;
  calendar: FiscalCalendar;
  meriEnabled?: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const { message } = App.useApp();
  const isCongress = kind === 'congress';
  const put = usePutReference(kind);
  const assist = useRefAssist(kind);
  const todayIdx = Math.round(calendar.todayQ);
  const lastIdx = calendar.quarters.length; // exclusive-end ceiling

  // Baseline milestones carry real (non-quarter-aligned) dates; snap the
  // inclusive start DOWN (floor) and the exclusive end UP (ceil) so an
  // unmodified baseline row always loads as a valid from<to selection (never
  // a collapsed/backwards range that would disable Save).
  const [rows, setRows] = useState<EditorRow[]>(() =>
    isCongress
      ? calendars.congress.map((r) => {
          const from = r.startsOn
            ? Math.max(0, Math.min(lastIdx - 1, Math.floor(qOfDate(parseDbDate(r.startsOn), calendar))))
            : todayIdx;
          const toRaw = r.endsOn ? Math.ceil(qOfDate(parseDbDate(r.endsOn), calendar)) : from + 1;
          return {
            key: newKey(),
            label: r.label,
            from,
            to: Math.max(from + 1, Math.min(lastIdx, toRaw)),
            tone: r.tone ?? 'info',
          };
        })
      : calendars.ppbeCurrentPhases.map((r) => ({
          key: newKey(),
          label: r.label,
          fy: r.fy ?? calendar.fys[0],
          tone: r.tone ?? 'info',
        })),
  );

  const set = (i: number, k: keyof EditorRow, v: string | number) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const del = (i: number) => setRows((r) => r.filter((_, j) => j !== i));
  const add = () =>
    setRows((r) => [
      ...r,
      isCongress
        ? { key: newKey(), label: 'New milestone', from: todayIdx, to: todayIdx + 1, tone: 'info' }
        : { key: newKey(), label: 'New phase', fy: calendar.fys[0], tone: 'info' },
    ]);

  // REF-4: Meri rewrites the working set. We hand it rows in the shape its tool
  // expects (congress = {label, from, to} quarter indices; ppbe = {fy, phase}),
  // then re-parse + clamp what it returns back into editor rows. It never saves.
  const [meriText, setMeriText] = useState('');
  const parseMeriRows = (raw: unknown): EditorRow[] => {
    if (!Array.isArray(raw)) return [];
    const out: EditorRow[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const tone = typeof r.tone === 'string' ? r.tone : 'info';
      if (isCongress) {
        const label = typeof r.label === 'string' ? r.label : '';
        let from = Number(r.from);
        let to = Number(r.to);
        if (!Number.isFinite(from)) from = todayIdx;
        if (!Number.isFinite(to)) to = from + 1;
        from = Math.max(0, Math.min(lastIdx - 1, Math.floor(from)));
        to = Math.max(from + 1, Math.min(lastIdx, Math.ceil(to)));
        out.push({ key: newKey(), label, from, to, tone });
      } else {
        const label =
          typeof r.phase === 'string' ? r.phase : typeof r.label === 'string' ? r.label : '';
        let fy = Number(r.fy);
        if (!Number.isFinite(fy)) fy = calendar.fys[0]!;
        out.push({ key: newKey(), label, fy: Math.round(fy), tone });
      }
    }
    return out;
  };
  const runMeri = () => {
    const instruction = meriText.trim();
    if (!instruction || assist.isPending) return;
    const payload = rows.map((r) =>
      isCongress
        ? { label: r.label, from: r.from, to: r.to, tone: r.tone }
        : { fy: r.fy, phase: r.label, tone: r.tone },
    );
    assist.mutate(
      { instruction, rows: payload },
      {
        onSuccess: (res) => {
          const next = parseMeriRows(res.rows);
          if (next.length) {
            setRows(next);
            setMeriText('');
          } else {
            message.info('Meri did not change any rows.');
          }
        },
        onError: () => message.error('Meri could not adjust the calendar — please try again.'),
      },
    );
  };

  const invalid =
    rows.length === 0 ||
    rows.some(
      (r) =>
        !r.label.trim() ||
        (isCongress ? (r.to ?? 0) <= (r.from ?? 0) : !r.fy || r.fy < 2000 || r.fy > 2100),
    );

  const save = () => {
    const payload: ReferenceForkRow[] = rows.map((r) =>
      isCongress
        ? {
            label: r.label.trim(),
            startsOn: quarterStartDateIso(r.from ?? todayIdx, calendar),
            endsOn: quarterStartDateIso(r.to ?? todayIdx + 1, calendar),
            tone: r.tone,
          }
        : { label: r.label.trim(), fy: r.fy, tone: r.tone },
    );
    put.mutate(payload, {
      onSuccess: () => {
        onSaved(isCongress ? 'Legislative calendar updated.' : 'PPBE reference updated.');
        onClose();
      },
      onError: () => message.error('Could not save the reference edits.'),
    });
  };

  const sel: React.CSSProperties = {
    border: '1px solid var(--border-2)',
    borderRadius: 7,
    padding: 6,
    fontSize: 'var(--text-2xs)',
    fontFamily: 'var(--font-sans)',
    color: 'var(--ink-1)',
    background: 'var(--bg-surface)',
  };
  const txt: React.CSSProperties = {
    border: '1px solid var(--border-2)',
    borderRadius: 7,
    padding: '7px 10px',
    fontSize: 'var(--text-sm)',
    fontFamily: 'var(--font-sans)',
    color: 'var(--ink-1)',
  };

  return (
    <Overlay onClose={onClose}>
      <div
        style={{
          width: 640,
          maxHeight: '86vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-surface)',
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: '0 24px 60px rgba(12,26,56,0.28)',
        }}
      >
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid var(--border-1)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--ink-1)' }}>
              Edit the {isCongress ? 'legislative calendar' : 'PPBE reference'}
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-3)', marginTop: 2 }}>
              Reference data can shift — adjust it manually. Applies to all strategies.
            </div>
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={iconBtn}>
            <Icon name="x" size={16} color="var(--ink-3)" />
          </button>
        </div>

        <div style={{ padding: '10px 24px 16px', overflow: 'auto' }}>
          {meriEnabled && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: 'var(--accent-soft)',
                border: '1px solid #C6D4F4',
                borderRadius: 9,
                padding: '9px 11px',
                marginBottom: 8,
              }}
            >
              <Icon name="spark" size={15} color="var(--accent-ink)" />
              <input
                value={meriText}
                onChange={(e) => setMeriText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    runMeri();
                  }
                }}
                disabled={assist.isPending}
                placeholder={
                  isCongress
                    ? 'Ask Meri, e.g. “shift markups a month later this year”'
                    : 'Ask Meri, e.g. “move everything to the FY27 execution phase”'
                }
                style={{
                  flex: 1,
                  border: '1px solid var(--border-2)',
                  borderRadius: 7,
                  padding: '7px 10px',
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'var(--font-sans)',
                  color: 'var(--ink-1)',
                  background: 'var(--bg-surface)',
                }}
              />
              <button
                onClick={runMeri}
                disabled={!meriText.trim() || assist.isPending}
                style={{
                  ...btnPrimary,
                  padding: '7px 13px',
                  opacity: !meriText.trim() || assist.isPending ? 0.45 : 1,
                  cursor: !meriText.trim() || assist.isPending ? 'not-allowed' : 'pointer',
                }}
              >
                {assist.isPending ? 'Working…' : 'Ask Meri'}
              </button>
            </div>
          )}
          <div
            style={{
              display: 'flex',
              fontSize: 'var(--text-2xs)',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--ink-4)',
              padding: '8px 4px',
            }}
          >
            {isCongress ? (
              <>
                <span style={{ flex: 1 }}>Milestone</span>
                <span style={{ width: 210 }}>Runs (quarters)</span>
                <span style={{ width: 30 }} />
              </>
            ) : (
              <>
                <span style={{ width: 90 }}>Fiscal year</span>
                <span style={{ flex: 1 }}>Current phase</span>
                <span style={{ width: 30 }} />
              </>
            )}
          </div>
          {rows.map((r, i) => (
            <div
              key={r.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 4px',
                borderTop: '1px solid var(--border-1)',
              }}
            >
              {isCongress ? (
                <>
                  <input
                    value={r.label}
                    onChange={(e) => set(i, 'label', e.target.value)}
                    style={{
                      ...txt,
                      flex: 1,
                      border: `1px solid ${r.label.trim() ? 'var(--border-2)' : 'var(--critical)'}`,
                    }}
                  />
                  <div style={{ width: 210, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <select
                      value={r.from}
                      onChange={(e) => set(i, 'from', +e.target.value)}
                      style={{ ...sel, flex: 1 }}
                    >
                      {calendar.quarters.map((q, qi) => (
                        <option key={qi} value={qi}>
                          {q.fy} {q.q}
                        </option>
                      ))}
                    </select>
                    <span style={{ color: 'var(--ink-4)', fontSize: 'var(--text-xs)' }}>→</span>
                    <select
                      value={r.to}
                      onChange={(e) => set(i, 'to', +e.target.value)}
                      style={{
                        ...sel,
                        flex: 1,
                        border: `1px solid ${(r.to ?? 0) > (r.from ?? 0) ? 'var(--border-2)' : 'var(--critical)'}`,
                      }}
                    >
                      {calendar.quarters.map((q, qi) => (
                        <option key={qi} value={qi + 1}>
                          {q.fy} {q.q}
                        </option>
                      ))}
                    </select>
                  </div>
                </>
              ) : (
                <>
                  <input
                    type="number"
                    value={r.fy}
                    onChange={(e) => set(i, 'fy', +e.target.value)}
                    style={{ ...txt, width: 90, fontFamily: 'var(--font-mono)' }}
                  />
                  <input
                    value={r.label}
                    onChange={(e) => set(i, 'label', e.target.value)}
                    style={{
                      ...txt,
                      flex: 1,
                      border: `1px solid ${r.label.trim() ? 'var(--border-2)' : 'var(--critical)'}`,
                    }}
                  />
                </>
              )}
              <button onClick={() => del(i)} style={{ ...iconBtn, width: 30 }} title="Remove">
                <Icon name="x" size={13} color="var(--ink-4)" />
              </button>
            </div>
          ))}
          <button
            onClick={add}
            style={{
              marginTop: 12,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: 'var(--bg-surface)',
              border: '1px dashed var(--border-strong)',
              borderRadius: 8,
              padding: '8px 13px',
              fontSize: 'var(--text-sm)',
              fontWeight: 600,
              color: 'var(--ink-2)',
              cursor: 'pointer',
            }}
          >
            <Icon name="plus" size={13} color="var(--ink-2)" /> {isCongress ? 'Add milestone' : 'Add row'}
          </button>
        </div>

        <div
          style={{
            padding: '14px 24px',
            borderTop: '1px solid var(--border-1)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            background: 'var(--bg-surface-2)',
          }}
        >
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-3)' }}>
            Capiro-maintained reference — your edits override it for your firm.
          </span>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={onClose} style={btnGhost}>
              Cancel
            </button>
            <button
              onClick={save}
              disabled={invalid || put.isPending}
              style={{
                ...btnPrimary,
                opacity: invalid || put.isPending ? 0.45 : 1,
                cursor: invalid || put.isPending ? 'not-allowed' : 'pointer',
              }}
            >
              {put.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
