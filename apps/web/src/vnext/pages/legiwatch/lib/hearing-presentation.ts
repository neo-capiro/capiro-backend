import { easternDayOf } from './hearing-datetime.js';

export function hearingHasPassed(start: string | null | undefined, day?: string | null, now = Date.now()): boolean {
  if (start && Number.isFinite(Date.parse(start))) return Date.parse(start) < now;
  return Boolean(day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day < (easternDayOf(new Date(now).toISOString()) ?? ''));
}

export function hearingEventLabel(status: string | null | undefined, start?: string | null, day?: string | null, now = Date.now()): string {
  const normalized = status?.toLowerCase() ?? '';
  if (['scheduled', 'upcoming', 'announced'].includes(normalized) && hearingHasPassed(start, day, now)) return 'Past · outcome unconfirmed';
  const labels: Record<string, string> = { scheduled: 'Scheduled', upcoming: 'Upcoming', announced: 'Announced', completed: 'Completed', ended: 'Ended', canceled: 'Canceled', cancelled: 'Canceled', live: 'Live', in_progress: 'In progress', postponed: 'Postponed' };
  return labels[normalized] ?? 'Status unconfirmed';
}

export function recordingAttemptDate(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Attempt time unavailable';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' }).format(new Date(value));
}

export function hasTestSessionTitle(title: string): boolean {
  return /(?:^|[\s\[(_-])(?:qa|test|smoke|fixture)(?:$|[\s\])_:.-])/i.test(title);
}
