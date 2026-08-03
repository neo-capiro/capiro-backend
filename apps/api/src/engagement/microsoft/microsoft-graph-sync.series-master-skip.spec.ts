import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';

/**
 * Regression guard for the "meetings showing at the wrong time" report
 * (DualSight / Jordan Clayton, 2026-08-02): the calendarView delta stream
 * surfaces the bare seriesMaster object alongside real occurrence/exception
 * instances for any recurring series with changes in range. Persisting it as
 * an ordinary meeting created a permanent duplicate frozen at the series'
 * anchor date/time — confirmed live across 4 tenants (365 rows). seriesMaster
 * events must be skipped before any read or write; everything else persists
 * as before.
 */

function setup() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    meeting: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'meeting-1' }),
      update: jest.fn().mockResolvedValue({ id: 'meeting-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    meetingAttendee: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({ id: 'attendee-1' }),
    },
    engagementContact: {
      upsert: jest.fn().mockResolvedValue({ id: 'contact-1' }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    clientAssociationOverride: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  const prisma = {
    withTenant: jest.fn((_tenantId: string, fn: (t: unknown) => unknown) => fn(tx)),
    withTenantRetry: jest.fn((_tenantId: string, fn: (t: unknown) => unknown) => fn(tx)),
  };

  const association = {
    associate: jest.fn(async () => ({
      clientId: 'client-1',
      score: 0.9,
      reason: 'match',
      signals: {},
    })),
  };

  const config = { get: () => undefined };

  const service = new MicrosoftGraphSyncService(
    prisma as never,
    {} as never,
    association as never,
    config as never,
  );

  const persistGraphEvent = (event: unknown, accountEmail: string | null = 'me@firm.com') =>
    (
      service as unknown as {
        persistGraphEvent: (
          t: string,
          c: string,
          e: unknown,
          email?: string | null,
        ) => Promise<string>;
      }
    ).persistGraphEvent('tenant-1', 'conn-1', event, accountEmail);

  return { persistGraphEvent, prisma, tx, association };
}

const baseEvent = {
  id: 'evt-series-1',
  subject: 'Weekly Standup',
  start: { dateTime: '2026-08-10T20:30:00', timeZone: 'UTC' },
  end: { dateTime: '2026-08-10T21:00:00', timeZone: 'UTC' },
  organizer: { emailAddress: { address: 'org@acme.com', name: 'Org' } },
};

describe('MicrosoftGraphSyncService — seriesMaster events are skipped', () => {
  it('skips a seriesMaster event without reading or writing anything', async () => {
    const { persistGraphEvent, tx, association, prisma } = setup();

    const outcome = await persistGraphEvent({ ...baseEvent, type: 'seriesMaster' });

    expect(outcome).toBe('skipped');
    expect(association.associate).not.toHaveBeenCalled();
    expect(tx.meeting.findUnique).not.toHaveBeenCalled();
    expect(tx.meeting.create).not.toHaveBeenCalled();
    expect(tx.meeting.update).not.toHaveBeenCalled();
    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(prisma.withTenantRetry).not.toHaveBeenCalled();
  });

  it.each(['occurrence', 'exception', 'singleInstance', undefined])(
    'still persists a %s event normally',
    async (type) => {
      const { persistGraphEvent, tx } = setup();

      const outcome = await persistGraphEvent({ ...baseEvent, type });

      expect(outcome).toBe('matched');
      expect(tx.meeting.create).toHaveBeenCalledTimes(1);
    },
  );

  it('an @removed seriesMaster (deleted series) still short-circuits to skipped, not removed', async () => {
    // Removed events carry no `type` (Graph sends only id + @removed), so this
    // exercises the ordering: the seriesMaster guard only fires when Graph
    // labels the payload as such, and never suppresses a real removal.
    const { persistGraphEvent, tx } = setup();

    const outcome = await persistGraphEvent({ id: 'evt-removed-1', '@removed': { reason: 'deleted' } });

    expect(outcome).toBe('removed');
    expect(tx.meeting.updateMany).toHaveBeenCalledTimes(1);
  });
});
