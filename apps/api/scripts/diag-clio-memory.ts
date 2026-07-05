/**
 * Read-only MERI MEMORY HEALTH report (W2 M3). Per-tenant counts: total memory
 * rows, firm vs user_private split, % with an embedding, and oldest/newest +
 * top sources. Lets us see whether semantic retrieval can actually work in prod
 * (no embeddings => memory only surfaces via the keyword/recency fallback).
 *
 * SAFE: COUNT()/GROUP BY reads only. No writes.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface TenantRow {
  tenant_id: string;
  total: bigint;
  firm: bigint;
  user_private: bigint;
  with_embedding: bigint;
  oldest: Date | null;
  newest: Date | null;
}

async function main(): Promise<void> {
  // clio_memory is RLS-protected; this read-only diag runs cross-tenant, so it
  // must set the bypass GUC inside a transaction or FORCE ROW LEVEL SECURITY
  // returns 0 rows (mirrors PrismaService.withSystem / embed-backfill.ts).
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
    return tx.$queryRawUnsafe<TenantRow[]>(
      `SELECT
       tenant_id,
       COUNT(*)::bigint AS total,
       COUNT(*) FILTER (WHERE scope = 'firm')::bigint AS firm,
       COUNT(*) FILTER (WHERE scope = 'user_private')::bigint AS user_private,
       COUNT(*) FILTER (WHERE embedding IS NOT NULL)::bigint AS with_embedding,
       MIN(created_at) AS oldest,
       MAX(created_at) AS newest
     FROM clio_memory
     GROUP BY tenant_id
     ORDER BY total DESC`,
    );
  });

  const perTenant = rows.map((r) => {
    const total = Number(r.total);
    const withEmbedding = Number(r.with_embedding);
    return {
      tenantId: r.tenant_id,
      total,
      firm: Number(r.firm),
      userPrivate: Number(r.user_private),
      withEmbedding,
      embeddingPct: total > 0 ? Math.round((withEmbedding / total) * 1000) / 10 : 0,
      oldest: r.oldest ? new Date(r.oldest).toISOString().slice(0, 10) : null,
      newest: r.newest ? new Date(r.newest).toISOString().slice(0, 10) : null,
    };
  });

  const totals = perTenant.reduce(
    (acc, t) => {
      acc.total += t.total;
      acc.withEmbedding += t.withEmbedding;
      return acc;
    },
    { total: 0, withEmbedding: 0 },
  );

  console.log(
    'CLIO_MEMORY_REPORT ' +
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          tenants: perTenant.length,
          totalRows: totals.total,
          totalWithEmbedding: totals.withEmbedding,
          overallEmbeddingPct:
            totals.total > 0 ? Math.round((totals.withEmbedding / totals.total) * 1000) / 10 : 0,
          perTenant,
        },
        null,
        2,
      ),
  );
}

main()
  .catch((err) => {
    console.error('CLIO_MEMORY_ERR', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
