import type { PrismaService } from '../../prisma/prisma.service.js';
import { SemanticDataCatalogService } from '../data-catalog/semantic-data-catalog.service.js';
import type { RetrievalRequest } from '../retrieval-v2.types.js';
import { CorePrismaRetrievalAdapter } from './core-prisma-retrieval.adapter.js';

function setup() {
  const tx = {
    client: {
      findMany: jest.fn().mockResolvedValue([{ id: 'client-1' }]),
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
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'mailbox-1',
          status: 'connected',
          lastSyncAt: new Date('2026-08-17T12:00:00.000Z'),
        },
      ]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (value: unknown) => Promise<unknown>) =>
      callback(tx),
    ),
  } as unknown as PrismaService;
  return {
    tx,
    adapter: new CorePrismaRetrievalAdapter(prisma),
    catalog: new SemanticDataCatalogService(),
  };
}

const request = (overrides: Partial<RetrievalRequest> = {}): RetrievalRequest => ({
  queryClass: 'lookup',
  requestedDomains: ['clients'],
  caller: { tenantId: 'tenant-1', userId: 'user-1' },
  ...overrides,
});

describe('CorePrismaRetrievalAdapter Phase 15 SecurityScope', () => {
  it('intersects the authorized client envelope with ethical-wall visibility', async () => {
    const { adapter, catalog, tx } = setup();
    tx.client.findMany.mockReset().mockResolvedValue([{ id: 'client-1' }]);

    const result = await adapter.retrieve(
      catalog.get('clients'),
      request({
        caller: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          authorizedClientIds: ['client-1', 'client-hidden'],
        },
      }),
    );

    expect(tx.client.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['client-1', 'client-hidden'] },
        OR: [
          { memoryWall: false },
          { memoryAccessGrants: { some: { userId: 'user-1' } } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(result).toMatchObject({
      sourceStatus: 'unauthorized',
      coverageComplete: false,
      stopReason: 'requested_client_scope_not_fully_authorized',
    });
    expect(tx.client.count).not.toHaveBeenCalled();
  });

  it('rejects SubjectScope client ids outside the authorized envelope', async () => {
    const { adapter, catalog, tx } = setup();

    const result = await adapter.retrieve(
      catalog.get('mail'),
      request({
        requestedDomains: ['mail'],
        caller: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          authorizedClientIds: ['client-1'],
          clientIds: ['client-2'],
        },
      }),
    );

    expect(result).toMatchObject({
      sourceStatus: 'unauthorized',
      coverageComplete: false,
      stopReason: 'requested_client_scope_not_fully_authorized',
    });
    expect(tx.mailMessage.count).not.toHaveBeenCalled();
  });

  it('filters mail and health to the exact authorized mailbox subset', async () => {
    const { adapter, catalog, tx } = setup();

    await adapter.retrieve(
      catalog.get('mail'),
      request({
        requestedDomains: ['mail'],
        caller: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          authorizedMailboxConnectionIds: ['mailbox-1'],
        },
      }),
    );

    expect(tx.integrationConnection.findMany).toHaveBeenCalledWith({
      where: {
        createdByUserId: 'user-1',
        provider: { in: ['microsoft_365', 'google_workspace', 'imap_caldav'] },
        id: { in: ['mailbox-1'] },
      },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, lastSyncAt: true },
    });
    expect(tx.mailMessage.count).toHaveBeenCalledWith({
      where: {
        AND: [
          { thread: { OR: [{ clientId: null }, { clientId: { in: ['client-1'] } }] } },
          { connection: { createdByUserId: 'user-1' }, removedAt: null },
          { connectionId: { in: ['mailbox-1'] } },
        ],
      },
    });
  });

  it('fails closed before reading mail when a requested mailbox is not user-owned', async () => {
    const { adapter, catalog, tx } = setup();
    tx.integrationConnection.findMany.mockReset().mockResolvedValue([]);

    const result = await adapter.retrieve(
      catalog.get('mail'),
      request({
        requestedDomains: ['mail'],
        caller: {
          tenantId: 'tenant-1',
          userId: 'user-1',
          authorizedMailboxConnectionIds: ['foreign-mailbox'],
        },
      }),
    );

    expect(result).toMatchObject({
      sourceStatus: 'unauthorized',
      coverageComplete: false,
      stopReason: 'requested_mailbox_scope_not_fully_authorized',
    });
    expect(tx.mailMessage.count).not.toHaveBeenCalled();
    expect(tx.mailMessage.findMany).not.toHaveBeenCalled();
  });
});
