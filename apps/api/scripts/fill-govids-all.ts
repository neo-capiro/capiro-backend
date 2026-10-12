/** @cleanup-smoke noArgsExit=2 */
/**
 * SAM gov-id backfill as a one-shot Fargate task.
 *
 *   fill-govids-all                         → DRY RUN over every active tenant
 *   fill-govids-all --commit                → write fills
 *   fill-govids-all --tenant <uuid>         → one tenant
 *   fill-govids-all --delay 500             → ms between SAM calls (quota pacing)
 *
 * Runs SamEntityEnrichmentService.enrichAllForTenant for each tenant: looks up
 * each client's UEI/CAGE/NAICS/PSC from SAM.gov by legal name (+state) and fills
 * ONLY empty fields (never clobbers user-entered values). Conservative matching
 * (single active exact-name entity) — ambiguous names are skipped, not guessed.
 *
 * DEFAULTS TO DRY RUN so an operator can review match rates before writing. Pass
 * --commit to persist. Idempotent + fail-safe (one client's SAM error never
 * aborts the run). Requires SAM_GOV_API_KEY (Entity-API access).
 *
 * Boots a Nest application context (no HTTP server) to reuse the real service +
 * RLS-aware PrismaService. Mirrors prepopulate-all.ts.
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { parseArgs } from 'node:util';

dotenvConfig();

// Load the Nest graph from the COMPILED dist (tsc-emitted decorator metadata);
// tsx re-transpiles with esbuild which does NOT emit reliable decorator metadata
// → NestJS DI fails. Falls back to src for local dev where dist may be absent.
async function loadNest(): Promise<{
  AppModule: any;
  SamEntityEnrichmentService: any;
  PrismaService: any;
}> {
  for (const base of ['../dist', '../src']) {
    try {
      const app = await import(`${base}/app.module.js`);
      const sam = await import(`${base}/intelligence/sam-entity.service.js`);
      const prisma = await import(`${base}/prisma/prisma.service.js`);
      return {
        AppModule: app.AppModule,
        SamEntityEnrichmentService: sam.SamEntityEnrichmentService,
        PrismaService: prisma.PrismaService,
      };
    } catch {
      // try next base
    }
  }
  throw new Error('Could not load AppModule from dist or src');
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      tenant: { type: 'string' },
      commit: { type: 'boolean', default: false },
      delay: { type: 'string' },
    },
  });

  // Guard --tenant to a well-formed UUID so an invalid value fails loudly instead
  // of silently resolving to "0 clients" (RLS would block a bad id, masking typos).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (args.tenant && !UUID_RE.test(args.tenant)) {
    console.error('[fill-govids-all] --tenant must be a valid UUID');
    process.exit(1);
  }
  const logger = new Logger('fill-govids-all');
  const commit = args.commit === true;
  const delayMs = args.delay ? Number(args.delay) : 300;
  if (!process.env.DATABASE_URL) {
    console.error('Usage: fill-govids-all [--tenant <uuid>] [--commit] [--delay <ms>] (requires DATABASE_URL)');
    process.exitCode = 2;
    return;
  }
  const { AppModule, SamEntityEnrichmentService, PrismaService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  logger.log(`mode=${commit ? 'COMMIT' : 'DRY RUN'} delayMs=${delayMs}`);

  try {
    const sam = app.get(SamEntityEnrichmentService);
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

    logger.log(`${commit ? 'enriching' : 'previewing'} ${tenants.length} tenant(s)`);

    let totalMatched = 0;
    let totalFilled = 0;
    for (const tenant of tenants) {
      try {
        const summary = await sam.enrichAllForTenant(tenant.id, { commit, delayMs });
        totalMatched += summary.matched;
        totalFilled += summary.filled;
        logger.log(
          `${tenant.slug}: ${summary.clients} client(s), ${summary.matched} SAM match(es), ${summary.filled} ${commit ? 'filled' : 'would-fill'}`,
        );
      } catch (err) {
        logger.error(`${tenant.slug}: FAILED: ${(err as Error).message}`);
      }
    }

    logger.log(
      `done. ${totalMatched} matched, ${totalFilled} ${commit ? 'filled' : 'would-fill'} across ${tenants.length} tenant(s). ${commit ? '' : '(DRY RUN — re-run with --commit to write)'}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('[fill-govids-all] FAILED', err);
  process.exit(1);
});
