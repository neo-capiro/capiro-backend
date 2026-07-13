/**
 * Read-only MEMORY RECALL PARITY report — the measurement gate for the Phase 1
 * canonical-store consolidation ("clio_memory becomes a derived view of
 * memory_items"), deferred because a naive collapse risks a silent recall
 * regression.
 *
 * WHY THIS EXISTS: two independent embedding-recall paths exist today —
 *   1. semanticMemorySearch (legacy-chat live auto-inject) reads
 *      `clio_memory.embedding` directly.
 *   2. the search_memory tool reads memory_items → context_embeddings.
 * The projection into memory_items (projectClioMemory) AND the clio_memory
 * embedding (embedMemory) are BOTH fire-and-forget. So re-pointing recall #1
 * onto the projection could silently drop any clio_memory row whose projection
 * is missing or unembedded. You cannot safely flip what you have not measured;
 * this quantifies that gap per tenant.
 *
 * Linkage (verified): clio_memory.id → memory_items{type='note',
 * slug='clio:'||id} → context_embeddings{source_type='memory_item',
 * source_id=memory_items.id::text}.
 *
 * THE GATE: `wouldDropOnCollapse` must be 0 for every tenant before recall is
 * re-pointed off clio_memory. It counts rows recallable TODAY (clio_memory
 * embedding present) that would NOT be recallable via the projection (no
 * projection row, or a projection with no embedding). Non-zero => run the
 * reconcile/backfill first, re-measure, and do not flip.
 *
 * SAFE: COUNT()/EXISTS reads only. No writes. Cross-tenant, so it sets the
 * bypass GUC inside a transaction (mirrors diag-clio-memory.ts / withSystem).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface TenantRow {
  tenant_id: string;
  /** Live (non-expired) clio_memory rows. */
  live: bigint;
  /** Live rows with a clio_memory embedding — recallable via path #1 today. */
  recallable_today: bigint;
  /** Live rows with NO memory_items projection at all. */
  projection_missing: bigint;
  /** Live rows WITH a projection but NO context_embeddings embedding on it. */
  projection_unembedded: bigint;
  /** THE GATE: recallable today (clio embedding) but not via the projection. */
  would_drop_on_collapse: bigint;
}

async function main(): Promise<void> {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
    return tx.$queryRawUnsafe<TenantRow[]>(
      `WITH live AS (
         SELECT
           cm.tenant_id,
           (cm.embedding IS NOT NULL) AS clio_recallable,
           EXISTS (
             SELECT 1 FROM memory_items mi
             WHERE mi.tenant_id = cm.tenant_id
               AND mi.type = 'note'
               AND mi.slug = 'clio:' || cm.id::text
           ) AS has_projection,
           EXISTS (
             SELECT 1 FROM memory_items mi
             JOIN context_embeddings ce
               ON ce.source_type = 'memory_item'
              AND ce.source_id = mi.id::text
             WHERE mi.tenant_id = cm.tenant_id
               AND mi.type = 'note'
               AND mi.slug = 'clio:' || cm.id::text
           ) AS projection_embedded
         FROM clio_memory cm
         WHERE cm.expires_at IS NULL OR cm.expires_at > now()
       )
       SELECT
         tenant_id,
         COUNT(*)::bigint AS live,
         COUNT(*) FILTER (WHERE clio_recallable)::bigint AS recallable_today,
         COUNT(*) FILTER (WHERE NOT has_projection)::bigint AS projection_missing,
         COUNT(*) FILTER (WHERE has_projection AND NOT projection_embedded)::bigint
           AS projection_unembedded,
         COUNT(*) FILTER (WHERE clio_recallable AND NOT projection_embedded)::bigint
           AS would_drop_on_collapse
       FROM live
       GROUP BY tenant_id
       ORDER BY would_drop_on_collapse DESC, live DESC`,
    );
  });

  const perTenant = rows.map((r) => ({
    tenantId: r.tenant_id,
    live: Number(r.live),
    recallableToday: Number(r.recallable_today),
    projectionMissing: Number(r.projection_missing),
    projectionUnembedded: Number(r.projection_unembedded),
    wouldDropOnCollapse: Number(r.would_drop_on_collapse),
  }));

  const totals = perTenant.reduce(
    (acc, t) => {
      acc.live += t.live;
      acc.recallableToday += t.recallableToday;
      acc.projectionMissing += t.projectionMissing;
      acc.projectionUnembedded += t.projectionUnembedded;
      acc.wouldDropOnCollapse += t.wouldDropOnCollapse;
      return acc;
    },
    {
      live: 0,
      recallableToday: 0,
      projectionMissing: 0,
      projectionUnembedded: 0,
      wouldDropOnCollapse: 0,
    },
  );

  // The gate: parityReady means recall can be re-pointed off clio_memory
  // without any live row silently dropping out of recall.
  const parityReady = totals.wouldDropOnCollapse === 0;

  console.log(
    'MEMORY_RECALL_PARITY_REPORT ' +
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          parityReady,
          gate: 'wouldDropOnCollapse must be 0 for every tenant before re-pointing recall',
          tenants: perTenant.length,
          totals,
          perTenant,
        },
        null,
        2,
      ),
  );

  // Non-zero gate => a loud, non-fatal signal (exit 2) so an operator or a
  // scheduled canary can distinguish "measured, not ready" from a crash.
  if (!parityReady) process.exitCode = 2;
}

main()
  .catch((err) => {
    console.error('MEMORY_RECALL_PARITY_ERR', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
