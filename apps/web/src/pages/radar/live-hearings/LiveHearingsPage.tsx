import { useMemo, useState, type ReactNode } from 'react';
import { Alert, App as AntApp, Button, Empty, Input, Select, Spin, Tooltip } from 'antd';
import {
  AudioOutlined,
  BankOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  FileSearchOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  ScheduleOutlined,
  SearchOutlined,
  TeamOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  useCreateHearing,
  useHearingSessionHistory,
} from '../../../lib/hearing-watch-api.js';
import {
  browserCaptureCapability,
  capturePolicyLabel,
  captureStatusLabel,
  isLiveEvent,
  safeOfficialHttpUrl,
  serverCaptureCapability,
} from './live-hearings-capability.js';
import {
  liveHearingApiError,
  useCancelScheduledHearing,
  useCanonicalHearingEvent,
  useCommitteeRoom,
  useHearingIntelligence,
  useHearingUpdates,
  useLiveHearingsCalendar,
  useLiveHearingsLive,
  usePublicHearingTranscript,
  useScheduleHearing,
} from './live-hearings-api.js';
import type {
  CanonicalHearingEvent,
  HearingCommitteeRef,
  HearingIntelligenceItem,
  HearingSiteUpdate,
} from './live-hearings.types.js';
import './LiveHearingsPage.css';

type LiveHearingsView =
  | 'calendar'
  | 'live'
  | 'committees'
  | 'scheduled'
  | 'sessions'
  | 'archive'
  | 'event'
  | 'committee';

const VIEWS = new Set<LiveHearingsView>([
  'calendar',
  'live',
  'committees',
  'scheduled',
  'sessions',
  'archive',
  'event',
  'committee',
]);

interface ViewDefinition {
  id: Exclude<LiveHearingsView, 'event' | 'committee'>;
  label: string;
  icon: ReactNode;
}

const VIEW_DEFINITIONS: ViewDefinition[] = [
  { id: 'calendar', label: 'Master Calendar', icon: <CalendarOutlined /> },
  { id: 'live', label: 'Live Now', icon: <PlayCircleOutlined /> },
  { id: 'committees', label: 'Committee Rooms', icon: <BankOutlined /> },
  { id: 'scheduled', label: 'Scheduled Recordings', icon: <ScheduleOutlined /> },
  { id: 'sessions', label: 'My Sessions', icon: <AudioOutlined /> },
  { id: 'archive', label: 'Archive', icon: <HistoryOutlined /> },
];

function todayInput(offsetDays = 0): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function dayBoundary(value: string, end = false): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00.000'}`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function formatDateTime(value?: string, timeZone = 'America/New_York'): string {
  if (!value) return 'Time not announced';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(date);
}

function titleCase(value?: string): string {
  return (value ?? 'Unknown')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusTone(value?: string): string {
  const status = (value ?? '').toUpperCase();
  if (['LIVE', 'RECORDING'].includes(status)) return 'live';
  if (['FAILED', 'SOURCE_ERROR', 'POLICY_BLOCKED', 'CANCELED'].includes(status)) return 'danger';
  if (['RECOVERING', 'WAITING_FOR_STREAM', 'WAITING_FOR_BROADCAST', 'POSTPONED'].includes(status)) {
    return 'warning';
  }
  if (['COMPLETE', 'COMPLETED', 'ENDED'].includes(status)) return 'complete';
  return 'neutral';
}

function SourceHealthBanner({
  health,
}: {
  health?: {
    complete?: boolean;
    healthy?: number;
    expected?: number;
    degraded?: number;
    failing?: number;
    reviewRequired?: number;
  };
}) {
  if (!health || health.complete) return null;
  const expected = health.expected ?? 0;
  const healthy = health.healthy ?? 0;
  return (
    <Alert
      type="warning"
      showIcon
      message="Calendar coverage is still being reconciled"
      description={
        expected
          ? `${healthy} of ${expected} official source bodies are currently healthy. Unavailable sources remain visible as coverage exceptions rather than being treated as empty calendars.`
          : 'One or more official committee sources is degraded, unavailable, or awaiting review.'
      }
    />
  );
}

function LoadingBlock({ label = 'Loading live hearings…' }: { label?: string }) {
  return (
    <div className="lh-loading" role="status">
      <Spin />
      <span>{label}</span>
    </div>
  );
}

function ErrorBlock({
  error,
  onRetry,
  title = 'Couldn’t load Live Hearings',
}: {
  error: unknown;
  onRetry: () => void;
  title?: string;
}) {
  return (
    <Alert
      type="error"
      showIcon
      message={title}
      description={liveHearingApiError(error)}
      action={
        <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
          Retry
        </Button>
      }
    />
  );
}

function EventStatus({ event }: { event: CanonicalHearingEvent }) {
  const status = isLiveEvent(event)
    ? 'LIVE'
    : event.capture?.status && event.capture.status !== 'NOT_SCHEDULED'
      ? event.capture.status
      : event.eventStatus;
  return (
    <span className={`lh-status lh-status--${statusTone(status)}`}>
      {status === 'LIVE' || status === 'RECORDING' ? <span className="lh-status__pulse" /> : null}
      {titleCase(status)}
    </span>
  );
}

function EventCard({
  event,
  onOpen,
  compact = false,
}: {
  event: CanonicalHearingEvent;
  onOpen: (event: CanonicalHearingEvent) => void;
  compact?: boolean;
}) {
  const server = serverCaptureCapability(event);
  return (
    <article className={`lh-event-card${compact ? ' lh-event-card--compact' : ''}`}>
      <div className="lh-event-card__time">
        <span>{formatDateTime(event.scheduledStart, event.timeZone)}</span>
        {event.location ? <small>{event.location}</small> : null}
      </div>
      <div className="lh-event-card__body">
        <div className="lh-event-card__meta">
          <span>{event.chamber}</span>
          <span>·</span>
          <span>{event.subcommittee?.name ?? event.committee.name}</span>
          <span>·</span>
          <span>{titleCase(event.eventType)}</span>
        </div>
        <h3>{event.title}</h3>
        <div className="lh-event-card__facts">
          {event.witnessCount ? <span>{event.witnessCount} witnesses</span> : null}
          {event.documentCount ? <span>{event.documentCount} documents</span> : null}
          <span>{capturePolicyLabel(event.capturePolicy)}</span>
          {!server.allowed && server.reason ? (
            <Tooltip title={server.reason}>
              <span className="lh-event-card__exception">Capture exception</span>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <div className="lh-event-card__actions">
        <EventStatus event={event} />
        <button type="button" className="lh-button lh-button--primary" onClick={() => onOpen(event)}>
          Enter room
        </button>
      </div>
    </article>
  );
}

function CalendarView({ openEvent }: { openEvent: (event: CanonicalHearingEvent) => void }) {
  const [from, setFrom] = useState(todayInput(-1));
  const [to, setTo] = useState(todayInput(30));
  const [search, setSearch] = useState('');
  const [chamber, setChamber] = useState<string | undefined>();
  const calendar = useLiveHearingsCalendar({
    from: dayBoundary(from),
    to: dayBoundary(to, true),
    chamber,
    search: search.trim() || undefined,
    limit: 250,
  });

  return (
    <section className="lh-view" aria-labelledby="master-calendar-title">
      <div className="lh-view__heading">
        <div>
          <span className="lh-kicker">Official House, Senate, joint, and committee sources</span>
          <h2 id="master-calendar-title">Master Calendar</h2>
          <p>Every discovered proceeding stays visible until it is captured or assigned an explicit exception.</p>
        </div>
        <div className="lh-count">{calendar.data?.total?.toLocaleString() ?? '—'} events</div>
      </div>

      <div className="lh-filterbar">
        <label>
          <span>From</span>
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label>
          <span>To</span>
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
        </label>
        <label className="lh-filterbar__search">
          <span>Search</span>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Title, committee, witness, or issue"
          />
        </label>
        <label>
          <span>Chamber</span>
          <Select
            allowClear
            value={chamber}
            placeholder="All chambers"
            onChange={(value) => setChamber(value)}
            options={[
              { value: 'HOUSE', label: 'House' },
              { value: 'SENATE', label: 'Senate' },
              { value: 'JOINT', label: 'Joint' },
            ]}
          />
        </label>
      </div>

      <SourceHealthBanner health={calendar.data?.sourceHealth} />
      {calendar.isLoading ? <LoadingBlock /> : null}
      {calendar.isError ? (
        <ErrorBlock error={calendar.error} onRetry={() => void calendar.refetch()} />
      ) : null}
      {!calendar.isLoading && !calendar.isError && (calendar.data?.items.length ?? 0) === 0 ? (
        <Empty description="No official proceedings match this date range and filter." />
      ) : null}
      <div className="lh-event-list">
        {calendar.data?.items.map((event) => (
          <EventCard key={event.id} event={event} onOpen={openEvent} />
        ))}
      </div>
    </section>
  );
}

function LiveNowView({ openEvent }: { openEvent: (event: CanonicalHearingEvent) => void }) {
  const live = useLiveHearingsLive();
  return (
    <section className="lh-view" aria-labelledby="live-now-title">
      <div className="lh-view__heading">
        <div>
          <span className="lh-kicker">Updated every 15 seconds</span>
          <h2 id="live-now-title">Live Now</h2>
          <p>Enter a room already being captured or use browser-assisted recording when required.</p>
        </div>
        <span className="lh-live-indicator">
          <span />
          {live.data?.length ?? 0} live
        </span>
      </div>
      {live.isLoading ? <LoadingBlock label="Checking live committee rooms…" /> : null}
      {live.isError ? <ErrorBlock error={live.error} onRetry={() => void live.refetch()} /> : null}
      {!live.isLoading && !live.isError && (live.data?.length ?? 0) === 0 ? (
        <div className="lh-empty-state">
          <VideoCameraOutlined />
          <h3>No public proceedings are live right now</h3>
          <p>The master calendar continues monitoring scheduled starts and delayed broadcasts.</p>
        </div>
      ) : null}
      <div className="lh-event-list">
        {live.data?.map((event) => (
          <EventCard key={event.id} event={event} onOpen={openEvent} />
        ))}
      </div>
    </section>
  );
}

function CommitteeRoomsView({
  openCommittee,
}: {
  openCommittee: (committee: HearingCommitteeRef) => void;
}) {
  const calendar = useLiveHearingsCalendar({
    from: dayBoundary(todayInput(-90)),
    to: dayBoundary(todayInput(180), true),
    limit: 500,
  });
  const committees = useMemo(() => {
    const byId = new Map<string, { committee: HearingCommitteeRef; upcoming: number; recent: number }>();
    const now = Date.now();
    for (const event of calendar.data?.items ?? []) {
      const committee = event.subcommittee ?? event.committee;
      const key = committee.id ?? committee.systemCode ?? committee.name;
      const current = byId.get(key) ?? { committee, upcoming: 0, recent: 0 };
      const timestamp = event.scheduledStart ? new Date(event.scheduledStart).getTime() : Number.NaN;
      if (Number.isFinite(timestamp) && timestamp >= now) current.upcoming += 1;
      else current.recent += 1;
      byId.set(key, current);
    }
    return [...byId.values()].sort((left, right) =>
      left.committee.name.localeCompare(right.committee.name),
    );
  }, [calendar.data]);

  return (
    <section className="lh-view" aria-labelledby="committee-rooms-title">
      <div className="lh-view__heading">
        <div>
          <span className="lh-kicker">Persistent official-source rooms</span>
          <h2 id="committee-rooms-title">Committee Rooms</h2>
          <p>Follow a committee’s schedule, members, official updates, documents, and recent proceedings.</p>
        </div>
      </div>
      {calendar.isLoading ? <LoadingBlock label="Building committee rooms from the canonical calendar…" /> : null}
      {calendar.isError ? (
        <ErrorBlock error={calendar.error} onRetry={() => void calendar.refetch()} />
      ) : null}
      {!calendar.isLoading && !calendar.isError && committees.length === 0 ? (
        <Empty description="No committee identities have been reconciled yet." />
      ) : null}
      <div className="lh-committee-grid">
        {committees.map(({ committee, upcoming, recent }) => {
          const identifier = committee.id ?? committee.systemCode;
          return (
            <article className="lh-committee-card" key={identifier ?? committee.name}>
              <div className="lh-committee-card__icon">
                <TeamOutlined />
              </div>
              <div>
                <span className="lh-kicker">{committee.chamber ?? 'Congressional committee'}</span>
                <h3>{committee.name}</h3>
                {committee.parentName ? <p>{committee.parentName}</p> : null}
              </div>
              <div className="lh-committee-card__stats">
                <span>
                  <strong>{upcoming}</strong>
                  Upcoming
                </span>
                <span>
                  <strong>{recent}</strong>
                  Recent
                </span>
              </div>
              <button
                type="button"
                className="lh-button"
                disabled={!identifier}
                title={!identifier ? 'The canonical committee id has not been reconciled.' : undefined}
                onClick={() => openCommittee(committee)}
              >
                Enter committee room
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ScheduledView({ openEvent }: { openEvent: (event: CanonicalHearingEvent) => void }) {
  const scheduled = useLiveHearingsCalendar({
    from: dayBoundary(todayInput(-1)),
    to: dayBoundary(todayInput(180), true),
    scheduled: true,
    limit: 250,
  });
  return (
    <section className="lh-view" aria-labelledby="scheduled-title">
      <div className="lh-view__heading">
        <div>
          <span className="lh-kicker">Runs while you are offline</span>
          <h2 id="scheduled-title">Scheduled Recordings</h2>
          <p>Tenant subscriptions point to one global capture, preventing duplicate media and Deepgram jobs.</p>
        </div>
      </div>
      {scheduled.isLoading ? <LoadingBlock label="Loading scheduled recordings…" /> : null}
      {scheduled.isError ? (
        <ErrorBlock error={scheduled.error} onRetry={() => void scheduled.refetch()} />
      ) : null}
      {!scheduled.isLoading && !scheduled.isError && (scheduled.data?.items.length ?? 0) === 0 ? (
        <div className="lh-empty-state">
          <ScheduleOutlined />
          <h3>No hearings are scheduled for unattended capture</h3>
          <p>Open a public event room to schedule an eligible first-party source.</p>
        </div>
      ) : null}
      <div className="lh-event-list">
        {scheduled.data?.items.map((event) => (
          <EventCard key={event.id} event={event} onOpen={openEvent} />
        ))}
      </div>
    </section>
  );
}

function SessionsView() {
  const navigate = useNavigate();
  const sessions = useHearingSessionHistory();
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="lh-view" aria-labelledby="sessions-title">
      <div className="lh-view__heading">
        <div>
          <span className="lh-kicker">Browser-assisted and private sessions</span>
          <h2 id="sessions-title">My Sessions</h2>
          <p>The existing browser capture path remains available alongside the new shared public capture system.</p>
        </div>
      </div>
      {sessions.isLoading ? <LoadingBlock label="Loading your hearing sessions…" /> : null}
      {sessions.isError ? (
        <ErrorBlock error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : null}
      {!sessions.isLoading && !sessions.isError && items.length === 0 ? (
        <Empty description="You have not started a browser-assisted hearing session." />
      ) : null}
      <div className="lh-session-list">
        {items.map((session) => (
          <button
            type="button"
            className="lh-session-row"
            key={session.id}
            onClick={() => navigate(`/intelligence/hearing-watch/${session.id}`)}
          >
            <span className="lh-session-row__icon">
              <AudioOutlined />
            </span>
            <span className="lh-session-row__body">
              <strong>{session.title}</strong>
              <small>
                {titleCase(session.sourceType)}
                {session.startedAt ? ` · ${formatDateTime(session.startedAt)}` : ''}
              </small>
            </span>
            <span className={`lh-status lh-status--${statusTone(session.status)}`}>
              {titleCase(session.status)}
            </span>
          </button>
        ))}
      </div>
      {sessions.hasNextPage ? (
        <div className="lh-centered-action">
          <Button
            loading={sessions.isFetchingNextPage}
            onClick={() => void sessions.fetchNextPage()}
          >
            Load more sessions
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function ArchiveView({ openEvent }: { openEvent: (event: CanonicalHearingEvent) => void }) {
  const archive = useLiveHearingsCalendar({
    from: dayBoundary(todayInput(-365)),
    to: dayBoundary(todayInput(1), true),
    eventStatus: 'COMPLETED',
    limit: 250,
  });
  return (
    <section className="lh-view" aria-labelledby="archive-title">
      <div className="lh-view__heading">
        <div>
          <span className="lh-kicker">Canonical public record</span>
          <h2 id="archive-title">Archive</h2>
          <p>Completed hearings, final transcripts, capture gaps, official documents, and derived intelligence.</p>
        </div>
      </div>
      {archive.isLoading ? <LoadingBlock label="Loading the hearing archive…" /> : null}
      {archive.isError ? <ErrorBlock error={archive.error} onRetry={() => void archive.refetch()} /> : null}
      {!archive.isLoading && !archive.isError && (archive.data?.items.length ?? 0) === 0 ? (
        <Empty description="No completed canonical hearings are available in this range." />
      ) : null}
      <div className="lh-event-list">
        {archive.data?.items.map((event) => (
          <EventCard key={event.id} event={event} onOpen={openEvent} />
        ))}
      </div>
    </section>
  );
}

function UpdateTimeline({ updates }: { updates: HearingSiteUpdate[] }) {
  if (!updates.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No official site changes recorded." />;
  return (
    <ol className="lh-timeline">
      {updates.map((update) => {
        const source = safeOfficialHttpUrl(update.sourceUrl);
        return (
          <li key={update.id}>
            <span className="lh-timeline__dot" />
            <div>
              <span className="lh-kicker">{titleCase(update.updateType)}</span>
              <h4>{update.title}</h4>
              {update.summary ? <p>{update.summary}</p> : null}
              <small>
                {formatDateTime(update.publishedAt ?? update.firstSeenAt)}
                {source ? (
                  <>
                    {' · '}
                    <a href={source} target="_blank" rel="noreferrer">
                      Official source
                    </a>
                  </>
                ) : null}
              </small>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function IntelligencePanel({ items }: { items: HearingIntelligenceItem[] }) {
  if (!items.length) {
    return (
      <div className="lh-empty-inline">
        Live intelligence will appear when transcript segments produce source-grounded facts.
      </div>
    );
  }
  return (
    <div className="lh-insight-list">
      {items.map((item) => (
        <article className="lh-insight" key={item.id}>
          <div className="lh-insight__meta">
            <span>{titleCase(item.insightType)}</span>
            {item.preliminary ? <span className="lh-preliminary">Preliminary</span> : null}
            {item.startMs !== undefined ? <span>{Math.floor(item.startMs / 1000)}s</span> : null}
          </div>
          <h4>{item.title}</h4>
          <p>{item.summary}</p>
          {item.evidenceText ? <blockquote>{item.evidenceText}</blockquote> : null}
          {item.entities?.length ? (
            <div className="lh-tag-row">
              {item.entities.map((entity) => (
                <span key={`${item.id}-${entity.entityType}-${entity.label}`}>
                  {entity.label}
                </span>
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function PublicTranscript({
  event,
}: {
  event: CanonicalHearingEvent;
}) {
  const transcript = usePublicHearingTranscript(event.id);
  const segments = useMemo(
    () =>
      (transcript.data?.pages.flatMap((page) => page.items) ?? []).sort(
        (left, right) => left.sequence - right.sequence,
      ),
    [transcript.data],
  );
  if (transcript.isLoading) return <LoadingBlock label="Loading the canonical transcript…" />;
  if (transcript.isError) {
    return (
      <div className="lh-empty-inline">
        No canonical server transcript is available yet. Browser-assisted sessions remain under My Sessions.
      </div>
    );
  }
  if (!segments.length) {
    return (
      <div className="lh-empty-inline">
        The public transcript has not started. Capture status: {captureStatusLabel(event)}.
      </div>
    );
  }
  return (
    <div className="lh-transcript" role="log" aria-label="Canonical public hearing transcript">
      {segments.map((segment) => (
        <div className="lh-transcript__segment" key={segment.id}>
          {segment.gapBefore ? (
            <div className="lh-transcript__gap">Capture gap recorded before this segment</div>
          ) : null}
          <span className="lh-transcript__time">{Math.floor(segment.startMs / 1000)}s</span>
          <p>
            {segment.speakerName || segment.speakerLabel ? (
              <strong>{segment.speakerName ?? segment.speakerLabel}: </strong>
            ) : null}
            {segment.text}
          </p>
        </div>
      ))}
      {transcript.hasNextPage ? (
        <Button
          loading={transcript.isFetchingNextPage}
          onClick={() => void transcript.fetchNextPage()}
        >
          Load earlier transcript segments
        </Button>
      ) : null}
    </div>
  );
}

function EventRoom({
  eventId,
  onBack,
  openCommittee,
}: {
  eventId: string;
  onBack: () => void;
  openCommittee: (committee: HearingCommitteeRef) => void;
}) {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const eventQuery = useCanonicalHearingEvent(eventId);
  const updates = useHearingUpdates(eventId);
  const intelligence = useHearingIntelligence(eventId);
  const schedule = useScheduleHearing();
  const cancel = useCancelScheduledHearing();
  const createBrowserSession = useCreateHearing();

  if (eventQuery.isLoading) return <LoadingBlock label="Opening hearing room…" />;
  if (eventQuery.isError || !eventQuery.data) {
    return (
      <ErrorBlock
        title="Couldn’t open this hearing room"
        error={eventQuery.error}
        onRetry={() => void eventQuery.refetch()}
      />
    );
  }

  const event = eventQuery.data;
  const officialUrl = safeOfficialHttpUrl(event.officialPageUrl);
  const server = serverCaptureCapability(event);
  const browser = browserCaptureCapability(event);
  const scheduled = Boolean(event.subscription?.scheduled);
  const committeeIdentifier =
    event.subcommittee?.id ??
    event.subcommittee?.systemCode ??
    event.committee.id ??
    event.committee.systemCode;

  const scheduleCapture = () => {
    schedule.mutate(event.id, {
      onSuccess: () => message.success('Unattended recording scheduled'),
      onError: (error) => message.error(liveHearingApiError(error)),
    });
  };
  const cancelCapture = () => {
    cancel.mutate(event.id, {
      onSuccess: () => message.success('Scheduled recording canceled'),
      onError: (error) => message.error(liveHearingApiError(error)),
    });
  };
  const startBrowserCapture = () => {
    if (!browser.allowed || !officialUrl) return;
    createBrowserSession.mutate(
      {
        title: event.title.slice(0, 300),
        sourceType: event.eventType.toLowerCase().includes('markup') ? 'markup' : 'hearing',
        audioSource: 'browser_mic',
        recordingPolicy: 'transcript_only',
        sourceUrl: officialUrl,
        hearingId: event.id,
        committeeId: event.committee.id,
      },
      {
        onSuccess: (session) => navigate(`/intelligence/hearing-watch/${session.id}`),
        onError: (error) => message.error(liveHearingApiError(error)),
      },
    );
  };

  return (
    <section className="lh-room" aria-labelledby="hearing-room-title">
      <button type="button" className="lh-back" onClick={onBack}>
        ← Back to Live Hearings
      </button>
      <header className="lh-room__hero">
        <div>
          <div className="lh-room__meta">
            <EventStatus event={event} />
            <span>{event.chamber}</span>
            <span>·</span>
            <span>{titleCase(event.eventType)}</span>
          </div>
          <h2 id="hearing-room-title">{event.title}</h2>
          <p>
            {event.subcommittee?.name ?? event.committee.name}
            {' · '}
            {formatDateTime(event.scheduledStart, event.timeZone)}
            {event.location ? ` · ${event.location}` : ''}
          </p>
        </div>
        <div className="lh-room__actions">
          {scheduled ? (
            <Button
              danger
              loading={cancel.isPending}
              onClick={cancelCapture}
            >
              Cancel scheduled recording
            </Button>
          ) : (
            <Tooltip title={!server.allowed ? server.reason : undefined}>
              <span>
                <Button
                  type="primary"
                  icon={<ScheduleOutlined />}
                  disabled={!server.allowed}
                  loading={schedule.isPending}
                  onClick={scheduleCapture}
                >
                  Schedule recording
                </Button>
              </span>
            </Tooltip>
          )}
          <Tooltip title={!browser.allowed ? browser.reason : undefined}>
            <span>
              <Button
                icon={<AudioOutlined />}
                disabled={!browser.allowed}
                loading={createBrowserSession.isPending}
                onClick={startBrowserCapture}
              >
                Use browser recording
              </Button>
            </span>
          </Tooltip>
          {officialUrl ? (
            <a className="lh-button" href={officialUrl} target="_blank" rel="noreferrer">
              Open official broadcast
            </a>
          ) : null}
        </div>
      </header>

      {!server.allowed && server.reason ? (
        <Alert
          type={server.mode === 'BROWSER' ? 'info' : 'warning'}
          showIcon
          message="Unattended recording is not available for this source"
          description={server.reason}
        />
      ) : null}

      <div className="lh-room__summary-grid">
        <div>
          <span>Capture</span>
          <strong>{captureStatusLabel(event)}</strong>
        </div>
        <div>
          <span>Stream</span>
          <strong>{titleCase(event.streamState)}</strong>
        </div>
        <div>
          <span>Witnesses</span>
          <strong>{event.witnessCount ?? event.witnesses?.length ?? 0}</strong>
        </div>
        <div>
          <span>Documents</span>
          <strong>{event.documentCount ?? event.documents?.length ?? 0}</strong>
        </div>
        <div>
          <span>Reconnects</span>
          <strong>{event.capture?.reconnectCount ?? 0}</strong>
        </div>
        <div>
          <span>Transcript gaps</span>
          <strong>{event.capture?.gapSeconds ? `${event.capture.gapSeconds}s` : 'None recorded'}</strong>
        </div>
      </div>

      <div className="lh-room__columns">
        <main className="lh-room__main">
          <section className="lh-panel">
            <div className="lh-panel__heading">
              <div>
                <span className="lh-kicker">Global public transcript</span>
                <h3>Live Transcript</h3>
              </div>
              <ClockCircleOutlined />
            </div>
            <PublicTranscript event={event} />
          </section>

          <section className="lh-panel">
            <div className="lh-panel__heading">
              <div>
                <span className="lh-kicker">Source-grounded and timestamped</span>
                <h3>Live Intelligence</h3>
              </div>
              <FileSearchOutlined />
            </div>
            {intelligence.isLoading ? <LoadingBlock label="Loading live intelligence…" /> : null}
            {intelligence.isError ? (
              <div className="lh-empty-inline">
                The live-intelligence endpoint is not enabled yet. Transcript capture is unaffected.
              </div>
            ) : (
              <IntelligencePanel items={intelligence.data ?? event.intelligence ?? []} />
            )}
          </section>
        </main>

        <aside className="lh-room__aside">
          <section className="lh-panel">
            <div className="lh-panel__heading">
              <div>
                <span className="lh-kicker">Official participants</span>
                <h3>Committee and Witnesses</h3>
              </div>
            </div>
            <button
              type="button"
              className="lh-committee-link"
              disabled={!committeeIdentifier}
              onClick={() => openCommittee(event.subcommittee ?? event.committee)}
            >
              <TeamOutlined />
              <span>
                <strong>{event.subcommittee?.name ?? event.committee.name}</strong>
                {event.subcommittee?.parentName ? <small>{event.subcommittee.parentName}</small> : null}
              </span>
            </button>
            {event.witnesses?.length ? (
              <ul className="lh-person-list">
                {event.witnesses.map((witness, index) => (
                  <li key={witness.id ?? `${witness.name}-${index}`}>
                    <span>{witness.name.slice(0, 1).toUpperCase()}</span>
                    <div>
                      <strong>{witness.name}</strong>
                      <small>
                        {[witness.title, witness.organization].filter(Boolean).join(' · ')}
                      </small>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="lh-empty-inline">No witness roster has been published.</div>
            )}
          </section>

          <section className="lh-panel">
            <div className="lh-panel__heading">
              <div>
                <span className="lh-kicker">Official source history</span>
                <h3>Site Updates</h3>
              </div>
            </div>
            {updates.isLoading ? <LoadingBlock label="Checking committee updates…" /> : null}
            {updates.isError ? (
              <div className="lh-empty-inline">Official update history is temporarily unavailable.</div>
            ) : (
              <UpdateTimeline updates={updates.data ?? event.updates ?? []} />
            )}
          </section>

          <section className="lh-panel">
            <div className="lh-panel__heading">
              <div>
                <span className="lh-kicker">Published material</span>
                <h3>Documents</h3>
              </div>
            </div>
            {event.documents?.length ? (
              <ul className="lh-document-list">
                {event.documents.map((document, index) => {
                  const url = safeOfficialHttpUrl(document.sourceUrl);
                  return (
                    <li key={document.id ?? `${document.sourceUrl}-${index}`}>
                      <FileSearchOutlined />
                      <div>
                        <strong>{document.title}</strong>
                        <small>{titleCase(document.documentType)}</small>
                      </div>
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="lh-empty-inline">No official documents have been published.</div>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}

function CommitteeRoomView({
  committeeId,
  onBack,
  openEvent,
}: {
  committeeId: string;
  onBack: () => void;
  openEvent: (event: CanonicalHearingEvent) => void;
}) {
  const room = useCommitteeRoom(committeeId);
  if (room.isLoading) return <LoadingBlock label="Opening committee room…" />;
  if (room.isError || !room.data) {
    return (
      <section className="lh-view">
        <button type="button" className="lh-back" onClick={onBack}>
          ← Back to Committee Rooms
        </button>
        <ErrorBlock
          title="Committee room enrichment is not available"
          error={room.error}
          onRetry={() => void room.refetch()}
        />
      </section>
    );
  }
  const officialUrl = safeOfficialHttpUrl(room.data.officialSiteUrl);
  return (
    <section className="lh-room" aria-labelledby="committee-room-title">
      <button type="button" className="lh-back" onClick={onBack}>
        ← Back to Committee Rooms
      </button>
      <header className="lh-room__hero">
        <div>
          <span className="lh-kicker">{room.data.committee.chamber ?? 'Congressional committee'}</span>
          <h2 id="committee-room-title">{room.data.committee.name}</h2>
          <p>{room.data.jurisdiction ?? 'Official committee schedule, membership, and publications.'}</p>
        </div>
        <div className="lh-room__actions">
          {officialUrl ? (
            <a className="lh-button lh-button--primary" href={officialUrl} target="_blank" rel="noreferrer">
              Official committee site
            </a>
          ) : null}
          <span className={`lh-status lh-status--${statusTone(room.data.sourceHealth)}`}>
            Source {titleCase(room.data.sourceHealth)}
          </span>
        </div>
      </header>

      <div className="lh-room__columns">
        <main className="lh-room__main">
          <section className="lh-panel">
            <div className="lh-panel__heading">
              <h3>Upcoming Proceedings</h3>
            </div>
            {room.data.upcomingEvents.length ? (
              <div className="lh-event-list">
                {room.data.upcomingEvents.map((event) => (
                  <EventCard compact key={event.id} event={event} onOpen={openEvent} />
                ))}
              </div>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No upcoming proceedings announced." />
            )}
          </section>
          <section className="lh-panel">
            <div className="lh-panel__heading">
              <h3>Official Site Updates</h3>
            </div>
            <UpdateTimeline updates={room.data.updates} />
          </section>
          <section className="lh-panel">
            <div className="lh-panel__heading">
              <h3>Recent Proceedings</h3>
            </div>
            <div className="lh-event-list">
              {room.data.recentEvents.map((event) => (
                <EventCard compact key={event.id} event={event} onOpen={openEvent} />
              ))}
            </div>
          </section>
        </main>

        <aside className="lh-room__aside">
          <section className="lh-panel">
            <div className="lh-panel__heading">
              <h3>Leadership</h3>
            </div>
            {[room.data.chair, room.data.rankingMember].filter(Boolean).map((member) => (
              <div className="lh-leader" key={member!.id}>
                <span>{member!.name.slice(0, 1).toUpperCase()}</span>
                <div>
                  <strong>{member!.name}</strong>
                  <small>{member!.role ?? 'Committee leadership'}</small>
                </div>
              </div>
            ))}
          </section>
          <section className="lh-panel">
            <div className="lh-panel__heading">
              <h3>Members</h3>
              <span>{room.data.members.length}</span>
            </div>
            <ul className="lh-person-list">
              {room.data.members.map((member) => (
                <li key={member.id}>
                  <span>{member.name.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <strong>{member.name}</strong>
                    <small>{[member.party, member.state, member.role].filter(Boolean).join(' · ')}</small>
                  </div>
                </li>
              ))}
            </ul>
          </section>
          {room.data.subcommittees.length ? (
            <section className="lh-panel">
              <div className="lh-panel__heading">
                <h3>Subcommittees</h3>
              </div>
              <ul className="lh-subcommittee-list">
                {room.data.subcommittees.map((subcommittee) => (
                  <li key={subcommittee.id ?? subcommittee.systemCode ?? subcommittee.name}>
                    {subcommittee.name}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
    </section>
  );
}

export function LiveHearingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawView = searchParams.get('hearingView');
  const view: LiveHearingsView =
    rawView && VIEWS.has(rawView as LiveHearingsView)
      ? (rawView as LiveHearingsView)
      : 'calendar';
  const eventId = searchParams.get('event') ?? '';
  const committeeId = searchParams.get('committee') ?? '';

  const updateLocation = (
    nextView: LiveHearingsView,
    values: { event?: string | null; committee?: string | null } = {},
  ) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'hearings');
    next.set('hearingView', nextView);
    if ('event' in values) {
      if (values.event) next.set('event', values.event);
      else next.delete('event');
    }
    if ('committee' in values) {
      if (values.committee) next.set('committee', values.committee);
      else next.delete('committee');
    }
    setSearchParams(next);
  };

  const openEvent = (event: CanonicalHearingEvent) =>
    updateLocation('event', { event: event.id, committee: null });
  const openCommittee = (committee: HearingCommitteeRef) => {
    const id = committee.id ?? committee.systemCode;
    if (id) updateLocation('committee', { committee: id, event: null });
  };

  const primaryView =
    view === 'event' || view === 'committee' ? 'calendar' : view;

  return (
    <div className="lh-root">
      <nav className="lh-nav" aria-label="Live Hearings views">
        {VIEW_DEFINITIONS.map((item) => (
          <button
            type="button"
            key={item.id}
            className={primaryView === item.id ? 'is-active' : ''}
            aria-current={primaryView === item.id ? 'page' : undefined}
            onClick={() => updateLocation(item.id, { event: null, committee: null })}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {view === 'calendar' ? <CalendarView openEvent={openEvent} /> : null}
      {view === 'live' ? <LiveNowView openEvent={openEvent} /> : null}
      {view === 'committees' ? <CommitteeRoomsView openCommittee={openCommittee} /> : null}
      {view === 'scheduled' ? <ScheduledView openEvent={openEvent} /> : null}
      {view === 'sessions' ? <SessionsView /> : null}
      {view === 'archive' ? <ArchiveView openEvent={openEvent} /> : null}
      {view === 'event' && eventId ? (
        <EventRoom
          eventId={eventId}
          onBack={() => updateLocation('calendar', { event: null })}
          openCommittee={openCommittee}
        />
      ) : null}
      {view === 'committee' && committeeId ? (
        <CommitteeRoomView
          committeeId={committeeId}
          onBack={() => updateLocation('committees', { committee: null })}
          openEvent={openEvent}
        />
      ) : null}
      {view === 'event' && !eventId ? (
        <Alert
          type="warning"
          message="No hearing event was selected"
          action={<Button onClick={() => updateLocation('calendar', { event: null })}>Open calendar</Button>}
        />
      ) : null}
      {view === 'committee' && !committeeId ? (
        <Alert
          type="warning"
          message="No committee room was selected"
          action={
            <Button onClick={() => updateLocation('committees', { committee: null })}>
              Open committee rooms
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

export default LiveHearingsPage;
