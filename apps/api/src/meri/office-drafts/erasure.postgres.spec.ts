import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { conversationMemoryRetentionFixture } from '../../memory/memory-conversation-retention.postgres-fixture.js';
import { finalizeConversationRetention, verifyConversationRetention } from '../conversation-management/retention.js';
import { MANAGEMENT_VERSION, TRASH_MS, managementDigest } from '../conversation-management/contract.js';
import { officeDraftFixture } from './postgres-scenario.js';
import { openDraft, saveDraft, discardDraft, readDraft } from './store.js';

const url = process.env.MEMORY_CONVERSATION_TEST_DATABASE_URL;
(url ? describe : describe.skip)('Office erasure at canonical chat finalization, ordinary PostgreSQL role', () => {
  let store: Awaited<ReturnType<typeof conversationMemoryRetentionFixture>>, prisma: PrismaService;
  beforeAll(async () => {
    store = await conversationMemoryRetentionFixture(url!);
    prisma = store.prisma;
  }, 60000);
  afterAll(async () => { await store?.db.$disconnect(); });
  const fixture = (tenantId?: string) => officeDraftFixture(store.db, prisma, tenantId);
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function saved(f: Fixture) { await f.lock(); await saveDraft(f.ports, f.save('Synthetic private draft')); }
  async function rows(f: Fixture) {
    return store.db.$queryRaw<Array<{ snapshot: Record<string, unknown> }>>`SELECT to_jsonb(d) AS snapshot
      FROM meri_office_drafts d WHERE tenant_id=${f.ports.ctx.tenantId}::uuid
        AND conversation_id=${f.key.conversationId}::uuid ORDER BY draft_id`;
  }
  // Model a partial backup restore that bypassed its FK. Only the synthetic
  // fixture administrator can do this; runtime repair still uses capiro_app.
  async function restore(snapshot: Record<string, unknown>) {
    await store.db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role=replica');
      await tx.$executeRaw`INSERT INTO meri_office_drafts SELECT *
        FROM jsonb_populate_record(NULL::meri_office_drafts,${JSON.stringify(snapshot)}::jsonb)`;
    });
  }
  async function expiredTrash(f: Fixture, expired = true) {
    const requestId = randomUUID(), trashedAt = new Date(Date.now() - (expired ? TRASH_MS + 60000 : 0)),
      restoreUntil = new Date(+trashedAt + TRASH_MS), { tenantId, userId } = f.ports.ctx;
    await store.scoped(tenantId, async tx => {
      await tx.clioConversation.update({ where: { id: f.key.conversationId }, data: {
        status: 'trashed', metadataRevision: 1n, archivedAt: trashedAt, trashedAt, restoreUntil } });
      await tx.clioConversationManagementReceipt.create({ data: { tenantId, actorUserId: userId, requestId,
        conversationId: f.key.conversationId,
        requestSha256: managementDigest({ version: MANAGEMENT_VERSION, operation: 'trash', requestId,
          conversationId: f.key.conversationId, expectedRevision: '0' }),
        receipt: { releaseRetention: false, suppressionRequestId: null, receipt: {
          version: MANAGEMENT_VERSION, requestId, conversation: {
            conversationId: f.key.conversationId, status: 'trashed', revision: '1', scopeKind: 'client',
            clientId: f.clientId, trashedAt: trashedAt.toISOString(), restoreUntil: restoreUntil.toISOString(),
          },
        } },
      } });
    });
    return { tenantId, conversationId: f.key.conversationId, ownerActorId: userId,
      requestId, revision: '1', restoreUntilMs: +restoreUntil };
  }
  function interceptDelete(before: (tx: Prisma.TransactionClient) => Promise<void>,
    after: () => Promise<void> = async () => {}) {
    return { ...prisma, withSystem: <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
      prisma.withSystem(tx => work(new Proxy(tx, { get(target, key) {
        if (key !== 'clioConversation') return Reflect.get(target, key);
        return new Proxy(target.clioConversation, { get(delegate, name) {
          if (name !== 'deleteMany') return Reflect.get(delegate, name);
          return async (args: Prisma.ClioConversationDeleteManyArgs) => {
            await before(tx);
            const result = await delegate.deleteMany(args);
            await after();
            return result;
          };
        } });
      } }))),
    } as PrismaService;
  }

  it('cascades saved and closed identities, preserving other chats and tenants; late Open/Save refuse', async () => {
    const f = await fixture(), sibling = await fixture(f.ports.ctx.tenantId), foreign = await fixture();
    for (const item of [f, sibling, foreign]) await saved(item);
    const closed = { ...f.source, draftId: randomUUID() };
    await openDraft(f.ports, closed);
    await discardDraft(f.ports, { conversationId: closed.conversationId, draftId: closed.draftId });
    const command = await expiredTrash(f);
    expect(await rows(f)).toHaveLength(2);
    await expect(verifyConversationRetention(prisma, command)).resolves.toMatchObject({ erased: false });
    await expect(finalizeConversationRetention(prisma, command)).resolves.toMatchObject({ erased: true, replayed: false });
    expect(await rows(f)).toEqual([]);
    await expect(verifyConversationRetention(prisma, command)).resolves.toMatchObject({ erased: true });
    for (const item of [sibling, foreign]) expect((await readDraft(item.ports, item.key)).sequence).toBe(1);
    for (const source of [f.source, { ...f.source, draftId: randomUUID() }])
      await expect(openDraft(f.ports, source)).rejects.toThrow('OFFICE_DRAFT_UNAVAILABLE');
    await expect(saveDraft(f.ports, f.save('late', 1))).rejects.toThrow('OFFICE_DRAFT_UNAVAILABLE');
  });

  it.each([false, true])('detects and repairs restored orphan rows, including metadata-only closed identities (closed=%s)', async closed => {
    const f = await fixture(), other = await fixture(); await saved(f); await saved(other);
    if (closed) await discardDraft(f.ports, f.key);
    const snapshot = (await rows(f))[0]!.snapshot, command = await expiredTrash(f);
    await finalizeConversationRetention(prisma, command);
    await expect(verifyConversationRetention(prisma, command)).resolves.toMatchObject({ erased: true });
    await restore(snapshot);
    await expect(verifyConversationRetention(prisma, command)).resolves.toMatchObject({ erased: false });
    await expect(finalizeConversationRetention(prisma, { ...command, requestId: randomUUID() }))
      .rejects.toThrow('Conversation retention identity unavailable');
    expect((await rows(f))[0]!.snapshot).toEqual(snapshot);
    await expect(finalizeConversationRetention(prisma, command)).resolves.toMatchObject({ erased: true, replayed: true });
    await expect(verifyConversationRetention(prisma, command)).resolves.toMatchObject({ erased: true });
    expect(await rows(f)).toEqual([]);
    expect((await readDraft(other.ports, other.key)).sequence).toBe(1);
  });

  it.each(['revision', 'request', 'owner', 'unexpired'])('refuses a mismatched or unexpired generation without deleting drafts (%s)', async mismatch => {
    const f = await fixture(); await saved(f);
    const before = await rows(f), command = await expiredTrash(f, mismatch !== 'unexpired');
    const invalid = { ...command, ...(mismatch === 'revision' ? { revision: '2' } :
      mismatch === 'request' ? { requestId: randomUUID() } : mismatch === 'owner' ? { ownerActorId: randomUUID() } : {}) };
    await expect(finalizeConversationRetention(prisma, invalid)).rejects.toThrow('RETENTION_GENERATION_NOT_EXPIRED');
    expect(await rows(f)).toEqual(before);
  });

  it('keeps Office rows when copied memory is held, then permits the original finalization when released', async () => {
    const f = await fixture(); await saved(f);
    const before = await rows(f);
    const held = await store.scoped(f.ports.ctx.tenantId, tx => tx.memoryCandidate.create({ data: {
      tenantId: f.ports.ctx.tenantId, proposedBy: f.ports.ctx.userId, sourceKind: 'explicit_user', scope: 'firm',
      payload: { value: 'Synthetic proposal', key: 'Synthetic title' }, legalHold: true,
      provenance: { tool: 'meri_memory_review', origin: { kind: 'conversation', conversationId: f.key.conversationId,
        runId: randomUUID(), commandId: randomUUID(), commandSha256: 'b'.repeat(64) } },
    } }));
    const command = await expiredTrash(f);
    await expect(finalizeConversationRetention(prisma, command)).rejects.toThrow('RETENTION_MEMORY_HELD_OR_REFERENCED');
    expect(await rows(f)).toEqual(before);
    await store.scoped(null, tx => tx.memoryCandidate.update({ where: { id: held.id }, data: { legalHold: false } }));
    await expect(finalizeConversationRetention(prisma, command)).resolves.toMatchObject({ erased: true });
    expect(await rows(f)).toEqual([]);
  });

  it('rolls the FK cascade and consumed receipt back when the finalization transaction fails', async () => {
    const f = await fixture(); await saved(f);
    const before = await rows(f), command = await expiredTrash(f);
    const failing = interceptDelete(async () => {}, async () => { throw Error('synthetic finalization failure'); });
    await expect(finalizeConversationRetention(failing, command)).rejects.toThrow('synthetic finalization failure');
    expect(await rows(f)).toEqual(before);
    expect(await store.db.clioConversation.count({ where: { id: f.key.conversationId } })).toBe(1);
    await expect(verifyConversationRetention(prisma, command)).resolves.toMatchObject({ erased: false });
    await expect(finalizeConversationRetention(prisma, command)).resolves.toMatchObject({ erased: true, replayed: false });
  });

  it.each(['save', 'open'])('a %s waiting behind finalization cannot recreate private bytes', async operation => {
    const f = await fixture(); await saved(f); const command = await expiredTrash(f);
    let entered!: (pid: number) => void, release!: () => void;
    const reached = new Promise<number>(r => { entered = r; }), hold = new Promise<void>(r => { release = r; });
    const pausing = interceptDelete(async tx => {
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      entered(row!.pid); await hold;
    });
    const finalizing = finalizeConversationRetention(pausing, command);
    finalizing.catch(() => undefined);
    let checked: Promise<void> | undefined;
    try {
      const pid = await reached;
      checked = expect(operation === 'save' ? saveDraft(f.ports, f.save('late', 1)) :
        openDraft(f.ports, { ...f.source, draftId: randomUUID() })).rejects.toThrow('OFFICE_DRAFT_UNAVAILABLE');
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const [row] = await store.db.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(
          SELECT 1 FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))) AS blocked`;
        if (row!.blocked) { blocked = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
      expect(blocked).toBe(true);
    } finally { release(); await finalizing; await checked; }
    expect(await rows(f)).toEqual([]);
    await expect(verifyConversationRetention(prisma, command)).resolves.toMatchObject({ erased: true });
  });
});
