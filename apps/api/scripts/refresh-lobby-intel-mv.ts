/**
 * Refresh the lobby_intel_mv materialized view.
 *
 *   pnpm --filter @capiro/api refresh:lobby-intel
 *
 * Calls refresh_lobby_intel_mv() which runs REFRESH MATERIALIZED VIEW
 * CONCURRENTLY (so reads don't block). Run after sync-lda.ts to pick up
 * new filings; safe to run on cron every ~6h.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/refresh-lobby-intel-mv.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const t0 = Date.now();
  try {
    console.log('[refresh-lobby-intel] starting');
    await prisma.$executeRawUnsafe('SELECT refresh_lobby_intel_mv()');
    const rows = await prisma.$queryRawUnsafe<[{ count: bigint }]>(
      'SELECT COUNT(*)::bigint AS count FROM lobby_intel_mv',
    );
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `[refresh-lobby-intel] DONE in ${elapsed}s, ${rows[0]?.count ?? 0} rows in lobby_intel_mv`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
main().catch((err) => {
  console.error('[refresh-lobby-intel] FAILED', err);
  process.exit(1);
});
}
