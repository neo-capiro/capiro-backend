import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';

/**
 * Regression guard for the dev-incident fix (2026-07-21): the expensive client
 * association read must run OUTSIDE the per-tenant Graph-sync advisory lock.
 *
 * Holding lockTenantForGraphSync across ClientAssociationService.associate()
 * (a full active-client scan + attendee-history join + scoring) serialized that
 * read per tenant and left ~5 sessions permanently blocked on
 * pg_advisory_xact_lock, each pinning a Prisma pool connection — which starved
 * the pool and made unrelated endpoints (e.g. the Knowledge Graph) 500 with
 * P2028 "Unable to start a transaction in the given time". The lock must now be
 * acquired only AFTER association, wrapping just the writes.
 *
 * The invariant asserted: within a single persist, `associate` is invoked before
 * the advisory-lock `$executeRaw` fires.
 */

interface Recorder {
  log: string[];
}

function setup() {
  const log: string[] = [];
  // A single recording transaction client shared by both mocked scopes. The only
  // `$executeRaw` these methods issue on the tx is lockTenantForGraphSync's
  // pg_advisory_xact_lock (the real set_config lives in the withTenant wrapper,
  // which is mocked away here), so any $executeRaw call marks "lock acquired".
  const tx = {
    $executeRaw: jest.fn(() => {
      log.push('lock');
      return Promise.resolve(1);
    }),
    meeting: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'meeting-1' }),
      update: jest.fn().mockResolvedValue({ id: 'meeting-1' }),
    },
    meetingAttendee: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({ id: 'attendee-1' }),
    },
    engagementContact: {
      upsert: jest.fn().mockResolvedValue({ id: 'contact-1' }),
    },
    clientAssociationOverride: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    mailMessage: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'mail-1' }),
    },
    mailThread: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'thread-1' }),
      update: jest.fn().mockResolvedValue({ id: 'thread-1' }),
    },
  };

  const prisma = {
    // Phase 1 (association) uses withTenant; phase 2 (write) uses withTenantRetry.
    withTenant: jest.fn((_tenantId: string, fn: (t: unknown) => unknown) => fn(tx)),
    withTenantRetry: jest.fn((_tenantId: string, fn: (t: unknown) => unknown) => fn(tx)),
  };

  const association = {
    associate: jest.fn(async () => {
      log.push('associate');
      return { clientId: 'client-1', score: 0.9, reason: 'match', signals: {} };
    }),
  };

  const config = { get: () => undefined };

  const service = new MicrosoftGraphSyncService(
    prisma as never,
    {} as never,
    association as never,
    config as never,
  );

  return { service, prisma, association, tx, recorder: { log } as Recorder };
}

describe('MicrosoftGraphSyncService — association runs outside the advisory lock', () => {
  it('persistGraphEvent: associate() is called before the advisory lock', async () => {
    const { service, association, prisma, recorder } = setup();
    const event = {
      id: 'evt-1',
      subject: 'Sync with Acme',
      start: { dateTime: '2026-07-21T10:00:00' },
      end: { dateTime: '2026-07-21T11:00:00' },
      organizer: { emailAddress: { address: 'org@acme.com', name: 'Org' } },
      attendees: [{ emailAddress: { address: 'a@acme.com', name: 'A' }, type: 'required' }],
    };

    const outcome = await (
      service as unknown as {
        persistGraphEvent: (
          t: string,
          c: string,
          e: unknown,
          email?: string | null,
        ) => Promise<string>;
      }
    ).persistGraphEvent('tenant-1', 'conn-1', event, 'me@firm.com');

    expect(outcome).toBe('matched');
    expect(association.associate).toHaveBeenCalledTimes(1);
    expect(recorder.log).toContain('associate');
    expect(recorder.log).toContain('lock');
    expect(recorder.log.indexOf('associate')).toBeLessThan(recorder.log.indexOf('lock'));
    // Association ran in the unlocked read scope, the write in the retry scope.
    expect(prisma.withTenant).toHaveBeenCalled();
    expect(prisma.withTenantRetry).toHaveBeenCalled();
  });

  it('persistGraphMessage: associate() is called before the advisory lock', async () => {
    const { service, association, recorder } = setup();
    const message = {
      id: 'msg-1',
      conversationId: 'conv-1',
      subject: 'Re: Acme',
      bodyPreview: 'hello',
      from: { emailAddress: { address: 'a@acme.com', name: 'A' } },
      toRecipients: [{ emailAddress: { address: 'me@firm.com', name: 'Me' } }],
      receivedDateTime: '2026-07-21T10:00:00Z',
    };

    const outcome = await (
      service as unknown as {
        persistGraphMessage: (
          t: string,
          c: string,
          folder: string,
          m: unknown,
        ) => Promise<string>;
      }
    ).persistGraphMessage('tenant-1', 'conn-1', 'inbox', message);

    expect(outcome).toBe('matched');
    expect(association.associate).toHaveBeenCalledTimes(1);
    expect(recorder.log.indexOf('associate')).toBeLessThan(recorder.log.indexOf('lock'));
  });
});
