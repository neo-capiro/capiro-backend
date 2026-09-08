/*
 * Agents surface — shared display helpers (STRATEGIES-HANDOFF §7.8/§7.9).
 * Pure presentational utilities used by both tabs (proposals + runs). No data
 * fetching here — every hook lives in ../strategies-api.js (BUILD-CONTRACT).
 */
import { strategyRelativeTime } from '../lib/date-format.js';
import type { UseQueryResult } from '@tanstack/react-query';

/** ISO datetime → "just now" / "N min ago" / … (day-granularity fallback). */
export function fmtRelative(iso: string | null | undefined): string {
  return iso ? strategyRelativeTime(iso) : '—';
}

/** Machine identifier → short form for display (full value stays in title). */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** §9.1 Forbidden detection — the agents surface is AgenticGuard-gated server-side. */
export function isForbidden(err: unknown): boolean {
  return (err as { response?: { status?: number } } | null)?.response?.status === 403;
}

/**
 * §9.1 Stale state: a failed REFETCH keeps the last-good data visible with a
 * marker and its last-successful timestamp. The panel never disappears.
 */
export function StaleNote({ dataUpdatedAt }: { dataUpdatedAt: number }) {
  return (
    <div className="st-agents__stale-note" role="status">
      Refresh failed — showing data from{' '}
      {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : 'the last successful load'}.
    </div>
  );
}

/**
 * The one stale-or-error decision every section makes: a query with data and
 * a failed refetch renders STALE (data + marker); a query with no data at all
 * renders ERROR (or FORBIDDEN). Returns 'stale' | 'error' | null.
 */
export function staleOrError(q: Pick<UseQueryResult<unknown>, 'isError' | 'data'>): 'stale' | 'error' | null {
  if (!q.isError) return null;
  return q.data !== undefined ? 'stale' : 'error';
}

/*
 * Dark-banner icon tiles (design handoff — "a 36px icon tile" on both Agent
 * review banners; `agBannerIcon` varies per tab: a governance/approval glyph
 * on the proposals queue, a lock on execution runs). The shared icon set
 * (../../components/icons/index.tsx) has no match for either, and that file
 * may be touched by another concurrent Strategies agent — self-contained,
 * view-local glyphs instead (same stroke convention as StrategyLibraryVNext's
 * local glyphs: 24x24 viewBox, currentColor, 1.75 stroke). Purely decorative
 * (aria-hidden) — no behavior, so out of scope for the "no new actions" rule.
 */
export function BannerGovernanceGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 20 7v6c0 4.5-3.4 7.2-8 8-4.6-.8-8-3.5-8-8V7l8-4Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function BannerLockGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
    </svg>
  );
}

/** The Watch marker remains in the audit record, not the primary proposal text. */
export function proposalSummary(summary: string): string {
  return summary.replace(/^\[watch:[^\]]+\]\s*/, '') || 'Proposed plan change';
}
