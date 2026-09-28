import type { PrismaService } from '../../prisma/prisma.service.js';
import { SemanticDataCatalogService } from '../data-catalog/semantic-data-catalog.service.js';
import type { RetrievalRequest } from '../retrieval-v2.types.js';
import { CorePrismaRetrievalAdapter } from './core-prisma-retrieval.adapter.js';

const DEFAULT_MAIL_SYNC = new Date('2026-08-16T12:00:00.000Z');

function mailConnection(id = 'mail-connection-1', mailSyncAt = DEFAULT_MAIL_SYNC) {
  return {
    id,
    provider: 'microsoft_365',
    status: 'connected',
    lastSyncAt: new Date('2026-09-07T12:00:00.000Z'),
    syncState: {
      mail: {
        captureVersion: 1,
        updatedAt: mailSyncAt.toISOString(),
        folderEnumerationComplete: true,
        folders: {
          inbox: { updatedAt: mailSyncAt.toISOString(), deltaLink: 'inbox-delta' },
          sentitems: { updatedAt: mailSyncAt.toISOString(), deltaLink: 'sent-delta' },
        },
      },
    },
  };
}

const request = (overrides: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  queryClass: 'lookup',
  requestedDomains: ['clients'],
  caller: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    clientIds: ['client-visible'],
  },
  ...overrides,
});

function setup(txOverrides: Record<string, unknown> = {}) {
  const tx = {
    client: {
      findMany: jest.fn().mockResolvedValue([{ id: 'client-visible' }]),
      count: jest.fn().mockResolvedValue(0),
    },
    engagementContact: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    mailMessage: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    meeting: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    engagementTask: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    outreachRecord: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    integrationConnection: {
      findMany: jest.fn().mockResolvedValue([mailConnection()]),
      findFirst: jest.fn().mockResolvedValue({ lastSyncAt: DEFAULT_MAIL_SYNC }),
    },
    ...txOverrides,
  };
  const withTenant = jest.fn(
    async (tenantId: string, callback: (value: unknown) => Promise<unknown>) => callback(tx),
  );
  const prisma = { withTenant } as unknown as PrismaService;
  const adapter = new CorePrismaRetrievalAdapter(prisma);
  const catalog = new SemanticDataCatalogService();
  return { adapter, catalog, tx, withTenant };
}

describe('CorePrismaRetrievalAdapter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-17T12:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('enters the tenant-scoped Prisma transaction and resolves client visibility through the ethical wall', async () => {
    const { adapter, catalog, tx, withTenant } = setup();

    await adapter.retrieve(catalog.get('clients'), request());

    expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function), undefined);
    expect(tx.client.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: { in: ['client-visible'] },
        OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: 'user-1' } } }],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
  });

  it('fails closed when all requested clients are walled or otherwise not visible and never queries the requested domain', async () => {
    const { adapter, catalog, tx } = setup();
    tx.client.findMany.mockReset().mockResolvedValue([]);

    const result = await adapter.retrieve(
      catalog.get('mail'),
      request({ requestedDomains: ['mail'] }),
    );

    expect(result).toMatchObject({
      sourceStatus: 'unauthorized',
      returned: 0,
      coverageComplete: false,
      paginationComplete: false,
      stopReason: 'requested_client_scope_not_fully_authorized',
    });
    expect(tx.mailMessage.count).not.toHaveBeenCalled();
    expect(tx.mailMessage.findMany).not.toHaveBeenCalled();
  });

  it('fails the whole scoped retrieval when only a subset of explicitly requested clients is visible', async () => {
    const { adapter, catalog, tx } = setup();
    tx.client.findMany.mockReset().mockResolvedValue([{ id: 'client-visible' }]);

    const result = await adapter.retrieve(
      catalog.get('mail'),
      request({
        requestedDomains: ['mail'],
        caller: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          clientIds: ['client-visible', 'client-hidden'],
        },
      }),
    );

    expect(result).toMatchObject({
      sourceStatus: 'unauthorized',
      requestedEntityCount: 2,
      searchedEntityCount: 1,
      coverageComplete: false,
      stopReason: 'requested_client_scope_not_fully_authorized',
    });
    expect(tx.mailMessage.count).not.toHaveBeenCalled();
  });

  it('scopes meeting retrieval to the established owner predicate and excludes deleted meetings', async () => {
    const { adapter, catalog, tx } = setup();

    const result = await adapter.retrieve(
      catalog.get('meetings'),
      request({ requestedDomains: ['meetings'] }),
    );

    expect(tx.meeting.count).toHaveBeenCalledWith({
      where: {
        AND: [
          { clientId: { in: ['client-visible'] } },
          {
            OR: [{ createdByUserId: 'user-1' }, { connection: { createdByUserId: 'user-1' } }],
            status: { not: 'deleted' },
          },
        ],
      },
    });
    expect(tx.integrationConnection.findFirst).toHaveBeenCalledWith({
      where: {
        createdByUserId: 'user-1',
        provider: { in: ['microsoft_365', 'google_workspace', 'imap_caldav'] },
        status: 'connected',
      },
      orderBy: { lastSyncAt: 'desc' },
      select: { lastSyncAt: true },
    });
    expect(result).toMatchObject({
      sourceStatus: 'degraded',
      coverageComplete: false,
      stopReason: 'meeting_metadata_complete_but_authorized_debrief_body_adapter_not_wired',
    });
  });

  it('keeps removed and foreign-owner mail out of an explicit client scope', async () => {
    const { adapter, catalog, tx } = setup();

    await adapter.retrieve(catalog.get('mail'), request({ requestedDomains: ['mail'] }));

    expect(tx.mailMessage.count).toHaveBeenCalledWith({
      where: {
        AND: [
          { thread: { clientId: { in: ['client-visible'] } } },
          { connection: { createdByUserId: 'user-1' }, removedAt: null },
        ],
      },
    });
    expect(tx.integrationConnection.findMany).toHaveBeenCalledWith({
      where: {
        createdByUserId: 'user-1',
        provider: { in: ['microsoft_365', 'google_workspace', 'imap_caldav'] },
      },
      orderBy: { id: 'asc' },
      select: { id: true, provider: true, status: true, lastSyncAt: true, syncState: true },
    });
  });

  it('does not report a complete empty mail scan when the caller has no authorized mailbox connection', async () => {
    const { adapter, catalog, tx } = setup();
    tx.integrationConnection.findMany.mockReset().mockResolvedValue([]);

    const result = await adapter.retrieve(
      catalog.get('mail'),
      request({ requestedDomains: ['mail'] }),
    );

    expect(result).toMatchObject({
      returned: 0,
      sourceStatus: 'unavailable',
      paginationComplete: true,
      coverageComplete: false,
      stopReason: 'authorized_mailbox_connection_not_found',
    });
  });

  it('marks mail coverage degraded when one authorized mailbox is not connected', async () => {
    const { adapter, catalog, tx } = setup();
    tx.integrationConnection.findMany
      .mockReset()
      .mockResolvedValue([
        mailConnection('mail-1'),
        { ...mailConnection('mail-2'), status: 'error', lastSyncAt: null },
      ]);

    const result = await adapter.retrieve(
      catalog.get('mail'),
      request({ requestedDomains: ['mail'] }),
    );

    expect(result).toMatchObject({
      sourceStatus: 'degraded',
      coverageComplete: false,
      stopReason: 'one_or_more_authorized_mailboxes_not_connected',
    });
  });

  it('reports the stalest completed authorized mailbox sync rather than a fresher unrelated connection', async () => {
    const { adapter, catalog, tx } = setup();
    const older = new Date('2026-08-15T13:00:00.000Z');
    tx.integrationConnection.findMany
      .mockReset()
      .mockResolvedValue([mailConnection('mail-1'), mailConnection('mail-2', older)]);

    const result = await adapter.retrieve(
      catalog.get('mail'),
      request({ requestedDomains: ['mail'] }),
    );

    expect(result).toMatchObject({
      sourceStatus: 'healthy',
      coverageComplete: true,
      lastSyncAt: older,
    });
  });

  it('keeps complete stored pagination partial when the actual mail sync is stale', async () => {
    const { adapter, catalog, tx } = setup();
    tx.integrationConnection.findMany.mockResolvedValue([
      mailConnection('mail-stale', new Date('2026-08-10T12:00:00.000Z')),
    ]);
    const result = await adapter.retrieve(
      catalog.get('mail'),
      request({ requestedDomains: ['mail'] }),
    );
    expect(result).toMatchObject({
      sourceStatus: 'degraded',
      coverageComplete: false,
      paginationComplete: true,
      stopReason: 'mail_sync_stale',
    });
  });

  it('does not claim empty mail coverage is complete after a calendar-only connection sync', async () => {
    const { adapter, catalog, tx } = setup();
    tx.integrationConnection.findMany.mockResolvedValue([
      {
        ...mailConnection(),
        syncState: { calendar: { updatedAt: DEFAULT_MAIL_SYNC.toISOString() } },
      },
    ]);

    const result = await adapter.retrieve(
      catalog.get('mail'),
      request({ requestedDomains: ['mail'] }),
    );

    expect(result).toMatchObject({
      returned: 0,
      sourceStatus: 'degraded',
      coverageComplete: false,
      lastSyncAt: undefined,
      stopReason: 'mail_never_synced',
    });
  });

  it('does not promote legacy client-associated-only mail to complete mailbox coverage', async () => {
    const { adapter, catalog, tx } = setup();
    const connection = mailConnection();
    tx.integrationConnection.findMany.mockResolvedValue([
      {
        ...connection,
        syncState: { mail: { ...connection.syncState.mail, captureVersion: undefined } },
      },
    ]);

    const result = await adapter.retrieve(
      catalog.get('mail'),
      request({ requestedDomains: ['mail'] }),
    );

    expect(result).toMatchObject({
      sourceStatus: 'degraded',
      coverageComplete: false,
      lastSyncAt: DEFAULT_MAIL_SYNC,
      stopReason: 'mail_capture_repair_required',
    });
  });

  it('separates complete local pagination from an unfinished provider backfill', async () => {
    const { adapter, catalog, tx } = setup();
    const connection = mailConnection();
    tx.integrationConnection.findMany.mockResolvedValue([
      {
        ...connection,
        syncState: { mail: { ...connection.syncState.mail, lastStats: { hasMore: true } } },
      },
    ]);

    const result = await adapter.retrieve(
      catalog.get('mail'),
      request({ requestedDomains: ['mail'] }),
    );

    expect(result).toMatchObject({
      returned: 0,
      paginationComplete: true,
      sourceStatus: 'degraded',
      coverageComplete: false,
      stopReason: 'mail_sync_incomplete',
    });
  });

  it('withholds complete mail coverage while replay still owes retained-baseline catch-up', async () => {
    const { adapter, catalog, tx } = setup();
    const connection = mailConnection();
    tx.integrationConnection.findMany.mockResolvedValue([
      {
        ...connection,
        syncState: {
          mail: {
            ...connection.syncState.mail,
            captureReplayCatchupPending: true,
            lastStats: { hasMore: false },
          },
        },
      },
    ]);

    const result = await adapter.retrieve(
      catalog.get('mail'),
      request({ requestedDomains: ['mail'] }),
    );

    expect(result).toMatchObject({
      returned: 0,
      paginationComplete: true,
      sourceStatus: 'degraded',
      coverageComplete: false,
      stopReason: 'mail_sync_incomplete',
    });
  });

  it('keeps soft-deleted, foreign-owner, and reserved internal outreach out', async () => {
    const { adapter, catalog, tx } = setup();

    await adapter.retrieve(catalog.get('outreach'), request({ requestedDomains: ['outreach'] }));

    expect(tx.outreachRecord.count).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        AND: [
          { clientId: { in: ['client-visible'] } },
          {
            createdByUserId: 'user-1',
            AND: [{ type: { notIn: ['outreach_v3'] } }],
          },
        ],
      },
    });
  });

  it('allows unassigned tenant records only when no explicit client subset was requested', async () => {
    const { adapter, catalog, tx } = setup();

    await adapter.retrieve(
      catalog.get('mail'),
      request({
        requestedDomains: ['mail'],
        caller: { tenantId: 'tenant-1', userId: 'user-1' },
      }),
    );

    expect(tx.mailMessage.count).toHaveBeenCalledWith({
      where: {
        AND: [
          { thread: { OR: [{ clientId: null }, { clientId: { in: ['client-visible'] } }] } },
          { connection: { createdByUserId: 'user-1' }, removedAt: null },
        ],
      },
    });
  });

  it('requires a valid time window for advertised temporal query classes before entering Prisma', async () => {
    const { adapter, catalog, withTenant } = setup();

    const result = await adapter.retrieve(
      catalog.get('clients'),
      request({ queryClass: 'change_detection' }),
    );

    expect(withTenant).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      sourceStatus: 'unsupported',
      coverageComplete: false,
      stopReason: 'window_start_and_end_required',
    });
  });

  it('filters client change detection by updatedAt inside the requested half-open window', async () => {
    const { adapter, catalog, tx } = setup();
    const windowStart = new Date('2026-08-01T00:00:00.000Z');
    const windowEnd = new Date('2026-08-17T00:00:00.000Z');

    await adapter.retrieve(
      catalog.get('clients'),
      request({ queryClass: 'change_detection', windowStart, windowEnd }),
    );

    expect(tx.client.count).toHaveBeenCalledWith({
      where: {
        id: { in: ['client-visible'] },
        updatedAt: { gte: windowStart, lt: windowEnd },
      },
    });
  });

  it('filters mail relationship history by sent/received occurrence inside the requested window', async () => {
    const { adapter, catalog, tx } = setup();
    const windowStart = new Date('2026-08-01T00:00:00.000Z');
    const windowEnd = new Date('2026-08-17T00:00:00.000Z');

    await adapter.retrieve(
      catalog.get('mail'),
      request({
        requestedDomains: ['mail'],
        queryClass: 'relationship_history',
        windowStart,
        windowEnd,
      }),
    );

    expect(tx.mailMessage.count).toHaveBeenCalledWith({
      where: {
        AND: [
          { thread: { clientId: { in: ['client-visible'] } } },
          { connection: { createdByUserId: 'user-1' }, removedAt: null },
          {
            OR: [
              { receivedAt: { gte: windowStart, lt: windowEnd } },
              { sentAt: { gte: windowStart, lt: windowEnd } },
            ],
          },
        ],
      },
    });
  });

  /**
   * Regression for the Outreach V3 Context Plane gap: the outreach dataset now
   * advertises `relationship_history`, and this adapter must NOT demand a time
   * window for that pair. Only entity_history and change_detection are
   * window-gated for outreach, so "have we written to this recipient before"
   * must reach Prisma with no temporal scope applied at all.
   */
  it('serves outreach relationship history without requiring a time window', async () => {
    const { adapter, catalog, tx, withTenant } = setup();

    const result = await adapter.retrieve(
      catalog.get('outreach'),
      request({ requestedDomains: ['outreach'], queryClass: 'relationship_history' }),
    );

    // It must not short-circuit before Prisma the way the window-gated classes do.
    expect(withTenant).toHaveBeenCalled();
    expect(result.sourceStatus).not.toBe('unsupported');
    expect(result.stopReason).not.toBe('window_start_and_end_required');

    // No temporal predicate may be applied — the recipient's whole history counts.
    const where = (tx.outreachRecord.count as jest.Mock).mock.calls[0]![0].where as {
      AND: Array<Record<string, unknown>>;
    };
    const serialized = JSON.stringify(where);
    expect(serialized).not.toContain('updatedAt');
    expect(serialized).not.toContain('createdAt');
    expect(serialized).not.toContain('sentAt');
  });

  it('still requires a valid window for outreach entity history and change detection', async () => {
    for (const queryClass of ['entity_history', 'change_detection'] as const) {
      const { adapter, catalog, withTenant } = setup();

      const result = await adapter.retrieve(
        catalog.get('outreach'),
        request({ requestedDomains: ['outreach'], queryClass }),
      );

      expect(withTenant).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        sourceStatus: 'unsupported',
        coverageComplete: false,
        stopReason: 'window_start_and_end_required',
      });
    }
  });
});
