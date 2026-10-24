import { describe, expect, jest, test } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

// Bounded read-only fixture; sanitization is never part of these service calls.
jest.mock('sanitize-html', () => {
  const fail = () => { throw new Error('Unexpected sanitizer in a mail read'); };
  return Object.assign(fail, { simpleTransform: () => fail });
});
const tenant = '11111111-1111-1111-1111-111111111111';
const user = '22222222-2222-2222-2222-222222222222';
const ctx = { tenantId: tenant, userId: user } as TenantContext;
function makeService() {
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const query = jest.fn(async (_sql: Prisma.Sql) => []);
  Object.assign(service, { prisma: { withTenant: (_id: string, read: (tx: unknown) => unknown) => read({
    $executeRaw: jest.fn(async () => 1), $queryRaw: query,
    tenantMembership: { findFirst: jest.fn(async () => ({ id: 'member' })) },
    integrationConnection: { findMany: jest.fn(async () => []) },
  }) } });
  return { service, query };
}

describe('EngagementService.listMailThreads compatibility', () => {
  test('the existing array consumer delegates to the same bounded owner page', async () => {
    const { service, query } = makeService();
    expect(await service.listMailThreads(ctx, {})).toEqual([]);
    const sql = query.mock.calls[0]![0];
    expect(sql.sql).toContain('t.tenant_id=?::uuid AND c.created_by_user_id=?::uuid');
    expect(sql.sql).toContain('m.removed_at IS NULL');
    expect(sql.values).toContain(tenant); expect(sql.values).toContain(user);
    expect(sql.values).toContain(51);
  });
  test('nested previews retain active-only received/sent/created order and add the deterministic ID tie-break', async () => {
    const { service, query } = makeService(); await service.listMailThreads(ctx, {});
    const sql = query.mock.calls[0]![0];
    expect(sql.sql).toContain('m.removed_at IS NULL');
    expect(sql.sql).toContain('m.received_at DESC,m.sent_at DESC,m.created_at DESC,m.id DESC LIMIT 3');
    expect(sql.sql).toContain('left(p.body_text,400)');
  });
  test('a different actor gets their own mailbox predicate and no inherited connection IDs', async () => {
    const { service, query } = makeService(); const other = '33333333-3333-3333-3333-333333333333';
    await service.listMailThreads({ ...ctx, userId: other }, {});
    expect(query.mock.calls[0]![0].values).toContain(other);
    expect(query.mock.calls[0]![0].values).not.toContain(user);
  });
});
