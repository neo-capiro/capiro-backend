import { randomUUID } from 'node:crypto';
import {
  ownerRetentionDatabase,
  ownerRetentionCase,
} from './memory-owner-retention.postgres-fixture.js';
import { purgeMemoryOwnerRetentionInTx } from './memory-owner-retention.js';
import { embedMemoryItem } from './memory-embedding-lifecycle.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';

const url = process.env.MEMORY_OWNER_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('memory owner periods at the ordinary PostgreSQL role boundary', () => {
  let store: Awaited<ReturnType<typeof ownerRetentionDatabase>>;
  beforeAll(async () => {
    store = await ownerRetentionDatabase(url!);
  }, 60000);
  afterAll(async () => {
    await store?.db.$disconnect();
  });
  const fixture = () => ownerRetentionCase(store);
  async function corpus(
    f: Awaited<ReturnType<typeof fixture>>,
    held = false,
    scope: 'user_private' | 'client' = 'user_private',
  ) {
    const source = await f.create(scope);
    const item = await store.scoped(f.tenantId, (tx) =>
      tx.memoryItem.create({
        data: {
          tenantId: f.tenantId,
          clientId: scope === 'client' ? f.clientId : null,
          ownerUserId: scope === 'user_private' ? f.userId : null,
          type: 'note',
          visibility: scope === 'user_private' ? 'user' : 'tenant',
          slug: 'clio:' + source.id,
          title: 'Synthetic owned memory',
          source: 'manual',
          sections: [],
          governedStatus: 'active',
          memoryScope: scope,
          legalHold: held,
        },
      }),
    );
    const candidate = await store.scoped(f.tenantId, (tx) =>
      tx.memoryCandidate.create({
        data: {
          tenantId: f.tenantId,
          proposedBy: f.userId,
          sourceKind: 'settings_sections',
          scope: scope === 'user_private' ? 'personal' : 'client',
          clientId: scope === 'client' ? f.clientId : null,
          payload: { value: 'Synthetic content' },
          provenance: {},
          committedMemoryId: source.id,
          committedMemoryItemId: item.id,
          legalHold: held,
        },
      }),
    );
    return { source, item, candidate };
  }
  async function closeFixturePeriod(id: string, daysAgo: number) {
    // Only synthetic rows in this isolated DB: seed a past transition, without a
    // production clock override. The immutable-period trigger and deadline check remain on.
    await store.db
      .$executeRaw`WITH stamp AS MATERIALIZED(SELECT clock_timestamp()-${daysAgo}*interval '24 hours' AS ended)
      UPDATE memory_retention_subjects SET closed_at=stamp.ended,
      purge_after=stamp.ended+CASE WHEN owner_kind='personal' THEN interval '720 hours' ELSE interval '2160 hours' END,
      closed_reason='synthetic_transition' FROM stamp WHERE id=${id}::uuid`;
  }
  const embeddingPrisma = () => ({
    withSystem: (fn: Parameters<typeof store.scoped>[1]) => store.scoped(null, fn),
    $queryRawUnsafe: (sql: string, ...params: unknown[]) =>
      store.scoped(null, (tx) => tx.$queryRawUnsafe(sql, ...params)),
    $transaction: (fn: Parameters<typeof store.scoped>[1]) => store.scoped(null, fn),
  });
  it('closes personal content immediately, schedules thirty days and never reopens the old period', async () => {
    const f = await fixture(),
      personal = await f.create('user_private'),
      firm = await f.create('firm'),
      client = await f.create('client');
    expect(personal.retentionSubjectId).toBeTruthy();
    await store.scoped(f.tenantId, (tx) =>
      tx.tenantMembership.updateMany({
        where: { tenantId: f.tenantId, userId: f.userId },
        data: { status: 'removed' },
      }),
    );
    expect(
      await store.scoped(f.tenantId, (tx) =>
        tx.clioMemory.findMany({ where: { tenantId: f.tenantId } }),
      ),
    ).toHaveLength(2);
    const closed = await store.db.memoryRetentionSubject.findUniqueOrThrow({
      where: { id: personal.retentionSubjectId! },
    });
    expect(closed.purgeAfter!.getTime() - closed.closedAt!.getTime()).toBe(30 * 86400000);
    await expect(f.create('user_private')).rejects.toThrow('memory_owner_unavailable');
    await store.db.tenantMembership.updateMany({
      where: { tenantId: f.tenantId, userId: f.userId },
      data: { status: 'active' },
    });
    const later = await f.create('user_private');
    expect(later.retentionSubjectId).not.toBe(personal.retentionSubjectId);
    expect(
      await store.scoped(f.tenantId, (tx) =>
        tx.clioMemory.findMany({ where: { tenantId: f.tenantId } }),
      ),
    ).toHaveLength(3);
    await expect(
      store.scoped(null, (tx) =>
        tx.clioMemory.update({
          where: { id: personal.id },
          data: { value: 'Must stay suppressed' },
        }),
      ),
    ).rejects.toThrow('memory_ownership_closed');
    for (const id of [firm.retentionSubjectId!, client.retentionSubjectId!])
      expect(
        (await store.db.memoryRetentionSubject.findUniqueOrThrow({ where: { id } })).closedAt,
      ).toBeNull();
  });
  it('client closure has a ninety day deadline and reactivation cannot rebind old sources', async () => {
    const f = await fixture(),
      original = await f.create('client');
    await store.scoped(f.tenantId, (tx) =>
      tx.client.update({ where: { id: f.clientId }, data: { status: 'archived' } }),
    );
    expect(
      await store.scoped(f.tenantId, (tx) =>
        tx.clioMemory.findMany({ where: { tenantId: f.tenantId } }),
      ),
    ).toEqual([]);
    const closed = await store.db.memoryRetentionSubject.findUniqueOrThrow({
      where: { id: original.retentionSubjectId! },
    });
    expect(closed.purgeAfter!.getTime() - closed.closedAt!.getTime()).toBe(90 * 86400000);
    await store.db.client.update({ where: { id: f.clientId }, data: { status: 'active' } });
    const later = await f.create('client');
    await expect(
      store.scoped(null, (tx) =>
        tx.clioMemory.update({
          where: { id: original.id },
          data: { retentionSubjectId: later.retentionSubjectId },
        }),
      ),
    ).rejects.toThrow('memory_ownership_rebinding_refused');
  });
  it('rejects missing ownership, cross-tenant period substitution and direct ordinary-role period changes', async () => {
    const f = await fixture(),
      other = await fixture(),
      foreign = await other.create('firm');
    await expect(
      store.scoped(f.tenantId, (tx) =>
        tx.clioMemory.create({
          data: {
            tenantId: f.tenantId,
            scope: 'user_private',
            key: randomUUID(),
            value: 'Invalid owner',
          },
        }),
      ),
    ).rejects.toThrow('memory_ownership_invalid');
    await expect(
      store.scoped(f.tenantId, (tx) =>
        tx.clioMemory.create({
          data: {
            tenantId: f.tenantId,
            scope: 'firm',
            key: randomUUID(),
            value: 'Invalid binding',
            retentionSubjectId: foreign.retentionSubjectId,
          },
        }),
      ),
    ).rejects.toThrow('memory_ownership_closed');
    expect(
      await store.scoped(f.tenantId, (tx) =>
        tx.memoryRetentionSubject.findMany({ where: { tenantId: other.tenantId } }),
      ),
    ).toEqual([]);
    expect(
      await store.scoped(
        f.tenantId,
        (tx) =>
          tx.$queryRaw`SELECT memory_retention_visible(${other.tenantId}::uuid,${foreign.retentionSubjectId}::uuid) AS visible`,
      ),
    ).toEqual([{ visible: false }]);
    await expect(
      store.scoped(null, (tx) =>
        tx.memoryRetentionSubject.update({
          where: { id: foreign.retentionSubjectId! },
          data: { closedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(/permission denied/);
  });
  it('purges due content, retains held content and refuses an old INSERT after cleanup', async () => {
    const f = await fixture(),
      removed = await corpus(f),
      held = await corpus(f, true),
      firm = await f.create('firm');
    await closeFixturePeriod(removed.source.retentionSubjectId!, 31);
    await store.db.tenantMembership.updateMany({
      where: { tenantId: f.tenantId, userId: f.userId },
      data: { status: 'removed' },
    });
    const result = await store.scoped(null, (tx) => purgeMemoryOwnerRetentionInTx(tx, f.tenantId));
    expect(result.items).toBe(1);
    expect(result.candidates).toBe(1);
    expect(result.clio).toBe(1);
    expect(result.remainingCoreRows).toBe(3);
    expect(await store.db.memoryRetentionTombstone.count({ where: { tenantId: f.tenantId } })).toBe(
      3,
    );
    expect(await store.db.clioMemory.findUnique({ where: { id: firm.id } })).not.toBeNull();
    await store.db.tenantMembership.updateMany({
      where: { tenantId: f.tenantId, userId: f.userId },
      data: { status: 'active' },
    });
    await expect(
      store.scoped(f.tenantId, (tx) =>
        tx.clioMemory.create({
          data: {
            id: removed.source.id,
            tenantId: f.tenantId,
            scope: 'user_private',
            ownerUserId: f.userId,
            key: randomUUID(),
            value: 'Late retry',
          },
        }),
      ),
    ).rejects.toThrow('memory_content_purged');
    await store.scoped(null, (tx) =>
      tx.memoryCandidate.update({ where: { id: held.candidate.id }, data: { legalHold: false } }),
    );
    await store.scoped(null, (tx) =>
      tx.memoryItem.update({ where: { id: held.item.id }, data: { legalHold: false } }),
    );
    const released = await store.scoped(null, (tx) =>
      purgeMemoryOwnerRetentionInTx(tx, f.tenantId),
    );
    expect(released.remainingCoreRows).toBe(0);
    expect(await store.db.memoryRetentionTombstone.count({ where: { tenantId: f.tenantId } })).toBe(
      6,
    );
    expect(
      (await store.scoped(null, (tx) => purgeMemoryOwnerRetentionInTx(tx, f.tenantId))).periods,
    ).toBe(0);
  });
  it('suppresses content before the deadline and leaves a not-yet-due period intact', async () => {
    const f = await fixture(),
      value = await corpus(f, false, 'client');
    await closeFixturePeriod(value.source.retentionSubjectId!, 89);
    await store.db.client.update({ where: { id: f.clientId }, data: { status: 'archived' } });
    expect(
      await store.scoped(f.tenantId, (tx) =>
        tx.memoryItem.findMany({ where: { tenantId: f.tenantId } }),
      ),
    ).toEqual([]);
    expect(
      (await store.scoped(null, (tx) => purgeMemoryOwnerRetentionInTx(tx, f.tenantId))).items,
    ).toBe(0);
    expect(await store.db.memoryItem.findUnique({ where: { id: value.item.id } })).not.toBeNull();
  });
  it('cannot publish a provider result into an ownership period closed during embedding', async () => {
    const f = await fixture(),
      value = await corpus(f);
    const provider = {
      metadata: { provider: 'synthetic', model: 'fixture', modelVersion: '1', dimensions: 1024 },
      embed: jest.fn(async () => {
        await store.db.tenantMembership.updateMany({
          where: { tenantId: f.tenantId, userId: f.userId },
          data: { status: 'removed' },
        });
        return Array(1024).fill(0);
      }),
      embedBatch: jest.fn(),
    } as EmbeddingProvider;
    const result = await embedMemoryItem(
      embeddingPrisma() as never,
      {
        tenantId: f.tenantId,
        sourceId: value.item.id,
        ownerUserId: f.userId,
        clientId: null,
        text: 'Synthetic owned memory',
        sourceContent: { title: value.item.title, sections: [] },
      },
      provider,
    );
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(result).toBe('skipped');
    expect(await store.db.contextEmbedding.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });
  it('indexes current memory and immediately hides its vector and incoming graph relationships on closure', async () => {
    const f = await fixture(),
      value = await corpus(f);
    const provider = {
      metadata: { provider: 'synthetic', model: 'fixture', modelVersion: '1', dimensions: 1024 },
      embed: jest.fn(async () => Array(1024).fill(0)),
      embedBatch: jest.fn(),
    } as EmbeddingProvider;
    expect(
      await embedMemoryItem(
        embeddingPrisma() as never,
        {
          tenantId: f.tenantId,
          sourceId: value.item.id,
          ownerUserId: f.userId,
          clientId: null,
          text: 'Synthetic owned memory',
          sourceContent: { title: value.item.title, sections: [] },
        },
        provider,
      ),
    ).toBe('inserted');
    const firm = await store.scoped(f.tenantId, (tx) =>
      tx.memoryItem.create({
        data: {
          tenantId: f.tenantId,
          type: 'note',
          slug: randomUUID(),
          title: 'Synthetic firm memory',
          source: 'manual',
          governedStatus: 'active',
        },
      }),
    );
    await store.scoped(f.tenantId, (tx) =>
      tx.memoryEdge.create({
        data: {
          tenantId: f.tenantId,
          srcItemId: firm.id,
          relation: 'related',
          dstType: value.item.type,
          dstSlug: value.item.slug,
        },
      }),
    );
    expect(
      await store.scoped(f.tenantId, (tx) =>
        tx.contextEmbedding.count({ where: { tenantId: f.tenantId } }),
      ),
    ).toBe(1);
    expect(
      await store.scoped(f.tenantId, (tx) =>
        tx.memoryEdge.count({ where: { tenantId: f.tenantId } }),
      ),
    ).toBe(1);
    await store.db.tenantMembership.updateMany({
      where: { tenantId: f.tenantId, userId: f.userId },
      data: { status: 'removed' },
    });
    expect(
      await store.scoped(f.tenantId, (tx) =>
        tx.contextEmbedding.count({ where: { tenantId: f.tenantId } }),
      ),
    ).toBe(0);
    expect(
      await store.scoped(f.tenantId, (tx) =>
        tx.memoryEdge.count({ where: { tenantId: f.tenantId } }),
      ),
    ).toBe(0);
    expect(
      await store.scoped(f.tenantId, async (tx) => {
        await tx.$queryRaw`SELECT memory_retention_edge_visible(${f.tenantId}::uuid,${firm.id}::uuid,${value.item.type},${value.item.slug})`;
        return tx.$queryRaw`SELECT rls_bypass() AS bypass`;
      }),
    ).toEqual([{ bypass: false }]);
    await expect(
      store.scoped(
        f.tenantId,
        (tx) =>
          tx.$queryRaw`SELECT memory_retention_edge_sources(${f.tenantId}::uuid,${firm.id}::uuid,${value.item.type},${value.item.slug})`,
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('creates no function-level app.bypass_rls setting', async () => {
    expect(
      await store.db.$queryRawUnsafe(
        `SELECT count(*)::int AS count FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='public' AND p.proconfig IS NOT NULL
           AND EXISTS(SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE '%bypass_rls%')`,
      ),
    ).toEqual([{ count: 0 }]);
  });

  it('restores the caller GUC when the edge helper fails after widening', async () => {
    const f = await fixture(),
      value = await corpus(f),
      owner = store.migrationRole;
    // A real in-body failure after the widening: the SECURITY DEFINER helper
    // cannot execute its callee while that temporary revoke is in place.
    await store.db.$executeRawUnsafe(
      `REVOKE EXECUTE ON FUNCTION memory_retention_visible(uuid,uuid) FROM PUBLIC, "${owner}"`,
    );
    try {
      expect(
        await store.scoped(f.tenantId, async (tx) => {
          await tx.$executeRawUnsafe(`DO $$ BEGIN
            BEGIN
              PERFORM memory_retention_edge_visible('${f.tenantId}'::uuid,
                '${value.item.id}'::uuid,'${value.item.type}','${value.item.slug}');
              RAISE EXCEPTION 'edge helper unexpectedly succeeded';
            EXCEPTION WHEN insufficient_privilege THEN NULL;
            END;
          END $$`);
          return tx.$queryRaw`SELECT rls_bypass() AS bypass, current_setting('app.bypass_rls',true) AS guc`;
        }),
      ).toEqual([{ bypass: false, guc: '' }]);
    } finally {
      await store.db.$executeRawUnsafe(
        'GRANT EXECUTE ON FUNCTION memory_retention_visible(uuid,uuid) TO PUBLIC',
      );
    }
    expect(
      await store.scoped(
        f.tenantId,
        (tx) =>
          tx.$queryRaw`SELECT memory_retention_edge_visible(${f.tenantId}::uuid,${value.item.id}::uuid,${value.item.type},${value.item.slug}) AS visible`,
      ),
    ).toEqual([{ visible: true }]);
  });

  it('cleans a due closed client and its old grants without deleting firm memory', async () => {
    const f = await fixture(),
      value = await corpus(f, false, 'client'),
      firm = await f.create('firm');
    const createdAt = new Date(Date.now() - 92 * 86400000);
    await store.db.clientMemoryAccess.create({
      data: { tenantId: f.tenantId, clientId: f.clientId, userId: f.userId, createdAt },
    });
    await store.db.memoryAccessGrant.create({
      data: {
        tenantId: f.tenantId,
        clientId: f.clientId,
        userId: f.userId,
        permissions: ['edit'],
        reason: 'Synthetic grant',
        createdAt,
      },
    });
    await closeFixturePeriod(value.source.retentionSubjectId!, 91);
    await store.db.client.update({ where: { id: f.clientId }, data: { status: 'archived' } });
    const result = await store.scoped(null, (tx) => purgeMemoryOwnerRetentionInTx(tx, f.tenantId));
    expect(result).toMatchObject({
      items: 1,
      clio: 1,
      candidates: 1,
      grants: 2,
      remainingCoreRows: 0,
    });
    expect(await store.db.clioMemory.findUnique({ where: { id: firm.id } })).not.toBeNull();
  });

  it('rolls content and deletion outcomes back together if the final audit fails', async () => {
    const f = await fixture(),
      value = await corpus(f);
    await closeFixturePeriod(value.source.retentionSubjectId!, 31);
    await expect(
      store.scoped(null, async (tx) => {
        const spy = jest.spyOn(tx.auditLog, 'create').mockImplementation(() => {
          throw Error('Synthetic audit failure');
        });
        try {
          return await purgeMemoryOwnerRetentionInTx(tx, f.tenantId);
        } finally {
          spy.mockRestore();
        }
      }),
    ).rejects.toThrow('Synthetic audit failure');
    expect(await store.db.clioMemory.findUnique({ where: { id: value.source.id } })).not.toBeNull();
    expect(await store.db.memoryItem.findUnique({ where: { id: value.item.id } })).not.toBeNull();
    expect(
      await store.db.memoryCandidate.findUnique({ where: { id: value.candidate.id } }),
    ).not.toBeNull();
    expect(await store.db.memoryRetentionTombstone.count({ where: { tenantId: f.tenantId } })).toBe(
      0,
    );
  });

  it('cannot move an existing row to a new identity before deletion', async () => {
    const f = await fixture(),
      value = await f.create('user_private');
    await expect(
      store.scoped(f.tenantId, (tx) =>
        tx.clioMemory.update({ where: { id: value.id }, data: { id: randomUUID() } }),
      ),
    ).rejects.toThrow('memory_identity_immutable');
    expect(await store.db.clioMemory.findUnique({ where: { id: value.id } })).not.toBeNull();
  });
});
