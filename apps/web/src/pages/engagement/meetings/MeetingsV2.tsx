import { useEffect, useMemo, useRef, useState } from 'react';
import { Skeleton } from 'antd';
import { Calendar, CalendarCheck, CalendarSearch, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMeetings } from './meetings-api.js';
import { MonthView } from './MonthView.js';
import { MeetingRow } from './MeetingRow.js';
import { MeetingDetailPanel } from './MeetingDetailPanel.js';
import { SendMeriModal } from './SendMeriModal.js';
import { ShareConfirmation } from './ShareConfirmation.js';
import { MeetingLibraryView } from './MeetingLibraryView.js';
import { Empty } from './meetings-ui.js';
import {
  addDays,
  dayKey,
  formatDayHeader,
  formatDayTitle,
  formatMonthTitle,
  formatWeekdayShort,
  isSameDay,
  isToday,
  localDateFromKey,
  startOfMonth,
  startOfWeek,
} from './meetings-format.js';
import type { Meeting, MeetingViewMode } from './meetings-types.js';

const WEEK_RANGE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/**
 * Redesigned Engagement → Meetings surface (Meetings & Meri v2) — a faithful
 * port of the design prototype. Day / Month / List are true calendar modes; the
 * chips switch the calendar body. The Meeting Library is opened from the page
 * header (EngagementPage), so it is controlled here via `libraryOpen`.
 */
export function MeetingsV2({
  clientId,
  aiConfigured,
  libraryOpen = false,
  onLibraryOpenChange,
}: {
  clientId?: string | null;
  aiConfigured: boolean;
  libraryOpen?: boolean;
  onLibraryOpenChange?: (open: boolean) => void;
}) {
  const [viewMode, setViewMode] = useState<MeetingViewMode>('day');
  const [cursor, setCursor] = useState<Date>(() => new Date());
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
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

  const from = new Date(
    range.start.getFullYear(),
    range.start.getMonth(),
    range.start.getDate(),
  ).toISOString();
  const to = new Date(
    range.end.getFullYear(),
    range.end.getMonth(),
    range.end.getDate() + 1,
  ).toISOString();
  const meetings = useMeetings({ from, to, clientId: clientId ?? undefined });
  const list = meetings.data ?? [];

  useEffect(() => {
    if (!selected) return;
    const fresh = list.find((m) => m.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [meetings.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const openMeeting = (m: Meeting) => {
    setSelected(m);
    setDetailOpen(true);
  };

  const shift = (dir: -1 | 1) => {
    if (viewMode === 'month') setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
    else if (viewMode === 'day') setCursor(addDays(cursor, dir));
    else setCursor(addDays(cursor, dir * 7));
  };

  const label = (() => {
    if (viewMode === 'month') return formatMonthTitle(cursor);
    if (viewMode === 'day') return formatDayTitle(cursor);
    const ws = startOfWeek(cursor);
    return `${WEEK_RANGE.format(ws)} – ${addDays(ws, 6).getDate()}`;
  })();

  const meetingsOn = (d: Date) =>
    list
      .filter((m) => dayKey(new Date(m.startsAt)) === dayKey(d))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor), i));

  // The day-keys rendered in the scrolling body: just the focused day (Day view)
  // or every day in the visible week that has meetings (List view).
  const bodyKeys =
    viewMode === 'day'
      ? [dayKey(cursor)]
      : weekDays.map(dayKey).filter((k) => list.some((m) => dayKey(new Date(m.startsAt)) === k));

  const panel = (
    <>
      <MeetingDetailPanel
        meeting={selected}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        aiConfigured={aiConfigured}
        onSendMeri={(m) => setSendMeriTarget(m)}
        onRequestShare={(m) => setShareTarget(m)}
      />
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
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 520,
        }}
      >
        <MeetingLibraryView
          onBack={() => onLibraryOpenChange?.(false)}
          onOpenMeeting={(m) => openMeeting(m)}
        />
        {panel}
      </div>
    );
  }

  return (
    <div ref={contentRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <div
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-1)',
          borderRadius: 10,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--shadow-1)',
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
            onClick={() => setCursor(new Date())}
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
                onClick={() => setViewMode(v)}
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
                  onClick={() => setCursor(d)}
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
              setCursor(d);
              setViewMode('day');
            }}
          />
        ) : (
          <div
            style={{
              maxHeight: '60vh',
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
                        selected={m.id === selected?.id}
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
