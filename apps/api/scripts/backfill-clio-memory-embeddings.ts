/**
 * Backfill embeddings for clio_memory rows that have none (W2 M2).
 *
 * Memory embeddings are written fire-and-forget when a memory is saved; a
 * transient OpenAI failure leaves a row with embedding IS NULL, which means it
 * never surfaces in semantic search (only via the keyword/recency fallback).
 * This reconciler re-embeds those rows so semantic retrieval is complete.
 *
 * DRY-RUN by default: prints how many rows WOULD be embedded. Pass --commit to
 * actually call OpenAI + write embeddings. Requires OPENAI_API_KEY.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * clio_memory is RLS-protected (tenant isolation). This reconciler runs
 * cross-tenant as a trusted job, so every statement runs inside a transaction
 * that flips the bypass GUC — otherwise FORCE ROW LEVEL SECURITY returns 0 rows
 * and silently drops the UPDATE. Mirrors PrismaService.withSystem and
 * scripts/embed-backfill.ts.
 */
async function withBypass<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
    return fn(tx);
  });
}

const COMMIT = process.argv.includes('--commit');
const LIMIT = (() => {
  const arg = process.argv.find((a) => a.startsWith('--limit='));
  const n = arg ? Number(arg.split('=')[1]) : 500;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 5000) : 500;
})();

interface PendingRow {
  id: string;
  key: string;
  value: string;
}

async function embed(text: string, apiKey: string): Promise<number[] | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const vec = json.data?.[0]?.embedding;
    return Array.isArray(vec) ? vec : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // Reads run under the RLS bypass GUC (see withBypass) — clio_memory is
  // tenant-isolated and this reconciler is a trusted cross-tenant job.
  const { pending, candidateCount } = await withBypass(async (tx) => {
    const pending = await tx.$queryRawUnsafe<PendingRow[]>(
      `SELECT id, key, value FROM clio_memory WHERE embedding IS NULL ORDER BY created_at ASC LIMIT ${LIMIT}`,
    );
    const totalNullRows = await tx.$queryRawUnsafe<Array<{ c: bigint }>>(
      `SELECT COUNT(*)::bigint AS c FROM clio_memory WHERE embedding IS NULL`,
    );
    return { pending, candidateCount: Number(totalNullRows?.[0]?.c ?? 0) };
  });

  if (!COMMIT) {
    console.log(
      'CLIO_MEMORY_BACKFILL ' +
        JSON.stringify(
          {
            mode: 'DRY_RUN',
            candidatesWithoutEmbedding: candidateCount,
            wouldProcessThisRun: pending.length,
            note: 'Re-run with --commit to write embeddings (requires OPENAI_API_KEY).',
          },
          null,
          2,
        ),
    );
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('CLIO_MEMORY_BACKFILL_ERR OPENAI_API_KEY not set');
    process.exitCode = 1;
    return;
  }

  let embedded = 0;
  let failed = 0;
  for (const row of pending) {
    const vec = await embed(`${row.key}: ${row.value}`, apiKey);
    if (!vec) {
      failed++;
      continue;
    }
    const literal = `[${vec.join(',')}]`;
    try {
      await withBypass((tx) =>
        tx.$executeRawUnsafe(
          `UPDATE clio_memory SET embedding = $1::vector WHERE id = $2`,
          literal,
          row.id,
        ),
      );
      embedded++;
    } catch {
      failed++;
    }
  }

  console.log(
    'CLIO_MEMORY_BACKFILL ' +
      JSON.stringify(
        {
          mode: 'COMMIT',
          processed: pending.length,
          embedded,
          failed,
          remainingAfterRun: Math.max(0, candidateCount - embedded),
        },
        null,
        2,
      ),
  );
}

main()
  .catch((err) => {
    console.error('CLIO_MEMORY_BACKFILL_ERR', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
