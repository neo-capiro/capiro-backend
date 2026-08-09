import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App, Button, Empty, Form, Modal, Popover, Skeleton, Switch, Tag } from 'antd';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/use-api.js';
import {
  DebriefNotesView,
  extractMeetingJoinUrl,
  NotetakerConsentFields,
  openMeetingJoinLink,
} from './engagement/meeting-actions.js';
import { redistrictingHref } from './redistricting-link.js';
import { SectionLabel, SendMeriButton } from './engagement/meetings/meetings-ui.js';
import type { Meeting } from './engagement/meetings/meetings-types.js';
import { useMe } from '../lib/me.js';
import type { Client } from './clients/clientTypes.js';
import type {
  ComingUpItem,
  ComingUpResult,
  IntelligenceChange,
  PortfolioAlertItem,
  PortfolioAlertsResponse,
} from './intelligence/types.js';
import { useActionsList } from './actions/actions-api.js';
import { STATUS_LABELS as ACTION_STATUS_LABELS, type ActionCardDto } from './actions/types.js';
import { useReviewsList } from './reviews/reviews-api.js';
import {
  RISK_TIER_LABELS,
  SURFACE_LABELS,
  type ReviewRequestDto,
} from './reviews/types.js';
import './home-dashboard.css';

/* ── Local data shapes (lean projections of API responses) ─────────────── */

interface CommentAlertItem {
  documentId: string;
  title: string;
  type: string;
  commentEndDate: string;
  daysToDeadline: number;
  severity: string;
  agencies: string[];
  clientId: string;
  clientName: string;
  relevanceScore: number;
}

interface CommentAlertsResponse {
  alerts: CommentAlertItem[];
}

interface DashMeeting {
  id: string;
  subject: string;
  location: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
  source: string;
  startsAt: string;
  endsAt: string;
  organizerName: string | null;
  client: { id: string; name: string } | null;
  attendees: Array<{ name: string | null; role: string | null }>;
  preps: Array<{ status: string }>;
  debriefs: Array<{ id: string }>;
  isVirtual?: boolean;
  joinLink?: string | null;
  meri?: 'scheduled' | 'attending' | 'attended' | 'done' | null;
}

interface HomeDebrief {
  id: string;
  body: string | null;
  restricted: boolean;
}

interface DashOutreach {
  id: string;
  title: string;
  subject: string | null;
  body: string | null;
  status: 'draft' | 'sent' | 'opened_in_email' | 'failed';
  recipientCount: number;
  client: { id: string; name: string } | null;
  updatedAt: string;
}

interface NewsDashboardItem {
  id: string;
  title: string;
  source: string;
  url: string;
  imageUrl: string | null;
  publishedAt: string;
  clientMatches: Array<{ id: string; name: string }>;
  topics: string[];
  relevanceReason: string;
  duplicateCount: number | null;
}

interface NewsDashboardResponse {
  available: boolean;
  provider: 'newscatcher';
  items: NewsDashboardItem[];
  generatedAt: string;
  cached: boolean;
  stale?: boolean;
  reason?: 'not_configured' | 'no_clients' | 'provider_unavailable';
  monitoredClientCount: number;
  activeClientCount: number;
  coverageLimited: boolean;
}

type DashboardModuleKey = 'today' | 'work' | 'news';
type DashboardVisibility = Record<DashboardModuleKey, boolean>;

const DEFAULT_VISIBILITY: DashboardVisibility = {
  today: true,
  work: true,
  news: true,
};

const COMMENTS_LINK = '/explorer?source=comment-deadlines';
const ACTIVE_ACTION_STATUSES = new Set([
  'new',
  'triaged',
  'assigned',
  'drafting',
  'ready_for_review',
]);

export function HomePage() {
  const api = useApi();
  const { user } = useUser();
  const me = useMe();

  const preferenceKey = useMemo(() => {
    if (!user?.id || !me.data?.tenant.id) return null;
    return `capiro:dashboard-visibility:${me.data.tenant.id}:${user.id}`;
  }, [me.data?.tenant.id, user?.id]);
  const [visibility, setVisibility] = useDashboardVisibility(preferenceKey);

  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 60_000,
  });

  // Let failures remain visible: "couldn't check" must never render as "zero".
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

  const commentAlerts = useQuery<CommentAlertsResponse>({
    queryKey: ['comment-alerts-dashboard'],
    queryFn: async () =>
      (await api.get<CommentAlertsResponse>('/api/intelligence/comment-alerts')).data,
    staleTime: 5 * 60 * 1000,
  });

  const comingUp = useQuery<ComingUpResult>({
    queryKey: ['coming-up'],
    queryFn: async () => (await api.get<ComingUpResult>('/api/intelligence/coming-up')).data,
    staleTime: 5 * 60 * 1000,
  });

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

  const outreach = useQuery<DashOutreach[]>({
    queryKey: ['engagement-outreach-drafts'],
    queryFn: async () =>
      (await api.get<DashOutreach[]>('/api/engagement/outreach', { params: { limit: 25 } })).data,
    staleTime: 60_000,
  });

  const actions = useActionsList({ sort: 'deadline', limit: 25, page: 1 });
  const reviews = useReviewsList('pending');

  const news = useQuery<NewsDashboardResponse>({
    queryKey: ['dashboard-news'],
    queryFn: async () =>
      (await api.get<NewsDashboardResponse>('/api/intelligence/news/dashboard')).data,
    enabled: visibility.news,
    staleTime: 15 * 60 * 1000,
    retry: false,
  });

  const overnightCount = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return (recentChanges.data ?? []).filter((c) => new Date(c.detectedAt).getTime() >= cutoff)
      .length;
  }, [recentChanges.data, recentChanges.dataUpdatedAt]);

  const criticalTodayCount = useMemo(
    () => (recentChanges.data ?? []).filter((c) => c.severity === 'critical').length,
    [recentChanges.data],
  );

  const firstName = user?.firstName || (user?.fullName?.split(' ')[0] ?? null) || null;
  const clientNameById = useMemo(
    () => new Map((clients.data ?? []).map((client) => [client.id, client.name])),
    [clients.data],
  );

  const visibleGridModules = Number(visibility.today) + Number(visibility.work);

  return (
    <section className="command-page redesign">
      <GreetingRow
        firstName={firstName}
        overnightCount={overnightCount}
        criticalToday={criticalTodayCount}
        signalsUnknown={recentChanges.isError}
        action={
          <DashboardCustomize visibility={visibility} onChange={setVisibility} />
        }
      />

      <NeedsAction
        alerts={commentAlerts.data?.alerts ?? []}
        comingUp={comingUp.data?.items ?? []}
        changes={recentChanges.data ?? []}
        portfolioAlerts={portfolioAlerts.data?.alerts ?? []}
        clientNameById={clientNameById}
        loading={commentAlerts.isLoading || comingUp.isLoading || portfolioAlerts.isLoading}
        someSourcesUnavailable={recentChanges.isError || portfolioAlerts.isError}
      />

      {visibility.news ? (
        <NewsAndNarrative
          data={news.data}
          loading={news.isLoading}
          isError={news.isError}
        />
      ) : null}

      {visibleGridModules > 0 ? (
        <div
          className="home-grid-2"
          style={visibleGridModules === 1 ? { gridTemplateColumns: '1fr' } : undefined}
        >
          {visibility.today ? (
            <TodayAndComingUp
              meetings={meetings.data ?? []}
              comingUp={comingUp.data?.items ?? []}
              loading={meetings.isLoading || comingUp.isLoading}
            />
          ) : null}
          {visibility.work ? (
            <WorkQueue
              actions={Array.isArray(actions.data?.data) ? actions.data.data : []}
              reviews={Array.isArray(reviews.data) ? reviews.data : []}
              outreach={outreach.data ?? []}
              loading={actions.isLoading || reviews.isLoading || outreach.isLoading}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* ── Greeting + lightweight show/hide customization ───────────────────── */

function GreetingRow({
  firstName,
  overnightCount,
  criticalToday,
  signalsUnknown,
  action,
}: {
  firstName: string | null;
  overnightCount: number;
  criticalToday: number;
  signalsUnknown: boolean;
  action?: ReactNode;
}) {
  const now = new Date();
  const hour = now.getHours();
  const greeting =
    hour < 5
      ? 'Good Evening'
      : hour < 12
        ? 'Good Morning'
        : hour < 17
          ? 'Good Afternoon'
          : 'Good Evening';
  const dateLabel = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const congress = congressSession(now);

  return (
    <header className="home-greet-row">
      <div>
        <h1 className="home-greet">
          {greeting}
          {firstName ? `, ${firstName}` : ''}.
        </h1>
        <p className="home-greet-meta">
          {dateLabel} · {congress} ·{' '}
          {signalsUnknown ? (
            'signal count unavailable'
          ) : (
            <>
              <b className="num">{overnightCount}</b> new signal{overnightCount === 1 ? '' : 's'}{' '}
              overnight
            </>
          )}
          {!signalsUnknown && criticalToday > 0 ? (
            <>
              {' · '}
              <span className="critical">
                {criticalToday} critical action{criticalToday === 1 ? '' : 's'} today
              </span>
            </>
          ) : null}
        </p>
      </div>
      {action}
    </header>
  );
}

function DashboardCustomize({
  visibility,
  onChange,
}: {
  visibility: DashboardVisibility;
  onChange: (next: DashboardVisibility) => void;
}) {
  const set = (key: DashboardModuleKey, checked: boolean) =>
    onChange({ ...visibility, [key]: checked });

  const content = (
    <div className="home-dashboard-customize-popover">
      <div className="home-dashboard-customize-title">Dashboard modules</div>
      <label className="home-dashboard-customize-row">
        <span>Today &amp; Coming Up</span>
        <Switch size="small" checked={visibility.today} onChange={(v) => set('today', v)} />
      </label>
      <label className="home-dashboard-customize-row">
        <span>Work Queue</span>
        <Switch size="small" checked={visibility.work} onChange={(v) => set('work', v)} />
      </label>
      <label className="home-dashboard-customize-row">
        <span>News &amp; Narrative</span>
        <Switch size="small" checked={visibility.news} onChange={(v) => set('news', v)} />
      </label>
      <div className="home-dashboard-customize-note">
        Needs Action stays pinned so urgent client and policy signals are never hidden. Your choices
        are saved in this browser.
      </div>
    </div>
  );

  return (
    <div className="home-dashboard-customize">
      <Popover content={content} trigger="click" placement="bottomRight">
        <Button size="small">Customize</Button>
      </Popover>
    </div>
  );
}

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

  const persist = (next: DashboardVisibility) => {
    setVisibilityState(next);
    if (!preferenceKey || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(preferenceKey, JSON.stringify(next));
    } catch {
      // A blocked/full localStorage should never prevent dashboard customization
      // for the current session.
    }
  };

  return [visibility, persist];
}

/* ── Needs Action: preserve the existing horizontal signal strip ───────── */

interface BannerItemRaw {
  id: string;
  sev: 'critical' | 'notable' | 'info';
  eyebrow: string;
  title: string;
  context: string;
  href: string;
  rank: number;
}

interface BannerItem extends BannerItemRaw {
  dueLabel: string | null;
  actionLabel: string;
}

/* Map a BannerItem to the Figma status badge pill.
 * Badge kind is derived from severity + eyebrow content so the dashboard
 * surfaces the same CRITICAL / APPROVAL / DEADLINE / HEARING pills the
 * reference shows, without touching any upstream data shape. */
type AttentionBadge = 'critical' | 'approval' | 'deadline' | 'hearing';

function badgeFor(item: BannerItemRaw): { kind: AttentionBadge; label: string } {
  const eyebrow = item.eyebrow.toLowerCase();
  if (item.sev === 'critical') return { kind: 'critical', label: 'CRITICAL' };
  if (eyebrow.includes('hearing') || eyebrow.includes('markup'))
    return { kind: 'hearing', label: 'HEARING' };
  if (eyebrow.includes('review') || eyebrow.includes('approv') || eyebrow.includes('artifact'))
    return { kind: 'approval', label: 'APPROVAL' };
  return { kind: 'deadline', label: 'DEADLINE' };
}

/* Default per-row action verb. Keeps the row action compact + scannable. */
function actionFor(item: BannerItemRaw): string {
  const eyebrow = item.eyebrow.toLowerCase();
  if (eyebrow.includes('hearing') || eyebrow.includes('markup')) return 'Prepare';
  if (eyebrow.includes('review') || eyebrow.includes('approv')) return 'Review';
  if (eyebrow.includes('budget')) return 'Build brief';
  if (eyebrow.includes('comment') || eyebrow.includes('federal register') || eyebrow.includes('docket'))
    return 'Open docket';
  return 'Open';
}

/* Pull a short "DUE AUG 14" / "DUE TODAY" / "10:00 AM" string from the eyebrow
 * when the underlying event carries timing. Returns null when nothing useful
 * is available so the cell collapses cleanly. */
function dueLabelFor(item: BannerItemRaw): string | null {
  const m = item.eyebrow.match(/(?:·|^)\s*([^·]+?)\s*$/);
  if (!m) return null;
  const tail = (m[1] ?? '').trim();
  if (!tail) return null;
  if (/^\d+\s*(day|days|hr|hrs|hour|hours|min|mins|minute|minutes)\b/i.test(tail))
    return `DUE ${tail.toUpperCase()}`;
  if (/^(today|tomorrow)\b/i.test(tail)) return `DUE ${tail.toUpperCase()}`;
  if (/^\d{1,2}:\d{2}\s*(am|pm)?/i.test(tail)) return tail.toUpperCase();
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(tail))
    return `DUE ${tail.toUpperCase()}`;
  return null;
}

function NeedsAction({
  alerts,
  comingUp,
  changes,
  portfolioAlerts,
  clientNameById,
  loading,
  someSourcesUnavailable,
}: {
  alerts: CommentAlertItem[];
  comingUp: ComingUpItem[];
  changes: IntelligenceChange[];
  portfolioAlerts: PortfolioAlertItem[];
  clientNameById: Map<string, string>;
  loading: boolean;
  someSourcesUnavailable: boolean;
}) {
  const items = useMemo<BannerItem[]>(() => {
    const out: BannerItemRaw[] = [];
    const hasPortfolio = portfolioAlerts.length > 0;

    for (const alert of portfolioAlerts) {
      const sev: BannerItemRaw['sev'] =
        alert.severity === 'critical' || alert.severity === 'notable'
          ? alert.severity
          : 'info';
      out.push({
        id: `pa-${alert.id}`,
        sev,
        eyebrow: `${portfolioAlertCategoryLabel(alert.type)}${alert.countdownLabel ? ` · ${alert.countdownLabel}` : ''}`,
        title: alert.title,
        context: alert.clientName || 'Unmapped',
        href: alert.href ?? '/intelligence/changes',
        rank: typeof alert.countdownDays === 'number' ? Math.max(0, alert.countdownDays) : 50,
      });
    }

    if (!hasPortfolio) {
      for (const alert of alerts) {
        out.push({
          id: `c-${alert.documentId}`,
          sev: commentSeverity(alert.daysToDeadline),
          eyebrow: `${prettySource(alert.type || alert.agencies[0] || 'FedReg')} · ${deadlineLabel(alert.daysToDeadline)}`,
          title: alert.title,
          context: alert.clientName || 'Unmapped',
          href: COMMENTS_LINK,
          rank: Math.max(0, alert.daysToDeadline),
        });
      }

      for (const event of comingUp) {
        if (event.kind !== 'hearing' && event.kind !== 'markup') continue;
        const sev =
          event.severity === 'critical' || event.severity === 'notable'
            ? event.severity
            : 'info';
        out.push({
          id: `e-${event.id}`,
          sev,
          eyebrow: `${event.kind === 'markup' ? 'Markup' : 'Hearing'} · ${whenLabel(event.date, event.time)}`,
          title: event.title,
          context: event.label || event.detail || 'Capitol Hill',
          href: event.href ?? '/legiwatch',
          rank: Math.max(0, dayDiff(event.date)),
        });
      }
    }

    for (const change of changes) {
      const sev =
        change.severity === 'critical' || change.severity === 'notable'
          ? change.severity
          : 'info';
      const names = change.relatedClientIds
        .map((id) => clientNameById.get(id))
        .filter(Boolean) as string[];

      if (change.source === 'program_element') {
        const pe = change.relatedPeCodes?.[0];
        out.push({
          id: `pe-${change.id}`,
          sev,
          eyebrow: `Budget · ${peChangeLabel(change.changeType)}`,
          title: change.title,
          context: pe ? `PE ${pe}` : (names[0] ?? 'Tracked program'),
          href: pe ? `/program-elements/${encodeURIComponent(pe)}` : '/intelligence/changes',
          rank: hoursSince(change.detectedAt),
        });
      } else if (change.source === 'congress_bill' && change.changeType.startsWith('bill_')) {
        out.push({
          id: `b-${change.id}`,
          sev,
          eyebrow: `Bill · ${relativeTime(change.detectedAt)}`,
          title: change.title,
          context:
            names[0] ??
            (change.relatedIssues[0] ? `Issue ${change.relatedIssues[0]}` : 'Tracked bill'),
          href: '/intelligence/changes',
          rank: hoursSince(change.detectedAt),
        });
      } else if (change.source === 'state_bill') {
        out.push({
          id: `sb-${change.id}`,
          sev,
          eyebrow: `State bill · ${relativeTime(change.detectedAt)}`,
          title: change.title,
          context: names[0] ?? 'Tracked state bill',
          href: change.relatedClientIds[0]
            ? `/legiwatch?tab=bills&client=${encodeURIComponent(change.relatedClientIds[0])}`
            : '/legiwatch?tab=bills',
          rank: hoursSince(change.detectedAt),
        });
      } else if (change.source === 'redistricting') {
        out.push({
          id: `rd-${change.id}`,
          sev,
          eyebrow: `Redistricting · ${relativeTime(change.detectedAt)}`,
          title: change.title,
          context:
            names[0] ??
            (change.data as { name?: string } | undefined)?.name ??
            'Tracked district',
          href: redistrictingHref(change.data),
          rank: hoursSince(change.detectedAt),
        });
      } else if (
        (change.source === 'federal_register_document' || change.source === 'fec_contribution') &&
        sev !== 'info'
      ) {
        out.push({
          id: `r-${change.id}`,
          sev,
          eyebrow: `${prettySource(change.source)} · ${relativeTime(change.detectedAt)}`,
          title: change.title,
          context: names[0] ?? 'Unmapped',
          href: '/intelligence/changes',
          rank: hoursSince(change.detectedAt),
        });
      }
    }

    const severityRank = { critical: 0, notable: 1, info: 2 } as const;
    return out
      .sort((a, b) => severityRank[a.sev] - severityRank[b.sev] || a.rank - b.rank)
      .slice(0, 4)
      .map((item) => ({
        ...item,
        dueLabel: dueLabelFor(item),
        actionLabel: actionFor(item),
      }));
  }, [alerts, clientNameById, comingUp, changes, portfolioAlerts]);

  return (
    <section className="home-attention" aria-label="Needs Action">
      <header className="home-attention-head">
        <span className="home-attention-title">Needs Action</span>
        <span className="home-attention-count">
          {items.length} PRIORITIZED ITEM{items.length === 1 ? '' : 'S'}
        </span>
        <Link to="/intelligence/changes" className="home-attention-viewall">
          View all →
        </Link>
      </header>
      {loading ? (
        <div className="home-attention-scroll" role="status" aria-label="Loading">
          {[0, 1, 2, 3].map((i) => (
            <div className="home-attention-card" key={i}>
              <Skeleton active paragraph={{ rows: 2 }} title={false} />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div style={{ padding: 24 }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              someSourcesUnavailable
                ? "Couldn't load some sources — this list may be incomplete. Try refreshing."
                : 'Nothing needs your action right now.'
            }
          />
        </div>
      ) : (
        <ul className="home-attention-scroll">
          {items.map((item, idx) => {
            const badge = badgeFor(item);
            return (
              <li key={item.id} className={`home-attention-card${idx === 0 ? ' is-first' : ''}`}>
                <span className={`home-attention-badge is-${badge.kind}`}>
                  <span className="home-attention-badge-dot" aria-hidden />
                  {badge.label}
                </span>
                <span className="home-attention-body">
                  <span className="home-attention-eyebrow">{item.eyebrow}</span>
                  <Link to={item.href} className="home-attention-title-row home-clamp-2">
                    {item.title}
                  </Link>
                </span>
                <span className="home-attention-context home-clamp-1">{item.context}</span>
                {item.dueLabel ? (
                  <span className="home-attention-due">{item.dueLabel}</span>
                ) : (
                  <span className="home-attention-due is-empty" aria-hidden />
                )}
                <Link to={item.href} className="home-attention-action">
                  {item.actionLabel}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ── Today & Coming Up: meetings + direct actions + policy calendar ────── */

function TodayAndComingUp({
  meetings,
  comingUp,
  loading,
}: {
  meetings: DashMeeting[];
  comingUp: ComingUpItem[];
  loading: boolean;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const now = useMemo(() => new Date(), []);
  const days = useMemo(() => weekDays(now), [now]);
  const todayKey = dayKey(now);
  const [selectedDay, setSelectedDay] = useState<string>(todayKey);

  const [notetakerForm] = Form.useForm();
  const notetakerAuthorized = Form.useWatch('authorizedToRecord', notetakerForm);
  const notetakerNotified = Form.useWatch('allPartiesWillBeNotified', notetakerForm);
  const [notetakerOpen, setNotetakerOpen] = useState(false);
  const [notetakerTargetId, setNotetakerTargetId] = useState<string | null>(null);
  const [notesMeetingId, setNotesMeetingId] = useState<string | null>(null);
  const [briefMeetingId, setBriefMeetingId] = useState<string | null>(null);
  const [briefGeneratingId, setBriefGeneratingId] = useState<string | null>(null);

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
      message.success('Meri is joining the meeting');
      setNotetakerOpen(false);
      notetakerForm.resetFields();
      void qc.invalidateQueries({ queryKey: ['engagement-meetings-week'] });
    },
    onError: (error: unknown) =>
      message.error(error instanceof Error ? error.message : 'Could not send Meri'),
  });

  const notesQuery = useQuery<HomeDebrief[]>({
    queryKey: ['engagement-meeting-debriefs', notesMeetingId],
    queryFn: async () =>
      (await api.get<HomeDebrief[]>(`/api/engagement/meetings/${notesMeetingId}/debriefs`)).data,
    enabled: Boolean(notesMeetingId),
  });

  const briefQuery = useQuery<Meeting>({
    queryKey: ['engagement-meeting-full', briefMeetingId],
    queryFn: async () => (await api.get<Meeting>(`/api/engagement/meetings/${briefMeetingId}`)).data,
    enabled: Boolean(briefMeetingId),
  });

  const generateBrief = useMutation({
    mutationFn: async (meetingId: string) =>
      (await api.post(`/api/engagement/meetings/${meetingId}/prep`, {})).data,
    onSuccess: (_data, meetingId) => {
      message.success('Meeting brief generated.');
      setBriefMeetingId(meetingId);
      void qc.invalidateQueries({ queryKey: ['engagement-meetings-week'] });
      void qc.invalidateQueries({ queryKey: ['engagement-meeting-full', meetingId] });
    },
    onError: (error: unknown) =>
      message.error(error instanceof Error ? error.message : 'Could not generate meeting brief'),
    onSettled: () => setBriefGeneratingId(null),
  });

  const openNotetaker = (meeting: DashMeeting) => {
    setNotetakerTargetId(meeting.id);
    notetakerForm.setFieldsValue({
      meetingUrl: extractMeetingJoinUrl(meeting) ?? '',
      authorizedToRecord: false,
      allPartiesWillBeNotified: false,
    });
    setNotetakerOpen(true);
  };

  const meetingDayKeys = useMemo(
    () => new Set(meetings.map((meeting) => dayKey(new Date(meeting.startsAt)))),
    [meetings],
  );
  const policyDayKeys = useMemo(
    () =>
      new Set(
        comingUp
          .filter((event) => event.kind !== 'meeting')
          .map((event) => comingUpDayKey(event.date)),
      ),
    [comingUp],
  );

  const dayMeetings = useMemo(
    () =>
      meetings
        .filter((meeting) => dayKey(new Date(meeting.startsAt)) === selectedDay)
        .sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt)),
    [meetings, selectedDay],
  );

  const dayPolicyEvents = useMemo(
    () =>
      comingUp
        .filter(
          (event) => event.kind !== 'meeting' && comingUpDayKey(event.date) === selectedDay,
        )
        .sort((a, b) => String(a.time ?? '').localeCompare(String(b.time ?? ''))),
    [comingUp, selectedDay],
  );

  return (
    <div className="home-panel">
      <header className="home-panel-head">
        <span className="home-panel-title">Today &amp; Coming Up</span>
        <span className="open">
          <Link to="/engagement">Open Engagement Manager →</Link>
        </span>
      </header>

      <div className="home-week-label">This Week</div>
      <div className="home-week-strip">
        {days.map((day) => {
          const hasActivity = meetingDayKeys.has(day.key) || policyDayKeys.has(day.key);
          const className = [
            'home-week-day',
            day.isToday ? 'is-today' : '',
            day.key === selectedDay ? 'is-selected' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              type="button"
              key={day.key}
              className={className}
              onClick={() => setSelectedDay(day.key)}
            >
              <span className="home-week-wd">{day.weekday}</span>
              <span className="home-week-num num">{day.dayNum}</span>
              {hasActivity ? <span className="home-week-dot" aria-hidden /> : null}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="home-panel-list">
          {[0, 1, 2].map((i) => (
            <div className="home-panel-row" key={i}>
              <Skeleton active paragraph={{ rows: 1 }} title={false} />
            </div>
          ))}
        </div>
      ) : dayMeetings.length === 0 && dayPolicyEvents.length === 0 ? (
        <div className="home-panel-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`Nothing scheduled on ${selectedDayLabel(selectedDay)}.`}
          />
        </div>
      ) : (
        <>
          {dayMeetings.length > 0 ? (
            <div className="home-panel-list">
              {dayMeetings.map((meeting) => {
                const channel =
                  meeting.location || (meeting.source ? prettySource(meeting.source) : null);
                const who =
                  meeting.organizerName ||
                  meeting.attendees.find((attendee) => attendee.name)?.name ||
                  meeting.client?.name ||
                  '';
                const hasBrief = meeting.preps.length > 0;
                const hasDebrief = meeting.debriefs.length > 0 || meeting.meri === 'done';
                const joinUrl = extractMeetingJoinUrl(meeting);
                const canMeri = meeting.isVirtual ?? Boolean(joinUrl);

                return (
                  <div key={meeting.id} className="home-panel-row-wrap">
                    <Link
                      to={`/engagement/meetings/${encodeURIComponent(meeting.id)}`}
                      className="home-panel-row"
                    >
                      <div className="home-panel-row-main">
                        <span className="home-meeting-when num">
                          {formatCompactTime(new Date(meeting.startsAt))}
                        </span>
                        <span className="home-panel-row-title">{meeting.subject}</span>
                        <span className="home-panel-row-sub">
                          {[who, channel].filter(Boolean).join(' · ') || ' '}
                        </span>
                      </div>
                    </Link>
                    <div className="home-meeting-actions">
                      {joinUrl ? (
                        <button
                          type="button"
                          className="dash-btn-soft"
                          onClick={() => openMeetingJoinLink(meeting)}
                        >
                          Join
                        </button>
                      ) : null}
                      {hasBrief ? (
                        <button
                          type="button"
                          className="dash-btn-soft"
                          onClick={() => setBriefMeetingId(meeting.id)}
                        >
                          View Brief
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="dash-btn-soft"
                          disabled={briefGeneratingId === meeting.id}
                          onClick={() => {
                            setBriefGeneratingId(meeting.id);
                            generateBrief.mutate(meeting.id);
                          }}
                        >
                          {briefGeneratingId === meeting.id ? 'Preparing…' : 'Create Brief'}
                        </button>
                      )}
                      {hasDebrief ? (
                        <button
                          type="button"
                          className="dash-btn-soft"
                          onClick={() => setNotesMeetingId(meeting.id)}
                        >
                          Debrief
                        </button>
                      ) : canMeri ? (
                        <SendMeriButton
                          m={meeting}
                          size="sm"
                          className="dash-send-meri"
                          onClick={() => openNotetaker(meeting)}
                        />
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {dayPolicyEvents.length > 0 ? (
            <>
              <div className="home-coming-policy-label">Policy calendar</div>
              <div className="home-panel-list">
                {dayPolicyEvents.map((event) => {
                  const content = (
                    <>
                      <div className="home-panel-row-main">
                        <span className="home-meeting-when num">
                          {event.time || policyEventTimeLabel(event.kind)}
                        </span>
                        <span className="home-panel-row-title">{event.title}</span>
                        <span className="home-panel-row-sub">
                          {[event.label, event.detail].filter(Boolean).join(' · ')}
                        </span>
                      </div>
                      <Tag className="home-coming-kind">{policyKindLabel(event.kind)}</Tag>
                    </>
                  );
                  return event.href ? (
                    <Link
                      key={`${event.kind}-${event.id}`}
                      to={event.href}
                      className="home-panel-row home-coming-policy-row"
                    >
                      {content}
                    </Link>
                  ) : (
                    <div
                      key={`${event.kind}-${event.id}`}
                      className="home-panel-row home-coming-policy-row"
                    >
                      {content}
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </>
      )}

      <Modal
        title="Send Meri to take notes?"
        open={notetakerOpen}
        onCancel={() => setNotetakerOpen(false)}
        onOk={() => notetakerForm.submit()}
        okText="Send Meri"
        confirmLoading={dispatchNotetaker.isPending}
        okButtonProps={{ disabled: !(notetakerAuthorized && notetakerNotified) }}
        width={560}
        rootClassName="redesign"
      >
        <Form
          form={notetakerForm}
          layout="vertical"
          onFinish={(values) => {
            if (!notetakerTargetId) return;
            dispatchNotetaker.mutate({
              meetingId: notetakerTargetId,
              meetingUrl: values.meetingUrl,
            });
          }}
        >
          <NotetakerConsentFields />
        </Form>
      </Modal>

      <Modal
        title="Debrief"
        open={Boolean(notesMeetingId)}
        onCancel={() => setNotesMeetingId(null)}
        footer={null}
        width={640}
      >
        {notesQuery.isLoading ? (
          <span>Loading debrief…</span>
        ) : (() => {
            const debrief = (notesQuery.data ?? []).find((item) => !item.restricted && item.body);
            if (!debrief?.body) {
              return (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No debrief for this meeting yet."
                />
              );
            }
            return <DebriefNotesView body={debrief.body} />;
          })()}
      </Modal>

      <Modal
        title="Meeting Brief"
        open={Boolean(briefMeetingId)}
        onCancel={() => setBriefMeetingId(null)}
        footer={null}
        width={640}
      >
        <MeetingBriefBody meeting={briefQuery.data} loading={briefQuery.isLoading} />
      </Modal>
    </div>
  );
}

function MeetingBriefBody({ meeting, loading }: { meeting: Meeting | undefined; loading: boolean }) {
  if (loading) return <span>Loading brief…</span>;
  const prep = meeting?.preps?.[0] ?? null;
  if (!prep) {
    return (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No brief for this meeting yet." />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {prep.summary ? (
        <div>
          <SectionLabel style={{ marginBottom: 7 }}>Summary</SectionLabel>
          <p style={{ fontSize: 13, lineHeight: 1.65, color: 'var(--ink-2)', margin: 0 }}>
            {prep.summary}
          </p>
        </div>
      ) : null}
      {prep.agenda.length > 0 ? (
        <div>
          <SectionLabel style={{ marginBottom: 7 }}>Agenda</SectionLabel>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 13,
              lineHeight: 1.6,
              color: 'var(--ink-1)',
            }}
          >
            {prep.agenda.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {prep.talkingPoints.length > 0 ? (
        <div>
          <SectionLabel style={{ marginBottom: 9 }}>Talking points</SectionLabel>
          <ul
            style={{
              margin: 0,
              paddingLeft: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {prep.talkingPoints.map((item, index) => (
              <li
                key={index}
                style={{
                  display: 'flex',
                  gap: 10,
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: 'var(--ink-1)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono-rd)',
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--accent)',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                >
                  {String(index + 1).padStart(2, '0')}
                </span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {prep.risks.length > 0 ? (
        <div>
          <SectionLabel style={{ marginBottom: 9 }}>Watch-outs</SectionLabel>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {prep.risks.map((item, index) => (
              <div
                key={index}
                style={{
                  fontSize: 12.5,
                  lineHeight: 1.5,
                  color: 'var(--ink-2)',
                  padding: '9px 12px',
                  background: 'var(--notable-soft)',
                  borderRadius: 7,
                }}
              >
                {item}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── Work Queue: governed reviews + action cards + outreach drafts ─────── */

interface WorkQueueItem {
  id: string;
  title: string;
  subtitle: string;
  href: string;
  tag: string;
  tagColor?: string;
  rank: number;
  timestamp: number;
}

function WorkQueue({
  actions,
  reviews,
  outreach,
  loading,
}: {
  actions: ActionCardDto[];
  reviews: ReviewRequestDto[];
  outreach: DashOutreach[];
  loading: boolean;
}) {
  const items = useMemo<WorkQueueItem[]>(() => {
    const out: WorkQueueItem[] = [];

    for (const review of reviews) {
      out.push({
        id: `review-${review.id}`,
        title: review.title,
        subtitle: `${SURFACE_LABELS[review.surface]} · ${review.reason}`,
        href: `/reviews?id=${encodeURIComponent(review.id)}`,
        tag: `${RISK_TIER_LABELS[review.riskTier]} review`,
        tagColor: review.riskTier === 'restricted' || review.riskTier === 'high' ? 'red' : 'gold',
        rank: 0,
        timestamp: +new Date(review.createdAt),
      });
    }

    for (const action of actions) {
      if (!ACTIVE_ACTION_STATUSES.has(action.status)) continue;
      const deadline = action.deadline ? +new Date(action.deadline) : Number.POSITIVE_INFINITY;
      out.push({
        id: `action-${action.id}`,
        title: action.issueTitle,
        subtitle: [action.clientName, action.recommendedAction].filter(Boolean).join(' · '),
        href: '/actions',
        tag: ACTION_STATUS_LABELS[action.status],
        tagColor: action.status === 'ready_for_review' ? 'gold' : 'blue',
        rank: 1,
        timestamp: deadline,
      });
    }

    for (const draft of outreach) {
      if (draft.status !== 'draft') continue;
      const ready = Boolean(draft.body?.trim() && draft.recipientCount > 0);
      out.push({
        id: `outreach-${draft.id}`,
        title: draft.title,
        subtitle: [
          draft.client?.name,
          draft.subject ||
            (draft.recipientCount
              ? `${draft.recipientCount} recipient${draft.recipientCount === 1 ? '' : 's'}`
              : 'No recipients yet'),
        ]
          .filter(Boolean)
          .join(' · '),
        href: `/engagement/outreach/draft/${encodeURIComponent(draft.id)}`,
        tag: ready ? 'Ready to send' : 'Draft',
        tagColor: ready ? 'green' : undefined,
        rank: 2,
        timestamp: -new Date(draft.updatedAt).getTime(),
      });
    }

    return out
      .sort((a, b) => a.rank - b.rank || a.timestamp - b.timestamp)
      .slice(0, 8);
  }, [actions, outreach, reviews]);

  return (
    <div className="home-panel">
      <header className="home-panel-head">
        <span className="home-panel-title">Work Queue</span>
        <span className="open">
          <Link to="/actions">Open Actions →</Link>
        </span>
      </header>
      {loading ? (
        <div className="home-panel-list">
          {[0, 1, 2].map((i) => (
            <div className="home-panel-row" key={i}>
              <Skeleton active paragraph={{ rows: 1 }} title={false} />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="home-panel-empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Your work queue is clear." />
        </div>
      ) : (
        <div className="home-work-list">
          {items.map((item) => (
            <Link key={item.id} to={item.href} className="home-work-row">
              <div className="home-work-main">
                <span className="home-work-title">{item.title}</span>
                <span className="home-work-sub">{item.subtitle}</span>
              </div>
              <Tag color={item.tagColor} className="home-panel-tag">
                {item.tag}
              </Tag>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── News & Narrative: NewsCatcher client-relevance feed ───────────────── */

function NewsAndNarrative({
  data,
  loading,
  isError,
}: {
  data: NewsDashboardResponse | undefined;
  loading: boolean;
  isError: boolean;
}) {
  return (
    <div className="home-panel home-news-panel">
      <header className="home-panel-head">
        <span className="home-panel-title">News &amp; Narrative</span>
        <span className="open">Client-relevant coverage · last 48h</span>
      </header>

      {loading ? (
        <div className="home-panel-list">
          {[0, 1, 2, 3].map((i) => (
            <div className="home-panel-row" key={i}>
              <Skeleton active paragraph={{ rows: 1 }} title={false} />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div className="home-news-status">News intelligence could not load right now.</div>
      ) : !data?.available ? (
        <div className="home-news-status">{newsUnavailableMessage(data?.reason)}</div>
      ) : data.items.length === 0 ? (
        <div className="home-panel-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No client-relevant policy coverage found in the last 48 hours."
          />
        </div>
      ) : (
        <div className="home-panel-list home-news-list">
          {data.items.map((item) => (
            <a
              key={item.id}
              className="home-news-row"
              href={item.url}
              target="_blank"
              rel="noreferrer"
            >
              <span className="home-news-thumb" aria-hidden>
                <span className="home-news-thumb-fallback">{sourceInitials(item.source)}</span>
                {item.imageUrl ? (
                  <img
                    src={item.imageUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                    }}
                  />
                ) : null}
              </span>
              <div className="home-news-main">
                <span className="home-news-title">{item.title}</span>
                <span className="home-news-meta">
                  {item.source} · {relativeTime(item.publishedAt)}
                  {item.duplicateCount && item.duplicateCount > 1
                    ? ` · ${item.duplicateCount} similar placements`
                    : ''}
                </span>
                <span className="home-news-relevance">{item.relevanceReason}</span>
              </div>
              {item.topics[0] ? <Tag className="home-panel-tag">{item.topics[0]}</Tag> : null}
            </a>
          ))}
        </div>
      )}

      {data?.available ? (
        <div className="home-news-footnote">
          <span>
            NewsCatcher · {data.monitoredClientCount} client
            {data.monitoredClientCount === 1 ? '' : 's'} monitored
            {data.stale ? ' · cached fallback' : ''}
          </span>
          {data.coverageLimited ? (
            <span className="coverage-warning">· portfolio exceeds MVP entity-query envelope</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function sourceInitials(source: string): string {
  const parts = source
    .replace(/\.[a-z]{2,}$/i, '')
    .split(/[\s._-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const initials = parts
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
  return initials || 'N';
}

function newsUnavailableMessage(reason: NewsDashboardResponse['reason']): string {
  switch (reason) {
    case 'not_configured':
      return 'News intelligence is ready to activate once NEWSCATCHER_API_KEY is configured.';
    case 'no_clients':
      return 'Add an active client to begin monitoring relevant policy coverage.';
    case 'provider_unavailable':
      return 'NewsCatcher is unavailable right now. The rest of your dashboard is unaffected.';
    default:
      return 'News intelligence is not available right now.';
  }
}

/* ── Helpers ───────────────────────────────────────────────────────────── */

function congressSession(now: Date): string {
  const year = now.getFullYear();
  const month = now.getMonth();
  const startYear = month === 0 && now.getDate() < 3 ? year - 1 : year;
  const effectiveYear = startYear % 2 === 0 ? startYear - 1 : startYear;
  const congressNumber = 1 + Math.floor((effectiveYear - 1789) / 2);
  return `${ordinal(congressNumber)} Congress`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'] as const;
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? 'th');
}

function commentSeverity(days: number): 'critical' | 'notable' | 'info' {
  if (days <= 1) return 'critical';
  if (days <= 7) return 'notable';
  return 'info';
}

function portfolioAlertCategoryLabel(type: string): string {
  const map: Record<string, string> = {
    comment_deadline: 'Comment deadline',
    comment_overdue: 'Comment closed',
    competitor_filing: 'Competitor filing',
    contract_award: 'Contract award',
    hearing: 'Hearing',
    bill_movement: 'Bill movement',
    program_element: 'Budget move',
    congress_bill: 'Bill',
    federal_register_document: 'Regulation',
    fec_contribution: 'FEC',
  };
  return map[type] ?? prettySource(type);
}

function deadlineLabel(days: number): string {
  if (days <= 0) return 'closes today';
  if (days === 1) return 'closes tomorrow';
  return `${days} days`;
}

function peChangeLabel(changeType: string): string {
  switch (changeType) {
    case 'pe_mark_added':
      return 'New mark';
    case 'pe_mark_changed':
      return 'Mark changed';
    case 'pe_value_increased':
      return 'Value up';
    case 'pe_value_decreased':
      return 'Value down';
    case 'pe_milestone_slip':
      return 'Milestone slip';
    default:
      return 'Budget update';
  }
}

function dayDiff(dateIso: string): number {
  const key = comingUpDayKey(dateIso);
  const [year = 0, month = 0, day = 0] = key.split('-').map(Number);
  const target = new Date(year, month - 1, day);
  target.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function whenLabel(dateIso: string, time: string | null): string {
  const timeSuffix = time ? ` ${time}` : '';
  const difference = dayDiff(dateIso);
  if (difference <= 0) return `Today${timeSuffix}`;
  if (difference === 1) return `Tomorrow${timeSuffix}`;
  const [year = 0, month = 0, day = 0] = comingUpDayKey(dateIso).split('-').map(Number);
  return `${new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'short' })}${timeSuffix}`;
}

function hoursSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000));
}

function weekBounds(now: Date): { from: string; to: string } {
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { from: monday.toISOString(), to: sunday.toISOString() };
}

interface WeekDay {
  key: string;
  weekday: string;
  dayNum: string;
  isToday: boolean;
}

function weekDays(now: Date): WeekDay[] {
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);
  const todayKey = dayKey(now);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return {
      key: dayKey(date),
      weekday: date.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
      dayNum: date.toLocaleDateString('en-US', { day: 'numeric' }),
      isToday: dayKey(date) === todayKey,
    };
  });
}

function dayKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function comingUpDayKey(value: string): string {
  const dateOnly = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (dateOnly) return dateOnly;
  return dayKey(new Date(value));
}

function selectedDayLabel(key: string): string {
  const [year = 0, month = 0, day = 0] = key.split('-').map(Number);
  if (!year || !month || !day) return 'this day';
  return new Date(year, month - 1, day).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}

function formatCompactTime(date: Date): string {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const meridiem = hours >= 12 ? 'pm' : 'am';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return minutes === 0
    ? `${hour12}${meridiem}`
    : `${hour12}:${String(minutes).padStart(2, '0')}${meridiem}`;
}

function policyKindLabel(kind: ComingUpItem['kind']): string {
  switch (kind) {
    case 'hearing':
      return 'Hearing';
    case 'markup':
      return 'Markup';
    case 'deadline':
      return 'Deadline';
    default:
      return 'Event';
  }
}

function policyEventTimeLabel(kind: ComingUpItem['kind']): string {
  return kind === 'deadline' ? 'Due' : '—';
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function prettySource(raw: string): string {
  const map: Record<string, string> = {
    fec: 'FEC',
    sec: 'SEC EDGAR',
    fedreg: 'FedReg',
    federal_register: 'FedReg',
    federal_register_document: 'FedReg',
    congress: 'Congress.gov',
    lda: 'LDA',
    gao: 'GAO',
    crs: 'CRS',
    bls: 'BLS',
    outlook: 'Outlook',
    google: 'Google Calendar',
  };
  const key = (raw ?? '').toLowerCase();
  return map[key] ?? (raw ?? '').replace(/[_-]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
