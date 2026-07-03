import { fmtMoneyMBare } from './format.js';

export interface DeltaDatum {
  fy: string | number;
  /** Enacted minus request in $ millions; null renders a placeholder dot. */
  delta: number | null;
}

export interface DeltaBarsProps {
  data: DeltaDatum[];
  height?: number;
}

/**
 * Signed bars around a centered zero baseline — Congress adds (green) or cuts
 * (red) against the President's Budget, per fiscal year. Values in $ millions.
 */
export function DeltaBars({ data, height = 150 }: DeltaBarsProps) {
  const W = 720;
  const H = height;
  const padL = 46;
  const padR = 16;
  const padT = 14;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const vals = data.map((d) => d.delta).filter((v): v is number => v != null);
  const maxAbs = Math.max(...vals.map(Math.abs), 1);
  const zeroY = padT + plotH / 2;
  const bw = data.length ? Math.min(46, (plotW / data.length) * 0.5) : 0;
  const x = (i: number) => padL + ((i + 0.5) / (data.length || 1)) * plotW;
  const scale = (v: number) => (v / maxAbs) * (plotH / 2 - 6);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="pe-deltabars"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Enacted vs. request delta by fiscal year"
    >
      <line x1={padL} x2={W - padR} y1={zeroY} y2={zeroY} className="pe-chart-grid strong" />
      {data.map((d, i) => {
        if (d.delta == null) {
          return (
            <text
              key={`n${d.fy}`}
              x={x(i)}
              y={zeroY + 4}
              className="pe-axis-x"
              textAnchor="middle"
              opacity="0.5"
            >
              ·
            </text>
          );
        }
        const hh = scale(d.delta);
        const pos = d.delta >= 0;
        return (
          <g key={`b${d.fy}`}>
            <rect
              x={x(i) - bw / 2}
              y={pos ? zeroY - hh : zeroY}
              width={bw}
              height={Math.abs(hh)}
              rx="3"
              fill={pos ? 'var(--success)' : 'var(--critical)'}
              opacity="0.9"
            />
            <text
              x={x(i)}
              y={pos ? zeroY - hh - 6 : zeroY + hh + 14}
              className="pe-axis-val"
              textAnchor="middle"
              fill={pos ? 'var(--success)' : 'var(--critical)'}
            >
              {pos ? '+' : '−'}
              {fmtMoneyMBare(Math.abs(d.delta))}
            </text>
          </g>
        );
      })}
      {data.map((d, i) => (
        <text key={`l${d.fy}`} x={x(i)} y={H - 8} className="pe-axis-x" textAnchor="middle">
          {d.fy}
        </text>
      ))}
    </svg>
  );
}
