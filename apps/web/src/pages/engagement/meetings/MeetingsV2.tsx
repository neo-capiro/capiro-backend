import { useEffect, useMemo, useRef, useState } from 'react';
import { Skeleton } from 'antd';
import {
  Calendar,
  CalendarCheck,
  CalendarSearch,
  ChevronLeft,
  ChevronRight,
  Plus,
  X,
} from 'lucide-react';
import { useMeeting, useMeetings } from './meetings-api.js';
import { MonthView } from './MonthView.js';
import { MeetingRow } from './MeetingRow.js';
import { MeetingDetailPanel } from './MeetingDetailPanel.js';
import { SendMeriModal } from './SendMeriModal.js';
import { ShareConfirmation } from './ShareConfirmation.js';
import { MeetingLibraryView } from './MeetingLibraryView.js';
import { Empty, meetingStatus } from './meetings-ui.js';
import {
  addDays,
  dayKey,
  formatDayHeader,
  formatDayTitle,
  formatMonthTitle,
  formatWeekRange,
  formatWeekdayShort,
  isSameDay,
  isToday,
  localDateFromKey,
  meetingDayKey,
  startOfMonth,
  startOfWeek,
} from './meetings-format.js';
import type { DetailTab, Meeting, MeetingViewMode } from './meetings-types.js';

/**
 * The best default detail tab for a freshly opened meeting (spec §2.8): debrief
 * if already done, else notes if captured, else prep. This used to live as an
 * internal effect in MeetingDetailPanel; now that the tab is controlled by the
 * parent, it's computed once per meeting-open in openMeeting() below.
 */
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

export interface MeetingsV2Props {
  clientId?: string | null;
  aiConfigured: boolean;
  libraryOpen: boolean;
  onLibraryOpenChange: (open: boolean) => void;
  /** All of the below are owned by the parent (EngagementPage owns the URL —
   *  Phase 2 §2a2). This component only calls the on*Change callbacks; it never
   *  keeps its own copy of view mode / cursor / selection / detail tab. */
  viewMode: MeetingViewMode;
  cursor: Date;
  selectedMeetingId: string | null;
  detailTab: DetailTab;
  onViewModeChange: (mode: MeetingViewMode) => void;
  onCursorChange: (date: Date) => void;
  onSelectedMeetingChange: (meetingId: string | null) => void;
  onDetailTabChange: (tab: DetailTab) => void;
  onCreateMeeting: (defaultDate?: Date) => void;
}

/**
 * Redesigned Engagement → Meetings surface (Meetings & Meri v2) — a faithful
 * port of the design prototype. Day / Month / List are true calendar modes; the
 * chips switch the calendar body. The Meeting Library is opened from the page
 * header (EngagementPage), so it is controlled here via `libraryOpen`.
 */
export function MeetingsV2({
  clientId,
  aiConfigured,
  libraryOpen,
  onLibraryOpenChange,
  viewMode,
  cursor,
  selectedMeetingId,
  detailTab,
  onViewModeChange,
  onCursorChange,
  onSelectedMeetingChange,
  onDetailTabChange,
  onCreateMeeting,
}: MeetingsV2Props) {
  const [sendMeriTarget, setSendMeriTarget] = useState<Meeting | null>(null);
  const [shareTarget, setShareTarget] = useState<Meeting | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const range = useMemo(() => {
    if (viewMode === 'month') {
      const gridStart = startOfWeek(startOfMonth(cursor));
      return { start: gridStart, end: addDays(gridStart, 41) };
    }
    const ws = startOfWeek(cursor);
    return { start: ws, end: addDays(ws, 6) };
  }, [viewMode, cursor]);

  // Lower bound = the EARLIER of the first day's local midnight and its UTC
  // midnight. Using the min ensures an all-day event stored at UTC midnight on
  // the leading day (which is < local midnight for west-of-UTC users) is still
  // fetched, without excluding early-morning timed events for east-of-UTC users.
  const from = new Date(
    Math.min(
      new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate()).getTime(),
      Date.UTC(range.start.getFullYear(), range.start.getMonth(), range.start.getDate()),
    ),
  ).toISOString();
  const to = new Date(
    range.end.getFullYear(),
    range.end.getMonth(),
    range.end.getDate() + 1,
  ).toISOString();
  const meetings = useMeetings({ from, to, clientId: clientId ?? undefined });
  const list = meetings.data ?? [];

  // The selected meeting may live outside the fetched range entirely (a deep
  // link to a meeting on a different day/month) — fall back to fetching it
  // directly by id when it isn't in the visible list (spec §4 edge case 1).
  const listMeeting = list.find((m) => m.id === selectedMeetingId) ?? null;
  const needsFallback = Boolean(selectedMeetingId) && !listMeeting;
  const fallbackMeetingQuery = useMeeting(needsFallback ? selectedMeetingId : null);
  const selected = listMeeting ?? fallbackMeetingQuery.data ?? null;

  // The id is set but neither the visible list nor the direct fetch resolved
  // it — deleted or no longer accessible (spec §4 edge case 2). Surfaced as an
  // explicit not-found panel rather than silently showing nothing; the user
  // dismisses it (closing clears the selection), so there's no auto-redirect
  // loop to worry about.
  const notFound =
    Boolean(selectedMeetingId) &&
    !listMeeting &&
    !fallbackMeetingQuery.isLoading &&
    (fallbackMeetingQuery.isError ||
      (fallbackMeetingQuery.isFetched && !fallbackMeetingQuery.data));

  const detailOpen = Boolean(selectedMeetingId) && !notFound;

  // Opens a meeting from a click (calendar cell / row / library). Deep links
  // and browser back/forward set `selectedMeetingId` directly from the URL and
  // never go through here, so the "pick the best tab" heuristic only ever runs
  // for in-app opens — an explicit `?detail=` from a URL is never clobbered
  // (spec §2a3, §4 edge cases 3-4). Re-clicking the already-open meeting is a
  // no-op for the tab so it can't stomp a manual tab change either.
  const openMeeting = (m: Meeting) => {
    const isNewMeeting = m.id !== selectedMeetingId;
    onSelectedMeetingChange(m.id);
    if (isNewMeeting) onDetailTabChange(bestDetailTab(m));
  };

  const shift = (dir: -1 | 1) => {
    if (viewMode === 'month') {
      onCursorChange(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
    } else if (viewMode === 'day') {
      onCursorChange(addDays(cursor, dir));
    } else {
      onCursorChange(addDays(cursor, dir * 7));
    }
  };

  const label = (() => {
    if (viewMode === 'month') return formatMonthTitle(cursor);
    if (viewMode === 'day') return formatDayTitle(cursor);
    const ws = startOfWeek(cursor);
    return formatWeekRange(ws, addDays(ws, 6));
  })();

  const meetingsOn = (d: Date) =>
    list
      .filter((m) => meetingDayKey(m.startsAt, m.endsAt) === dayKey(d))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i));

  // The day-keys rendered in the scrolling body: just the focused day (Day view)
  // or every day in the visible week that has meetings (List view).
  const bodyKeys =
    viewMode === 'day'
      ? [dayKey(cursor)]
      : weekDays.map(dayKey).filter((k) => list.some((m) => meetingDayKey(m.startsAt, m.endsAt) === k));

  const panel = (
    <>
      {notFound ? (
        <div
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: 'min(680px,92%)',
            background: 'var(--bg-surface)',
            zIndex: 50,
            borderLeft: '1px solid var(--border-1)',
            boxShadow: '-8px 0 44px rgba(12,26,56,0.16)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 16px 0' }}>
            <button
              type="button"
              onClick={() => onSelectedMeetingChange(null)}
              aria-label="Close"
              className="btn sm btn-ghost"
              style={{ padding: 6 }}
            >
              <X size={16} />
            </button>
          </div>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty
              icon={<CalendarSearch size={20} />}
              title="Meeting not found"
              body="It may have been deleted, or you no longer have access to it."
            />
          </div>
        </div>
      ) : (
        <MeetingDetailPanel
          meeting={selected}
          open={detailOpen}
          onClose={() => onSelectedMeetingChange(null)}
          aiConfigured={aiConfigured}
          activeTab={detailTab}
          onTabChange={onDetailTabChange}
          onSendMeri={(m) => setSendMeriTarget(m)}
          onRequestShare={(m) => setShareTarget(m)}
        />
      )}
      <SendMeriModal
        meeting={sendMeriTarget}
        open={Boolean(sendMeriTarget)}
        onClose={() => setSendMeriTarget(null)}
      />
      <ShareConfirmation
        meeting={shareTarget}
        open={Boolean(shareTarget)}
        onClose={() => setShareTarget(null)}
      />
    </>
  );

  if (libraryOpen) {
    return (
      <div
        ref={contentRef}
        style={{
          position: 'relative',
          // Clips MeetingDetailPanel when closed: it's translateX(100%)'d by its
          // OWN width, so its closed position starts exactly at this container's
          // right edge and extends further right — without this, that "closed"
          // panel still paints in any gutter beyond this box (visible as a thin
          // sliver of its content past the calendar card).
          overflow: 'hidden',
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          height: 'calc(100vh - 200px)',
          minHeight: 0,
        }}
      >
        <MeetingLibraryView
          onBack={() => onLibraryOpenChange(false)}
          onOpenMeeting={(m) => openMeeting(m)}
        />
        {panel}
      </div>
    );
  }

  return (
    <div
      ref={contentRef}
      style={{
        position: 'relative',
        // Clips MeetingDetailPanel when closed: it's translateX(100%)'d by its
        // OWN width, so its closed position starts exactly at this container's
        // right edge and extends further right — without this, that "closed"
        // panel still paints in any gutter beyond this box (visible as a thin
        // sliver of its content past the calendar card).
        overflow: 'hidden',
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        // Bound to the viewport so the card — and the detail panel stacked atop
        // it — always fill the available height instead of shrink-wrapping to
        // however many meetings happen to be listed. No fixed min-height floor:
        // that would force a second, outer page scrollbar on short viewports.
        height: 'calc(100vh - 200px)',
        minHeight: 0,
      }}
    >
      <div
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-1)',
          borderRadius: 10,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--shadow-1)',
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* Toolbar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 18px',
            borderBottom: '1px solid var(--border-1)',
            flexShrink: 0,
            background: 'var(--bg-surface)',
            flexWrap: 'wrap',
          }}
        >
          <Calendar size={18} style={{ color: 'var(--ink-1)' }} />
          <span
            style={{
              fontWeight: 700,
              fontSize: 17,
              letterSpacing: '-0.01em',
              color: 'var(--ink-1)',
            }}
          >
            Meetings
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
            <button
              type="button"
              aria-label="Previous"
              onClick={() => shift(-1)}
              className="btn sm btn-ghost"
              style={{ padding: 5 }}
            >
              <ChevronLeft size={16} />
            </button>
            <span
              style={{
                fontSize: 16,
                fontWeight: 700,
                letterSpacing: '-0.01em',
                color: 'var(--ink-1)',
                minWidth: 118,
                textAlign: 'center',
              }}
            >
              {label}
            </span>
            <button
              type="button"
              aria-label="Next"
              onClick={() => shift(1)}
              className="btn sm btn-ghost"
              style={{ padding: 5 }}
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <button
            type="button"
            onClick={() => onCursorChange(new Date())}
            className="btn sm btn-ghost"
            style={{ gap: 5, color: 'var(--ink-3)' }}
          >
            <CalendarSearch size={13} />
            Today
          </button>
          <div style={{ flex: 1 }} />
          <div
            style={{
              display: 'inline-flex',
              border: '1px solid var(--border-1)',
              borderRadius: 7,
              overflow: 'hidden',
            }}
          >
            {(
              [
                ['day', 'Day'],
                ['list', 'List'],
                ['month', 'Month'],
              ] as [MeetingViewMode, string][]
            ).map(([v, l], i) => (
              <button
                key={v}
                type="button"
                onClick={() => onViewModeChange(v)}
                style={{
                  padding: '6px 14px',
                  border: 'none',
                  fontFamily: 'var(--font-sans)',
                  borderLeft: i > 0 ? '1px solid var(--border-1)' : 'none',
                  background: viewMode === v ? 'var(--ink-1)' : 'transparent',
                  color: viewMode === v ? '#fff' : 'var(--ink-2)',
                  fontSize: 12.5,
                  fontWeight: viewMode === v ? 600 : 500,
                  cursor: 'pointer',
                }}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        {/* Day strip */}
        {viewMode === 'day' && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7,1fr)',
              borderTop: '1px solid var(--border-2)',
              borderBottom: '2px solid var(--border-strong)',
              flexShrink: 0,
              background: 'var(--bg-sunken)',
              boxShadow: 'inset 0 -1px 0 var(--border-2)',
            }}
          >
            {weekDays.map((d, i) => {
              const count = meetingsOn(d).length;
              const isSel = isSameDay(d, cursor);
              const today = isToday(d);
              return (
                <button
                  key={dayKey(d)}
                  type="button"
                  onClick={() => onCursorChange(d)}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    padding: '9px 2px 11px',
                    border: 'none',
                    fontFamily: 'var(--font-sans)',
                    borderRight: i < 6 ? '1px solid var(--border-1)' : 'none',
                    borderTop: `2.5px solid ${isSel ? 'var(--accent)' : 'transparent'}`,
                    background: isSel ? 'var(--accent-soft)' : 'transparent',
                    cursor: 'pointer',
                    gap: 4,
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      color: isSel ? 'var(--accent)' : 'var(--ink-3)',
                    }}
                  >
                    {formatWeekdayShort(d)}
                  </span>
                  <span
                    style={{
                      fontSize: 16,
                      fontWeight: isSel || today ? 700 : 400,
                      color: today || isSel ? 'var(--accent)' : 'var(--ink-1)',
                      width: 30,
                      height: 30,
                      borderRadius: '50%',
                      display: 'grid',
                      placeItems: 'center',
                      background: today && !isSel ? 'rgba(42,87,206,0.09)' : 'transparent',
                    }}
                  >
                    {d.getDate()}
                  </span>
                  <span
                    style={{ fontSize: 10, color: count > 0 ? 'var(--ink-3)' : 'var(--ink-4)' }}
                  >
                    {count > 0 ? `${count}` : '—'}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Content */}
        {meetings.isLoading ? (
          <div style={{ padding: 18 }}>
            <Skeleton active paragraph={{ rows: 4 }} />
          </div>
        ) : viewMode === 'month' ? (
          <MonthView
            monthDate={cursor}
            meetings={list}
            onSelect={(m) => openMeeting(m)}
            onOpenDay={(d) => {
              onCursorChange(d);
              onViewModeChange('day');
            }}
          />
        ) : (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              overflowX: 'hidden',
              background: 'var(--bg-canvas)',
            }}
          >
            {meetings.isError ? (
              <Empty icon={<CalendarCheck size={20} />} title="Couldn't load meetings." />
            ) : bodyKeys.length === 0 ? (
              <Empty
                icon={<CalendarCheck size={20} />}
                title={viewMode === 'day' ? 'No meetings scheduled' : 'No meetings'}
                body={
                  viewMode === 'day'
                    ? 'Nothing on the calendar for this day.'
                    : 'Nothing on the calendar for this period.'
                }
                action={
                  <button
                    type="button"
                    className="btn sm"
                    style={{ gap: 6 }}
                    onClick={() => onCreateMeeting(cursor)}
                  >
                    <Plus size={13} />
                    New meeting
                  </button>
                }
              />
            ) : (
              bodyKeys.map((k) => {
                const rows = meetingsOn(localDateFromKey(k));
                return (
                  <div key={k}>
                    <div
                      style={{
                        padding: '10px 20px',
                        fontSize: 13,
                        fontWeight: 700,
                        letterSpacing: '-0.005em',
                        color: isToday(localDateFromKey(k)) ? 'var(--accent)' : 'var(--ink-2)',
                        borderBottom: '1px solid var(--border-1)',
                        background: 'var(--bg-surface-2)',
                        position: 'sticky',
                        top: 0,
                        zIndex: 1,
                      }}
                    >
                      {formatDayHeader(localDateFromKey(k))}
                    </div>
                    {rows.map((m) => (
                      <MeetingRow
                        key={m.id}
                        meeting={m}
                        selected={m.id === selectedMeetingId}
                        onSelect={(mm) => openMeeting(mm)}
                        onSendMeri={(mm) => setSendMeriTarget(mm)}
                      />
                    ))}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {panel}
    </div>
  );
}
