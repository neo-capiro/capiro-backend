import { ExpandableHearingTitle } from './ExpandableHearingTitle.js';
import { recordingAttemptDate, hasTestSessionTitle } from '../lib/hearing-presentation.js';
import { LegalDeadlineOverlay } from '../research/LegalDeadlineOverlay.js';

/**
 * Hearings tab (§7.7) — the module's landing tab. Two columns: the schedule
 * (left) and sessions + scheduled recordings (right).
 *
 * PR A remediation (2026-09-02, LW-QA-001/002/005):
 *  - The schedule now reads the CANONICAL Phase 3 master calendar
 *    (`/api/legiwatch/live-hearings/calendar`) scoped to the SELECTED WEEK
 *    (from/to), instead of one forward-only upcoming fetch paged locally.
 *    Historical weeks therefore fetch their real completed rows, and the
 *    header count is the server's count for exactly the visible range.
 *  - Date/time rendering goes through the shared contract
 *    (`lib/hearing-datetime.ts`): the true instant when the official time is
 *    known, "Time not announced" otherwise — never the 8:00 PM previous-day
 *    artifact of parsing a calendar date as UTC midnight.
 *  - Closed sessions (publicAccessStatus CLOSED / UNKNOWN-private) are
 *    classified from canonical visibility BEFORE any capture affordance:
 *    they render "Closed session — no public stream", never "Attend live".
 *
 * Scheduled server attendance is managed from canonical hearing detail.
 * Browser sessions use the shared live capture room.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight, Search, DownloadCloud } from 'lucide-react';
import { ArchiveSubTab } from './ArchiveSubTab.js';
import { ServerCaptureSessions } from './ServerCaptureSessions.js';
import { CapiroDrawer } from '../../../components/overlays/index.js';
import { useHearingSessionHistory } from '../../../../lib/hearing-watch-api.js';
import { useLiveHearingsCoverage } from '../../../../pages/radar/live-hearings/live-hearings-api.js';
import {
  useLwWeekCalendar,
  isLiveEvent,
  browserCaptureCapability,
  serverCaptureCapability,
  captureSummaryLabel,
  type CanonicalHearingEvent,
} from '../lib/canonical-hearings.js';
import { LwPill, LwSeg, LwButton, LwSkeleton } from '../lib/primitives.js';
import { LwStateEmpty, LwStateUnavailable } from '../states/SystemStates.js';
import { LwModal } from '../overlays/LwModal.js';
import { useCalendarExportBulk, downloadIcs } from '../lib/wave1-api.js';
import { useLatestFloridaHearing } from '../lib/use-latest-florida-hearing.js';
import {
  useIntelFeatureEnabled,
  STATE_CALENDAR_FEATURE,
} from '../../../../lib/intel-feature-flags.js';
import {
  useCalendarFolderScope,
  useCalendarSourceCoverage,
  type CalendarSourceCoverageRow,
} from '../lib/calendar-preparation-api.js';
import { easternDayOf } from '../lib/hearing-datetime.js';
import './hearings.css';
import type { HearingCapability, Tone } from '../lib/types.js';
import {
  calendarBucketIndex,
  formatHearingDay,
  formatHearingTime,
  momentOfCanonicalEvent,
  parseHearingMoment,
  useEasternWeekDays,
} from '../lib/hearing-datetime.js';

type ViewMode = 'calendar' | 'list';

const KIND_TONE: Record<string, Tone> = { HEARING: 'brand', MARKUP: 'gray' };
const FLORIDA_COVERAGE_FRESH_MS = 24 * 60 * 60 * 1000;
const FLORIDA_COVERAGE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type FloridaCoverageState =
  | 'checking'
  | 'pending'
  | 'error'
  | 'missing'
  | 'failed'
  | 'partial'
  | 'stale'
  | 'complete';

const FLORIDA_COVERAGE_LABEL: Record<FloridaCoverageState, string> = {
  checking: 'Checking',
  pending: 'Source check in progress',
  error: 'Check unavailable',
  missing: 'Coverage not verified',
  failed: 'Failed check',
  partial: 'Partial check',
  stale: 'Stale check',
  complete: 'Healthy',
};

function floridaCoverageState(
  rows: CalendarSourceCoverageRow[],
  from: string,
  to: string,
  asOf?: string,
): Exclude<FloridaCoverageState, 'checking' | 'error'> {
  const reference = Date.parse(asOf ?? '');
  const referenceTime = Number.isFinite(reference) ? reference : Date.now();
  const selected = ['house', 'senate']
    .map((chamber) =>
      rows
        .filter((row) => row.chamber.toLowerCase() === chamber)
        .sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt))[0],
    )
    .filter((row): row is CalendarSourceCoverageRow => Boolean(row));

  if (selected.length === 0) return 'missing';
  if (selected.some((row) => row.status.toLowerCase() === 'failed')) return 'failed';

  const stale = selected.some((row) => {
    const checkedAt = Date.parse(row.checkedAt);
    if (!Number.isFinite(checkedAt)) return true;
    const age = referenceTime - checkedAt;
    return age < -FLORIDA_COVERAGE_CLOCK_SKEW_MS || age >= FLORIDA_COVERAGE_FRESH_MS;
  });
  if (stale) return 'stale';
  if (selected.some((row) => row.status.toLowerCase() === 'partial')) return 'partial';
  if (selected.some((row) => row.status.toLowerCase() === 'attempted')) return 'pending';

  // A verified negative requires BOTH chambers, a successful source check and
  // a receipt whose inclusive window contains the entire displayed range.
  if (
    selected.length !== 2 ||
    selected.some(
      (row) =>
        row.status.toLowerCase() !== 'complete' ||
        !row.from ||
        !row.to ||
        row.from > from ||
        row.to < to,
    )
  )
    return 'missing';
  return 'complete';
}

function dateOnlyParts(value: string) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return { year, month, day };
}

function formatDateOnly(value: string) {
  const { year, month, day } = dateOnlyParts(value);
  return `${MONTHS[month - 1] ?? value} ${day}, ${year}`;
}

function formatDateOnlyRange(from: string, to: string) {
  const start = dateOnlyParts(from);
  const end = dateOnlyParts(to);
  if (start.year === end.year && start.month === end.month)
    return `${MONTHS[start.month - 1]} ${start.day}–${end.day}, ${start.year}`;
  if (start.year === end.year)
    return `${MONTHS[start.month - 1]} ${start.day}–${MONTHS[end.month - 1]} ${end.day}, ${start.year}`;
  return `${formatDateOnly(from)}–${formatDateOnly(to)}`;
}

function sameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** vNext capability for a canonical row (LW-QA-002): visibility FIRST. */
export function canonicalCapability(e: CanonicalHearingEvent): {
  capability: HearingCapability;
  closed: boolean;
  reason: string;
} {
  const access = (e.publicAccessStatus ?? 'UNKNOWN').toUpperCase();
  // LW-QA-002 review item A: UNKNOWN is NOT CLOSED. A closed session is a
  // verified negative ("closed session — no public stream"); an unverified one
  // simply has not had its public access confirmed from official metadata.
  // Closed/PRIVATE → labeled CLOSED SESSION, no capture action. UNKNOWN →
  // labeled "Public access unverified", fail-closed for capture (no affordance,
  // consent inert), but never labeled as a closed session.
  if (access === 'CLOSED' || access === 'PRIVATE') {
    return {
      capability: 'unavailable',
      closed: true,
      reason: 'Closed session — no public stream.',
    };
  }
  if (access === 'UNKNOWN') {
    return {
      capability: 'unavailable',
      closed: false,
      reason:
        'Public access unverified — official source metadata does not confirm public access yet.',
    };
  }
  const server = serverCaptureCapability(e);
  if (server.allowed) return { capability: 'direct', closed: false, reason: server.reason ?? '' };
  const browser = browserCaptureCapability(e);
  if (browser.allowed)
    return { capability: 'browser', closed: false, reason: browser.reason ?? '' };
  return {
    capability: 'unavailable',
    closed: false,
    reason: browser.reason ?? server.reason ?? '',
  };
}

/**
 * PR D / LW-QA-011 — true below 900px CSS width. matchMedia is the same
 * mechanism the stylesheet media queries use, so JS and CSS agree at the
 * boundary; a resize listener covers browsers without addListener callbacks
 * (jsdom's matchMedia is stubbed to a non-live object, so a fallback resize
 * check keeps tests deterministic).
 */
function useMediaBelow900(): boolean {
  const [below, setBelow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    if (typeof window.matchMedia === 'function') {
      return window.matchMedia('(max-width: 899px)').matches;
    }
    return window.innerWidth < 900;
  });
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      const onResize = () => setBelow(window.innerWidth < 900);
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }
    const mq = window.matchMedia('(max-width: 899px)');
    const onChange = (ev: MediaQueryListEvent) => setBelow(ev.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return below;
}

/**
 * The Hearings sub-views (W1-3 IA):
 *   ?sub=schedule  the calendar + list (the landing sub-view)
 *   ?sub=sessions  My Sessions and scheduled recordings
 *   ?sub=archive   the durable historical corpus, searched server-side
 */
const HEARING_SUBS = [
  { id: 'schedule' as const, label: 'Schedule' },
  { id: 'sessions' as const, label: 'Recordings' },
  { id: 'archive' as const, label: 'Past hearings' },
];
type HearingSub = (typeof HEARING_SUBS)[number]['id'];

export function HearingsTab({ scope }: { scope: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  // Unknown values land on the schedule rather than rendering nothing.
  const rawSub = searchParams.get('sub');
  const sub: HearingSub = HEARING_SUBS.some((s) => s.id === rawSub)
    ? (rawSub as HearingSub)
    : 'schedule';
  const setSub = (next: HearingSub) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'schedule') params.delete('sub');
    else params.set('sub', next);
    setSearchParams(params, { replace: true });
  };
  const history = useHearingSessionHistory();
  const exportWeek = useCalendarExportBulk();
  const sessions = history.data?.pages.flatMap((page) => page.items) ?? [];
  const interrupted = sessions.filter((session) => captureNeedsAttention(session.status));
  // Show ALL loaded browser sessions — never hide a loaded row behind an
  // arbitrary "first 3" cut. Older sessions stay reachable via load-more.
  const [hideTestSessions, setHideTestSessions] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');
  const [sessionLifecycle, setSessionLifecycle] = useState('all');
  const visibleSessions = sessions.filter((session) =>
    (!hideTestSessions || !hasTestSessionTitle(session.title)) &&
    (!sessionSearch.trim() || session.title.toLowerCase().includes(sessionSearch.trim().toLowerCase())) &&
    (sessionLifecycle === 'all' || (sessionLifecycle === 'completed') === ['ended', 'completed'].includes(session.status)));

  // The user's saved desktop preference (LegiWatch Settings → default view).
  const [view, setView] = useState<ViewMode>(
    searchParams.get('calendarView') === 'list' ? 'list' : 'calendar',
  );
  const [weekAnchor, setWeekAnchor] = useState<Date>(() => {
    const day = searchParams.get('calendarDate');
    return day && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day))
      ? new Date(`${day}T12:00:00Z`)
      : new Date();
  });
  const [committee, setCommittee] = useState<string>(searchParams.get('calendarCommittee') ?? '');
  const [kind, setKind] = useState<string>(searchParams.get('calendarKind') ?? '');
  const [search, setSearch] = useState(searchParams.get('calendarQ') ?? '');
  const [dateOnlyReminder, setDateOnlyReminder] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false),
    [expandedAgenda, setExpandedAgenda] = useState(searchParams.get('calendarExpanded') === 'true');
  const [rangeMode, setRangeMode] = useState<'week' | 'day'>(
    searchParams.get('calendarRange') === 'day' ? 'day' : 'week',
  );
  // Florida public hearings are visible to EVERY tenant. The stateCalendar
  // flag still gates the folder/session/chamber/status refinement controls,
  // but the jurisdiction filter itself is a public-feed control and must not
  // be hidden per-tenant. Florida is the only supported state today; the
  // default calendar is inclusive (All jurisdictions) unless the user saved a
  // narrower filter.
  const stateCalendar = useIntelFeatureEnabled(STATE_CALENDAR_FEATURE);
  const savedJurisdiction = searchParams.get('jurisdiction');
  const jurisdiction: 'US' | 'FL' | 'ALL' = ['US', 'FL', 'ALL'].includes(
    savedJurisdiction ?? '',
  )
    ? (savedJurisdiction as 'US' | 'FL' | 'ALL')
    : 'ALL';
  const selectedFolders = stateCalendar
    ? searchParams.getAll('calendarFolder').filter(Boolean)
    : [];
  const session = stateCalendar ? (searchParams.get('session') ?? '') : '';
  const following = stateCalendar && searchParams.get('following') === 'true';
  const liveOnly = searchParams.get('live') === 'true';
  const chamber = stateCalendar ? (searchParams.get('chamber') ?? '') : '';
  const eventStatus = stateCalendar ? (searchParams.get('eventStatus') ?? '') : '';
  const clientId = scope && scope !== 'all' ? scope : undefined;
  const folderChoices = useCalendarFolderScope({ clientId, jurisdiction }, stateCalendar);
  const privateSelection = stateCalendar && Boolean(selectedFolders.length || clientId);
  const folderSelection = useCalendarFolderScope(
    {
      clientId,
      jurisdiction,
      session: session || undefined,
      ...(selectedFolders.length ? { folderIds: selectedFolders } : {}),
    },
    privateSelection,
  );
  const setCalendarParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams);
    if (value) params.set(key, value);
    else params.delete(key);
    setSearchParams(params, { replace: true });
  };

  // PR D / LW-QA-011: below 900px the seven-day grid compresses to ~90px
  // columns — unreadable. The schedule TEMPORARILY renders agenda/list layout
  // (the LwSeg control is disabled with the reason so the state is honest).
  // The override is NEVER written back to the user's preference: returning to
  // a full-size display restores exactly what they saved. CSS already drops
  // the grid to one day per row below 780 as belt-and-braces.
  const narrow = useMediaBelow900();
  const effectiveView: ViewMode = narrow ? 'list' : view;

  const weekDays = useEasternWeekDays(weekAnchor);
  const anchorDay = easternDayOf(weekAnchor.toISOString())!;
  useEffect(() => {
    const params = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries({
      calendarDate: anchorDay,
      calendarView: view,
      calendarRange: rangeMode,
      calendarCommittee: committee,
      calendarKind: kind,
      calendarQ: search,
      calendarExpanded: expandedAgenda ? 'true' : '',
    })) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    // Forward the incoming location state: a Back navigation from hearing
    // detail hands the scroll offset over via legiwatchScrollY, and this
    // normalization write runs BEFORE the calendar query resolves — dropping
    // state here means the scroll-restore effect below never sees it.
    if (params.toString() !== searchParams.toString())
      setSearchParams(params, { replace: true, state: location.state });
  }, [
    anchorDay,
    view,
    rangeMode,
    committee,
    kind,
    search,
    expandedAgenda,
    searchParams,
    setSearchParams,
    location.state,
  ]);
  const rangeFrom = rangeMode === 'day' ? anchorDay : (weekDays[0] ?? '');
  const rangeTo = rangeMode === 'day' ? anchorDay : (weekDays[6] ?? '');
  const sourceCoverage = useCalendarSourceCoverage(
    { from: rangeFrom, to: rangeTo, session: session || undefined },
    jurisdiction !== 'US' && sub === 'schedule',
  );

  // LW-QA-005: server-side range query. The query key includes the week, so a
  // prior week's response can never overwrite a newer navigation request.
  // Jurisdiction is ALWAYS forwarded — the public Florida feed must not depend
  // on a tenant feature flag.
  const calendarSelection = {
    from: rangeFrom,
    to: rangeTo,
    committee: committee || undefined,
    q: search.trim() || undefined,
    eventType: kind || undefined,
    jurisdiction,
    ...(stateCalendar
      ? {
          session: session || undefined,
          following: following || undefined,
          chamber: chamber || undefined,
          eventStatus: eventStatus || undefined,
          ...(privateSelection ? { billIds: folderSelection.data?.billIds ?? [] } : {}),
        }
      : {}),
  };
  const calendar = useLwWeekCalendar(
    calendarSelection,
    !privateSelection || folderSelection.isSuccess,
  );

  /**
   * Explicit, user-initiated lookup for the most recent canonical Florida
   * proceeding that MATCHES the active calendar selection (minus date bounds).
   * Only enabled when the Florida range is EMPTY and fully loaded — the
   * calendar never changes the date window in response to a filter, so the
   * only way the date moves here is the deliberate click below. Bounded
   * (pageSize 1, latest-first) and global-public (every tenant; no media
   * feature flag required to VIEW public FL rows). Because the lookup honors
   * the active filters, the row it finds renders in the calendar it jumps to.
   */
  const floridaRangeEmpty =
    jurisdiction === 'FL' && calendar.isSuccess && (calendar.data?.total ?? 0) === 0;
  const floridaCoverage: FloridaCoverageState = sourceCoverage.isError
    ? 'error'
    : sourceCoverage.isPending
      ? 'checking'
      : floridaCoverageState(
          sourceCoverage.data?.rows ?? [],
          rangeFrom,
          rangeTo,
          sourceCoverage.data?.asOf,
        );
  const floridaRangeVerifiedEmpty = floridaRangeEmpty && floridaCoverage === 'complete';
  const floridaSelectionNarrowed = Boolean(
    committee ||
      kind ||
      search.trim() ||
      session ||
      following ||
      chamber ||
      eventStatus ||
      privateSelection,
  );
  const latestFloridaSelection = {
    committee: committee || undefined,
    q: search.trim() || undefined,
    eventType: kind || undefined,
    ...(stateCalendar ? {
        session: session || undefined,
        following: following || undefined,
        chamber: chamber || undefined,
        eventStatus: eventStatus || undefined,
        ...(privateSelection ? { billIds: folderSelection.data?.billIds ?? [] } : {}),
      } : {}),
  };
  const latestFlorida = useLatestFloridaHearing(
    latestFloridaSelection,
    sub === 'schedule' && floridaRangeEmpty,
  );
  const latestFloridaHearing = latestFlorida.data?.hearing ?? null;
  const latestFloridaDay = latestFloridaHearing?.calendarDate ?? null;
  const jumpToLatestFlorida = (calendarDay: string) => {
    // Require a real canonical date — never fabricate one. The button is
    // disabled unless the returned event carries calendarDate, so this
    // always receives a valid day.
    const anchor = new Date(`${calendarDay}T12:00:00Z`);
    if (rangeMode === 'week') {
      // Rewind to the Monday of the event's week (Eastern week starts Monday).
      const dow = anchor.getUTCDay(); // 0=Sun … 6=Sat
      const daysSinceMonday = (dow + 6) % 7;
      anchor.setUTCDate(anchor.getUTCDate() - daysSinceMonday);
    }
    setWeekAnchor(anchor);
  };
  const floridaRangeLabel = formatDateOnlyRange(rangeFrom, rangeTo);
  const floridaEmptyRangeNotice = floridaRangeEmpty ? (
    <div
      className={`lw-hearings-empty-range${floridaRangeVerifiedEmpty ? ' is-verified' : ''}`}
      role="status"
      aria-label="Florida calendar availability"
      data-coverage-state={floridaCoverage}
    >
      <div className="lw-hearings-empty-range__copy">
        <p className="lw-hearings-empty-range__title">
          {floridaRangeVerifiedEmpty
            ? `No Florida proceedings${floridaSelectionNarrowed ? ' matching this selection' : ''} were published for ${floridaRangeLabel}.`
            : `Florida proceeding availability is not verified for ${floridaRangeLabel}.`}
        </p>
        {!floridaRangeVerifiedEmpty ? (
          <p className="lw-card__meta">
            {floridaCoverage === 'checking'
              ? 'The House and Senate source checks are still loading.'
              : floridaCoverage === 'pending'
                ? 'A Florida source check is in progress. Results are pending.'
              : floridaCoverage === 'error'
                ? 'The source coverage check could not be loaded.'
                : floridaCoverage === 'failed'
                  ? 'At least one chamber source check failed.'
                  : floridaCoverage === 'partial'
                    ? 'At least one chamber source check is partial.'
                    : floridaCoverage === 'stale'
                      ? 'At least one chamber source check is stale.'
                      : 'Fresh, complete House and Senate checks do not cover this full date range.'}
          </p>
        ) : null}
        {latestFlorida.isError ? (
          <p className="lw-card__meta">The latest published Florida proceeding could not be loaded.</p>
        ) : latestFlorida.isPending ? (
          <p className="lw-card__meta">Checking the latest published Florida proceeding…</p>
        ) : latestFloridaHearing && latestFloridaDay ? (
          <p className="lw-card__meta">
            Latest published proceeding: <strong>{latestFloridaHearing.title}</strong> ·{' '}
            {formatDateOnly(latestFloridaDay)}
          </p>
        ) : latestFlorida.data?.answered ? (
          <p className="lw-card__meta">No earlier Florida proceedings match this selection.</p>
        ) : null}
      </div>
      <div className="lw-hearings-empty-range__actions">
        {sourceCoverage.isError ? (
          <LwButton onClick={() => void sourceCoverage.refetch()}>Retry source check</LwButton>
        ) : null}
        {latestFlorida.isError ? (
          <LwButton onClick={() => void latestFlorida.refetch()}>Retry latest hearing</LwButton>
        ) : latestFloridaDay ? (
          <LwButton onClick={() => jumpToLatestFlorida(latestFloridaDay)}>
            View latest Florida hearings
          </LwButton>
        ) : null}
      </div>
    </div>
  ) : null;

  const rows = useMemo(() => calendar.data?.items ?? [], [calendar.data]);
  useEffect(() => {
    const y = location.state?.legiwatchScrollY;
    if (calendar.isSuccess && typeof y === 'number' && Number.isFinite(y)) {
      const frame = requestAnimationFrame(() => window.scrollTo(0, Math.max(0, y)));
      return () => cancelAnimationFrame(frame);
    }
  }, [calendar.isSuccess, location.key]);
  const serverTotal = calendar.data?.total ?? 0;

  const filtered = liveOnly ? rows.filter((event) => isLiveEvent(event)) : rows;

  const committees = useMemo(
    () => [...new Map(rows.filter((e) => e.committee?.name).map((e) => [
      e.committee!.systemCode ?? e.committee!.name,
      { value: e.committee!.systemCode ?? e.committee!.name,
        label: `${e.chamber} · ${e.committee!.name}` },
    ])).values()].sort((a, b) => a.label.localeCompare(b.label)),
    [rows],
  );

  const visibleCount = liveOnly ? filtered.length : Math.min(serverTotal, rows.length);

  // Live rows come from the canonical live endpoint's shape via the calendar
  // rows themselves; the room route is handled in the live tab.
  const live = useMemo(() => rows.find((e) => isLiveEvent(e)) ?? null, [rows]);

  const byDay = useMemo(() => {
    const map = new Map<number, CanonicalHearingEvent[]>();
    weekDays.forEach((_, i) => map.set(i, []));
    for (const e of filtered) {
      const idx = calendarBucketIndex(momentOfCanonicalEvent(e), weekDays);
      if (idx >= 0) map.get(idx)!.push(e);
    }
    for (const list of map.values()) {
      list.sort((a, b) =>
        (a.scheduledStart ?? a.calendarDate ?? '').localeCompare(
          b.scheduledStart ?? b.calendarDate ?? '',
        ),
      );
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, weekDays]);

  const openHearing = (e: CanonicalHearingEvent) => {
    // Live and archived proceedings share the canonical transcript/intel room.
    const context = new URLSearchParams();
    if (clientId) context.set('client', clientId);
    for (const folder of selectedFolders) context.append('folder', folder);
    navigate(
      `/legiwatch/hearings/${encodeURIComponent(e.id)}${context.size ? `?${context}` : ''}`,
      {
        state: {
          legiwatchReturnTo: location.pathname + location.search,
          legiwatchScrollY: window.scrollY,
        },
      },
    );
  };

  // Sub-view strip keeps the three durable hearing destinations explicit: schedule, recordings, and the public archive.
  // chip. Rendered for every sub-view so navigation is always reachable.
  const subStrip = (
    <div className="lw-subtabs" aria-label="Hearings sub-views">
      <LwSeg
        ariaLabel="Hearing views"
        options={HEARING_SUBS.map((s) => ({ id: s.id, label: s.label }))}
        value={sub}
        onChange={(next) => setSub(next as HearingSub)}
      />
      <span className="lw-recordkey" aria-hidden="true">
        <span className="lw-recordkey__sw lw-recordkey__sw--public" />
        <span className="lw-recordkey__lab">Public record</span>
        <span className="lw-recordkey__sep" />
        <span className="lw-recordkey__sw lw-recordkey__sw--analysis" />
        <span className="lw-recordkey__lab lw-recordkey__lab--analysis">Your analysis</span>
      </span>
    </div>
  );

  // The jurisdiction filter is a PUBLIC-feed control: it is never hidden by a
  // tenant feature flag. Florida is the only supported state today.
  const jurisdictionControl = (
    <div className="lw-controls" aria-label="Calendar jurisdiction selection">
      <label>
        Jurisdiction{' '}
        <select
          className="lw-btn lw-select"
          aria-label="Calendar jurisdiction"
          value={jurisdiction}
          onChange={(e) => {
            setCommittee('');
            setCalendarParam('jurisdiction', e.target.value);
          }}
        >
          <option value="ALL">All jurisdictions</option>
          <option value="US">Federal</option>
          <option value="FL">Florida</option>
        </select>
      </label>
    </div>
  );

  const phase3Filters = (
    <details className="lw-hearings-filter-details">
      <summary className="lw-btn">More filters</summary>
      <div
        className="lw-controls lw-hearings-filter-details__body"
      aria-label="Calendar selection"
      style={narrow ? { display: 'grid', gap: 16 } : undefined}
    >
      <label>
        Chamber{' '}
        <select
          className="lw-btn lw-select"
          aria-label="Calendar chamber"
          value={chamber}
          onChange={(e) => setCalendarParam('chamber', e.target.value)}
        >
          <option value="">All chambers</option>
          <option value="house">House</option>
          <option value="senate">Senate</option>
          <option value="joint">Joint</option>
        </select>
      </label>
      <details>
        <summary className="lw-btn">
          {selectedFolders.length
            ? `${selectedFolders.length} folders selected`
            : clientId
              ? 'All client folders'
              : 'All public events'}
        </summary>
        <fieldset
          aria-label="Calendar folders"
          style={{ maxHeight: 240, overflowY: 'auto', display: 'grid', gap: 8, padding: 12 }}
        >
          <legend>Match any selected folder</legend>
          {(folderChoices.data?.folders ?? []).map((f) => (
            <label key={f.id}>
              <input
                type="checkbox"
                checked={selectedFolders.includes(f.id)}
                onChange={(e) => {
                  const params = new URLSearchParams(searchParams);
                  const next = e.target.checked
                    ? [...selectedFolders, f.id]
                    : selectedFolders.filter((id) => id !== f.id);
                  params.delete('calendarFolder');
                  for (const id of next) params.append('calendarFolder', id);
                  setSearchParams(params, { replace: true });
                }}
              />{' '}
              {f.name}
            </label>
          ))}
          <button type="button" onClick={() => setCalendarParam('calendarFolder', '')}>
            Clear folders
          </button>
        </fieldset>
      </details>
      <label>
        Session{' '}
        <input
          className="lw-btn"
          aria-label="Calendar session"
          placeholder="All sessions"
          value={session}
          onChange={(e) => setCalendarParam('session', e.target.value)}
          style={{ width: 125 }}
        />
      </label>
      <label>
        Status{' '}
        <select
          className="lw-btn lw-select"
          aria-label="Calendar status"
          value={eventStatus}
          onChange={(e) => setCalendarParam('eventStatus', e.target.value)}
        >
          <option value="">All statuses</option>
          <option value="scheduled">Scheduled</option>
          <option value="postponed">Postponed</option>
          <option value="canceled">Canceled</option>
          <option value="completed">Completed</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={following}
          onChange={(e) => setCalendarParam('following', e.target.checked ? 'true' : '')}
        />{' '}
        Following
      </label>
      {folderSelection.isError || folderChoices.isError ? (
        <span role="alert">
          Folder selection could not be checked.{' '}
          <button
            onClick={() => {
              void folderChoices.refetch();
              if (privateSelection) void folderSelection.refetch();
            }}
          >
            Retry
          </button>
        </span>
      ) : null}
      </div>
    </details>
  );
  const scheduleToolbar = (
    <>
      <div className="lw-selectwrap">
        <select
          aria-label="Committee"
          className="lw-btn lw-select"
          value={committee}
          onChange={(e) => setCommittee(e.target.value)}
        >
          <option value="">All committees</option>
          {committees.map((committee) => <option key={committee.value} value={committee.value}>{committee.label}</option>)}
        </select>
        <ChevronDown size={14} className="lw-select__caret" aria-hidden="true" />
      </div>
      <div className="lw-selectwrap">
        <select
          aria-label="Proceeding type"
          className="lw-btn lw-select"
          value={kind.toLowerCase()}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">All proceedings</option>
          <option value="committee">Committee meetings</option>
          <option value="hearing">Hearings</option>
          <option value="markup">Markups</option>
          {stateCalendar ? <>
            <option value="floor">Floor sessions</option>
            <option value="joint">Joint meetings</option>
          </> : null}
        </select>
        <ChevronDown size={14} className="lw-select__caret" aria-hidden="true" />
      </div>
      <div className="lw-search">
        <Search size={16} className="lw-search__icon" aria-hidden="true" />
        <input
          aria-label="Search proceedings"
          aria-describedby="hearings-search-hint"
          placeholder="Search this week"
          title="Filter by title, committee or witness"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span id="hearings-search-hint" className="lw-sr-only">Filter visible proceedings by title, committee, or witness name</span>
      </div>
    </>
  );

  if (sub === 'archive') {
    return (
      <div className="lw-body">
        {subStrip}
        {/* W1-3 — server-side search over the durable historical corpus. */}
        <ArchiveSubTab clientId={scope} />
      </div>
    );
  }

  return (
    <div className="lw-body lw-hearings-body">
      {subStrip}
      {sub === 'schedule' && selectedFolders.length ? <div className="lw-card" role="status" aria-label="Active calendar folder scope" style={{ padding: 12, marginBottom: 12 }}>
        <strong>Folder calendar: </strong>{selectedFolders.map((id, index) => folderChoices.data?.folders.find((folder) => folder.id === id)?.name ?? `Selected folder ${index + 1}`).join(', ')}
        <span> · Events matching the selected folders</span>{' '}
        <LwButton onClick={() => setCalendarParam('calendarFolder', '')}>Clear folder scope</LwButton>
      </div> : null}
      {sub === 'schedule' ? (
        <>
          {narrow ? (
            <>
              <LwButton onClick={() => setFiltersOpen(true)}>Calendar filters</LwButton>
              <CapiroDrawer
                open={filtersOpen}
                title="Calendar filters"
                onClose={() => setFiltersOpen(false)}
              >
                <div className="lw-hearings-quick-filters" aria-label="Quick hearing filters">
                  <label><input type="checkbox" checked={liveOnly} onChange={(e) => setCalendarParam('live', e.target.checked ? 'true' : '')} /> Live</label>
                  <label><input type="checkbox" checked={following} onChange={(e) => setCalendarParam('following', e.target.checked ? 'true' : '')} /> Following</label>
                </div>
                {jurisdictionControl}
                {stateCalendar ? phase3Filters : null}
                <LwSeg ariaLabel="Schedule view" options={[{ id: 'calendar' as ViewMode, label: 'Calendar' }, { id: 'list' as ViewMode, label: 'Agenda' }]} value={effectiveView} onChange={setView} />
                <LwSeg ariaLabel="Calendar range" options={[{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }]} value={rangeMode} onChange={(next) => setRangeMode(next as 'day' | 'week')} />
                <div className="lw-hearings-mobile-toolbar">{scheduleToolbar}</div>
                {stateCalendar ? (
                  <label className="lw-hearings-date-controls__reminder">
                    <input type="checkbox" checked={dateOnlyReminder} onChange={(e) => setDateOnlyReminder(e.target.checked)} />{' '}
                    Include date-only reminders
                  </label>
                ) : null}
                <LwButton className="lw-hearings-date-controls__export" disabled={exportWeek.isPending || calendar.isError || (privateSelection && !folderSelection.isSuccess)} onClick={() => exportWeek.mutate({ ...calendarSelection, dateOnlyReminder }, { onSuccess: downloadIcs })}>
                  {exportWeek.isPending ? 'Preparing…' : 'Export calendar'}
                </LwButton>
                <label className="lw-hearings-expand--drawer">
                  <input
                    type="checkbox"
                    checked={expandedAgenda}
                    onChange={(e) => {
                      setExpandedAgenda(e.target.checked);
                      if (e.target.checked) setView('list');
                    }}
                  />{' '}
                  Expand published agendas
                </label>
              </CapiroDrawer>
            </>
          ) : (
            <>
              <div className="lw-hearings-quick-filters" aria-label="Quick hearing filters">
                <label><input type="checkbox" checked={liveOnly} onChange={(e) => setCalendarParam('live', e.target.checked ? 'true' : '')} /> Live</label>
                <label><input type="checkbox" checked={following} onChange={(e) => setCalendarParam('following', e.target.checked ? 'true' : '')} /> Following</label>
              </div>
              {stateCalendar ? phase3Filters : null}
            </>
          )}
          <div className="lw-controls lw-hearings-date-controls" aria-label="Calendar date and display">
            {!narrow ? jurisdictionControl : null}
            <LwButton
              onClick={() => {
                const date = new Date(weekAnchor);
                date.setDate(date.getDate() - (rangeMode === 'day' ? 1 : 7));
                setWeekAnchor(date);
              }}
             aria-label="Previous period" className="lw-hearings-date-prev">
              Previous
            </LwButton>
            <LwButton className="lw-hearings-date-today" onClick={() => setWeekAnchor(new Date())}>Today</LwButton>
            <label>
              Date{' '}
              <input
                type="date"
                aria-label="Calendar date"
                value={anchorDay}
                onChange={(e) => {
                  if (e.target.value) setWeekAnchor(new Date(`${e.target.value}T12:00:00Z`));
                }}
              />
            </label>
            <LwButton
              onClick={() => {
                const date = new Date(weekAnchor);
                date.setDate(date.getDate() + (rangeMode === 'day' ? 1 : 7));
                setWeekAnchor(date);
              }}
             aria-label="Next period" className="lw-hearings-date-next">
              Next
            </LwButton>
            <LwSeg
              ariaLabel="Calendar range"
              options={[
                { id: 'day', label: 'Day' },
                { id: 'week', label: 'Week' },
              ]}
              value={rangeMode}
              onChange={(next) => setRangeMode(next as 'day' | 'week')}
            />
            <label className="lw-hearings-expand">
              <input
                type="checkbox"
                checked={expandedAgenda}
                onChange={(e) => {
                  setExpandedAgenda(e.target.checked);
                  if (e.target.checked) setView('list');
                }}
              />{' '}
              Expand published agendas
            </label>
            {stateCalendar ? (
              <label className="lw-hearings-date-controls__reminder">
                <input
                  type="checkbox"
                  checked={dateOnlyReminder}
                  onChange={(e) => setDateOnlyReminder(e.target.checked)}
                />{' '}
                Include date-only reminders
              </label>
            ) : null}
            <LwButton
              className="lw-hearings-date-controls__export"
              disabled={
                exportWeek.isPending ||
                calendar.isError ||
                (privateSelection && !folderSelection.isSuccess)
              }
              onClick={() =>
                exportWeek.mutate(
                  { ...calendarSelection, dateOnlyReminder },
                  { onSuccess: downloadIcs },
                )
              }
            >
              {exportWeek.isPending ? 'Preparing…' : 'Export calendar'}
            </LwButton>
          </div>
          {/* Calendar timezone indicator: proceedings are bucketed by Eastern calendar day */}
          <span
            className="lw-hearings-date-controls__tz"
            aria-label="Calendar timezone: Eastern (ET)"
            title="Proceedings are organised by their official Eastern (ET) calendar day"
          >
            ET
          </span>
        </>
      ) : null}
      {exportWeek.isError ? (
        <p role="alert">Calendar export failed. Refresh the selection and try again.</p>
      ) : null}
      {exportWeek.data ? (
        <p role="status">
          Exported {exportWeek.data.includedCount} events.
          {exportWeek.data.skipped.length
            ? ` ${exportWeek.data.skipped.length} events were skipped: ${exportWeek.data.skipped.map((s) => s.reason).join('; ')}`
            : ''}
        </p>
      ) : null}
      <div
        className={sub === 'sessions' ? 'lw-hearings-cols lw-hearings-cols--single' : 'lw-schedule'}
      >
        {/* Schedule sub-view is full-width (the calendar runs the whole content
            width). The Sessions sub-view keeps the two-column rail. */}
        {sub === 'sessions' ? null : calendar.isLoading ? (
          <div
            className="lw-card"
            style={{ padding: 18 }}
            role="status"
            aria-label="Loading hearing schedule"
          >
            <LwSkeleton height={32} />
            <LwSkeleton height={206} delay={2} />
          </div>
        ) : calendar.isError ? (
          <LwStateUnavailable
            source="Hearing schedule"
            reason="The committee calendar could not be loaded for this week. Saved capture sessions and source health are shown separately."
            onRetry={() => void calendar.refetch()}
          />
        ) : (
          <div className="lw-schedule">
            {!narrow ? (
              <div className="lw-controls">
                <LwSeg
                  ariaLabel="Schedule view"
                  options={[
                    { id: 'calendar' as ViewMode, label: 'Calendar' },
                    { id: 'list' as ViewMode, label: 'Agenda' },
                  ]}
                  value={effectiveView}
                  onChange={setView}
                />
                {scheduleToolbar}
              </div>
            ) : null}

            {effectiveView === 'calendar' && !(stateCalendar && rangeMode === 'day') ? (
              <section className="lw-card lw-cal" aria-label="Week calendar">
                <div className="lw-card__head">
                  <button
                    className="lw-navbtn"
                    aria-label="Previous week"
                    onClick={() => {
                      const d = new Date(weekAnchor);
                      d.setDate(d.getDate() - 7);
                      setWeekAnchor(d);
                    }}
                  >
                    <ChevronLeft size={15} aria-hidden="true" />
                  </button>
                  <button
                    className="lw-navbtn"
                    aria-label="Next week"
                    onClick={() => {
                      const d = new Date(weekAnchor);
                      d.setDate(d.getDate() + 7);
                      setWeekAnchor(d);
                    }}
                  >
                    <ChevronRight size={15} aria-hidden="true" />
                  </button>
                  <span className="lw-weeklabel">
                    {formatHearingDay(parseHearingMoment({ date: weekDays[0] ?? '' }))} –{' '}
                    {formatHearingDay(parseHearingMoment({ date: weekDays[6] ?? '' }))}
                  </span>
                  <span className="lw-card__meta">
                    {/* Honest header (LW-QA-005 review item E): the count is the
                      server total for the visible range (bounded by the first
                      page), and the secondary count is subscriptions scheduled
                      by the user — never implied to be "matches". */}
                    {visibleCount} proceedings ·{' '}
                    {!liveOnly && serverTotal > rows.length
                      ? `showing first ${rows.length}`
                      : `${totalMatches0(filtered)} scheduled by you`}
                  </span>
                </div>

                {floridaEmptyRangeNotice}

                <div className="lw-cal__grid">
                  {weekDays.map((day, i) => {
                    const list = byDay.get(i) ?? [];
                    const isToday = sameDay(new Date(), parseEasternUTC(day));
                    return (
                      <div key={day} className={`lw-cal__day${isToday ? ' is-today' : ''}`}>
                        <div className="lw-cal__dayhead">
                          <span className="lw-cal__weekday">{WEEKDAY[i]}</span>
                          <span className="lw-cal__date">{Number(day.slice(8, 10))}</span>
                        </div>
                        {list.length === 0 ? (
                          <span className="lw-cal__empty">
                            {stateCalendar ? 'No matching published events' : 'No proceedings'}
                          </span>
                        ) : (
                          list.map((e) => {
                            const isLive = isLiveEvent(e);
                            const { capability: cap, closed } = canonicalCapability(e);
                            const queued = e.capture?.status === 'scheduled';
                            const kindCls = closed
                              ? 'lw-chip--unavailable'
                              : isLive
                                ? 'lw-chip--live'
                                : (e.eventType ?? 'HEARING').toUpperCase() === 'MARKUP'
                                  ? 'lw-chip--markup'
                                  : 'lw-chip--hearing';
                            const m = momentOfCanonicalEvent(e);
                            return (
                              <button
                                key={e.id}
                                type="button"
                                className={`lw-chip ${kindCls}`}
                                onClick={() => openHearing(e)}
                                aria-label={`${e.title}, ${e.committee?.name ?? ''}, ${formatHearingTime(m)}`}
                              >
                                <span className="lw-chip__row">
                                  <span className="lw-chip__time">{formatHearingTime(m)}</span>
                                  {isLive || queued ? (
                                    <span
                                      className="lw-chip__marker"
                                      style={{
                                        background: isLive
                                          ? 'var(--lw-error-dot)'
                                          : 'var(--lw-brand-dot)',
                                      }}
                                      aria-hidden="true"
                                    />
                                  ) : null}
                                </span>
                                <span className="lw-chip__title">{e.title}</span>
                                <span className="lw-chip__meta">
                                  {e.committee?.name ?? ''}
                                  {closed ? ' · CLOSED SESSION' : ''}
                                </span>
                              </button>
                            );
                          })
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="lw-cal__legend">
                  <span className="lw-legend__item">
                    <span
                      className="lw-legend__dot"
                      style={{ background: 'var(--lw-error-dot)' }}
                    />
                    Live now
                  </span>
                  <span className="lw-legend__item">
                    <span
                      className="lw-legend__dot"
                      style={{ background: 'var(--lw-brand-dot)' }}
                    />
                    Hearing
                  </span>
                  <span className="lw-legend__item">
                    <span className="lw-legend__dot" style={{ background: 'var(--lw-faint)' }} />
                    Markup
                  </span>
                  <span className="lw-legend__item">
                    <span
                      className="lw-legend__dot"
                      style={{ background: 'var(--lw-warn-ring)' }}
                    />
                    Access unverified
                  </span>
                  <span className="lw-legend__item">
                    <span
                      className="lw-legend__dot"
                      style={{ background: 'var(--lw-brand-dot)' }}
                    />
                    Capiro attending
                  </span>
                </div>
              </section>
            ) : (
              <section className="lw-card" aria-label="Schedule list">
                <div className="lw-card__head">
                  <h2 className="lw-card__title">
                    {stateCalendar
                      ? `Schedule — ${rangeFrom}${rangeTo !== rangeFrom ? ` to ${rangeTo}` : ''}`
                      : 'Schedule — this week'}
                  </h2>
                  <span className="lw-card__meta">{visibleCount} proceedings</span>
                </div>
                {floridaEmptyRangeNotice}
                {filtered.length === 0 ? (
                  <div style={{ padding: 18 }}>
                    <LwStateEmpty
                      title={
                        liveOnly
                          ? 'No proceedings are live in this range'
                            : committee || kind || search
                            ? 'No proceedings matched your filters — try clearing the search or filter'
                            : 'No proceedings matched these filters'
                      }
                      onReset={() => {
                        setCommittee('');
                        setKind('');
                        setSearch('');
                        setCalendarParam('live', '');
                      }}
                    />
                  </div>
                ) : (
                  filtered.map((e) => {
                    const isLive = isLiveEvent(e);
                    const m = momentOfCanonicalEvent(e);
                    const { capability: cap, closed, reason } = canonicalCapability(e);
                    const queued = e.capture?.status === 'scheduled';
                    const verb =
                      e.geographicJurisdiction && e.geographicJurisdiction !== 'US'
                        ? 'OPEN AGENDA'
                        : isLive
                          ? 'OPEN LIVE ROOM'
                          : queued
                            ? 'RECORDING SCHEDULED'
                            : closed
                              ? 'CLOSED SESSION'
                              : cap === 'unavailable'
                                ? 'RECORDING UNAVAILABLE'
                                : 'VIEW DETAIL';
                    return (
                      <div key={e.id} className={`lw-lrow${isLive ? ' is-live' : ''}`}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <button
                            type="button"
                            className="lw-lrow__main"
                            style={{
                              textAlign: 'left',
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              width: '100%',
                            }}
                            onClick={() => openHearing(e)}
                            aria-label={`Open ${e.title}`}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                flexWrap: 'wrap',
                              }}
                            >
                              <span className="lw-lrow__when">
                                {formatHearingDay(m).toUpperCase()} · {formatHearingTime(m)}
                              </span>
                              <LwPill
                                tone={
                                  KIND_TONE[(e.eventType ?? 'HEARING').toUpperCase()] ?? 'brand'
                                }
                                size="22"
                              >
                                {(e.eventType ?? 'HEARING').toUpperCase()}
                              </LwPill>
                              {e.committee?.systemCode ? (
                                <button
                                  type="button"
                                  className="lw-lrow__cm"
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    padding: 0,
                                    cursor: 'pointer',
                                    textDecoration: 'underline dotted',
                                  }}
                                  onClick={(ev) => {
                                    ev.stopPropagation();
                                    navigate(
                                      `/legiwatch/committees/${encodeURIComponent(e.committee!.systemCode!)}`,
                                    );
                                  }}
                                >
                                  {e.committee.name}
                                </button>
                              ) : (
                                <span className="lw-lrow__cm">{e.committee?.name ?? ''}</span>
                              )}
                            </div>
                            <div className="lw-lrow__title">{e.title}</div>
                            <div className="lw-lrow__match">
                              {closed
                                ? reason
                                : captureSummaryLabel(e).toUpperCase()}
                            </div>
                          </button>
                          {stateCalendar ? (
                            <div style={{ padding: '10px 0' }}>
                              <p className="lw-card__meta">
                                {e.eventStatus} · {e.following ? 'Following' : 'Not followed'} ·{' '}
                                {e.calendarCheckState === 'complete'
                                  ? 'Source checked'
                                  : 'Source check incomplete'}
                              </p>
                              {expandedAgenda ? (
                                e.agenda?.length ? (
                                  <ol style={{ paddingLeft: 22 }}>
                                    {[...e.agenda]
                                      .sort((a, b) => a.position - b.position)
                                      .map((item) => (
                                        <li key={item.key}>
                                          {item.bill ? (
                                            <Link to={`/bills/${encodeURIComponent(item.bill.id)}`}>
                                              {item.title}
                                            </Link>
                                          ) : (
                                            item.title
                                          )}
                                          {item.bill &&
                                          folderSelection.data?.billIds.includes(item.bill.id)
                                            ? ' · In selected folders'
                                            : ''}
                                          {item.kind === 'unresolved_bill'
                                            ? ' · Bill reference awaiting resolution'
                                            : ''}
                                        </li>
                                      ))}
                                  </ol>
                                ) : (
                                  <p>
                                    Published agenda unavailable. Open the hearing to check its
                                    source notice.
                                  </p>
                                )
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                        <div className="lw-lrow__side">
                          <LwPill
                            tone={
                              closed
                                ? 'gray'
                                : cap === 'unavailable'
                                  ? 'gray'
                                  : cap === 'pending'
                                    ? 'warning'
                                    : 'success'
                            }
                            size="26"
                          >
                            {closed
                              ? 'CLOSED'
                              : cap === 'direct' || cap === 'browser'
                                ? 'AVAILABLE'
                                : cap.toUpperCase()}
                          </LwPill>
                          <button
                            type="button"
                            className="lw-lrow__verb"
                            onClick={() => openHearing(e)}
                          >
                            {closed ? 'DETAILS →' : `${verb} →`}
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </section>
            )}
          </div>
        )}

        {/* Recording and saved-session panels belong to the Recordings tab. */}
        {sub === 'sessions' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <section className="lw-card" aria-label="Recordings">
            <div className="lw-card__head">
              <h2 className="lw-card__title">Recordings</h2>
              <span className="lw-card__meta">All dates</span>
            </div>
            {/* Durable all-lifecycle server attendance for exactly this
                tenant+user — independent of the selected week and filters. A
                scheduled row appears immediately and stays through completion. */}
            <ServerCaptureSessions />
            <div className="lw-note">
              <div className="lw-note__label">How unattended capture works</div>
              <div className="lw-note__body">
                Automatic attendance records the official stream on the server and continues when
                you leave the site. Open a hearing to check its capture status, transcript and
                intelligence. Browser attendance requires an open tab and an awake device.
              </div>
            </div>
          </section>

          <section className="lw-card" aria-label="Saved recording attempts">
            <div className="lw-card__head">
              <h2 className="lw-card__title">Saved recording attempts</h2>
              <span className="lw-card__meta">Browser and server sessions · separate capture attempts</span>
            </div>

            {!calendar.isError && live ? (
              <div className="lw-session lw-on-ink">
                <span className="lw-session__badge">
                  <span className="lw-session__dot is-live" aria-hidden="true" />
                  LIVE
                </span>
                <div className="lw-session__title">{live.title}</div>
                <div className="lw-session__sub">{live.committee?.name ?? ''}</div>
                <div className="lw-session__actions">
                  <LwButton variant="primary" size="40" onClick={() => openHearing(live)}>
                    Open live room →
                  </LwButton>
                  <LwButton size="40" onClick={() => openHearing(live)}>
                    Details
                  </LwButton>
                </div>
              </div>
            ) : (
              <div style={{ padding: '16px 18px' }}>
                <p className="lw-state__body">
                  {calendar.isLoading
                    ? 'Checking live proceedings in the selected week…'
                    : calendar.isError
                      ? 'Live proceeding status is unavailable for the selected week.'
                      : 'No live proceedings in the selected week and filters.'}
                </p>
              </div>
            )}

            {history.isLoading ? (
              <div className="lw-recs__empty" role="status">
                Checking saved capture sessions…
              </div>
            ) : history.isError ? (
              <LwStateUnavailable
                source="Capture session status"
                reason="Saved session status could not be refreshed. Capture attention is unverified."
                onRetry={() => void history.refetch()}
              />
            ) : (
              <div
                className="lw-state"
                role={interrupted.length ? 'alert' : 'status'}
                style={{ padding: '12px 18px' }}
              >
                {interrupted.length ? <LwPill tone="warning">CAPTURE ATTENTION</LwPill> : null}
                <p className="lw-state__body">
                  {interrupted.length
                    ? `${interrupted.length} interrupted capture${interrupted.length === 1 ? '' : 's'} in loaded session history. Open the affected session below to review saved content and recovery options.`
                    : 'No interrupted captures in loaded session history.'}
                  {history.hasNextPage ? ' Older sessions have not been checked yet.' : ''}
                </p>
              </div>
            )}

            <div className="lw-history__label">Recent session history · {visibleSessions.length} of {sessions.length} loaded</div>
            <div className="lw-controls" aria-label="Filter saved recording attempts">
              <input className="lw-input" aria-label="Search recording attempts" placeholder="Search recordings" value={sessionSearch} onChange={(event) => setSessionSearch(event.target.value)} />
              <select className="lw-select" aria-label="Recording attempt status" value={sessionLifecycle} onChange={(event) => setSessionLifecycle(event.target.value)}>
                <option value="all">All attempts</option><option value="completed">Completed attempts</option><option value="other">Active or interrupted attempts</option>
              </select>
              <label><input type="checkbox" checked={hideTestSessions} onChange={(event) => setHideTestSessions(event.target.checked)} /> Hide titles marked test or QA</label>
            </div>
            {sessions.length > 0 && !visibleSessions.length ? <p className="lw-card__meta">No loaded attempts match these filters. Clear the filters or load older sessions.</p> : null}
            <div className="lw-history__rows">
              {visibleSessions.map((s) => {
                const rec = captureNeedsAttention(s.status);
                const resumable = s.status === 'failed-recoverable';
                const done = ['completed', 'ended'].includes(s.status);
                const browserSession = ['browser_mic', 'browser_tab'].includes(s.audioSource);
                const path =
                  s.hearingId && !browserSession
                    ? `/legiwatch/hearings/${encodeURIComponent(s.hearingId)}`
                    : `/intelligence/hearing-watch/${encodeURIComponent(s.id)}`;
                return (
                  <div
                    key={s.id}
                    className="lw-hrow"
                    role="button"
                    tabIndex={0}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(path)}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter' || ev.key === ' ') {
                        ev.preventDefault();
                        navigate(path);
                      }
                    }}
                    aria-label={`Open ${s.title}`}
                  >
                    <div>
                      <div className="lw-hrow__title"><ExpandableHearingTitle title={s.title} /></div>
                      <div className="lw-hrow__sub">
                        {done
                          ? 'Completed'
                          : resumable
                            ? 'Capture interrupted · can resume'
                            : rec
                              ? 'Capture failed · review saved session'
                              : s.status}
                        {s.watchlistMatchCount != null ? ` · ${s.watchlistMatchCount} matches` : ''}
                        {' · '}{recordingAttemptDate(s.startedAt)}
                        {' · '}{browserSession ? 'Browser recording' : 'Server session'}
                        {s.recordingPolicy === 'transcript_only' ? ' · Transcript only; audio not retained' : ''}
                        <span style={{ display: 'block' }}>Attempt {s.id.slice(-8)} · {s.hearingId ? 'Linked to a hearing' : 'Hearing link not established'}</span>
                      </div>
                    </div>
                    <span className="lw-hrow__pill">
                      <LwPill tone={rec ? 'warning' : done ? 'success' : 'gray'}>
                        {resumable
                          ? 'RECOVERABLE'
                          : rec
                            ? 'NEEDS REVIEW'
                            : done
                              ? s.recapSaved
                                ? 'RECAP READY'
                                : 'COMPLETE'
                              : s.status.toUpperCase()}
                      </LwPill>
                    </span>
                  </div>
                );
              })}
              {!history.isLoading && !history.isError && sessions.length === 0 ? (
                <div className="lw-recs__empty">
                  No sessions yet. Start capture from the schedule.
                </div>
              ) : null}
              {history.hasNextPage ? (
                <LwButton
                  disabled={history.isFetchingNextPage}
                  onClick={() => void history.fetchNextPage()}
                >
                  {history.isFetchingNextPage
                    ? 'Loading older sessions…'
                    : 'Check older capture sessions'}
                </LwButton>
              ) : null}
            </div>
          </section>

        </div>
        ) : null}
        {/* Florida legal dates are supplemental research reminders. Keep the
            shared proceedings calendar/agenda as the primary schedule surface,
            then expose the source-stated dates after it rather than inserting
            an unbounded notice list between the filters and calendar. */}
        {sub === 'schedule' && jurisdiction === 'FL' && dateOnlyReminder ? (
          <LegalDeadlineOverlay
            from={rangeFrom}
            to={rangeTo}
            clientId={clientId || undefined}
            folderId={selectedFolders.length === 1 ? selectedFolders[0] : undefined}
          />
        ) : null}
        {sub === 'schedule' ? <CommitteeSourceStatus /> : null}
        {jurisdiction !== 'US' && sub === 'schedule' ? (
        <section
          className="lw-card"
          aria-label="Florida source coverage"
          style={{ padding: 16, marginBottom: 12 }}
        >
          <details
            className="lw-hearings-source-health"
            open={sourceCoverage.isError || floridaCoverage === 'failed'}
          >
            <summary className="lw-card__title">
              Florida calendar checks · {FLORIDA_COVERAGE_LABEL[floridaCoverage]}{' '}
              <span>View details</span>
            </summary>
            <div className="lw-hearings-source-health__body">
              <h2 className="sr-only">Florida committee source coverage details</h2>
          {sourceCoverage.isError ? (
            <p role="alert">
              Source coverage could not be checked.{' '}
              <button onClick={() => void sourceCoverage.refetch()}>Retry</button>
            </p>
          ) : sourceCoverage.isPending ? (
            <p role="status">Checking source coverage…</p>
          ) : (
            ['house', 'senate'].map((chamber) => {
              const source = sourceCoverage.data?.rows?.find(
                (row) => row.chamber.toLowerCase() === chamber,
              );
              const asOf = Date.parse(sourceCoverage.data?.asOf ?? '');
              const referenceTime = Number.isFinite(asOf) ? asOf : Date.now();
              const checkedAt = source ? Date.parse(source.checkedAt) : Number.NaN;
              const age = referenceTime - checkedAt;
              const fresh =
                source &&
                Number.isFinite(checkedAt) &&
                age >= -FLORIDA_COVERAGE_CLOCK_SKEW_MS &&
                age < FLORIDA_COVERAGE_FRESH_MS;
              const coversRange =
                source?.from &&
                source.to &&
                source.from <= rangeFrom &&
                source.to >= rangeTo;
              const sessionIssue = source?.details?.issues?.some((issue) => /session/i.test(issue));
              const status = source
                ? source.status === 'failed'
                  ? 'Failed check'
                  : source.status === 'attempted' && fresh
                    ? 'Source check in progress; result pending.'
                  : source.status === 'partial' && fresh
                  ? sessionIssue
                    ? 'Notice found, session unresolved'
                    : 'Partial check'
                  : source.status === 'complete' && fresh && coversRange
                    ? 'Source checked'
                    : !fresh
                      ? 'Stale check'
                      : 'No source check covers this full date selection.'
                : 'No source check covers this full date selection.';
              return (
                <div key={chamber}>
                  <p className="lw-card__meta">
                    {chamber === 'house' ? 'House' : 'Senate'} · {status}
                    {source && source.status !== 'attempted' ? ` · ${source.details?.found ?? source.items} of ${source.details?.expected ?? 'unknown'} notices found` : ''}
                  </p>
                  {source ? <p className="lw-card__meta">{source.status === 'attempted' ? 'Check started' : 'Last check'}: {new Date(source.checkedAt).toLocaleString()}</p> : null}
                  {source?.details?.issues?.length ? (
                    <p className="lw-card__meta">Technical issue: {source.details.issues.join('; ')}</p>
                  ) : null}
                </div>
              );
            })
          )}
              <p className="lw-card__meta">
                Published notices can change. Missing coverage does not establish that no proceeding is
                scheduled.
              </p>
            </div>
          </details>
        </section>
      ) : null}
      </div>
    </div>
  );
}

function captureNeedsAttention(status: string): boolean {
  return status === 'failed-recoverable' || status === 'failed';
}

/** Source ingestion is independent of live rows, watchlist matches and capture. */
function CommitteeSourceStatus() {
  const coverage = useLiveHearingsCoverage();
  const summary = coverage.data?.summary;
  const failing =
    coverage.data?.sources.filter((source) => source.sourceHealth === 'failing') ?? [];
  return (
    <section className="lw-card" aria-label="Committee source health">
      <div className="lw-card__head">
        <h2 className="lw-card__title">Committee source health</h2>
        <LwButton disabled={coverage.isFetching} onClick={() => void coverage.refetch()}>
          {coverage.isFetching ? 'Refreshing source status…' : 'Refresh source status'}
        </LwButton>
      </div>
      {coverage.isLoading ? (
        <div className="lw-recs__empty" role="status">
          Checking committee source health…
        </div>
      ) : coverage.isError ? (
        <LwStateUnavailable
          source="Committee source health"
          reason="Source status could not be refreshed. Current ingestion health is unverified."
        />
      ) : !summary || summary.total === 0 ? (
        <div className="lw-state" role="status">
          <LwPill tone="gray">SOURCE STATUS UNKNOWN</LwPill>
          <p className="lw-state__body">
            No registered source-health records are available. Complete coverage is unverified.
          </p>
        </div>
      ) : (
        <div className="lw-state" role={summary.failing > 0 ? 'alert' : 'status'}>
          <LwPill
            tone={
              summary.failing > 0 ? 'error' : summary.healthy < summary.total ? 'warning' : 'gray'
            }
          >
            {summary.failing > 0
              ? 'SOURCE FAILURES'
              : summary.healthy < summary.total
                ? 'SOURCE HEALTH PARTIAL'
                : 'REGISTERED SOURCE STATUS'}
          </LwPill>
          <p className="lw-state__body">
            {summary.healthy} of {summary.total} registered committee sources report healthy.{' '}
            {summary.degraded} degraded · {summary.failing} failing · {summary.unknown} unknown.
          </p>
          {failing.length ? (
            <p className="lw-state__body">
              Failing:{' '}
              {failing
                .map(
                  (source) =>
                    source.committeeName ?? source.committeeSystemCode ?? source.sourceUrl,
                )
                .join('; ')}
              .
            </p>
          ) : null}
          <p className="lw-state__body">
            Registered source health does not establish complete coverage of every committee
            calendar or proceeding.
            {coverage.dataUpdatedAt
              ? ` Status retrieved ${new Date(coverage.dataUpdatedAt).toLocaleString()}.`
              : ''}
          </p>
        </div>
      )}
    </section>
  );
}

/** `YYYY-MM-DD` → local Date at midnight (parts-parsed, no UTC shift). */
function parseEasternUTC(day: string): Date {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  return new Date(y, m - 1, d);
}

const WEEKDAY = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

function totalMatches0(rows: CanonicalHearingEvent[]): number {
  return rows.filter((e) => e.subscription?.scheduled ?? false).length;
}
