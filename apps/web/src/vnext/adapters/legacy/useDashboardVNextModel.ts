import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useUser } from '@clerk/clerk-react';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
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

export type DashboardDensity = 'standard' | 'compact';

export interface AttentionItem {
  id: string;
  /** Badge text, e.g. CRITICAL / DEADLINE / HEARING / BUDGET. */
  kind: string;
  severity: 'critical' | 'high' | 'normal';
  eyebrow: string;
  title: string;
  context: string | null;
  due: string | null;
  href: string | null;
  actionLabel: string;
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
 */
const ATTENTION_ALERT_TYPES: Readonly<Record<string, { badge: string; action: string }>> = {
  comment_deadline: { badge: 'DEADLINE', action: 'Open' },
  hearing: { badge: 'HEARING', action: 'Prepare' },
  bill_movement: { badge: 'LEGISLATIVE', action: 'Open' },
  contract_award: { badge: 'BUDGET', action: 'Open' },
  competitor_filing: { badge: 'FILING', action: 'Open' },
};

/** Intelligence changes that count as material funding/regulatory movement. */
const MATERIAL_CHANGE_SEVERITIES = new Set(['critical', 'high']);

const DEFAULT_VISIBILITY: DashboardVisibility = { today: true, work: true, news: true };

export interface DashboardVNextModel {
  header: {
    greeting: string;
    eyebrow: string;
    meta: string;
    refreshedLabel: string | null;
  };
  needsAttention: { state: DashboardModuleState; items: AttentionItem[]; total: number };
  news: {
    state: DashboardModuleState;
    items: NewsItem[];
    meta: string;
    preferences: NewsPreferences;
    setPreferences: (next: NewsPreferences) => void;
    unavailableReason: string | null;
  };
  today: {
    state: DashboardModuleState;
    week: Array<{ id: string; weekday: string; day: string; today: boolean; hasEvents: boolean }>;
    events: TodayEvent[];
  };
  workQueue: { state: DashboardModuleState; items: WorkQueueEntry[]; total: number };
  visibility: DashboardVisibility;
  setVisibility: (next: DashboardVisibility) => void;
  density: DashboardDensity;
  setDensity: (next: DashboardDensity) => void;
}

export function useDashboardVNextModel(): DashboardVNextModel {
  const api = useApi();
  const { user } = useUser();
  const me = useMe();

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
    const sourcesFailed =
      portfolioAlerts.isError || recentChanges.isError || (visibility.news && news.isError);

    if (portfolioAlerts.isLoading && recentChanges.isLoading) {
      return { state: 'loading' as DashboardModuleState, items: [], total: 0 };
    }
    if (portfolioAlerts.isError && recentChanges.isError) {
      return { state: 'unavailable' as DashboardModuleState, items: [], total: 0 };
    }

    const ordered = selectAttentionItems({
      alerts: portfolioAlerts.data?.alerts ?? [],
      changes: recentChanges.data ?? [],
      failedSourceReason:
        visibility.news && news.data && !news.data.available ? (news.data.reason ?? null) : null,
    });

    if (ordered.length === 0) {
      return {
        state: (sourcesFailed ? 'partial' : 'all-clear') as DashboardModuleState,
        items: ordered,
        total: 0,
      };
    }

    return {
      state: (sourcesFailed ? 'partial' : 'ready') as DashboardModuleState,
      items: ordered,
      total: ordered.length,
    };
  }, [
    portfolioAlerts.data,
    portfolioAlerts.isError,
    portfolioAlerts.isLoading,
    recentChanges.data,
    recentChanges.isError,
    recentChanges.isLoading,
    news.data,
    news.isError,
    visibility.news,
  ]);

  /* ── News & Narrative ─────────────────────────────────────────────────── */

  const newsModule = useMemo(() => {
    const base = {
      preferences: newsPreferences,
      setPreferences: setNewsPreferences,
    };

    if (!visibility.news) {
      return { ...base, state: 'empty' as DashboardModuleState, items: [], meta: '', unavailableReason: null };
    }
    if (news.isLoading) {
      return { ...base, state: 'loading' as DashboardModuleState, items: [], meta: '', unavailableReason: null };
    }
    if (news.isError) {
      return {
        ...base,
        state: 'unavailable' as DashboardModuleState,
        items: [],
        meta: '',
        unavailableReason: 'News could not be loaded.',
      };
    }

    const data = news.data;
    if (!data || !data.available) {
      return {
        ...base,
        state: 'unavailable' as DashboardModuleState,
        items: [],
        meta: '',
        unavailableReason: newsReasonLabel(data?.reason),
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
      return { ...base, state: 'empty' as DashboardModuleState, items, meta, unavailableReason: null };
    }

    return {
      ...base,
      state: (data.stale ? 'stale' : 'ready') as DashboardModuleState,
      items,
      meta,
      unavailableReason: null,
    };
  }, [news.data, news.isError, news.isLoading, newsPreferences, setNewsPreferences, visibility.news]);

  /* ── Today & Coming Up ────────────────────────────────────────────────── */

  const today = useMemo(() => {
    if (!visibility.today) {
      return { state: 'empty' as DashboardModuleState, week: [], events: [] };
    }
    if (meetings.isLoading && comingUp.isLoading) {
      return { state: 'loading' as DashboardModuleState, week: weekStrip([]), events: [] };
    }
    if (meetings.isError && comingUp.isError) {
      return { state: 'unavailable' as DashboardModuleState, week: weekStrip([]), events: [] };
    }

    const events: TodayEvent[] = [];

    for (const meeting of meetings.data ?? []) {
      const joinUrl = readJoinUrl(meeting);
      events.push({
        id: `meeting-${meeting.id}`,
        time: formatTime(meeting.startsAt),
        title: meeting.subject,
        meta: [meeting.client?.name, meeting.location].filter(Boolean).join(' · ') || 'Meeting',
        href: `/engagement/meetings/${encodeURIComponent(meeting.id)}`,
        action: joinUrl ? 'join' : meeting.preps.length > 0 ? 'brief' : 'prepare',
        joinUrl,
      });
    }

    // Hearings, comment deadlines, floor activity and other tracked events.
    for (const item of comingUp.data?.items ?? []) {
      events.push({
        id: `coming-${item.id}`,
        time: item.time ?? formatDayShort(item.date),
        title: item.title,
        meta: [item.label, item.detail].filter(Boolean).join(' · '),
        href: item.href,
        action: 'open',
      });
    }

    events.sort((a, b) => a.time.localeCompare(b.time));

    const partial = meetings.isError || comingUp.isError;
    if (events.length === 0) {
      return {
        state: (partial ? 'partial' : 'empty') as DashboardModuleState,
        week: weekStrip([]),
        events,
      };
    }

    return {
      state: (partial ? 'partial' : 'ready') as DashboardModuleState,
      week: weekStrip(events),
      events,
    };
  }, [comingUp.data, comingUp.isError, comingUp.isLoading, meetings.data, meetings.isError, meetings.isLoading, visibility.today]);

  /* ── Work Queue (outreach + governed work documents only) ─────────────── */

  const workQueue = useMemo(() => {
    if (!visibility.work) {
      return { state: 'empty' as DashboardModuleState, items: [], total: 0 };
    }
    if (outreach.isLoading && workspaceDrafts.isLoading) {
      return { state: 'loading' as DashboardModuleState, items: [], total: 0 };
    }
    if (outreach.isError && workspaceDrafts.isError) {
      return { state: 'unavailable' as DashboardModuleState, items: [], total: 0 };
    }

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

    const partial = outreach.isError || workspaceDrafts.isError;
    if (items.length === 0) {
      return {
        state: (partial ? 'partial' : 'empty') as DashboardModuleState,
        items,
        total: 0,
      };
    }

    return {
      state: (partial ? 'partial' : 'ready') as DashboardModuleState,
      items,
      total: items.length,
    };
  }, [outreach.data, outreach.isError, outreach.isLoading, workspaceDrafts.data, workspaceDrafts.isError, workspaceDrafts.isLoading, visibility.work]);

  /* ── Header ───────────────────────────────────────────────────────────── */

  const header = useMemo(() => {
    const overnight = (recentChanges.data ?? []).filter(
      (change) => new Date(change.detectedAt).getTime() >= Date.now() - 24 * 60 * 60 * 1000,
    ).length;
    const critical = needsAttention.items.filter((item) => item.severity === 'critical').length;

    const metaParts = [formatToday(), `${overnight} new signals overnight`];
    if (critical > 0) metaParts.push(`${critical} critical actions today`);

    return {
      greeting: `${greetingFor(new Date())}${me.data?.user.firstName ? `, ${me.data.user.firstName}` : ''}.`,
      eyebrow: 'ALL CLIENTS · PORTFOLIO WIDE',
      meta: metaParts.join(' · '),
      refreshedLabel: portfolioAlerts.data?.generatedAt
        ? `Refreshed ${relativeDay(portfolioAlerts.data.generatedAt)}`
        : null,
    };
  }, [me.data?.user.firstName, needsAttention.items, portfolioAlerts.data?.generatedAt, recentChanges.data]);

  return {
    header,
    needsAttention,
    news: newsModule,
    today,
    workQueue,
    visibility,
    setVisibility,
    density,
    setDensity,
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
  for (const change of changes) {
    if (!MATERIAL_CHANGE_SEVERITIES.has(change.severity)) continue;
    items.push({
      id: `change-${change.id}`,
      kind: 'BUDGET',
      severity: change.severity === 'critical' ? 'critical' : 'high',
      eyebrow: change.source.toUpperCase(),
      title: change.title,
      context: change.description || null,
      due: relativeDay(change.detectedAt),
      href: '/explorer',
      actionLabel: 'Open',
    });
  }

  // A failed source is itself actionable and must never be silently hidden.
  // `no_clients` is a configuration state, not a failure, so it is not raised.
  if (failedSourceReason === 'provider_unavailable' || failedSourceReason === 'not_configured') {
    items.push({
      id: 'source-news',
      kind: 'SOURCE',
      severity: 'high',
      eyebrow: 'SOURCE FAILURE',
      title:
        failedSourceReason === 'not_configured'
          ? 'News ingestion is not configured'
          : 'News provider is unavailable',
      context: 'News & Narrative cannot refresh until this is resolved.',
      due: null,
      href: '/settings/integrations',
      actionLabel: 'Resolve',
    });
  }

  return items.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

function attentionFromAlert(
  alert: PortfolioAlertItem,
  mapping: { badge: string; action: string },
): AttentionItem {
  const severity: AttentionItem['severity'] =
    alert.severity === 'critical' ? 'critical' : alert.severity === 'high' ? 'high' : 'normal';
  return {
    id: `alert-${alert.id}`,
    kind: severity === 'critical' ? 'CRITICAL' : mapping.badge,
    severity,
    eyebrow: alert.clientName.toUpperCase(),
    title: alert.title,
    context: alert.subtitle || null,
    due: alert.countdownLabel ?? (alert.when ? relativeDay(alert.when) : null),
    href: alert.href,
    actionLabel: mapping.action,
  };
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
  if (hour < 12) return 'Good Morning';
  if (hour < 18) return 'Good Afternoon';
  return 'Good Evening';
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

function weekStrip(events: TodayEvent[]): DashboardVNextModel['today']['week'] {
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
      hasEvents: events.length > 0 && date.toDateString() === now.toDateString(),
    };
  });
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

function useDashboardDensity(
  preferenceKey: string | null,
): [DashboardDensity, (next: DashboardDensity) => void] {
  const [density, setDensityState] = useState<DashboardDensity>('standard');

  useEffect(() => {
    if (!preferenceKey || typeof window === 'undefined') return;
    try {
      setDensityState(
        window.localStorage.getItem(preferenceKey) === 'compact' ? 'compact' : 'standard',
      );
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
