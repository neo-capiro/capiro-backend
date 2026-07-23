/*
 * Firm-phase config modal (PHS-1..6) — ported from the prototype sp-app
 * FirmConfig. Rows are edited in quarter-index space (from = inclusive start,
 * to = EXCLUSIVE end); on save they convert to FY+Q and PUT /firm-phases
 * (full replace). First-run pre-seeds the 7-row template; edit shows the
 * "Updated by X · date" attribution (PHS-5). Applies firm-wide.
 */
import { useMemo, useState } from 'react';
import { App } from 'antd';
import { Overlay, Icon, btnPrimary, btnGhost, iconBtn } from './strategy-ui.js';
import { FIRM_PHASES_DEFAULT } from './constants.js';
import { relativeTime } from './constants.js';
import { idxToFyQ, fyQuarterToQ, type FiscalCalendar } from './fiscal.js';
import { usePutFirmPhases } from './api.js';
import { useTenantMembers, memberName } from './members.js';
import type { FirmPhase } from './types.js';

interface Row {
  id: string;
  label: string;
  from: number; // inclusive quarter index
  to: number; // exclusive quarter index
}

let seqId = 0;
const newId = () => `new-${seqId++}`;

export function FirmConfig({
  firstRun,
  phases,
  calendar,
  onClose,
  onSaved,
}: {
  firstRun: boolean;
  phases: FirmPhase[];
  calendar: FiscalCalendar;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const { message } = App.useApp();
  const put = usePutFirmPhases();
  const members = useTenantMembers();

  const N = calendar.quarters.length;
  // Seed the template ONLY on a genuine first run (never on a merely-empty/
  // still-loading edit — the caller passes firstRun=false until the query
  // resolves, so an unresolved load shows no rows and Save stays disabled
  // rather than wiping real phases). Existing phases whose FY now precedes the
  // rolled-forward window are clamped into it (they need re-rolling anyway, D13)
  // so their selects always have a matching option and never silently reanchor.
  const [rows, setRows] = useState<Row[]>(() =>
    firstRun
      ? FIRM_PHASES_DEFAULT.map((p) => ({ id: newId(), label: p.label, from: p.from, to: p.to }))
      : phases.map((p) => {
          const from = Math.max(0, Math.min(N - 1, fyQuarterToQ(p.startFy, p.startQ, calendar)));
          const to = Math.max(from + 1, Math.min(N, fyQuarterToQ(p.endFy, p.endQ, calendar)));
          return { id: p.id, label: p.label, from, to };
        }),
  );

  const set = (i: number, k: keyof Row, v: string | number) =>
    setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const move = (i: number, d: number) =>
    setRows((r) => {
      const n = [...r];
      const j = i + d;
      if (j < 0 || j >= n.length) return r;
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
  const add = () =>
    setRows((r) => {
      // Append after the last phase (clamped into the window) rather than
      // overlapping the first phase at index 0.
      const from = Math.min(N - 1, r.length ? r[r.length - 1]!.to : 0);
      return [...r, { id: newId(), label: 'New phase', from, to: Math.min(N, from + 1) }];
    });
  const del = (i: number) => setRows((r) => r.filter((_, j) => j !== i));

  const invalid = rows.length === 0 || rows.some((r) => !r.label.trim() || r.to <= r.from);

  const caption = useMemo(() => {
    if (firstRun || phases.length === 0) return null;
    const latest = phases.reduce<FirmPhase | null>(
      (a, b) => (!a || (b.updatedAt ?? '') > (a.updatedAt ?? '') ? b : a),
      null,
    );
    if (!latest?.updatedAt) return null;
    return `Updated by ${memberName(members.data, latest.updatedByUserId)} · ${relativeTime(latest.updatedAt)}`;
  }, [phases, firstRun, members.data]);

  const save = () => {
    const payload = rows.map((r) => {
      const s = idxToFyQ(r.from, calendar);
      const e = idxToFyQ(r.to, calendar);
      return {
        label: r.label.trim(),
        startFy: s.fy,
        startQ: s.q,
        endFy: e.fy,
        endQ: e.q,
      };
    });
    put.mutate(payload, {
      onSuccess: () => {
        onSaved(firstRun ? 'Firm phases set.' : 'Firm phases saved.');
        onClose();
      },
      onError: () => message.error('Could not save the firm phases.'),
    });
  };

  const stepBtn: React.CSSProperties = {
    fontSize: 8,
    lineHeight: 1,
    padding: '2px 0',
    width: 20,
    border: '1px solid var(--border-2)',
    borderRadius: 4,
    background: 'var(--bg-surface)',
    color: 'var(--ink-3)',
    cursor: 'pointer',
  };
  const sel: React.CSSProperties = {
    flex: 1,
    border: '1px solid var(--border-2)',
    borderRadius: 7,
    padding: 6,
    fontSize: 'var(--text-2xs)',
    fontFamily: 'var(--font-sans)',
    color: 'var(--ink-1)',
    background: 'var(--bg-surface)',
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
              {firstRun ? "Set your firm's phases" : 'Configure your firm phases'}
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-3)', marginTop: 2 }}>
              {firstRun
                ? 'One-time setup, pre-filled from a standard template. Review, then confirm — editable anytime.'
                : "Your firm's operating rhythm. Every strategy timeline aligns to it."}
            </div>
            {caption && (
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)', marginTop: 4 }}>
                {caption}
              </div>
            )}
          </div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={iconBtn}>
            <Icon name="x" size={16} color="var(--ink-3)" />
          </button>
        </div>

        <div style={{ padding: '16px 24px', overflow: 'auto' }}>
          <div
            style={{
              display: 'flex',
              fontSize: 'var(--text-2xs)',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--ink-4)',
              padding: '0 4px 8px',
            }}
          >
            <span style={{ width: 40 }}>Order</span>
            <span style={{ flex: 1 }}>Phase name</span>
            <span style={{ width: 200 }}>Runs (quarters)</span>
            <span style={{ width: 30 }} />
          </div>
          {rows.map((p, i) => (
            <div
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 4px',
                borderTop: '1px solid var(--border-1)',
              }}
            >
              <div style={{ width: 40, display: 'flex', flexDirection: 'column', gap: 1 }}>
                <button onClick={() => move(i, -1)} style={stepBtn} title="Move up">
                  ▲
                </button>
                <button onClick={() => move(i, 1)} style={stepBtn} title="Move down">
                  ▼
                </button>
              </div>
              <input
                value={p.label}
                onChange={(e) => set(i, 'label', e.target.value)}
                style={{
                  flex: 1,
                  border: `1px solid ${p.label.trim() ? 'var(--border-2)' : 'var(--critical)'}`,
                  borderRadius: 7,
                  padding: '7px 10px',
                  fontSize: 'var(--text-sm)',
                  fontFamily: 'var(--font-sans)',
                  color: 'var(--ink-1)',
                }}
              />
              <div style={{ width: 200, display: 'flex', alignItems: 'center', gap: 6 }}>
                <select value={p.from} onChange={(e) => set(i, 'from', +e.target.value)} style={sel}>
                  {calendar.quarters.map((q, qi) => (
                    <option key={qi} value={qi}>
                      {q.fy} {q.q}
                    </option>
                  ))}
                </select>
                <span style={{ color: 'var(--ink-4)', fontSize: 'var(--text-xs)' }}>→</span>
                <select
                  value={p.to}
                  onChange={(e) => set(i, 'to', +e.target.value)}
                  style={{
                    ...sel,
                    border: `1px solid ${p.to > p.from ? 'var(--border-2)' : 'var(--critical)'}`,
                  }}
                >
                  {calendar.quarters.map((q, qi) => (
                    <option key={qi} value={qi + 1}>
                      {q.fy} {q.q}
                    </option>
                  ))}
                </select>
              </div>
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
            <Icon name="plus" size={13} color="var(--ink-2)" /> Add phase
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
            Applies firm-wide across all strategies.
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
              {put.isPending ? 'Saving…' : firstRun ? 'Confirm firm phases' : 'Save phases'}
            </button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
