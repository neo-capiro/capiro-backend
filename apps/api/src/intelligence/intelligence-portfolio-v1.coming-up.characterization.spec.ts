import { UnauthorizedException } from '@nestjs/common';
import {
  deadline,
  harness,
  hearing,
  inputOf,
  installHooks,
  meeting,
  tenantId,
  userId,
} from '../../test/fixtures/intelligence-portfolio.js';

installHooks();

describe('Portfolio coming-up ownership and timezone', () => {
  test('rejects an absent current user before any reader starts', async () => {
    const h = harness();
    await expect(h.service.getComingUp(tenantId, '')).rejects.toThrow(
      new UnauthorizedException('Current user is required'),
    );
    expect(h.calls).toEqual([]);
  });
  test('uses UTC-date tomorrow through plus seven and the original own-calendar predicate', async () => {
    const h = harness();
    expect(await h.service.getComingUp(tenantId, userId)).toEqual({ items: [], totalThisWeek: 0 });
    const bounds = { gte: new Date('2026-10-13T00:00:00Z'), lte: new Date('2026-10-20T00:00:00Z') };
    expect(inputOf(h, 'meetings')).toEqual({
      where: {
        OR: [{ createdByUserId: userId }, { connection: { createdByUserId: userId } }],
        startsAt: bounds,
        status: { notIn: ['cancelled', 'canceled', 'deleted'] },
      },
      orderBy: { startsAt: 'asc' },
      take: 30,
      select: {
        id: true,
        subject: true,
        startsAt: true,
        location: true,
        organizerName: true,
        organizerEmail: true,
      },
    });
    expect(inputOf(h, 'hearings')).toEqual({
      where: {
        AND: [
          { canonicalHearingId: null },
          { OR: [{ geographicJurisdiction: 'US' }, { geographicJurisdiction: null }] },
          { date: bounds },
        ],
      },
      orderBy: { date: 'asc' },
      take: 30,
    });
    expect(inputOf(h, 'deadlines')).toEqual({
      where: { type: { in: ['PROPOSED_RULE', 'RULE'] }, commentEndDate: bounds },
      orderBy: { commentEndDate: 'asc' },
      take: 20,
    });
    expect(h.callsOf('meetings')[0]).toMatchObject({ scope: 'tenant', tenantId, transaction: 1 });
    expect(h.callsOf('clients')[0]).toMatchObject({ scope: 'tenant', tenantId, transaction: 2 });
  });
});

describe('Portfolio coming-up selected membership versus chronological display', () => {
  test('reserves the four soonest meetings and fills two slots with critical markups before final date sorting', async () => {
    const meetings = Array.from({ length: 5 }, (_, index) =>
      meeting({ id: `m${index}`, startsAt: new Date(`2026-10-${14 + index}T14:00:00Z`) }),
    ).reverse();
    const h = harness({
      rows: {
        meetings,
        hearings: [
          hearing({ id: 'early-notable', date: new Date('2026-10-13T00:00:00Z') }),
          hearing({ id: 'critical-late', type: 'markup', date: new Date('2026-10-19T00:00:00Z') }),
          hearing({ id: 'critical-early', type: 'markup', date: new Date('2026-10-18T00:00:00Z') }),
        ],
        deadlines: [deadline({ commentEndDate: new Date('2026-10-13T00:00:00Z') })],
      },
    });
    const value = await h.service.getComingUp(tenantId, userId);
    expect(value.items.map((item) => item.id)).toEqual([
      'meeting-m0',
      'meeting-m1',
      'meeting-m2',
      'meeting-m3',
      'hearing-critical-early',
      'hearing-critical-late',
    ]);
    expect(value.totalThisWeek).toBe(9);
    expect(meetings.map((item) => item.id)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0']);
  });
  test('uses all six slots for non-meeting picks when no calendar meetings exist', async () => {
    const h = harness({
      rows: {
        hearings: Array.from({ length: 8 }, (_, index) =>
          hearing({
            id: `h${index}`,
            type: 'markup',
            date: new Date(`2026-10-${13 + index}T00:00:00Z`),
          }),
        ),
        deadlines: [deadline({ commentEndDate: new Date('2026-10-14T00:00:00Z') })],
      },
    });
    const value = await h.service.getComingUp(tenantId, userId);
    expect(value.items.map((item) => item.id)).toEqual([
      'hearing-h0',
      'hearing-h1',
      'hearing-h2',
      'hearing-h3',
      'hearing-h4',
      'hearing-h5',
    ]);
    expect(value.totalThisWeek).toBe(9);
  });
});

describe('Portfolio coming-up calendar projection', () => {
  test('keeps own meeting routes, Eastern time and nullish organizer precedence', async () => {
    const h = harness({
      rows: {
        meetings: [
          meeting(),
          meeting({
            id: 'blank',
            location: '',
            organizerName: '',
            organizerEmail: 'fallback@example.test',
          }),
          meeting({ id: 'email', location: null, organizerName: null }),
        ],
      },
    });
    const value = await h.service.getComingUp(tenantId, userId);
    expect(value.items[0]).toEqual({
      id: 'meeting-meet-one',
      kind: 'meeting',
      label: 'MEETING',
      title: 'Research meeting',
      detail: 'Office · Organizer: Example',
      severity: 'info',
      date: '2026-10-14T14:00:00.000Z',
      time: '10:00 AM',
      href: '/engagement/meetings/meet-one',
    });
    expect(value.items[1]!.detail).toBeNull();
    expect(value.items[2]!.detail).toBe('Organizer: example@example.test');
  });
  test('preserves coming-up hearing severity differences and deadline final-date fallback', async () => {
    const h = harness({
      rows: {
        hearings: [
          hearing({ type: 'markup', date: new Date('2026-10-14T00:00:00Z') }),
          hearing({ id: 'normal', type: 'Markup', date: new Date('2026-10-15T00:00:00Z') }),
        ],
        deadlines: [deadline({ commentEndDate: null })],
      },
    });
    const value = await h.service.getComingUp(tenantId, userId);
    expect(value.items[0]).toMatchObject({
      kind: 'markup',
      label: 'MARKUP',
      severity: 'critical',
      detail: null,
    });
    expect(value.items[1]).toMatchObject({
      kind: 'hearing',
      label: 'HEARING',
      severity: 'notable',
    });
    expect(value.items[2]).toMatchObject({
      kind: 'deadline',
      label: 'DEADLINE',
      severity: 'notable',
      detail: 'Science / Commerce',
      date: '2026-10-20T00:00:00.000Z',
      time: 'before EOD',
    });
  });
  test('softens meeting time formatting failure without losing the actual Date or route', async () => {
    const startsAt = new Date('2026-10-14T14:00:00Z');
    jest.spyOn(startsAt, 'toLocaleTimeString').mockImplementation(() => {
      throw new Error('Locale failed');
    });
    const h = harness({ rows: { meetings: [meeting({ startsAt })] } });
    expect((await h.service.getComingUp(tenantId, userId)).items[0]).toMatchObject({
      time: null,
      date: startsAt.toISOString(),
      href: '/engagement/meetings/meet-one',
    });
  });
  test('keeps invalid meeting Date serialization fatal', async () => {
    const h = harness({ rows: { meetings: [meeting({ startsAt: new Date('invalid') })] } });
    await expect(h.service.getComingUp(tenantId, userId)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('Portfolio coming-up independent reader failures', () => {
  test.each(['hearings', 'deadlines', 'meetings', 'clients'])(
    'propagates the %s failure including the currently reserved client read',
    async (operation) => {
      const error = new Error(`${operation} failed`);
      const h = harness({ errors: { [operation]: error } });
      await expect(h.service.getComingUp(tenantId, userId)).rejects.toBe(error);
      expect(
        h.calls.filter((call) => call.operation !== 'withTenant').map((call) => call.operation),
      ).toEqual(['hearings', 'deadlines', 'meetings', 'clients']);
    },
  );
});
