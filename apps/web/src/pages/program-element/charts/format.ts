// ============================================================
// Program Element charts — shared formatters + palettes.
// All monetary inputs are in $ MILLIONS (the canonical PE unit;
// program_element_year and the finder list endpoint both store
// millions), NOT raw dollars.
// ============================================================

/** Compact money in $ millions: >=1000M -> $X.XXB, else $X.XM (1 decimal). */
export function fmtMoneyM(m: number | null | undefined, digits = 1): string {
  if (m == null || !Number.isFinite(m)) return '—';
  if (Math.abs(m) >= 1000) return `$${(m / 1000).toFixed(2)}B`;
  return `$${m.toFixed(digits)}M`;
}

/** Same as fmtMoneyM but without the leading "$" (for signed delta labels). */
export function fmtMoneyMBare(m: number | null | undefined, digits = 1): string {
  return fmtMoneyM(m, digits).replace('$', '');
}

// Service accent dots — mirrors the design spec (chart-specific palette).
const SERVICE_COLORS: Record<string, string> = {
  ARMY: '#2A57CE',
  NAVY: '#1A6E78',
  USMC: '#4F7942',
  'MARINE CORPS': '#4F7942',
  AF: '#A26913',
  'AIR FORCE': '#A26913',
  SF: '#B0651F',
  'SPACE FORCE': '#B0651F',
  DARPA: '#7A3FB5',
  DW: '#4E5A86',
  'DEFENSE-WIDE': '#4E5A86',
};

/** A stable accent color for a service label/code (case-insensitive). */
export function serviceColor(service: string | null | undefined): string {
  if (!service) return 'var(--ink-3)';
  return SERVICE_COLORS[service.trim().toUpperCase()] ?? 'var(--ink-3)';
}

// The stacked donut ramp for FY-request-by-project style breakdowns.
export const DONUT_RAMP = ['#2A57CE', '#4E78D8', '#7A9BE6', '#A9C0F0', '#CBD9F5', '#8A5A2B'];

export type SignalTone = 'critical' | 'notable' | 'info';

export interface SignalMeta {
  label: string;
  tone: SignalTone;
}

/**
 * Map a PE's most-material live budget delta (delta_type + score + %) to a short
 * signal pill. Tone follows the server's severityForScore thresholds
 * (>=0.7 critical, >=0.4 notable, else info). Returns null when there is no signal.
 */
export function signalMeta(item: {
  signalType?: string | null;
  signalScore?: number | null;
  signalDeltaPct?: number | null;
}): SignalMeta | null {
  const type = item.signalType;
  if (!type) return null;

  const score = item.signalScore ?? 0;
  const pct = item.signalDeltaPct ?? null;
  let tone: SignalTone = score >= 0.7 ? 'critical' : score >= 0.4 ? 'notable' : 'info';

  let label: string;
  switch (type) {
    case 'termination':
    case 'zeroed':
      label = 'Cut';
      tone = 'critical';
      break;
    case 'mark_vs_request':
    case 'mark_vs_mark':
    case 'conference_vs_marks':
      label = 'Markup';
      break;
    case 'enacted_vs_request':
      label = pct != null && pct < 0 ? 'Cut' : 'Over req';
      if (pct != null && pct < 0) tone = tone === 'info' ? 'notable' : tone;
      break;
    case 'new_start':
      label = 'New start';
      break;
    case 'pb_vs_prior_pb':
      label = 'New PB';
      break;
    case 'quantity_change':
      label = 'Qty Δ';
      break;
    case 'unit_cost_change':
      label = 'Unit cost';
      break;
    case 'outyear_shift':
      label = 'Outyear';
      break;
    case 'transfer_candidate':
      label = 'Transfer';
      break;
    default:
      label = pct != null && pct < 0 ? 'Cut' : 'Change';
  }
  return { label, tone };
}
