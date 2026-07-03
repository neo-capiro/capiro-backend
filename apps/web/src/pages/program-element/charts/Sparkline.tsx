import { useId } from 'react';

export interface SparklineProps {
  /** Series values (any unit); the line is min/max-normalized. */
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  /** Draw a soft area gradient under the line. Default true. */
  area?: boolean;
  strokeWidth?: number;
}

/**
 * Tiny trend line with an optional area gradient and an end dot. Fixed pixel size
 * (crisp in dense table cells / KPI tiles). Dependency-free inline SVG.
 */
export function Sparkline({
  data,
  width = 96,
  height = 28,
  color = 'var(--accent)',
  area = true,
  strokeWidth = 1.6,
}: SparklineProps) {
  // useId is stable across render + SSR (unlike Math.random) so gradient ids don't collide.
  const gid = `spk-${useId().replace(/[:]/g, '')}`;

  if (!data || data.length === 0) return null;

  const pad = 3;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => {
    const x =
      data.length === 1 ? width / 2 : pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return [x, y] as const;
  });
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1]!;
  const first = pts[0]!;
  const areaD = `${d} L ${last[0].toFixed(1)} ${height - pad} L ${first[0].toFixed(1)} ${height - pad} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="pe-spark"
      aria-hidden="true"
      role="presentation"
    >
      {area && data.length > 1 && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaD} fill={`url(#${gid})`} />
        </>
      )}
      {data.length > 1 && (
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      <circle cx={last[0]} cy={last[1]} r="2.4" fill={color} />
    </svg>
  );
}
