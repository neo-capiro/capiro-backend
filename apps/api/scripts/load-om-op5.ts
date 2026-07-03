/**
 * OP-5 O&M narrative loader (batch-10). Consumes the deterministic SAG-code join
 * (`build_op5_artifact.py`: O-1's stored `raw.sagBli` <-> the OP-5 exhibit's own
 * printed Subactivity-Group header, or a curated agency-title map for DW's
 * one-exhibit-per-book agencies) and attaches it to EXISTING O&M program elements:
 *   - fills the queryable `description` column
 *   - merges `raw.op5Detail` (sag, source book, page range) for citation
 *
 * Enrich-only: NEVER creates a PE, NEVER nulls out an existing `description`
 * (incoming wins when present; existing survives when the artifact has none).
 * A peCode with no existing program_element is skipped (reported).
 *
 * PRESENCE-BASED raw merge (deployment-playbook gotcha #4 — load-pdoc-enrichment's
 * `raw.pDocDetail = pe.pDocDetail ?? null` nulls the key when an artifact item
 * omits it): here every artifact item DOES carry `op5Detail`, but the merge still
 * only touches that one key on the existing raw object — every other `raw.*` field
 * (the O-1 loader's own `source`/`account`) is preserved untouched, not just
 * defaulted to null.
 *
 *   load-om-op5 --artifact scripts/__data__/corrected_json/om_op5_fy2027.json
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import { PrismaClient, Prisma } from '@prisma/client';

dotenvConfig();

interface Op5Detail {
  sag: string | null;
  book: string;
  pageStart: number | null;
  pageEnd: number | null;
}
interface EnrichPe {
  peCode: string;
  description?: string | null;
  op5Detail?: Op5Detail;
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
    console.error('Usage: load-om-op5 --artifact <om_op5.json>');
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Artifact;
  const prisma = new PrismaClient();
  await prisma.$connect();
  let seen = 0;
  let updated = 0;
  let skippedMissing = 0;
  let skippedNotOm = 0;
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
      if (existing.appropriationType !== 'OM') {
        // Never write OP-5 narrative onto a non-O&M line, even if the code collides.
        skippedNotOm += 1;
        continue;
      }
      const existingRaw =
        existing.raw && typeof existing.raw === 'object' && !Array.isArray(existing.raw)
          ? (existing.raw as Record<string, unknown>)
          : {};
      // Presence-based: only touch the op5Detail key, only when the artifact item
      // actually carries one. Every other key on raw (source/account/sagBli from
      // the O-1 loader) survives untouched.
      const mergedRaw =
        pe.op5Detail !== undefined ? { ...existingRaw, op5Detail: pe.op5Detail } : existingRaw;

      await prisma.programElement.update({
        where: { peCode: pe.peCode },
        data: {
          // incoming enrichment wins when present; never null out an existing value
          description: pe.description ?? existing.description ?? null,
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
          source: artifact.source ?? 'om_op5',
          seen,
          updated,
          skippedMissing,
          skippedNotOm,
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
