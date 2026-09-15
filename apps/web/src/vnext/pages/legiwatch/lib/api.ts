/**
 * LegiWatch vNext — module data hooks. These wrap the canonical fetchers so the
 * module reads one shape; the underlying react-query keys stay the canonical
 * ones (§3.3) so mutations here invalidate the old app and vice-versa.
 */
import { useMemo } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
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

/** Assign-self (LW-QA-021). Backend requires `assignedTo` on state='assigned';
   * the row pill and packet drawer previously sent the bare state → real API
   * 400. The id must be a DB `users.id` for a member of this tenant (same
   * contract as the old app's `/api/tenant-admin/team` picker). Resolved from
   * the current actor's `/api/me` so no id is hardcoded. */
export function useLwAssignSelf(): { userId: string | null; ready: boolean } {
  const api = useApi();
  const me = useQuery({
    queryKey: ['lw-self-member'],
    queryFn: async () => {
      const body = (await api.get<{ user: { id: string; clerkUserId: string } }>('/api/me')).data;
      return { userId: body?.user?.id ?? null };
    },
    staleTime: 5 * 60 * 1000,
  });
  return { userId: me.data?.userId ?? null, ready: me.isSuccess };
}

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

/**
 * Patch one item's work state inside every page of a cached feed response.
 * Touches ONLY `items[].workState.state` — never `workStateCounts` or `total`.
 * Those are server-computed over the whole filtered set, and hand-adjusting
 * them here is what would double-apply a triage: the optimistic tweak plus the
 * refetch onSettled triggers. Leaving them alone means every count moves
 * exactly once, from the server.
 */
function patchFeedWorkState(
  data: InfiniteData<FeedResponse> | undefined,
  alertIds: Set<string>,
  state: WorkState,
): InfiniteData<FeedResponse> | undefined {
  if (!data?.pages) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((it) =>
        alertIds.has(it.id)
          ? {
              ...it,
              workState: {
                assignedTo: null,
                snoozedUntil: null,
                note: null,
                ...it.workState,
                state,
              },
            }
          : it,
      ),
    })),
  };
}

/** §6.2 — work-state mutation. One mutation, available in three places (§4.1
 *  #9): the packet drawer's Change menu, the feed's bulk bar, and the row-level
 *  state pill. Optimistic, with rollback; invalidates the canonical feed keys
 *  so the OLD app reflects the change after its normal refetch (§16).
 *
 *  LW-QA-019: `clientId` stays the explicit tenant-wide token '_all' for the
 *  All-clients scope — the server now has real `_all` handlers, so the token is
 *  never substituted with some arbitrary client's UUID. The optimistic patch and
 *  the rollback below were previously only claimed by this comment: neither
 *  onMutate nor onError existed, so a failed triage silently kept its old state. */
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
    onMutate: async (input) => {
      // Stop in-flight feed fetches so a response already on the wire cannot
      // land on top of the optimistic state and undo it.
      await qc.cancelQueries({ queryKey: ['intel-feed'] });
      // The PREFIX-matching API: the real cache entries are
      // ['intel-feed', clientId, source, order, bucket], so the bare
      // ['intel-feed'] key addresses no entry at all and getQueryData on it
      // always returned undefined.
      const snapshot = qc.getQueriesData<InfiniteData<FeedResponse>>({ queryKey: ['intel-feed'] });
      if (input.state !== undefined) {
        const ids = new Set(input.alertIds);
        const next = input.state;
        qc.setQueriesData<InfiniteData<FeedResponse>>({ queryKey: ['intel-feed'] }, (old) =>
          patchFeedWorkState(old, ids, next),
        );
      }
      return { snapshot };
    },
    onError: (_error, _input, context) => {
      for (const [key, data] of context?.snapshot ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => {
      // Invalidate every feed page for this scope (all sources/orders/buckets)
      // plus the tenant roll-up — bulk triage invalidates every dependent count
      // and the Dashboard attention feed (§3.3). The ['intel-feed'] prefix also
      // covers the module feed behind the nav Feed badge, so the badge re-reads
      // the server's recomputed count here rather than being adjusted by hand.
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
