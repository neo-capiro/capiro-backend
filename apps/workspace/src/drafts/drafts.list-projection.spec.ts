import { describe, expect, it, jest } from '@jest/globals';
import { DraftsService } from './drafts.service.js';

/**
 * P0 regression: dashboard Work Queue calls GET /workspace-api/drafts?scope=all
 * and was receiving full ws_draft rows (including giant config JSONB). Live
 * observed ~2.7 MB payloads that freeze/white os.capiro.ai after first paint.
 * List must project a slim row and never return `config`.
 */
function makeService() {
  const prisma = {
    wsCollaborator: {
      findMany: jest.fn(async () => [] as Array<{ draftId: string }>),
    },
    wsDraft: {
      findMany: jest.fn(async () => [
        {
          id: 'draft-1',
          tenantId: 'tenant-1',
          ownerId: 'user-1',
          lastEditedById: 'user-1',
          docTitle: 'Board memo',
          industry: 'defense',
          product: 'one-pager',
          client: 'Acme',
          status: 'draft',
          isPacket: false,
          docCount: 1,
          ask: null,
          createdAt: new Date('2026-08-01T00:00:00Z'),
          updatedAt: new Date('2026-08-02T00:00:00Z'),
          documents: [{ id: 'doc-1' }],
        },
      ]),
    },
  };
  const collaborators = {
    assertCan: jest.fn(async () => 'owner'),
  };
  return {
    service: new DraftsService(prisma as never, collaborators as never),
    prisma,
  };
}

describe('DraftsService.list projection', () => {
  it('requests a slim select without config JSONB', async () => {
    const { service, prisma } = makeService();

    await service.list('tenant-1', 'user-1', { scope: 'all' });

    expect(prisma.wsDraft.findMany).toHaveBeenCalledTimes(1);
    const calls = prisma.wsDraft.findMany.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const arg = (calls[0]?.[0] ?? {}) as {
      select?: Record<string, unknown>;
      include?: unknown;
    };
    expect(arg.select).toBeDefined();
    expect(arg.include).toBeUndefined();
    expect(arg.select).not.toHaveProperty('config');
    expect(arg.select).toMatchObject({
      id: true,
      docTitle: true,
      status: true,
      updatedAt: true,
      documents: { select: { id: true } },
    });
  });

  it('returns list rows without a config field even if the store had one', async () => {
    const { service, prisma } = makeService();
    prisma.wsDraft.findMany.mockResolvedValueOnce([
      {
        id: 'draft-2',
        tenantId: 'tenant-1',
        ownerId: 'user-1',
        lastEditedById: null,
        docTitle: 'Huge config draft',
        industry: null,
        product: null,
        client: null,
        status: 'draft',
        isPacket: false,
        docCount: 1,
        ask: null,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-02T00:00:00Z'),
        documents: [],
        // Should never be selected; if a future regression reintroduces it,
        // the service must still strip it from the response.
        config: { documentAgent: { phase: 'x' }, body: 'x'.repeat(100_000) },
      },
    ] as never);

    const result = await service.list('tenant-1', 'user-1', { scope: 'all' });

    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({
      id: 'draft-2',
      docTitle: 'Huge config draft',
      status: 'draft',
    });
    expect(result.drafts[0]).not.toHaveProperty('config');
  });
});
