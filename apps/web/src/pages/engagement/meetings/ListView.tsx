import { MeetingRow } from './MeetingRow.js';
import { dayKey, formatDayHeader, localDateFromKey } from './meetings-format.js';
import type { Meeting } from './meetings-types.js';

/** List view: a flat chronological agenda across the visible range, grouped
 *  under date headers. Same row shape as Day. */
export function ListView({
  meetings,
  selectedId,
  onSelect,
  onSendMeri,
}: {
  meetings: Meeting[];
  selectedId: string | null;
  onSelect: (m: Meeting) => void;
  onSendMeri: (m: Meeting) => void;
}) {
  const groups = new Map<string, Meeting[]>();
  for (const m of meetings) {
    const key = dayKey(new Date(m.startsAt));
    const list = groups.get(key) ?? [];
    list.push(m);
    groups.set(key, list);
  }
  const dayKeys = [...groups.keys()].sort();

  if (dayKeys.length === 0) {
    return (
      <div className="mtg-body">
        <div className="mtg-empty">No meetings in this range.</div>
      </div>
    );
  }

  return (
    <div className="mtg-body">
      {dayKeys.map((key) => {
        const list = (groups.get(key) ?? []).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        return (
          <div key={key}>
            <div className="mtg-daygroup-head">{formatDayHeader(localDateFromKey(key))}</div>
            {list.map((m) => (
              <MeetingRow
                key={m.id}
                meeting={m}
                selected={m.id === selectedId}
                onSelect={onSelect}
                onSendMeri={onSendMeri}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
