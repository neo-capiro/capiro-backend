export interface HBarDatum {
  label: string;
  value: number;
  color?: string;
}

export interface HBarsProps {
  data: HBarDatum[];
  color?: string;
  /** Value formatter (e.g. fmtMoneyM or identity). */
  fmt?: (value: number) => string | number;
  unit?: string;
}

/**
 * Horizontal bar breakdown: `label | track | value` grid. CSS-driven (not SVG),
 * fill width = value / max. Used for project-level funding and roster-by-org.
 */
export function HBars({ data, color = 'var(--accent)', fmt = (v) => v, unit = '' }: HBarsProps) {
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  return (
    <div className="pe-hbars">
      {data.map((d, i) => (
        <div key={`${d.label}-${i}`} className="pe-hbar-row">
          <div className="pe-hbar-label" title={d.label}>
            {d.label}
          </div>
          <div className="pe-hbar-track">
            <div
              className="pe-hbar-fill"
              style={{ width: `${(d.value / max) * 100}%`, background: d.color || color }}
            />
          </div>
          <div className="pe-hbar-val">
            {fmt(d.value)}
            {unit}
          </div>
        </div>
      ))}
    </div>
  );
}
