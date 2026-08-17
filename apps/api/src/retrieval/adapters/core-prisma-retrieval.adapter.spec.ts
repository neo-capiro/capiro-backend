import type { PrismaService } from '../../prisma/prisma.service.js';
import { SemanticDataCatalogService } from '../data-catalog/semantic-data-catalog.service.js';
import type { RetrievalRequest } from '../retrieval-v2.types.js';
import { CorePrismaRetrievalAdapter } from './core-prisma-retrieval.adapter.js';

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
      findFirst: jest.fn().mockResolvedValue(null),
    },
    ...txOverrides,
  };
  const withTenant = jest.fn(async (tenantId: string, callback: (value: unknown) => Promise<unknown>) =>
    callback(tx),
  );
  const prisma = { withTenant } as unknown as PrismaService;
  const adapter = new CorePrismaRetrievalAdapter(prisma);
  const catalog = new SemanticDataCatalogService();
  return { adapter, catalog, tx, withTenant };
}

describe('CorePrismaRetrievalAdapter', () => {
  it('enters the tenant-scoped Prisma transaction and resolves client visibility through the ethical wall', async () => {
    const { adapter, catalog, tx, withTenant } = setup();

    await adapter.retrieve(catalog.get('clients'), request());

    expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    expect(tx.client.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: { in: ['client-visible'] },
        OR: [
          { memoryWall: false },
          { memoryAccessGrants: { some: { userId: 'user-1' } } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
  });

  it('fails closed when all requested clients are walled or otherwise not visible and never queries the requested domain', async () => {
    const { adapter, catalog, tx } = setup();
    tx.client.findMany.mockReset().mockResolvedValue([]);

    const result = await adapter.retrieve(catalog.get('mail'), request({ requestedDomains: ['mail'] }));

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

  it('scopes a client-specific meeting retrieval exactly to visible clients and only user-owned or explicitly shared meetings', async () => {
    const { adapter, catalog, tx } = setup();

    const result = await adapter.retrieve(
      catalog.get('meetings'),
      request({ requestedDomains: ['meetings'] }),
    );

    expect(tx.meeting.count).toHaveBeenCalledWith({
      where: {
        AND: [
          { clientId: { in: ['client-visible'] } },
          { OR: [{ createdByUserId: 'user-1' }, { sharedAt: { not: null } }] },
        ],
      },
    });
    expect(result).toMatchObject({
      sourceStatus: 'degraded',
      coverageComplete: false,
      stopReason: 'meeting_metadata_complete_but_authorized_debrief_body_adapter_not_wired',
    });
  });

  it('keeps removed mail out and excludes unassigned mail from an explicit client scope', async () => {
    const { adapter, catalog, tx } = setup();

    await adapter.retrieve(catalog.get('mail'), request({ requestedDomains: ['mail'] }));

    expect(tx.mailMessage.count).toHaveBeenCalledWith({
      where: {
        removedAt: null,
        AND: [{ thread: { clientId: { in: ['client-visible'] } } }],
      },
    });
  });

  it('keeps soft-deleted outreach out and excludes unassigned outreach from an explicit client scope', async () => {
    const { adapter, catalog, tx } = setup();

    await adapter.retrieve(
      catalog.get('outreach'),
      request({ requestedDomains: ['outreach'] }),
    );

    expect(tx.outreachRecord.count).toHaveBeenCalledWith({
      where: {
        deletedAt: null,
        AND: [{ clientId: { in: ['client-visible'] } }],
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
        removedAt: null,
        AND: [
          { thread: { OR: [{ clientId: null }, { clientId: { in: ['client-visible'] } }] } },
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
        removedAt: null,
        AND: [
          { thread: { clientId: { in: ['client-visible'] } } },
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
});
