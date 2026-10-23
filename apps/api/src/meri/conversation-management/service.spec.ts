import type { TenantContext } from '@capiro/shared';
import { MANAGEMENT_VERSION, TRASH_MS } from './contract.js';
import { assertLegacyManagementAllowed, manageConversation, readManagedConversationOwner, type ManagementPort } from './service.js';

// Synthetic transactions and canonical fence. No database or retention process.
const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const tenantId = id(1), actorId = id(2), conversationId = id(3), requestId = id(4);
const ctx = { tenantId, userId: actorId } as TenantContext;
const now = new Date('2026-10-23T00:00:00.000Z');
function fixture() {
  let row: any = { id: conversationId, tenantId, userId: actorId, clientId: null, title: 'Original', status: 'active',
    metadataRevision: 0n, updatedAt: now, archivedAt: null, trashedAt: null, restoreUntil: null,
    bootstrapReceipt: { tenantId, actorUserId: actorId, conversationId, scopeKind: 'general', clientId: null } };
  const receipts = new Map<string, any>(); const events: string[] = []; let failCommit = false;
  const tx = { $executeRaw: async () => {}, $queryRaw: async () => [{ now }],
    tenantMembership: { findFirst: async () => ({id:'synthetic-membership'}) },
    clioConversation: { findFirst: async () => row, update: async ({ data }: any) => {
      row = { ...row, ...data, metadataRevision: row.metadataRevision + 1n }; events.push('update'); return row;
    } },
    clioConversationManagementReceipt: { findUnique: async ({ where }: any) => receipts.get(where.tenantId_actorUserId_requestId.requestId) ?? null,
      create: async ({ data }: any) => { if (failCommit) throw Error('unknown commit'); receipts.set(data.requestId, data); events.push('receipt'); } },
  };
  const prisma = { withTenant: async (_tenant: string, work: (tx: any) => Promise<unknown>) => {
    const before = structuredClone(row);
    try { const result = await work(tx); events.push('commit'); return result; }
    catch (error) { row = before; throw error; }
  } };
  const fence = { suppress: jest.fn(async () => { events.push('suppress'); }), release: jest.fn(async () => { events.push('release'); }) };
  const port: ManagementPort = { withTerminalConversation: async (_input, work) => { events.push('fence'); return work(fence); } };
  return { prisma: prisma as never, port, fence, events, get row() { return row; }, setRow: (next: any) => { row = next; },
    failCommit: () => { failCommit = true; }, receipts };
}
const request = (operation: 'trash'|'archive'|'restore') => ({ version: MANAGEMENT_VERSION, requestId, conversationId, expectedRevision: '0', operation });
test('management is unavailable without the trusted canonical fence', async () => {
  const f = fixture(); await expect(manageConversation(f.prisma, ctx, request('trash'))).rejects.toThrow('MANAGEMENT_UNAVAILABLE');
  expect(f.events).toEqual([]);
});
test('retention ownership comes from the exact persisted binding, never a supplied actor or legacy null', async () => {
  const f = fixture();
  expect(await readManagedConversationOwner(f.prisma,{tenantId,conversationId})).toBe(actorId);
  f.setRow({...f.row,bootstrapReceipt:{...f.row.bootstrapReceipt,actorUserId:id(8)}});
  await expect(readManagedConversationOwner(f.prisma,{tenantId,conversationId})).rejects.toThrow('Chat not found');
  f.setRow({...f.row,bootstrapReceipt:null});
  await expect(readManagedConversationOwner(f.prisma,{tenantId,conversationId})).rejects.toThrow('Chat not found');
});
test('a deleted conversation replay never reconstructs its title from a retained request tombstone', async () => {
  const f = fixture(); await manageConversation(f.prisma,ctx,request('trash'),f.port);
  f.setRow(null);
  f.receipts.set(requestId,{requestSha256:'synthetic',conversationId:null,receipt:{tombstone:true}});
  await expect(manageConversation(f.prisma,ctx,request('trash'),f.port)).rejects.toThrow('Chat not found');
  expect(f.fence.release).not.toHaveBeenCalled();
});
test('Trash suppresses before commit, retains history, and offers exactly thirty days', async () => {
  const f = fixture(); const receipt = await manageConversation(f.prisma, ctx, request('trash'), f.port);
  expect(f.events).toEqual(['fence','suppress','update','receipt','commit']);
  expect(receipt.conversation).toMatchObject({ status: 'trashed', revision: '1', trashedAt: now.toISOString(), restoreUntil: new Date(+now + TRASH_MS).toISOString() });
  expect(f.fence.release).not.toHaveBeenCalled();
});
test('unknown Trash commit never compensates by releasing suppression', async () => {
  const f = fixture(); f.failCommit();
  await expect(manageConversation(f.prisma, ctx, request('trash'), f.port)).rejects.toThrow('unknown commit');
  expect(f.fence.suppress).toHaveBeenCalledTimes(1); expect(f.fence.release).not.toHaveBeenCalled();
});
test('stale CAS and another owner fail before suppression', async () => {
  const f = fixture();
  await expect(manageConversation(f.prisma, ctx, { ...request('trash'), expectedRevision: '9' }, f.port)).rejects.toThrow('STALE_REVISION');
  f.setRow({ ...f.row, userId: id(5) });
  await expect(manageConversation(f.prisma, ctx, request('trash'), f.port)).rejects.toThrow('Chat not found');
  expect(f.fence.suppress).not.toHaveBeenCalled();
});
test('Restore commits an exact receipt before canonical release; retries do not increment revision', async () => {
  const f = fixture(); f.setRow({ ...f.row, status: 'trashed', trashedAt: now, restoreUntil: new Date(+now + TRASH_MS) });
  const first = await manageConversation(f.prisma, ctx, request('restore'), f.port);
  expect(f.events).toEqual(['fence','update','receipt','commit','release']);
  expect(await manageConversation(f.prisma, ctx, request('restore'), f.port)).toEqual(first);
  expect(f.row.metadataRevision).toBe(1n);
});
test('an old Restore retry never releases a later Trash', async () => {
  const f = fixture(); f.setRow({ ...f.row, status: 'trashed', trashedAt: now, restoreUntil: new Date(+now + TRASH_MS) });
  await manageConversation(f.prisma, ctx, request('restore'), f.port);
  f.setRow({ ...f.row, status: 'trashed', metadataRevision: 2n }); f.fence.release.mockClear();
  await manageConversation(f.prisma, ctx, request('restore'), f.port);
  expect(f.fence.release).not.toHaveBeenCalled();
});
test('restoring Archive never releases a retention suppression, even on retry', async () => {
  const f = fixture(); f.setRow({ ...f.row, status: 'archived', archivedAt: now });
  await manageConversation(f.prisma, ctx, request('restore'), f.port);
  await manageConversation(f.prisma, ctx, request('restore'), f.port);
  expect(f.fence.release).not.toHaveBeenCalled();
});
test('expired Trash and reused request IDs refuse', async () => {
  const f = fixture(); f.setRow({ ...f.row, status: 'trashed', restoreUntil: now });
  await expect(manageConversation(f.prisma, ctx, request('restore'), f.port)).rejects.toThrow('RESTORE_EXPIRED');
  f.setRow({ ...f.row, status: 'active', restoreUntil: null });
  await manageConversation(f.prisma, ctx, request('archive'), f.port);
  await expect(manageConversation(f.prisma, ctx, { ...request('restore'), expectedRevision: '1' }, f.port)).rejects.toThrow('REQUEST_ID_CONFLICT');
});
test('legacy mutation routes cannot bypass metadata CAS for bound conversations', async () => {
  const tx = { clioConversationBootstrapReceipt: { findFirst: async () => ({ requestId }) } };
  await expect(assertLegacyManagementAllowed(tx as never, tenantId, conversationId)).rejects.toThrow('VERSIONED_CONVERSATION_MANAGEMENT_REQUIRED');
});
