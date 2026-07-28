/*
 * Read-only working timeline (TLN-1..11) — ported from the prototype
 * sp-timeline.jsx `WorkingTimeline`. Months × bands, live 3-FY axis, red Today
 * line, Legislative + PPBE + Firm-phase reference bands, and the strategy's node
 * cards packed into non-overlapping lanes. Click selects a node (highlights its
 * true month span); drag re-times it when onRetime is wired.
 *
 * LAYOUT CONTRACT (Phase 1 §3 Step 7). The frozen label column is NOT a set of
 * sticky cells inside the horizontal scroller any more. The timeline is:
 *
 *   frame (min-width:0, max-width:100%, own stacking context)
 *   └ body (flex row)
 *     ├ label column   — opaque, RAIL wide, full height, z above the grid
 *     └ clip region    — overflow:hidden, begins right of the label column
 *       └ grid scroller — the ONLY horizontal scroller on the page
 *         └ grid column — width = W
 *
 * Both columns render from ONE `RowSpec[]`, so a label row and its grid row can
 * never drift apart: the heights exist in exactly one place. Vertical scrolling
 * belongs to the editor/page, so labels and rows move up and down together.
 *
 * Consequence of owning horizontal scroll here: the reference bands no longer
 * pin vertically (a sticky child of a scroll container resolves to THAT
 * container, and this one has no vertical scroll). Recorded in the phase report.
 *
 * Export (`staticHeader`) renders the same rows with no clip region and no
 * scroller, so html2canvas measures the natural RAIL + W width.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './strategy-ui.js';
import { todayScrollLeft } from './timeline-scroll.js';
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
/** Frozen label-column width (prototype LABELW). */
const RAIL = 176;

// Band heights, measured from the prototype at 1440px. They live here as named
// constants because BOTH columns read them from the row descriptors below.
/** Quarter ruler cell (6px padding + a 20px line box). */
const QUARTER_CELL_H = 32;
/** Month ruler cell (same box as the quarter cell). */
const MONTH_CELL_H = 32;
/** Ruler band = quarter row + its 1px divider + month row. */
const RULER_H = QUARTER_CELL_H + 1 + MONTH_CELL_H;
/** PPBE current-phase summary strip. */
const PPBE_SUMMARY_H = 46;
/** Firm-phase band. */
const FIRM_H = 58;
/** One packed node lane. */
const NODE_H = 92;

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

/**
 * One timeline band. `height` is the CONTENT height (content-box), matching the
 * prototype where the band's border sat on the row wrapper and the grid region
 * carried the height. `height: null` marks the single flexible final row.
 */
interface RowSpec {
  key: string;
  height: number | null;
  minHeight?: string;
  /** Painted in BOTH columns, so the label column is never transparent. */
  bg: string;
  /** Label-cell background when it differs from the grid (Legislative is navy). */
  labelBg?: string;
  labelPad?: string;
  borderTop?: string;
  borderBottom?: string;
  label: React.ReactNode;
  grid: React.ReactNode;
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
  /** Reference/firm editor entry points (G4). Omit to hide the edit links. */
  onEditCongress?: () => void;
  onEditPpbe?: () => void;
  onConfigureFirm?: () => void;
  /** Export crop (EXP-5): render only months [fromM, toM). Omit = full window.
   *  fromM/toM are quarter-aligned month indices (fromQ*3 .. (toQ+1)*3). */
  crop?: { fromM: number; toM: number } | null;
  /** Export (EXP-5): render unclipped at natural width for html2canvas, and
   *  make in-bar labels static (there is no scroll ancestor to stick to). */
  staticHeader?: boolean;
  /**
   * Anchors the one-time "center today" positioning (Step 9). Combined with the
   * rendered month range to form the effect key, so a node edit does not
   * re-centre but opening another strategy does.
   */
  strategyId?: string | null;
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
  onEditCongress,
  onEditPpbe,
  onConfigureFirm,
  crop,
  staticHeader,
  strategyId,
}: TimelineProps) {
  const months = calendar.months;
  const NM = months.length;
  // Crop window (EXP-5): OFF = first visible month, NMv = visible month count.
  // Absent crop → OFF=0, NMv=NM → every derived value below is identical to the
  // live (uncropped) timeline, so the on-screen surface is unaffected.
  const OFF = crop ? crop.fromM : 0;
  const NMv = crop ? crop.toM - crop.fromM : NM;
  const W = NMv * COLW;
  const mLeft = (m: number) => (m - OFF) * COLW;
  const qToMonth = (q: number) => q * 3;
  const inRange = (m: number) => m > OFF - 0.5 && m < OFF + NMv + 0.5;
  // A band's absolute children outside the crop window are clipped (export only).
  const clip = crop ? ('hidden' as const) : undefined;
  // Export has no scroll ancestor, so in-bar labels must not be sticky.
  const isExport = Boolean(staticHeader);
  const labelPos = isExport ? ('static' as const) : ('sticky' as const);
  const inWin = (s: number, e: number) => e > OFF && s < OFF + NMv;
  const TODAY_M = calendar.todayQ * 3;
  const TODAY_MI = Math.floor(TODAY_M);

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

  // ---- Step 9: centre today ONCE per open, after the grid's final measurement -
  // Keyed on the strategy + rendered month range (NOT the nodes), so editing a
  // step never yanks the viewport. A manual scroll or a later resize (e.g. the
  // Meri panel opening) must not re-centre either, hence the one-shot ref.
  const gridScrollRef = useRef<HTMLDivElement>(null);
  const centerKey = `${strategyId ?? ''}:${OFF}:${NMv}`;
  const centeredKeyRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    if (isExport) return;
    const el = gridScrollRef.current;
    if (!el) return;
    if (centeredKeyRef.current === centerKey) return;

    let cancelled = false;
    let frameA = 0;
    let frameB = 0;
    const cancel = () => {
      cancelled = true;
    };

    const apply = () => {
      if (cancelled || centeredKeyRef.current === centerKey) return;
      const viewportWidth = el.clientWidth;
      const contentWidth = el.scrollWidth;
      // Not laid out yet — leave the key unclaimed so the observer retries.
      //
      // `contentWidth < W` is the case that actually bit: mid-layout the
      // scroller can report scrollWidth === clientWidth, which looks like a
      // plan too narrow to scroll. Writing 0 then CLAIMING the key left today
      // permanently off-screen once the grid reached its real width. Waiting
      // for the grid's declared width makes the measurement trustworthy.
      if (viewportWidth <= 0 || contentWidth <= 0) return;
      if (contentWidth + 1 < W) return;
      el.scrollLeft = todayScrollLeft({
        todayX: mLeft(TODAY_M),
        viewportWidth,
        contentWidth,
      });
      centeredKeyRef.current = centerKey;
    };

    // Post-layout double frame: the first frame flushes this render, the second
    // runs once the grid has its final measured width.
    frameA = requestAnimationFrame(() => {
      frameB = requestAnimationFrame(apply);
    });

    // A ResizeObserver covers the case where the width is not final on both
    // frames (lazy panel/zoom/font settle). It only ever fires the pending
    // centring — never a re-centre, because apply() claims the key.
    //
    // It watches the grid COLUMN as well as the scroller: the scroller's own box
    // is sized by the clip region, so a content-width change (0 → W) may resize
    // the child without ever resizing the scroller, and observing only the
    // scroller would miss the very measurement being waited for.
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            apply();
          })
        : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);

    el.addEventListener('wheel', cancel, { passive: true });
    el.addEventListener('pointerdown', cancel, { passive: true });

    return () => {
      cancelAnimationFrame(frameA);
      cancelAnimationFrame(frameB);
      ro?.disconnect();
      el.removeEventListener('wheel', cancel);
      el.removeEventListener('pointerdown', cancel);
    };
    // mLeft is a pure function of OFF/COLW, and OFF/NMv (hence W) are both in
    // the dep list via centerKey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerKey, isExport, TODAY_M, W]);

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
        left: mLeft(0),
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
  /** Every band paints the same overlay stack behind its own content. */
  const overlays = (
    <>
      {pastShade}
      {grid}
      {hoverBand}
      {pinBand}
      {selBand}
    </>
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
  // Inline "edit" affordance in a band label (prototype railSub); only shown
  // when an editor callback is wired (G4).
  const railSub = (label: string, onClick?: () => void) =>
    onClick ? (
      <span
        onClick={onClick}
        style={{
          fontSize: 'var(--text-2xs)',
          color: 'var(--accent)',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {label}
      </span>
    ) : null;

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
  const [ppbeExpanded, setPpbeExpanded] = useState(false);

  // =========================================================================
  // Row descriptors — the single source of truth for both columns' geometry.
  // =========================================================================
  const rows: RowSpec[] = [];

  if (layers.congress) {
    rows.push({
      key: 'legislative',
      height: legH,
      bg: 'var(--bg-sunken)',
      labelBg: 'var(--bg-dark)',
      borderBottom: '3px solid var(--bg-dark)',
      label: (
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
            <span style={{ width: 9, height: 9, borderRadius: 2, background: 'var(--accent)' }} />
            Legislative calendar
          </span>
          {onEditCongress && (
            <span
              onClick={onEditCongress}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                fontSize: 'var(--text-2xs)',
                color: 'rgba(245,242,235,0.72)',
                fontWeight: 600,
                cursor: 'pointer',
                marginTop: 9,
              }}
            >
              <Icon name="edit" size={11} color="rgba(245,242,235,0.72)" />
              Edit calendar
            </span>
          )}
        </>
      ),
      grid: (
        <>
          {overlays}
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
                <span style={{ position: labelPos, left: 10, padding: '0 13px', whiteSpace: 'nowrap' }}>
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
                    style={{ display: 'block', fontSize: 'var(--text-base)', fontWeight: 700, color: c.fg }}
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
                // Phase 7 §7: same inherited-line-height bug as the header
                // eyebrow — antd's 1.5714 made this flag 16.15px tall where
                // the prototype's is 13.94px.
                lineHeight: 'normal',
                padding: '2px 8px',
                borderRadius: 5,
                whiteSpace: 'nowrap',
                zIndex: 7,
              }}
            >
              TODAY · {calendar.todayLabel}
            </div>
          )}
        </>
      ),
    });
  }

  rows.push({
    key: 'ruler',
    height: RULER_H,
    bg: 'var(--bg-sunken)',
    borderBottom: '2px solid var(--border-strong)',
    label: (
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
      </span>
    ),
    grid: (
      <>
        <div
          style={{
            display: 'flex',
            height: QUARTER_CELL_H,
            boxSizing: 'content-box',
            borderBottom: '1px solid var(--border-2)',
          }}
        >
          {calendar.quarters
            .map((q, qi) => ({ q, qi }))
            .filter(({ qi }) => !crop || (qi * 3 >= OFF && qi * 3 < OFF + NMv))
            .map(({ q, qi }) => {
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
                    height: '100%',
                    boxSizing: 'border-box',
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
        <div style={{ display: 'flex', height: MONTH_CELL_H, boxSizing: 'content-box' }}>
          {months
            .map((mo, i) => ({ mo, i }))
            .filter(({ i }) => !crop || (i >= OFF && i < OFF + NMv))
            .map(({ mo, i }) => {
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
                    height: '100%',
                    boxSizing: 'border-box',
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
      </>
    ),
  });

  if (layers.ppbe) {
    rows.push({
      key: 'ppbe-summary',
      height: PPBE_SUMMARY_H,
      bg: PPBE_BG,
      borderBottom: ppbeExpanded ? '1px solid var(--border-1)' : '1px solid var(--border-2)',
      label: (
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
          <div style={{ display: 'flex', gap: 10 }}>
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
            {railSub('Edit', onEditPpbe)}
          </div>
        </>
      ),
      grid: (
        <>
          {overlays}
          {todayLine}
          <div
            style={{
              position: 'relative',
              zIndex: 2,
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 12px',
            }}
          >
            {ppbeCurrentPhases.map((r) => (
              <div
                key={r.id}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  flexShrink: 0,
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
        </>
      ),
    });

    if (ppbeExpanded) {
      for (const [fy, bars] of ppbeByFy.entries()) {
        const its = packSpans(
          bars.map((b) => ({
            row: b,
            s: qToMonth(refQ(b.startsOn)),
            e: qToMonth(refQ(b.endsOn)),
          })),
          1.5,
        );
        rows.push({
          key: `ppbe-lane-${fy}`,
          height: its.rows * 32 + 8,
          bg: PPBE_BG,
          labelPad: '0 16px 0 34px',
          borderBottom: '1px solid var(--border-1)',
          label: (
            <span
              style={{
                fontSize: 'var(--text-sm)',
                fontFamily: 'var(--font-mono)',
                fontWeight: 700,
                color: 'var(--ink-2)',
              }}
            >
              FY{String(fy).slice(2)}
            </span>
          ),
          grid: (
            <>
              {overlays}
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
                      position: labelPos,
                      left: 8,
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
            </>
          ),
        });
      }
    }
  }

  rows.push({
    key: 'firm',
    height: FIRM_H,
    bg: 'var(--bg-surface)',
    borderTop: '1px solid var(--border-1)',
    borderBottom: '2px solid var(--border-strong)',
    label: (
      <>
        {railTitle('Firm phase')}
        {railSub('Configure', onConfigureFirm)}
      </>
    ),
    grid: (
      <>
        {overlays}
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
              position: labelPos,
              left: 12,
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
      </>
    ),
  });

  // The one flexible row: it absorbs any leftover frame height in BOTH columns,
  // which is what paints the label column all the way to the bottom.
  rows.push({
    key: 'nodes',
    height: null,
    minHeight: `max(${packedNodes.rows * NODE_H + 40}px, 72vh)`,
    bg: 'var(--bg-surface)',
    labelPad: '14px 16px',
    label: railTitle('This strategy'),
    grid: (
      <>
        {overlays}
        {todayLine}
        <div
          style={{
            position: 'relative',
            zIndex: 2,
            display: 'grid',
            gridTemplateColumns: `repeat(${NMv}, ${COLW}px)`,
            gridAutoRows: 'min-content',
            rowGap: 10,
            padding: '12px 0',
            alignContent: 'start',
          }}
        >
          {packedNodes.items
            .filter(({ s, e }) => inWin(s, e))
            .map(({ node: n, s, e, _row }) => {
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
              // Crop-relative grid columns, clamped so a node straddling the
              // crop start never yields a non-positive column (OFF=0 ⇒ s+1/e+1).
              const cS = Math.max(1, s - OFF + 1);
              const cE = Math.max(cS + 1, e - OFF + 1);
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
                    gridColumn: `${cS} / ${cE}`,
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
                  {/* Phase 5 §6: a small, calm inline marker — never a full
                      card — on exactly the steps a context gap still affects.
                      Clears the moment the gap resolves (server-driven, not a
                      local dismiss). */}
                  {n.provenance?.contextNeeds && n.provenance.contextNeeds.length > 0 && (
                    <div
                      role="status"
                      title={`Needs context: ${n.provenance.contextNeeds.map((c) => c.label).join(', ')}`}
                      aria-label={`Needs context: ${n.provenance.contextNeeds.map((c) => c.label).join(', ')}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        marginTop: 4,
                        fontSize: 9.5,
                        fontWeight: 800,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        color: 'var(--notable)',
                        background: 'var(--notable-soft)',
                        borderRadius: 5,
                        padding: '2px 6px',
                      }}
                    >
                      needs context
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </>
    ),
  });

  // =========================================================================
  // Render: label column + clip region, both driven by `rows`.
  // =========================================================================
  /** Shared box for one row in either column — the anti-drift guarantee. */
  const rowBox = (r: RowSpec): React.CSSProperties => ({
    boxSizing: 'content-box',
    height: r.height ?? undefined,
    minHeight: r.minHeight,
    flex: r.height === null ? '1 1 auto' : '0 0 auto',
    background: r.bg,
    borderTop: r.borderTop,
    borderBottom: r.borderBottom,
  });

  const labelColumn = (
    <div
      data-testid="sp-timeline-labels"
      style={{
        width: RAIL,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        // Own stacking context, above every bar, grid cell and today marker.
        position: 'relative',
        zIndex: 2,
        isolation: 'isolate',
        background: 'var(--bg-surface)',
        borderRight: '1px solid var(--border-strong)',
        boxShadow: '3px 0 8px -3px rgba(12,26,56,0.10)',
      }}
    >
      {rows.map((r) => (
        <div
          key={r.key}
          style={{
            ...rowBox(r),
            background: r.labelBg ?? r.bg,
            padding: r.labelPad ?? '0 16px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 3,
            overflow: 'hidden',
          }}
        >
          {r.label}
        </div>
      ))}
    </div>
  );

  const gridColumn = (
    // flex:1 so the flexible last row absorbs leftover height exactly as the
    // label column's does. Without it the label column stretches to the frame
    // (which carries minHeight:100%) while the grid column stops at its natural
    // height, and the two drift apart at the bottom — measured 676px vs 648px.
    <div
      style={{
        width: W,
        display: 'flex',
        flexDirection: 'column',
        flex: isExport ? undefined : '1 1 auto',
      }}
    >
      {rows.map((r) => (
        <div key={r.key} style={{ ...rowBox(r), position: 'relative', overflow: clip }}>
          {r.grid}
        </div>
      ))}
    </div>
  );

  return (
    <div
      data-testid="sp-timeline-frame"
      style={{
        border: '1px solid var(--border-strong)',
        borderRadius: 12,
        background: 'var(--bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        maxWidth: isExport ? undefined : '100%',
        minHeight: '100%',
        // A new stacking context, so nothing inside can paint over the frame's
        // siblings and the label column's z-index is resolved locally.
        position: 'relative',
        isolation: 'isolate',
        overflow: isExport ? 'visible' : 'hidden',
      }}
    >
      <div
        onClick={() => setPin(null)}
        style={{ display: 'flex', flex: 1, minWidth: 0, alignItems: 'stretch' }}
      >
        {labelColumn}
        {isExport ? (
          gridColumn
        ) : (
          // Clip region: starts immediately right of the label column, never
          // offset negatively, and hides anything the scroller lets escape.
          <div
            data-testid="sp-timeline-clip"
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              position: 'relative',
              zIndex: 1,
              // Column flex so the scroller — and through it the grid column —
              // stretches to the same height the label column gets.
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div
              ref={gridScrollRef}
              data-testid="sp-timeline-grid-scroller"
              style={{
                overflowX: 'auto',
                overflowY: 'hidden',
                flex: '1 1 auto',
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {gridColumn}
            </div>
          </div>
        )}
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
