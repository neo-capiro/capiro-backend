/**
 * P-40 deep-enrichment loader. Consumes an artifact of per-line-item enrichment
 * derived from the P-40 justification exhibits (deterministic Resource Summary +
 * LLM-extracted narrative fields) and attaches it to EXISTING program elements:
 *   - fills the queryable columns description / acatLevel / programOfRecord / status
 *   - merges the full structured detail into program_element.raw.pDocDetail
 *     (quantities, unit cost, schedule, acquisition strategy, competition,
 *      modification type, contractors, milestones, risks, MDAP code, related PEs)
 *
 * Enrich-only: it NEVER creates a PE and NEVER overwrites existing non-null columns
 * with null; a peCode with no existing program_element is skipped (reported), so
 * this can only run after the budget/BLIN loads (batches 2-3). Idempotent.
 *
 *   load-pdoc-enrichment --artifact scripts/__data__/corrected_json/pdoc_enrichment_fy2027.json
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import { PrismaClient, Prisma } from '@prisma/client';

dotenvConfig();

interface EnrichPe {
  peCode: string;
  description?: string | null;
  acatLevel?: string | null;
  programOfRecord?: string | null;
  status?: string | null;
  pDocDetail?: Record<string, unknown>;
}
interface Artifact {
  source?: string;
  fy?: number;
  pes?: EnrichPe[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const artifactPath = arg('artifact');
  if (!artifactPath) {
    console.error('Usage: load-pdoc-enrichment --artifact <enrichment.json>');
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Artifact;
  const prisma = new PrismaClient();
  await prisma.$connect();
  let seen = 0;
  let updated = 0;
  let skippedMissing = 0;
  const missingSamples: string[] = [];
  try {
    for (const pe of artifact.pes ?? []) {
      seen += 1;
      const existing = await prisma.programElement.findUnique({ where: { peCode: pe.peCode } });
      if (!existing) {
        skippedMissing += 1;
        if (missingSamples.length < 15) missingSamples.push(pe.peCode);
        continue;
      }
      const existingRaw =
        existing.raw && typeof existing.raw === 'object' && !Array.isArray(existing.raw)
          ? (existing.raw as Record<string, unknown>)
          : {};
      // PRESENCE-based: only touch the pDocDetail key when this artifact item
      // actually carries one. `pe.pDocDetail ?? null` used to null the key on
      // EVERY row regardless of whether the artifact supplied it, which is how
      // two prior loads reported "802 updated" while silently writing null
      // pDocDetail for all of them (caught by browser verification, fixed in
      // #205). Every other key already on raw survives untouched either way.
      const mergedRaw =
        pe.pDocDetail !== undefined ? { ...existingRaw, pDocDetail: pe.pDocDetail } : existingRaw;

      await prisma.programElement.update({
        where: { peCode: pe.peCode },
        data: {
          // prefer the incoming enrichment value; never null out an existing one
          description: pe.description ?? existing.description ?? null,
          acatLevel: pe.acatLevel ?? existing.acatLevel ?? null,
          programOfRecord: pe.programOfRecord ?? existing.programOfRecord ?? null,
          status: pe.status ?? existing.status ?? null,
          raw: mergedRaw as Prisma.InputJsonValue,
          lastSyncedAt: new Date(),
        },
      });
      updated += 1;
    }
    console.log(
      JSON.stringify(
        {
          artifact: artifactPath,
          source: artifact.source ?? 'p_doc_enrichment',
          seen,
          updated,
          skippedMissing,
          missingSamples,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
