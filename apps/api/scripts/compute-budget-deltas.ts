/** @cleanup-smoke noArgsExit=2 */
/**
 * Step 1.4 — recompute typed, materiality-scored budget deltas.
 *
 *   pnpm --filter @capiro/api deltas:compute              # DRY RUN (default)
 *   pnpm --filter @capiro/api deltas:compute -- --commit  # persist (idempotent, latest-wins)
 *   pnpm --filter @capiro/api deltas:compute -- --commit --fy 2027
 *
 * Idempotent: a recompute that finds no magnitude change is a no-op and emits no
 * IntelligenceChange. Computes every delta type from ProgramElementYear (real today) plus the
 * BudgetPosition / ProcurementLine types (dormant until that data lands — they yield [] now).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { DeltaEngineService } from '../src/program-element/deltas/delta-engine.service.js';

dotenvConfig();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const commit = flag('commit');
  const fyArg = arg('fy');
  const fy = fyArg ? Number(fyArg) : undefined;
  if (fyArg && !Number.isFinite(fy)) {
    console.error(`Invalid --fy ${fyArg}`);
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error('Usage: compute-budget-deltas [--commit] [--fy <year>] (requires DATABASE_URL)');
    process.exit(2);
  }
  const prisma = new PrismaService();
  try {
    await prisma.onModuleInit();
    const engine = new DeltaEngineService(prisma);
    const results = await engine.computeAll(fy, { commit });
    const totals = results.reduce(
      (acc, r) => ({
        pes_with_deltas: acc.pes_with_deltas + (r.derived > 0 ? 1 : 0),
        derived: acc.derived + r.derived,
        inserted: acc.inserted + r.inserted,
        superseded: acc.superseded + r.superseded,
        unchanged: acc.unchanged + r.unchanged,
        emitted: acc.emitted + r.emitted,
      }),
      { pes_with_deltas: 0, derived: 0, inserted: 0, superseded: 0, unchanged: 0, emitted: 0 },
    );
    console.log(
      JSON.stringify({ mode: commit ? 'COMMIT' : 'DRY_RUN', fy: fy ?? 'all', pes_scanned: results.length, ...totals }, null, 2),
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main().catch((e) => {
  console.error('[compute-budget-deltas] fatal', e?.stack || e);
  process.exit(1);
});
