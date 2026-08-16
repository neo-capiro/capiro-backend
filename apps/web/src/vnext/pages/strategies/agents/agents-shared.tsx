/*
 * Agents surface — shared display helpers (STRATEGIES-HANDOFF §7.8/§7.9).
 * Pure presentational utilities used by both tabs (proposals + runs). No data
 * fetching here — every hook lives in ../strategies-api.js (BUILD-CONTRACT).
 */
import type { UseQueryResult } from '@tanstack/react-query';

/** ISO datetime → "just now" / "N min ago" / … (day-granularity fallback). */
export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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
