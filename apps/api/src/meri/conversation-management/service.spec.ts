import type { TenantContext } from '@capiro/shared';
import { MANAGEMENT_VERSION, TRASH_MS } from './contract.js';
import { assertLegacyManagementAllowed, manageConversation, readManagementRequest, readManagedConversationOwner } from './service.js';

// Scripted Core transaction only; no fabricated Meri exclusion/retention ports.
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const tenantId = id(1), actorId = id(2), conversationId = id(3), requestId = id(4);
const ctx = { tenantId, userId: actorId } as TenantContext;
const now = new Date('2026-10-24T00:00:00.000Z');
function fixture() {
  let row: any = { id: conversationId, tenantId, userId: actorId, clientId: null, title: 'Original', status: 'active',
    metadataRevision: 0n, updatedAt: now, archivedAt: null, trashedAt: null, restoreUntil: null,
    bootstrapReceipt: { tenantId, actorUserId: actorId, conversationId, scopeKind: 'general', clientId: null } };
  const receipts = new Map<string, any>(); const events: string[] = []; let failCommit = false, loseReply = false;
  const tx = { $executeRaw: async (parts: TemplateStringsArray) => {
    const sql = parts.join('?');
    if (sql.includes('FROM tenants')) events.push('tenant-lock');
    else if (sql.includes('FROM clients')) events.push('client-lock');
    else if (sql.includes('FROM tenant_memberships')) events.push('membership-lock');
    else if (sql.includes('FROM client_memory_access')) events.push('grant-lock');
    else if (sql.includes('FROM clio_conversations')) events.push('lock');
    else if (sql.includes('UPDATE meri_office_drafts')) events.push('retire-office');
    else throw Error('Unexpected management SQL');
  }, $queryRaw: async () => [{ now }],
    tenantMembership: { findFirst: jest.fn(async () => ({ id: 'synthetic-membership' })) },
    client: { findFirst: jest.fn(async () => ({ id: id(7) })) },
    clioConversation: { findFirst: async () => row, update: async ({ data }: any) => {
      row = { ...row, ...data, metadataRevision: row.metadataRevision + 1n }; events.push('update'); return row;
    } },
    clioConversationManagementReceipt: { findUnique: async ({ where }: any) => receipts.get(where.tenantId_actorUserId_requestId.requestId) ?? null,
      findMany: async ({ where }: any) => [...receipts.values()].filter(r => r.receipt.receipt.conversation.revision === where.receipt.equals),
      create: async ({ data }: any) => { if (failCommit) throw Error('transaction refused'); receipts.set(data.requestId, data); events.push('receipt'); } },
  };
  const transaction = async (work: (tx: any) => Promise<unknown>) => {
    const before = structuredClone(row), previous = new Map(receipts); let result;
    try { result = await work(tx); events.push('commit'); }
    catch (error) { row = before; receipts.clear(); for (const [k, v] of previous) receipts.set(k, v); throw error; }
    if (loseReply) { loseReply = false; throw Error('committed response lost'); } return result;
  };
  const prisma = { withTenant: async (_tenant: string, work: (tx: any) => Promise<unknown>) => transaction(work),
    withTenantUser: async (tenant: string, actor: string, work: (tx: any) => Promise<unknown>) => {
      expect(tenant).toBe(ctx.tenantId); expect(actor).toBe(ctx.userId); return transaction(work);
    } };
  return { prisma: prisma as never, tx, events, get row() { return row; }, setRow: (next: any) => { row = next; },
    failCommit: () => { failCommit = true; }, loseReply: () => { loseReply = true; }, receipts };
}
const request = (operation: 'trash'|'archive'|'restore') => ({ version: MANAGEMENT_VERSION, requestId, conversationId, expectedRevision: '0', operation });

test('readback preserves absence after stale CAS refusal without acknowledging a write', async () => {
  const f = fixture(), stale = { ...request('trash'), expectedRevision: '9' };
  await expect(manageConversation(f.prisma, ctx, stale)).rejects.toThrow('STALE_REVISION');
  expect(await readManagementRequest(f.prisma, ctx, stale)).toMatchObject({ current: { status: 'active', revision: '0' }, receipt: null, releaseRetention: false });
  expect(f.events).not.toContain('update'); expect(f.receipts.size).toBe(0);
});
test('retention ownership requires exact persisted bootstrap identity, not legacy null', async () => {
  const f = fixture(); expect(await readManagedConversationOwner(f.prisma, { tenantId, conversationId })).toBe(actorId);
  for (const bootstrapReceipt of [{ ...f.row.bootstrapReceipt, actorUserId: id(8) }, null]) {
    f.setRow({ ...f.row, bootstrapReceipt });
    await expect(readManagedConversationOwner(f.prisma, { tenantId, conversationId })).rejects.toThrow('Chat not found');
  }
});
test('deleted replay never reconstructs title from a request tombstone', async () => {
  const f = fixture(); await manageConversation(f.prisma, ctx, request('trash'));
  f.setRow(null); f.receipts.set(requestId, { conversationId: null, receipt: { tombstone: true } });
  await expect(readManagementRequest(f.prisma, ctx, request('trash'))).rejects.toThrow('Chat not found');
});
test('Trash retires private Office drafts and stores its exact receipt and thirty-day database-clock deadline', async () => {
  const f = fixture(), result = await manageConversation(f.prisma, ctx, request('trash'));
  expect(f.events).toEqual(['membership-lock', 'tenant-lock', 'lock', 'retire-office', 'update', 'receipt', 'commit']);
  expect(result.receipt!.conversation).toMatchObject({ status: 'trashed', revision: '1', archivedAt: now.toISOString(), trashedAt: now.toISOString(), restoreUntil: new Date(+now + TRASH_MS).toISOString() });
  expect(result.releaseRetention).toBe(false);
  expect(await readManagementRequest(f.prisma, ctx, request('trash'))).toEqual(result);
});

test('client and grant authority locks precede the conversation lock on apply and exact readback', async () => {
  const f = fixture();
  f.setRow({ ...f.row, clientId: id(7), bootstrapReceipt: { ...f.row.bootstrapReceipt, clientId: id(7), scopeKind: 'client' } });
  await manageConversation(f.prisma, ctx, request('archive'));
  expect(f.events).toEqual(['client-lock', 'membership-lock', 'tenant-lock', 'grant-lock', 'lock', 'update', 'receipt', 'commit']);
  f.events.length = 0;
  await readManagementRequest(f.prisma, ctx, request('archive'));
  expect(f.events).toEqual(['client-lock', 'membership-lock', 'tenant-lock', 'grant-lock', 'lock', 'commit']);
});

test('Trash preserves an earlier inactive timestamp and Restore deliberately clears it', async () => {
  const f = fixture(), archivedAt = new Date(+now - 60000);
  f.setRow({ ...f.row, status: 'archived', archivedAt });
  expect((await manageConversation(f.prisma, ctx, request('trash'))).current.archivedAt).toBe(archivedAt.toISOString());
  const restored = await manageConversation(f.prisma, ctx, { ...request('restore'), requestId: id(8), expectedRevision: '1' });
  expect(restored.current).toMatchObject({ status: 'active', archivedAt: null, trashedAt: null, restoreUntil: null });
});
test('refused transaction and committed lost response have different exact durable readbacks', async () => {
  const f = fixture(); f.failCommit();
  await expect(manageConversation(f.prisma, ctx, request('trash'))).rejects.toThrow('transaction refused');
  expect(await readManagementRequest(f.prisma, ctx, request('trash'))).toMatchObject({ receipt: null, current: { status: 'active' } });
  const g = fixture(); g.loseReply();
  await expect(manageConversation(g.prisma, ctx, request('trash'))).rejects.toThrow('committed response lost');
  const read = await readManagementRequest(g.prisma, ctx, request('trash'));
  expect(read.receipt!.conversation.status).toBe('trashed');
  expect(await manageConversation(g.prisma, ctx, request('trash'))).toEqual(read);
  expect(g.row.metadataRevision).toBe(1n);
});
test('membership, owner and tenant are rechecked before replay', async () => {
  const f = fixture(); await manageConversation(f.prisma, ctx, request('archive'));
  f.tx.tenantMembership.findFirst.mockResolvedValue(null as never);
  await expect(readManagementRequest(f.prisma, ctx, request('archive'))).rejects.toThrow('Current conversation access unavailable');
  for (const changed of [{ userId: id(5) }, { tenantId: id(5) }]) {
    const g = fixture(); g.setRow({ ...g.row, ...changed });
    await expect(manageConversation(g.prisma, ctx, request('trash'))).rejects.toThrow('Chat not found');
  }
});
test('Restore release is available only after exact committed receipt; retries are idempotent', async () => {
  const f = fixture(); await manageConversation(f.prisma, ctx, request('trash'));
  const restore = { ...request('restore'), requestId: id(8), expectedRevision: '1' };
  expect((await readManagementRequest(f.prisma, ctx, restore)).releaseRetention).toBe(false);
  const result = await manageConversation(f.prisma, ctx, restore);
  expect(result.releaseRetention).toBe(true); expect(result.suppressionRequestId).toBe(requestId);
  expect(await manageConversation(f.prisma, ctx, restore)).toEqual(result);
  expect(f.row.metadataRevision).toBe(2n);
});
test('old Restore retry never releases a later Trash or changed revision', async () => {
  const f = fixture(); await manageConversation(f.prisma, ctx, request('trash'));
  const restore = { ...request('restore'), requestId: id(8), expectedRevision: '1' };
  const applied = await manageConversation(f.prisma, ctx, restore);
  expect(applied.suppressionRequestId).toBe(requestId);
  for (const status of ['trashed', 'active']) {
    f.setRow({ ...f.row, status, metadataRevision: 3n });
    const replay = await readManagementRequest(f.prisma, ctx, restore);
    expect(replay.releaseRetention).toBe(false); expect(replay.receipt).toEqual(applied.receipt);
  }
});
test('Archive restore never requests retention release, even on replay', async () => {
  const f = fixture(); f.setRow({ ...f.row, status: 'archived', archivedAt: now });
  expect((await manageConversation(f.prisma, ctx, request('restore'))).releaseRetention).toBe(false);
  expect((await readManagementRequest(f.prisma, ctx, request('restore'))).releaseRetention).toBe(false);
});
test('expired Trash, invalid transitions and request-ID collisions refuse', async () => {
  const f = fixture(); f.setRow({ ...f.row, status: 'trashed', restoreUntil: now });
  await expect(manageConversation(f.prisma, ctx, request('restore'))).rejects.toThrow('RESTORE_EXPIRED');
  f.setRow({ ...f.row, status: 'active', restoreUntil: null });
  await expect(manageConversation(f.prisma, ctx, request('restore'))).rejects.toThrow('Chat is not archived or in Trash');
  await manageConversation(f.prisma, ctx, request('archive'));
  await expect(readManagementRequest(f.prisma, ctx, { ...request('restore'), expectedRevision: '1' })).rejects.toThrow('REQUEST_ID_CONFLICT');
});
test('legacy mutation cannot bypass native CAS; unbound legacy rows remain supported', async () => {
  const findFirst = jest.fn(async () => ({ requestId }));
  const tx = { clioConversationBootstrapReceipt: { findFirst } };
  await expect(assertLegacyManagementAllowed(tx as never, tenantId, conversationId)).rejects.toThrow('VERSIONED_CONVERSATION_MANAGEMENT_REQUIRED');
  findFirst.mockResolvedValue(null as never);
  await expect(assertLegacyManagementAllowed(tx as never, tenantId, conversationId)).resolves.toBeUndefined();
});
