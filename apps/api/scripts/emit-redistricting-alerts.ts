/**
 * Emit `intelligence_change` rows for Legislative Districts redistricting
 * events (WS-C, LegiStorm gaps/enrichment plan).
 *
 * PREREQUISITE: WS-B (sync-legistorm-districts.ts) must have populated the
 * `legislative_district` table. This script ONLY READS that table — it never
 * calls the LegiStorm API itself, so it has no dependency on LEGISTORM_API_KEY
 * or the current key-rotation gate.
 *
 * Structural precedent: mirrors emit-state-changes.ts's dedupeKey +
 * findFirst + create pattern for the intelligence_change write. Severity
 * vocabulary precedent is emit-bill-alerts.ts's (critical|notable|info), NOT
 * emit-state-changes.ts's own 'high'/'medium' — that is a KNOWN, already-
 * flagged vocabulary drift bug: apps/web/src/pages/HomePage.tsx's banner
 * collapses anything other than 'critical'/'notable' straight to 'info'
 * (`c.severity === 'critical' || c.severity === 'notable' ? c.severity :
 * 'info'`), so 'high'/'medium' silently render as the LOWEST priority tier —
 * the opposite of what their names suggest. Do not propagate that bug here.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/emit-redistricting-alerts.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
dotenvConfig();

const prisma = new PrismaClient();

export const SOURCE = 'redistricting';

/**
 * apps/api-side cross-tenant read for a tenant-scoped table (client_facilities
 * has no relevance to a single tenant here — a redistricting event must be
 * checked against every tenant's facilities). Mirrors emit-state-changes.ts's
 * readIntelCrossTenant / sync-congress.ts's set_config('app.bypass_rls', ...)
 * transaction precedent verbatim. intelligence_change and legislative_district
 * are both GLOBAL tables (no tenant_id column) and need no such bypass.
 */
async function readCrossTenant<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
    return fn(tx as unknown as PrismaClient);
  });
}

export interface FutureDistrictRow {
  legistormDistrictId: number;
  state: string;
  districtNo: string | null;
  name: string;
  effectiveDate: Date | null;
  enactedDate: Date | null;
}

export interface PriorAlertSnapshot {
  effectiveDate: string | null;
  enactedDate: string | null;
  districtNo: string | null;
  name: string;
}

export function isoDate(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * Bridge LegiStorm's own district_no numbering to client_facilities.
 * congressional_district's convention. Live-verified 2026-07-24: LegiStorm
 * reports district_no="1" even for a jurisdiction's SOLE House seat (DC's
 * non-voting delegate) — there is no at-large sentinel on the vendor side.
 * client_facilities.congressionalDistrict is VARCHAR(2) and uses '00' for
 * at-large, zero-padded 2-digit otherwise (the Census-geocoder BASENAME
 * convention already used everywhere else in the app — see
 * census-geocoder.client.ts). `isAtLarge` must be computed dynamically
 * (exactly one House row for this state+status) — never a hardcoded list of
 * "the 6 at-large states"; apportionment can change after a future census.
 */
export function toFacilityDistrictCode(
  districtNo: string | null,
  isAtLarge: boolean,
): string | null {
  if (districtNo === null) return null; // a Senate row — no House district code at all
  if (isAtLarge) return '00';
  return districtNo.padStart(2, '0');
}

/**
 * Flat 'notable' for every alert. We do not have a real signal (an HQ flag,
 * facility dollar value, employee-count threshold) to justify a richer
 * critical-vs-notable split without fabricating one — a documented
 * simplification, not a silent decision. Revisit if such a signal becomes
 * available (e.g. ClientFacility.employeeCount above a threshold).
 */
export function severityFor(): 'critical' | 'notable' | 'info' {
  return 'notable';
}

/**
 * Decide whether `current` differs from the latest prior alert emitted for
 * this district (`prior`), and therefore whether a NEW alert should fire.
 * `prior === undefined` means we have never alerted on this district before.
 *
 * This is NOT "have we ever seen this district before" — that classification
 * would relabel and re-fire on every single re-run of an UNCHANGED district
 * (since `prior` would already exist from the first run), which would
 * violate the "re-running twice creates zero duplicate rows" requirement.
 * `changed=false` is the correct outcome for an unchanged re-run; the caller
 * must skip in that case, not create a "boundary changed" alert for nothing.
 */
export function classifyEvent(
  prior: PriorAlertSnapshot | undefined,
  current: PriorAlertSnapshot,
): { event: 'district_new_map' | 'district_boundary_changed'; changed: boolean } {
  if (!prior) return { event: 'district_new_map', changed: true };
  const changed =
    prior.effectiveDate !== current.effectiveDate ||
    prior.enactedDate !== current.enactedDate ||
    prior.districtNo !== current.districtNo ||
    prior.name !== current.name;
  return { event: 'district_boundary_changed', changed };
}

/** Build the deterministic dedupe key. Exported so a test can pin the exact format. */
export function buildDedupeKey(
  state: string,
  facilityDistrictCode: string,
  event: string,
  effectiveDate: string | null,
): string {
  return `redistricting:${state}-${facilityDistrictCode}:${event}:${effectiveDate ?? 'unknown'}`;
}

async function main(): Promise<void> {
  await runWithSyncRun(
    // See the comment on sync-legistorm-districts.ts's identical call for
    // why this cast matches the dominant real precedent for a directly-passed
    // module-scope PrismaClient (as opposed to one threaded through a deps
    // object, which is the one calling shape that compiles without it).
    prisma as never,
    'emit-redistricting-alerts',
    async () => {
      let emitted = 0;
      let skipped = 0;
      let errors = 0;

      // Senate seats are statewide — they have no sub-state boundary to
      // redistrict, so only House rows are candidates.
      const candidates: FutureDistrictRow[] = await prisma.legislativeDistrict.findMany({
        where: { status: 'F', chamber: 'house' },
        select: {
          legistormDistrictId: true,
          state: true,
          districtNo: true,
          name: true,
          effectiveDate: true,
          enactedDate: true,
        },
      });
      if (!candidates.length) {
        console.log('[emit-redistricting-alerts] no future (status=F) House maps found');
        return { inserted: 0, updated: 0, skipped: 0, errors: 0 };
      }

      // At-large detection, batched: how many House+status='F' rows exist per
      // state among the states we're about to process.
      const distinctStates = Array.from(new Set(candidates.map((c) => c.state)));
      const houseCounts = await prisma.legislativeDistrict.groupBy({
        by: ['state'],
        where: { state: { in: distinctStates }, status: 'F', chamber: 'house' },
        _count: { _all: true },
      });
      const houseCountByState = new Map(houseCounts.map((r) => [r.state, r._count._all]));
      const isAtLargeState = (state: string): boolean => (houseCountByState.get(state) ?? 0) === 1;

      // Prior alerts for this source, ordered oldest->newest so the LAST
      // write into the map per legistormDistrictId is genuinely the most
      // recent one (Map.set overwrites in iteration order).
      const priorAlerts = await prisma.intelligenceChange.findMany({
        where: { source: SOURCE },
        select: { data: true, detectedAt: true },
        orderBy: { detectedAt: 'asc' },
      });
      const latestByLegistormId = new Map<number, PriorAlertSnapshot>();
      for (const a of priorAlerts) {
        const d = a.data as Record<string, unknown>;
        const id = typeof d.legistormDistrictId === 'number' ? d.legistormDistrictId : null;
        if (id === null) continue;
        latestByLegistormId.set(id, {
          effectiveDate: typeof d.effectiveDate === 'string' ? d.effectiveDate : null,
          enactedDate: typeof d.enactedDate === 'string' ? d.enactedDate : null,
          districtNo: typeof d.districtNo === 'string' ? d.districtNo : null,
          name: typeof d.name === 'string' ? d.name : '',
        });
      }

      // Batch the affected-client lookup into ONE cross-tenant transaction
      // (never one $transaction per row). The SQL itself stays one
      // state+code pair per query (not a hand-built dynamic multi-tuple IN
      // clause) — redistricting candidates are rare (single digits to low
      // dozens per run), matching emit-bill-alerts.ts's per-item processing
      // precedent for a similarly small N; a dynamic parameterized IN-tuple
      // list would add real SQL-injection/parameter-index risk for no
      // meaningful performance gain at this volume.
      const distinctPairs = Array.from(
        new Map(
          candidates.map((c) => {
            const code = toFacilityDistrictCode(c.districtNo, isAtLargeState(c.state));
            return [`${c.state}|${code}`, { state: c.state, code }] as const;
          }),
        ).values(),
      ).filter((p): p is { state: string; code: string } => p.code !== null);

      const clientIdsByPair = await readCrossTenant(async (tx) => {
        const map = new Map<string, string[]>();
        for (const { state, code } of distinctPairs) {
          const rows = await tx.$queryRawUnsafe<Array<{ client_id: string }>>(
            `SELECT DISTINCT client_id FROM client_facilities WHERE state = $1 AND congressional_district = $2`,
            state,
            code,
          );
          map.set(`${state}|${code}`, rows.map((r) => r.client_id));
        }
        return map;
      });

      for (const c of candidates) {
        try {
          const facilityCode = toFacilityDistrictCode(c.districtNo, isAtLargeState(c.state));
          if (facilityCode === null) {
            skipped++;
            continue; // no district code at all (shouldn't happen for a House row) — nothing to join
          }

          const currentSnapshot: PriorAlertSnapshot = {
            effectiveDate: isoDate(c.effectiveDate),
            enactedDate: isoDate(c.enactedDate),
            districtNo: c.districtNo,
            name: c.name,
          };
          const { event, changed } = classifyEvent(
            latestByLegistormId.get(c.legistormDistrictId),
            currentSnapshot,
          );
          if (!changed) {
            skipped++;
            continue; // identical to the last alert we emitted for this district — nothing new
          }

          const relatedClientIds = clientIdsByPair.get(`${c.state}|${facilityCode}`) ?? [];
          if (!relatedClientIds.length) {
            skipped++;
            continue; // no client has a facility in this district — never broadcast market-wide
          }

          const dedupeKey = buildDedupeKey(c.state, facilityCode, event, currentSnapshot.effectiveDate);
          const existing = await prisma.intelligenceChange.findFirst({
            where: { dedupeKey },
            select: { id: true },
          });
          if (existing) {
            skipped++;
            continue;
          }

          const effectiveLabel = currentSnapshot.effectiveDate ?? 'an unannounced date';
          const title =
            event === 'district_new_map'
              ? `New congressional map enacted for ${c.name}`
              : `Congressional map revised for ${c.name}`;
          const description =
            event === 'district_new_map'
              ? `${c.name} has an enacted, not-yet-effective redistricting map, effective ${effectiveLabel}. A tracked client has a facility in this district.`
              : `The previously-announced redistricting map for ${c.name} has changed (now effective ${effectiveLabel}). A tracked client has a facility in this district.`;

          try {
            await prisma.intelligenceChange.create({
              data: {
                source: SOURCE,
                changeType: event,
                severity: severityFor(),
                title,
                description,
                relatedClientIds,
                relatedIssues: ['redistricting'],
                data: {
                  legistormDistrictId: c.legistormDistrictId,
                  state: c.state,
                  districtNo: c.districtNo,
                  facilityDistrictCode: facilityCode,
                  name: c.name,
                  effectiveDate: currentSnapshot.effectiveDate,
                  enactedDate: currentSnapshot.enactedDate,
                  event,
                },
                dedupeKey,
              },
            });
            emitted++;
          } catch (createErr) {
            // Defensive backstop against a race between two concurrent runs
            // both passing the findFirst check for the same dedupeKey — the
            // DB's own @unique constraint on dedupeKey is the real guarantee.
            if ((createErr as { code?: string }).code === 'P2002') {
              skipped++;
            } else {
              throw createErr;
            }
          }
        } catch (err) {
          errors++;
          console.error(`[emit-redistricting-alerts] district ${c.legistormDistrictId} failed:`, err);
        }
      }

      console.log(
        `[emit-redistricting-alerts] ${candidates.length} future-map candidates, ${emitted} emitted, ${skipped} skipped, ${errors} errors`,
      );
      return { inserted: emitted, updated: 0, skipped, errors };
    },
  );
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
