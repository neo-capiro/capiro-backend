/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Read-only facility-district data audit (QA Bug 4 back-test).
 *
 * The facilities API now validates state ∈ US_STATE_CODES and (state, district)
 * via isValidDistrictForState, but rows written BEFORE that validation (or
 * imported) may still carry bad location data. This verb scans client_facilities
 * across ALL tenants and reports:
 *   - unknown_state:   state set but not a known US state/territory code
 *   - invalid_pair:    (state, district) fails isValidDistrictForState
 *   - orphan_district: congressional_district set but state is NULL
 *   - plus an informational count of single-digit BARE districts ('5') — valid
 *     app convention, and the relevance joins now LTRIM-normalize both sides
 *     against USAspending's zero-padded codes, so no action is needed.
 *
 * SAFE: SELECT-only. No writes. RLS-bypass read (tenant-owned table; same
 * trusted cross-tenant admin path as PrismaService.withSystem).
 *
 * Run as a one-off ECS task (read-only):
 *   aws ecs run-task ... --overrides '{"containerOverrides":[{"name":"api","command":["diag-facility-districts"]}]}'
 */
import { PrismaClient } from '@prisma/client';
import {
  US_STATE_CODES,
  isValidDistrictForState,
} from '../src/common/us-congressional-districts.js';

async function withBypass<T>(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx as unknown as PrismaClient);
  });
}

interface FacilityRow {
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  state: string | null;
  congressional_district: string | null;
}

type Issue = 'unknown_state' | 'invalid_pair' | 'orphan_district';

async function main(): Promise<void> {
  const usage = 'Usage: apps/api/scripts/diag-facility-districts.ts requires DATABASE_URL (database configuration is required)';
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
    const rows = await withBypass(prisma, async (tx) =>
      tx.$queryRawUnsafe<FacilityRow[]>(`
      SELECT f.id, f.tenant_id, f.client_id, f.name, f.state, f.congressional_district
      FROM client_facilities f
      WHERE f.state IS NOT NULL OR f.congressional_district IS NOT NULL
      ORDER BY f.tenant_id, f.client_id, f.name
    `),
    );

    const offending: Array<{
      issue: Issue;
      id: string;
      tenantId: string;
      clientId: string;
      name: string;
      state: string | null;
      district: string | null;
    }> = [];
    let bareSingleDigit = 0;

    for (const r of rows) {
      const state = r.state?.trim() || null;
      const district = r.congressional_district?.trim() || null;

      // Informational: BARE single-digit districts now join via LTRIM normalization.
      if (district && /^[1-9]$/.test(district)) bareSingleDigit++;

      let issue: Issue | null = null;
      if (!state && district) issue = 'orphan_district';
      else if (state && !US_STATE_CODES.includes(state.toUpperCase())) issue = 'unknown_state';
      else if (state && district && !isValidDistrictForState(state, district)) {
        issue = 'invalid_pair';
      }
      if (!issue) continue;

      offending.push({
        issue,
        id: r.id,
        tenantId: r.tenant_id,
        clientId: r.client_id,
        name: r.name,
        state: r.state,
        district: r.congressional_district,
      });
    }

    const count = (issue: Issue) => offending.filter((o) => o.issue === issue).length;
    // One tagged summary line + one line per offending row, easy to grep out of CloudWatch.
    console.log(
      'FACILITY_DISTRICTS_SUMMARY ' +
        JSON.stringify({
          facilitiesWithLocation: rows.length,
          unknownState: count('unknown_state'),
          invalidPair: count('invalid_pair'),
          orphanDistrict: count('orphan_district'),
          bareSingleDigitDistricts: bareSingleDigit,
        }),
    );
    for (const o of offending) console.log('FACILITY_DISTRICTS_ROW ' + JSON.stringify(o));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((err) => {
    console.error('[diag-facility-districts] FAILED', err);
    process.exit(1);
  });
}
