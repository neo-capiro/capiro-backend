/**
 * Geocode client facilities — District Impact Engine (Phase 1 M1.2). GLOBAL
 * (cross-tenant scan; each row's write re-scopes to its own tenant).
 *
 * Scans `client_facilities` where `geocoded_at IS NULL OR updated_at >
 * geocoded_at` (never-geocoded, or the address changed since the last
 * geocode), resolves each via the free/keyless Census Geocoder
 * (census-geocoder.client.ts), and upserts lat/lng + federal/state districts
 * + `districtSource='geocoded'` + `geocodeStatus`. Idempotent — a row whose
 * resolved geocode is unchanged is skipped (facility-geocode.util.ts).
 *
 * `client_facilities` is tenant-scoped/RLS; this is a background scan across
 * ALL tenants, so it bypasses RLS the same way `emit-state-changes.ts` does
 * (`set_config('app.bypass_rls', 'on', true)` inside a transaction) rather
 * than iterating tenants one at a time.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/geocode-facilities.ts
 * Env: GEOCODE_BATCH_CAP (default 500 rows/run — keyless but be a polite
 *      citizen of a free federal service), GEOCODE_DELAY_MS (default 250).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { computeFacilityGeocode, type FacilityGeocodeInput } from '../src/clients/facility-geocode.util.js';
dotenvConfig();

const prisma = new PrismaClient();
const BATCH_CAP = Number(process.env.GEOCODE_BATCH_CAP ?? '500');
const DELAY_MS = Number(process.env.GEOCODE_DELAY_MS ?? '250');

/** apps/api-side equivalent of withSystem for a plain PrismaClient script (sync-congress.ts precedent, reused verbatim by emit-state-changes.ts). */
async function bypassRls<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
    return fn(tx as unknown as PrismaClient);
  });
}

async function main() {
  await runWithSyncRun(prisma as never, 'geocode-facilities', async () => {
    let inserted = 0; // newly matched (previously ungeocoded or status changed to matched)
    let updated = 0; // a previously-matched row whose district/coords changed
    let skipped = 0;
    let errors = 0;
    let discrepancies = 0;
    // First per-row failure, surfaced on the sync_run row. A partial failure
    // used to land as `success_with_errors` with a null error_message — which
    // is how the same MA facility failed nine nights running (a VARCHAR(8)
    // overflow on a named state-legislative district) with nothing in the
    // ingestion dashboard to say why.
    let firstError: string | null = null;

    // W4.2: select by a deterministic address CHANGE-HASH, not the
    // `updated_at > geocoded_at` race. A row is a candidate only when it has
    // never been stamped (geocode_input_hash IS NULL) or its current normalized
    // address hash differs from the stamped one — so an unrelated updated_at
    // bump no longer forces a re-geocode, and never-tried rows are processed
    // first. The identical md5 expression is SELECTed as "currentHash" and
    // written back after EVERY attempt (below) so address-less / no-match rows
    // can't perpetually re-select and starve the batch cap.
    const ADDR_HASH_SQL =
      "md5(lower(coalesce(address_line,'') || '|' || coalesce(city,'') || '|' || coalesce(state,'') || '|' || coalesce(zip,'')))";
    const rows = await bypassRls((tx) =>
      tx.$queryRawUnsafe<
        Array<FacilityGeocodeInput & { tenantId: string; currentHash: string }>
      >(
        `SELECT id, tenant_id AS "tenantId", address_line AS "addressLine", city, state, zip,
                congressional_district AS "congressionalDistrict", district_source AS "districtSource",
                state_house_district AS "stateHouseDistrict", state_senate_district AS "stateSenateDistrict",
                latitude, longitude, geocode_status AS "geocodeStatus",
                ${ADDR_HASH_SQL} AS "currentHash"
           FROM client_facilities
          WHERE geocode_input_hash IS NULL OR geocode_input_hash IS DISTINCT FROM ${ADDR_HASH_SQL}
          ORDER BY (geocode_input_hash IS NOT NULL), updated_at ASC
          LIMIT $1`,
        BATCH_CAP,
      ),
    );

    console.log(`[geocode-facilities] ${rows.length} facilities to (re)geocode`);

    for (const row of rows) {
      try {
        const outcome = await computeFacilityGeocode(row);
        if (outcome.discrepancy) {
          discrepancies++;
          console.log(
            `[geocode-facilities] DISCREPANCY facility=${row.id} hand="${outcome.discrepancy.handEntered}" geocoded="${outcome.discrepancy.geocoded}"`,
          );
        }
        if (!outcome.update) {
          skipped++;
          // Stamp the hash even when nothing else changed (unchanged, no-match,
          // or address-less) so this row won't re-select until its address
          // actually changes — the fix for the starvation the old watermark had.
          await bypassRls((tx) =>
            tx.clientFacility.update({
              where: { id: row.id },
              data: { geocodeInputHash: row.currentHash },
            }),
          );
        } else {
          const wasUngeocoded = row.geocodeStatus == null;
          await bypassRls((tx) =>
            tx.clientFacility.update({
              where: { id: row.id },
              data: { ...outcome.update!, geocodeInputHash: row.currentHash },
            }),
          );
          if (wasUngeocoded && outcome.status === 'matched') inserted++;
          else updated++;
        }
      } catch (err) {
        errors++;
        if (!firstError) firstError = `facility ${row.id}: ${(err as Error).message}`;
        console.error(`[geocode-facilities] facility ${row.id} failed:`, err);
      }
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    console.log(
      `[geocode-facilities] done: +${inserted} newly matched, ~${updated} updated, ${skipped} unchanged, ${discrepancies} discrepancies, ${errors} errors`,
    );
    return { inserted, updated, skipped, errors, errorMessage: firstError };
  });
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
