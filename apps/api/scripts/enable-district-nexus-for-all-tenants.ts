/**
 * Enable all four District Nexus feature flags for every tenant.
 *
 *   pnpm --filter @capiro/api enable:district-nexus-all
 *   (dry-run by default; add --commit to persist)
 *
 * Mirrors intel-api's `enable-feature-all <flag>` task-runner verb (see
 * apps/intel-api/src/tasks/task-runner.ts / WatchlistSyncService.setFeatureFlagAll)
 * but does all four District Nexus keys in one script instead of four separate
 * invocations, and is dry-run-by-default like set-tenant-flag.ts (that verb
 * has no dry-run gate of its own). SAFE: prints before/after for every
 * tenant x feature pair; only writes when --commit is passed. tenants and
 * intel_feature_flag are both RLS-FORCE-protected, so this runs inside one
 * transaction with app.bypass_rls set (scoped to the transaction only).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FEATURES = [
  'district_nexus_v2',
  'district_nexus_strategic_relevance',
  'district_nexus_priority_intelligence',
  'district_nexus_supplier_footprint',
];

async function main() {
  const commit = process.argv.includes('--commit');

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

    const tenants = await tx.$queryRawUnsafe<Array<{ id: string; slug: string; status: string }>>(
      'SELECT id::text AS id, slug, status FROM tenants ORDER BY slug',
    );

    const existing = await tx.$queryRawUnsafe<
      Array<{ feature: string; tenant_id: string; enabled: boolean }>
    >(`SELECT feature, tenant_id, enabled FROM intel_feature_flag WHERE feature = ANY($1::text[])`, FEATURES);
    const currentByKey = new Map(existing.map((r) => [`${r.tenant_id}:${r.feature}`, r.enabled]));

    let changed = 0;
    let alreadyOn = 0;
    for (const t of tenants) {
      for (const feature of FEATURES) {
        const current = currentByKey.get(`${t.id}:${feature}`);
        if (current === true) {
          alreadyOn++;
          continue;
        }
        changed++;
        console.log(
          `${t.slug} (${t.status}) | ${feature}: ${current === undefined ? 'no row' : current} -> true`,
        );
        if (commit) {
          // FeatureFlag.id is `@default(cuid())` — a Prisma-client-side default,
          // not a DB default — so a raw INSERT must supply its own id. The
          // column is plain String (no cuid-format check), so gen_random_uuid()
          // is a safe substitute; only uniqueness matters here.
          await tx.$executeRawUnsafe(
            `INSERT INTO intel_feature_flag (id, feature, tenant_id, enabled, created_at)
             VALUES (gen_random_uuid()::text, $1, $2, true, now())
             ON CONFLICT (feature, tenant_id) DO UPDATE SET enabled = true`,
            feature,
            t.id,
          );
        }
      }
    }

    console.log(
      `\n${commit ? 'COMMITTED' : 'DRY RUN — pass --commit to persist'}: ` +
        `${tenants.length} tenants x ${FEATURES.length} features. ` +
        `${alreadyOn} already on, ${changed} ${commit ? 'set to' : 'would be set to'} true.`,
    );
  });
}

main()
  .catch((e) => {
    console.error('FATAL', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
