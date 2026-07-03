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

/**
 * Horizontal legislative milestone axis. The year window is derived from the
 * events (Jan 1 of the earliest year through Jan 1 after the latest). Labels
 * stagger above/below the axis to avoid overlap. Dependency-free inline SVG.
 */
export function LegTimeline({ events }: LegTimelineProps) {
  const parsed = events
    .map((e) => ({ ...e, t: new Date(e.date).getTime() }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);

  if (parsed.length === 0) return null;

  const W = 720;
  const H = 132;
  const padL = 12;
  const padR = 12;
  const axisY = 60;
  const plotW = W - padL - padR;

  const minYear = new Date(parsed[0]!.t).getUTCFullYear();
  const maxYear = new Date(parsed[parsed.length - 1]!.t).getUTCFullYear();
  const t0 = Date.UTC(minYear, 0, 1);
  const t1 = Date.UTC(maxYear + 1, 0, 1);
  const span = t1 - t0 || 1;
  const x = (t: number) => padL + ((t - t0) / span) * plotW;

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
            y1={axisY - 40}
            y2={axisY + 40}
            className="pe-chart-grid"
          />
          <text x={x(Date.UTC(y, 0, 1)) + 5} y={H - 8} className="pe-axis-x" textAnchor="start">
            {y}
          </text>
        </g>
      ))}
      <line x1={padL} x2={W - padR} y1={axisY} y2={axisY} className="pe-tl-axis" />
      {parsed.map((e, i) => {
        const up = i % 2 === 0;
        const ly = up ? axisY - 18 : axisY + 30;
        const color = KIND_COLOR[e.kind] ?? '#8A8780';
        const anchor = i === 0 ? 'start' : 'middle';
        return (
          <g key={`${e.date}-${i}`}>
            <line
              x1={x(e.t)}
              x2={x(e.t)}
              y1={axisY}
              y2={up ? axisY - 12 : axisY + 12}
              stroke={color}
              strokeWidth="1.5"
            />
            <circle
              cx={x(e.t)}
              cy={axisY}
              r="5"
              fill="var(--bg-surface)"
              stroke={color}
              strokeWidth="2.5"
            />
            {e.num && (
              <text x={x(e.t)} y={ly} className="pe-tl-label" textAnchor={anchor} fill={color}>
                {e.num}
              </text>
            )}
            <text
              x={x(e.t)}
              y={ly + (up ? -12 : 13)}
              className="pe-tl-sub"
              textAnchor={anchor}
            >
              {e.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
