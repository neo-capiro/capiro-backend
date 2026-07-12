import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { MemoryPromotionClient } from '../src/generation/memory-promotion.client';
import { MemoryPromotionService } from '../src/generation/memory-promotion.service';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 3.4 memory write-back (workspace side). Proves the client is FAIL-CLOSED
 * without the shared secret, and the service builds a stable-keyed firm-memory
 * candidate from the draft (note-first, context fallback) and delegates.
 */
describe('MemoryPromotionClient (fail-closed)', () => {
  const original = process.env.INTERNAL_SERVICE_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = original;
    jest.restoreAllMocks();
  });

  it('throws (never a silent no-op) when INTERNAL_SERVICE_SECRET is unset', async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    const client = new MemoryPromotionClient();
    expect(client.configured).toBe(false);
    await expect(
      client.promote({ tenantId: 't1', clerkUserId: 'c1', key: 'k', value: 'v' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('POSTs to the internal endpoint with the shared-secret header when configured', async () => {
    process.env.INTERNAL_SERVICE_SECRET = 'shh';
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ candidateId: 'c9', status: 'pending' }),
      text: async () => '',
    })) as unknown as typeof fetch;
    global.fetch = fetchMock;
    const client = new MemoryPromotionClient();
    const res = await client.promote({ tenantId: 't1', clerkUserId: 'c1', key: 'k', value: 'v' });
    expect(res).toEqual({ candidateId: 'c9', status: 'pending' });
    const [url, init] = (fetchMock as unknown as jest.Mock).mock.calls[0];
    expect(String(url)).toContain('/api/internal/memory/candidates');
    expect((init as { headers: Record<string, string> }).headers['x-internal-service-secret']).toBe(
      'shh',
    );
  });
});

describe('MemoryPromotionService.promoteDraft', () => {
  function make(draft: unknown) {
    const prisma = {
      wsDraft: { findFirst: jest.fn(async () => draft) },
    } as unknown as PrismaService;
    const promote = jest.fn(async () => ({ candidateId: 'c1', status: 'pending' }));
    const client = { promote } as unknown as MemoryPromotionClient;
    return { service: new MemoryPromotionService(prisma, client), promote };
  }

  it('404s when the draft is not in the tenant', async () => {
    const { service } = make(null);
    await expect(service.promoteDraft('t1', 'c1', 'd1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('uses the user note as the memory value, keyed stably by draft id', async () => {
    const { service, promote } = make({
      id: 'd1',
      product: 'Written testimony',
      docTitle: 'X',
      client: 'Acme',
    });
    await service.promoteDraft('t1', 'clerk_1', 'd1', '  Support the FY27 plus-up.  ');
    expect(promote).toHaveBeenCalledWith({
      tenantId: 't1',
      clerkUserId: 'clerk_1',
      key: 'workspace-artifact:d1',
      value: 'Support the FY27 plus-up.',
      source: 'workspace',
    });
  });

  it('falls back to a draft-context line when no note is given', async () => {
    const { service, promote } = make({
      id: 'd1',
      product: 'One-pager',
      docTitle: 'Title',
      client: 'Acme',
    });
    await service.promoteDraft('t1', 'clerk_1', 'd1');
    const arg = (promote as unknown as jest.Mock).mock.calls[0]![0] as {
      value: string;
      key: string;
    };
    expect(arg.key).toBe('workspace-artifact:d1');
    expect(arg.value).toContain('One-pager');
    expect(arg.value).toContain('Acme');
  });
});
