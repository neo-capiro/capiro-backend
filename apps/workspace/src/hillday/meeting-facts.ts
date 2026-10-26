import { isISO8601 } from 'class-validator';
import type { MeetingFacts } from './hillday.types.js';

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

function instant(value: unknown): value is string {
  return boundedString(value, 64) && /T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
    && isISO8601(value, { strict: true, strictSeparator: true })
    && Number.isFinite(Date.parse(value));
}

function timeZone(value: unknown): value is string {
  if (!boundedString(value, 64) || !value.length) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Read the saved snapshot only. The correction DTO's text bounds define
 * usable editable facts; unsupported legacy snapshots remain visible as null.
 * Reuse class-validator's ISO validation and Intl's existing zone semantics. */
export function projectMeetingFacts(row: { id: string; eventId: string; event: unknown }): MeetingFacts {
  const result: MeetingFacts = { meetingId: row.id, eventId: row.eventId, facts: null };
  if (!row.event || typeof row.event !== 'object' || Array.isArray(row.event)) return result;
  const event = row.event as Record<string, unknown>;
  if (
    !row.eventId || event.eventId !== row.eventId
    || !boundedString(event.subject, 240) || !event.subject.trim()
    || !instant(event.startsAt) || !instant(event.endsAt)
    || Date.parse(event.endsAt) <= Date.parse(event.startsAt)
    || !timeZone(event.timeZone)
    || (event.location !== null && !boundedString(event.location, 240))
  ) return result;
  result.facts = {
    subject: event.subject,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timeZone: event.timeZone,
    location: event.location,
  };
  return result;
}
