export interface LegEvent {
  /** ISO date string. */
  date: string;
  label: string;
  /** Short identifier shown as the node title (e.g. a bill ref). */
  num?: string;
  /** intro | report | markup | pass | law — drives the node color. */
  kind: string;
}

export interface LegTimelineProps {
  events: LegEvent[];
}

const KIND_COLOR: Record<string, string> = {
  intro: '#8A8780',
  report: '#2C5BD4',
  markup: '#A26913',
  pass: '#2A57CE',
  law: '#2E6B43',
  enacted: '#2E6B43',
  // LEG-A normalized stages (bill-stage.ts) plot directly.
  introduced: '#8A8780',
  referred: '#8A8780',
  reported: '#2C5BD4',
  passed_house: '#2A57CE',
  passed_senate: '#2A57CE',
  conference: '#7A3FB5',
  to_president: '#2E6B45',
  other: '#B5B0A4',
};

const W = 720;
const padL = 12;
const padR = 12;
const plotW = W - padL - padR;
// Single-line label geometry. ~11px font ⇒ ~5.4px/char; pack lanes 14px apart.
const CHAR_W = 5.4;
const LABEL_GAP = 8;
const LANE_STEP = 14;
const MAX_LABEL_CHARS = 30;

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

/**
 * Horizontal legislative milestone axis. Each bill action is a node on a date
 * axis; its label is packed into a collision-free lane (labels for events at
 * nearby dates stack outward from the axis instead of overprinting each other).
 * Exact-duplicate events are de-duped. Dependency-free inline SVG; height grows
 * with the number of lanes actually needed.
 */
export function LegTimeline({ events }: LegTimelineProps) {
  // Parse, drop unparseable dates, de-dupe exact repeats, sort by date.
  const seen = new Set<string>();
  const parsed = events
    .map((e) => ({ ...e, t: new Date(e.date).getTime() }))
    .filter((e) => Number.isFinite(e.t))
    .filter((e) => {
      const k = `${e.date}|${e.num ?? ''}|${e.kind}|${e.label}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.t - b.t);

  if (parsed.length === 0) return null;

  const minYear = new Date(parsed[0]!.t).getUTCFullYear();
  const maxYear = new Date(parsed[parsed.length - 1]!.t).getUTCFullYear();
  const t0 = Date.UTC(minYear, 0, 1);
  const t1 = Date.UTC(maxYear + 1, 0, 1);
  const span = t1 - t0 || 1;
  const x = (t: number) => padL + ((t - t0) / span) * plotW;

  // One combined, truncated label line per event, then greedy lane packing:
  // fill the nearest lane whose previous label has cleared this label's left edge.
  const laid = parsed.map((e) => {
    const text = truncate(e.num ? `${e.num} · ${e.label}` : e.label, MAX_LABEL_CHARS);
    const halfW = (text.length * CHAR_W) / 2;
    const cx = x(e.t);
    return { ...e, text, cx, left: cx - halfW, right: cx + halfW, lane: 0 };
  });
  const laneRight: number[] = []; // last occupied right-edge per lane
  for (const item of laid) {
    let lane = laneRight.findIndex((r) => item.left > r + LABEL_GAP);
    if (lane === -1) {
      lane = laneRight.length;
      laneRight.push(item.right);
    } else {
      laneRight[lane] = item.right;
    }
    item.lane = lane;
  }

  // Lane → side + distance from axis. Even lanes go up, odd lanes go down.
  const distOf = (lane: number) => Math.floor(lane / 2);
  const isUp = (lane: number) => lane % 2 === 0;
  let maxUp = 0;
  let maxDown = 0;
  for (const it of laid) {
    if (isUp(it.lane)) maxUp = Math.max(maxUp, distOf(it.lane));
    else maxDown = Math.max(maxDown, distOf(it.lane));
  }

  const topPad = 10;
  const upStack = (maxUp + 1) * LANE_STEP;
  const axisY = topPad + upStack + 6;
  const downStack = (maxDown + 1) * LANE_STEP;
  const yearRow = 18;
  const H = axisY + downStack + 10 + yearRow;

  const labelY = (lane: number) =>
    isUp(lane) ? axisY - 12 - distOf(lane) * LANE_STEP : axisY + 22 + distOf(lane) * LANE_STEP;

  const years: number[] = [];
  for (let y = minYear; y <= maxYear; y += 1) years.push(y);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="pe-leg-timeline"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Legislative timeline"
    >
      {years.map((y) => (
        <g key={y}>
          <line
            x1={x(Date.UTC(y, 0, 1))}
            x2={x(Date.UTC(y, 0, 1))}
            y1={topPad}
            y2={H - yearRow}
            className="pe-chart-grid"
          />
          <text x={x(Date.UTC(y, 0, 1)) + 5} y={H - 6} className="pe-axis-x" textAnchor="start">
            {y}
          </text>
        </g>
      ))}
      <line x1={padL} x2={W - padR} y1={axisY} y2={axisY} className="pe-tl-axis" />
      {laid.map((e, i) => {
        const color = KIND_COLOR[e.kind] ?? '#8A8780';
        const ly = labelY(e.lane);
        // Anchor the label to keep it inside the plot at the edges.
        const anchor = e.cx < 60 ? 'start' : e.cx > W - 60 ? 'end' : 'middle';
        return (
          <g key={`${e.date}-${i}`}>
            {/* connector from the axis node up/down to the label's lane */}
            <line
              x1={e.cx}
              x2={e.cx}
              y1={axisY}
              y2={ly + (isUp(e.lane) ? 3 : -9)}
              stroke={color}
              strokeWidth="1"
              strokeOpacity="0.5"
            />
            <circle
              cx={e.cx}
              cy={axisY}
              r="4.5"
              fill="var(--bg-surface)"
              stroke={color}
              strokeWidth="2.5"
            />
            <text x={e.cx} y={ly} className="pe-tl-label" textAnchor={anchor} fill={color}>
              {e.text}
              <title>{e.num ? `${e.num} — ${e.label}` : e.label}</title>
            </text>
          </g>
        );
      })}
    </svg>
  );
}
