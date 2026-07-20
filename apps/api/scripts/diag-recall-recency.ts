/**
 * Read-only MEASURED GATE for Phase 5 recall reranking (master plan Phase 5):
 * "stale-but-embedded facts demote below fresh ones (measured)".
 *
 * For each tenant it samples the memory_items projection (clio-projected notes
 * with an embedding), pairs rows that are mutually similar in Titan space but
 * differ in freshness, and reports:
 *   (i)  recencyInversions — pairs where a STALER row currently outranks a
 *        FRESHER, near-equal-similarity row under pure cosine (the problem), and
 *   (ii) demotionsAfterRerank — how many of those the Phase-5 fusion reorders so
 *        the fresher row wins (the fix), using the SAME pure fuseRecallScore the
 *        runtime uses.
 *
 * SAFE: COUNT/SELECT only, cross-tenant under SET LOCAL app.bypass_rls inside a
 * transaction (mirrors diag-memory-recall-parity.ts). No writes. Fusion is done
 * in-memory with the shipped helper so the report reflects real behavior.
 *
 * Usage: run via the api ECS one-off (tsx scripts/diag-recall-recency.ts).
 * Env knobs mirror config defaults: MEMORY_RECALL_HALFLIFE_DAYS,
 * MEMORY_RECALL_W_SIM/_W_RECENCY/_W_CONFIDENCE, MEMORY_RECALL_NEUTRAL_CONFIDENCE.
 */
import { PrismaClient } from '@prisma/client';
import { fuseRecallScore, type RecalledRow } from '../src/meri/memory-scoring.helpers.js';

const prisma = new PrismaClient();

interface SampleRow {
  tenant_id: string;
  id: string;
  age_days: number;
  confidence: number | null;
  embedding: string; // pgvector as text
}

const SIM_NEAR = 0.05; // treat |sim_a - sim_b| <= this as "near-equal similarity"
const SAMPLE_PER_TENANT = 200;

function cosineFromText(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function parseVec(s: string): number[] {
  return s.replace(/^\[|\]$/g, '').split(',').map(Number);
}

async function main(): Promise<void> {
  const opts = {
    halfLifeDays: numEnv('MEMORY_RECALL_HALFLIFE_DAYS', 180),
    weights: {
      sim: numEnv('MEMORY_RECALL_W_SIM', 0.6),
      rec: numEnv('MEMORY_RECALL_W_RECENCY', 0.25),
      conf: numEnv('MEMORY_RECALL_W_CONFIDENCE', 0.15),
    },
    neutralConfidence: numEnv('MEMORY_RECALL_NEUTRAL_CONFIDENCE', 0.75),
  };

  const tenants = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
    return tx.$queryRawUnsafe<Array<{ tenant_id: string }>>(
      `SELECT DISTINCT tenant_id FROM context_embeddings WHERE source_type='memory_item'`,
    );
  });

  const perTenant: Array<{
    tenantId: string;
    sampled: number;
    nearEqualPairs: number;
    recencyInversions: number;
    demotionsAfterRerank: number;
  }> = [];

  for (const { tenant_id } of tenants) {
    const rows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
      return tx.$queryRawUnsafe<SampleRow[]>(
        `SELECT mi.tenant_id,
                mi.id,
                EXTRACT(EPOCH FROM (now() - COALESCE(mi.last_confirmed_at, mi.updated_at, mi.created_at))) / 86400 AS age_days,
                mi.confidence,
                ce.embedding::text AS embedding
           FROM memory_items mi
           JOIN context_embeddings ce
             ON ce.source_type='memory_item' AND ce.source_id = mi.id::text
          WHERE mi.tenant_id = $1::uuid AND mi.type='note' AND mi.status='active'
          ORDER BY mi.updated_at DESC
          LIMIT ${SAMPLE_PER_TENANT}`,
        tenant_id,
      );
    });
    if (rows.length < 2) continue;

    const vecs = rows.map((r) => parseVec(r.embedding));
    let nearEqualPairs = 0;
    let recencyInversions = 0;
    let demotionsAfterRerank = 0;

    // Compare each row against a bounded window of peers (O(n·w)) to find
    // near-equal-similarity pairs relative to the FIRST row as a probe query.
    const probe = vecs[0]!;
    const scored = rows.map((r, i) => ({
      row: r,
      sim: cosineFromText(vecs[i]!, probe),
    }));
    for (let i = 0; i < scored.length; i += 1) {
      for (let j = i + 1; j < scored.length; j += 1) {
        const a = scored[i]!;
        const b = scored[j]!;
        if (Math.abs(a.sim - b.sim) > SIM_NEAR) continue;
        nearEqualPairs += 1;
        const older = a.row.age_days >= b.row.age_days ? a : b;
        const newer = a.row.age_days >= b.row.age_days ? b : a;
        // pure-cosine inversion: the older row currently ranks >= the newer one
        if (older.sim >= newer.sim) {
          recencyInversions += 1;
          const fusedOlder = fuseRecallScore(toRow(older), opts);
          const fusedNewer = fuseRecallScore(toRow(newer), opts);
          if (fusedNewer > fusedOlder) demotionsAfterRerank += 1;
        }
      }
    }

    perTenant.push({
      tenantId: tenant_id,
      sampled: rows.length,
      nearEqualPairs,
      recencyInversions,
      demotionsAfterRerank,
    });
  }

  const totals = perTenant.reduce(
    (acc, t) => {
      acc.recencyInversions += t.recencyInversions;
      acc.demotionsAfterRerank += t.demotionsAfterRerank;
      return acc;
    },
    { recencyInversions: 0, demotionsAfterRerank: 0 },
  );

  console.log(
    'RECALL_RECENCY_REPORT ' +
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          gate: 'demotionsAfterRerank > 0 proves stale rows demote below fresh ones under fusion',
          weights: opts.weights,
          halfLifeDays: opts.halfLifeDays,
          totals,
          perTenant,
        },
        null,
        2,
      ),
  );
}

function toRow(s: { row: SampleRow; sim: number }): RecalledRow {
  return {
    key: s.row.id,
    value: '',
    similarity: s.sim,
    ageDays: s.row.age_days,
    confidence: s.row.confidence,
  };
}

function numEnv(name: string, d: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : d;
}

main()
  .catch((err) => {
    console.error('RECALL_RECENCY_ERR', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
