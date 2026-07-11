import {
  addDays,
  dayKey,
  formatTime,
  isToday,
  startOfMonth,
  startOfWeek,
} from './meetings-format.js';
import type { Meeting } from './meetings-types.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_CHIPS = 3;

/** Month view: a 6-week grid; each cell stacks up to 3 meeting chips + a
 *  "+N more" overflow that opens that day. Chips open the meeting. */
export function MonthView({
  monthDate,
  meetings,
  onSelect,
  onOpenDay,
}: {
  monthDate: Date;
  meetings: Meeting[];
  onSelect: (m: Meeting) => void;
  onOpenDay: (d: Date) => void;
}) {
  const gridStart = startOfWeek(startOfMonth(monthDate));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const byDay = new Map<string, Meeting[]>();
  for (const m of meetings) {
    const key = dayKey(new Date(m.startsAt));
    const list = byDay.get(key) ?? [];
    list.push(m);
    byDay.set(key, list);
  }

  return (
    <div className="mtg-month">
      <div className="mtg-month-dow">
        {WEEKDAYS.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="mtg-month-grid">
        {cells.map((d) => {
          const key = dayKey(d);
          const list = (byDay.get(key) ?? []).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
          const outside = d.getMonth() !== monthDate.getMonth();
          const overflow = list.length - MAX_CHIPS;
          return (
            <div
              key={key}
              className={`mtg-month-cell${outside ? ' is-outside' : ''}${
                isToday(d) ? ' is-today' : ''
              }`}
            >
              <span className="mtg-month-datenum">{d.getDate()}</span>
              {list.slice(0, MAX_CHIPS).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="mtg-month-chip"
                  title={m.subject}
                  onClick={() => onSelect(m)}
                >
                  {formatTime(m.startsAt)} {m.subject}
                </button>
              ))}
              {overflow > 0 ? (
                <button type="button" className="mtg-month-more" onClick={() => onOpenDay(d)}>
                  ↓ {overflow} more
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
