/**
 * LW-QA-001/002 contract specs — the upcoming-hearings payload must carry the
 * TRUE start instant (or none), the official wall-clock, the source timezone,
 * and the visibility class, so no consumer can re-derive a time from the
 * calendar date (the 2026-09-02 "8:00 PM previous day" corruption) or offer a
 * capture path on a closed session.
 */
import { UpcomingHearingsService } from './upcoming-hearings.service.js';

type Row = Record<string, unknown>;

function row(overrides: Row): Row {
  return {
    id: 'cm-119-119528',
    title: 'Reliable Water in the Digital Age',
    committeeName: 'Water Resources and Environment Subcommittee',
    chamber: 'House',
    // Prisma @db.Date arrives as a UTC-midnight Date for the calendar day.
    date: new Date('2026-09-03T00:00:00.000Z'),
    startsAt: new Date('2026-09-03T13:00:00.000Z'),
    time: '9:00 AM',
    location: '2123 RHOB',
    type: 'hearing',
    url: 'https://www.congress.gov/event/119th-Congress/house-event/119528',
    timezone: 'America/New_York',
    visibility: 'public',
    ...overrides,
  };
}

function serviceWith(rows: Row[]): UpcomingHearingsService {
  const source = {
    getUpcomingCommitteeHearings: async () => rows,
    searchCommitteeHearings: async () => ({ rows, total: rows.length }),
  };
  const prisma = {
    withTenant: (_t: string, fn: (tx: unknown) => unknown) => fn({
      liveHearingSession: { findMany: async () => [] },
    }),
  };
  return new UpcomingHearingsService(source as never, prisma as never);
}

/** Drive the REAL list() path: source rows → toUpcoming mapping → decorate. */
async function listRows(rows: Row[]) {
  const service = serviceWith(rows);
  return service.list('17b63099-bc0f-4ac5-b596-496161e9481e', 'user-1');
}

describe('upcoming-hearings date/time + visibility contract (LW-QA-001/002)', () => {
  it('exposes startsAt as the true instant and keeps scheduledAt a calendar day', async () => {
    const items = await listRows([row({ id: 'cm-119-119528' })]);
    expect(items[0]?.scheduledAt).toBe('2026-09-03');
    expect(items[0]?.startsAt).toBe('2026-09-03T13:00:00.000Z');
  });

  it('exposes null startsAt for a date-only record — never a fabricated midnight', async () => {
    const items = await listRows([row({ startsAt: null, time: null })]);
    expect(items[0]?.startsAt).toBeNull();
    expect(items[0]?.scheduledAt).toBe('2026-09-03');
    expect(items[0]?.time ?? null).toBeNull();
  });

  it('carries the official wall-clock and source timezone verbatim', async () => {
    const items = await listRows([row({})]);
    expect(items[0]?.time).toBe('9:00 AM');
    expect(items[0]?.timezone).toBe('America/New_York');
  });

  it('carries visibility so closed sessions can be classified before capture is offered', async () => {
    const items = await listRows([row({ visibility: 'private', id: 'cm-119-338672' })]);
    expect(items[0]?.visibility).toBe('private');
  });

  it('formats the two official QA samples without the 8:00 PM previous-day corruption', async () => {
    const items = await listRows([
      row({ id: 'cm-119-119528' }),
      row({
        id: 'cm-119-119533',
        title: 'Industrial Base and Workforce Development for Skilled Trades',
        date: new Date('2026-09-04T00:00:00.000Z'),
        startsAt: new Date('2026-09-04T17:00:00.000Z'),
        time: '1:00 PM',
        location: 'College of the Canyons Performing Arts Center, Santa Clarita, CA',
        url: 'https://www.congress.gov/event/119th-Congress/house-event/119533',
      }),
    ]);
    // 13:00Z is 9:00 AM ET — not 8:00 PM the day before.
    expect(new Date(items[0]!.startsAt!).toISOString()).toBe('2026-09-03T13:00:00.000Z');
    expect(items[0]!.scheduledAt).toBe('2026-09-03');
    // 17:00Z is 1:00 PM ET on Sep 4 — the day never shifts backward.
    expect(new Date(items[1]!.startsAt!).getUTCDate()).toBe(4);
    expect(items[1]!.scheduledAt).toBe('2026-09-04');
  });
});
