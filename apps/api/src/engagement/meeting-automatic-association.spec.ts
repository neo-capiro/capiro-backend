import { EngagementService } from './engagement.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { GoogleSyncService } from './google/google-sync.service.js';
import { hasBoundMeetingRecords } from './meeting-automatic-association.js';

function fixture(
  options: {
    bound?: string;
    clientId?: string | null;
    manual?: boolean;
    internal?: boolean;
    onLock?: (row: any) => void;
  } = {},
) {
  const row: any = {
    id: 'meeting',
    clientId: options.clientId === undefined ? 'client-a' : options.clientId,
    isInternal: options.internal ?? false,
    associationSignals: options.manual ? { manual: true } : {},
    associationScore: 0.8,
    associationReason: 'original association',
    status: 'scheduled',
  };
  const events: string[] = [];
  const tx: any = {
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async () => {
      events.push('lock');
      options.onLock?.(row);
      return [{ id: row.id }];
    }),
    meeting: {
      findUnique: jest.fn(async () => {
        events.push('read');
        return { ...row };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        expect(where.tenantId).toBe('tenant');
        if (where.OR?.some((entry: any) => entry.preps)) {
          events.push('bound-records');
          return options.bound && where.OR.some((entry: any) => entry[options.bound!])
            ? { id: row.id }
            : null;
        }
        return { ...row };
      }),
      update: jest.fn(async ({ data }: any) => {
        events.push('write');
        Object.assign(row, data);
        return { id: row.id };
      }),
      create: jest.fn(async ({ data }: any) => {
        Object.assign(row, data);
        return { id: row.id };
      }),
    },
    meetingAttendee: { deleteMany: jest.fn(), create: jest.fn() },
    clientAssociationOverride: { findFirst: jest.fn(async () => null) },
    engagementContact: { upsert: jest.fn() },
  };
  const prisma = {
    withTenant: async (_t: string, work: any) => work(tx),
    withTenantRetry: async (_t: string, work: any) => work(tx),
  };
  const association = {
    associate: jest.fn(async () => ({
      clientId: 'client-b',
      score: 0.9,
      reason: 'new automatic guess',
      signals: { inferred: true },
    })),
  };
  async function sync(provider: 'microsoft' | 'google') {
    const microsoft = provider === 'microsoft';
    const service: any = Object.assign(
      Object.create(microsoft ? MicrosoftGraphSyncService.prototype : GoogleSyncService.prototype),
      { prisma, association },
    );
    const event = {
      id: 'external-event',
      subject: 'Synthetic meeting',
      summary: 'Synthetic meeting',
      start: { dateTime: '2026-10-31T12:00:00Z', timeZone: 'UTC' },
      end: { dateTime: '2026-10-31T12:30:00Z', timeZone: 'UTC' },
      attendees: [],
      iCalUId: 'synthetic-ical',
    };
    return microsoft
      ? service.persistGraphEvent('tenant', 'connection', event)
      : service.persistCalendarEvent('tenant', 'connection', event);
  }
  return { row, tx, events, sync, association };
}

describe.each(['microsoft', 'google'] as const)('%s automatic association', (provider) => {
  test.each(['preps', 'notes', 'debriefs', 'attachments', 'tasks', 'botSessions'])(
    'preserves attribution when %s already exist',
    async (bound) => {
      const f = fixture({ bound });
      await f.sync(provider);
      expect(f.row).toMatchObject({
        clientId: 'client-a',
        associationScore: 0.8,
        associationReason: 'original association',
        externalId: 'external-event',
        connectionId: 'connection',
      });
      expect(f.events.indexOf('lock')).toBeLessThan(f.events.indexOf('bound-records'));
      expect(f.events.slice(0, 3)).toEqual(['read', 'lock', 'read']);
      expect(f.tx.meeting.update).toHaveBeenCalledTimes(1);
      expect(f.tx.meeting.create).not.toHaveBeenCalled();
      // No child rows are rewritten or discarded by an automatic guess.
      expect(f.row.associationSignals).toEqual({});
    },
  );
  test('allows an automatic reassociation when no bound records exist', async () => {
    const f = fixture();
    await f.sync(provider);
    expect(f.row.clientId).toBe('client-b');
    expect(f.row.associationReason).toBe('new automatic guess');
  });
  test('uses the current manual assignment read after the parent lock', async () => {
    const f = fixture({
      onLock: (row) => {
        row.clientId = 'manual-client';
        row.associationSignals = { manual: true };
      },
    });
    await f.sync(provider);
    expect(f.row.clientId).toBe('manual-client');
    expect(f.events).not.toContain('bound-records');
  });
  test('keeps an internal meeting client-less without probing artifacts', async () => {
    const f = fixture({ clientId: null, internal: true });
    await f.sync(provider);
    expect(f.row.clientId).toBeNull();
    expect(f.events).not.toContain('bound-records');
  });
});

test('unchanged association needs no dependent read', async () => {
  const f = fixture();
  await expect(
    hasBoundMeetingRecords(f.tx, 'tenant', 'meeting', 'client-a', 'client-a'),
  ).resolves.toBe(false);
  expect(f.tx.meeting.findFirst).not.toHaveBeenCalled();
});

test.each([true, false])(
  'generation preserves null attribution with existing material=%s',
  async (bound) => {
    const f = fixture({ clientId: null, bound: bound ? 'debriefs' : undefined });
    const service: any = Object.assign(Object.create(EngagementService.prototype), {
      association: f.association,
    });
    // Production callers lock before reading the full generation snapshot.
    await service.lockMeetingClientAssignment(f.tx, { tenantId: 'tenant' }, f.row.id);
    f.tx.client = { findFirst: jest.fn(async () => ({ id: 'client-b' })) };
    f.tx.$queryRawUnsafe = jest.fn(async () => [{ allowed: true }]);
    const selected = await service.resolveEffectiveMeetingClientId(
      f.tx,
      { tenantId: 'tenant', userId: 'actor' },
      { ...f.row, attendees: [] },
    );
    expect(selected).toBe(bound ? null : 'client-b');
    expect(f.tx.meeting.update).toHaveBeenCalledTimes(bound ? 0 : 1);
    expect(f.events[0]).toBe('lock');
  },
);
