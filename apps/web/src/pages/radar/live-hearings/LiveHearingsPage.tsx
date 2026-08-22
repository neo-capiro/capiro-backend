import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, App as AntApp, Button, Empty, Input, Select, Spin, Tooltip } from 'antd';
import {
  AudioOutlined,
  BankOutlined,
  CalendarOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  FileSearchOutlined,
  HistoryOutlined,
  LeftOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RightOutlined,
  ScheduleOutlined,
  SearchOutlined,
  TeamOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  useCreateHearing,
  useHearingSessionHistory,
  type LiveHearingSession,
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
  useLiveHearingsCoverage,
  useLiveHearingsLive,
  usePublicHearingTranscript,
  useScheduleHearing,
} from './live-hearings-api.js';
import type {
  CanonicalHearingEvent,
  CommitteeSourceCoverage,
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
  // "Complete with gaps" is truthfully never the same visual as a clean
  // completion — the prototype's own state vocabulary (hearingRoomState:
  // 'gaps') keeps a warning-toned pill distinct from 'complete'.
  if (status === 'COMPLETE_WITH_GAPS') return 'gaps';
  if (['COMPLETE', 'COMPLETED', 'ENDED'].includes(status)) return 'complete';
  return 'neutral';
}

/**
 * Source-health vocabulary — mirrors the prototype's LH_HEALTH map
 * (healthy / degraded / review required / custom adapter required /
 * unavailable). Unknown values still render truthfully via a title-cased
 * fallback rather than being coerced into one of the five labels, since we
 * cannot confirm the committee-room API emits exactly this enum.
 */
function sourceHealthTone(value?: string): { label: string; tone: string } {
  const status = (value ?? '').toUpperCase();
  if (status === 'HEALTHY') return { label: 'Healthy', tone: 'success' };
  if (status === 'DEGRADED') return { label: 'Degraded', tone: 'warning' };
  if (status === 'REVIEW' || status === 'REVIEW_REQUIRED') {
    return { label: 'Review required', tone: 'warning' };
  }
  if (status === 'CUSTOM' || status === 'CUSTOM_ADAPTER_REQUIRED') {
    return { label: 'Custom adapter required', tone: 'neutral' };
  }
  if (status === 'UNAVAILABLE') return { label: 'Unavailable', tone: 'neutral' };
  // `committee_source.source_health` (Phase 2-6 model backing the coverage
  // drawer) is the real, narrower enum 'healthy' | 'degraded' | 'failing' |
  // 'unknown' — named explicitly rather than falling through to the generic
  // titleCase fallback, since these are genuine values this endpoint returns
  // today, not merely unrecognized input.
  if (status === 'FAILING') return { label: 'Failing', tone: 'danger' };
  if (status === 'UNKNOWN') return { label: 'Unknown', tone: 'neutral' };
  return { label: titleCase(value), tone: 'neutral' };
}

/**
 * Left-edge accent for a hearing row/card, grounded in real fields only:
 * live capture, proceeding kind (markup vs hearing), and resolved
 * public-access/stream state. Matches the prototype's calendar-chip state
 * matrix (live / hearing / markup / unavailable).
 */
function eventEdgeTone(event: CanonicalHearingEvent): 'live' | 'markup' | 'unavailable' | 'hearing' {
  if (isLiveEvent(event)) return 'live';
  const status = (event.eventStatus ?? '').toUpperCase();
  // A postponed or canceled proceeding is truthfully unavailable — the
  // Master Calendar week grid (§ prototype chip matrix) must not render it
  // with the same brand-toned "hearing" edge as something still on.
  if (status === 'POSTPONED' || status === 'CANCELED') return 'unavailable';
  const access = (event.publicAccessStatus ?? '').toUpperCase();
  const stream = (event.streamState ?? '').toUpperCase();
  if (
    access === 'CLOSED' ||
    access === 'CLASSIFIED' ||
    access === 'NOT_STREAMED' ||
    ['NO_PUBLIC_STREAM', 'POLICY_BLOCKED', 'SOURCE_ERROR'].includes(stream)
  ) {
    return 'unavailable';
  }
  if ((event.eventType ?? '').toUpperCase().includes('MARKUP')) return 'markup';
  return 'hearing';
}

/** Recording-queued marker for a calendar chip: a real subscription or an
 *  active scheduled-capture status, never a guess. */
function isRecordingQueued(event: CanonicalHearingEvent): boolean {
  if (event.subscription?.scheduled) return true;
  const status = (event.capture?.status ?? '').toUpperCase();
  return status === 'SCHEDULED' || status === 'PREPARING' || status === 'WAITING_FOR_BROADCAST';
}

/** Monday of the week containing `date`, at local midnight. */
function mondayOf(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  const day = result.getDay(); // 0 = Sunday .. 6 = Saturday
  const diff = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + diff);
  return result;
}

function addDays(date: Date, amount: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

function toDayInput(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The event's Eastern (or its own timezone) calendar day, e.g. "2026-08-12". */
function zonedDayKey(iso: string, timeZone = 'America/New_York'): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function zonedShortTime(iso: string, timeZone = 'America/New_York'): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function weekRangeLabel(monday: Date): string {
  const sunday = addDays(monday, 6);
  const sameMonth = monday.getMonth() === sunday.getMonth();
  const start = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' }).format(monday);
  const end = sameMonth
    ? new Intl.DateTimeFormat(undefined, { day: 'numeric', year: 'numeric' }).format(sunday)
    : new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' }).format(
        sunday,
      );
  return `${start} – ${end}`;
}

/** "2H 14M" style countdown; never negative, never fabricates a unit smaller
 *  than a minute. */
function formatCountdown(targetIso?: string): string {
  if (!targetIso) return '';
  const ms = new Date(targetIso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'Starting now';
  const totalMinutes = Math.max(1, Math.round(ms / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}M`;
  return `${hours}H ${minutes}M`;
}

function elapsedClock(startIso?: string): string {
  if (!startIso) return '00:00:00';
  const ms = Math.max(0, Date.now() - new Date(startIso).getTime());
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
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
    <article
      className={`lh-event-card${compact ? ' lh-event-card--compact' : ''}`}
      data-edge={eventEdgeTone(event)}
    >
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

/** One day column of the Master Calendar week grid (A.7 "Week calendar"). */
function CalendarDayColumn({
  date,
  isToday,
  events,
  openEvent,
}: {
  date: Date;
  isToday: boolean;
  events: CanonicalHearingEvent[];
  openEvent: (event: CanonicalHearingEvent) => void;
}) {
  const dow = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date).toUpperCase();
  return (
    <div className={`lh-calendar-day${isToday ? ' is-today' : ''}`}>
      <span className="lh-calendar-day__head">
        <span className="lh-calendar-day__dow">{dow}</span>
        <span className="lh-calendar-day__num">{date.getDate()}</span>
      </span>
      {events.length === 0 ? (
        <span className="lh-calendar-day__empty">NO PROCEEDINGS</span>
      ) : (
        events.map((event) => {
          const edge = eventEdgeTone(event);
          const marker = isLiveEvent(event) || isRecordingQueued(event);
          return (
            <button
              type="button"
              key={event.id}
              className="lh-calendar-chip"
              data-edge={edge}
              onClick={() => openEvent(event)}
            >
              <span className="lh-calendar-chip__row">
                <span className="lh-calendar-chip__time">
                  {event.scheduledStart ? zonedShortTime(event.scheduledStart, event.timeZone) : '—'}
                </span>
                {marker ? (
                  <span
                    className="lh-calendar-chip__dot"
                    style={isLiveEvent(event) ? { animation: 'lh-pulse 1.6s ease-in-out infinite' } : undefined}
                  />
                ) : null}
              </span>
              <span className="lh-calendar-chip__title">{event.title}</span>
              <span className="lh-calendar-chip__meta">
                {(event.subcommittee?.name ?? event.committee.name)} · {titleCase(event.eventType)}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

const CALENDAR_LEGEND: Array<{ label: string; tone: 'live' | 'hearing' | 'markup' | 'queued' }> = [
  { label: 'LIVE', tone: 'live' },
  { label: 'HEARING', tone: 'hearing' },
  { label: 'MARKUP', tone: 'markup' },
  { label: 'RECORDING QUEUED', tone: 'queued' },
];

/** The real 7-day structural grid (A.7 "Week calendar"). Reshapes the same
 *  canonical calendar data the agenda/list view reads — no placeholder
 *  events. */
function CalendarWeekGrid({
  weekStart,
  onPrevWeek,
  onNextWeek,
  isLoading,
  isError,
  error,
  onRetry,
  items,
  openEvent,
}: {
  weekStart: Date;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  items: CanonicalHearingEvent[];
  openEvent: (event: CanonicalHearingEvent) => void;
}) {
  const days = useMemo(() => {
    const buckets = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      return { date, key: toDayInput(date), events: [] as CanonicalHearingEvent[] };
    });
    const byKey = new Map(buckets.map((b) => [b.key, b]));
    for (const event of items) {
      if (!event.scheduledStart) continue;
      const key = zonedDayKey(event.scheduledStart, event.timeZone);
      byKey.get(key)?.events.push(event);
    }
    for (const bucket of buckets) {
      bucket.events.sort((a, b) => (a.scheduledStart ?? '').localeCompare(b.scheduledStart ?? ''));
    }
    return buckets;
  }, [items, weekStart]);
  const todayKey = toDayInput(new Date());
  const totalCount = days.reduce((sum, d) => sum + d.events.length, 0);

  return (
    <section className="lh-calendar-grid-section" aria-label="Master Calendar week grid">
      <div className="lh-calendar-grid-header">
        <span className="lh-calendar-grid-nav">
          <button type="button" onClick={onPrevWeek} aria-label="Previous week">
            <LeftOutlined />
          </button>
          <button type="button" onClick={onNextWeek} aria-label="Next week">
            <RightOutlined />
          </button>
        </span>
        <span className="lh-calendar-grid-label">{weekRangeLabel(weekStart)}</span>
        <span className="lh-calendar-grid-meta">
          {totalCount} {totalCount === 1 ? 'PROCEEDING' : 'PROCEEDINGS'} THIS WEEK
        </span>
      </div>
      {isLoading ? <LoadingBlock label="Loading the week grid…" /> : null}
      {isError ? <ErrorBlock error={error} onRetry={onRetry} /> : null}
      {!isLoading && !isError ? (
        <>
          <div className="lh-calendar-grid">
            {days.map((day) => (
              <CalendarDayColumn
                key={day.key}
                date={day.date}
                isToday={day.key === todayKey}
                events={day.events}
                openEvent={openEvent}
              />
            ))}
          </div>
          <div className="lh-calendar-legend">
            {CALENDAR_LEGEND.map((item) => (
              <span key={item.tone}>
                <span className="lh-calendar-legend__dot" data-tone={item.tone} />
                {item.label}
              </span>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function CalendarView({ openEvent }: { openEvent: (event: CanonicalHearingEvent) => void }) {
  const [from, setFrom] = useState(todayInput(-1));
  const [to, setTo] = useState(todayInput(30));
  const [search, setSearch] = useState('');
  const [chamber, setChamber] = useState<string | undefined>();
  // View-mode toggle: the existing filtered agenda/list stays the default,
  // matching the "additional view, not a replacement" instruction. Both
  // modes share the chamber/search filters; the week grid drives its own
  // 7-day window instead of the agenda's From/To range.
  const [mode, setMode] = useState<'agenda' | 'calendar'>('agenda');
  const [weekOffset, setWeekOffset] = useState(0);
  const weekStart = useMemo(() => addDays(mondayOf(new Date()), weekOffset * 7), [weekOffset]);
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);

  const agenda = useLiveHearingsCalendar({
    from: dayBoundary(from),
    to: dayBoundary(to, true),
    chamber,
    search: search.trim() || undefined,
    limit: 250,
  });
  const week = useLiveHearingsCalendar({
    from: dayBoundary(toDayInput(weekStart)),
    to: dayBoundary(toDayInput(weekEnd), true),
    chamber,
    search: search.trim() || undefined,
    limit: 250,
  });
  const active = mode === 'calendar' ? week : agenda;

  return (
    <section className="lh-view" aria-labelledby="master-calendar-title">
      <div className="lh-view__heading">
        <div>
          <span className="lh-kicker">Official House, Senate, joint, and committee sources</span>
          <h2 id="master-calendar-title">Master Calendar</h2>
          <p>Every discovered proceeding stays visible until it is captured or assigned an explicit exception.</p>
        </div>
        <div className="lh-count">{active.data?.total?.toLocaleString() ?? '—'} events</div>
      </div>

      <div className="lh-filterbar">
        {mode === 'agenda' ? (
          <>
            <label>
              <span>From</span>
              <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </label>
            <label>
              <span>To</span>
              <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </label>
          </>
        ) : null}
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
        <div className="lh-segmented" role="tablist" aria-label="Calendar presentation">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'agenda'}
            className={mode === 'agenda' ? 'is-active' : ''}
            onClick={() => setMode('agenda')}
          >
            Agenda
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'calendar'}
            className={mode === 'calendar' ? 'is-active' : ''}
            onClick={() => setMode('calendar')}
          >
            Calendar
          </button>
        </div>
      </div>

      <SourceHealthBanner health={active.data?.sourceHealth} />

      {mode === 'calendar' ? (
        <CalendarWeekGrid
          weekStart={weekStart}
          onPrevWeek={() => setWeekOffset((n) => n - 1)}
          onNextWeek={() => setWeekOffset((n) => n + 1)}
          isLoading={week.isLoading}
          isError={week.isError}
          error={week.error}
          onRetry={() => void week.refetch()}
          items={week.data?.items ?? []}
          openEvent={openEvent}
        />
      ) : (
        <>
          {agenda.isLoading ? <LoadingBlock /> : null}
          {agenda.isError ? (
            <ErrorBlock error={agenda.error} onRetry={() => void agenda.refetch()} />
          ) : null}
          {!agenda.isLoading && !agenda.isError && (agenda.data?.items.length ?? 0) === 0 ? (
            <Empty description="No official proceedings match this date range and filter." />
          ) : null}
          <div className="lh-event-list">
            {agenda.data?.items.map((event) => (
              <EventCard key={event.id} event={event} onOpen={openEvent} />
            ))}
          </div>
        </>
      )}
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

/**
 * The dark "next session" hero (LEGIWATCH-HANDOFF.md A.7 "My Sessions": one
 * ink card, states driven by whether a session is running). Two prototype
 * states — Live / Next upcoming — plus a third, honest "no session" state
 * this module needs that the prototype's own fixtures never exercise (the
 * design's principle is "never empty"; real tenant data can genuinely have
 * neither a live nor a scheduled session, so that state gets the identical
 * ink card geometry rather than a blank panel or invented data).
 */
function SessionsHero({
  browserSessions,
  browserSessionsLoading,
  openEvent,
  onOpenScheduled,
  onOpenCalendar,
}: {
  browserSessions: LiveHearingSession[];
  browserSessionsLoading: boolean;
  openEvent: (event: CanonicalHearingEvent) => void;
  onOpenScheduled: () => void;
  onOpenCalendar: () => void;
}) {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const upcoming = useLiveHearingsCalendar({
    followState: 'scheduled',
    from: dayBoundary(todayInput(-1)),
    to: dayBoundary(todayInput(60), true),
    limit: 50,
  });
  const schedule = useScheduleHearing();

  if (browserSessionsLoading || upcoming.isLoading) {
    return (
      <section className="lh-sessions-hero" aria-live="polite">
        <span className="lh-sessions-hero__badge">
          <span className="lh-sessions-hero__dot" />
          CHECKING SESSIONS
        </span>
        <p className="lh-sessions-hero__body">Loading your live and upcoming sessions…</p>
      </section>
    );
  }

  const liveServerEvent = upcoming.data?.items.find((event) => isLiveEvent(event));
  const liveBrowserSession = browserSessions.find((session) => session.status === 'live');
  const now = Date.now();
  const nextEvent = liveServerEvent
    ? undefined
    : upcoming.data?.items.find(
        (event) =>
          !isLiveEvent(event) &&
          Boolean(event.scheduledStart) &&
          new Date(event.scheduledStart as string).getTime() > now,
      );

  if (liveServerEvent) {
    const startedAt =
      liveServerEvent.actualStart ?? liveServerEvent.capture?.captureStartedAt ?? liveServerEvent.scheduledStart;
    return (
      <section className="lh-sessions-hero" data-state="live">
        <span className="lh-sessions-hero__badge">
          <span className="lh-sessions-hero__dot is-live" />
          LIVE · {elapsedClock(startedAt)}
        </span>
        <h3 className="lh-sessions-hero__title">{liveServerEvent.title}</h3>
        <p className="lh-sessions-hero__sub">
          {liveServerEvent.subcommittee?.name ?? liveServerEvent.committee.name} · Server-captured public proceeding
        </p>
        <div className="lh-sessions-hero__actions">
          <button
            type="button"
            className="lh-sessions-hero__primary"
            onClick={() => openEvent(liveServerEvent)}
          >
            Open live room
          </button>
        </div>
      </section>
    );
  }

  if (liveBrowserSession) {
    return (
      <section className="lh-sessions-hero" data-state="live">
        <span className="lh-sessions-hero__badge">
          <span className="lh-sessions-hero__dot is-live" />
          LIVE · {elapsedClock(liveBrowserSession.startedAt ?? undefined)}
        </span>
        <h3 className="lh-sessions-hero__title">{liveBrowserSession.title}</h3>
        <p className="lh-sessions-hero__sub">{titleCase(liveBrowserSession.sourceType)} · Browser-assisted session</p>
        <div className="lh-sessions-hero__actions">
          <button
            type="button"
            className="lh-sessions-hero__primary"
            onClick={() => navigate(`/intelligence/hearing-watch/${liveBrowserSession.id}`)}
          >
            Open live room
          </button>
        </div>
      </section>
    );
  }

  if (nextEvent) {
    const scheduled = Boolean(nextEvent.subscription?.scheduled);
    return (
      <section className="lh-sessions-hero" data-state="next">
        <span className="lh-sessions-hero__badge">
          <span className="lh-sessions-hero__dot" />
          NEXT SESSION · STARTS IN {formatCountdown(nextEvent.scheduledStart)}
        </span>
        <h3 className="lh-sessions-hero__title">{nextEvent.title}</h3>
        <p className="lh-sessions-hero__sub">
          {nextEvent.subcommittee?.name ?? nextEvent.committee.name} ·{' '}
          {formatDateTime(nextEvent.scheduledStart, nextEvent.timeZone)}
        </p>
        <p className="lh-sessions-hero__body">
          Nothing is live right now. This is the next proceeding on your watchlist.
        </p>
        <div className="lh-sessions-hero__actions">
          {scheduled ? (
            <span className="lh-sessions-hero__pill">Recording scheduled</span>
          ) : (
            <button
              type="button"
              className="lh-sessions-hero__primary"
              disabled={schedule.isPending}
              onClick={() =>
                schedule.mutate(nextEvent.id, {
                  onSuccess: () => message.success('Unattended recording scheduled'),
                  onError: (error) => message.error(liveHearingApiError(error)),
                })
              }
            >
              Schedule recording
            </button>
          )}
          <button type="button" className="lh-sessions-hero__secondary" onClick={onOpenScheduled}>
            View schedule
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="lh-sessions-hero" data-state="none">
      <span className="lh-sessions-hero__badge">
        <span className="lh-sessions-hero__dot" />
        NO UPCOMING SESSION
      </span>
      <p className="lh-sessions-hero__body">
        Nothing is live and nothing is scheduled on your watchlist right now. Open the Master Calendar to
        find a proceeding to follow.
      </p>
      <div className="lh-sessions-hero__actions">
        <button type="button" className="lh-sessions-hero__primary" onClick={onOpenCalendar}>
          Open master calendar
        </button>
      </div>
    </section>
  );
}

function SessionsView({
  openEvent,
  onOpenScheduled,
  onOpenCalendar,
}: {
  openEvent: (event: CanonicalHearingEvent) => void;
  onOpenScheduled: () => void;
  onOpenCalendar: () => void;
}) {
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
      <SessionsHero
        browserSessions={items}
        browserSessionsLoading={sessions.isLoading}
        openEvent={openEvent}
        onOpenScheduled={onOpenScheduled}
        onOpenCalendar={onOpenCalendar}
      />
      {sessions.isLoading ? <LoadingBlock label="Loading your hearing sessions…" /> : null}
      {sessions.isError ? (
        <ErrorBlock error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : null}
      {!sessions.isLoading && !sessions.isError && items.length === 0 ? (
        <Empty description="You have not started a browser-assisted hearing session." />
      ) : null}
      {items.length > 0 ? <span className="lh-kicker">Recent session history</span> : null}
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
            {/* HearingIntelligenceItem carries no client/tenant field today —
                everything rendered here is the canonical public read, so the
                tag says exactly that rather than implying client relevance
                the API does not (yet) provide. See report: Phase 6 overlay
                gap. */}
            <span className="lh-fact-tag">Public record</span>
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
            // The API exposes only a boolean `gapBefore` — no duration or
            // recovery reason — so the banner never fabricates a seconds
            // count or a "stream recovered" claim it cannot verify.
            <div className="lh-transcript__gap">Transcript gap recorded</div>
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
          <span className={`lh-status lh-status--${sourceHealthTone(room.data.sourceHealth).tone}`}>
            Source {sourceHealthTone(room.data.sourceHealth).label}
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

/**
 * One committee source's diagnostic row in the coverage drawer. Every value
 * is either a real `committee_source` column or an explicitly-derived,
 * explicitly-labeled read (see live-hearings.service.ts `coverage()`); a
 * missing derived value renders "Not observed yet" rather than a fabricated
 * status.
 */
function CoverageRow({ source }: { source: CommitteeSourceCoverage }) {
  const health = sourceHealthTone(source.sourceHealth);
  const url = safeOfficialHttpUrl(source.sourceUrl);
  return (
    <div className="lh-coverage-row">
      <div className="lh-coverage-row__head">
        <span className="lh-coverage-row__name">{source.committeeName ?? 'Chamber-wide source'}</span>
        <span className="lh-coverage-row__chamber">{source.chamber.toUpperCase()}</span>
        <span className="lh-coverage-row__spacer" />
        <span className={`lh-status lh-status--${health.tone}`}>{health.label}</span>
      </div>
      <div className="lh-coverage-row__link">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer">
            {source.sourceUrl}
          </a>
        ) : (
          <span>{source.sourceUrl}</span>
        )}
        <span className="lh-coverage-row__adapter">· {source.adapterKey}</span>
        {!source.enabled ? <span className="lh-coverage-row__disabled">· Polling disabled</span> : null}
      </div>
      <div className="lh-coverage-row__cells">
        <span>
          <span className="lh-coverage-row__cell-key">LAST CHECKED</span>
          <span className="lh-coverage-row__cell-value">
            {source.lastCheckedAt ? formatDateTime(source.lastCheckedAt) : 'Not yet checked'}
          </span>
        </span>
        <span>
          <span className="lh-coverage-row__cell-key">LAST SUCCESS</span>
          <span
            className="lh-coverage-row__cell-value"
            data-warn={source.lastSuccessAt ? undefined : 'true'}
          >
            {source.lastSuccessAt ? formatDateTime(source.lastSuccessAt) : 'Never'}
          </span>
        </span>
        <span>
          <span className="lh-coverage-row__cell-key">SOURCE TYPE</span>
          <span className="lh-coverage-row__cell-value">{titleCase(source.sourceType)}</span>
        </span>
        <span>
          <span className="lh-coverage-row__cell-key">STREAM RESOLUTION</span>
          <span className="lh-coverage-row__cell-value">
            {source.recentResolutionState ? titleCase(source.recentResolutionState) : 'Not observed yet'}
          </span>
        </span>
        <span>
          <span className="lh-coverage-row__cell-key">SERVER CAPTURE</span>
          <span
            className="lh-coverage-row__cell-value"
            data-good={source.recentCapturePolicy === 'SERVER_CAPTURE_ALLOWED' ? 'true' : undefined}
          >
            {source.recentCapturePolicy ? capturePolicyLabel(source.recentCapturePolicy) : 'Not observed yet'}
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * Source coverage / health drawer — the prototype's operator-tooling
 * surface (§17 of the prototype instructions). Mounted from the persistent
 * Live Hearings toolbar, matching the prototype's own placement (the
 * "Source coverage" trigger sits in the sub-nav bar, visible from every
 * sub-surface, not only Committee Rooms).
 */
function CoverageDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const coverage = useLiveHearingsCoverage();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  const summary = coverage.data?.summary;

  return (
    <div className="lh-coverage-overlay" role="presentation">
      <div className="lh-coverage-scrim" onClick={onClose} />
      <div
        className="lh-coverage-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Source coverage"
      >
        <div className="lh-coverage-drawer__header">
          <div>
            <span className="lh-kicker">Operator tooling · not a client surface</span>
            <h3>Source coverage</h3>
            <p>
              Per-committee discovery, stream resolution and server-capture support, read directly from
              the committee-source model. A source that cannot be captured automatically is named here
              rather than failing silently in the calendar.
            </p>
          </div>
          <button
            type="button"
            className="lh-coverage-drawer__close"
            onClick={onClose}
            aria-label="Close source coverage"
          >
            <CloseOutlined />
          </button>
        </div>

        {coverage.isLoading ? <LoadingBlock label="Loading source coverage…" /> : null}
        {coverage.isError ? (
          <ErrorBlock error={coverage.error} onRetry={() => void coverage.refetch()} />
        ) : null}

        {summary ? (
          <div className="lh-coverage-drawer__stats">
            <div>
              <span>SOURCES TRACKED</span>
              <strong>{summary.total}</strong>
            </div>
            <div>
              <span>HEALTHY</span>
              <strong className="is-success">{summary.healthy}</strong>
            </div>
            <div>
              <span>DEGRADED</span>
              <strong className="is-warning">{summary.degraded}</strong>
            </div>
            <div>
              <span>FAILING</span>
              <strong className="is-danger">{summary.failing}</strong>
            </div>
            <div>
              <span>UNKNOWN</span>
              <strong>{summary.unknown}</strong>
            </div>
          </div>
        ) : null}

        <div className="lh-coverage-drawer__body">
          {coverage.data && coverage.data.sources.length === 0 ? (
            <Empty description="No committee sources are registered yet." />
          ) : null}
          {coverage.data?.sources.map((source) => (
            <CoverageRow key={source.id} source={source} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Toolbar trigger for the coverage drawer — shares the drawer's react-query
 *  cache, so opening the drawer never issues a second request. */
function CoverageTrigger({ onOpen }: { onOpen: () => void }) {
  const coverage = useLiveHearingsCoverage();
  const summary = coverage.data?.summary;
  const dotTone = !summary
    ? 'neutral'
    : summary.failing > 0
      ? 'danger'
      : summary.degraded > 0 || summary.unknown > 0
        ? 'warning'
        : 'success';
  return (
    <button type="button" className="lh-coverage-trigger" onClick={onOpen}>
      <span className={`lh-coverage-trigger__dot lh-coverage-trigger__dot--${dotTone}`} />
      Source coverage
      {summary ? (
        <span className="lh-coverage-trigger__meta">
          {summary.healthy} / {summary.total} healthy
        </span>
      ) : null}
    </button>
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
  const [coverageOpen, setCoverageOpen] = useState(false);

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
        <span className="lh-nav__spacer" />
        <CoverageTrigger onOpen={() => setCoverageOpen(true)} />
      </nav>
      <CoverageDrawer open={coverageOpen} onClose={() => setCoverageOpen(false)} />

      {view === 'calendar' ? <CalendarView openEvent={openEvent} /> : null}
      {view === 'live' ? <LiveNowView openEvent={openEvent} /> : null}
      {view === 'committees' ? <CommitteeRoomsView openCommittee={openCommittee} /> : null}
      {view === 'scheduled' ? <ScheduledView openEvent={openEvent} /> : null}
      {view === 'sessions' ? (
        <SessionsView
          openEvent={openEvent}
          onOpenScheduled={() => updateLocation('scheduled', { event: null, committee: null })}
          onOpenCalendar={() => updateLocation('calendar', { event: null, committee: null })}
        />
      ) : null}
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
