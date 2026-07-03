export interface LineSeries {
  name: string;
  color: string;
  /** SVG dasharray, e.g. "5 4" for the request line. */
  dash?: string;
  /** Per-label values in $ MILLIONS; null breaks the line (e.g. un-enacted years). */
  values: (number | null)[];
}

export interface LineChartProps {
  labels: string[];
  series: LineSeries[];
  height?: number;
  /** Y-axis ceiling in $M; defaults to max value rounded up to the nearest 40M. */
  yMaxM?: number;
  yTicks?: number;
  /** 'area' fills a soft region under series[0]. */
  mode?: 'line' | 'area';
  /** Clicking a data point calls back with its label index (used to open the FY drawer). */
  onPointClick?: (index: number) => void;
}

/**
 * Multi-series fiscal-year line chart (President's request vs. enacted). Values are
 * in $ millions. Responsive (viewBox + width:100%). Dependency-free inline SVG.
 */
export function LineChart({
  labels,
  series,
  height = 260,
  yMaxM,
  yTicks = 4,
  mode = 'line',
  onPointClick,
}: LineChartProps) {
  const W = 720;
  const H = height;
  const padL = 52;
  const padR = 18;
  const padT = 18;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const allVals = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const dataMax = allVals.length ? Math.max(...allVals) : 0;
  const max = yMaxM ?? Math.max(Math.ceil(dataMax / 40) * 40, 40);

  const x = (i: number) =>
    padL + (labels.length <= 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
  const y = (v: number) => padT + (1 - v / max) * plotH;
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => (max / yTicks) * i);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="pe-linechart"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Funding trajectory by fiscal year"
    >
      {ticks.map((t, i) => (
        <g key={`t${i}`}>
          <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="pe-chart-grid" />
          <text x={padL - 10} y={y(t) + 3.5} className="pe-axis-y" textAnchor="end">
            ${Math.round(t)}M
          </text>
        </g>
      ))}
      {labels.map((l, i) => (
        <text key={l} x={x(i)} y={H - 12} className="pe-axis-x" textAnchor="middle">
          {l}
        </text>
      ))}

      {series.map((s, si) => {
        // Break the polyline into contiguous non-null segments so a gap year
        // (e.g. FY with no enacted value yet) does not draw a fake connecting line.
        const segs: Array<Array<readonly [number, number]>> = [];
        let cur: Array<readonly [number, number]> = [];
        s.values.forEach((v, i) => {
          if (v == null) {
            if (cur.length) {
              segs.push(cur);
              cur = [];
            }
          } else {
            cur.push([x(i), y(v)]);
          }
        });
        if (cur.length) segs.push(cur);

        return (
          <g key={s.name}>
            {mode === 'area' &&
              si === 0 &&
              segs.map((seg, k) => {
                const dd = seg
                  .map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
                  .join(' ');
                const areaD = `${dd} L ${seg[seg.length - 1]![0].toFixed(1)} ${y(0)} L ${seg[0]![0].toFixed(1)} ${y(0)} Z`;
                return <path key={`a${k}`} d={areaD} fill={s.color} opacity="0.1" />;
              })}
            {segs.map((seg, k) => {
              const dd = seg
                .map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
                .join(' ');
              return (
                <path
                  key={`l${k}`}
                  d={dd}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="2.4"
                  strokeDasharray={s.dash || undefined}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              );
            })}
            {s.values.map((v, i) =>
              v == null ? null : (
                <circle
                  key={`p${i}`}
                  cx={x(i)}
                  cy={y(v)}
                  r="3.6"
                  fill="var(--bg-surface)"
                  stroke={s.color}
                  strokeWidth="2"
                  style={onPointClick ? { cursor: 'pointer' } : undefined}
                  onClick={onPointClick ? () => onPointClick(i) : undefined}
                />
              ),
            )}
          </g>
        );
      })}
    </svg>
  );
}
