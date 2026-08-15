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
