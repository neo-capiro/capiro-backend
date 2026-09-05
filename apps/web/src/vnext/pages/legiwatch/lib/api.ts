/**
 * LegiWatch vNext — module data hooks. These wrap the canonical fetchers so the
 * module reads one shape; the underlying react-query keys stay the canonical
 * ones (§3.3) so mutations here invalidate the old app and vice-versa.
 */
import { useMemo } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import {
  feedQueryString,
  intelFeedKeys,
  intelFeedPaths,
  type FeedItem,
  type FeedWorkStateCounts,
  type FeedOrder,
  type FeedFilter,
  type FeedResponse,
} from '../../../../pages/clients/tracker/intel-feed-api.js';
import type { GovernmentAffairsAlertPacket } from '../../../../pages/clients/tracker/alert-packet.js';
import { lwKeys, type WorkState } from './types.js';

const enc = encodeURIComponent;

/** The module's scope: '' = all clients (tenant feed), else one client. */
export type Scope = string;

function feedPath(scope: Scope): string {
  return scope ? intelFeedPaths.feed(scope) : intelFeedPaths.tenantFeed();
}

/** One feed page family (infinite). The same query fills the list AND derives
 *  every count on screen (§8.6) — tab badge, header pill, source-family chips. */
export function useLwFeed(scope: Scope, source: FeedFilter, order: FeedOrder, workState?: string) {
  const api = useApi();
  return useInfiniteQuery<FeedResponse>({
    queryKey: scope
      ? [...intelFeedKeys.feed(scope, source, order), workState ?? 'default']
      : [...intelFeedKeys.tenantFeed(source, order), workState ?? 'default'],
    queryFn: async ({ pageParam }) => {
      const qs = feedQueryString(source, order, pageParam as string | undefined, workState);
      return (await api.get<FeedResponse>(`${feedPath(scope)}?${qs}`)).data;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Derive the "Active queue" (`default`) bucket's exact count from the same
 * `workStateCounts` the other five buckets read directly. `default` is not
 * one of the six stored work states — it is the shipped view's OWN
 * definition, "everything except this user's dismissed/actively-snoozed
 * alerts" (see `FeedQuery.workStates` in feed.service.ts) — so its count is
 * the sum of the four buckets that definition does NOT exclude.
 */
export function defaultBucketCount(workStateCounts: FeedWorkStateCounts | null): number | null {
  if (!workStateCounts) return null;
  return (
    workStateCounts.new +
    workStateCounts.in_review +
    workStateCounts.assigned +
    workStateCounts.actioned
  );
}

/** The full GA packet for the drawer (§7.4). */
export function useLwPacket(scope: Scope, alertId: string | null) {
  const api = useApi();
  const clientId = scope || '_all';
  return useQuery<GovernmentAffairsAlertPacket | null>({
    queryKey: lwKeys.packet(clientId, alertId ?? ''),
    queryFn: async () => {
      if (!alertId) return null;
      try {
        return (
          await api.get<GovernmentAffairsAlertPacket>(
            `/intel-api/clients/${enc(clientId)}/alerts/${enc(alertId)}/packet`,
          )
        ).data;
      } catch {
        return null; // packet is additive; the drawer degrades to feed-item evidence
      }
    },
    enabled: Boolean(alertId),
    retry: false,
    staleTime: 60_000,
  });
}

/** Single-alert read (drawer header evidence when the packet is absent). */
export function useLwAlert(scope: Scope, alertId: string | null) {
  const api = useApi();
  const clientId = scope || '_all';
  return useQuery<FeedItem | null>({
    queryKey: ['lw-vnext', 'alert', clientId, alertId ?? ''],
    queryFn: async () => {
      if (!alertId) return null;
      return (
        await api.get<FeedItem>(`/intel-api/clients/${enc(clientId)}/feed/alerts/${enc(alertId)}`)
      ).data;
    },
    enabled: Boolean(alertId),
    retry: false,
    staleTime: 30_000,
  });
}

/** §6.2 — work-state mutation. One mutation, available in three places (§4.1
 *  #9): the packet drawer's Change menu, the feed's bulk bar, and the row-level
 *  state pill. Optimistic, with rollback; invalidates the canonical feed keys
 *  so the OLD app reflects the change after its normal refetch (§16). */
export function useLwWorkState(scope: Scope) {
  const api = useApi();
  const qc = useQueryClient();
  const clientId = scope || '_all';
  return useMutation({
    mutationFn: async (input: {
      alertIds: string[];
      state?: WorkState;
      assignedTo?: string | null;
      snoozedUntil?: string | null;
    }) => {
      const body: Record<string, unknown> = {};
      if (input.state !== undefined) body.state = input.state;
      if (input.assignedTo !== undefined) body.assignedTo = input.assignedTo;
      if (input.snoozedUntil !== undefined) body.snoozedUntil = input.snoozedUntil;
      if (input.alertIds.length === 1 && input.alertIds[0]) {
        return (
          await api.post(
            `/intel-api/clients/${enc(clientId)}/alerts/${enc(input.alertIds[0])}/work-state`,
            body,
          )
        ).data;
      }
      return (
        await api.post(`/intel-api/clients/${enc(clientId)}/alerts/work-state/bulk`, {
          alertIds: input.alertIds,
          ...body,
        })
      ).data;
    },
    onSettled: () => {
      // Invalidate every feed page for this scope (all sources/orders/buckets)
      // plus the tenant roll-up — bulk triage invalidates every dependent count
      // and the Dashboard attention feed (§3.3).
      void qc.invalidateQueries({ queryKey: ['intel-feed'] });
      void qc.invalidateQueries({ queryKey: ['lw-vnext', 'bucket-count'] });
      void qc.invalidateQueries({ queryKey: ['lw-vnext'] });
    },
  });
}

/**
 * Flatten the infinite feed into one item list, alongside the facet counts —
 * including the EXACT work-state bucket counts (W2-3) and the exact total for
 * the fully-filtered set. All three read from the FIRST page only: they are
 * computed server-side over the whole filtered set (never per-page), so every
 * page after the first carries the identical values and re-reading them would
 * only risk drift if a later page's snapshot differs.
 */
export function useLwFeedItems(feed: ReturnType<typeof useLwFeed>): {
  items: FeedItem[];
  counts: Partial<Record<string, number>>;
  severityCounts: Partial<Record<string, number>>;
  workStateCounts: FeedWorkStateCounts | null;
  total: number | null;
} {
  return useMemo(() => {
    const pages = feed.data?.pages ?? [];
    const items = pages.flatMap((p) => p.items);
    const counts = pages[0]?.counts ?? {};
    const severityCounts = pages[0]?.severityCounts ?? {};
    const workStateCounts = pages[0]?.workStateCounts ?? null;
    const total = pages[0]?.total ?? null;
    return { items, counts, severityCounts, workStateCounts, total };
  }, [feed.data]);
}
