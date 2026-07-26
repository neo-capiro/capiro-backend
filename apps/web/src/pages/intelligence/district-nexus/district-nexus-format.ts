import type { DistrictNexusDistrictSummary, Money } from './district-nexus-api.js';

/**
 * Formatting and choropleth-presentation helpers for District Nexus.
 *
 * Scoring itself (the 0-100 score, coveragePercent, breakdown) is computed
 * server-side by apps/api/src/district-nexus/district-nexus-scoring.ts (WS-F)
 * — this module only formats numbers and picks colors for values the API
 * already returns. It does not recompute anything the backend owns.
 */

/** `null` is "no figure" (see the Money type docblock) — renders as an em dash,
 * never $0. Mirrors the prototype's `money()`. */
export function formatMoney(amount: Money, decimals?: number): string {
  if (amount == null) return '—';
  const abs = Math.abs(amount);
  if (abs >= 1e9) return `$${(amount / 1e9).toFixed(decimals ?? 2)}B`;
  if (abs >= 1e6) return `$${(amount / 1e6).toFixed(decimals ?? 1)}M`;
  if (abs >= 1e3) return `$${Math.round(amount / 1e3)}K`;
  return `$${amount}`;
}

export function formatNumber(value: number | null): string {
  return value == null ? '—' : value.toLocaleString('en-US');
}

export interface ScoreBand {
  id: 'strong' | 'moderate' | 'limited' | 'minimal';
  label: string;
  color: string;
}

/** Mirrors the prototype's BANDS exactly (plan §7-F / prototype README). */
const BANDS: Array<[number, ScoreBand]> = [
  [60, { id: 'strong', label: 'Strong', color: '#1a3f9f' }],
  [35, { id: 'moderate', label: 'Moderate', color: '#2a57ce' }],
  [15, { id: 'limited', label: 'Limited', color: '#8a8780' }],
  [0, { id: 'minimal', label: 'Minimal', color: '#b5b0a4' }],
];

/** `null` when the score itself is null (below the coverage floor) — this is
 * a DISTINCT fact from "Minimal" and must never collapse into it. Callers
 * render an "Unscored" state, not a fabricated band. */
export function bandOf(score: number | null): ScoreBand | null {
  if (score == null) return null;
  for (const [floor, band] of BANDS) {
    if (score >= floor) return band;
  }
  return BANDS[BANDS.length - 1]![1];
}

export type ChoroplethMetric = 'nexus' | 'contracts' | 'grants' | 'employees' | 'clients' | 'coverage';

export const METRIC_OPTIONS: Array<{ value: ChoroplethMetric; label: string }> = [
  { value: 'nexus', label: 'Nexus strength' },
  { value: 'contracts', label: 'Contract obligations' },
  { value: 'grants', label: 'Grant obligations' },
  { value: 'employees', label: 'Employees' },
  { value: 'clients', label: 'Clients' },
  { value: 'coverage', label: 'Evidence coverage' },
];

interface MetricScale {
  label: string;
  /** Ascending breakpoints; a value's ramp step = how many breaks it clears. */
  breaks: number[];
  ticks: string[];
}

/** Mirrors the prototype's SCALES (dn/app.js). Breakpoints are chosen for a
 * single-firm book of business, not a global maximum — a firm whose values
 * cluster above these will simply saturate at the top ramp step. */
export const METRIC_SCALES: Record<ChoroplethMetric, MetricScale> = {
  nexus: { label: 'Nexus strength', breaks: [1, 15, 35, 50, 65], ticks: ['0', '15', '35', '50', '65', '80+'] },
  contracts: {
    label: 'Contract obligations',
    breaks: [1, 2e6, 6e6, 12e6, 22e6],
    ticks: ['$0', '2M', '6M', '12M', '22M', '+'],
  },
  grants: {
    label: 'Grant obligations',
    breaks: [1, 2e6, 6e6, 12e6, 20e6],
    ticks: ['$0', '2M', '6M', '12M', '20M', '+'],
  },
  employees: {
    label: 'Employees represented',
    breaks: [1, 150, 400, 800, 1500],
    ticks: ['0', '150', '400', '800', '1.5K', '+'],
  },
  clients: { label: 'Clients with nexus', breaks: [1, 2, 3, 4, 5], ticks: ['0', '1', '2', '3', '4', '5+'] },
  coverage: { label: 'Evidence coverage', breaks: [1, 35, 50, 65, 80], ticks: ['0', '35', '50', '65', '80', '100'] },
};

/** Six-step blue ramp — light (no/weak signal) to dark (strongest). */
export const CHOROPLETH_RAMP = ['#edf1fa', '#dee6f8', '#bccdf0', '#8ea9e4', '#547ad4', '#2a57ce'];
/** Fill for a district with zero nexus under the current filters — distinct
 * from the ramp's own lightest step so "no data" never reads as "lowest value". */
export const NO_NEXUS_FILL = '#e8e4da';

export function metricValue(district: DistrictNexusDistrictSummary, metric: ChoroplethMetric): number {
  switch (metric) {
    case 'nexus':
      return district.score ?? 0;
    case 'contracts':
      return district.awarded.contractObligations ?? 0;
    case 'grants':
      return district.awarded.grantObligations ?? 0;
    case 'employees':
      return district.employeeCount ?? 0;
    case 'clients':
      return district.clientCount;
    case 'coverage':
      return district.coveragePercent;
  }
}

export function rampColorForValue(value: number, metric: ChoroplethMetric): string {
  const breaks = METRIC_SCALES[metric].breaks;
  let step = 0;
  while (step < breaks.length && value >= breaks[step]!) step += 1;
  return CHOROPLETH_RAMP[Math.max(0, step - 1)] ?? CHOROPLETH_RAMP[0]!;
}

/** `TX-23` -> `{ state: 'TX', districtNo: '23' }`; `WY-00` -> districtNo '00'.
 * Mirrors the district-key convention shared with the boundary artifact and
 * the existing `/directory/districts/:state/:districtNo` page. */
export function splitDistrictKey(districtKey: string): { state: string; districtNo: string } {
  const [state, districtNo] = districtKey.split('-');
  return { state: state ?? '', districtNo: districtNo ?? '' };
}
