import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { listManagedConversations } from './list.js';
import { MANAGEMENT_VERSION, parseManagementRequest } from './contract.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2) } as TenantContext;
const request = { version: MANAGEMENT_VERSION, status: 'active', title: '', before: null };
const row = (n = 3, status = 'active', clientId: string | null = null) => ({
  id: id(n), tenantId: ctx.tenantId, userId: ctx.userId, clientId,
  title: `User title ${n}`, status, metadataRevision: 0n,
  updatedAt: new Date('2026-10-24T12:00:00.000Z'),
  archivedAt: status === 'archived' ? new Date('2026-10-24T12:00:00.000Z') : null,
  trashedAt: null, restoreUntil: null,
  bootstrapReceipt: { tenantId: ctx.tenantId, actorUserId: ctx.userId, conversationId: id(n),
    scopeKind: clientId === null ? 'general' : 'client', clientId },
});
function fixture(rows = [row()]) {
  const tx = {
    tenantMembership: { findFirst: jest.fn(async () => ({ id: id(7) })) },
    clioConversation: { findMany: jest.fn(async (_query: { where: Record<string, unknown> }) => rows) },
    client: { findFirst: jest.fn(async () => ({ id: id(9) })) },
  };
  return { tx, prisma: { withTenant: async (_tenant: string, fn: (t: typeof tx) => unknown) => fn(tx) } as never };
}

test('owned-title search is a bounded canonical metadata query, not transcript search', async () => {
  const f = fixture();
  const result = await listManagedConversations(f.prisma, ctx, { ...request, title: 'Budget' });
  expect(f.tx.clioConversation.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active',
      bootstrapReceipt: { isNot: null }, title: { contains: 'Budget', mode: 'insensitive' } },
    take: 21, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
  }));
  expect(result.conversations[0]).toMatchObject({ title: 'User title 3', scopeKind: 'general', clientId: null, revision: '0' });
  expect(result.nextBefore).toBeNull();
});

test('archived owned rows have an explicit discoverable state without active-only authority', async () => {
  const f = fixture([row(3, 'archived')]);
  const result = await listManagedConversations(f.prisma, ctx, { ...request, status: 'archived' });
  expect(result.conversations[0]?.status).toBe('archived');
  expect(f.tx.clioConversation.findMany.mock.calls[0]?.[0].where.status).toBe('archived');
});

test('stable paging uses the last returned title row and the exact owner filter', async () => {
  const f = fixture(Array.from({ length: 21 }, (_, n) => row(n + 3)));
  const page = await listManagedConversations(f.prisma, ctx, request);
  expect(page.conversations).toHaveLength(20);
  expect(page.nextBefore).toEqual({ updatedAt: '2026-10-24T12:00:00.000Z', conversationId: id(22) });
  await listManagedConversations(f.prisma, ctx, { ...request, before: page.nextBefore });
  expect(f.tx.clioConversation.findMany.mock.calls[1]?.[0].where).toMatchObject({
    tenantId: ctx.tenantId, userId: ctx.userId,
    OR: [{ updatedAt: { lt: new Date(page.nextBefore!.updatedAt) } },
      { updatedAt: new Date(page.nextBefore!.updatedAt), id: { lt: id(22) } }],
  });
});

test('a revoked or unavailable client row withholds the page instead of disappearing', async () => {
  const f = fixture([row(), row(4, 'active', id(9))]);
  f.tx.client.findFirst.mockResolvedValue(null as never);
  await expect(listManagedConversations(f.prisma, ctx, request)).rejects.toBeInstanceOf(NotFoundException);
  f.tx.client.findFirst.mockRejectedValue(Error('source unavailable'));
  await expect(listManagedConversations(f.prisma, ctx, request)).rejects.toThrow('source unavailable');
});

test('membership, foreign principal and legacy null-client rows never become managed General chats', async () => {
  const f = fixture();
  f.tx.tenantMembership.findFirst.mockResolvedValue(null as never);
  await expect(listManagedConversations(f.prisma, ctx, request)).rejects.toThrow('Current conversation access unavailable');
  for (const changed of [{ userId: id(8) }, { tenantId: id(8) }, { bootstrapReceipt: null }]) {
    const g = fixture([{ ...row(), ...changed } as never]);
    await expect(listManagedConversations(g.prisma, ctx, request)).rejects.toThrow('Chat not found');
  }
});

test('commands cannot reassign client scope or carry generated titles through hidden fields', () => {
  const command = { version: MANAGEMENT_VERSION, requestId: id(4), conversationId: id(3), expectedRevision: '0', operation: 'rename', title: 'User title' };
  expect(parseManagementRequest(command)).toEqual(command);
  for (const altered of [{ ...command, clientId: id(9) }, { ...command, autoTitle: true },
    { ...command, title: ' padded ' }, { ...command, title: '' }, { ...command, title: 'x'.repeat(201) }])
    expect(() => parseManagementRequest(altered)).toThrow('Invalid chat change');
});
