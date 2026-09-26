import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUser } from '@clerk/clerk-react';
import { isAxiosError } from 'axios';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import { useClientFilter } from '../../../state/client-filter.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import {
  useNewsPreferences,
  type NewsPreferences,
} from '../../../pages/dashboard/news-preferences.js';
import type {
  ComingUpItem,
  ComingUpResult,
  IntelligenceChange,
  PortfolioAlertItem,
  PortfolioAlertsResponse,
} from '../../../pages/intelligence/types.js';
import type { MeriState } from '../../../pages/engagement/meetings/meetings-types.js';
import {
  useLwNotifications,
  type LwNotification,
} from '../../pages/legiwatch/lib/wave1-api.js';
import type { DefaultXFeedAccount } from '../../pages/dashboard/x-feed-defaults.js';

/**
 * Dashboard vNext controller.
 *
 * Adapts the existing Dashboard data model into the approved presentation
 * (Figma `751:2502`). Every query below reuses the canonical endpoint *and* the
 * canonical query key, so the vNext Dashboard shares one cache with the
 * existing surfaces instead of creating a second one.
 *
 * Dashboard is always all-client: no request here takes a client filter, and
 * persisted client context is never read.
 */

/** Per-module system state. A failed request is never reported as empty. */
export type DashboardModuleState =
  | 'loading'
  | 'ready'
  | 'partial'
  | 'stale'
  | 'unavailable'
  | 'empty'
  | 'all-clear';

/**
 * Density contract (Figma `760:2695`, drawer segment `754:2851`): three modes,
 * not two. Density changes spacing and visible item count — never meaning or
 * governance, so the row budgets below only move how much is deferred to
 * "View all".
 */
export type DashboardDensity = 'presentation' | 'standard' | 'compact';

/** The optional, user-orderable modules. Needs Attention is pinned at 00. */
export type DashboardModuleKey = 'news' | 'today' | 'work' | 'xFeed';

/**
 * A module's system state as the design states it (`754:2885`): a badge, the
 * source fact that justifies the state, a headline, and the next safe action.
 * Every field is derived from a real query — a module with no honest value
 * omits it rather than inventing one.
 */
export interface ModuleStatus {
  state: DashboardModuleState;
  /** Right-aligned source fact, e.g. "2 of 3 ready" or the failing source. */
  meta: string | null;
  title: string;
  body: string;
  action: { label: string; tone: 'warning' | 'accent' | 'success' } | null;
}

export interface AttentionItem {
  id: string;
  /** Severity badge text, derived honestly: Critical / Deadline / Hearing / Budget / Legislative / Filing / Source. */
  kind: string;
  severity: 'critical' | 'high' | 'normal';
  /** Humanized `source · type` eyebrow — never a raw API enum. */
  eyebrow: string;
  title: string;
  context: string | null;
  due: string | null;
  href: string | null;
  actionLabel: string;
  /** Count of near-duplicate rows collapsed into this one (renders "+N similar"). */
  similarCount: number;
  /**
   * 'lw-notification' marks rows sourced from the durable committee/hearing
   * notification feed: the dashboard marks them read (via the lw read API)
   * before navigating, so the badge count and this module stay in sync across
   * a reload. Absent for every existing source (portfolio alerts, changes).
   */
  attentionSource?: 'lw-notification';
}

export interface NewsItem {
  id: string;
  source: string;
  title: string;
  reason: string;
  clients: string;
  url: string;
  imageUrl: string | null;
  summary?: string | null;
  /** Raw provider instant used by Dashboard v2 to interleave X + news exactly. */
  publishedAt?: string;
  publishedLabel: string;
}

export interface TodayEvent {
  id: string;
  /** Raw instant retained for Dashboard v2 day grouping/date labels. */
  startsAt?: string;
  time: string;
  title: string;
  meta: string;
  href: string | null;
  /** Figma actions: Join / Prepare / Brief / Open. */
  action: 'join' | 'prepare' | 'brief' | 'open';
  joinUrl?: string | null;
  /**
   * True only for events sourced from a real meeting. Hearings, comment
   * deadlines and other tracked items from `comingUp` are never meetings, so
   * they keep the single Prepare/Open/Brief `action` above rather than
   * rendering Join/Send Meri controls that don't apply to them.
   */
  isMeeting: boolean;
  isVirtual?: boolean;
  /** Same `/api/engagement/meetings` field HomePage's Send Meri button reads —
   * no new endpoint, just widening this projection to include it. */
  meri?: MeriState | null;
}

export interface WorkQueueEntry {
  id: string;
  kind: string;
  title: string;
  status: string;
  href: string;
}

/** X Feed subscription display item. */
export interface XFeedSubscriptionItem {
  id: string;
  accountId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
  enabled: boolean;
  sortOrder: number;
}

/** X Feed post display item. */
export interface XFeedPostItem {
  id: string;
  xPostId: string;
  text: string;
  createdAtX: string;
  media: unknown[];
  metrics: Record<string, number>;
  authorUsername: string;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
  authorVerified: boolean;
  xUrl: string;
}

/** X handle resolve result (preview before adding). */
export interface XFeedResolveResult {
  accountId: string;
  xUserId: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  verified: boolean;
}

export interface DashboardVisibility {
  today: boolean;
  work: boolean;
  news: boolean;
  xFeed: boolean;
}

/**
 * Needs Attention is restricted to externally-driven, time-sensitive work.
 * `comment_overdue` is deliberately absent: the module must not carry overdue
 * comments, generic internal reviews, assigned actions or CRM housekeeping.
 * Badge labels are sentence case (the approved design has no mono caps).
 */
const ATTENTION_ALERT_TYPES: Readonly<Record<string, { badge: string; action: string }>> = {
  comment_deadline: { badge: 'Deadline', action: 'Open' },
  hearing: { badge: 'Hearing', action: 'Prepare' },
  bill_movement: { badge: 'Legislative', action: 'Open' },
  contract_award: { badge: 'Budget', action: 'Open' },
  competitor_filing: { badge: 'Filing', action: 'Open' },
};

/** Intelligence changes that count as material funding/regulatory movement. */
const MATERIAL_CHANGE_SEVERITIES = new Set(['critical', 'high']);

const DEFAULT_VISIBILITY: DashboardVisibility = { today: true, work: true, news: true, xFeed: true };

/** Drawer order 01/02/03 (`754:2789`, `754:2797`, `754:2805`). */
const DEFAULT_ORDER: readonly DashboardModuleKey[] = ['news', 'today', 'work', 'xFeed'];

/**
 * Row budgets from the Figma layout: the modules are fixed-height cards, not
 * scrolling lists. Each card shows this many rows and defers the rest to its
 * "View all" destination. `total` still reports the true count, so capping is
 * presentational and never hides the real volume.
 *
 * Standard matches the canonical desktop artifact (`751:2502`). Presentation
 * trades items for explanation and Compact does the reverse, per the density
 * contract (`760:2695`).
 */
const ROW_LIMITS: Readonly<
  Record<DashboardDensity, { attention: number; news: number; today: number; work: number; xFeed: number }>
> = {
  presentation: { attention: 3, news: 3, today: 2, work: 2, xFeed: 3 },
  // Standard shows THREE attention rows, not four: the approved card is
  // 1120x198 = 45px header + 3 x ~51px rows. The header keeps the true total and
  // `View all` reaches the rest, so only the visible count changes here — the
  // selection taxonomy and governance logic are untouched.
  standard: { attention: 3, news: 4, today: 3, work: 3, xFeed: 5 },
  compact: { attention: 6, news: 6, today: 5, work: 5, xFeed: 8 },
};

/**
 * Mobile (`757:2622`) is a different content model, not a narrower desktop: two
 * attention rows, two stories, a single Next Meeting card and one work item.
 */
const MOBILE_ROW_LIMITS = { attention: 2, news: 2, today: 1, work: 1, xFeed: 3 } as const;

export interface DashboardVNextModel {
  header: {
    greeting: string;
    eyebrow: string;
    meta: string;
    refreshedLabel: string | null;
  };
  needsAttention: { status: ModuleStatus; items: AttentionItem[]; total: number };
  news: {
    status: ModuleStatus;
    items: NewsItem[];
    meta: string;
    preferences: NewsPreferences;
    setPreferences: (next: NewsPreferences) => void;
    unavailableReason: string | null;
    facets: { sources: string[]; topics: string[]; agencies: string[] };
  };
  today: {
    status: ModuleStatus;
    week: Array<{ id: string; weekday: string; day: string; today: boolean; hasEvents: boolean }>;
    events: TodayEvent[];
    /** Mobile replaces the whole module with this one card (`759:2683`). */
    nextMeeting: TodayEvent | null;
    /**
     * Backs the Send Meri consent flow — the same
     * `POST /api/engagement/meetings/:id/notetaker` call and consent copy
     * HomePage's dashboard strip already uses, not a new workflow.
     */
    sendMeri: {
      /** The TodayEvent.id the consent dialog is open for, or null when closed. */
      targetEventId: string | null;
      pending: boolean;
      open: (eventId: string) => void;
      close: () => void;
      submit: (meetingUrl: string) => void;
    };
  };
  workQueue: { status: ModuleStatus; items: WorkQueueEntry[]; total: number };
  xFeed: {
    status: ModuleStatus;
    subscriptions: XFeedSubscriptionItem[];
    posts: XFeedPostItem[];
    filteredAccountId: string | null;
    addSource: (username: string) => Promise<void>;
    removeSource: (subscriptionId: string) => Promise<void>;
    setFilter: (accountId: string | null) => void;
    resolveHandle: (username: string) => Promise<XFeedResolveResult | null>;
    refreshing: boolean;
    refresh: () => void;
    defaultAccounts: DefaultXFeedAccount[];
    selectedDefaultUsernames: string[];
    applyDefaultAccounts: (usernames: string[]) => Promise<void>;
  };
  visibility: DashboardVisibility;
  setVisibility: (next: DashboardVisibility) => void;
  /** User order for the optional modules; Needs Attention is never in it. */
  order: readonly DashboardModuleKey[];
  setOrder: (next: readonly DashboardModuleKey[]) => void;
  density: DashboardDensity;
  setDensity: (next: DashboardDensity) => void;
  /** Drives the mobile content model; false above the 390px stage. */
  isMobile: boolean;
  /** Backs the designed "Retry source →" action on stale/unavailable states. */
  retry: () => void;
}

/** Every query this surface owns, so "Retry source" refetches exactly them. */
const DASHBOARD_QUERY_KEYS = [
  'portfolio-alerts',
  'intel-changes-tracked',
  'coming-up',
  'engagement-meetings-week',
  'dashboard-news-custom',
  'dashboard-work-outreach',
  'dashboard-workspace-drafts',
  'x-feed-dashboard',
  'x-feed-subscriptions',
] as const;

/** The committee/hearing notification feed lives under the shared w1 prefix;
 *  retry invalidates the whole prefix so bell + dashboard recover together. */
const DASHBOARD_QUERY_PREFIXES = [['lw-w1', 'notifications'] as const] as const;

export function useDashboardVNextModel(): DashboardVNextModel {
  const api = useApi();
  const { user } = useUser();
  const me = useMe();
  const queryClient = useQueryClient();

  const retry = useCallback(() => {
    for (const key of DASHBOARD_QUERY_KEYS) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
    for (const prefix of DASHBOARD_QUERY_PREFIXES) {
      void queryClient.invalidateQueries({ queryKey: [...prefix] });
    }
  }, [queryClient]);

  // Send Meri consent flow — identical endpoint, payload and copy to the one
  // HomePage's dashboard strip already dispatches (meeting-actions.tsx's
  // NotetakerConsentFields is compliance-reviewed and must not be forked).
  const toast = useCapiroToast();
  const [sendMeriTargetId, setSendMeriTargetId] = useState<string | null>(null);
  const dispatchNotetaker = useMutation({
    mutationFn: async ({ meetingId, meetingUrl }: { meetingId: string; meetingUrl: string }) =>
      (
        await api.post(`/api/engagement/meetings/${meetingId}/notetaker`, {
          meetingUrl,
          authorizedToRecord: true,
          allPartiesWillBeNotified: true,
        })
      ).data,
    onSuccess: () => {
      toast.success('Meri is joining the meeting');
      setSendMeriTargetId(null);
      void queryClient.invalidateQueries({ queryKey: ['engagement-meetings-week'] });
    },
    onError: (error: unknown) => {
      // notetaker.service.ts's dispatch() throws a specific, actionable reason
      // for every gate it checks (tenant not enabled, unsupported join URL, a
      // notetaker already assigned, etc) — show that instead of Axios's own
      // generic "Request failed with status code ..." message.
      const backendMessage = isAxiosError(error) ? error.response?.data?.message : undefined;
      toast.error(
        typeof backendMessage === 'string' && backendMessage
          ? backendMessage
          : error instanceof Error
            ? error.message
            : 'Could not send Meri',
      );
    },
  });
  const sendMeri = {
    targetEventId: sendMeriTargetId,
    pending: dispatchNotetaker.isPending,
    open: (eventId: string) => setSendMeriTargetId(eventId),
    close: () => setSendMeriTargetId(null),
    submit: (meetingUrl: string) => {
      if (!sendMeriTargetId) return;
      // TodayEvent ids are prefixed `meeting-${id}` (vs. comingUp's `coming-${id}`)
      // to disambiguate the two sources — strip it back to the real meeting id.
      dispatchNotetaker.mutate({ meetingId: sendMeriTargetId.replace(/^meeting-/, ''), meetingUrl });
    },
  };

  const preferenceKey = useMemo(() => {
    if (!user?.id || !me.data?.tenant.id) return null;
    return `capiro:dashboard-visibility:${me.data.tenant.id}:${user.id}`;
  }, [me.data?.tenant.id, user?.id]);
  const [visibility, setVisibility] = useDashboardVisibility(preferenceKey);

  const densityKey = useMemo(() => {
    if (!user?.id || !me.data?.tenant.id) return null;
    return `capiro:dashboard-density:${me.data.tenant.id}:${user.id}`;
  }, [me.data?.tenant.id, user?.id]);
  const [density, setDensity] = useDashboardDensity(densityKey);

  const orderKey = useMemo(() => {
    if (!user?.id || !me.data?.tenant.id) return null;
    return `capiro:dashboard-order:${me.data.tenant.id}:${user.id}`;
  }, [me.data?.tenant.id, user?.id]);
  const [order, setOrder] = useDashboardOrder(orderKey);

  const isMobile = useIsMobile();
  const limits = isMobile ? MOBILE_ROW_LIMITS : ROW_LIMITS[density];

  // Acceptance A (`760:2740`): the Dashboard has no client picker *and* clears
  // hidden client scope before loading, so a selection persisted on another
  // surface can never silently narrow a portfolio-wide view.
  const { selectedClientId, setSelectedClientId } = useClientFilter();
  useEffect(() => {
    if (selectedClientId !== null) setSelectedClientId(null);
  }, [selectedClientId, setSelectedClientId]);

  const newsPreferenceKey = useMemo(() => {
    if (!user?.id || !me.data?.tenant.id) return null;
    return `capiro:dashboard-news:${me.data.tenant.id}:${user.id}`;
  }, [me.data?.tenant.id, user?.id]);
  const [newsPreferences, setNewsPreferences] = useNewsPreferences(newsPreferenceKey);

  /* ── Canonical queries (same keys as the existing Dashboard) ─────────── */

  const portfolioAlerts = useQuery<PortfolioAlertsResponse>({
    queryKey: ['portfolio-alerts'],
    queryFn: async () =>
      (
        await api.get<PortfolioAlertsResponse>('/api/intelligence/portfolio-alerts', {
          params: { limit: 30 },
        })
      ).data,
    staleTime: 2 * 60 * 1000,
  });

  // Durable committee/hearing notifications for followed committees. UNREAD
  // only — Needs Attention is a triage surface, not the read-history inbox.
  const lwNotifications = useLwNotifications(true);

  const recentChanges = useQuery<IntelligenceChange[]>({
    queryKey: ['intel-changes-tracked'],
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      return (
        await api.get<IntelligenceChange[]>('/api/intelligence/changes', { params: { since } })
      ).data;
    },
    staleTime: 2 * 60 * 1000,
  });

  const comingUp = useQuery<ComingUpResult>({
    queryKey: ['coming-up'],
    queryFn: async () => (await api.get<ComingUpResult>('/api/intelligence/coming-up')).data,
    staleTime: 5 * 60 * 1000,
  });

  const week = useMemo(() => weekBounds(new Date()), []);
  const meetings = useQuery<DashMeeting[]>({
    queryKey: ['engagement-meetings-week', week.from, week.to],
    queryFn: async () =>
      (
        await api.get<DashMeeting[]>('/api/engagement/meetings', {
          params: { from: week.from, to: week.to },
        })
      ).data,
    staleTime: 60_000,
  });

  const newsParams = useMemo(
    () => ({
      corpus: 'explorer',
      q: newsPreferences.customTopics.join(','),
      sources: newsPreferences.sources.join(','),
      topics: newsPreferences.articleTopics.join(','),
      agencies: newsPreferences.agencies.join(','),
      lookback: newsPreferences.lookback,
    }),
    [newsPreferences],
  );

  const news = useQuery<NewsDashboardResponse>({
    queryKey: ['dashboard-news-custom', newsParams],
    queryFn: async () =>
      (
        await api.get<NewsDashboardResponse>('/api/intelligence/news/dashboard', {
          params: newsParams,
        })
      ).data,
    staleTime: 15 * 60 * 1000,
    retry: false,
    enabled: visibility.news,
  });

  const newsFacets = useQuery<{ sources: string[]; topics: string[]; agencies: string[] }>({
    queryKey: ['explorer-article-facets'],
    queryFn: async () => (await api.get('/api/explorer/intel-article-facets')).data,
    staleTime: 10 * 60 * 1000,
  });

  const outreach = useQuery<DashOutreach[]>({
    queryKey: ['dashboard-work-outreach'],
    queryFn: async () =>
      (await api.get<DashOutreach[]>('/api/engagement/outreach', { params: { limit: 50 } })).data,
    staleTime: 60_000,
    enabled: visibility.work,
  });

  const workspaceDrafts = useQuery<DashWorkspaceDraft[]>({
    queryKey: ['dashboard-workspace-drafts'],
    queryFn: async () =>
      (
        await api.get<{ drafts: DashWorkspaceDraft[] }>('/workspace-api/drafts', {
          params: { scope: 'all' },
        })
      ).data.drafts,
    staleTime: 60_000,
    retry: false,
    enabled: visibility.work,
  });

  /* ── Needs Attention ──────────────────────────────────────────────────── */

  const needsAttention = useMemo(() => {
    const ordered = selectAttentionItems({
      alerts: portfolioAlerts.data?.alerts ?? [],
      changes: recentChanges.data ?? [],
      failedSourceReason:
        visibility.news && news.data && !news.data.available ? (news.data.reason ?? null) : null,
      lwNotifications: lwNotifications.data?.rows ?? [],
    });

    const status = buildStatus({
      sources: [
        {
          name: 'Portfolio alerts',
          isLoading: portfolioAlerts.isLoading,
          isError: portfolioAlerts.isError,
          updatedAt: portfolioAlerts.dataUpdatedAt,
        },
        {
          name: 'Intelligence changes',
          isLoading: recentChanges.isLoading,
          isError: recentChanges.isError,
          updatedAt: recentChanges.dataUpdatedAt,
        },
        {
          name: 'Committee notifications',
          isLoading: lwNotifications.isLoading,
          isError: lwNotifications.isError,
          updatedAt: lwNotifications.dataUpdatedAt,
        },
      ],
      hidden: false,
      emptyKind: 'all-clear',
      emptyTitle: 'No time-sensitive items need attention',
      emptyBody: 'Confirm the clear state and show when the next refresh will run.',
      emptyMeta: portfolioAlerts.dataUpdatedAt
        ? `Checked ${clockTime(portfolioAlerts.dataUpdatedAt)}`
        : null,
      itemCount: ordered.length,
    });

    // Dashboard v2 owns the four-tile ribbon budget and its View all expansion.
    // Keep the adapter semantically complete so density never becomes truth.
    return { status, items: ordered, total: ordered.length };
  }, [
    portfolioAlerts.data,
    portfolioAlerts.dataUpdatedAt,
    portfolioAlerts.isError,
    portfolioAlerts.isLoading,
    recentChanges.data,
    recentChanges.dataUpdatedAt,
    recentChanges.isError,
    recentChanges.isLoading,
    lwNotifications.data,
    lwNotifications.dataUpdatedAt,
    lwNotifications.isError,
    lwNotifications.isLoading,
    news.data,
    visibility.news,
    limits.attention,
  ]);

  /* ── News & Narrative ─────────────────────────────────────────────────── */

  const newsModule = useMemo(() => {
    const base = {
      preferences: newsPreferences,
      setPreferences: setNewsPreferences,
      facets: {
        sources: newsFacets.data?.sources ?? [],
        topics: newsFacets.data?.topics ?? [],
        agencies: newsFacets.data?.agencies ?? [],
      },
    };

    /** Subscription breadth, for the EMPTY state's "N active filters". */
    const activeFilters =
      newsPreferences.articleTopics.length +
      newsPreferences.sources.length +
      newsPreferences.agencies.length +
      newsPreferences.customTopics.length;

    if (!visibility.news) {
      return {
        ...base,
        status: buildStatus({
          sources: [],
          hidden: true,
          emptyKind: 'empty',
          emptyTitle: 'News & Narrative is hidden',
          emptyBody: 'Turn the module back on from Customize Dashboard.',
          itemCount: 0,
        }),
        items: [],
        meta: '',
        unavailableReason: null,
      };
    }

    const data = news.data;
    // The feed reports its own availability, so a reachable endpoint that
    // cannot serve a source is still SOURCE UNAVAILABLE — not an empty feed.
    const sourceDown = news.isError || Boolean(data && !data.available);
    const failingSource = news.isError
      ? 'News'
      : (newsReasonLabel(data?.reason) ?? 'News');

    if (sourceDown) {
      return {
        ...base,
        status: {
          state: 'unavailable' as DashboardModuleState,
          meta: failingSource,
          title: 'News source is temporarily unavailable',
          body: 'Keep the module visible, identify the failing source, and never convert missing data to zero.',
          action: { label: 'Retry source', tone: 'warning' as const },
        },
        items: [],
        meta: '',
        unavailableReason: news.isError ? 'News could not be loaded.' : newsReasonLabel(data?.reason),
      };
    }

    if (news.isLoading || !data) {
      return {
        ...base,
        status: buildStatus({
          sources: [
            { name: 'News', isLoading: true, isError: false, updatedAt: news.dataUpdatedAt },
          ],
          hidden: false,
          emptyKind: 'empty',
          emptyTitle: '',
          emptyBody: '',
          itemCount: 0,
        }),
        items: [],
        meta: '',
        unavailableReason: null,
      };
    }

    const items = data.items.map<NewsItem>((item) => ({
      id: item.id,
      source: `${item.source.toUpperCase()} · ${relativeDay(item.publishedAt)}`,
      title: item.title,
      reason: item.relevanceReason,
      clients: item.clientMatches.map((client) => client.name).join(', '),
      url: item.url,
      imageUrl: item.imageUrl,
      summary: item.summary ?? null,
      publishedAt: item.publishedAt,
      publishedLabel: relativeDay(item.publishedAt),
    }));

    const meta = data.provider === 'intel-article'
      ? 'Shared Data Explorer news'
      : data.coverageLimited
        ? `${data.monitoredClientCount} of ${data.activeClientCount} clients monitored`
        : `${data.monitoredClientCount} clients monitored`;

    if (items.length === 0) {
      return {
        ...base,
        status: {
          state: 'empty' as DashboardModuleState,
          meta: activeFilters > 0 ? `${activeFilters} active filter${activeFilters === 1 ? '' : 's'}` : null,
          title: 'No stories match this subscription',
          body: 'Offer Customize feed and preserve the active subscription summary.',
          action: { label: 'Customize feed', tone: 'accent' as const },
        },
        items,
        meta,
        unavailableReason: null,
      };
    }

    if (data.stale) {
      return {
        ...base,
        status: {
          state: 'stale' as DashboardModuleState,
          meta: news.dataUpdatedAt ? `Last success ${relativeAge(news.dataUpdatedAt)}` : null,
          title: news.dataUpdatedAt
            ? `Showing results from ${clockTime(news.dataUpdatedAt)}`
            : 'Showing the last good result',
          body: 'Preserve the last good result, display its age, and offer a controlled retry.',
          action: { label: 'Retry source', tone: 'warning' as const },
        },
        // The Wire applies one combined density cap after X + news are interleaved.
        items,
        meta,
        unavailableReason: null,
      };
    }

    return {
      ...base,
      status: { state: 'ready' as DashboardModuleState, meta: null, title: '', body: '', action: null },
      items,
      meta,
      unavailableReason: null,
    };
  }, [
    news.data,
    news.dataUpdatedAt,
    news.isError,
    news.isLoading,
    newsPreferences,
    setNewsPreferences,
    visibility.news,
    limits.news,
  ]);

  /* ── Today & Coming Up ────────────────────────────────────────────────── */

  const today = useMemo(() => {
    const status = buildStatus({
      sources: [
        {
          name: 'Meetings',
          isLoading: meetings.isLoading,
          isError: meetings.isError,
          updatedAt: meetings.dataUpdatedAt,
        },
        {
          name: 'Coming up',
          isLoading: comingUp.isLoading,
          isError: comingUp.isError,
          updatedAt: comingUp.dataUpdatedAt,
        },
      ],
      hidden: !visibility.today,
      emptyKind: 'empty',
      emptyTitle: visibility.today ? 'Nothing scheduled in this window' : 'Today & Coming Up is hidden',
      emptyBody: visibility.today
        ? 'No meetings, hearings or deadlines fall inside the current week.'
        : 'Turn the module back on from Customize Dashboard.',
      itemCount: 1,
    });

    if (status.state === 'loading' || status.state === 'unavailable' || !visibility.today) {
      return { status, week: weekStrip(new Set()), events: [], nextMeeting: null };
    }

    // Ordering must use the real instant, not the rendered time string: the
    // week query returns every day's meetings, so sorting by "10:00 AM" alone
    // interleaves each day's recurring standup into one indistinguishable list.
    // See mergeTodayEvents for the meeting/coming-up pairing rules.
    const dated = mergeTodayEvents(meetings.data ?? [], comingUp.data?.items ?? []);

    // Past events are not "today and coming up".
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    // Real calendars carry noise the mockup never shows: the same recurring
    // meeting duplicated per source, and cancelled holds. Collapse identical
    // title+instant pairs and drop cancellations.
    const seen = new Set<string>();
    const upcoming = dated
      .filter((event) => event.at >= startOfToday.getTime())
      .filter((event) => !/^cancell?ed:/i.test(event.title.trim()))
      .sort((a, b) => a.at - b.at)
      .filter((event) => {
        const key = `${event.at}|${event.title.trim().toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const eventDays = new Set(
      upcoming
        .filter((event) => event.at !== Number.MAX_SAFE_INTEGER)
        .map((event) => new Date(event.at).toDateString()),
    );
    // Dashboard v2 owns TODAY / TOMORROW / LATER THIS WEEK grouping.
    const events: TodayEvent[] = upcoming.map(({ at: _at, ...event }) => event);

    // Mobile shows the next *meeting*, not the next tracked policy event, so
    // pick the first joinable/preparable item rather than events[0].
    const nextMeeting =
      upcoming
        .filter((event) => event.action !== 'open')
        .map(({ at: _at, ...event }) => event)[0] ?? null;

    if (events.length === 0) {
      return {
        status: {
          ...status,
          state: 'empty' as DashboardModuleState,
          title: 'Nothing scheduled in this window',
          body: 'No meetings, hearings or deadlines fall inside the current week.',
        },
        week: weekStrip(new Set()),
        events,
        nextMeeting: null,
      };
    }

    return { status, week: weekStrip(eventDays), events, nextMeeting };
  }, [
    comingUp.data,
    comingUp.dataUpdatedAt,
    comingUp.isError,
    comingUp.isLoading,
    meetings.data,
    meetings.dataUpdatedAt,
    meetings.isError,
    meetings.isLoading,
    visibility.today,
    limits.today,
  ]);

  /* ── Work Queue (outreach + governed work documents only) ─────────────── */

  const workQueue = useMemo(() => {
    const items: WorkQueueEntry[] = [];

    for (const draft of outreach.data ?? []) {
      if (draft.status !== 'draft') continue;
      const ready = Boolean(draft.body?.trim() && draft.recipientCount > 0);
      items.push({
        id: `outreach-${draft.id}`,
        kind: 'OUTREACH',
        title: draft.title,
        status: ready ? 'Ready to send' : 'Draft',
        href: `/engagement/outreach/draft/${encodeURIComponent(draft.id)}`,
      });
    }

    for (const document of workspaceDrafts.data ?? []) {
      if (document.status !== 'draft') continue;
      items.push({
        id: `workspace-${document.id}`,
        kind: 'DOCUMENT',
        title: document.docTitle || 'Untitled document',
        status: 'Draft',
        href: `/workspace/draft/${encodeURIComponent(document.id)}`,
      });
    }

    const status = buildStatus({
      sources: [
        {
          name: 'Outreach',
          isLoading: outreach.isLoading,
          isError: outreach.isError,
          updatedAt: outreach.dataUpdatedAt,
        },
        {
          name: 'Work documents',
          isLoading: workspaceDrafts.isLoading,
          isError: workspaceDrafts.isError,
          updatedAt: workspaceDrafts.dataUpdatedAt,
        },
      ],
      hidden: !visibility.work,
      emptyKind: 'empty',
      emptyTitle: visibility.work ? 'No open drafts' : 'Work Queue is hidden',
      emptyBody: visibility.work
        ? 'Outreach drafts and work documents appear here once one is in progress.'
        : 'Turn the module back on from Customize Dashboard.',
      itemCount: items.length,
    });

    if (status.state !== 'ready') {
      return { status, items: [], total: items.length };
    }

    // Dashboard v2 applies its 3 / 4 / 5 density budget in the Work Queue view.
    return { status, items, total: items.length };
  }, [
    outreach.data,
    outreach.dataUpdatedAt,
    outreach.isError,
    outreach.isLoading,
    workspaceDrafts.data,
    workspaceDrafts.dataUpdatedAt,
    workspaceDrafts.isError,
    workspaceDrafts.isLoading,
    visibility.work,
    limits.work,
  ]);

  /* ── X Intelligence Feed ───────────────────────────────────────────────── */

  const [xFeedFilter, setXFeedFilter] = useState<string | null>(null);

  const xFeedDashboard = useQuery<XFeedDashboardResponse>({
    queryKey: ['x-feed-dashboard', xFeedFilter],
    queryFn: async () =>
      (
        await api.get<XFeedDashboardResponse>('/api/intelligence/x-feed/dashboard', {
          params: xFeedFilter ? { accountId: xFeedFilter } : {},
        })
      ).data,
    staleTime: 5 * 60 * 1000,
    enabled: visibility.xFeed,
  });

  const xFeedSubscriptions = useQuery({
    queryKey: ['x-feed-subscriptions'],
    queryFn: async () =>
      (await api.get('/api/intelligence/x-feed/subscriptions')).data as XFeedSubscriptionItem[],
    staleTime: 60_000,
  });

  const xFeedDefaults = useQuery<DefaultXFeedAccount[]>({
    queryKey: ['x-feed-defaults'],
    queryFn: async () => (await api.get<DefaultXFeedAccount[]>('/api/intelligence/x-feed/defaults')).data,
    staleTime: 60 * 60 * 1000,
    enabled: visibility.xFeed,
  });

  const xFeedAddMutation = useMutation({
    mutationFn: async (username: string) =>
      (await api.post('/api/intelligence/x-feed/subscriptions', { username })).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['x-feed-subscriptions'] });
      void queryClient.invalidateQueries({ queryKey: ['x-feed-dashboard'] });
    },
  });

  const xFeedRemoveMutation = useMutation({
    mutationFn: async (subscriptionId: string) =>
      api.delete(`/api/intelligence/x-feed/subscriptions/${subscriptionId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['x-feed-subscriptions'] });
      void queryClient.invalidateQueries({ queryKey: ['x-feed-dashboard'] });
    },
  });

  const xFeedRefreshMutation = useMutation({
    mutationFn: async () => (await api.post('/api/intelligence/x-feed/refresh')).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['x-feed-dashboard'] });
    },
  });

  const xFeedModule = useMemo<DashboardVNextModel['xFeed']>(() => {
    // Shared defaults wiring — every branch below must honor the user's
    // "Save default accounts" action, not just the fully-loaded one.
    const sharedDefaults = {
      defaultAccounts: xFeedDefaults.data ?? [],
      selectedDefaultUsernames: ((xFeedDashboard.data?.subscriptions ?? xFeedSubscriptions.data ?? []) as XFeedSubscriptionItem[])
        .filter((sub) => xFeedDefaults.data?.some((account) => account.username.toLowerCase() === sub.username.toLowerCase()))
        .map((sub) => sub.username),
      applyDefaultAccounts: async (usernames: string[]) => {
        // Await the POST and the subscription refetch so the Customize drawer
        // can keep the draft selection visible until the server selection is
        // actually reflected in selectedDefaultUsernames. Fire-and-forget
        // invalidation left a window where dirty=false and stale subs made
        // every checkbox snap back to the pre-save state.
        await api.post('/api/intelligence/x-feed/defaults', { usernames });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['x-feed-subscriptions'] }),
          queryClient.invalidateQueries({ queryKey: ['x-feed-dashboard'] }),
          queryClient.invalidateQueries({ queryKey: ['x-feed-defaults'] }),
        ]);
        await Promise.all([
          queryClient.refetchQueries({ queryKey: ['x-feed-subscriptions'] }),
          queryClient.refetchQueries({ queryKey: ['x-feed-dashboard'] }),
        ]);
      },
    };

    if (!visibility.xFeed) {
      return {
        status: buildStatus({
          sources: [],
          hidden: true,
          emptyKind: 'empty',
          emptyTitle: 'X Intelligence is hidden',
          emptyBody: 'Turn the module back on from Customize Dashboard.',
          itemCount: 0,
        }),
        subscriptions: [],
        posts: [],
        filteredAccountId: xFeedFilter,
        addSource: async () => {},
        removeSource: async () => {},
        setFilter: () => {},
        resolveHandle: async () => null,
        refreshing: false,
        refresh: () => {},
        ...sharedDefaults,
      };
    }

    const data = xFeedDashboard.data;
    const subs = (data?.subscriptions ?? xFeedSubscriptions.data ?? []) as XFeedSubscriptionItem[];

    // Provider not configured — honest unavailable state, no fake posts.
    if (data && !data.available) {
      return {
        status: {
          state: 'unavailable' as DashboardModuleState,
          meta: data.reason === 'not_configured' ? 'Not configured' : 'X API unavailable',
          title:
            data.reason === 'not_configured'
              ? 'X Intelligence is not configured yet'
              : 'X API is temporarily unavailable',
          body:
            data.reason === 'not_configured'
              ? 'Add an X account to get started. The administrator may need to configure the X API token.'
              : 'The X API could not be reached. Try again shortly.',
          action: { label: 'Retry source', tone: 'warning' as const },
        },
        subscriptions: subs,
        posts: [],
        filteredAccountId: xFeedFilter,
        addSource: async (username: string) => {
          await xFeedAddMutation.mutateAsync(username);
        },
        removeSource: async (subscriptionId: string) => {
          await xFeedRemoveMutation.mutateAsync(subscriptionId);
        },
        setFilter: setXFeedFilter,
        resolveHandle: async (username: string) => {
          try {
            return (await api.get('/api/intelligence/x-feed/resolve', { params: { username } }))
              .data as XFeedResolveResult;
          } catch {
            return null;
          }
        },
        refreshing: xFeedRefreshMutation.isPending,
        refresh: () => void xFeedRefreshMutation.mutate(),
        ...sharedDefaults,
      };
    }

    if (xFeedDashboard.isLoading || (!data && !xFeedDashboard.isError)) {
      return {
        status: buildStatus({
          sources: [{ name: 'X Feed', isLoading: true, isError: false, updatedAt: xFeedDashboard.dataUpdatedAt }],
          hidden: false,
          emptyKind: 'empty',
          emptyTitle: '',
          emptyBody: '',
          itemCount: 0,
        }),
        subscriptions: subs,
        posts: [],
        filteredAccountId: xFeedFilter,
        addSource: async (username: string) => {
          await xFeedAddMutation.mutateAsync(username);
        },
        removeSource: async (subscriptionId: string) => {
          await xFeedRemoveMutation.mutateAsync(subscriptionId);
        },
        setFilter: setXFeedFilter,
        resolveHandle: async (username: string) => {
          try {
            return (await api.get('/api/intelligence/x-feed/resolve', { params: { username } }))
              .data as XFeedResolveResult;
          } catch {
            return null;
          }
        },
        refreshing: xFeedRefreshMutation.isPending,
        refresh: () => void xFeedRefreshMutation.mutate(),
        ...sharedDefaults,
      };
    }

    if (xFeedDashboard.isError) {
      return {
        status: {
          state: 'unavailable' as DashboardModuleState,
          meta: 'X Feed',
          title: 'X Intelligence source is temporarily unavailable',
          body: 'The X API could not be reached. Try again shortly.',
          action: { label: 'Retry source', tone: 'warning' as const },
        },
        subscriptions: subs,
        posts: [],
        filteredAccountId: xFeedFilter,
        addSource: async (username: string) => {
          await xFeedAddMutation.mutateAsync(username);
        },
        removeSource: async (subscriptionId: string) => {
          await xFeedRemoveMutation.mutateAsync(subscriptionId);
        },
        setFilter: setXFeedFilter,
        resolveHandle: async (username: string) => {
          try {
            return (await api.get('/api/intelligence/x-feed/resolve', { params: { username } }))
              .data as XFeedResolveResult;
          } catch {
            return null;
          }
        },
        refreshing: xFeedRefreshMutation.isPending,
        refresh: () => void xFeedRefreshMutation.mutate(),
        ...sharedDefaults,
      };
    }

    const posts = (data?.posts ?? []) as XFeedPostItem[];

    // Empty state: no subscriptions yet → show setup CTA.
    if (subs.filter((s) => s.enabled).length === 0) {
      return {
        status: {
          state: 'empty' as DashboardModuleState,
          meta: null,
          title: 'Follow the people and organizations that matter to your work.',
          body: 'Add an X account to start seeing posts in your dashboard feed.',
          action: null,
        },
        subscriptions: subs,
        posts: [],
        filteredAccountId: xFeedFilter,
        addSource: async (username: string) => {
          await xFeedAddMutation.mutateAsync(username);
        },
        removeSource: async (subscriptionId: string) => {
          await xFeedRemoveMutation.mutateAsync(subscriptionId);
        },
        setFilter: setXFeedFilter,
        resolveHandle: async (username: string) => {
          try {
            return (await api.get('/api/intelligence/x-feed/resolve', { params: { username } }))
              .data as XFeedResolveResult;
          } catch {
            return null;
          }
        },
        refreshing: xFeedRefreshMutation.isPending,
        refresh: () => void xFeedRefreshMutation.mutate(),
        ...sharedDefaults,
      };
    }

    // No posts but subscriptions exist — could be no recent tweets.
    if (posts.length === 0) {
      return {
        status: {
          state: 'empty' as DashboardModuleState,
          meta: `${subs.filter((s) => s.enabled).length} account${subs.filter((s) => s.enabled).length === 1 ? '' : 's'}`,
          title: 'No recent posts from your followed accounts',
          body: 'Posts will appear here when the accounts you follow publish new content.',
          action: { label: 'Retry source', tone: 'warning' as const },
        },
        subscriptions: subs,
        posts: [],
        filteredAccountId: xFeedFilter,
        addSource: async (username: string) => {
          await xFeedAddMutation.mutateAsync(username);
        },
        removeSource: async (subscriptionId: string) => {
          await xFeedRemoveMutation.mutateAsync(subscriptionId);
        },
        setFilter: setXFeedFilter,
        resolveHandle: async (username: string) => {
          try {
            return (await api.get('/api/intelligence/x-feed/resolve', { params: { username } }))
              .data as XFeedResolveResult;
          } catch {
            return null;
          }
        },
        refreshing: xFeedRefreshMutation.isPending,
        refresh: () => void xFeedRefreshMutation.mutate(),
        ...sharedDefaults,
      };
    }

    return {
      status: { state: 'ready' as DashboardModuleState, meta: null, title: '', body: '', action: null },
      subscriptions: subs,
      posts,
      filteredAccountId: xFeedFilter,
      addSource: async (username: string) => {
        await xFeedAddMutation.mutateAsync(username);
      },
      removeSource: async (subscriptionId: string) => {
        await xFeedRemoveMutation.mutateAsync(subscriptionId);
      },
      setFilter: setXFeedFilter,
      resolveHandle: async (username: string) => {
        try {
          return (await api.get('/api/intelligence/x-feed/resolve', { params: { username } }))
            .data as XFeedResolveResult;
        } catch {
          return null;
        }
      },
      refreshing: xFeedRefreshMutation.isPending,
      refresh: () => void xFeedRefreshMutation.mutate(),
      defaultAccounts: sharedDefaults.defaultAccounts,
      selectedDefaultUsernames: sharedDefaults.selectedDefaultUsernames,
      applyDefaultAccounts: sharedDefaults.applyDefaultAccounts,
    };
  }, [
    visibility.xFeed,
    xFeedDashboard.data,
    xFeedDashboard.dataUpdatedAt,
    xFeedDashboard.isError,
    xFeedDashboard.isLoading,
    xFeedSubscriptions.data,
    xFeedFilter,
    xFeedAddMutation,
    xFeedRemoveMutation,
    xFeedRefreshMutation,
    xFeedDefaults.data,
    api,
  ]);

  /* ── Header ───────────────────────────────────────────────────────────── */

  const header = useMemo(() => {
    const overnight = (recentChanges.data ?? []).filter(
      (change) => new Date(change.detectedAt).getTime() >= Date.now() - 24 * 60 * 60 * 1000,
    ).length;

    // The approved subhead is the date + counts line only — no
    // "COMMAND DASHBOARD · ALL CLIENTS" mono-caps prefix. Sentence case,
    // Inter, gray-500.
    const metaParts = [formatToday(), `${overnight} signals overnight`];
    if (needsAttention.total > 0) {
      metaParts.push(`${needsAttention.total} time-sensitive item${needsAttention.total === 1 ? '' : 's'}`);
    }

    return {
      greeting: `${greetingFor(new Date())}${me.data?.user.firstName ? `, ${me.data.user.firstName}` : ''}.`,
      eyebrow: '',
      meta: metaParts.join(' · '),
      refreshedLabel: portfolioAlerts.data?.generatedAt
        ? `Refreshed ${new Date(portfolioAlerts.data.generatedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
        : null,
    };
  }, [me.data?.user.firstName, needsAttention.total, portfolioAlerts.data?.generatedAt, recentChanges.data]);

  return {
    header,
    needsAttention,
    news: newsModule,
    today: { ...today, sendMeri },
    workQueue,
    xFeed: xFeedModule,
    visibility,
    setVisibility,
    order,
    setOrder,
    density,
    setDensity,
    isMobile,
    retry,
  };
}

/* ── Local projections of the canonical API responses ───────────────────── */

interface DashMeeting {
  id: string;
  subject: string;
  location: string | null;
  metadata: Record<string, unknown> | null;
  startsAt: string;
  client: { id: string; name: string } | null;
  preps: Array<{ status: string }>;
  isVirtual?: boolean;
  joinLink?: string | null;
  meri?: MeriState | null;
}

interface DashOutreach {
  id: string;
  title: string;
  body: string | null;
  status: 'draft' | 'sent' | 'opened_in_email' | 'failed';
  recipientCount: number;
  updatedAt: string;
}

interface DashWorkspaceDraft {
  id: string;
  docTitle: string;
  status: 'draft' | 'complete';
  updatedAt: string;
}

/** X Feed dashboard API response shape. */
interface XFeedDashboardResponse {
  available: boolean;
  reason: string | null;
  subscriptions: XFeedSubscriptionItem[];
  posts: XFeedPostItem[];
  filteredAccount: string | null;
}

interface NewsDashboardResponse {
  available: boolean;
  provider?: 'newscatcher' | 'intel-article';
  items: Array<{
    id: string;
    title: string;
    source: string;
    url: string;
    imageUrl: string | null;
    summary?: string | null;
    publishedAt: string;
    clientMatches: Array<{ id: string; name: string }>;
    relevanceReason: string;
  }>;
  stale?: boolean;
  reason?: 'not_configured' | 'no_clients' | 'provider_unavailable' | 'no_articles';
  monitoredClientCount?: number;
  activeClientCount?: number;
  coverageLimited?: boolean;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/**
 * Pure Needs Attention selection.
 *
 * The module carries only externally-driven, time-sensitive work: external
 * deadlines, material funding changes, hearings and preparation windows,
 * time-sensitive legislative/regulatory developments, and material source
 * failures. Alert types outside {@link ATTENTION_ALERT_TYPES} — notably
 * `comment_overdue` — are excluded, as are internal reviews, assigned actions
 * and CRM housekeeping, which live on their own surfaces. Work Queue items are
 * never duplicated here.
 */
export function selectAttentionItems({
  alerts,
  changes,
  failedSourceReason,
  lwNotifications,
}: {
  alerts: readonly PortfolioAlertItem[];
  changes: readonly IntelligenceChange[];
  failedSourceReason: 'not_configured' | 'no_clients' | 'provider_unavailable' | 'no_articles' | null;
  /** Unread committee/hearing notifications (followed committees). Unread
   *  only — read history belongs to the inbox, never to Needs Attention. */
  lwNotifications?: readonly LwNotification[];
}): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const alert of alerts) {
    const mapping = ATTENTION_ALERT_TYPES[alert.type];
    if (!mapping) continue;
    items.push(attentionFromAlert(alert, mapping));
  }

  // Material funding/regulatory movement the alert roll-up does not carry.
  //
  // Severity alone is not sufficient. `/api/intelligence/changes` is the
  // ingestion feed behind the Changes Inbox, and it emits portfolio-wide
  // pipeline counters ("379954 new LDA filings synced") at high severity. Those
  // are housekeeping, not client-facing work, so an item must additionally be
  // attributable to at least one client to qualify.
  for (const change of changes) {
    if (!MATERIAL_CHANGE_SEVERITIES.has(change.severity)) continue;
    if ((change.relatedClientIds?.length ?? 0) === 0) continue;
    const severity = change.severity === 'critical' ? 'critical' : 'high';
    items.push({
      id: `change-${change.id}`,
      // Derive the badge from severity honestly — never BUDGET on everything.
      kind: severity === 'critical' ? 'Critical' : 'Budget',
      severity,
      // Humanize the source enum at the view-model boundary
      // (FEDERAL_REGISTER → Federal Register), never in the component.
      eyebrow: humanizeSourceLabel(change.source),
      title: change.title,
      context: change.description || null,
      due: relativeDay(change.detectedAt),
      href: '/explorer',
      actionLabel: 'Open',
      similarCount: 0,
      // Grouping key: same source + same calendar day collapses near-duplicates.
      ...attentionGroupKey(change.source, change.detectedAt),
    } as AttentionItem & { _group: string });
  }

  // Followed-committee alerts: new hearings and committee publications
  // ("What has been published"). These are ROUTINE signals — severity normal —
  // so they never outrank legitimate critical/high portfolio work. UNREAD rows
  // only (the feed is asked for unreadOnly, but a defensive filter keeps a
  // cached full-history response from leaking read rows in). Stable identity
  // is the server's durable notification id; destination is always the
  // server-provided deepLink.
  for (const n of lwNotifications ?? []) {
    if (n.read) continue;
    items.push({
      id: `lw-notif-${n.id}`,
      kind: n.eventType === 'committee_publication' ? 'Publication' : 'Hearing',
      severity: 'normal',
      eyebrow: n.eventType === 'committee_publication' ? 'Committee publication' : 'Committee alert',
      title: n.title,
      context: n.body || null,
      due: relativeDay(n.createdAt),
      href: n.deepLink || null,
      actionLabel: 'Open',
      similarCount: 0,
      attentionSource: 'lw-notification',
      // Carried to the final sort: newest unread committee item first among
      // normal-severity rows.
      _sortAt: Date.parse(n.createdAt) || 0,
    } as AttentionItem & { _sortAt: number });
  }

  // A failed source is itself actionable and must never be silently hidden.
  // `no_clients` is a configuration state, not a failure, so it is not raised.
  if (failedSourceReason === 'provider_unavailable' || failedSourceReason === 'not_configured') {
    items.push({
      id: 'source-news',
      kind: 'Source',
      severity: 'high',
      eyebrow: 'Source failure',
      title:
        failedSourceReason === 'not_configured'
          ? 'News ingestion is not configured'
          : 'News provider is unavailable',
      context: 'News & Narrative cannot refresh until this is resolved.',
      due: null,
      href: '/settings/integrations',
      actionLabel: 'Resolve',
      similarCount: 0,
    });
  }

  return collapseSimilarAttentionItems(
    items.sort((a, b) => {
      const rank = severityRank(a.severity) - severityRank(b.severity);
      if (rank !== 0) return rank;
      // Within a severity band, newest first — a freshly-arrived committee
      // alert must never sit below an older same-severity row.
      const aAt = (a as AttentionItem & { _sortAt?: number })._sortAt ?? 0;
      const bAt = (b as AttentionItem & { _sortAt?: number })._sortAt ?? 0;
      return bAt - aAt;
    }),
  );
}

/** Internal grouping key carried on change rows until collapsed. */
function attentionGroupKey(source: string, detectedAt: string): { _group: string } {
  const day = new Date(detectedAt);
  const dayKey = Number.isNaN(day.getTime()) ? detectedAt : day.toDateString();
  return { _group: `${source}::${dayKey}` };
}

/**
 * Collapse near-duplicate rows from the same source and day into one row with
 * a `+N similar` affordance. Only intelligence-change rows (which carry the
 * `_group` key) are eligible — alerts are distinct client work and never merge.
 */
function collapseSimilarAttentionItems(items: AttentionItem[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  const groupIndex = new Map<string, AttentionItem>();
  for (const item of items) {
    const group = (item as AttentionItem & { _group?: string })._group;
    if (!group) {
      const { _sortAt: _omitAt, ...clean } = item as AttentionItem & { _sortAt?: number };
      out.push(clean);
      continue;
    }
    const existing = groupIndex.get(group);
    if (existing) {
      existing.similarCount += 1;
      continue;
    }
    const { _group: _omit, _sortAt: _omitAt, ...clean } = item as AttentionItem & {
      _group?: string;
      _sortAt?: number;
    };
    const row: AttentionItem = { ...clean, similarCount: 0 };
    groupIndex.set(group, row);
    out.push(row);
  }
  return out;
}

/** Humanize an API source/type enum: FEDERAL_REGISTER → Federal Register, PROPOSED_RULE → Comment period. */
function humanizeSourceLabel(value: string): string {
  const overrides: Record<string, string> = {
    PROPOSED_RULE: 'Comment period',
    FINAL_RULE: 'Final rule',
  };
  if (overrides[value]) return overrides[value]!;
  return value
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function attentionFromAlert(
  alert: PortfolioAlertItem,
  mapping: { badge: string; action: string },
): AttentionItem {
  const severity: AttentionItem['severity'] =
    alert.severity === 'critical' ? 'critical' : alert.severity === 'high' ? 'high' : 'normal';
  return {
    id: `alert-${alert.id}`,
    // Severity is derived honestly: a critical alert badges Critical; otherwise
    // the badge names the kind of work (Deadline / Hearing / …) and tone carries
    // the urgency. Never a mono-caps BUDGET-style stamp on every row.
    kind: severity === 'critical' ? 'Critical' : mapping.badge,
    severity,
    // Client name in sentence case — no mono-caps eyebrow.
    eyebrow: alert.clientName,
    title: alert.title,
    context: alert.subtitle || null,
    // Sentence-case due label (Due Aug 16 / 10:00 AM / New today), not a mono stamp.
    due: dueStamp(alert),
    href: alert.href,
    actionLabel: mapping.action,
    similarCount: 0,
  };
}

/** Sentence-case deadline label. */
function dueStamp(alert: PortfolioAlertItem): string | null {
  const when = alert.when ? new Date(alert.when) : null;
  if (!when || Number.isNaN(when.getTime())) return alert.countdownLabel ?? null;

  const today = new Date();
  const sameDay = when.toDateString() === today.toDateString();
  if (sameDay) {
    return when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (when.getTime() < today.getTime()) return 'New today';
  return `Due ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function severityRank(severity: AttentionItem['severity']): number {
  if (severity === 'critical') return 0;
  if (severity === 'high') return 1;
  return 2;
}

function newsReasonLabel(reason: NewsDashboardResponse['reason']): string {
  if (reason === 'not_configured') return 'News ingestion is not configured.';
  if (reason === 'no_clients') return 'No monitored clients yet.';
  if (reason === 'provider_unavailable') return 'The news provider is unavailable.';
  if (reason === 'no_articles') return 'No Data Explorer articles match the current filters.';
  return 'News is unavailable.';
}

function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function formatToday(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDayShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function relativeDay(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(elapsed)) return '';
  const minutes = Math.floor(Math.abs(elapsed) / 60_000);
  const future = elapsed < 0;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

/**
 * Strip query parameters (including ?pwd= tokens) from URL-shaped meeting
 * locations so that join passwords and other secrets do not appear in the
 * dashboard subtitle. The actual join URL is stored separately in joinUrl
 * and used by the Join button, so this is display-only sanitization.
 */
function sanitizeLocation(location: string | null | undefined): string | null {
  if (!location || typeof location !== 'string') return null;
  const trimmed = location.trim();
  if (!trimmed) return null;

  // Not a URL — pass through (room names, addresses, etc.)
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return trimmed;

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();

    // Zoom
    if (host.includes('zoom.us') || host.includes('zoom.com')) return 'Zoom Meeting';
    // Microsoft Teams
    if (host.includes('teams.microsoft.com') || host.includes('teams.live.com')) return 'Microsoft Teams Meeting';
    // Google Meet
    if (host.includes('meet.google.com')) return 'Google Meet';
    // Webex
    if (host.includes('webex.com')) return 'Webex Meeting';
    // Generic: show just the hostname, no path or query params
    return url.hostname;
  } catch {
    // Malformed URL — strip everything after ? to be safe
    const qIdx = trimmed.indexOf('?');
    return qIdx > 0 ? trimmed.slice(0, qIdx) : trimmed;
  }
}

function readJoinUrl(meeting: DashMeeting): string | null {
  if (meeting.joinLink) return meeting.joinLink;
  const metadata = meeting.metadata;
  if (metadata && typeof metadata.joinUrl === 'string') return metadata.joinUrl;
  return null;
}

function weekBounds(now: Date): { from: string; to: string } {
  const start = new Date(now);
  const day = (start.getDay() + 6) % 7; // Monday-first
  start.setDate(start.getDate() - day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { from: start.toISOString(), to: end.toISOString() };
}

function weekStrip(eventDays: ReadonlySet<string>): DashboardVNextModel['today']['week'] {
  const now = new Date();
  const start = new Date(now);
  const day = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - day);
  start.setHours(0, 0, 0, 0);

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return {
      id: date.toISOString().slice(0, 10),
      weekday: date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase(),
      day: String(date.getDate()),
      today: date.toDateString() === now.toDateString(),
      // Marks the days that actually carry events, not just today.
      hasEvents: eventDays.has(date.toDateString()),
    };
  });
}

function dayLabel(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return null;
  return date.toLocaleDateString(undefined, { weekday: 'short' });
}

/**
 * Maps the two Today & Coming Up sources into a single event-list skeleton
 * with a numeric `at` instant for ordering.
 *
 * Meetings come from /api/engagement/meetings with the real startsAt instant,
 * join/prepare/brief actions and Meri state. comingUp's kind==='meeting' items
 * are the SAME meetings re-projected (id `meeting-${id}`, date = startsAt), so
 * they are deduped by meeting identity and the rich primary mapping wins.
 * They are NOT all dropped: comingUp spans tomorrow→+7d, which reaches past the
 * Monday-first calendar week the primary query loads, and its meetings are
 * already user-owned (ownMeetingWhere). A unique one is kept as a fallback
 * meeting row — real ISO instant, original href/title/detail, plain Open
 * action, and no invented join URL / isVirtual / prep / Meri state. Tracked
 * hearings/markups/deadlines have no other representation and are preserved.
 */
export function mergeTodayEvents(
  meetings: DashMeeting[],
  comingUpItems: ComingUpItem[],
): Array<TodayEvent & { at: number }> {
  const dated: Array<TodayEvent & { at: number }> = [];

  for (const meeting of meetings) {
    const joinUrl = readJoinUrl(meeting);
    const at = new Date(meeting.startsAt).getTime();
    dated.push({
      at: Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER,
      id: `meeting-${meeting.id}`,
      startsAt: meeting.startsAt,
      time: formatTime(meeting.startsAt),
      title: meeting.subject,
      meta: [dayLabel(meeting.startsAt), meeting.client?.name, sanitizeLocation(meeting.location)]
        .filter(Boolean)
        .join(' · '),
      href: `/engagement/meetings/${encodeURIComponent(meeting.id)}`,
      action: joinUrl ? 'join' : meeting.preps.length > 0 ? 'brief' : 'prepare',
      joinUrl,
      isMeeting: true,
      isVirtual: meeting.isVirtual,
      meri: meeting.meri,
    });
  }

  const primaryMeetingIds = new Set(meetings.map((meeting) => meeting.id));

  // Hearings, comment deadlines, floor activity and other tracked events.
  for (const item of comingUpItems) {
    if (item.kind === 'meeting') {
      // Same meeting as a primary row → the primary mapping already covers it.
      const rawMeetingId = item.id.replace(/^meeting-/, '');
      if (primaryMeetingIds.has(rawMeetingId)) continue;
      // The ISO date IS the real instant; the localized `time` label must
      // never be combined with it (that misparse built phantom NaN rows).
      const at = new Date(item.date).getTime();
      dated.push({
        at: Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER,
        // Canonical meeting event id (Send Meri strips this prefix), never a
        // `coming-` one.
        id: `meeting-${rawMeetingId}`,
        startsAt: Number.isFinite(at) ? new Date(at).toISOString() : item.date,
        time: item.time ?? formatDayShort(item.date),
        title: item.title,
        meta: [dayLabel(item.date), item.label, item.detail].filter(Boolean).join(' · '),
        href: item.href,
        action: 'open',
        isMeeting: true,
      });
      continue;
    }
    const at = new Date(item.time ? `${item.date}T${item.time}` : item.date).getTime();
    dated.push({
      at: Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER,
      id: `coming-${item.id}`,
      startsAt: Number.isFinite(at) ? new Date(at).toISOString() : item.date,
      time: item.time ?? formatDayShort(item.date),
      title: item.title,
      meta: [dayLabel(item.date), item.label, item.detail].filter(Boolean).join(' · '),
      href: item.href,
      action: 'open',
      isMeeting: false,
    });
  }

  return dated;
}

/**
 * Module order (`754:2786` "Drag to reorder"). Persisted alongside visibility
 * and density under the same per-user key contract. Unknown or missing keys
 * fall back to the designed 01/02/03 order rather than dropping a module.
 */
function useDashboardOrder(
  preferenceKey: string | null,
): [readonly DashboardModuleKey[], (next: readonly DashboardModuleKey[]) => void] {
  const [order, setOrderState] = useState<readonly DashboardModuleKey[]>(DEFAULT_ORDER);

  useEffect(() => {
    if (!preferenceKey || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(preferenceKey);
      setOrderState(raw ? normalizeOrder(JSON.parse(raw)) : DEFAULT_ORDER);
    } catch {
      setOrderState(DEFAULT_ORDER);
    }
  }, [preferenceKey]);

  return [
    order,
    (next: readonly DashboardModuleKey[]) => {
      const normalized = normalizeOrder(next);
      setOrderState(normalized);
      if (!preferenceKey || typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(preferenceKey, JSON.stringify(normalized));
      } catch {
        // A blocked storage write must not break the dashboard.
      }
    },
  ];
}

/** Keeps every module present exactly once, whatever the stored value says. */
function normalizeOrder(value: unknown): readonly DashboardModuleKey[] {
  const requested = Array.isArray(value) ? value : [];
  const seen = new Set<DashboardModuleKey>();
  const result: DashboardModuleKey[] = [];
  for (const entry of requested) {
    if (DEFAULT_ORDER.includes(entry as DashboardModuleKey) && !seen.has(entry as DashboardModuleKey)) {
      seen.add(entry as DashboardModuleKey);
      result.push(entry as DashboardModuleKey);
    }
  }
  for (const key of DEFAULT_ORDER) if (!seen.has(key)) result.push(key);
  return result;
}

/**
 * Mobile is a distinct composition (`757:2622`), so the model — not just CSS —
 * has to know which one is rendering.
 *
 * 779px, matching the canonical mobile boundary in foundations/responsive.css
 * and the shell's own @media (max-width: 779px). This used to read 639px, which
 * left a 140px band (640-779) rendering the DESKTOP content model inside MOBILE
 * geometry — no rail, bottom nav mounted, but the full desktop module set. Both
 * halves of the boundary have to move together or that band gets worse, not
 * better.
 */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(max-width: 779px)');
    const sync = () => setIsMobile(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return isMobile;
}

/**
 * Builds a module's system state from its real sources (`754:2885`).
 *
 * The six states are not cosmetic: a failed source must never read as empty and
 * a missing value must never render as zero, so `unavailable` and `stale` are
 * reported from query errors rather than from an item count.
 */
function buildStatus({
  sources,
  hidden,
  emptyKind,
  emptyTitle,
  emptyBody,
  emptyMeta = null,
  emptyAction = null,
  itemCount,
}: {
  sources: readonly { name: string; isLoading: boolean; isError: boolean; updatedAt: number }[];
  hidden: boolean;
  emptyKind: 'empty' | 'all-clear';
  emptyTitle: string;
  emptyBody: string;
  emptyMeta?: string | null;
  emptyAction?: ModuleStatus['action'];
  itemCount: number;
}): ModuleStatus {
  if (hidden) {
    return { state: 'empty', meta: null, title: emptyTitle, body: emptyBody, action: null };
  }

  const loading = sources.filter((source) => source.isLoading);
  const failed = sources.filter((source) => source.isError);
  const ready = sources.filter((source) => !source.isLoading && !source.isError);

  if (loading.length === sources.length) {
    return {
      state: 'loading',
      meta: `${sources.length} source${sources.length === 1 ? '' : 's'} connecting`,
      title: 'Refreshing dashboard sources',
      body: 'First load waits for required source contracts before showing content.',
      action: null,
    };
  }

  if (failed.length === sources.length) {
    return {
      state: 'unavailable',
      meta: failed.map((source) => source.name).join(' · '),
      title: `${failed.length === 1 ? failed[0]!.name : 'Every source'} is temporarily unavailable`,
      body: 'Keep the module visible, identify the failing source, and never convert missing data to zero.',
      action: { label: 'Retry source', tone: 'warning' },
    };
  }

  // Some sources answered and some did not: show what is known and name what is
  // still outstanding rather than silently rendering a short list.
  if (loading.length > 0) {
    return {
      state: 'partial',
      meta: `${ready.length} of ${sources.length} ready`,
      title: `${ready.map((source) => source.name).join(', ')} loaded; ${loading
        .map((source) => source.name.toLowerCase())
        .join(', ')} still refreshing`,
      body: 'Render available modules and name the source that is still pending.',
      action: null,
    };
  }

  if (failed.length > 0) {
    const lastSuccess = Math.max(0, ...ready.map((source) => source.updatedAt));
    return {
      state: 'stale',
      meta: lastSuccess ? `Last success ${relativeAge(lastSuccess)}` : failed[0]!.name,
      title: lastSuccess ? `Showing results from ${clockTime(lastSuccess)}` : 'Showing the last good result',
      body: 'Preserve the last good result, display its age, and offer a controlled retry.',
      action: { label: 'Retry source', tone: 'warning' },
    };
  }

  if (itemCount === 0) {
    return {
      state: emptyKind,
      meta: emptyMeta,
      title: emptyTitle,
      body: emptyBody,
      action: emptyAction,
    };
  }

  return { state: 'ready', meta: null, title: '', body: '', action: null };
}

function clockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function relativeAge(epochMs: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - epochMs) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Reuses the existing per-user localStorage preference contract. */
function useDashboardVisibility(
  preferenceKey: string | null,
): [DashboardVisibility, (next: DashboardVisibility) => void] {
  const [visibility, setVisibilityState] = useState<DashboardVisibility>(DEFAULT_VISIBILITY);

  useEffect(() => {
    if (!preferenceKey || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(preferenceKey);
      if (!raw) {
        setVisibilityState(DEFAULT_VISIBILITY);
        return;
      }
      const parsed = JSON.parse(raw) as Partial<DashboardVisibility>;
      setVisibilityState({
        today: parsed.today !== false,
        work: parsed.work !== false,
        news: parsed.news !== false,
        xFeed: parsed.xFeed !== false,
      });
    } catch {
      setVisibilityState(DEFAULT_VISIBILITY);
    }
  }, [preferenceKey]);

  return [
    visibility,
    (next: DashboardVisibility) => {
      setVisibilityState(next);
      if (!preferenceKey || typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(preferenceKey, JSON.stringify(next));
      } catch {
        // A blocked storage write must not break the dashboard.
      }
    },
  ];
}

const DENSITIES: readonly DashboardDensity[] = ['presentation', 'standard', 'compact'];

function useDashboardDensity(
  preferenceKey: string | null,
): [DashboardDensity, (next: DashboardDensity) => void] {
  const [density, setDensityState] = useState<DashboardDensity>('standard');

  useEffect(() => {
    if (!preferenceKey || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(preferenceKey) as DashboardDensity | null;
      setDensityState(raw && DENSITIES.includes(raw) ? raw : 'standard');
    } catch {
      setDensityState('standard');
    }
  }, [preferenceKey]);

  return [
    density,
    (next: DashboardDensity) => {
      setDensityState(next);
      if (!preferenceKey || typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(preferenceKey, next);
      } catch {
        // Non-fatal.
      }
    },
  ];
}
