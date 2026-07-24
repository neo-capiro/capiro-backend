import type { PillSev } from './EvidenceBadge.js';

/** Foreground color per severity — the prototype's `SEV[sev][0]`. */
export const SEV_COLOR: Record<PillSev, string> = {
  critical: '#b5301b',
  notable: '#a26913',
  info: '#2c5bd4',
  success: '#2e6b43',
  accent: '#1a3f9f',
  neutral: '#4f525a',
};

export interface DossierKpi {
  label: string;
  value: string;
  sub: string | null;
  /**
   * Explicit value color, matching the prototype's per-cell `kv(color, mono)`
   * (delta sign colors, or the muted ink-3 of an unavailable cell). Takes
   * precedence over `sev`; omit both for the default ink-1.
   */
  color?: string | null;
  /** Severity shorthand — resolved to `SEV_COLOR[sev]`. */
  sev?: PillSev | null;
  /** Monospace + tabular numerals — the prototype's `kv(_, true)` cells. */
  mono?: boolean;
}

function valueColor(k: DossierKpi): string | undefined {
  if (k.color) return k.color;
  if (k.sev) return SEV_COLOR[k.sev];
  return undefined;
}

/**
 * The 6-cell KPI strip (3-up hairline grid): label / value / sub per cell. The
 * value carries the prototype's per-cell color and optional monospace, so a
 * failed vote result reads red and every amount aligns on tabular numerals.
 */
export function DossierKpiStrip({ items }: { items: DossierKpi[] }) {
  return (
    <div className="dsr-kpi-strip">
      {items.map((k, i) => (
        <div className="dsr-kpi" key={`${k.label}-${i}`}>
          <div className="dsr-kpi-label">{k.label}</div>
          <div className={`dsr-kpi-value${k.mono ? ' mono' : ''}`} style={{ color: valueColor(k) }}>
            {k.value}
          </div>
          {k.sub != null ? <div className="dsr-kpi-sub">{k.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}
