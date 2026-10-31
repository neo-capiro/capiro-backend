import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { listManagedConversations } from './list.js';
import { MANAGEMENT_VERSION } from './contract.js';
import { readManagedConversationMetadata, visibleBinding } from './service.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2) } as TenantContext;
const captured = { kind: 'research_portfolio' as const, researchPortfolioId: id(4),
  researchPortfolioName: 'Captured research', researchPortfolioRevision: 2 };
const scope = { ...captured, scopeVersion: createHash('sha256').update(JSON.stringify(captured)).digest('hex') };
function fixture() {
  const row: any = { id: id(3), tenantId: ctx.tenantId, userId: ctx.userId, clientId: null,
    title: 'Research chat', status: 'active', metadataRevision: 0n, updatedAt: new Date('2026-10-31T00:00:00.000Z'),
    archivedAt: null, trashedAt: null, restoreUntil: null, bootstrapReceipt: null,
    metadata: { researchPortfolioScope: { ...scope, currentResearchPortfolioName: 'Old mutable cache', currentResearchPortfolioRevision: 77, stale: true } } };
  const tx = {
    tenantMembership: { findFirst: jest.fn(async () => ({ id: id(6) })) },
    researchPortfolio: { findFirst: jest.fn(async () => ({ id: id(4), tenantId: ctx.tenantId,
      name: 'Current research name', revision: 5, lifecycle: 'active', grants: [{ role: 'viewer' }], clientLinks: [] })) },
    clioConversation: { findFirst: jest.fn(async () => row), findMany: jest.fn(async () => [row]) },
  };
  const prisma = { withTenant: async (_: string, work: (tx: any) => unknown) => work(tx) } as never;
  const read = () => readManagedConversationMetadata(prisma, { tenantId: ctx.tenantId, actorId: ctx.userId }, row.id);
  return { row, tx, prisma, read };
}
test('canonical Research history publishes exactly the immutable five fields without a General bootstrap', async () => {
  const f = fixture(), result = await f.read();
  expect(result).toMatchObject({ scopeKind: 'research_portfolio', clientId: null, scope });
  expect(result.scope).toEqual(scope);
  expect(f.tx.researchPortfolio.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
    id: scope.researchPortfolioId, tenantId: ctx.tenantId, grants: { some: { principalUserId: ctx.userId } },
  } }));
});
test.each(['archived', 'trashed'])('Research %s metadata retains current grant checks and immutable capture', async status => {
  const f = fixture(); f.row.status = status;
  expect(await f.read()).toMatchObject({ status, scope });
  f.tx.researchPortfolio.findFirst.mockResolvedValue(null as never);
  await expect(f.read()).rejects.toThrow('Research portfolio not found');
});
test('Research list does not require a bootstrap and pagination cannot replace the subject admission filter', async () => {
  const f = fixture();
  const before = { updatedAt: '2026-10-31T00:00:00.000Z', conversationId: id(10) };
  const result = await listManagedConversations(f.prisma, ctx, { version: MANAGEMENT_VERSION, status: 'active', title: '', before });
  expect(result.conversations[0]!.scope).toEqual(scope);
  const query = (f.tx.clioConversation.findMany.mock.calls as unknown as Array<[any]>)[0]![0];
  expect(query.where.AND[0].OR).toHaveLength(2);
  expect(query.where.OR).toHaveLength(2);
  f.tx.researchPortfolio.findFirst.mockResolvedValue(null as never);
  await expect(listManagedConversations(f.prisma, ctx, { version: MANAGEMENT_VERSION, status: 'active', title: '', before })).rejects.toThrow();
});
test.each([
  { userId: id(9) }, { tenantId: id(9) }, { clientId: id(9) },
  { bootstrapReceipt: { scopeKind: 'general' } },
  { metadata: { researchPortfolioScope: { ...scope, researchPortfolioName: 'Forged' } } },
  { metadata: { researchPortfolioScope: null } },
])('malformed, foreign or ambiguous Research capture refuses: %j', async change => {
  const f = fixture(); Object.assign(f.row, change); await expect(f.read()).rejects.toThrow();
});
test('Research read admission does not silently enable incompatible lifecycle/retention writes', async () => {
  const f = fixture(); await expect(visibleBinding(f.tx as never, ctx, f.row)).rejects.toThrow('Chat not found');
});
