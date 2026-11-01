import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { conversationMemoryRetentionFixture } from '../../memory/memory-conversation-retention.postgres-fixture.js';
import { ownerRetentionCase } from '../../memory/memory-owner-retention.postgres-fixture.js';
import { MANAGEMENT_VERSION, TRASH_MS, managementDigest } from './contract.js';
import { manageConversation } from './service.js';
import { finalizeConversationRetention, verifyConversationRetention } from './retention.js';
import { listConversationDeletions, readConversationDeletion } from './deletion-read.js';

const url = process.env.MEMORY_CONVERSATION_TEST_DATABASE_URL;
(url ? describe : describe.skip)('content-free deletion readback through the ordinary PostgreSQL role', () => {
  let store: Awaited<ReturnType<typeof conversationMemoryRetentionFixture>>;
  beforeAll(async () => { store = await conversationMemoryRetentionFixture(url!); }, 60000);
  afterAll(async () => { await store?.db.$disconnect(); });
  async function owner() {
    const f = await ownerRetentionCase(store);
    const ctx = { tenantId: f.tenantId, userId: f.userId, clerkUserId: 'owner-' + f.userId, role: 'user_admin' } as TenantContext;
    return { ...f, ctx };
  }
  type Owner = Awaited<ReturnType<typeof owner>>;
  async function chat(f: Owner, expired = false, created?: { base: Date; microseconds: number }) {
    const conversationId = randomUUID(), requestId = randomUUID(), trashedAt = new Date(Date.now() - TRASH_MS - 10000);
    const restoreUntil = new Date(+trashedAt + TRASH_MS);
    await store.scoped(f.tenantId, async tx => {
      await tx.clioConversation.create({ data: { id: conversationId, tenantId: f.tenantId, userId: f.userId,
        title: 'Synthetic private title', ...(expired ? { status: 'trashed', metadataRevision: 1n, archivedAt: trashedAt, trashedAt, restoreUntil } : {}) } });
      await tx.clioConversationBootstrapReceipt.create({ data: { tenantId: f.tenantId, actorUserId: f.userId,
        conversationId, requestId: randomUUID(), scopeKind: 'general', clientId: null } });
      if (expired) {
        const digest = managementDigest({ version: MANAGEMENT_VERSION, requestId, conversationId, operation: 'trash', expectedRevision: '0' });
        const receipt = { releaseRetention: false, suppressionRequestId: null, receipt: { version: MANAGEMENT_VERSION, requestId,
          conversation: { conversationId, title: 'Synthetic private title', status: 'trashed', revision: '1',
            scopeKind: 'general', clientId: null, trashedAt: trashedAt.toISOString(), restoreUntil: restoreUntil.toISOString() } } };
        const at = created ? Prisma.sql`${created.base}::timestamptz + ${created.microseconds}::int * interval '1 microsecond'` : Prisma.sql`clock_timestamp()`;
        await tx.$executeRaw(Prisma.sql`INSERT INTO clio_conversation_management_receipts
          (tenant_id,actor_user_id,conversation_id,request_id,request_sha256,receipt,created_at)
          VALUES(${f.tenantId}::uuid,${f.userId}::uuid,${conversationId}::uuid,${requestId}::uuid,
            ${digest},${JSON.stringify(receipt)}::jsonb,${at})`);
      }
    });
    const request = { version: MANAGEMENT_VERSION, requestId, conversationId, operation: 'trash', expectedRevision: '0' };
    if (!expired) await manageConversation(store.prisma, f.ctx, request);
    return { request, finalize: { tenantId: f.tenantId, ownerActorId: f.userId, conversationId, requestId,
      revision: '1', restoreUntilMs: +restoreUntil } };
  }
  const read = (f: Owner, requestId: string) => readConversationDeletion(store.prisma, f.ctx, { version: MANAGEMENT_VERSION, requestId });
  const list = (f: Owner, before: unknown = null) => listConversationDeletions(store.prisma, f.ctx, { version: MANAGEMENT_VERSION, before });

  it('lists the exact owned request without title/content and does not equate Trash with erasure', async () => {
    const f = await owner(), c = await chat(f);
    const page = await list(f), status = await read(f, c.request.requestId);
    expect(page.requests).toHaveLength(1);
    expect(page.requests[0]).toMatchObject({ requestId: c.request.requestId, conversationId: c.request.conversationId, revision: '1' });
    expect(status.metadataState).toBe('present');
    expect(status.checkedAtMs).toBeGreaterThan(0);
    expect(JSON.stringify([page, status])).not.toContain('Synthetic private title');
    expect(status).not.toHaveProperty('completed');
  });

  it('canonical finalization scrubs metadata but preserves exact content-free request identity and replay', async () => {
    const f = await owner(), c = await chat(f, true);
    await expect(finalizeConversationRetention(store.prisma, c.finalize)).resolves.toMatchObject({ erased: true, replayed: false });
    await expect(verifyConversationRetention(store.prisma, c.finalize)).resolves.toMatchObject({ erased: true });
    await expect(finalizeConversationRetention(store.prisma, c.finalize)).resolves.toMatchObject({ erased: true, replayed: true });
    expect((await read(f, c.request.requestId)).metadataState).toBe('absent');
    expect((await list(f)).requests).toHaveLength(1);
    const receipt = await store.db.clioConversationManagementReceipt.findUniqueOrThrow({ where: {
      tenantId_actorUserId_requestId: { tenantId: f.tenantId, actorUserId: f.userId, requestId: c.request.requestId } } });
    expect(receipt.conversationId).toBeNull();
    expect(receipt.receipt).toEqual({ tombstone: true, deletion: { conversationId: c.request.conversationId,
      revision: '1', restoreUntil: new Date(c.finalize.restoreUntilMs).toISOString() } });
    await expect(store.scoped(f.tenantId, tx => tx.$executeRaw`UPDATE clio_conversation_management_receipts
      SET receipt='{}'::jsonb WHERE request_id=${c.request.requestId}::uuid`)).rejects.toThrow();
  });

  it('a later restore or new Trash does not count as the original request still pending', async () => {
    const f = await owner(), c = await chat(f);
    await manageConversation(store.prisma, f.ctx, { ...c.request, requestId: randomUUID(), operation: 'restore', expectedRevision: '1' });
    expect((await read(f, c.request.requestId)).metadataState).toBe('superseded');
    await manageConversation(store.prisma, f.ctx, { ...c.request, requestId: randomUUID(), expectedRevision: '2' });
    expect((await read(f, c.request.requestId)).metadataState).toBe('superseded');
  });

  it('current identity, role and membership bind both list and read, including after metadata erasure', async () => {
    const f = await owner(), other = await owner(), c = await chat(f, true);
    await finalizeConversationRetention(store.prisma, c.finalize);
    expect((await list(other)).requests).toEqual([]);
    await expect(read(other, c.request.requestId)).rejects.toThrow('not found');
    await expect(readConversationDeletion(store.prisma, { ...f.ctx, clerkUserId: other.ctx.clerkUserId },
      { version: MANAGEMENT_VERSION, requestId: c.request.requestId })).rejects.toThrow('access denied');
    await store.db.tenantMembership.deleteMany({ where: { tenantId: f.tenantId, userId: f.userId } });
    await expect(read(f, c.request.requestId)).rejects.toThrow('access denied');
    await expect(list(f)).rejects.toThrow('access denied');
  });

  it('paginates exact receipt identities without duplicate or missing rows', async () => {
    const f = await owner(), ids: string[] = [];
    for (let n = 0; n < 22; n++) ids.push((await chat(f, true,
      { base: new Date('2026-10-29T00:00:00.123Z'), microseconds: n })).request.requestId);
    const first = await list(f), second = await list(f, first.nextBefore);
    expect(first.requests).toHaveLength(20); expect(second.requests).toHaveLength(2); expect(second.nextBefore).toBeNull();
    expect([...first.requests, ...second.requests].map(x => x.requestId).sort()).toEqual(ids.sort());
  });

  it('refuses principal injection and malformed cursors before opening a transaction', async () => {
    const f = await owner(), c = await chat(f);
    await expect(readConversationDeletion(store.prisma, f.ctx, { version: MANAGEMENT_VERSION,
      requestId: c.request.requestId, tenantId: f.tenantId })).rejects.toThrow('Invalid deletion read');
    await expect(list(f, { requestId: c.request.requestId, createdAt: 'yesterday' })).rejects.toThrow('Invalid deletion cursor');
  });

  it('reports unavailable older history without inventing deletion requests or leaking another actor history', async () => {
    const f = await owner(), other = await owner(), requestId = randomUUID();
    // Simulate a restored historical content-free row in this guarded fixture.
    // The replica setting is transaction-local and never used by product code.
    await store.db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role=replica');
      await tx.clioConversationManagementReceipt.create({ data: { tenantId: f.tenantId, actorUserId: f.userId,
        requestId, requestSha256: 'a'.repeat(64), conversationId: null, receipt: { tombstone: true } } });
    });
    expect(await list(f)).toMatchObject({ requests: [], olderRequestsUnavailable: true });
    expect(await list(other)).toMatchObject({ requests: [], olderRequestsUnavailable: false });
    await expect(read(f, requestId)).rejects.toThrow('Deletion receipt unavailable');
  });
});
