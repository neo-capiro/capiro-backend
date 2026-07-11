import { MeetingRow } from './MeetingRow.js';
import {
  addDays,
  dayKey,
  formatDayHeader,
  formatWeekdayShort,
  isSameDay,
  isToday,
  startOfWeek,
} from './meetings-format.js';
import type { Meeting } from './meetings-types.js';

function meetingsOn(meetings: Meeting[], d: Date): Meeting[] {
  const key = dayKey(d);
  return meetings
    .filter((m) => dayKey(new Date(m.startsAt)) === key)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** Day view: a 7-day week strip (with per-day counts) above the focused day's
 *  meeting rows. Clicking a strip day re-focuses. */
export function DayView({
  meetings,
  focusDate,
  onFocusDate,
  selectedId,
  onSelect,
  onSendMeri,
}: {
  meetings: Meeting[];
  focusDate: Date;
  onFocusDate: (d: Date) => void;
  selectedId: string | null;
  onSelect: (m: Meeting) => void;
  onSendMeri: (m: Meeting) => void;
}) {
  const weekStart = startOfWeek(focusDate);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const dayMeetings = meetingsOn(meetings, focusDate);

  return (
    <div>
      <div className="mtg-weekstrip">
        {days.map((d) => {
          const count = meetings.filter((m) => dayKey(new Date(m.startsAt)) === dayKey(d)).length;
          return (
            <button
              key={dayKey(d)}
              type="button"
              className={`mtg-weekstrip-day${isToday(d) ? ' is-today' : ''}${
                isSameDay(d, focusDate) ? ' is-selected' : ''
              }`}
              onClick={() => onFocusDate(d)}
            >
              <div className="mtg-weekstrip-dow">{formatWeekdayShort(d)}</div>
              <div className="mtg-weekstrip-num">{d.getDate()}</div>
              <div className="mtg-weekstrip-count">{count > 0 ? count : '—'}</div>
            </button>
          );
        })}
      </div>
      <div className="mtg-body">
        <div className="mtg-daygroup-head">{formatDayHeader(focusDate)}</div>
        {dayMeetings.length === 0 ? (
          <div className="mtg-empty">No meetings this day.</div>
        ) : (
          dayMeetings.map((m) => (
            <MeetingRow
              key={m.id}
              meeting={m}
              selected={m.id === selectedId}
              onSelect={onSelect}
              onSendMeri={onSendMeri}
            />
          ))
        )}
      </div>
    </div>
  );
}
