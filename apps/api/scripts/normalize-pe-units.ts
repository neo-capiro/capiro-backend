/**
 * normalize-pe-units.ts — value-based PE-mark unit repair (dollars -> millions).
 *
 *   tsx scripts/normalize-pe-units.ts           # DRY RUN (default): writes nothing
 *   tsx scripts/normalize-pe-units.ts --commit  # apply
 *
 * Completes the unit fix that the log-based rebuild (rebuild-pe-years) could only
 * partially do: it only repaired fields with per-field source-value log entries
 * (request + committee marks), leaving historical enacted/conference values in raw
 * DOLLARS. This normalizes the canonical program_element_year table directly by
 * MAGNITUDE: any |value| above DOLLARS_THRESHOLD ($100,000 — far above any real
 * mark in millions, far below any real mark in dollars) is divided by 1e6.
 * Idempotent (post-divide values fall below the threshold) and leaves already-
 * millions + seed-fixture values untouched. See normalize-units.ts for the why.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import { PE_VALUE_COLUMNS, DOLLARS_THRESHOLD } from '../src/program-element/rebuild/normalize-units.js';

dotenvConfig();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/normalize-pe-units.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const commit = flag('commit');
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const perColumn: Record<string, number> = {};
    let totalFieldUpdates = 0;
    const samples: string[] = [];

    for (const col of PE_VALUE_COLUMNS) {
      const c = Prisma.raw(col);
      const cnt = await prisma.$queryRaw<Array<{ n: number }>>(
        Prisma.sql`SELECT count(*)::int AS n FROM program_element_year WHERE ${c} IS NOT NULL AND abs(${c}) > ${DOLLARS_THRESHOLD}`,
      );
      const n = cnt[0]?.n ?? 0;
      perColumn[col] = n;
      totalFieldUpdates += n;

      if (n > 0 && samples.length < 15) {
        const rows = await prisma.$queryRaw<Array<{ peCode: string; fy: number; val: number }>>(
          Prisma.sql`SELECT pe_code AS "peCode", fy, ${c}::float8 AS val FROM program_element_year WHERE ${c} IS NOT NULL AND abs(${c}) > ${DOLLARS_THRESHOLD} ORDER BY abs(${c}) DESC LIMIT 3`,
        );
        for (const r of rows) samples.push(`  ${r.peCode} FY${r.fy} ${col}: ${r.val} -> ${r.val / 1_000_000}`);
      }

      if (commit && n > 0) {
        await prisma.$executeRaw(
          Prisma.sql`UPDATE program_element_year SET ${c} = ${c} / 1000000 WHERE ${c} IS NOT NULL AND abs(${c}) > ${DOLLARS_THRESHOLD}`,
        );
      }
    }

    console.log(
      JSON.stringify(
        { mode: commit ? 'COMMIT' : 'DRY-RUN', threshold: DOLLARS_THRESHOLD, perColumn, totalFieldUpdates },
        null,
        2,
      ),
    );
    if (samples.length > 0) {
      console.log(`\nSamples (value -> millions)${commit ? ' [applied]' : ' [dry-run, not applied]'}:`);
      console.log(samples.join('\n'));
    }
    if (!commit && totalFieldUpdates > 0) {
      console.log('\nRe-run with --commit to apply. Verify the value -> millions magnitudes first.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
void main().catch((err) => {
  console.error('[normalize-pe-units] FAILED', err);
  process.exit(1);
});
}
