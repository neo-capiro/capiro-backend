import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUser } from '@clerk/clerk-react';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import { useClientFilter } from '../../../state/client-filter.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import {
  useNewsPreferences,
  type NewsPreferences,
} from '../../../pages/dashboard/DashboardNewsAndNarrative.js';
import type {
  ComingUpResult,
  IntelligenceChange,
  PortfolioAlertItem,
  PortfolioAlertsResponse,
} from '../../../pages/intelligence/types.js';
import type { MeriState } from '../../../pages/engagement/meetings/meetings-types.js';

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
export type DashboardModuleKey = 'news' | 'today' | 'work';

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
}

export interface NewsItem {
  id: string;
  source: string;
  title: string;
  reason: string;
  clients: string;
  url: string;
  imageUrl: string | null;
  publishedLabel: string;
}

export interface TodayEvent {
  id: string;
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

export interface DashboardVisibility {
  today: boolean;
  work: boolean;
  news: boolean;
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

const DEFAULT_VISIBILITY: DashboardVisibility = { today: true, work: true, news: true };

/** Drawer order 01/02/03 (`754:2789`, `754:2797`, `754:2805`). */
const DEFAULT_ORDER: readonly DashboardModuleKey[] = ['news', 'today', 'work'];

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
  Record<DashboardDensity, { attention: number; news: number; today: number; work: number }>
> = {
  presentation: { attention: 3, news: 3, today: 2, work: 2 },
  // Standard shows THREE attention rows, not four: the approved card is
  // 1120x198 = 45px header + 3 x ~51px rows. The header keeps the true total and
  // `View all` reaches the rest, so only the visible count changes here — the
  // selection taxonomy and governance logic are untouched.
  standard: { attention: 3, news: 4, today: 3, work: 3 },
  compact: { attention: 6, news: 6, today: 5, work: 5 },
};

/**
 * Mobile (`757:2622`) is a different content model, not a narrower desktop: two
 * attention rows, two stories, a single Next Meeting card and one work item.
 */
const MOBILE_ROW_LIMITS = { attention: 2, news: 2, today: 1, work: 1 } as const;

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
] as const;

export function useDashboardVNextModel(): DashboardVNextModel {
  const api = useApi();
  const { user } = useUser();
  const me = useMe();
  const queryClient = useQueryClient();

  const retry = useCallback(() => {
    for (const key of DASHBOARD_QUERY_KEYS) {
      void queryClient.invalidateQueries({ queryKey: [key] });
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
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : 'Could not send Meri'),
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
      ...(newsPreferences.clientIds.length
        ? { clients: newsPreferences.clientIds.join(',') }
        : {}),
      topics: newsPreferences.policyTopics.join(','),
      signals: newsPreferences.signalKinds.join(','),
      ...(newsPreferences.customTopics.length
        ? { custom: newsPreferences.customTopics.join(',') }
        : {}),
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
      (await api.get<DashWorkspaceDraft[]>('/workspace-api/drafts', { params: { scope: 'all' } }))
        .data,
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

    return { status, items: ordered.slice(0, limits.attention), total: ordered.length };
  }, [
    portfolioAlerts.data,
    portfolioAlerts.dataUpdatedAt,
    portfolioAlerts.isError,
    portfolioAlerts.isLoading,
    recentChanges.data,
    recentChanges.dataUpdatedAt,
    recentChanges.isError,
    recentChanges.isLoading,
    news.data,
    visibility.news,
    limits.attention,
  ]);

  /* ── News & Narrative ─────────────────────────────────────────────────── */

  const newsModule = useMemo(() => {
    const base = {
      preferences: newsPreferences,
      setPreferences: setNewsPreferences,
    };

    /** Subscription breadth, for the EMPTY state's "N active filters". */
    const activeFilters =
      newsPreferences.policyTopics.length +
      newsPreferences.signalKinds.length +
      newsPreferences.clientIds.length +
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
      publishedLabel: relativeDay(item.publishedAt),
    }));

    const meta = data.coverageLimited
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
        items: items.slice(0, limits.news),
        meta,
        unavailableReason: null,
      };
    }

    return {
      ...base,
      status: { state: 'ready' as DashboardModuleState, meta: null, title: '', body: '', action: null },
      items: items.slice(0, limits.news),
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
    const dated: Array<TodayEvent & { at: number }> = [];

    for (const meeting of meetings.data ?? []) {
      const joinUrl = readJoinUrl(meeting);
      const at = new Date(meeting.startsAt).getTime();
      dated.push({
        at: Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER,
        id: `meeting-${meeting.id}`,
        time: formatTime(meeting.startsAt),
        title: meeting.subject,
        meta: [dayLabel(meeting.startsAt), meeting.client?.name, meeting.location]
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

    // Hearings, comment deadlines, floor activity and other tracked events.
    for (const item of comingUp.data?.items ?? []) {
      const at = new Date(item.time ? `${item.date}T${item.time}` : item.date).getTime();
      dated.push({
        at: Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER,
        id: `coming-${item.id}`,
        time: item.time ?? formatDayShort(item.date),
        title: item.title,
        meta: [dayLabel(item.date), item.label, item.detail].filter(Boolean).join(' · '),
        href: item.href,
        action: 'open',
        isMeeting: false,
      });
    }

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
    const events: TodayEvent[] = upcoming
      .slice(0, limits.today)
      .map(({ at: _at, ...event }) => event);

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

    return { status, items: items.slice(0, limits.work), total: items.length };
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

interface NewsDashboardResponse {
  available: boolean;
  items: Array<{
    id: string;
    title: string;
    source: string;
    url: string;
    imageUrl: string | null;
    publishedAt: string;
    clientMatches: Array<{ id: string; name: string }>;
    relevanceReason: string;
  }>;
  stale?: boolean;
  reason?: 'not_configured' | 'no_clients' | 'provider_unavailable';
  monitoredClientCount: number;
  activeClientCount: number;
  coverageLimited: boolean;
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
}: {
  alerts: readonly PortfolioAlertItem[];
  changes: readonly IntelligenceChange[];
  failedSourceReason: 'not_configured' | 'no_clients' | 'provider_unavailable' | null;
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
    items.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
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
      out.push(item);
      continue;
    }
    const existing = groupIndex.get(group);
    if (existing) {
      existing.similarCount += 1;
      continue;
    }
    const { _group: _omit, ...clean } = item as AttentionItem & { _group?: string };
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
 */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia('(max-width: 639px)');
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
