import type { QueryClient } from '@tanstack/react-query';

/**
 * Response-object provenance for Engagement-owned React Query data.
 *
 * Query keys are intentionally not treated as the source of truth: Engagement
 * requests live on primary pages and mixed cross-surfaces, and several existing
 * keys are generic (`client-meetings`, integration capabilities, etc.). The
 * axios interceptor sees the actual request URL, so it marks the exact object
 * or array returned by an Engagement request in this WeakSet. React Query keeps
 * that same reference as query data.
 */
const engagementResponseData = new WeakSet<object>();

const FALLBACK_ENGAGEMENT_QUERY_KEYS = new Set([
  'engagement-integrations',
  'engagement-meetings',
  'engagement-mail-threads',
  'client-meetings',
  'client-mail-threads',
  'integration-capabilities',
]);

type QueryLike = {
  queryKey: readonly unknown[];
  state: { data: unknown };
};

export function markEngagementResponseData(data: unknown): void {
  if ((typeof data === 'object' && data !== null) || typeof data === 'function') {
    engagementResponseData.add(data as object);
  }
}

export function isEngagementOwnedQuery(query: QueryLike): boolean {
  const data = query.state.data;
  if ((typeof data === 'object' && data !== null) || typeof data === 'function') {
    if (engagementResponseData.has(data as object)) return true;
  }

  // Small fallback for pending/primitive queries. These are existing, reviewed
  // keys whose queryFns are Engagement routes. Do not use broad substring
  // matching (`report`, `task`, etc.) because mixed pages also carry unrelated
  // owners and Phase 3 must preserve their caches.
  const first = Array.isArray(query.queryKey) ? query.queryKey[0] : undefined;
  return typeof first === 'string' && FALLBACK_ENGAGEMENT_QUERY_KEYS.has(first);
}

/**
 * Cancel and remove only Engagement-owned queries on a mode transition. Cancel
 * first so an in-flight old-mode query cannot repopulate the new-mode cache.
 * The axios response gate independently rejects a response whose dispatch mode
 * no longer equals the session mode, providing defense in depth for queryFns
 * that do not consume React Query's AbortSignal.
 */
export async function clearEngagementPreviewQueries(queryClient: QueryClient): Promise<void> {
  const predicate = (query: QueryLike) => isEngagementOwnedQuery(query);
  await queryClient.cancelQueries({ predicate });
  queryClient.removeQueries({ predicate });
}
