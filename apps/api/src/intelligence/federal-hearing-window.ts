import type { CommitteeHearing } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { federalHearingWhere } from '../hearing-discovery/hearing-geography.js';
import { ClientReadCache } from './client-read-cache.js';
import { dateBoundsInZone } from './time-bounds.js';

/**
 * The upcoming federal hearing window (next N days, ordered by date and
 * time, at most 40 rows) that profile-v1's calendar feed and the hearing
 * alerts both read. It is global reference data with no tenant column, so one
 * process-wide read is shared for a minute: the two reads inside one profile
 * load, and every client of a portfolio roll-up, now cost one statement.
 */
export const FEDERAL_HEARING_WINDOW_TTL_MS = 60_000;
export const FEDERAL_HEARING_WINDOW_ROWS = 40;

// One cache per Prisma client, so a fixture or test harness with its own
// client never observes another client's window.
const windowsByClient = new WeakMap<object, ClientReadCache<CommitteeHearing[]>>();
function windowsFor(prisma: object): ClientReadCache<CommitteeHearing[]> {
  const existing = windowsByClient.get(prisma);
  if (existing) return existing;
  const created = new ClientReadCache<CommitteeHearing[]>(FEDERAL_HEARING_WINDOW_TTL_MS, 16);
  windowsByClient.set(prisma, created);
  return created;
}

/**
 * `date` is a UTC-midnight @db.Date, so `lte: until` admits exactly the days
 * up to the UTC day of `until`; keying on that day lets requests that differ
 * only by milliseconds share the read without changing the result.
 */
function windowKey(start: Date, until: Date): string {
  const untilDay = new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), until.getUTCDate()));
  return `${start.toISOString()}|${untilDay.toISOString()}`;
}

export function readFederalHearingWindow(
  prisma: Pick<PrismaService, 'committeeHearing'>,
  now: Date,
  until: Date,
): Promise<CommitteeHearing[]> {
  // Start-of-Eastern-day, not `now`: `date` is a UTC-midnight @db.Date, so
  // `gte: now` dropped today's rows for the whole working day.
  const start = dateBoundsInZone(now, 'America/New_York').start;
  return windowsFor(prisma).remember(windowKey(start, until), () =>
    prisma.committeeHearing.findMany({
      where: federalHearingWhere({ date: { gte: start, lte: until } }),
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
      take: FEDERAL_HEARING_WINDOW_ROWS,
    }),
  );
}
