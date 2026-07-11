import {
  addDays,
  dayKey,
  formatTime,
  isToday,
  startOfMonth,
  startOfWeek,
} from './meetings-format.js';
import { meetingStatus } from './meetings-ui.js';
import type { Meeting } from './meetings-types.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MAX_CHIPS = 3;

/** Month view — a full 6-week grid (Mon-first). Direct port of the prototype
 *  MonthView: date-circle, up to 3 accent chips with a status-colored left rule,
 *  and a "+N more" overflow that opens the day. */
export function MonthView({
  monthDate,
  meetings,
  onSelect,
  onOpenDay,
  selectedId,
}: {
  monthDate: Date;
  meetings: Meeting[];
  onSelect: (m: Meeting) => void;
  onOpenDay: (d: Date) => void;
  selectedId?: string | null;
}) {
  const gridStart = startOfWeek(startOfMonth(monthDate));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const weeks: Date[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const byDay = new Map<string, Meeting[]>();
  for (const m of meetings) {
    const k = dayKey(new Date(m.startsAt));
    const arr = byDay.get(k) ?? [];
    arr.push(m);
    byDay.set(k, arr);
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', maxHeight: '62vh', overflow: 'hidden' }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7,1fr)',
          borderBottom: '1px solid var(--border-1)',
          flexShrink: 0,
          background: 'var(--bg-surface)',
        }}
      >
        {WEEKDAYS.map((d, i) => (
          <div
            key={d}
            style={{
              padding: '8px 10px',
              fontSize: 10.5,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--ink-3)',
              borderRight: i < 6 ? '1px solid var(--border-1)' : 'none',
            }}
          >
            {d}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {weeks.map((wk, wi) => (
          <div
            key={wi}
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7,1fr)',
              minHeight: 104,
              borderBottom: wi < weeks.length - 1 ? '1px solid var(--border-1)' : 'none',
            }}
          >
            {wk.map((d, di) => {
              const key = dayKey(d);
              const outside = d.getMonth() !== monthDate.getMonth();
              const dayMeetings = (byDay.get(key) ?? []).sort((a, b) =>
                a.startsAt.localeCompare(b.startsAt),
              );
              const overflow = dayMeetings.length - MAX_CHIPS;
              return (
                <div
                  key={di}
                  style={{
                    borderRight: di < 6 ? '1px solid var(--border-1)' : 'none',
                    padding: '6px 6px 8px',
                    background: outside ? 'var(--bg-sunken)' : 'var(--bg-surface)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    minWidth: 0,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 1 }}>
                    <span
                      style={{
                        fontSize: 11.5,
                        fontWeight: isToday(d) ? 700 : 500,
                        color: isToday(d) ? '#fff' : outside ? 'var(--ink-4)' : 'var(--ink-2)',
                        width: 20,
                        height: 20,
                        borderRadius: '50%',
                        display: 'grid',
                        placeItems: 'center',
                        background: isToday(d) ? 'var(--accent)' : 'transparent',
                      }}
                    >
                      {d.getDate()}
                    </span>
                  </div>
                  {dayMeetings.slice(0, MAX_CHIPS).map((m) => {
                    const active = m.id === selectedId;
                    const done = meetingStatus(m).debrief;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        title={m.subject}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(m);
                        }}
                        style={{
                          textAlign: 'left',
                          border: 'none',
                          cursor: 'pointer',
                          fontFamily: 'var(--font-sans)',
                          borderRadius: 5,
                          padding: '3px 6px',
                          background: active ? 'var(--accent)' : 'var(--accent-soft)',
                          color: active ? '#fff' : 'var(--accent-ink)',
                          fontSize: 10.5,
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          display: 'block',
                          width: '100%',
                          borderLeft: `2.5px solid ${done ? 'var(--success)' : 'var(--accent)'}`,
                        }}
                      >
                        {formatTime(m.startsAt).replace(':00', '')} {m.subject}
                      </button>
                    );
                  })}
                  {overflow > 0 && (
                    <button
                      type="button"
                      onClick={() => onOpenDay(d)}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--ink-3)',
                        fontSize: 10,
                        cursor: 'pointer',
                        paddingLeft: 4,
                        textAlign: 'left',
                      }}
                    >
                      +{overflow} more
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
