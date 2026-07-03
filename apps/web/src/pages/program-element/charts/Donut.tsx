import { DONUT_RAMP } from './format.js';

export interface DonutDatum {
  label?: string;
  name?: string;
  value: number;
  color?: string;
}

export interface DonutProps {
  data: DonutDatum[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerSub?: string;
}

/**
 * Categorical breakdown as stacked arcs (stroke-dasharray on concentric circles).
 * Track ring in --bg-sunken; optional center label + sub-label.
 */
export function Donut({ data, size = 168, thickness = 26, centerLabel, centerSub }: DonutProps) {
  const r = (size - thickness) / 2;
  const c = size / 2;
  const total = data.reduce((s, d) => s + (d.value || 0), 0);
  const circ = 2 * Math.PI * r;
  let acc = 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="pe-donut"
      role="img"
      aria-label={centerSub ? `${centerLabel ?? ''} ${centerSub}` : 'Breakdown'}
    >
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--bg-sunken)" strokeWidth={thickness} />
      {total > 0 &&
        data.map((d, i) => {
          const frac = (d.value || 0) / total;
          const dash = frac * circ;
          const el = (
            <circle
              key={i}
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={d.color || DONUT_RAMP[i % DONUT_RAMP.length]}
              strokeWidth={thickness}
              strokeDasharray={`${dash} ${circ - dash}`}
              strokeDashoffset={-acc * circ}
              transform={`rotate(-90 ${c} ${c})`}
              strokeLinecap="butt"
            />
          );
          acc += frac;
          return el;
        })}
      {centerLabel && (
        <text x={c} y={c - 2} className="pe-donut-center" textAnchor="middle">
          {centerLabel}
        </text>
      )}
      {centerSub && (
        <text x={c} y={c + 15} className="pe-donut-sub" textAnchor="middle">
          {centerSub}
        </text>
      )}
    </svg>
  );
}
