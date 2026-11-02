import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { conversationMemoryRetentionFixture } from './memory-conversation-retention.postgres-fixture.js';
import { ownerRetentionCase } from './memory-owner-retention.postgres-fixture.js';
import { finalizeConversationRetention, verifyConversationRetention } from '../meri/conversation-management/retention.js';
import { manageConversation } from '../meri/conversation-management/service.js';
import { MANAGEMENT_VERSION, TRASH_MS, managementDigest } from '../meri/conversation-management/contract.js';

const url = process.env.MEMORY_CONVERSATION_TEST_DATABASE_URL;
(url ? describe : describe.skip)('Core conversation and memory retention, ordinary PostgreSQL role', () => {
  let store: Awaited<ReturnType<typeof conversationMemoryRetentionFixture>>;
  beforeAll(async () => { store = await conversationMemoryRetentionFixture(url!); }, 60000);
  afterAll(async () => { await store?.db.$disconnect(); });
  async function fixture() {
    const f = await ownerRetentionCase(store), conversationId = randomUUID();
    await store.scoped(f.tenantId, async tx => {
      await tx.clioConversation.create({ data: { id: conversationId, tenantId: f.tenantId, userId: f.userId, title: 'Synthetic chat' } });
      await tx.clioConversationBootstrapReceipt.create({ data: { tenantId: f.tenantId, actorUserId: f.userId,
        conversationId, requestId: randomUUID(), scopeKind: 'general', clientId: null } });
    });
    return { ...f, conversationId, ctx: { tenantId: f.tenantId, userId: f.userId, role: 'user_admin' } as TenantContext };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function candidateData(f: Fixture, nested = false): Prisma.MemoryCandidateUncheckedCreateInput {
    const provenance = { tool: 'meri_memory_review', origin: { kind: 'conversation', conversationId: f.conversationId,
      runId: randomUUID(), commandId: randomUUID(), commandSha256: 'a'.repeat(64) } };
    return { tenantId: f.tenantId, proposedBy: f.userId, sourceKind: nested ? 'memory_correction' : 'explicit_user',
      scope: 'firm', payload: { value: 'Synthetic proposed content', key: 'Synthetic proposal title' },
      provenance: nested ? { meri: provenance } : provenance };
  }
  const add = (f: Fixture, nested = false, extra: Partial<Prisma.MemoryCandidateUncheckedCreateInput> = {}) =>
    store.scoped(f.tenantId, tx => tx.memoryCandidate.create({ data: { ...candidateData(f, nested), ...extra } }));
  async function expiredTrash(f: Fixture) {
    const requestId = randomUUID(), trashedAt = new Date(Date.now() - TRASH_MS - 60000),
      restoreUntil = new Date(+trashedAt + TRASH_MS);
    await store.scoped(f.tenantId, async tx => {
      await tx.clioConversation.update({ where: { id: f.conversationId }, data: { status: 'trashed', metadataRevision: 1n,
        archivedAt: trashedAt, trashedAt, restoreUntil } });
      await tx.clioConversationManagementReceipt.create({ data: { tenantId: f.tenantId, actorUserId: f.userId,
        requestId, conversationId: f.conversationId,
        requestSha256: managementDigest({ version: MANAGEMENT_VERSION, operation: 'trash', requestId,
          conversationId: f.conversationId, expectedRevision: '0' }),
        receipt: { releaseRetention: false, suppressionRequestId: null, receipt: { version: MANAGEMENT_VERSION, requestId,
          conversation: { conversationId: f.conversationId, status: 'trashed', revision: '1', scopeKind: 'general', clientId: null,
            trashedAt: trashedAt.toISOString(), restoreUntil: restoreUntil.toISOString() } } } } });
    });
    return { tenantId: f.tenantId, conversationId: f.conversationId, ownerActorId: f.userId,
      requestId, revision: '1', restoreUntilMs: +restoreUntil };
  }
  async function visible(f: Fixture) {
    return store.scoped(f.tenantId, async tx => {
      await tx.$executeRaw`SELECT set_config('app.current_user',${f.userId},true)`;
      return {
        candidates: await tx.memoryCandidate.count({ where: { tenantId: f.tenantId } }),
        reviews: await tx.reviewRequest.count({ where: { tenantId: f.tenantId } }),
        notifications: await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM memory_review_in_app_notification WHERE tenant_id=${f.tenantId}::uuid`,
      };
    });
  }
  async function seedNotifications(f: Fixture, candidateId: string) {
    await store.scoped(f.tenantId, async tx => {
      const review = await tx.reviewRequest.findFirstOrThrow({ where: { subjectId: candidateId } });
      await tx.$executeRaw`SELECT set_config('app.current_user',${f.userId},true)`;
      await tx.$executeRaw`INSERT INTO memory_review_in_app_notification(tenant_id,recipient_user_id,review_request_id,candidate_id,event_type,title)
        VALUES(${f.tenantId}::uuid,${f.userId}::uuid,${review.id}::uuid,${candidateId}::uuid,'review_assigned','Synthetic title')`;
      await tx.$executeRaw`INSERT INTO memory_review_notification_outbox(tenant_id,recipient_user_id,review_request_id,candidate_id,event_type,idempotency_key,payload_jsonb)
        VALUES(${f.tenantId}::uuid,${f.userId}::uuid,${review.id}::uuid,${candidateId}::uuid,'review_assigned',${randomUUID()},'{"title":"Synthetic title"}')`;
    });
  }
  it.each([false, true])('suppresses explicit addition/correction and review surfaces in Trash; Restore reopens only the window (nested=%s)', async nested => {
    const f = await fixture(), c = await add(f, nested);
    await seedNotifications(f, c.id);
    expect(await visible(f)).toMatchObject({ candidates: 1, reviews: 1, notifications: [{ n: 1n }] });
    const trash = await manageConversation(store.prisma, f.ctx, { version: MANAGEMENT_VERSION, operation: 'trash',
      conversationId: f.conversationId, requestId: randomUUID(), expectedRevision: '0' });
    expect(await visible(f)).toMatchObject({ candidates: 0, reviews: 0, notifications: [{ n: 0n }] });
    await expect(add(f, nested)).rejects.toThrow('MEMORY_CONVERSATION_UNAVAILABLE');
    await manageConversation(store.prisma, f.ctx, { version: MANAGEMENT_VERSION, operation: 'restore',
      conversationId: f.conversationId, requestId: randomUUID(), expectedRevision: trash.current.revision });
    expect(await visible(f)).toMatchObject({ candidates: 1, reviews: 1, notifications: [{ n: 1n }] });
  });
  it('erases pending/rejected copies and review titles, retaining approved and unrelated surface memory plus deletion tombstones', async () => {
    const f = await fixture(), published = await f.create('firm'), pending = await add(f), correction = await add(f, true),
      rejected = await add(f, false, { status: 'rejected' }), approved = await add(f, false, { status: 'approved', committedMemoryId: published.id }),
      surface = await add(f, false, { provenance: { tool: 'meri_memory_review', origin: { kind: 'surface' },
        sources: [{ kind: 'conversation_message', reference: f.conversationId }] } });
    await seedNotifications(f, pending.id);
    const other = await fixture(), otherCandidate = await add(other);
    const command = await expiredTrash(f);
    expect(await visible(f)).toMatchObject({ candidates: 2 });
    await expect(verifyConversationRetention(store.prisma, command)).resolves.toMatchObject({ erased: false });
    await expect(finalizeConversationRetention(store.prisma, command)).resolves.toMatchObject({ erased: true, replayed: false });
    await expect(verifyConversationRetention(store.prisma, command)).resolves.toMatchObject({ erased: true });
    await expect(finalizeConversationRetention(store.prisma, command)).resolves.toMatchObject({ erased: true, replayed: true });
    const retained = await store.scoped(null, tx => tx.memoryCandidate.findMany({ where: { tenantId: f.tenantId }, select: { id: true } }));
    expect(retained.map(row => row.id).sort()).toEqual([approved.id, surface.id].sort());
    expect(await store.scoped(f.tenantId, tx => tx.clioMemory.count({ where: { id: published.id } }))).toBe(1);
    const tombstones = await store.scoped(f.tenantId, tx => tx.memoryRetentionTombstone.count({ where: { tenantId: f.tenantId, store: 'memory_candidate' } }));
    expect(tombstones).toBe(3);
    expect(await store.scoped(null, tx => tx.reviewRequest.count({ where: { tenantId: f.tenantId, subjectId: { in: [pending.id, correction.id, rejected.id] } } }))).toBe(0);
    const copies = await store.scoped(null, tx => tx.$queryRaw<Array<{ n: bigint }>>`
      SELECT (SELECT count(*) FROM memory_review_in_app_notification WHERE candidate_id=${pending.id}::uuid)
        +(SELECT count(*) FROM memory_review_notification_outbox WHERE candidate_id=${pending.id}::uuid) AS n`);
    expect(copies).toEqual([{ n: 0n }]);
    expect(await store.scoped(other.tenantId, tx => tx.memoryCandidate.count({ where: { id: otherCandidate.id } }))).toBe(1);
    await expect(add(f)).rejects.toThrow('MEMORY_CONVERSATION_UNAVAILABLE');
  });
  it('an undisposed or renamed receipt payload blocks deletion and completion verification', async () => {
    const f = await fixture(), c = await add(f), command = await expiredTrash(f);
    await store.db.$executeRawUnsafe('ALTER TABLE clio_meri_memory_submissions ADD COLUMN retained_payload jsonb');
    try {
      await expect(finalizeConversationRetention(store.prisma, command)).rejects.toThrow('RETENTION_MEMORY_RECEIPT_DISPOSITION_REQUIRED');
      expect(await store.scoped(null, tx => tx.memoryCandidate.count({ where: { id: c.id } }))).toBe(1);
      await store.scoped(null, tx => tx.clioConversation.delete({ where: { id: f.conversationId } }));
      await expect(verifyConversationRetention(store.prisma, command)).rejects.toThrow('RETENTION_MEMORY_RECEIPT_DISPOSITION_REQUIRED');
    } finally {
      await store.db.$executeRawUnsafe('ALTER TABLE clio_meri_memory_submissions DROP COLUMN retained_payload');
    }
    await expect(finalizeConversationRetention(store.prisma, command)).resolves.toMatchObject({ erased: true, replayed: true });
  });
  it('holds block completion atomically; clearing a hold permits the exact original finalization', async () => {
    const f = await fixture(), held = await add(f, false, { legalHold: true }), ordinary = await add(f);
    const command = await expiredTrash(f);
    await expect(finalizeConversationRetention(store.prisma, command)).rejects.toThrow('RETENTION_MEMORY_HELD_OR_REFERENCED');
    expect(await store.scoped(null, tx => tx.memoryCandidate.count({ where: { id: { in: [held.id, ordinary.id] } } }))).toBe(2);
    expect(await store.scoped(null, tx => tx.clioConversation.count({ where: { id: f.conversationId } }))).toBe(1);
    await store.scoped(null, tx => tx.memoryCandidate.update({ where: { id: held.id }, data: { legalHold: false } }));
    await expect(finalizeConversationRetention(store.prisma, command)).resolves.toMatchObject({ erased: true });
  });
  it('retains lineage referenced by another independent proposal and refuses false completion', async () => {
    const f = await fixture(), source = await add(f);
    await add(f, false, { provenance: {}, predecessorCandidateId: source.id, revisionRootId: source.id, revisionNumber: 2 });
    const command = await expiredTrash(f);
    await expect(finalizeConversationRetention(store.prisma, command)).rejects.toThrow('RETENTION_MEMORY_HELD_OR_REFERENCED');
  });
  it('rejects another actor/tenant, malformed origin and attempts to detach a recorded origin', async () => {
    const f = await fixture(), other = await fixture(), original = await add(f);
    await expect(add(f, false, { proposedBy: other.userId })).rejects.toThrow('MEMORY_CONVERSATION_UNAVAILABLE');
    await expect(add(other, false, { provenance: candidateData(f).provenance })).rejects.toThrow('MEMORY_CONVERSATION_UNAVAILABLE');
    await expect(add(f, false, { provenance: { tool: 'meri_memory_review', origin: { kind: 'unknown' } } })).rejects.toThrow('MEMORY_CONVERSATION_UNAVAILABLE');
    await expect(store.scoped(f.tenantId, tx => tx.memoryCandidate.update({ where: { id: original.id }, data: { provenance: {} } }))).rejects.toThrow('MEMORY_CONVERSATION_ORIGIN_IMMUTABLE');
    expect(await store.scoped(other.tenantId, tx => tx.memoryCandidate.count({ where: { id: original.id } }))).toBe(0);
  });
  it('serializes activation with Trash even for a row read before suppression', async () => {
    const f = await fixture(), c = await add(f);
    let entered!: () => void, release!: () => void;
    const locked = new Promise<void>(resolve => { entered = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
    const writer = store.scoped(f.tenantId, async tx => {
      await tx.$queryRaw`SELECT id FROM memory_candidate WHERE id=${c.id}::uuid FOR UPDATE`;
      entered(); await proceed;
      // Even a trusted owner bypass must recheck the origin under the row lock.
      await tx.$executeRaw`SELECT set_config('app.bypass_rls','on',true)`;
      await tx.memoryCandidate.update({ where: { id: c.id }, data: { status: 'approved' } });
    });
    const outcome = expect(writer).rejects.toThrow('MEMORY_CONVERSATION_UNAVAILABLE');
    await locked;
    try { await expiredTrash(f); } finally { release(); }
    await outcome;
    expect(await store.scoped(null, tx => tx.memoryCandidate.findUnique({ where: { id: c.id }, select: { status: true } }))).toEqual({ status: 'pending' });
  });
  it('repairs an older metadata-only completion instead of trusting its tombstone alone', async () => {
    const f = await fixture(), c = await add(f), command = await expiredTrash(f);
    await store.scoped(null, tx => tx.clioConversation.delete({ where: { id: f.conversationId } }));
    expect(await store.scoped(null, tx => tx.memoryCandidate.count({ where: { id: c.id } }))).toBe(1);
    await expect(verifyConversationRetention(store.prisma, command)).resolves.toMatchObject({ erased: false });
    expect(await store.scoped(null, tx => tx.memoryCandidate.count({ where: { id: c.id } }))).toBe(1);
    await expect(finalizeConversationRetention(store.prisma, command)).resolves.toMatchObject({ erased: true, replayed: true });
    await expect(verifyConversationRetention(store.prisma, command)).resolves.toMatchObject({ erased: true });
    expect(await store.scoped(null, tx => tx.memoryCandidate.count({ where: { id: c.id } }))).toBe(0);
  });
});
