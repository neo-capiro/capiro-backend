/**
 * Ops verb: `update-strategy-reference` (FND-8).
 *
 * The Capiro-maintained mechanism for updating the GLOBAL Legislative/PPBE
 * reference baseline when Congress/PPBE dates move. REPLACES the baseline
 * wholesale (delete-all + insert) within one transaction. Firm forks
 * (sp_reference_override) are untouched.
 *
 * Payload source (first that is set):
 *   STRATEGY_REFERENCE_FILE  path to a JSON array of reference entries
 *   STRATEGY_REFERENCE_JSON  inline JSON array
 *   (neither)                recompute the built-in baseline against today's
 *                            fiscal calendar (a deterministic "reset").
 *
 * Compiled to dist/reference-ops.js and invoked by the entrypoint
 * `update-strategy-reference` verb (run as a one-off ECS task).
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '../generated/prisma-client/index.js';
import {
  buildBaselineEntries,
  parseReferencePayload,
  type ReferenceRow,
} from './reference/baseline.js';

function loadRows(): { rows: ReferenceRow[]; source: string } {
  const file = process.env.STRATEGY_REFERENCE_FILE?.trim();
  if (file) {
    return { rows: parseReferencePayload(readFileSync(file, 'utf8')), source: `file:${file}` };
  }
  const inline = process.env.STRATEGY_REFERENCE_JSON?.trim();
  if (inline) {
    return { rows: parseReferencePayload(inline), source: 'env:STRATEGY_REFERENCE_JSON' };
  }
  return { rows: buildBaselineEntries(new Date()), source: 'built-in baseline (recompute)' };
}

async function main(): Promise<void> {
  const { rows, source } = loadRows();
  if (rows.length === 0) {
    throw new Error('refusing to replace the reference baseline with an empty payload');
  }
  const prisma = new PrismaClient();
  try {
    const replaced = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      const del = await tx.spReferenceEntry.deleteMany({});
      await tx.spReferenceEntry.createMany({ data: rows });
      return del.count;
    });
    // eslint-disable-next-line no-console
    console.log(
      `Replaced sp_reference_entry baseline: removed ${replaced}, inserted ${rows.length} (source: ${source}).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('update-strategy-reference failed', err);
  process.exit(1);
});
