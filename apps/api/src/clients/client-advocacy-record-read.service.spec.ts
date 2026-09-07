import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ClientAdvocacyMatterService } from './client-advocacy-matter.service';

jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: jest.fn() }));

const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as TenantContext;
const clientId = '11111111-1111-4111-8111-111111111111';
const date = new Date('2026-09-07T00:00:00.000Z');
const records = Array.from({ length: 27 }, (_, i) => ({
  id: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
  title: `Advocacy ${i}`, summary: 'Full authorized evidence '.repeat(30),
  recordType: 'lda_filing', sourceType: 'lda', sourceId: `filing-${i}`,
  sourceUrl: `https://example.gov/filing/${i}`, evidenceClass: 'inferred', confidence: 0.6,
  activityDate: date, createdAt: date, updatedAt: date, metadata: { exactSection: 'Issue 2' },
  matterId: i === 26 ? null : 'matter-a', matterTitle: i === 26 ? null : 'Issue 2',
  matterLocked: false, status: 'recorded', outcome: null,
}));

function setup() {
  const client = { findFirst: jest.fn().mockResolvedValue({ id: clientId }) };
  const query = jest.fn(async (sql: string, _tenant: string, _client: string, afterId?: string, limit?: number) => {
    if (sql.includes('COUNT(*)')) return [{ total: records.length }];
    return records.filter((r) => !afterId || r.id > afterId).slice(0, limit);
  });
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, read: (tx: unknown) => unknown) => read({ client, $queryRawUnsafe: query })),
  };
  return { client, query, prisma, service: new ClientAdvocacyMatterService(prisma as never, {} as never) };
}

describe('canonical advocacy record inventory', () => {
  it('pages beyond 25 with exact counts, original evidence and an unassigned record', async () => {
    const { service, query, prisma } = setup();
    const first = await service.listRecords(ctx, clientId, { limit: 25 });
    expect(first).toMatchObject({ total: 27, hasMore: true });
    expect(first.items).toHaveLength(25);
    expect(first.items[0]).toMatchObject({
      summary: records[0]!.summary, evidenceClass: 'inferred', confidence: 0.6,
      sourceUrl: records[0]!.sourceUrl, metadata: { exactSection: 'Issue 2' }, updatedAt: date.toISOString(),
    });
    const lastId = first.items[24]!.id;
    const last = await service.listRecords(ctx, clientId, { limit: 25, afterId: lastId });
    expect(last).toMatchObject({ total: 27, hasMore: false });
    expect(last.items.map((row) => row.id)).toEqual(records.slice(25).map((row) => row.id));
    expect(last.items[1]!.matterId).toBeNull();
    for (const call of query.mock.calls) {
      expect(call[0]).toMatch(/(?:r\.)?tenant_id = \$1::uuid AND (?:r\.)?client_id = \$2::uuid/);
      expect(call[0]).toContain('not_advocacy = false');
      expect(call[1]).toBe(ctx.tenantId);
      expect(call[2]).toBe(clientId);
    }
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('ORDER BY r.id ASC LIMIT $4'), ctx.tenantId, clientId, lastId, 26);
    expect(prisma.withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
  });

  it('denies a missing or cross-tenant client before reading record counts or bodies', async () => {
    const { service, client, query } = setup();
    client.findFirst.mockResolvedValue(null);
    await expect(service.listRecords(ctx, clientId, { limit: 25 })).rejects.toThrow(NotFoundException);
    expect(query).not.toHaveBeenCalled();
    expect(client.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
    }));
  });

  it.each([0, 51, 1.5])('rejects an unbounded/invalid page size %s', async (limit) => {
    const { service, query } = setup();
    await expect(service.listRecords(ctx, clientId, { limit })).rejects.toThrow(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it('propagates a source failure instead of reporting an empty ledger', async () => {
    const { service, query } = setup();
    query.mockRejectedValue(new Error('Read unavailable'));
    await expect(service.listRecords(ctx, clientId, { limit: 25 })).rejects.toThrow('Read unavailable');
  });
});
