import { useEffect, useMemo, useState } from 'react';
import { Empty, Skeleton } from 'antd';
import { CalendarOutlined, LeftOutlined, ReadOutlined, RightOutlined } from '@ant-design/icons';
import { useMeetings } from './meetings-api.js';
import { DayView } from './DayView.js';
import { MonthView } from './MonthView.js';
import { ListView } from './ListView.js';
import { MeetingDetailPanel } from './MeetingDetailPanel.js';
import { SendMeriModal } from './SendMeriModal.js';
import { ShareConfirmation } from './ShareConfirmation.js';
import { MeetingLibraryView } from './MeetingLibraryView.js';
import {
  addDays,
  formatDayTitle,
  formatMonthTitle,
  startOfMonth,
  startOfWeek,
} from './meetings-format.js';
import type { Meeting, MeetingViewMode } from './meetings-types.js';

type DetailTab = 'prep' | 'notes' | 'debrief';

const WEEK_RANGE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/**
 * Redesigned Engagement → Meetings surface (Meetings & Meri v2). Rendered in
 * place of the legacy meetings UI when the tenant is on `meetingsV2.enabled`.
 * Day / Month / List are true calendar modes; the chips switch the body.
 */
export function MeetingsV2({
  clientId,
  aiConfigured,
}: {
  clientId?: string | null;
  aiConfigured: boolean;
}) {
  const [viewMode, setViewMode] = useState<MeetingViewMode>('day');
  const [cursor, setCursor] = useState<Date>(() => new Date());
  const [selected, setSelected] = useState<Meeting | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>('prep');
  const [sendMeriTarget, setSendMeriTarget] = useState<Meeting | null>(null);
  const [shareTarget, setShareTarget] = useState<Meeting | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);

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

  // Keep the open meeting fresh as the list refetches after mutations.
  useEffect(() => {
    if (!selected) return;
    const fresh = meetings.data?.find((m) => m.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [meetings.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const openMeeting = (m: Meeting, tab: DetailTab = 'prep') => {
    setSelected(m);
    setDetailTab(tab);
    setDetailOpen(true);
  };

  const shift = (dir: -1 | 1) => {
    if (viewMode === 'month') {
      setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1));
    } else if (viewMode === 'day') {
      setCursor(addDays(cursor, dir));
    } else {
      setCursor(addDays(cursor, dir * 7));
    }
  };

  const rangeLabel = (() => {
    if (viewMode === 'month') return formatMonthTitle(cursor);
    if (viewMode === 'day') return formatDayTitle(cursor);
    const ws = startOfWeek(cursor);
    const we = addDays(ws, 6);
    return `${WEEK_RANGE.format(ws)} – ${we.getDate()}`;
  })();

  const list = meetings.data ?? [];

  if (showLibrary) {
    return (
      <>
        <MeetingLibraryView
          onBack={() => setShowLibrary(false)}
          onOpenMeeting={(m) => openMeeting(m)}
        />
        <MeetingDetailPanel
          meeting={selected}
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
          aiConfigured={aiConfigured}
          initialTab={detailTab}
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
  }

  return (
    <>
      <div className="mtg-shell">
        <div className="mtg-toolbar">
          <div className="mtg-toolbar-title">
            <CalendarOutlined /> Meetings
          </div>
          <div className="mtg-datenav">
            <button type="button" aria-label="Previous" onClick={() => shift(-1)}>
              <LeftOutlined />
            </button>
            <span>{rangeLabel}</span>
            <button type="button" aria-label="Next" onClick={() => shift(1)}>
              <RightOutlined />
            </button>
            <button type="button" className="mtg-today-btn" onClick={() => setCursor(new Date())}>
              <CalendarOutlined /> Today
            </button>
          </div>
          <div className="mtg-toolbar-spacer" />
          <div className="mtg-view-toggle" role="tablist" aria-label="Meeting view">
            {(['day', 'list', 'month'] as MeetingViewMode[]).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={viewMode === v}
                className={viewMode === v ? 'active' : ''}
                onClick={() => setViewMode(v)}
              >
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          <button type="button" className="mtg-library-btn" onClick={() => setShowLibrary(true)}>
            <ReadOutlined /> Meeting Library
          </button>
        </div>

        {meetings.isLoading ? (
          <div style={{ padding: 18 }}>
            <Skeleton active paragraph={{ rows: 4 }} />
          </div>
        ) : meetings.isError ? (
          <Empty description="Couldn't load meetings." style={{ padding: 40 }} />
        ) : viewMode === 'day' ? (
          <DayView
            meetings={list}
            focusDate={cursor}
            onFocusDate={setCursor}
            selectedId={selected?.id ?? null}
            onSelect={(m) => openMeeting(m)}
            onSendMeri={(m) => setSendMeriTarget(m)}
          />
        ) : viewMode === 'list' ? (
          <ListView
            meetings={list}
            selectedId={selected?.id ?? null}
            onSelect={(m) => openMeeting(m)}
            onSendMeri={(m) => setSendMeriTarget(m)}
          />
        ) : (
          <MonthView
            monthDate={cursor}
            meetings={list}
            onSelect={(m) => openMeeting(m)}
            onOpenDay={(d) => {
              setCursor(d);
              setViewMode('day');
            }}
          />
        )}
      </div>

      <MeetingDetailPanel
        meeting={selected}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        aiConfigured={aiConfigured}
        initialTab={detailTab}
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
}
