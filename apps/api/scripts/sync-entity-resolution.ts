/** @cleanup-smoke noArgsExit=2 */
/**
 * Entity resolution as a one-shot Fargate task (async, off the HTTP path).
 *   pnpm --filter @capiro/api sync:entity-resolution
 *   pnpm --filter @capiro/api sync:entity-resolution -- --tenant <uuid>
 *
 * resolveAllForTenant loops every client x 7 fuzzy-match sources; running it
 * inside the POST /intelligence/resolve-all request risks timeouts for large
 * tenants. This script runs the SAME EntityResolutionService logic as a job, so
 * the endpoint stays available for small/interactive use while bulk/scheduled
 * resolution runs here. Idempotent: re-running preserves confirmed mappings
 * (the service's update path never resets `confirmed`).
 *
 * Boots a Nest application context (no HTTP server) to reuse the real service
 * and its PrismaService wiring, rather than duplicating the matching SQL.
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { parseArgs } from 'node:util';

dotenvConfig();

// Load the Nest graph from the COMPILED dist (tsc-emitted decorator metadata).
// Running this script via tsx re-transpiles imports with esbuild, which does NOT
// emit reliable decorator metadata -> NestJS DI fails (ConfigService undefined in
// ClerkService). Importing the already-compiled dist/*.js avoids that. Falls back
// to src for local dev where dist may be absent.
async function loadNest(): Promise<{
  AppModule: any;
  EntityResolutionService: any;
  PrismaService: any;
}> {
  for (const base of ['../dist', '../src']) {
    try {
      const app = await import(`${base}/app.module.js`);
      const ers = await import(`${base}/intelligence/entity-resolution.service.js`);
      const prisma = await import(`${base}/prisma/prisma.service.js`);
      return {
        AppModule: app.AppModule,
        EntityResolutionService: ers.EntityResolutionService,
        PrismaService: prisma.PrismaService,
      };
    } catch {
      // try next base
    }
  }
  throw new Error('Could not load AppModule from dist or src');
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: sync-entity-resolution [--tenant <uuid>] (requires DATABASE_URL)');
    process.exitCode = 2;
    return;
  }
  const { values: args } = parseArgs({
    options: { tenant: { type: 'string' } },
  });

  const logger = new Logger('sync-entity-resolution');
  const { AppModule, EntityResolutionService, PrismaService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const resolver = app.get(EntityResolutionService);
    const prisma = app.get(PrismaService);

    const tenants = args.tenant
      ? [{ id: args.tenant, slug: args.tenant }]
      : await prisma.withSystem((tx: any) =>
          // RLS hides tenants from a context-less query; this is trusted
          // cross-tenant admin tooling, so bypass RLS to enumerate them.
          tx.tenant.findMany({
            where: { status: 'active' },
            select: { id: true, slug: true },
          }),
        );

    logger.log(`resolving ${tenants.length} tenant(s)`);

    let ok = 0;
    let failed = 0;
    for (const tenant of tenants) {
      try {
        const summary = await resolver.resolveAllForTenant(tenant.id);
        ok++;
        logger.log(
          `${tenant.slug}: ${summary.totalClients} clients, ${summary.mappingsCreated} mappings, ${summary.autoConfirmed} auto-confirmed, ${summary.needsReview} need review`,
        );
      } catch (err) {
        // One tenant's failure must not abort the rest of the run.
        failed++;
        logger.error(`${tenant.slug}: FAILED: ${(err as Error).message}`);
      }
    }

    logger.log(`done. ${ok} tenant(s) resolved, ${failed} failed.`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('[sync-entity-resolution] FAILED', err);
  process.exit(1);
});
