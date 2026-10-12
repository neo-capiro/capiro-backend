/**
 * embed-program-elements.ts
 *
 * Embeds each active Program Element's mission text into context_embeddings
 * (source_type='pe'), so the "Related Program Elements" panel can surface
 * semantically-similar PEs as SUGGESTIONS — explicitly not hard links.
 *
 * Why a dedicated source_type: PEs are global (tenant_id NULL) reference data,
 * same as bills. We reuse the shared embedAndUpsert so normalization, hashing
 * (skip-if-unchanged), Bedrock invocation and the pgvector upsert stay in one
 * place. Idempotent: a re-run with no text change burns zero Bedrock calls.
 *
 * Usage (via entrypoint verb): embed-program-elements [--limit N]
 * Retired PEs (retired_at IS NOT NULL) are skipped — they carry no live signal.
 */
import { PrismaClient } from '@prisma/client';
import {
  EMBEDDING_MODEL,
  buildProgramElementText,
  embedAndUpsert,
} from '../src/embeddings/embedder.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/embed-program-elements.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const limitArg = arg('--limit');
    const limit = limitArg ? Number.parseInt(limitArg, 10) : undefined;

    const pes = await prisma.programElement.findMany({
      where: { retiredAt: null },
      orderBy: { peCode: 'asc' },
      ...(limit ? { take: limit } : {}),
      select: {
        peCode: true,
        title: true,
        service: true,
        budgetActivityName: true,
        appropriationType: true,
        programOfRecord: true,
        description: true,
      },
    });

    console.log(`[embed-pe] embedding ${pes.length} active PEs with model ${EMBEDDING_MODEL}`);

    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const pe of pes) {
      const text = buildProgramElementText(pe);
      try {
        const outcome = await embedAndUpsert(prisma, {
          tenantId: null,
          sourceType: 'pe',
          sourceId: pe.peCode,
          text,
          bypassRls: true,
        });
        if (outcome === 'inserted') inserted++;
        else if (outcome === 'updated') updated++;
        else skipped++;
      } catch (e) {
        errors++;
        console.error(`[embed-pe] ${pe.peCode} failed:`, (e as Error).message);
      }
      const done = inserted + updated + skipped + errors;
      if (done % 200 === 0) {
        console.log(
          `[embed-pe] progress=${done}/${pes.length} inserted=${inserted} updated=${updated} skipped=${skipped} errors=${errors}`,
        );
      }
    }

    console.log(
      `[embed-pe] DONE inserted=${inserted} updated=${updated} skipped=${skipped} errors=${errors}`,
    );
    console.log(
      `INGESTION_METRIC ${JSON.stringify({
        source: 'embed-program-elements',
        rows_inserted: inserted,
        rows_updated: updated,
        rows_skipped: skipped,
        error_count: errors,
      })}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
