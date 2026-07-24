/**
 * Dossier number/label formatters — ported verbatim from the Bill 360 prototype
 * so the R2 UI matches it exactly (including the literal 'flat' and the U+2212
 * MINUS sign for negative deltas). Amounts are always in MILLIONS.
 */
import { FUNDING_SCOPE_LABELS, FUNDING_SCOPE_SHORT_LABELS, type FundingScope } from '@capiro/shared';

/**
 * ISO-8601 timestamp → the calendar date the prototype displays (`2026-06-18`).
 *
 * The R1 dossier API returns full ISO instants (`2026-06-18T21:30:00.000Z`) because
 * a wire contract should carry the unambiguous value; the prototype renders short
 * dates everywhere. This is the single display-side narrowing. Anything that is not
 * an ISO datetime — an already-short date, a human label, a bare string — passes
 * through untouched, so it is safe on the API's opaque KPI value/sub strings.
 */
export function fmtDate(s: string | null | undefined): string {
  if (!s) return '';
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
}

/** $X.XB at ≥1000M, else $XM (1 decimal only when non-integer); em-dash for null. */
export function fmtAmt(m: number | null | undefined): string {
  if (m == null) return '—';
  if (Math.abs(m) >= 1000) return `$${(m / 1000).toFixed(1)}B`;
  return `$${m % 1 ? m.toFixed(1) : m.toFixed(0)}M`;
}

/** '+'/'−' signed amount; literal 'flat' for exactly 0; em-dash for null. */
export function fmtDelta(d: number | null | undefined): string {
  if (d == null) return '—';
  if (d === 0) return 'flat';
  const s = d > 0 ? '+' : '−'; // U+2212 MINUS SIGN, not a hyphen
  const a = Math.abs(d);
  return s + (a >= 1000 ? `$${(a / 1000).toFixed(1)}B` : `$${a % 1 ? a.toFixed(1) : a.toFixed(0)}M`);
}

/** Delta color token (positive → green, negative → red, flat → neutral ink). */
export function deltaColor(d: number | null | undefined): string {
  if (d == null || d === 0) return 'var(--ink-2)';
  return d > 0 ? 'var(--positive)' : 'var(--critical)';
}

export function scopeLabel(scope: FundingScope): string {
  return FUNDING_SCOPE_LABELS[scope];
}

export function scopeShort(scope: FundingScope): string {
  return FUNDING_SCOPE_SHORT_LABELS[scope];
}
