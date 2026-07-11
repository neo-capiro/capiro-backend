/**
 * Emit `intelligence_change` rows for material state_bill status transitions
 * (State Legislation Platform Phase 0 S5.3 — DD4's second rail). intel-api
 * owns per-client `intel_alert` rows (the LegiWatch Feed/email); apps/api
 * separately owns the dashboard/changes-inbox surface, since intel-api may
 * never write apps/api tables (the read-only invariant, P0-plan DD4).
 * Precedent for apps/api raw-reading intel-owned tables for the client
 * fan-out: tracker-change-detector.service.ts's intelOwnedTenantIds() +
 * sync-congress.ts's `set_config('app.bypass_rls', ...)` transaction (the
 * script-context equivalent of withSystem, since this is a plain PrismaClient
 * script, not the NestJS-wrapped service).
 *
 * This retires the misleading `state_bill` synced_at-count row in
 * emit-changes.ts (fires on re-sync, not on legislative events) — but only in
 * a FOLLOW-UP PR after this rail is verified in prod (the Radar-cutover
 * sequence: "state emitters live → verify → drop the count row").
 *
 *   pnpm --filter @capiro/api exec tsx scripts/emit-state-changes.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
dotenvConfig();

const prisma = new PrismaClient();

const MATERIAL_STATUSES = [
  'passed_chamber',
  'to_governor',
  'enacted',
  'vetoed',
  'veto_overridden',
  'failed',
  'dead_by_deadline',
];

// Severity map exactly as specced (Phase 0 plan §S5.3) — enacted/vetoed/failed
// are 'high'; passed_chamber/to_governor are 'medium'; everything else
// (including dead_by_deadline and veto_overridden) is 'info'.
export function severityFor(status: string): string {
  if (['enacted', 'vetoed', 'failed'].includes(status)) return 'high';
  if (['passed_chamber', 'to_governor'].includes(status)) return 'medium';
  return 'info';
}

interface MaterialBill {
  id: string;
  state: string;
  identifier: string;
  status: string;
  statusAt: Date;
  latestActionText: string | null;
}

/** apps/api-side equivalent of withSystem for a plain PrismaClient script (sync-congress.ts precedent). */
async function readIntelCrossTenant<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
    return fn(tx as unknown as PrismaClient);
  });
}

// Window on status_derived_at (INGESTION time, stamped by
// derive-state-bill-status.ts) — never status_at, which is the legislative
// EVENT date (@db.Date, midnight granularity) and is almost always EARLIER
// than this same-day run's `since` (2026-07-10 hot-fix). status_at is still
// selected for display/dedupeKey purposes. Exported as a named constant
// (rather than inlined) so a regression spec can assert the windowing column
// without needing a live Postgres connection — this script's core query has
// no other unit-test path.
export const MATERIAL_BILLS_QUERY = `SELECT id, state, identifier, status, status_at AS "statusAt", latest_action_text AS "latestActionText"
         FROM state_bill
        WHERE status_derived_at > $1
          AND status = ANY($2::text[])`;

async function main() {
  await runWithSyncRun(prisma as never, 'emit-state-changes', async (ctx) => {
    const since = ctx.since ?? new Date(0);
    let emitted = 0;
    let skipped = 0;
    let errors = 0;

    const bills = await prisma.$queryRawUnsafe<MaterialBill[]>(
      MATERIAL_BILLS_QUERY,
      since,
      MATERIAL_STATUSES,
    );
    if (!bills.length) {
      console.log(`[emit-state-changes] no material transitions since ${since.toISOString()}`);
      return { inserted: 0, updated: 0, skipped: 0, errors: 0 };
    }

    const billKeys = bills.map((b) => b.id);
    const relatedByBill = await readIntelCrossTenant(async (tx) => {
      const tracked = await tx.$queryRawUnsafe<Array<{ bill_id: string; client_id: string }>>(
        `SELECT bill_id, client_id FROM intel_tracked_bill WHERE source = 'state' AND bill_id = ANY($1::text[])`,
        billKeys,
      );
      const matched = await tx.$queryRawUnsafe<Array<{ bill_id: string; client_id: string }>>(
        `SELECT bill_id, client_id FROM intel_bill_match WHERE jurisdiction != 'US' AND bill_id = ANY($1::text[])`,
        billKeys,
      );
      const map = new Map<string, Set<string>>();
      for (const r of [...tracked, ...matched]) {
        const set = map.get(r.bill_id) ?? new Set<string>();
        set.add(r.client_id);
        map.set(r.bill_id, set);
      }
      return map;
    });

    for (const b of bills) {
      try {
        const relatedClientIds = Array.from(relatedByBill.get(b.id) ?? []);
        if (!relatedClientIds.length) {
          skipped++;
          continue; // no client tracks/matches this bill — nothing to surface
        }
        const statusDate = b.statusAt.toISOString().slice(0, 10);
        const dedupeKey = `state_bill:${b.id}:${b.status}:${statusDate}`;
        const existing = await prisma.intelligenceChange.findFirst({
          where: { dedupeKey },
          select: { id: true },
        });
        if (existing) {
          skipped++;
          continue;
        }
        await prisma.intelligenceChange.create({
          data: {
            source: 'state_bill',
            changeType: `state_bill_${b.status}`,
            severity: severityFor(b.status),
            title: `${b.state} ${b.identifier} — ${b.status.replace(/_/g, ' ')}`,
            description:
              b.latestActionText ?? `${b.state} ${b.identifier} status changed to ${b.status}.`,
            relatedClientIds,
            relatedIssues: [],
            data: { billId: b.id, state: b.state, status: b.status, statusAt: statusDate },
            dedupeKey,
          },
        });
        emitted++;
      } catch (err) {
        errors++;
        console.error(`[emit-state-changes] ${b.id} failed:`, err);
      }
    }

    console.log(
      `[emit-state-changes] ${bills.length} material transitions, ${emitted} emitted, ${skipped} skipped (no client / already dedup'd), ${errors} errors`,
    );
    return { inserted: emitted, updated: 0, skipped, errors };
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
