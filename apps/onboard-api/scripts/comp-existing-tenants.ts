/**
 * One-time rollout safety: comp every PRE-EXISTING tenant so the new client-slot
 * cap never locks out a current customer. Run ONCE, right after the billing
 * migration deploys and BEFORE opening sign-ups — at that moment every tenant
 * has billing_status='none' (the column default), so this flips them to
 * 'comped'. New tenants created afterwards keep 'none' and must subscribe.
 *
 *   pnpm --filter @capiro/onboard-api exec tsx scripts/comp-existing-tenants.ts          # dry-run
 *   pnpm --filter @capiro/onboard-api exec tsx scripts/comp-existing-tenants.ts --commit # apply
 *
 * Idempotent: only touches tenants currently in 'none'. Boots a Nest context to
 * reuse the RLS-aware PrismaService (withSystem). Mirrors prepopulate-all.ts.
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { parseArgs } from 'node:util';

dotenvConfig();

async function loadNest(): Promise<{ AppModule: any; PrismaService: any }> {
  for (const base of ['../dist', '../src']) {
    try {
      const app = await import(`${base}/app.module.js`);
      const prisma = await import(`${base}/prisma/prisma.service.js`);
      return { AppModule: app.AppModule, PrismaService: prisma.PrismaService };
    } catch {
      // try next base
    }
  }
  throw new Error('Could not load AppModule from dist or src');
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { commit: { type: 'boolean', default: false } } });
  const commit = Boolean(values.commit);
  const logger = new Logger('comp-existing-tenants');

  const { AppModule, PrismaService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error', 'log'],
  });
  try {
    const prisma = app.get(PrismaService);
    const tenants = await prisma.withSystem((tx: any) =>
      tx.tenant.findMany({ where: { billingStatus: 'none' }, select: { id: true, slug: true } }),
    );
    logger.log(`${tenants.length} tenant(s) currently 'none':`);
    for (const t of tenants) logger.log(`  ${t.slug} (${t.id})`);

    if (!commit) {
      logger.log('DRY RUN — pass --commit to set these to comped.');
      return;
    }
    const res = await prisma.withSystem((tx: any) =>
      tx.tenant.updateMany({ where: { billingStatus: 'none' }, data: { billingStatus: 'comped' } }),
    );
    logger.log(`Comped ${res.count} tenant(s).`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('comp-existing-tenants failed', err);
  process.exit(1);
});
