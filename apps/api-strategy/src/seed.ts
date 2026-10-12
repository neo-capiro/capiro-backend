/**
 * Seed the GLOBAL reference baseline (sp_reference_entry).
 *
 * INSERT-IF-EMPTY: runs after `prisma migrate deploy` on every deploy but only
 * populates the baseline when it is empty, so it never clobbers Capiro's
 * ops-verb edits (update-strategy-reference) or firm forks. Compiled to
 * dist/seed.js and invoked by the entrypoint `migrate` / `seed` verbs.
 * @cleanup-smoke noArgsExit=2 helpExit=0
 */
import { buildBaselineEntries } from './reference/baseline.js';

const usage = 'Usage: node dist/seed.js --run';
const argv = process.argv.slice(2);
if ((argv.length === 1 && argv[0] === '--help') ||
    (argv.length === 2 && argv[0] === '--run' && argv[1] === '--help')) {
  console.log(usage);
  process.exit(0);
}
if (argv.length !== 1 || argv[0] !== '--run') {
  console.error(usage);
  process.exit(2);
}

async function main(): Promise<void> {
  const { PrismaClient } = await import('../generated/prisma-client/index.js');
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.spReferenceEntry.count();
    if (existing > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `sp_reference_entry already has ${existing} row(s); skipping seed (insert-if-empty).`,
      );
      return;
    }
    const rows = buildBaselineEntries(new Date());
    await prisma.$transaction(async (tx) => {
      // System write of a global (no tenant) table — set bypass so the
      // WITH CHECK (rls_bypass()) policy on sp_reference_entry admits the insert.
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.spReferenceEntry.createMany({ data: rows });
    });
    // eslint-disable-next-line no-console
    console.log(`Seeded ${rows.length} sp_reference_entry baseline row(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Reference baseline seed failed', err);
  process.exit(1);
});
