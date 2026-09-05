import { useMemo } from 'react';
import type { CanonicalHearingEvent } from '../../../../pages/radar/live-hearings/live-hearings.types.js';

/**
 * LegiWatch shared hearing date/time contract (LW-QA-001).
 *
 * The 2026-09-02 QA found every proceeding rendering as "8:00 PM" on the
 * PREVIOUS day. Root cause chain:
 *
 *   canonical `committee_hearing.starts_at` (true UTC instant)
 *     → intel-api `toUpcoming()` emitted ONLY the calendar date string
 *     → web `new Date('YYYY-MM-DD')` parses as midnight UTC
 *     → `toLocaleTimeString` in a west-of-UTC zone renders 8:00 PM the prior day.
 *
 * Rules enforced here (QA brief §4):
 *  1. An instant is shown only when the official time is known (startsAt).
 *  2. A calendar date is NEVER routed through timezone conversion as though it
 *     were midnight UTC — its Y/M/D parts are formatted directly.
 *  3. A date-only event shows "Time not announced" — never a fabricated time.
 *  4. A date-only event never shifts to the previous day.
 *  5. The official source zone is preserved and displayed.
 *  6. A non-Eastern event shows the event-zone time with the ET equivalent,
 *     e.g. "1:00 PM PT (4:00 PM ET)".
 *  7. Calendar bucketing uses the official Eastern calendar day for BOTH the
 *     week grid and the chip placement, so the whole module shares one frame.
 */

/** Product primary zone (the corpus is Eastern; canonical `date` is the Eastern day). */
export const LW_PRIMARY_TIME_ZONE = 'America/New_York';

/** Zone short labels for the dual-time display. */
const ZONE_LABEL: Record<string, string> = {
  'America/New_York': 'ET',
  'America/Chicago': 'CT',
  'America/Denver': 'MT',
  'America/Phoenix': 'MST',
  'America/Los_Angeles': 'PT',
  'America/Anchorage': 'AKT',
  'Pacific/Honolulu': 'HT',
};

export interface HearingMomentInput {
  /** Official calendar day `YYYY-MM-DD` (canonical `date` column). */
  date: string;
  /** True UTC instant when the official time is known; null for date-only. */
  startsAt?: string | null;
  /** Official wall-clock string from the source, e.g. "1:00 PM". */
  time?: string | null;
  /** IANA zone recorded for the event. */
  timeZone?: string | null;
}

export interface HearingMoment extends HearingMomentInput {
  kind: 'instant' | 'date-only';
  /** Normalized calendar day `YYYY-MM-DD` (validated; null when unusable). */
  calendarDate: string | null;
  /** Normalized IANA zone (defaults to the product primary zone). */
  timeZone: string;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * `YYYY-MM-DD` (or ISO prefix) → validated parts, or null. Never parses to a
 * Date. Validation is a CALENDAR ROUND-TRIP (LW-QA-005 review item C): a
 * structurally valid but impossible day like 2026-02-31 or 2026-04-31 is
 * rejected because Date.UTC normalizes it into the next month.
 */
export function calendarDayParts(value: string | null | undefined): { y: number; m: number; d: number } | null {
  const m = value ? DAY_RE.exec(value.trim()) : null;
  if (!m || !m[1] || !m[2] || !m[3]) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const roundTrip = new Date(Date.UTC(y, mo - 1, d));
  if (
    roundTrip.getUTCFullYear() !== y ||
    roundTrip.getUTCMonth() !== mo - 1 ||
    roundTrip.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m: mo, d };
}

/** Classify a hearing row into the shared moment model. Never throws. */
export function parseHearingMoment(input: HearingMomentInput): HearingMoment {
  const timeZone = input.timeZone?.trim() || LW_PRIMARY_TIME_ZONE;
  const raw = input.startsAt ?? null;
  let parsed: number | null = null;
  if (raw) {
    const t = new Date(raw).getTime();
    if (Number.isFinite(t)) parsed = t;
  }
  const parts = calendarDayParts(input.date);
  return {
    ...input,
    kind: parsed != null ? 'instant' : 'date-only',
    calendarDate: parts ? `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}` : null,
    timeZone,
  };
}

function zonedParts(ms: number, timeZone: string): { y: number; m: number; d: number; h: number; min: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    // hour '24' appears for midnight with hour12:false in some runtimes
    h: Number(get('hour')) % 24,
    min: Number(get('minute')),
  };
}

/** Eastern calendar day `YYYY-MM-DD` of an instant — matches the canonical `date` column. */
export function easternDayOf(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const p = zonedParts(t, LW_PRIMARY_TIME_ZONE);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/**
 * The ONE way a normalized canonical event becomes a moment (LW-QA-018).
 *
 * Schedule, Hearing Detail and Committee Room each hand-rolled this object and
 * disagreed: two fell back to `scheduledStart.slice(0, 10)` — the UTC day,
 * which is the PREVIOUS day for any hearing after 8pm ET — while the third used
 * the Eastern day. Same hearing, different date depending on the tab. The
 * Eastern fallback is the correct one: it matches the canonical `date` column
 * that `calendarDate` carries.
 */
export function momentOfCanonicalEvent(event: CanonicalHearingEvent): HearingMoment {
  return parseHearingMoment({
    date: event.calendarDate ?? (event.scheduledStart ? easternDayOf(event.scheduledStart) ?? '' : ''),
    startsAt: event.scheduledStart ?? null,
    timeZone: event.timeZone ?? null,
  });
}

function clockLabel(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  const suffix = p.h < 12 ? 'AM' : 'PM';
  return `${h12}:${String(p.min).padStart(2, '0')} ${suffix}`;
}

/**
 * Time-of-day display per the contract:
 *  - instant in the product zone           → "1:00 PM ET"
 *  - instant outside the product zone      → "1:00 PM PT (4:00 PM ET)"
 *  - date-only with an official clock file → "1:00 PM (official local time)" — verbatim, never converted
 *  - date-only without one                 → "Time not announced"
 */
export function formatHearingTime(m: HearingMoment): string {
  if (m.kind === 'instant' && m.startsAt) {
    const t = new Date(m.startsAt).getTime();
    const local = clockLabel(t, m.timeZone);
    if (m.timeZone === LW_PRIMARY_TIME_ZONE) return `${local} ET`;
    const zone = ZONE_LABEL[m.timeZone] ?? m.timeZone;
    const et = clockLabel(t, LW_PRIMARY_TIME_ZONE);
    return `${local} ${zone} (${et} ET)`;
  }
  const official = m.time?.trim();
  if (official) return `${official} (official local time)`;
  return 'Time not announced';
}

/**
 * Date display per the contract: the official calendar day, formatted from its
 * parts — NO timezone conversion, so a date-only event can never land on the
 * previous day, and an instant shows the day the official source assigned.
 */
export function formatHearingDay(m: HearingMoment): string {
  const parts = m.kind === 'instant' && m.startsAt ? calendarDayParts(easternDayOf(m.startsAt) ?? m.calendarDate) : calendarDayParts(m.calendarDate);
  if (!parts) return m.calendarDate ?? m.date;
  const label = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(parts.y, parts.m - 1, parts.d)));
  return label;
}

/** Full display label, e.g. "Wed, Sep 3 · 9:00 AM ET" or "Fri, Sep 4 · 1:00 PM PT (4:00 PM ET)". */
export function formatHearingMoment(m: HearingMoment): string {
  return `${formatHearingDay(m)} · ${formatHearingTime(m)}`;
}

/**
 * Which day of `weekDays` (each `YYYY-MM-DD` Eastern) does this hearing belong to?
 * Instant events bucket by their Eastern calendar day (matching the canonical
 * `date` column); date-only events by their official day. -1 when outside.
 */
export function calendarBucketIndex(m: HearingMoment, weekDays: string[]): number {
  const day =
    m.kind === 'instant' && m.startsAt ? (easternDayOf(m.startsAt) ?? m.calendarDate) : m.calendarDate;
  if (!day) return -1;
  return weekDays.indexOf(day);
}

/**
 * Pure Eastern-calendar week days (Monday..Sunday, INCLUSIVE both ends) for an
 * anchor instant. See the hook below for the contract.
 */
export function easternWeekDaysFor(anchor: Date): string[] {
  // Anchor in pure Eastern civil days: project the anchor instant onto the
  // Eastern calendar, then walk seven civil days. No local-time arithmetic, so
  // the same instant selects the same week in any browser timezone.
  const anchorDay = easternDayOf(anchor.toISOString()) ?? anchor.toISOString().slice(0, 10);
  const [yStr, mStr, dStr] = anchorDay.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return [];
  const anchorUtc = new Date(Date.UTC(y, m - 1, d));
  const day = (anchorUtc.getUTCDay() + 6) % 7; // Monday-start, computed in UTC on the Eastern civil day
  const weekStart = anchorUtc.getTime() - day * 86_400_000; // back to the week's Monday
  const out: string[] = [];
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC', // civil-day arithmetic already anchored; format from parts
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  for (let i = 0; i < 7; i++) {
    out.push(fmt.format(new Date(weekStart + i * 86_400_000))); // en-CA → YYYY-MM-DD
  }
  return out;
}

export function useEasternWeekDays(anchor: Date): string[] {
  return useMemo(() => easternWeekDaysFor(anchor), [anchor]);
}
