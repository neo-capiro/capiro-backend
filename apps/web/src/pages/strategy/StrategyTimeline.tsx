/*
 * Read-only working timeline (TLN-1..11) — ported from the prototype
 * sp-timeline.jsx `WorkingTimeline`. Months × bands, sticky label rail, live
 * 3-FY axis, red Today line, Legislative + PPBE + Firm-phase reference bands,
 * and the strategy's node cards packed into non-overlapping lanes. G2 is
 * READ-ONLY: click selects a node (highlights its true month span); drag-retime
 * and node editing arrive in G3.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from './strategy-ui.js';
import {
  qOfDate,
  fyQuarterToQ,
  monthRangeLabel,
  nodeRangeLabel,
  parseDbDate,
  shiftNodeMonths,
  type FiscalCalendar,
} from './fiscal.js';
import type { FirmPhase, ReferenceRow, StrategyNode } from './types.js';
import { NODE_KIND_META as NODE_KIND } from './constants.js';

const COLW = 100;
const LABELW = 176;

const tint = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

function legColor(label: string): { bg: string; fg: string } {
  if (/markup|final bills/i.test(label)) return { bg: 'var(--success)', fg: '#fff' };
  if (/continuing resolution/i.test(label)) return { bg: 'var(--critical)', fg: '#fff' };
  return { bg: 'var(--bg-dark)', fg: 'var(--ink-on-dark)' };
}
const PPBE_C = '#4E6072';
const PPBE_BG = '#E8ECEF';

interface Span {
  s: number;
  e: number;
  _row: number;
  _packEnd: number;
}
function packSpans<T>(
  items: Array<T & { s: number; e: number }>,
  minSpan = 0,
): { items: Array<T & Span>; rows: number } {
  const rowEnd: number[] = [];
  const sorted = [...items].sort((a, b) => a.s - b.s) as Array<T & Span>;
  sorted.forEach((it) => {
    const end = Math.max(it.e, it.s + minSpan);
    it._packEnd = end;
    let r = rowEnd.findIndex((x) => it.s >= x);
    if (r === -1) {
      r = rowEnd.length;
      rowEnd.push(0);
    }
    it._row = r;
    rowEnd[r] = end;
  });
  return { items: sorted, rows: Math.max(1, rowEnd.length) };
}

export interface TimelineProps {
  calendar: FiscalCalendar;
  nodes: StrategyNode[];
  congress: ReferenceRow[];
  ppbeLanes: ReferenceRow[];
  ppbeCurrentPhases: ReferenceRow[];
  firmPhases: FirmPhase[];
  layers: { ppbe: boolean; congress: boolean };
  selectedId: string | null;
  onSelectNode: (id: string) => void;
  /** Persist a drag-retimed node (TLN-12). Omit for read-only surfaces. */
  onRetime?: (nodeId: string, startsOn: string, endsOn: string | null, title: string) => void;
}

export function StrategyTimeline({
  calendar,
  nodes,
  congress,
  ppbeLanes,
  ppbeCurrentPhases,
  firmPhases,
  layers,
  selectedId,
  onSelectNode,
  onRetime,
}: TimelineProps) {
  const months = calendar.months;
  const NM = months.length;
  const W = NM * COLW;
  const mLeft = (m: number) => m * COLW;
  const qToMonth = (q: number) => q * 3;
  const inRange = (m: number) => m > -0.5 && m < NM + 0.5;
  const TODAY_M = calendar.todayQ * 3;
  const TODAY_MI = Math.floor(TODAY_M);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<[number, number] | null>(null);
  const [pin, setPin] = useState<[number, number] | null>(null);
  const togglePin = (a: number, b: number) =>
    setPin((p) => (p && p[0] === a && p[1] === b ? null : [a, b]));

  // ---- drag-to-retime (TLN-12) — only when onRetime is provided ----
  const [drag, setDrag] = useState<{ nodeId: string; dx: number } | null>(null);
  const dragRef = useRef<{ nodeId: string; startX: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const dragActive = drag !== null;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const target = (el.closest('[data-sp-scroll]') as HTMLElement) || el;
    target.scrollLeft = Math.max(0, mLeft(TODAY_M) - COLW * 1.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!dragActive) return;
    const onMove = (e: MouseEvent) => {
      const st = dragRef.current;
      if (!st) return;
      const dx = e.clientX - st.startX;
      if (Math.abs(dx) > 4) st.moved = true;
      setDrag((prev) => (prev ? { nodeId: prev.nodeId, dx } : prev));
    };
    const onUp = (e: MouseEvent) => {
      const st = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!st) return;
      if (!st.moved) return; // a click, not a drag — onClick selects
      // Suppress the synthetic click that follows this drag-release, but clear
      // the flag on the next tick so a release that lands off-card never eats a
      // later legitimate card click.
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      const deltaMonths = Math.round((e.clientX - st.startX) / COLW);
      if (deltaMonths === 0 || !onRetime) return;
      const node = nodes.find((nn) => nn.id === st.nodeId);
      if (!node) return;
      const shifted = shiftNodeMonths(node.startsOn, node.endsOn, deltaMonths, calendar);
      if (shifted.applied !== 0) {
        onRetime(st.nodeId, shifted.startsOn, shifted.endsOn, node.title);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragActive, nodes, calendar, onRetime]);

  // ---- q helpers for real (date-backed) rows ----
  // @db.Date values arrive as UTC-midnight ISO; parseDbDate preserves the
  // calendar day (local getters would shift it west of UTC).
  const nodeQ = (n: StrategyNode) => qOfDate(parseDbDate(n.startsOn), calendar);
  const nodeDur = (n: StrategyNode) =>
    n.endsOn ? Math.max(0, qOfDate(parseDbDate(n.endsOn), calendar) - nodeQ(n)) : 0;
  const refQ = (iso: string | null) => (iso ? qOfDate(parseDbDate(iso), calendar) : 0);

  // ---- shared grid overlays ----
  const quarterShade = calendar.quarters.map((q, qi) => {
    const s = qi * 3;
    if (qi % 2 !== 1) return null;
    return (
      <div
        key={'qs' + qi}
        style={{
          position: 'absolute',
          left: mLeft(s),
          top: 0,
          bottom: 0,
          width: COLW * 3,
          background: 'rgba(42,87,206,0.06)',
          pointerEvents: 'none',
        }}
      />
    );
  });
  const monthLines = months.map((mo, i) => {
    const qb = i % 3 === 0;
    return (
      <div
        key={'ml' + i}
        style={{
          position: 'absolute',
          left: mLeft(i),
          top: 0,
          bottom: 0,
          width: mo.fyStart ? 2 : qb ? 1.5 : 1,
          background: mo.fyStart
            ? 'var(--border-strong)'
            : qb
              ? 'var(--border-2)'
              : 'var(--border-1)',
        }}
      />
    );
  });
  const grid = [...quarterShade, ...monthLines];
  const pastShade = (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        bottom: 0,
        width: Math.max(0, TODAY_M) * COLW,
        background: 'rgba(21,22,26,0.025)',
        pointerEvents: 'none',
      }}
    />
  );
  const hoverBand = hover ? (
    <div
      style={{
        position: 'absolute',
        left: mLeft(hover[0]),
        top: 0,
        bottom: 0,
        width: (hover[1] - hover[0]) * COLW,
        background: 'rgba(42,87,206,0.07)',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    />
  ) : null;
  const pinBand = pin ? (
    <div
      style={{
        position: 'absolute',
        left: mLeft(pin[0]),
        top: 0,
        bottom: 0,
        width: (pin[1] - pin[0]) * COLW,
        background: 'rgba(42,87,206,0.10)',
        borderLeft: '2px solid var(--accent)',
        borderRight: '2px solid var(--accent)',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    />
  ) : null;
  const todayLine = inRange(TODAY_M) ? (
    <div
      style={{
        position: 'absolute',
        left: mLeft(TODAY_M),
        top: 0,
        bottom: 0,
        width: 2,
        background: 'var(--critical)',
        zIndex: 6,
        pointerEvents: 'none',
      }}
    />
  ) : null;
  const selNode = nodes.find((n) => n.id === selectedId);
  const selR = selNode
    ? [
        Math.floor(qToMonth(nodeQ(selNode))),
        Math.max(
          Math.floor(qToMonth(nodeQ(selNode))) + 1,
          Math.ceil(qToMonth(nodeQ(selNode) + nodeDur(selNode))),
        ),
      ]
    : null;
  const selBand = selR ? (
    <div
      style={{
        position: 'absolute',
        left: mLeft(selR[0]!),
        top: 0,
        bottom: 0,
        width: (selR[1]! - selR[0]!) * COLW,
        background: 'rgba(42,87,206,0.13)',
        borderLeft: '2px solid var(--accent)',
        borderRight: '2px solid var(--accent)',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    />
  ) : null;

  const rail = (content: React.ReactNode, opts: { bg?: string; pad?: string } = {}) => (
    <div
      style={{
        width: LABELW,
        flexShrink: 0,
        padding: opts.pad ?? '0 16px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 3,
        borderRight: '1px solid var(--border-strong)',
        background: opts.bg ?? 'var(--bg-surface)',
        position: 'sticky',
        left: 0,
        zIndex: 7,
        boxShadow: '3px 0 8px -3px rgba(12,26,56,0.10)',
      }}
    >
      {content}
    </div>
  );
  const railTitle = (t: string) => (
    <span
      style={{
        fontSize: 'var(--text-md)',
        fontWeight: 800,
        textTransform: 'uppercase',
        letterSpacing: '0.03em',
        color: 'var(--ink-1)',
      }}
    >
      {t}
    </span>
  );

  // ---- Legislative band ----
  const legItems = congress.map((c) => ({
    row: c,
    s: qToMonth(refQ(c.startsOn)),
    e: qToMonth(refQ(c.endsOn)),
  }));
  const leg = packSpans(legItems, 1.9);
  const legH = leg.rows * 50 + 12;

  // ---- Firm phases ----
  const firmItems = firmPhases.map((p) => ({
    row: p,
    s: qToMonth(fyQuarterToQ(p.startFy, p.startQ, calendar)),
    e: qToMonth(fyQuarterToQ(p.endFy, p.endQ, calendar)),
  }));

  // ---- PPBE lanes (grouped by fy) ----
  const ppbeByFy = new Map<number, ReferenceRow[]>();
  for (const b of ppbeLanes) {
    const fy = b.fy ?? 0;
    ppbeByFy.set(fy, [...(ppbeByFy.get(fy) ?? []), b]);
  }

  // ---- Nodes ----
  const nodeItems = nodes.map((n) => {
    const s = qToMonth(nodeQ(n));
    const span = Math.max(2, Math.round(nodeDur(n) * 3));
    return { node: n, s: Math.round(s), e: Math.round(s) + span };
  });
  const packedNodes = packSpans(nodeItems);
  const NODE_H = 92;
  const [ppbeExpanded, setPpbeExpanded] = useState(false);

  return (
    <div
      style={{
        border: '1px solid var(--border-strong)',
        borderRadius: 12,
        overflow: 'visible',
        background: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        ref={scrollRef}
        onClick={() => setPin(null)}
        style={{ overflow: 'visible', position: 'relative' }}
      >
        <div
          style={{
            minWidth: LABELW + W,
            position: 'relative',
            minHeight: '100%',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Frozen reference header — the prototype WorkingTimeline wraps
              every band above "This strategy" in a sticky box so they pin while
              the node track scrolls. StrategyView passes expand (overflow
              visible) with staticHeader undefined, so position resolves to
              sticky and the header sticks to the outer [data-sp-scroll]. */}
          <div style={{ position: 'sticky', top: 0, zIndex: 8 }}>
          {/* Legislative */}
          {layers.congress && (
            <div style={{ display: 'flex', borderBottom: '3px solid var(--bg-dark)' }}>
              {rail(
                <>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 'var(--text-md)',
                      fontWeight: 800,
                      color: 'var(--ink-on-dark)',
                      letterSpacing: '-0.01em',
                    }}
                  >
                    <span
                      style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--accent)' }}
                    />
                    Legislative calendar
                  </span>
                </>,
                { bg: 'var(--bg-dark)' },
              )}
              <div
                style={{
                  position: 'relative',
                  width: W,
                  height: legH,
                  background: 'var(--bg-sunken)',
                }}
              >
                {pastShade}
                {grid}
                {hoverBand}
                {pinBand}
                {selBand}
                {leg.items.map((b, i) => {
                  const c = legColor(b.row.label);
                  return (
                    <div
                      key={i}
                      title={b.row.label}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePin(Math.floor(b.s), Math.max(Math.floor(b.s) + 1, Math.ceil(b.e)));
                      }}
                      style={{
                        position: 'absolute',
                        left: mLeft(b.s) + 4,
                        width: (b._packEnd - b.s) * COLW - 8,
                        top: b._row * 50 + 7,
                        height: 44,
                        background: c.bg,
                        borderRadius: 8,
                        cursor: 'pointer',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        overflow: 'hidden',
                        zIndex: 2,
                        boxShadow: '0 1px 3px rgba(12,26,56,0.12)',
                      }}
                    >
                      <span
                        style={{
                          position: 'sticky',
                          left: LABELW + 10,
                          padding: '0 13px',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <span
                          style={{
                            display: 'block',
                            fontSize: 'var(--text-2xs)',
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                            color: c.fg,
                            opacity: 0.7,
                            textTransform: 'uppercase',
                          }}
                        >
                          {monthRangeLabel(b.s, b.e, calendar)}
                        </span>
                        <span
                          style={{
                            display: 'block',
                            fontSize: 'var(--text-base)',
                            fontWeight: 700,
                            color: c.fg,
                          }}
                        >
                          {b.row.label}
                        </span>
                      </span>
                    </div>
                  );
                })}
                {todayLine}
                {inRange(TODAY_M) && (
                  <div
                    style={{
                      position: 'absolute',
                      left: mLeft(TODAY_M),
                      top: 3,
                      transform: 'translateX(-50%)',
                      background: 'var(--critical)',
                      color: '#fff',
                      fontSize: 'var(--text-2xs)',
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 5,
                      whiteSpace: 'nowrap',
                      zIndex: 7,
                    }}
                  >
                    TODAY · {calendar.todayLabel}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Quarter · month ruler */}
          <div style={{ display: 'flex', borderBottom: '2px solid var(--border-strong)' }}>
            {rail(
              <span
                style={{
                  fontSize: 'var(--text-2xs)',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--ink-3)',
                }}
              >
                Quarter · month
              </span>,
              { bg: 'var(--bg-sunken)' },
            )}
            <div style={{ position: 'relative', width: W, background: 'var(--bg-sunken)' }}>
              <div style={{ display: 'flex', borderBottom: '1px solid var(--border-2)' }}>
                {calendar.quarters.map((q, qi) => {
                  const s = qi * 3;
                  const cur = TODAY_M >= s && TODAY_M < s + 3;
                  const pinned = !!pin && pin[0] === s && pin[1] === s + 3;
                  return (
                    <div
                      key={qi}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePin(s, s + 3);
                      }}
                      style={{
                        width: COLW * 3,
                        padding: '6px 12px',
                        borderRight: '1px solid var(--border-strong)',
                        cursor: 'pointer',
                        background: pinned
                          ? 'rgba(42,87,206,0.14)'
                          : cur
                            ? 'rgba(42,87,206,0.06)'
                            : 'transparent',
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'center',
                        gap: 7,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 'var(--text-md)',
                          fontWeight: 800,
                          fontFamily: 'var(--font-mono)',
                          color: cur ? 'var(--accent-ink)' : 'var(--ink-1)',
                        }}
                      >
                        {q.q}
                      </span>
                      <span
                        style={{
                          fontSize: 'var(--text-xs)',
                          fontWeight: 700,
                          color: 'var(--accent)',
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        {q.fy}
                      </span>
                      {cur && (
                        <span
                          style={{
                            fontSize: 'var(--text-2xs)',
                            color: 'var(--critical)',
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.04em',
                          }}
                        >
                          Current
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex' }}>
                {months.map((mo, i) => {
                  const past = i < TODAY_MI;
                  const pinned = !!pin && i >= pin[0] && i < pin[1];
                  return (
                    <div
                      key={i}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePin(i, i + 1);
                      }}
                      style={{
                        width: COLW,
                        padding: '6px 12px',
                        borderRight: '1px solid var(--border-1)',
                        borderLeft: mo.fyStart ? '1px solid var(--border-strong)' : 'none',
                        cursor: 'pointer',
                        background: pinned ? 'rgba(42,87,206,0.10)' : 'transparent',
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'center',
                        gap: 5,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 'var(--text-md)',
                          fontWeight: 700,
                          color: past
                            ? 'var(--ink-4)'
                            : i === TODAY_MI
                              ? 'var(--critical)'
                              : 'var(--ink-1)',
                        }}
                      >
                        {mo.m}
                      </span>
                      <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-4)' }}>
                        {mo.cal.slice(2)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* PPBE */}
          {layers.ppbe && (
            <div
              style={{
                display: 'flex',
                borderBottom: ppbeExpanded ? '1px solid var(--border-1)' : '1px solid var(--border-2)',
              }}
            >
              {rail(
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      onClick={() => setPpbeExpanded((v) => !v)}
                      style={{
                        cursor: 'pointer',
                        display: 'grid',
                        transform: ppbeExpanded ? 'rotate(90deg)' : 'none',
                      }}
                    >
                      <Icon name="chevron" size={13} color="var(--ink-2)" />
                    </span>
                    {railTitle('PPBE')}
                  </div>
                  <span
                    onClick={() => setPpbeExpanded((v) => !v)}
                    style={{
                      fontSize: 'var(--text-2xs)',
                      color: 'var(--accent)',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {ppbeExpanded ? 'Collapse' : 'Expand cycles'}
                  </span>
                </>,
                { bg: PPBE_BG },
              )}
              <div
                style={{
                  position: 'relative',
                  width: W,
                  minHeight: 46,
                  background: PPBE_BG,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 12px',
                }}
              >
                {pastShade}
                {grid}
                {hoverBand}
                {pinBand}
                {selBand}
                {todayLine}
                {ppbeCurrentPhases.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      position: 'relative',
                      zIndex: 2,
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                      background: '#fff',
                      border: `1px solid ${tint(PPBE_C, 0.4)}`,
                      borderLeft: `3px solid ${PPBE_C}`,
                      borderRadius: 6,
                      padding: '5px 11px',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 'var(--text-sm)',
                        fontWeight: 700,
                        color: 'var(--ink-1)',
                      }}
                    >
                      FY{String(r.fy ?? '').slice(2)}
                    </span>
                    <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: PPBE_C }}>
                      {r.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {layers.ppbe &&
            ppbeExpanded &&
            [...ppbeByFy.entries()].map(([fy, bars]) => {
              const its = packSpans(
                bars.map((b) => ({
                  row: b,
                  s: qToMonth(refQ(b.startsOn)),
                  e: qToMonth(refQ(b.endsOn)),
                })),
                1.5,
              );
              return (
                <div
                  key={fy}
                  style={{ display: 'flex', borderBottom: '1px solid var(--border-1)' }}
                >
                  {rail(
                    <span
                      style={{
                        fontSize: 'var(--text-sm)',
                        fontFamily: 'var(--font-mono)',
                        fontWeight: 700,
                        color: 'var(--ink-2)',
                      }}
                    >
                      FY{String(fy).slice(2)}
                    </span>,
                    { bg: PPBE_BG, pad: '0 16px 0 34px' },
                  )}
                  <div
                    style={{
                      position: 'relative',
                      width: W,
                      height: its.rows * 32 + 8,
                      background: PPBE_BG,
                    }}
                  >
                    {pastShade}
                    {grid}
                    {hoverBand}
                    {pinBand}
                    {selBand}
                    {todayLine}
                    {its.items.map((b, i) => (
                      <div
                        key={i}
                        title={b.row.label}
                        style={{
                          position: 'absolute',
                          left: mLeft(b.s) + 4,
                          width: (b._packEnd - b.s) * COLW - 8,
                          top: b._row * 32 + 4,
                          height: 24,
                          background: '#fff',
                          border: `1px solid ${tint(PPBE_C, 0.4)}`,
                          borderLeft: `3px solid ${PPBE_C}`,
                          borderRadius: 5,
                          display: 'flex',
                          alignItems: 'center',
                          overflow: 'hidden',
                          zIndex: 2,
                        }}
                      >
                        <span
                          style={{
                            position: 'sticky',
                            left: LABELW + 8,
                            padding: '0 9px',
                            whiteSpace: 'nowrap',
                            fontSize: 'var(--text-2xs)',
                            fontWeight: 700,
                            color: PPBE_C,
                          }}
                        >
                          {b.row.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

          {/* Firm phase */}
          <div
            style={{
              display: 'flex',
              borderTop: '1px solid var(--border-1)',
              borderBottom: '2px solid var(--border-strong)',
            }}
          >
            {rail(<>{railTitle('Firm phase')}</>, { bg: 'var(--bg-surface)' })}
            <div
              style={{
                position: 'relative',
                width: W,
                height: 58,
                background: 'var(--bg-surface)',
              }}
            >
              {pastShade}
              {grid}
              {hoverBand}
              {pinBand}
              {selBand}
              {firmItems.map((p) => {
                const isCur = TODAY_M >= p.s && TODAY_M < p.e;
                return (
                  <div
                    key={p.row.id}
                    title={p.row.label}
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePin(Math.floor(p.s), Math.max(Math.floor(p.s) + 1, Math.ceil(p.e)));
                    }}
                    style={{
                      position: 'absolute',
                      left: mLeft(p.s) + 5,
                      width: (p.e - p.s) * COLW - 10,
                      top: 10,
                      height: 38,
                      background: isCur ? 'var(--accent)' : 'var(--accent-soft)',
                      borderRadius: 8,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      padding: '0 10px',
                      zIndex: 2,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 'var(--text-sm)',
                        fontWeight: 700,
                        color: isCur ? '#fff' : 'var(--accent-ink)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {p.row.label}
                    </span>
                  </div>
                );
              })}
              {todayLine}
              {firmItems.length === 0 && (
                <span
                  style={{
                    position: 'sticky',
                    left: LABELW + 12,
                    top: 20,
                    fontSize: 'var(--text-xs)',
                    color: 'var(--ink-4)',
                    display: 'inline-block',
                    padding: '20px 0',
                  }}
                >
                  Firm phases not configured yet.
                </span>
              )}
            </div>
          </div>
          </div>
          {/* end frozen reference header */}

          {/* This strategy (nodes) */}
          <div style={{ display: 'flex', flex: 1, background: 'var(--bg-surface)' }}>
            {rail(<>{railTitle('This strategy')}</>, { pad: '14px 16px' })}
            <div
              style={{
                position: 'relative',
                width: W,
                flex: 1,
                minHeight: `max(${packedNodes.rows * NODE_H + 40}px, 72vh)`,
              }}
            >
              {pastShade}
              {grid}
              {hoverBand}
              {pinBand}
              {selBand}
              {todayLine}
              <div
                style={{
                  position: 'relative',
                  zIndex: 2,
                  display: 'grid',
                  gridTemplateColumns: `repeat(${NM}, ${COLW}px)`,
                  gridAutoRows: 'min-content',
                  rowGap: 10,
                  padding: '12px 0',
                  alignContent: 'start',
                }}
              >
                {packedNodes.items.map(({ node: n, s, e, _row }) => {
                  const k = NODE_KIND[n.kind];
                  const sel = selectedId === n.id;
                  const risk = n.kind === 'risk';
                  const dashed = n.meriAuthored && n.status === 'suggested';
                  const tS = Math.floor(qToMonth(nodeQ(n)));
                  const tE = Math.max(tS + 1, Math.ceil(qToMonth(nodeQ(n) + nodeDur(n))));
                  const eyebrow =
                    (n.meriAuthored ? 'MERI · ' : '') +
                    k.label.toUpperCase() +
                    ' · ' +
                    nodeRangeLabel(nodeQ(n), nodeQ(n) + nodeDur(n), calendar);
                  const isDragging = drag?.nodeId === n.id;
                  const dragDx = isDragging && drag ? Math.round(drag.dx / COLW) * COLW : 0;
                  return (
                    <div
                      key={n.id}
                      onMouseDown={
                        onRetime
                          ? (ev) => {
                              if (ev.button !== 0) return;
                              ev.preventDefault();
                              dragRef.current = { nodeId: n.id, startX: ev.clientX, moved: false };
                              setDrag({ nodeId: n.id, dx: 0 });
                            }
                          : undefined
                      }
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (suppressClick.current) {
                          suppressClick.current = false;
                          return;
                        }
                        onSelectNode(n.id);
                      }}
                      onMouseEnter={() => setHover([tS, tE])}
                      onMouseLeave={() => setHover(null)}
                      style={{
                        gridColumn: `${s + 1} / ${e + 1}`,
                        gridRow: _row + 1,
                        margin: '0 6px',
                        background: risk ? 'var(--critical-soft)' : 'var(--bg-surface)',
                        border: `${sel ? 1.5 : 1}px ${dashed ? 'dashed' : 'solid'} ${sel ? k.color : risk ? tint('#B5301B', 0.4) : 'var(--border-2)'}`,
                        borderRadius: 9,
                        padding: '10px 13px',
                        cursor: onRetime ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
                        transform: dragDx ? `translateX(${dragDx}px)` : undefined,
                        transition: isDragging ? 'none' : 'transform 0.12s',
                        zIndex: isDragging ? 5 : undefined,
                        boxShadow: sel
                          ? '0 6px 18px rgba(12,26,56,0.16)'
                          : '0 1px 2px rgba(12,26,56,0.05)',
                      }}
                    >
                      <div
                        style={{
                          fontSize: 'var(--text-2xs)',
                          fontWeight: 800,
                          letterSpacing: '0.05em',
                          textTransform: 'uppercase',
                          color: k.ink,
                          marginBottom: 4,
                        }}
                      >
                        {eyebrow}
                      </div>
                      <div
                        style={{
                          fontSize: 'var(--text-md)',
                          fontWeight: 600,
                          color: 'var(--ink-1)',
                          lineHeight: 1.3,
                        }}
                      >
                        {n.title}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div
        style={{
          padding: '8px 16px',
          borderTop: '1px solid var(--border-1)',
          background: 'var(--bg-surface-2)',
          fontSize: 'var(--text-2xs)',
          color: 'var(--ink-3)',
        }}
      >
        Nodes sit in the window where they act. The legislative band is shared; the firm-phase band
        is this firm's own cycle. Everything left of{' '}
        <b style={{ color: 'var(--critical)' }}>today</b> is due-or-done.
      </div>
    </div>
  );
}
