/**
 * vNext Meetings workspace — Engagement navy reskin (Meetings phase, 2026-08-16).
 *
 * A genuinely new surface, not a re-skin of the canonical `MeetingsV2` /
 * `MeetingRow` / `MonthView` components: the gaps this phase closes (toolbar
 * controls unified into one row, rounded meeting-row cards instead of a flat
 * bordered list, a 1-chip month cell cap instead of 3, a gradient selected
 * view-segment) are real layout changes that would visibly alter
 * app.capiro.ai's canonical Meetings page if made there — out of scope for
 * this vNext-only fork. See the architecture note in the phase brief.
 *
 * Reused as-is (canonical data layer + generic primitives, none of it
 * Meetings-page-specific layout):
 *   - meetings-api.ts — useMeetings/useMeeting/meetingsListKey (real queries,
 *     real cache invalidation).
 *   - meetings-types.ts — Meeting and the completedPrep/completedDebrief/
 *     approvedDebrief helpers that already encode the product's prep/debrief
 *     completion semantics (spec §2.3/§j) — not reinvented here.
 *   - meetings-format.ts — startOfWeek/dayKey/formatters. startOfWeek in
 *     particular is the general-purpose Monday-start math the design README
 *     itself says to use instead of the prototype's hardcoded August-1965-is-
 *     a-Saturday hack (§6.3).
 *   - EngagementDialog — the shared, already-vNext-token-based modal shell
 *     VNextOutreachWorkspace already uses for its own dialogs (focus trap,
 *     Escape, scroll lock, dirty-confirm) — reused for the minimal New
 *     Meeting composer rather than hand-rolling another modal shell.
 *
 * URL contract: view mode, cursor date, and selected meeting id round-trip
 * through `view` / `date` / `meeting` query params — the SAME param names
 * `engagement-route-state.ts`'s `canonicalEngagementLocation` already
 * normalizes legacy links onto (verified against its passing test file,
 * engagement-route-state.test.ts — the design README's internal state table
 * calls the selection param `sel`, but that table documents the design
 * PROTOTYPE's own template-runtime variable names, which the README
 * explicitly says not to port; the already-shipped, tested code contract
 * uses `meeting`, so this file follows the code, not the prototype's naming).
 * `tab` rounds through the same contract, now owned here: the drawer phase
 * mounts the real MeetingDetailPanel (canonical, reused — not forked; see
 * drawer-vnext.css for the CSS-only navy retheme and PrepTab/NotesTab/
 * DebriefTab/tab-kit.tsx for the structural completions) and this component
 * is what actually reads/writes `tab` now, same "only serialize non-default"
 * minimalism the canonical EngagementPage.tsx uses for its own `detail` param.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  Archive,
  Calendar,
  ChevronLeft,
  ChevronRight,
  CircleSlash2,
  History,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useApi } from '../../../lib/use-api.js';
import { EngagementDialog } from '../../../pages/engagement/meetings/EngagementDialog.js';
import { MeetingDetailPanel } from '../../../pages/engagement/meetings/MeetingDetailPanel.js';
// The drawer tree (MeetingDetailPanel + tabs + ShareConfirmation) is the
// canonical implementation, reused — but its confirm/toast chrome is injected
// per surface, and on this surface it must be vNext primitives, never AntD:
// VNextMeetingPanelChrome provides EngagementDialog confirms + Capiro toasts.
// SendMeriModal is the one drawer sibling that is STRUCTURALLY AntD (an AntD
// Form), so this surface renders its vNext rebuild instead.
import { ShareConfirmation } from '../../../pages/engagement/meetings/ShareConfirmation.js';
import { VNextMeetingPanelChrome } from './VNextMeetingPanelChrome.js';
import { VNextSendMeriModal } from './VNextSendMeriModal.js';
import { meetingsListKey, useMeeting, useMeetings } from '../../../pages/engagement/meetings/meetings-api.js';
import { useEngagementCalendarSync } from './use-engagement-calendar-sync.js';
import { meetingStatus } from '../../../pages/engagement/meetings/meetings-ui.js';
import {
  approvedDebrief,
  completedDebrief,
  completedPrep,
  isCancelledMeeting,
  type DetailTab,
  type Meeting,
  type MeetingViewMode,
} from '../../../pages/engagement/meetings/meetings-types.js';
import {
  addDays,
  calendarToday,
  meetingDateTimeToIso,
  meetingQueryRange,
  dayKey,
  formatDateShort,
  formatDayHeader,
  formatDayTitle,
  formatMonthTitle,
  formatTime,
  formatWeekRange,
  formatWeekdayShort,
  isAllDayMeeting,
  isSameDay,
  isToday,
  localDateFromKey,
  meetingDayKey,
  providerLabel,
  startOfMonth,
  startOfWeek,
} from '../../../pages/engagement/meetings/meetings-format.js';
import { useEngagementToast } from './engagement-toast.js';
import './meetings-vnext.css';
import './drawer-vnext.css';

export interface VNextMeetingsWorkspaceProps {
  clientId: string | null;
  /**
   * Human name for `clientId`, resolved by the caller from the client list it
   * already holds. Passed in rather than re-queried: a new meeting inherits the
   * page's client scope, and the composer has to be able to NAME what it is
   * inheriting instead of alluding to "the current client scope above".
   */
  clientLabel?: string | null;
}

const VIEW_OPTIONS: Array<{ key: MeetingViewMode; label: string }> = [
  { key: 'day', label: 'Day' },
  { key: 'list', label: 'List' },
  { key: 'month', label: 'Month' },
];

const WEEKDAY_HEADS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Each click widens the fetched window by this many days, capped so a
 *  distracted user can't accidentally request years of history in one tab. */
const HISTORY_STEP_DAYS = 14;
const MAX_HISTORY_BATCHES = 6;

function parseViewMode(raw: string | null): MeetingViewMode | null {
  return raw === 'day' || raw === 'list' || raw === 'month' ? raw : null;
}

function parseDetailTab(raw: string | null): DetailTab | null {
  return raw === 'prep' || raw === 'notes' || raw === 'debrief' ? raw : null;
}

/** The best default detail tab for a freshly opened meeting — ported from the
 *  canonical MeetingsV2.tsx's own bestDetailTab() (not exported there, so
 *  duplicated here rather than reaching into a sibling app's private helper):
 *  debrief if already done, else notes if captured, else prep. Only applied
 *  when a genuinely NEW meeting is opened (see selectMeeting below) — it
 *  never clobbers an explicit `?tab=` deep link or a manual tab change. */
function bestDetailTab(m: Meeting): DetailTab {
  const status = meetingStatus(m);
  if (status.debrief) return 'debrief';
  if (
    m.notesApproved ||
    m.meri === 'done' ||
    m.meri === 'attended' ||
    (m.notes && m.notes.length > 0)
  ) {
    return 'notes';
  }
  return 'prep';
}

type LifecycleTone = 'navy' | 'gray' | 'warn';
interface LifecycleStatus {
  label: string;
  tone: LifecycleTone;
}

/**
 * Maps a real Meeting onto ONE of the 8 status keys in the design README's
 * §2.3 table (prep-approved / meri-attending / prepped / debrief-complete /
 * internal / generate-prep / needs-prep / debrief-missing) — the README gives
 * the label→tone table but not the business logic for which meeting state
 * produces which key, so the priority order below is this phase's own
 * judgment call, built entirely from real fields (isInternal, meri,
 * preps[0].status, the completedPrep/completedDebrief/approvedDebrief
 * helpers, endsAt vs now) — never fabricated. Internal meetings short-circuit
 * to `internal` since they sit
 * outside the prep/debrief workflow entirely; debrief-complete and
 * meri-attending take priority over prep states because they're more
 * time-sensitive/definitive; a past meeting with no debrief surfaces as a
 * warning; a future meeting defaults to needs-prep.
 */
function meetingLifecycleStatus(m: Meeting): LifecycleStatus {
  if (isCancelledMeeting(m)) return { label: 'Cancelled', tone: 'gray' };
  if (m.isInternal) return { label: 'Internal', tone: 'gray' };
  if (approvedDebrief(m) || completedDebrief(m)) return { label: 'Debrief complete', tone: 'navy' };
  if (m.meri === 'attending') return { label: 'Meri attending', tone: 'navy' };

  const prep = m.preps[0] ?? null;
  if (prep?.status === 'approved') return { label: 'Prep approved', tone: 'navy' };
  if (completedPrep(m)) return { label: 'Prepped', tone: 'navy' };

  const isPast = new Date(m.endsAt).getTime() < Date.now();
  if (isPast) return { label: 'Debrief not completed', tone: 'warn' };
  if (prep?.status === 'failed') return { label: 'Generate prep', tone: 'warn' };
  return { label: 'Needs prep', tone: 'warn' };
}

/** UI-parity §4.4: `Client · Place · N attendees`. The client segment comes
 *  from the Meeting payload's own `client` ref — never inferred. */
function metaLine(m: Meeting, clientName?: string | null): string {
  const parts: string[] = [];
  if (clientName) parts.push(clientName);
  if (m.location) parts.push(m.location);
  if (m.isVirtual) {
    const label = providerLabel(m.provider);
    if (label) parts.push(label);
  }
  if (m.attendees.length > 0) {
    parts.push(`${m.attendees.length} attendee${m.attendees.length === 1 ? '' : 's'}`);
  }
  return parts.join(' · ');
}

/** The soonest-relevant meeting of a (chronologically pre-sorted) day's
 *  meetings, for the month cell's single chip — the first one still ahead of
 *  now, or the day's earliest if every meeting that day has already passed. */
function pickFeaturedMeeting(dayMeetingsSorted: Meeting[]): Meeting | null {
  if (dayMeetingsSorted.length === 0) return null;
  const now = Date.now();
  const upcoming = dayMeetingsSorted.find((m) => new Date(m.startsAt).getTime() >= now);
  return upcoming ?? dayMeetingsSorted[0] ?? null;
}

function StatusPill({ meeting }: { meeting: Meeting }) {
  const status = meetingLifecycleStatus(meeting);
  return (
    <span className={`eng-pill eng-pill--${status.tone} vmtg-row__pill`}>
      <span className="eng-pill__dot" />
      {status.label}
    </span>
  );
}

function WeekStrip({
  cursor,
  meetingsOn,
  onSelectDate,
}: {
  cursor: Date;
  meetingsOn: (d: Date) => Meeting[];
  onSelectDate: (d: Date) => void;
}) {
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i)),
    [cursor],
  );
  return (
    <div className="vmtg-weekstrip">
      {weekDays.map((d) => {
        const count = meetingsOn(d).length;
        const selected = isSameDay(d, cursor);
        return (
          <button
            key={dayKey(d)}
            type="button"
            data-selected={selected || undefined}
            onClick={() => onSelectDate(d)}
          >
            <span className="vmtg-weekstrip__dow">{formatWeekdayShort(d)}</span>
            <span className="vmtg-weekstrip__date">{d.getDate()}</span>
            {/* UI-parity §4.3: the zero glyph is a middot, not an em dash. */}
            <span className="vmtg-weekstrip__count" data-has-meetings={count > 0 || undefined}>
              {count > 0 ? count : '·'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function MonthGrid({
  monthDate,
  meetings,
  selectedMeetingId,
  onSelectMeeting,
  onOpenDay,
}: {
  monthDate: Date;
  meetings: Meeting[];
  selectedMeetingId: string | null;
  onSelectMeeting: (m: Meeting) => void;
  onOpenDay: (d: Date) => void;
}) {
  const gridStart = startOfWeek(startOfMonth(monthDate));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));

  const byDay = new Map<string, Meeting[]>();
  for (const m of meetings) {
    const k = meetingDayKey(m.startsAt, m.endsAt);
    const arr = byDay.get(k) ?? [];
    arr.push(m);
    byDay.set(k, arr);
  }

  return (
    <div className="vmtg-month">
      <div className="vmtg-month__weekdays">
        {WEEKDAY_HEADS.map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="vmtg-month__grid">
        {cells.map((d) => {
          const key = dayKey(d);
          const outside = d.getMonth() !== monthDate.getMonth();
          const dayMeetings = (byDay.get(key) ?? [])
            .slice()
            .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
          const featured = pickFeaturedMeeting(dayMeetings);
          const overflow = dayMeetings.length - (featured ? 1 : 0);
          return (
            <div
              key={key}
              role="button"
              tabIndex={0}
              className="vmtg-month__cell"
              data-outside={outside || undefined}
              data-today={isToday(d) || undefined}
              aria-label={`Open ${d.toDateString()} in Day view`}
              onClick={() => onOpenDay(d)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpenDay(d);
                }
              }}
            >
              <span className="vmtg-month__date">{d.getDate()}</span>
              {featured && (
                <button
                  type="button"
                  className="vmtg-month__chip"
                  title={featured.subject}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectMeeting(featured);
                  }}
                  data-selected={featured.id === selectedMeetingId || undefined}
                >
                  <span className="vmtg-month__chip-dot" />
                  <span className="vmtg-month__chip-text">{featured.subject}</span>
                </button>
              )}
              {overflow > 0 && <span className="vmtg-month__overflow">+{overflow} more</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MeetingRowCard({
  meeting,
  selected,
  onSelect,
}: {
  meeting: Meeting;
  selected: boolean;
  onSelect: (m: Meeting) => void;
}) {
  return (
    <button
      type="button"
      className="vmtg-row"
      data-selected={selected || undefined}
      onClick={() => onSelect(meeting)}
    >
      <span className="vmtg-row__time">
        {isAllDayMeeting(meeting.startsAt, meeting.endsAt)
          ? 'All day'
          : formatTime(meeting.startsAt)}
      </span>
      <span className="vmtg-row__main">
        <span className="vmtg-row__title">{meeting.subject}</span>
        <span className="vmtg-row__meta">
          {metaLine(meeting, meeting.client?.name) || '—'}
        </span>
      </span>
      <StatusPill meeting={meeting} />
    </button>
  );
}

interface NewMeetingInput {
  subject: string;
  dateKey: string;
  startTime: string;
  endTime: string;
  location: string;
  attendeeEmails: string[];
}

/** Splits a free-text attendee box on commas/newlines/semicolons into a
 *  deduped list of plausible email addresses — good enough to seed
 *  MeetingAttendeeInput[] without pretending to be a real contact picker. */
function parseAttendeeEmails(raw: string): string[] {
  const seen = new Set<string>();
  for (const token of raw.split(/[,;\n]/)) {
    const email = token.trim().toLowerCase();
    if (email && /\S+@\S+\.\S+/.test(email)) seen.add(email);
  }
  return Array.from(seen);
}

function NewMeetingModal({
  open,
  defaultDate,
  pending,
  error,
  clientId,
  clientLabel,
  onClose,
  onSave,
}: {
  open: boolean;
  defaultDate: Date;
  pending: boolean;
  error: string | null;
  clientId: string | null;
  clientLabel?: string | null;
  onClose: () => void;
  onSave: (input: NewMeetingInput) => void;
}) {
  const [subject, setSubject] = useState('');
  const [dateKeyValue, setDateKeyValue] = useState(() => dayKey(defaultDate));
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('09:30');
  const [location, setLocation] = useState('');
  const [attendeesRaw, setAttendeesRaw] = useState('');

  // Reset the form to sane defaults every time the modal is (re-)opened,
  // rather than carrying stale values from a previous open/cancel.
  useEffect(() => {
    if (!open) return;
    setSubject('');
    setDateKeyValue(dayKey(defaultDate));
    setStartTime('09:00');
    setEndTime('09:30');
    setLocation('');
    setAttendeesRaw('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const canSave = subject.trim().length > 0 && Boolean(dateKeyValue) && Boolean(startTime) && Boolean(endTime);

  return (
    <EngagementDialog
      open={open}
      eyebrow="Meetings · new"
      title="New meeting"
      width={520}
      busy={pending}
      dirty={subject.trim().length > 0}
      error={error}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="uui-button" disabled={pending} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="uui-button uui-button--primary"
            disabled={pending || !canSave}
            onClick={() =>
              onSave({
                subject: subject.trim(),
                dateKey: dateKeyValue,
                startTime,
                endTime,
                location: location.trim(),
                attendeeEmails: parseAttendeeEmails(attendeesRaw),
              })
            }
          >
            {pending ? 'Saving…' : 'Save meeting'}
          </button>
        </>
      }
    >
      {/*
        The client is INHERITED from the page's client scope and cannot be set
        here — POST /api/engagement/meetings takes the scope's clientId. It used
        to be disclosed only as "client assignment follows the current client
        scope above", which named neither the client nor the consequence. A
        meeting silently filed against the wrong client is not a cosmetic
        problem, so the actual value is stated, with how to change it.
      */}
      <div className="vmtg-scope-notice" data-unscoped={clientId ? undefined : true}>
        <span className="uui-eyebrow">Client</span>
        <strong>{clientId ? (clientLabel ?? 'Selected client') : 'No client · internal meeting'}</strong>
        <p>
          {clientId
            ? 'This meeting will be filed against that client. To file it elsewhere, change the client scope at the top of the page before saving.'
            : 'With no client selected this is saved as an internal meeting. Pick a client in the scope selector at the top of the page to file it against one.'}
        </p>
      </div>

      <div className="engagement-dialog__field-grid">
        <label className="engagement-dialog__field is-full">
          Subject
          <input
            autoFocus
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="e.g. Weekly check-in"
          />
        </label>
        <label className="engagement-dialog__field is-full">
          Date
          <input
            type="date"
            value={dateKeyValue}
            onChange={(event) => setDateKeyValue(event.target.value)}
          />
        </label>
        <label className="engagement-dialog__field">
          Start time
          <input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} />
        </label>
        <label className="engagement-dialog__field">
          End time
          <input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} />
        </label>
        {/*
          EM-10 — these two fields used to not exist at all: the create form
          exposed only Subject/Date/Start/End, so every manually created
          meeting was born "In person, Attendees · 0, No join link" with no
          way to complete the record at creation time (an edit path exists
          separately now — see MeetingDetailPanel.tsx's EditManualMeetingControl
          — but capturing this up front avoids ever creating the bare record
          in the first place). Location doubles as the join-link field: a
          pasted Zoom/Teams/Meet URL here makes the meeting Meri-eligible
          (deriveMeetingVirtuality, engagement.service.ts's createMeeting).
        */}
        <label className="engagement-dialog__field is-full">
          Location or join link
          <input
            value={location}
            onChange={(event) => setLocation(event.target.value)}
            placeholder="e.g. Conference Room B, or a Zoom/Teams/Meet link"
          />
          <small>Pasting a virtual meeting link here makes this meeting eligible for Meri.</small>
        </label>
        <label className="engagement-dialog__field is-full">
          Attendees
          <textarea
            rows={2}
            value={attendeesRaw}
            onChange={(event) => setAttendeesRaw(event.target.value)}
            placeholder="Email addresses, separated by commas or new lines"
          />
          <small>Optional — attendees can also be added by editing the meeting after it's saved.</small>
        </label>
      </div>
    </EngagementDialog>
  );
}

export function VNextMeetingsWorkspace({ clientId, clientLabel }: VNextMeetingsWorkspaceProps) {
  const api = useApi();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const toast = useEngagementToast();

  const [viewMode, setViewMode] = useState<MeetingViewMode>('day');
  const [cursor, setCursor] = useState<Date>(() => calendarToday());
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  // The drawer's active tab — owned here (not by MeetingDetailPanel, which is
  // fully controlled) and round-tripped through the `tab` URL param, the same
  // contract `meeting`/`view`/`date` already use. Phase 1a read this param
  // only to pass it through untouched on writes; this phase is the one that
  // actually owns it now that the real drawer is mounted.
  const [activeTab, setActiveTab] = useState<DetailTab>('prep');
  const [historyBatch, setHistoryBatch] = useState(0);
  useEffect(() => setHistoryBatch(0), [clientId]);
  const [newMeetingOpen, setNewMeetingOpen] = useState(false);
  // `?compose=meeting` opens the create-meeting window on arrival, so the
  // post-send "Create meeting" action in Outreach lands on a real composer
  // instead of merely dropping the user on the calendar. The param is consumed
  // immediately (replace, not push) so refresh and Back do not re-open it.
  // Mirrors the canonical EngagementPage.tsx contract (line ~1213).
  useEffect(() => {
    if (searchParams.get('compose') !== 'meeting') return;
    const next = new URLSearchParams(searchParams);
    next.delete('compose');
    navigate(
      { pathname: '/engagement/meetings', search: next.toString() ? `?${next.toString()}` : '' },
      { replace: true },
    );
    setNewMeetingOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  // Targets for the drawer's two sibling modals — same pattern as the
  // canonical MeetingsV2.tsx: MeetingDetailPanel only calls onSendMeri /
  // onRequestShare, it doesn't own either modal itself.
  const [sendMeriTarget, setSendMeriTarget] = useState<Meeting | null>(null);
  const [shareTarget, setShareTarget] = useState<Meeting | null>(null);

  // Same capabilities probe as the canonical EngagementPage.tsx (identical
  // query key, so the two pages share one cache entry) — the drawer's
  // Generate/Regenerate controls need to know whether AI is actually
  // configured rather than assuming it always is.
  const capabilities = useQuery<{ ai: { activeProvider: 'openai' | 'anthropic' | null } }>({
    queryKey: ['engagement-capabilities'],
    queryFn: async () =>
      (await api.get<{ ai: { activeProvider: 'openai' | 'anthropic' | null } }>(
        '/api/engagement/capabilities',
      )).data,
  });
  const aiConfigured = Boolean(capabilities.data?.ai?.activeProvider);

  // Same durable URL⇄state pattern as the canonical EngagementPage.tsx (two
  // guarded effects: URL→state and state→URL, each skipping the other's own
  // write via a ref) — scoped down to just this surface's three params.
  const syncingFromUrlRef = useRef(false);
  const lastProcessedUrlRef = useRef('');

  useEffect(() => {
    const urlKey = searchParams.toString();
    if (lastProcessedUrlRef.current === urlKey) return;
    lastProcessedUrlRef.current = urlKey;

    const nextView = parseViewMode(searchParams.get('view'));
    const nextDateKey = searchParams.get('date');
    const nextMeeting = searchParams.get('meeting');
    const nextTab = parseDetailTab(searchParams.get('tab'));
    const currentCursorKey = dayKey(cursor);

    const hasChange =
      (nextView !== null && nextView !== viewMode) ||
      (nextDateKey !== null && nextDateKey !== currentCursorKey) ||
      (nextMeeting ?? null) !== selectedMeetingId ||
      (nextTab !== null && nextTab !== activeTab);
    if (!hasChange) return;

    syncingFromUrlRef.current = true;
    if ((nextView !== null && nextView !== viewMode) || (nextDateKey !== null && nextDateKey !== currentCursorKey)) setHistoryBatch(0);
    if (nextView) setViewMode(nextView);
    if (nextDateKey) setCursor(localDateFromKey(nextDateKey));
    setSelectedMeetingId(nextMeeting ?? null);
    setActiveTab(nextTab ?? 'prep');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (syncingFromUrlRef.current) {
      syncingFromUrlRef.current = false;
      return;
    }
    const params = new URLSearchParams();
    if (viewMode !== 'day') params.set('view', viewMode);
    params.set('date', dayKey(cursor));
    // `tab` only means anything alongside a selected meeting, and only when
    // it's not the default — same "only serialize non-default" minimalism
    // the canonical EngagementPage.tsx uses for its own `detail` param.
    if (selectedMeetingId) {
      params.set('meeting', selectedMeetingId);
      if (activeTab !== 'prep') params.set('tab', activeTab);
    }

    const nextSearch = params.toString();
    if (nextSearch === searchParams.toString()) return;

    lastProcessedUrlRef.current = nextSearch;
    navigate(
      { pathname: '/engagement/meetings', search: nextSearch ? `?${nextSearch}` : '' },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, cursor, selectedMeetingId, activeTab, navigate]);

  const range = useMemo(() => {
    if (viewMode === 'month') {
      const gridStart = startOfWeek(startOfMonth(cursor));
      return { start: gridStart, end: addDays(gridStart, 41) };
    }
    // Day and List both fetch the FULL week containing cursor — Day view's
    // week strip needs every day's count even though only cursor's single
    // day renders in the body.
    const ws = startOfWeek(cursor);
    return { start: ws, end: addDays(ws, 6) };
  }, [viewMode, cursor]);

  // "Load earlier meetings" widens the window backward by real days and
  // re-queries — never applies to Month view, which already shows a fixed
  // 6-week grid with no history concept.
  const effectiveStart =
    viewMode === 'month' ? range.start : addDays(range.start, -historyBatch * HISTORY_STEP_DAYS);

  const { from, to } = meetingQueryRange(effectiveStart, range.end);

  const meetingsQuery = useMeetings({ from, to, clientId: clientId ?? undefined });
  const list = meetingsQuery.data ?? [];

  // Deep-linked selection may live outside the fetched window entirely —
  // fall back to fetching it directly by id, same edge case the canonical
  // MeetingsV2.tsx handles.
  const listMeeting = list.find((m) => m.id === selectedMeetingId) ?? null;
  const needsFallback = Boolean(selectedMeetingId) && !listMeeting;
  const fallbackQuery = useMeeting(needsFallback ? selectedMeetingId : null);
  const selectedMeeting = listMeeting ?? fallbackQuery.data ?? null;
  const notFound =
    Boolean(selectedMeetingId) &&
    !listMeeting &&
    !fallbackQuery.isLoading &&
    (fallbackQuery.isError || (fallbackQuery.isFetched && !fallbackQuery.data));
  /** True only when the real drawer (MeetingDetailPanel) is on screen — the
   *  placeholder/not-found/loading panels are cards on the page ground, not
   *  the drawer, and must not take its white column chrome (UI-parity §5.1). */
  const drawerOpen = Boolean(selectedMeetingId) && !notFound && Boolean(selectedMeeting);

  const periodLabel = viewMode === 'month'
    ? formatMonthTitle(cursor)
    : viewMode === 'day' ? formatDayTitle(cursor) : formatWeekRange(effectiveStart, range.end);

  const meetingsOn = (d: Date) =>
    list
      .filter((m) => meetingDayKey(m.startsAt, m.endsAt) === dayKey(d))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  // History must expand the rendered groups as well as the requested window.
  const visibleStartKey = dayKey(effectiveStart);
  const visibleEndKey = dayKey(range.end);
  const bodyKeys = viewMode === 'day'
    ? [dayKey(cursor)]
    : [...new Set(list.map((m) => meetingDayKey(m.startsAt, m.endsAt)))]
      .filter((key) => key >= visibleStartKey && key <= visibleEndKey)
      .sort();
  const isEmptyPeriod = viewMode === 'day' ? meetingsOn(cursor).length === 0 : bodyKeys.length === 0;

  function resetHistory() {
    setHistoryBatch(0);
  }

  // Ported/adapted from the canonical MeetingsV2.tsx's `shift()` — Day ±1,
  // List ±7 (real day math), Month steps by a whole calendar month (the
  // spec's shorthand "±30" is this: a month step, not a literal +30 days —
  // stepping by exact days would drift the day-of-month across months of
  // different lengths, which the canonical component correctly avoids).
  function stepPeriod(dir: -1 | 1) {
    resetHistory();
    if (viewMode === 'month') {
      setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
    } else if (viewMode === 'day') {
      setCursor(addDays(cursor, dir));
    } else {
      setCursor(addDays(cursor, dir * 7));
    }
  }

  // Unlike the canonical Today handler (which only resets the date), this
  // one also forces Day view per this phase's explicit spec.
  function goToToday() {
    resetHistory();
    setViewMode('day');
    setCursor(calendarToday());
  }

  function selectDateInStrip(d: Date) {
    resetHistory();
    setCursor(d);
  }

  function openDayFromMonth(d: Date) {
    resetHistory();
    setCursor(d);
    setViewMode('day');
  }

  // Opening a genuinely new meeting jumps to its best tab (bestDetailTab) —
  // mirrors the canonical MeetingsV2.tsx's openMeeting(). Re-clicking the
  // already-open meeting (or a deep link that already set both `meeting` and
  // `tab`) must NOT clobber a manual tab change, so this only fires the
  // heuristic when the id is actually changing.
  function selectMeeting(m: Meeting) {
    const isNewMeeting = m.id !== selectedMeetingId;
    setSelectedMeetingId(m.id);
    if (isNewMeeting) setActiveTab(bestDetailTab(m));
  }

  function clearSelection() {
    setSelectedMeetingId(null);
  }

  /*
   * Real calendar sync against the provider sync endpoints.
   *
   * This used to be `window.dispatchEvent(new Event('capiro:sync-inbox'))`,
   * described in a comment as the "real, existing mechanism". It was not one
   * here: the only listener for that event is in `components/AppShell.tsx`,
   * and `App.tsx` returns `<VNextApp />` before it ever reaches `<AppShell />`
   * on the vNext surface. On os.capiro.ai the button therefore dispatched an
   * event with no listener — silent, no error, no sync. See
   * use-engagement-calendar-sync.ts for the endpoints it now calls.
   */
  const calendarSync = useEngagementCalendarSync({
    onSynced: (count) =>
      toast.show(
        `Calendar synced · ${count} connected mailbox${count === 1 ? '' : 'es'}`,
      ),
  });

  const createMeeting = useMutation<Meeting, Error, NewMeetingInput>({
    mutationFn: async (input) =>
      (
        await api.post<Meeting>('/api/engagement/meetings', {
          clientId: clientId ?? undefined,
          subject: input.subject,
          location: input.location || undefined,
          startsAt: meetingDateTimeToIso(input.dateKey, input.startTime),
          endsAt: meetingDateTimeToIso(input.dateKey, input.endTime),
          attendees: input.attendeeEmails.map((email) => ({ email })),
        })
      ).data,
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: [meetingsListKey] });
      setNewMeetingOpen(false);
      setSelectedMeetingId(created.id);
      setCursor(localDateFromKey(meetingDayKey(created.startsAt, created.endsAt ?? created.startsAt)));
      toast.show(`Meeting created · ${formatDateShort(created.startsAt)}, ${formatTime(created.startsAt)}`);
    },
  });

  const viewLabel = viewMode === 'day' ? 'Day' : viewMode === 'list' ? 'List' : 'Month';

  /*
   * One definition for every place "Sync calendar" appears, so the disabled
   * state and its stated reason can never drift between the header and the two
   * empty states. With no connected mailbox the control is disabled and says
   * why — it is never enabled-but-inert.
   */
  const syncCalendarButton = (variant: 'toolbar' | 'empty') => (
    <button
      type="button"
      className="uui-button"
      onClick={calendarSync.sync}
      disabled={!calendarSync.canSync}
      title={calendarSync.disabledReason ?? undefined}
      aria-describedby={
        calendarSync.disabledReason ? 'vmtg-sync-reason' : undefined
      }
      data-variant={variant}
    >
      <RefreshCw size={variant === 'toolbar' ? 15 : 14} className={calendarSync.isPending ? 'uui-spin' : undefined} />
      {calendarSync.isPending ? 'Syncing…' : 'Sync calendar'}
    </button>
  );

  return (
    <VNextMeetingPanelChrome>
      <div className="vmtg-workspace">
      {/* Below 760px the open drawer REPLACES the list rather than overlapping
          it (UI-parity §5.1) — driven by this attribute, not by an overlay. */}
      <div className="vmtg-main" data-drawer-open={drawerOpen || undefined}>
        <div className="vmtg-toolbar">
          <h2 className="vmtg-title">Meetings</h2>
          <div className="vmtg-period">
            <button
              type="button"
              className="vmtg-period__step"
              aria-label="Previous period"
              onClick={() => stepPeriod(-1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="vmtg-period__label">{periodLabel}</span>
            <button
              type="button"
              className="vmtg-period__step"
              aria-label="Next period"
              onClick={() => stepPeriod(1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <button type="button" className="vmtg-today" onClick={goToToday}>
            Today
          </button>
          <div className="vmtg-spacer" />
          <div className="vmtg-view-toggle" role="group" aria-label="Calendar view">
            {VIEW_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                data-active={viewMode === option.key || undefined}
                onClick={() => {
                  resetHistory();
                  setViewMode(option.key);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          {syncCalendarButton('toolbar')}
          <button
            type="button"
            className="uui-button"
            onClick={() => navigate('/engagement/meeting-library')}
          >
            <Archive size={15} />
            Meeting Library
          </button>
          <button
            type="button"
            className="uui-button uui-button--primary"
            onClick={() => setNewMeetingOpen(true)}
          >
            <Plus size={15} />
            New meeting
          </button>
        </div>

        {/*
          The single node every "Sync calendar" button points its
          aria-describedby at. One id, one node, referenced from the toolbar and
          both empty states — so a screen reader gets the real reason the
          control is disabled instead of a bare "dimmed button".
        */}
        {calendarSync.disabledReason ? (
          <p id="vmtg-sync-reason" className="vmtg-visually-hidden">
            {calendarSync.disabledReason}
          </p>
        ) : null}
        {calendarSync.error ? (
          <div className="vmtg-sync-error" role="alert">
            <AlertTriangle size={15} />
            <span>
              <strong>Calendar sync failed.</strong> {calendarSync.error}
            </span>
          </div>
        ) : null}

        {meetingsQuery.isLoading ? (
          <div className="vmtg-skeletons">
            <div className="vmtg-skeleton-card" />
            <div className="vmtg-skeleton-card" />
            <div className="vmtg-skeleton-card" />
            <p className="vmtg-loading-caption">
              Loading calendar · selected meeting loads independently.
            </p>
          </div>
        ) : meetingsQuery.isError ? (
          <div className="vmtg-error">
            <AlertTriangle size={20} className="vmtg-error__icon" />
            <div>
              <h3>Calendar could not be reached</h3>
              <p>
                Calendar and API errors do not collapse the whole Engagement workspace. The
                selected meeting, Outreach and Reports remain usable.
              </p>
              <button type="button" className="vmtg-retry" onClick={() => void meetingsQuery.refetch()}>
                <RefreshCw size={14} />
                Retry calendar
              </button>
            </div>
          </div>
        ) : viewMode === 'month' ? (
          list.length === 0 ? (
            <div className="vmtg-empty">
              <div className="vmtg-empty__tile">
                <Calendar size={20} />
              </div>
              <h3>No meetings in this period</h3>
              <p>Nothing on the calendar for {periodLabel}.</p>
              <div className="vmtg-empty__actions">
                <button
                  type="button"
                  className="uui-button uui-button--primary"
                  onClick={() => setNewMeetingOpen(true)}
                >
                  <Plus size={14} />
                  New meeting
                </button>
                {syncCalendarButton('empty')}
              </div>
            </div>
          ) : (
            <>
              <MonthGrid
                monthDate={cursor}
                meetings={list}
                selectedMeetingId={selectedMeetingId}
                onSelectMeeting={selectMeeting}
                onOpenDay={openDayFromMonth}
              />
              <p className="vmtg-month__caption">
                URLs persist view mode, cursor date, selected meeting and detail tab.
              </p>
            </>
          )
        ) : isEmptyPeriod ? (
          <div className="vmtg-empty">
            <div className="vmtg-empty__tile">
              <Calendar size={20} />
            </div>
            <h3>No meetings in this period</h3>
            <p>Nothing on the calendar for {periodLabel}.</p>
            <div className="vmtg-empty__actions">
              <button
                type="button"
                className="uui-button uui-button--primary"
                onClick={() => setNewMeetingOpen(true)}
              >
                <Plus size={14} />
                New meeting
              </button>
              {syncCalendarButton('empty')}
            </div>
          </div>
        ) : (
          <>
            {viewMode === 'day' && (
              <WeekStrip cursor={cursor} meetingsOn={meetingsOn} onSelectDate={selectDateInStrip} />
            )}
            {bodyKeys.map((k) => {
              const rows = meetingsOn(localDateFromKey(k));
              return (
                <div key={k} className="vmtg-day-group">
                  <h3 className="vmtg-day-group__label">{formatDayHeader(localDateFromKey(k))}</h3>
                  <div className="vmtg-day-group__rows">
                    {rows.map((m) => (
                      <MeetingRowCard
                        key={m.id}
                        meeting={m}
                        selected={m.id === selectedMeetingId}
                        onSelect={selectMeeting}
                      />
                    ))}
                  </div>
                </div>
              );
            })}

          </>
        )}
        {viewMode === 'list' && !meetingsQuery.isLoading && !meetingsQuery.isError && (
          <button
            type="button"
            className="vmtg-load-more"
            disabled={historyBatch >= MAX_HISTORY_BATCHES || meetingsQuery.isFetching}
            onClick={() => setHistoryBatch((b) => Math.min(b + 1, MAX_HISTORY_BATCHES))}
          >
            <History size={14} />
            {meetingsQuery.isFetching ? 'Loading…' : historyBatch >= MAX_HISTORY_BATCHES ? 'Earlier history limit reached' : 'Load earlier meetings'}
          </button>
        )}
      </div>

      <aside className="vmtg-side" data-open={drawerOpen || undefined}>
        {selectedMeetingId === null ? (
          <div className="vmtg-panel">
            <span className="uui-eyebrow">Selected meeting</span>
            <h3>No meeting selected</h3>
            <p>
              Pick a meeting from the calendar to open its Prep, Meeting Notes and Debrief here.
            </p>
          </div>
        ) : notFound ? (
          <div className="vmtg-panel">
            <span className="vmtg-panel__icon-tile">
              <CircleSlash2 size={18} />
            </span>
            <span className="uui-eyebrow">Meeting not found</span>
            <h3>This meeting is deleted or not authorized for you</h3>
            <p>
              A deleted or unauthorized deep-link id renders this stable explicit panel instead of
              an empty drawer.
            </p>
            <button type="button" className="uui-button" onClick={clearSelection}>
              Back to {viewLabel} view
            </button>
          </div>
        ) : selectedMeeting ? (
          // With `layout="inline"` the canonical panel renders as an ordinary
          // in-flow block (no absolute positioning, no scrim, no transform),
          // so this wrapper no longer needs to be a clipped, sized containing
          // block — the <aside> above owns the sticky column and its scroll.
          <div className="vmtg-drawer-viewport">
            <MeetingDetailPanel
              meeting={selectedMeeting}
              open
              onClose={clearSelection}
              aiConfigured={aiConfigured}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onSendMeri={(m) => setSendMeriTarget(m)}
              onRequestShare={(m) => setShareTarget(m)}
              // UI-parity §5.1: an in-flow column, not an overlay. The
              // canonical Meetings page keeps the default `overlay`.
              layout="inline"
            />
          </div>
        ) : (
          <div className="vmtg-panel">
            <span className="uui-eyebrow">Selected meeting</span>
            <h3>Loading…</h3>
          </div>
        )}
      </aside>

      <NewMeetingModal
        open={newMeetingOpen}
        defaultDate={cursor}
        clientId={clientId}
        clientLabel={clientLabel}
        pending={createMeeting.isPending}
        error={createMeeting.isError ? 'Could not save the meeting. Try again.' : null}
        onClose={() => setNewMeetingOpen(false)}
        onSave={(input) => createMeeting.mutate(input)}
      />
      <VNextSendMeriModal
        meeting={sendMeriTarget}
        open={Boolean(sendMeriTarget)}
        onClose={() => setSendMeriTarget(null)}
      />
      <ShareConfirmation
        meeting={shareTarget}
        open={Boolean(shareTarget)}
        onClose={() => setShareTarget(null)}
      />
      </div>
    </VNextMeetingPanelChrome>
  );
}
