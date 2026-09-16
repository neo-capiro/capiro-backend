import { describe, expect, it } from 'vitest';
import { mergeTodayEvents } from './useDashboardVNextModel.js';
import type { ComingUpItem } from '../../../pages/intelligence/types.js';

/**
 * mergeTodayEvents must pair each real meeting exactly once, keep unique
 * owned coming-up meetings that fall outside the primary week query, and
 * preserve tracked hearings/markups/deadlines. All fixtures are synthetic.
 */

type PrimaryMeeting = Parameters<typeof mergeTodayEvents>[0][number];

function ownMeeting(id: string, subject: string, startsAt: string): PrimaryMeeting {
  return {
    id,
    subject,
    startsAt,
    location: 'Rayburn 2154',
    metadata: null,
    client: { id: 'client-1', name: 'Overland AI' },
    preps: [] as Array<{ status: string }>,
    isVirtual: true,
    joinLink: 'https://meet.test/join',
    meri: 'scheduled',
  };
}

function comingUpItem(overrides: Partial<ComingUpItem>): ComingUpItem {
  return {
    id: 'x1',
    kind: 'hearing',
    label: 'HEARING',
    title: 'HASC markup',
    detail: 'Rayburn',
    severity: 'notable',
    date: '2026-09-16T00:00:00.000Z',
    time: null,
    href: 'https://hearing.test',
    ...overrides,
  };
}

describe('Dashboard vNext Today & Coming Up merge (mergeTodayEvents)', () => {
  it('does not duplicate a coming-up meeting already mapped from /api/engagement/meetings', () => {
    const events = mergeTodayEvents(
      [ownMeeting('m-1', 'HILLDAY prep', '2026-09-16T13:30:00.000Z')],
      [
        comingUpItem({
          id: 'meeting-m-1',
          kind: 'meeting',
          label: 'MEETING',
          title: 'HILLDAY prep',
          date: '2026-09-16T13:30:00.000Z',
          time: '9:30 AM', // localized ET label — NOT ISO-parseable with date
          href: '/engagement/meetings/m-1',
        }),
      ],
    );

    // Exactly ONE row for the meeting, and it is the real meeting mapping:
    // correct instant, join action, isMeeting flag and deep link.
    const rows = events.filter((e) => e.title === 'HILLDAY prep');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'meeting-m-1',
      isMeeting: true,
      action: 'join',
      href: '/engagement/meetings/m-1',
      at: new Date('2026-09-16T13:30:00.000Z').getTime(),
    });
    // No phantom `coming-meeting-m-1` row.
    expect(events.some((e) => e.id === 'coming-meeting-m-1')).toBe(false);
  });

  it('retains a unique owned coming-up meeting outside the primary week range exactly once', () => {
    // Primary query is the Monday-first calendar week; comingUp reaches
    // tomorrow→+7d into next week, so m-next can be owned+authorized yet
    // absent from the primary list. It must survive as a meeting event.
    const events = mergeTodayEvents(
      [ownMeeting('m-inweek', 'In-week sync', '2026-09-16T13:30:00.000Z')],
      [
        comingUpItem({
          id: 'meeting-m-next',
          kind: 'meeting',
          label: 'MEETING',
          title: 'Next-week sync',
          detail: 'Rayburn 2154 · Organizer: a.rubin@test',
          date: '2026-09-23T14:00:00.000Z', // real startsAt instant
          time: '10:00 AM', // localized ET label — must NOT be merged into the date
          href: '/engagement/meetings/m-next',
        }),
      ],
    );

    const rows = events.filter((e) => e.id === 'meeting-m-next');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // Canonical meeting event id — never `coming-meeting-*`.
      id: 'meeting-m-next',
      isMeeting: true,
      action: 'open',
      href: '/engagement/meetings/m-next',
      title: 'Next-week sync',
      // The ISO date parsed as the real instant, not the localized label.
      at: new Date('2026-09-23T14:00:00.000Z').getTime(),
      startsAt: new Date('2026-09-23T14:00:00.000Z').toISOString(),
    });
    // No invented rich-meeting state on the fallback row.
    const [fallbackRow] = rows;
    if (!fallbackRow) throw new Error('fallback meeting row missing');
    expect(fallbackRow.joinUrl).toBeUndefined();
    expect(fallbackRow.isVirtual).toBeUndefined();
    expect(fallbackRow.meri).toBeUndefined();
    // Original fallback detail survives in meta.
    expect(fallbackRow.meta).toContain('Organizer: a.rubin@test');
    // The in-week primary meeting is untouched alongside it.
    expect(events.filter((e) => e.id === 'meeting-m-inweek')).toHaveLength(1);
  });

  it('keeps tracked hearings, markups and deadlines, and dedupes the meeting kind by identity', () => {
    const events = mergeTodayEvents(
      [ownMeeting('m-2', 'In-week sync', '2026-09-20T10:00:00.000Z')],
      [
        comingUpItem({ id: 'h-1', kind: 'hearing', date: '2026-09-17T00:00:00.000Z', time: '10:00 AM' }),
        comingUpItem({ id: 'k-1', kind: 'markup', date: '2026-09-18T00:00:00.000Z', time: '2:00 PM' }),
        comingUpItem({ id: 'd-1', kind: 'deadline', date: '2026-09-19T00:00:00.000Z', time: 'before EOD' }),
        // Same meeting id as the primary row → primary wins, no fallback copy.
        comingUpItem({ id: 'meeting-m-2', kind: 'meeting', title: 'In-week sync', date: '2026-09-20T10:00:00.000Z', time: '6:00 AM', href: '/engagement/meetings/m-2' }),
      ],
    );

    // Tracked kinds keep their current behavior untouched.
    const tracked = events.filter((e) => e.id.startsWith('coming-'));
    expect(tracked.map((e) => e.id)).toEqual(['coming-h-1', 'coming-k-1', 'coming-d-1']);
    expect(tracked.every((e) => e.isMeeting === false)).toBe(true);
    expect(tracked.every((e) => e.action === 'open')).toBe(true);
    // The duplicate meeting resolves to exactly one row — the rich primary one.
    const rows = events.filter((e) => e.id === 'meeting-m-2');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ isMeeting: true, action: 'join', href: '/engagement/meetings/m-2' });
    expect(events.some((e) => e.id === 'coming-meeting-m-2')).toBe(false);
  });

  it('carries the real instant on `at`/startsAt so the hook can sort and day-group', () => {
    const events = mergeTodayEvents(
      [ownMeeting('m-late', 'Late sync', '2026-09-18T20:00:00.000Z')],
      [comingUpItem({ id: 'd-early', kind: 'deadline', date: '2026-09-17T00:00:00.000Z', time: null })],
    );

    // (Sorting/filtering happens in the hook; this skeleton must expose the
    // parsed instants it needs: a numeric `at` and the raw startsAt string.)
    const byId = new Map(events.map((e) => [e.id, e]));
    expect(byId.get('meeting-m-late')?.at).toBe(new Date('2026-09-18T20:00:00.000Z').getTime());
    expect(byId.get('meeting-m-late')?.startsAt).toBe('2026-09-18T20:00:00.000Z');
    expect(byId.get('coming-d-early')?.at).toBe(new Date('2026-09-17T00:00:00.000Z').getTime());
    expect(byId.get('coming-d-early')?.startsAt).toBe(new Date('2026-09-17T00:00:00.000Z').toISOString());
  });
});