/**
 * Phase 6 — client-offboarding memory purge (operator tool, ECS one-off).
 *
 *   pnpm --filter @capiro/api purge:client-memory -- --tenant=<uuid> --client=<uuid> --reason="..."            # DRY RUN (default)
 *   pnpm --filter @capiro/api purge:client-memory -- --tenant=<uuid> --client=<uuid> --reason="..." --execute   # actually delete
 *
 * Dry-run (the default — you must pass --execute to delete) prints the selection
 * counts across every store. --execute runs MemoryPurgeService.purgeClient and
 * prints the audited result. Legal-held memory_items (and their clio sources)
 * are NEVER deleted. Gated by MEMORY_PURGE_ENABLED (refuses --execute when off).
 *
 * No-Nest-container pattern (mirrors refresh-memory-graph.ts): services are
 * instantiated manually around PrismaService so the script cannot drift from the
 * live purge logic. Requires DATABASE_URL.
 */
import 'dotenv/config';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { MemoryPurgeService } from '../src/memory/memory-purge.service.js';

function arg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const i = process.argv.indexOf(`--${name}`);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  return next && !next.startsWith('--') ? next : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const tenantId = arg('tenant');
  const clientId = arg('client');
  const reason = arg('reason');
  const execute = flag('execute');
  if (!tenantId || !clientId || !reason) {
    console.error('PURGE_ERR usage: --tenant=<uuid> --client=<uuid> --reason="..." [--execute]');
    process.exitCode = 1;
    return;
  }
  if (execute && process.env.MEMORY_PURGE_ENABLED !== 'true' && process.env.MEMORY_PURGE_ENABLED !== '1') {
    console.error('PURGE_ERR --execute refused: MEMORY_PURGE_ENABLED is not on.');
    process.exitCode = 2;
    return;
  }

  const prisma = new PrismaService();
  const purge = new MemoryPurgeService(prisma);
  try {
    const result = await purge.purgeClient(
      tenantId,
      clientId,
      { userId: null, role: 'operator_script' },
      { dryRun: !execute, reason },
    );
    console.log('PURGE_RESULT ' + JSON.stringify(result, null, 2));
    if (result.dryRun) {
      console.log('(dry run — re-run with --execute to delete; legal-held rows are always kept)');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('PURGE_ERR', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
