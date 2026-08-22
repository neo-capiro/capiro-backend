import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, App as AntApp, Button, Empty, Input, Spin, Tooltip } from 'antd';
import {
  AudioOutlined,
  BankOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  FileTextOutlined,
  HistoryOutlined,
  LinkOutlined,
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
  type LiveHearingSession,
} from '../../../lib/hearing-watch-api.js';
import { LiveHearingsCanonicalSurface } from './LiveHearingsCanonicalSurface.js';
import { liveHearingApiError, useLiveHearingsLive } from './live-hearings-api.js';
import { safeOfficialHttpUrl } from './live-hearings-capability.js';
import {
  usePhase7Archive,
  usePhase7BrowserJoin,
  usePhase7CancelSchedule,
  usePhase7Follow,
  usePhase7Recordings,
  usePhase7Room,
  usePhase7Schedule,
  usePhase7Transcript,
  usePhase7Unfollow,
  type Phase7CaptureDetail,
  type Phase7ListEvent,
  type Phase7Room,
} from './live-hearings-phase7-api.js';
import type { CanonicalHearingEvent, PublicTranscriptSegment } from './live-hearings.types.js';
import './LiveHearingsPhase7Surface.css';

type TopLevelView = 'calendar' | 'live' | 'committees' | 'scheduled' | 'sessions' | 'archive';
type Phase7View = TopLevelView | 'committee' | 'event';

const TOP_LEVEL_VIEWS = new Set<TopLevelView>([
  'calendar',
  'live',
  'committees',
  'scheduled',
  'sessions',
  'archive',
]);
const CANONICAL_PHASE34_VIEWS = new Set(['calendar', 'committees', 'committee']);
const NAV_ITEMS: ReadonlyArray<{ id: TopLevelView; label: string; icon: ReactNode }> = [
  { id: 'calendar', label: 'Master Calendar', icon: <CalendarOutlined /> },
  { id: 'live', label: 'Live Now', icon: <PlayCircleOutlined /> },
  { id: 'committees', label: 'Committee Rooms', icon: <BankOutlined /> },
  { id: 'scheduled', label: 'Scheduled Recordings', icon: <ScheduleOutlined /> },
  { id: 'sessions', label: 'My Sessions', icon: <AudioOutlined /> },
  { id: 'archive', label: 'Archive', icon: <HistoryOutlined /> },
];
const ACTIVE_CAPTURE_STATES = new Set([
  'PREPARING',
  'WAITING_FOR_STREAM',
  'READY',
  'CAPTURING',
  'RECOVERING',
  'FINALIZING',
]);

function titleCase(value?: string): string {
  return (value ?? 'Unknown')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDateTime(value?: string, timeZone = 'America/New_York'): string {
  if (!value) return 'Time not announced';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(parsed);
}

function formatDuration(seconds = 0): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatTranscriptTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function statusTone(value?: string): string {
  const status = (value ?? '').toUpperCase();
  if (['CAPTURING', 'LIVE', 'IN_PROGRESS'].includes(status)) return 'live';
  if (['PREPARING', 'WAITING_FOR_STREAM', 'READY', 'RECOVERING', 'FINALIZING', 'POSTPONED'].includes(status)) {
    return 'warning';
  }
  if (status === 'COMPLETE_WITH_GAPS') return 'gaps';
  if (['COMPLETE', 'COMPLETED', 'ENDED'].includes(status)) return 'complete';
  if (['FAILED', 'BLOCKED', 'CANCELED', 'POLICY_BLOCKED'].includes(status)) return 'danger';
  return 'neutral';
}

function Phase7Nav({ active, onSelect }: { active?: TopLevelView; onSelect: (view: TopLevelView) => void }) {
  return (
    <nav className="lh7-nav" aria-label="Live Hearings views">
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={active === item.id ? 'is-active' : ''}
          aria-current={active === item.id ? 'page' : undefined}
          onClick={() => onSelect(item.id)}
        >
          <span aria-hidden="true">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="lh7-loading" role="status">
      <Spin />
      <span>{label}</span>
    </div>
  );
}

function ErrorState({ error, retry, title }: { error: unknown; retry: () => void; title: string }) {
  return (
    <Alert
      type="error"
      showIcon
      message={title}
      description={liveHearingApiError(error)}
      action={
        <Button size="small" icon={<ReloadOutlined />} onClick={retry}>
          Retry
        </Button>
      }
    />
  );
}

function StatusPill({ value }: { value?: string }) {
  return <span className={`lh7-status lh7-status--${statusTone(value)}`}>{titleCase(value)}</span>;
}

function LiveEventCard({ event, onOpen }: { event: CanonicalHearingEvent; onOpen: (id: string) => void }) {
  const status = event.capture?.status ?? event.eventStatus;
  return (
    <article className="lh7-event-card">
      <div className="lh7-event-card__time">
        <ClockCircleOutlined />
        <span>{formatDateTime(event.scheduledStart, event.timeZone)}</span>
      </div>
      <div className="lh7-event-card__body">
        <small>
          {event.chamber} · {event.subcommittee?.name ?? event.committee.name} · {titleCase(event.eventType)}
        </small>
        <h3>{event.title}</h3>
        <div className="lh7-event-card__facts">
          <StatusPill value={status} />
          <span>{titleCase(event.streamState)}</span>
          {event.location ? <span>{event.location}</span> : null}
        </div>
      </div>
      <Button type="primary" onClick={() => onOpen(event.id)}>
        Enter room
      </Button>
    </article>
  );
}

function ListEventCard({
  event,
  onOpen,
  action,
}: {
  event: Phase7ListEvent;
  onOpen: (id: string) => void;
  action?: ReactNode;
}) {
  const captureStatus = event.capture?.status ?? event.eventStatus;
  return (
    <article className="lh7-event-card">
      <div className="lh7-event-card__time">
        <ClockCircleOutlined />
        <span>{formatDateTime(event.startsAt, event.timezone)}</span>
      </div>
      <div className="lh7-event-card__body">
        <small>
          {event.chamber} · {event.committeeName} · {titleCase(event.eventType)}
        </small>
        <h3>{event.title}</h3>
        <div className="lh7-event-card__facts">
          <StatusPill value={captureStatus} />
          <span>{titleCase(event.streamAvailability)}</span>
          {event.capture?.transcriptGapSeconds ? (
            <span>{formatDuration(event.capture.transcriptGapSeconds)} transcript gap</span>
          ) : null}
          {event.capture?.terminalReasonCode ? <span>{titleCase(event.capture.terminalReasonCode)}</span> : null}
        </div>
      </div>
      <div className="lh7-event-card__actions">
        <Button type="primary" onClick={() => onOpen(event.id)}>
          Open room
        </Button>
        {action}
      </div>
    </article>
  );
}

function LiveNowView({ openEvent }: { openEvent: (id: string) => void }) {
  const live = useLiveHearingsLive();
  return (
    <section className="lh7-view">
      <header className="lh7-heading">
        <div>
          <span className="lh7-eyebrow">Canonical public capture · refreshes every 15 seconds</span>
          <h2>Live Now</h2>
          <p>Enter the shared room. If Capiro is already capturing, you attach to the existing transcript instead of starting another stream.</p>
        </div>
        <span className="lh7-live-count"><span />{live.data?.length ?? 0} live</span>
      </header>
      {live.isLoading ? <Loading label="Checking public committee rooms…" /> : null}
      {live.isError ? <ErrorState error={live.error} retry={() => void live.refetch()} title="Live hearings could not be loaded" /> : null}
      {!live.isLoading && !live.isError && !live.data?.length ? (
        <Empty description="No public proceeding is live right now." />
      ) : null}
      <div className="lh7-list">
        {live.data?.map((event) => <LiveEventCard key={event.id} event={event} onOpen={openEvent} />)}
      </div>
    </section>
  );
}

function ScheduledView({ openEvent }: { openEvent: (id: string) => void }) {
  const { message } = AntApp.useApp();
  const [page, setPage] = useState(1);
  const recordings = usePhase7Recordings(page, 50);
  const cancel = usePhase7CancelSchedule();
  const totalPages = Math.max(1, Math.ceil((recordings.data?.total ?? 0) / 50));

  return (
    <section className="lh7-view">
      <header className="lh7-heading">
        <div>
          <span className="lh7-eyebrow">Runs while you are offline</span>
          <h2>Scheduled Recordings</h2>
          <p>Your tenant demand points at one global capture. Another firm scheduling the same hearing never creates a second media or Deepgram stream.</p>
        </div>
        <span className="lh7-count">{recordings.data?.total ?? 0} scheduled</span>
      </header>
      {recordings.isLoading ? <Loading label="Loading scheduled recordings…" /> : null}
      {recordings.isError ? <ErrorState error={recordings.error} retry={() => void recordings.refetch()} title="Scheduled recordings could not be loaded" /> : null}
      {!recordings.isLoading && !recordings.isError && !recordings.data?.rows.length ? (
        <Empty description="You have no unattended public hearing recordings scheduled." />
      ) : null}
      <div className="lh7-list">
        {recordings.data?.rows.map((event) => (
          <ListEventCard
            key={event.id}
            event={event}
            onOpen={openEvent}
            action={
              event.scheduleSource?.byUser ? (
                <Button
                  danger
                  loading={cancel.isPending}
                  onClick={() =>
                    cancel.mutate(event.id, {
                      onSuccess: () => {
                        message.success('Your recording demand was canceled. Canonical public history was preserved.');
                        void recordings.refetch();
                      },
                      onError: (error) => message.error(liveHearingApiError(error)),
                    })
                  }
                >
                  Cancel mine
                </Button>
              ) : event.scheduleSource?.byRule ? (
                <Tooltip title="This recording is scheduled by an automatic rule. Manage the rule in LegiWatch Settings.">
                  <span className="lh7-rule-badge">Auto rule</span>
                </Tooltip>
              ) : null
            }
          />
        ))}
      </div>
      {totalPages > 1 ? (
        <div className="lh7-pagination">
          <Button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button>
          <span>Page {page} of {totalPages}</span>
          <Button disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Next</Button>
        </div>
      ) : null}
    </section>
  );
}

function ArchiveView({ openEvent }: { openEvent: (id: string) => void }) {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const archive = usePhase7Archive(page, 50, appliedSearch);
  const totalPages = Math.max(1, Math.ceil((archive.data?.total ?? 0) / 50));

  return (
    <section className="lh7-view">
      <header className="lh7-heading">
        <div>
          <span className="lh7-eyebrow">Canonical public record</span>
          <h2>Archive</h2>
          <p>Completed hearings remain one public record with explicit capture outcomes and visible transcript gaps.</p>
        </div>
        <span className="lh7-count">{archive.data?.total ?? 0} archived</span>
      </header>
      <div className="lh7-searchbar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onPressEnter={() => {
            setPage(1);
            setAppliedSearch(search.trim());
          }}
          placeholder="Search hearing or committee"
        />
        <Button onClick={() => { setPage(1); setAppliedSearch(search.trim()); }}>Search</Button>
      </div>
      {archive.isLoading ? <Loading label="Loading the canonical archive…" /> : null}
      {archive.isError ? <ErrorState error={archive.error} retry={() => void archive.refetch()} title="Archive could not be loaded" /> : null}
      {!archive.isLoading && !archive.isError && !archive.data?.rows.length ? <Empty description="No archived hearings match this search." /> : null}
      <div className="lh7-list">
        {archive.data?.rows.map((event) => <ListEventCard key={event.id} event={event} onOpen={openEvent} />)}
      </div>
      {totalPages > 1 ? (
        <div className="lh7-pagination">
          <Button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button>
          <span>Page {page} of {totalPages}</span>
          <Button disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Next</Button>
        </div>
      ) : null}
    </section>
  );
}

function BrowserSessionRow({ session }: { session: LiveHearingSession }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="lh7-session-row"
      onClick={() => navigate(`/intelligence/hearing-watch/${session.id}`)}
    >
      <AudioOutlined />
      <span>
        <strong>{session.title}</strong>
        <small>{titleCase(session.sourceType)}{session.startedAt ? ` · ${formatDateTime(session.startedAt)}` : ''}</small>
      </span>
      <StatusPill value={session.status} />
    </button>
  );
}

function SessionsView({ openEvent, openCalendar }: { openEvent: (id: string) => void; openCalendar: () => void }) {
  const sessions = useHearingSessionHistory();
  const recordings = usePhase7Recordings(1, 10);
  const browserSessions = sessions.data?.pages.flatMap((page) => page.items) ?? [];
  const nextServer = recordings.data?.rows[0];

  return (
    <section className="lh7-view">
      <header className="lh7-heading">
        <div>
          <span className="lh7-eyebrow">Server capture + browser-assisted sessions</span>
          <h2>My Sessions</h2>
          <p>Your next unattended public capture and your private/browser session history in one place.</p>
        </div>
      </header>

      <section className="lh7-session-hero">
        {nextServer ? (
          <>
            <span className="lh7-eyebrow">Next server recording</span>
            <StatusPill value={nextServer.capture?.status ?? nextServer.eventStatus} />
            <h3>{nextServer.title}</h3>
            <p>{nextServer.committeeName} · {formatDateTime(nextServer.startsAt, nextServer.timezone)}</p>
            <Button type="primary" onClick={() => openEvent(nextServer.id)}>Open hearing room</Button>
          </>
        ) : browserSessions.find((session) => session.status === 'live') ? (
          <>
            <span className="lh7-eyebrow">Browser session live</span>
            <BrowserSessionRow session={browserSessions.find((session) => session.status === 'live')!} />
          </>
        ) : (
          <>
            <span className="lh7-eyebrow">No upcoming session</span>
            <h3>Nothing is live or scheduled for you right now.</h3>
            <p>Use the Master Calendar to schedule an unattended capture or enter a browser-assisted room.</p>
            <Button type="primary" onClick={openCalendar}>Open Master Calendar</Button>
          </>
        )}
      </section>

      {sessions.isLoading ? <Loading label="Loading browser session history…" /> : null}
      {sessions.isError ? <ErrorState error={sessions.error} retry={() => void sessions.refetch()} title="Browser sessions could not be loaded" /> : null}
      {browserSessions.length ? <h3 className="lh7-subheading">Recent browser-assisted sessions</h3> : null}
      <div className="lh7-session-list">
        {browserSessions.map((session) => <BrowserSessionRow key={session.id} session={session} />)}
      </div>
      {sessions.hasNextPage ? (
        <div className="lh7-pagination">
          <Button loading={sessions.isFetchingNextPage} onClick={() => void sessions.fetchNextPage()}>Load more sessions</Button>
        </div>
      ) : null}
    </section>
  );
}

function CaptureHealth({ capture }: { capture?: Phase7CaptureDetail }) {
  if (!capture) {
    return (
      <div className="lh7-health-card">
        <span className="lh7-eyebrow">Capture</span>
        <strong>Not scheduled</strong>
        <small>No global capture record exists yet.</small>
      </div>
    );
  }
  return (
    <div className="lh7-health-card">
      <span className="lh7-eyebrow">Capture health</span>
      <StatusPill value={capture.status} />
      <div className="lh7-health-grid">
        <span><small>Captured</small><strong>{formatDuration(capture.capturedSeconds)}</strong></span>
        <span><small>Transcript gaps</small><strong>{formatDuration(capture.transcriptGapSeconds)}</strong></span>
        <span><small>Reconnects</small><strong>{capture.reconnectCount}</strong></span>
      </div>
      {capture.resolutionReasonCode ? <small>Resolution: {titleCase(capture.resolutionReasonCode)}</small> : null}
      {capture.terminalReasonCode ? <small>Outcome: {titleCase(capture.terminalReasonCode)}</small> : null}
      {capture.failureCode ? <small>Failure: {titleCase(capture.failureCode)}</small> : null}
    </div>
  );
}

function TranscriptPanel({
  room,
  items,
  isLoading,
  isError,
  error,
  retry,
  hasMore,
  loadMore,
  loadingMore,
}: {
  room: Phase7Room;
  items: PublicTranscriptSegment[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  retry: () => void;
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
}) {
  const currentSpeaker = [...items]
    .reverse()
    .find((item) => item.speakerName || item.speakerLabel);
  return (
    <section className="lh7-room-card lh7-transcript-card">
      <div className="lh7-card-heading">
        <div>
          <span className="lh7-eyebrow">Canonical live transcript</span>
          <h3>Transcript</h3>
        </div>
        {currentSpeaker ? (
          <span className="lh7-current-speaker">Speaking · {currentSpeaker.speakerName ?? currentSpeaker.speakerLabel}</span>
        ) : null}
      </div>
      <Alert type="info" showIcon message={room.transcriptDisclaimer} />
      {room.capture?.status === 'COMPLETE_WITH_GAPS' || (room.capture?.transcriptGapSeconds ?? 0) > 0 ? (
        <Alert
          type="warning"
          showIcon
          message="This transcript contains one or more capture gaps"
          description="Gap markers stay in the canonical timeline so missing audio is never presented as continuous testimony."
        />
      ) : null}
      {isLoading ? <Loading label="Loading canonical transcript…" /> : null}
      {isError ? <ErrorState error={error} retry={retry} title="Transcript could not be loaded" /> : null}
      {!isLoading && !isError && !items.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No canonical transcript segment has been persisted yet." />
      ) : null}
      <div className="lh7-transcript">
        {items.map((segment) => (
          <div className="lh7-transcript-segment" key={segment.id}>
            {segment.gapBefore ? (
              <div className="lh7-gap-marker">Transcript gap before this segment</div>
            ) : null}
            <div className="lh7-transcript-segment__meta">
              <span>{formatTranscriptTime(segment.startMs)}</span>
              <strong>{segment.speakerName ?? segment.speakerLabel ?? 'Speaker not identified'}</strong>
              {typeof segment.confidence === 'number' ? <span>{Math.round(segment.confidence * 100)}% confidence</span> : null}
            </div>
            <p>{segment.text}</p>
          </div>
        ))}
      </div>
      {hasMore ? (
        <Button loading={loadingMore} onClick={loadMore}>Load more transcript</Button>
      ) : null}
    </section>
  );
}

function EventRoom({ eventId, goBack }: { eventId: string; goBack: () => void }) {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const roomQuery = usePhase7Room(eventId);
  const transcript = usePhase7Transcript(eventId);
  const schedule = usePhase7Schedule();
  const cancel = usePhase7CancelSchedule();
  const follow = usePhase7Follow();
  const unfollow = usePhase7Unfollow();
  const browserJoin = usePhase7BrowserJoin();
  const createBrowserSession = useCreateHearing();

  useEffect(() => {
    if (transcript.hasNextPage && !transcript.isFetchingNextPage) {
      void transcript.fetchNextPage();
    }
  }, [transcript.hasNextPage, transcript.isFetchingNextPage, transcript.fetchNextPage]);

  if (!eventId) {
    return <Alert type="warning" showIcon message="No hearing selected" action={<Button onClick={goBack}>Back to calendar</Button>} />;
  }
  if (roomQuery.isLoading) return <Loading label="Opening the canonical Hearing Room…" />;
  if (roomQuery.isError || !roomQuery.data) {
    return <ErrorState error={roomQuery.error} retry={() => void roomQuery.refetch()} title="The Hearing Room could not be loaded" />;
  }

  const room = roomQuery.data;
  const event = room.event;
  const participation = room.participation;
  const officialUrl = safeOfficialHttpUrl(event.officialPageUrl);
  const transcriptItems = transcript.data?.pages.flatMap((page) => page.items) ?? [];
  const captureActive = ACTIVE_CAPTURE_STATES.has((room.capture?.status ?? '').toUpperCase());

  const startBrowser = () => {
    browserJoin.mutate(event.id, {
      onSuccess: (plan) => {
        if (plan.mode === 'ATTACH_CANONICAL') {
          message.info('Capiro is already capturing this hearing. You are attached to the shared canonical transcript.');
          void roomQuery.refetch();
          void transcript.refetch();
          return;
        }
        if (plan.mode === 'BLOCKED') {
          message.error(plan.message);
          return;
        }
        createBrowserSession.mutate(
          {
            title: plan.title,
            sourceType: plan.sourceType,
            audioSource: plan.audioSource,
            recordingPolicy: plan.recordingPolicy,
            sourceUrl: plan.sourceUrl,
            hearingId: plan.hearingId,
            committeeId: plan.committeeId,
          },
          {
            onSuccess: (session) => navigate(`/intelligence/hearing-watch/${session.id}`),
            onError: (error) => message.error(liveHearingApiError(error)),
          },
        );
      },
      onError: (error) => message.error(liveHearingApiError(error)),
    });
  };

  return (
    <section className="lh7-view lh7-room">
      <button type="button" className="lh7-back" onClick={goBack}>← Back to Live Hearings</button>
      <header className="lh7-room-hero">
        <div>
          <span className="lh7-eyebrow">{event.chamber} · {event.subcommittee?.name ?? event.committee.name}</span>
          <h2>{event.title}</h2>
          <p>{formatDateTime(event.scheduledStart, event.timeZone)}{event.location ? ` · ${event.location}` : ''}</p>
          <div className="lh7-room-hero__status">
            <StatusPill value={room.capture?.status ?? event.eventStatus} />
            <span>{titleCase(event.streamState)}</span>
            {room.capture?.resolutionProvider ? <span>{room.capture.resolutionProvider}</span> : null}
          </div>
        </div>
        <div className="lh7-room-actions">
          {participation.scheduled ? (
            participation.scheduledByUser ? (
              <Button
                danger
                loading={cancel.isPending}
                onClick={() => cancel.mutate(event.id, {
                  onSuccess: () => message.success('Your scheduled capture was canceled. Shared public history remains intact.'),
                  onError: (error) => message.error(liveHearingApiError(error)),
                })}
              >
                Cancel my recording
              </Button>
            ) : (
              <span className="lh7-rule-badge"><ScheduleOutlined /> Scheduled by rule</span>
            )
          ) : (
            <Button
              type="primary"
              icon={<ScheduleOutlined />}
              loading={schedule.isPending}
              onClick={() => schedule.mutate(event.id, {
                onSuccess: () => message.success('Unattended recording scheduled. You may close Capiro.'),
                onError: (error) => message.error(liveHearingApiError(error)),
              })}
            >
              Schedule recording
            </Button>
          )}
          {participation.followed ? (
            <Button
              loading={unfollow.isPending}
              onClick={() => unfollow.mutate(event.id, {
                onSuccess: () => message.success('No longer following this hearing.'),
                onError: (error) => message.error(liveHearingApiError(error)),
              })}
            >
              Following ✓
            </Button>
          ) : (
            <Button
              loading={follow.isPending}
              onClick={() => follow.mutate(event.id, {
                onSuccess: () => message.success('Following this hearing. Follow state does not create capture demand.'),
                onError: (error) => message.error(liveHearingApiError(error)),
              })}
            >
              Follow hearing
            </Button>
          )}
          <Button
            icon={<VideoCameraOutlined />}
            loading={browserJoin.isPending || createBrowserSession.isPending}
            disabled={room.browser.mode === 'BLOCKED'}
            onClick={startBrowser}
          >
            {room.browser.mode === 'ATTACH_CANONICAL'
              ? 'Attach to shared transcript'
              : 'Join & transcribe in browser'}
          </Button>
          {officialUrl ? (
            <a className="lh7-official-link" href={officialUrl} target="_blank" rel="noreferrer">
              <LinkOutlined /> Official proceeding
            </a>
          ) : null}
        </div>
      </header>

      {captureActive ? (
        <Alert
          type="success"
          showIcon
          message="Server capture is running independently of your browser"
          description="Closing this page or shutting down your computer does not interrupt the canonical capture."
        />
      ) : null}
      {room.browser.mode === 'BLOCKED' ? (
        <Alert type="warning" showIcon message="Browser fallback unavailable" description={room.browser.message} />
      ) : null}

      <div className="lh7-room-grid">
        <div className="lh7-room-main">
          <TranscriptPanel
            room={room}
            items={transcriptItems}
            isLoading={transcript.isLoading}
            isError={transcript.isError}
            error={transcript.error}
            retry={() => void transcript.refetch()}
            hasMore={Boolean(transcript.hasNextPage)}
            loadMore={() => void transcript.fetchNextPage()}
            loadingMore={transcript.isFetchingNextPage}
          />

          <section className="lh7-room-card">
            <div className="lh7-card-heading">
              <div><span className="lh7-eyebrow">Official materials</span><h3>Witnesses & documents</h3></div>
              <span>{room.witnesses.length} witnesses · {room.documents.length} documents</span>
            </div>
            {room.witnesses.length ? (
              <div className="lh7-witnesses">
                {room.witnesses.map((witness, index) => <div key={`${witness}-${index}`}><TeamOutlined /><span>{witness}</span></div>)}
              </div>
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No witness list has been published in the canonical record." />}
            {room.documents.length ? (
              <div className="lh7-documents">
                {room.documents.map((document) => (
                  <a key={document.id} href={document.sourceUrl} target="_blank" rel="noreferrer">
                    <FileTextOutlined />
                    <span><strong>{document.title}</strong><small>{titleCase(document.documentType)}{document.publishedAt ? ` · ${formatDateTime(document.publishedAt)}` : ''}</small></span>
                  </a>
                ))}
              </div>
            ) : null}
          </section>

          <section className="lh7-room-card">
            <div className="lh7-card-heading">
              <div><span className="lh7-eyebrow">Official update timeline</span><h3>Changes from the committee</h3></div>
              <span>{room.updates.length}</span>
            </div>
            {room.updates.length ? (
              <ol className="lh7-timeline">
                {room.updates.map((update) => (
                  <li key={update.id}>
                    <span />
                    <div>
                      <small>{titleCase(update.updateType)} · {formatDateTime(update.publishedAt ?? update.firstSeenAt)}</small>
                      <strong>{update.title}</strong>
                      {update.summary ? <p>{update.summary}</p> : null}
                      {safeOfficialHttpUrl(update.sourceUrl) ? <a href={safeOfficialHttpUrl(update.sourceUrl)} target="_blank" rel="noreferrer">Official source</a> : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No official changes have been recorded for this event." />}
          </section>
        </div>

        <aside className="lh7-room-side">
          <CaptureHealth capture={room.capture} />
          <section className="lh7-room-card">
            <span className="lh7-eyebrow">Participation</span>
            <div className="lh7-fact-list">
              <span><small>Scheduled</small><strong>{participation.scheduled ? 'Yes' : 'No'}</strong></span>
              <span><small>Following</small><strong>{participation.followed ? 'Yes' : 'No'}</strong></span>
              <span><small>Start alerts</small><strong>{participation.notifyOnStart ? 'On' : 'Off'}</strong></span>
              <span><small>Update alerts</small><strong>{participation.notifyOnUpdates ? 'On' : 'Off'}</strong></span>
            </div>
          </section>
          <section className="lh7-room-card">
            <span className="lh7-eyebrow">Committee roster</span>
            <div className="lh7-leadership">
              <span><small>Chair</small><strong>{room.chair?.name ?? 'Not stated'}</strong></span>
              <span><small>Ranking member</small><strong>{room.rankingMember?.name ?? 'Not stated'}</strong></span>
            </div>
            <div className="lh7-member-list">
              {room.members.slice(0, 30).map((member) => (
                <div key={member.id}>
                  <strong>{member.name}</strong>
                  <small>{[member.party, member.role].filter(Boolean).join(' · ')}</small>
                </div>
              ))}
            </div>
          </section>
          <section className="lh7-room-card">
            <span className="lh7-eyebrow">Live Intelligence</span>
            {room.intelligenceStatus === 'PHASE_8_PERSISTENCE_NOT_ENABLED' ? (
              <Alert
                type="info"
                showIcon
                message="Intelligence persistence is not enabled in Phase 7"
                description="This room deliberately does not fabricate insight cards. Phase 8 will persist public insights and tenant-isolated relevance."
              />
            ) : null}
          </section>
          <section className="lh7-room-card">
            <span className="lh7-eyebrow">Source provenance</span>
            <div className="lh7-fact-list">
              <span><small>Official page</small><strong>{officialUrl ? 'Resolved' : 'Unavailable'}</strong></span>
              <span><small>Stream state</small><strong>{titleCase(event.streamState)}</strong></span>
              <span><small>Coverage</small><strong>{titleCase(event.coverageStatus)}</strong></span>
              <span><small>Resolver policy</small><strong>{titleCase(room.capture?.resolutionCapturePolicy)}</strong></span>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

export function LiveHearingsPhase7Surface() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawView = searchParams.get('hearingView') ?? 'calendar';
  const view: Phase7View =
    rawView === 'event' || rawView === 'committee' || TOP_LEVEL_VIEWS.has(rawView as TopLevelView)
      ? (rawView as Phase7View)
      : 'calendar';

  if (CANONICAL_PHASE34_VIEWS.has(view)) return <LiveHearingsCanonicalSurface />;

  const eventId = searchParams.get('event') ?? '';
  const topLevelActive = TOP_LEVEL_VIEWS.has(view as TopLevelView) ? (view as TopLevelView) : undefined;
  const navigateView = (next: TopLevelView) => {
    const params = new URLSearchParams(searchParams);
    params.set('hearingView', next);
    params.delete('event');
    params.delete('committee');
    setSearchParams(params);
  };
  const openEvent = (id: string) => {
    const params = new URLSearchParams(searchParams);
    params.set('hearingView', 'event');
    params.set('event', id);
    params.delete('committee');
    setSearchParams(params);
  };

  return (
    <div className="lh7-surface">
      <Phase7Nav active={topLevelActive} onSelect={navigateView} />
      {view === 'live' ? <LiveNowView openEvent={openEvent} /> : null}
      {view === 'scheduled' ? <ScheduledView openEvent={openEvent} /> : null}
      {view === 'sessions' ? <SessionsView openEvent={openEvent} openCalendar={() => navigateView('calendar')} /> : null}
      {view === 'archive' ? <ArchiveView openEvent={openEvent} /> : null}
      {view === 'event' ? <EventRoom eventId={eventId} goBack={() => navigateView('calendar')} /> : null}
    </div>
  );
}

export default LiveHearingsPhase7Surface;
