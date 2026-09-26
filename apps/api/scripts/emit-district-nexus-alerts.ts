/**
 * Emit District Nexus R5 alerts.
 *
 * Queries district_nexus_change for alertable events and fans out in_app
 * notifications to users with the 'district_nexus_change' trigger key.
 *
 * DRY-RUN by default (prints would-send counts + sample payloads).
 * --commit to deliver.
 * --since <iso> window (default last 48h).
 * --tenant <slug> filter.
 *
 * Skips tenants where district_nexus_r5_alerts is off.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/emit-district-nexus-alerts.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { R5DistrictAlertsService, type DistrictAlertPayload } from '../src/district-nexus/r5-action-layer/r5-alerts.service.js';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../src/config/config.schema.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
dotenvConfig();

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): {
  commit: boolean;
  since: Date;
  tenantSlug: string | null;
} {
  let commit = false;
  let since = new Date(Date.now() - 48 * 60 * 60 * 1000); // default 48h
  let tenantSlug: string | null = null;

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--commit') {
      commit = true;
    } else if (args[i] === '--since' && args[i + 1]) {
      const d = new Date(args[i + 1]);
      if (!isNaN(d.getTime())) {
        since = d;
      } else {
        console.error(`Invalid date: ${args[i + 1]}`);
        process.exit(1);
      }
      i++;
    } else if (args[i] === '--tenant' && args[i + 1]) {
      tenantSlug = args[i + 1];
      i++;
    }
  }

  return { commit, since, tenantSlug };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { commit, since, tenantSlug } = parseArgs();

  const prisma = new PrismaClient();
  const prismaService = new PrismaService();

  // Create a minimal ConfigService for the alerts service
  // We need APP_BASE_URL and CAPIRO_INTERNAL_TENANT_ID from env
  const configService = {
    get: <T>(key: string): T | undefined => {
      if (key === 'APP_BASE_URL') return (process.env.APP_BASE_URL || 'https://os.capiro.ai') as T;
      if (key === 'CAPIRO_INTERNAL_TENANT_ID') return process.env.CAPIRO_INTERNAL_TENANT_ID as T;
      return undefined;
    },
  } as unknown as ConfigService<AppConfig, true>;

  // Wire the PrismaClient through PrismaService (which is what R5DistrictAlertsService expects)
  // @ts-expect-error — wiring raw PrismaClient for script context
  prismaService['prisma'] = prisma;
  prismaService.withSystem = <T>(fn: (tx: typeof prisma) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
      return fn(tx as typeof prisma);
    });
  prismaService.withTenant = async <T>(tenantId: string, fn: (tx: typeof prisma) => Promise<T>): Promise<T> =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.current_tenant_id', $1, true)", tenantId);
      return fn(tx as typeof prisma);
    });

  const alerts = new R5DistrictAlertsService(prismaService, configService);

  await runWithSyncRun(
    prisma as never,
    'emit-district-nexus-alerts',
    async () => {
      const mode = commit ? 'COMMIT' : 'DRY RUN';
      console.log(`[emit-district-nexus-alerts] ${mode} since ${since.toISOString()}${tenantSlug ? ` tenant=${tenantSlug}` : ' (all tenants)'}`);

      // Get tenants
      let tenantQuery = prisma.tenant.findMany({
        where: tenantSlug ? { slug: tenantSlug } : undefined,
        select: { id: true, slug: true },
      });

      // Cross-tenant read
      let tenants: Array<{ id: string; slug: string }>;
      if (tenantSlug) {
        tenants = await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
          return tx.tenant.findMany({
            where: { slug: tenantSlug },
            select: { id: true, slug: true },
          });
        });
      } else {
        tenants = await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
          return tx.tenant.findMany({ select: { id: true, slug: true } });
        });
      }

      console.log(`[emit-district-nexus-alerts] Found ${tenants.length} tenant(s)`);

      let totalConsidered = 0;
      let totalDelivered = 0;
      let totalSkippedDup = 0;
      let totalSkippedPref = 0;
      let tenantSkipped = 0;

      for (const t of tenants) {
        const result = await alerts.emitForTenant(t.id, t.slug, since, commit);
        totalConsidered += result.eventsConsidered;
        totalDelivered += result.delivered;
        totalSkippedDup += result.skippedDuplicate;
        totalSkippedPref += result.skippedPreference;

        if (!result.enabled) {
          tenantSkipped++;
          console.log(`  ${t.slug}: flag OFF, skipped`);
        } else {
          console.log(
            `  ${t.slug}: ${result.eventsConsidered} events, ${result.delivered} delivered, ${result.skippedDuplicate} dup, ${result.skippedPreference} no-pref`,
          );
        }

        // Print sample payloads
        for (const s of result.samples) {
          console.log('    ── Sample ──');
          console.log(`      Title: ${s.title}`);
          console.log(`      District: ${s.districtLabel}`);
          console.log(`      Severity: ${s.severity}`);
          console.log(`      Caveats: ${s.caveats.join(', ') || 'none'}`);
          console.log(`      Deep link: ${s.deepLink}`);
        }
      }

      console.log('');
      console.log(
        `[emit-district-nexus-alerts] Total: ${totalConsidered} events considered, ${totalDelivered} delivered, ${totalSkippedDup} dup, ${totalSkippedPref} no-pref, ${tenantSkipped} tenants skipped (flag off)`,
      );

      return { inserted: totalDelivered, updated: 0, skipped: totalSkippedDup + totalSkippedPref, errors: 0 };
    },
  );
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => {
      // PrismaClient is module-scoped; disconnect on exit
      process.exit(0);
    });
}