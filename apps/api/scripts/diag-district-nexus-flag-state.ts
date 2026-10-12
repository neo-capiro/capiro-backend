/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Read-only DISTRICT NEXUS FLAG STATE report. Lists every tenant and the
 * current intel_feature_flag row (if any) for each of the four District
 * Nexus feature keys. SAFE: SELECT only, no writes. Mirrors the
 * app.bypass_rls pattern used by set-tenant-flag.ts / the guards themselves,
 * since tenants and intel_feature_flag are both RLS-FORCE-protected.
 */
import { PrismaClient } from '@prisma/client';

const FEATURES = [
  'district_nexus_v2',
  'district_nexus_strategic_relevance',
  'district_nexus_priority_intelligence',
  'district_nexus_supplier_footprint',
  'district_nexus_r5_brief',
  'district_nexus_r5_meeting_prep',
  'district_nexus_r5_actions',
  'district_nexus_r5_meri_tools',
  'district_nexus_r5_alerts',
];

async function main() {
  const usage = 'Usage: apps/api/scripts/diag-district-nexus-flag-state.ts requires DATABASE_URL (database configuration is required)';
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    process.exit(0);
  }
  if (args.length > 0) {
    console.error(usage);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error(usage);
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

      const tenants = await tx.$queryRawUnsafe<
        Array<{ id: string; slug: string; name: string; status: string }>
      >('SELECT id::text AS id, slug, name, status FROM tenants ORDER BY slug');

      const flags = await tx.$queryRawUnsafe<
        Array<{ feature: string; tenant_id: string; enabled: boolean }>
      >(
        `SELECT feature, tenant_id, enabled FROM intel_feature_flag WHERE feature = ANY($1::text[])`,
        FEATURES,
      );

      const byTenant: Record<string, Record<string, boolean>> = {};
      for (const f of flags) {
        byTenant[f.tenant_id] ??= {};
        byTenant[f.tenant_id][f.feature] = f.enabled;
      }

      const report = tenants.map((t) => ({
        slug: t.slug,
        name: t.name,
        status: t.status,
        flags: Object.fromEntries(
          FEATURES.map((f) => [f, byTenant[t.id]?.[f] ?? 'no row (dark unless internal-canary)']),
        ),
      }));

      console.log(JSON.stringify({ tenantCount: tenants.length, report }, null, 2));
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((e) => {
    console.error('FATAL', e);
    process.exitCode = 1;
  });
}
