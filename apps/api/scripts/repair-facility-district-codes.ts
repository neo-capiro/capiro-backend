/**
 * Normalize `client_facilities.congressional_district` to facility storage form.
 *
 *   tsx scripts/repair-facility-district-codes.ts                  # dry run
 *   tsx scripts/repair-facility-district-codes.ts --commit
 *   tsx scripts/repair-facility-district-codes.ts --tenant <uuid> --commit
 *   tsx scripts/repair-facility-district-codes.ts --client <uuid>  # dry run, one client
 *
 * ── What is being repaired ──────────────────────────────────────────────────
 *
 * Facility style is 2-char zero-padded ('07', '00' for at-large) — see the header
 * of `src/common/district-code.util.ts`, and the Census geocoder, which writes the
 * padded `CD119` value on every row it touches.
 *
 * Nothing enforced that on write until now, so a district typed or emitted as "7"
 * was stored as "7". That is not cosmetic. `districtKeyFor` builds its key from the
 * code AS STORED, so a "7" facility keys as `WA-7` while every award for the same
 * seat keys as `WA-07` (USAspending's `congressional_code` is stored verbatim and
 * is padded). The facility becomes its own district bucket with no awards, the real
 * district shows no facilities, and because the detail route builds `WA-07` the
 * facility is unreachable — it vanishes from District Nexus.
 *
 * Measured in production 2026-07-30: 7 of 151 facilities, all written by the Meri
 * `web_import` path whose LLM payload varied between "7" and "07" for one field.
 *
 * ── Why this is safe ────────────────────────────────────────────────────────
 *
 * The transform is `'7' → '07'`, plus `'1' → '00'` for single-seat jurisdictions
 * (at-largeness is derived from apportionment, never read off the value — a sole
 * House seat is reported as "1" by some sources and must key as '00'). No district
 * changes which SEAT it refers to, so nothing is reattributed; rows that are
 * already canonical are skipped, which makes the pass idempotent.
 *
 * Sentinels ('90' multi-district, '98' non-voting delegate, 'ZZ') pass through
 * untouched — the geocoder does write '98', observed in production.
 */
import { config as dotenvConfig } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { emptyCounts, runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import { normalizeDistrictForStorage } from '../src/clients/client-facilities.service.js';

dotenvConfig();

const SOURCE = 'repair-facility-district-codes';
/** Keyset page size. Bounded per query, unbounded in total. */
const PAGE_SIZE = 500;

export interface RepairFacilityDistrictArgs {
  commit: boolean;
  tenantId: string | null;
  clientId: string | null;
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
function value(argv: string[], name: string): string | null {
  const eq = argv.find((item) => item.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}

export function parseRepairFacilityDistrictArgs(argv: string[]): RepairFacilityDistrictArgs {
  return {
    commit: flag(argv, 'commit'),
    tenantId: value(argv, 'tenant'),
    clientId: value(argv, 'client'),
  };
}

/**
 * The pure decision: what should this row's district become?
 *
 * `null` means "already canonical, do not write" — which is what makes the pass
 * idempotent rather than rewriting every row and churning `updated_at`.
 */
export function repairFacilityDistrict(
  state: string | null,
  current: string | null,
): string | null {
  if (current == null || current.trim() === '') return null;
  const next = normalizeDistrictForStorage(state, current);
  if (next == null || next === current) return null;
  return next;
}

async function withBypass<T>(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as PrismaClient;
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

export interface RepairFacilityDistrictResult extends RunCounts {
  evaluated: number;
  repaired: number;
  /** Every change, so a dry run is reviewable before it is committed. */
  changes: Array<{ id: string; name: string; state: string | null; from: string; to: string }>;
}

export async function repairFacilityDistrictCodes(
  prisma: PrismaClient,
  options: { tenantId: string | null; clientId: string | null; commit: boolean },
): Promise<RepairFacilityDistrictResult> {
  const counts = emptyCounts();
  let evaluated = 0;
  let repaired = 0;
  const changes: RepairFacilityDistrictResult['changes'] = [];

  let cursor: string | null = null;
  for (;;) {
    const rows: Array<{
      id: string;
      tenantId: string;
      name: string;
      state: string | null;
      congressionalDistrict: string | null;
    }> = await withBypass(prisma, (tx) =>
      tx.clientFacility.findMany({
        where: {
          ...(options.tenantId ? { tenantId: options.tenantId } : {}),
          ...(options.clientId ? { clientId: options.clientId } : {}),
          ...(cursor ? { id: { gt: cursor } } : {}),
          NOT: { congressionalDistrict: null },
        },
        select: { id: true, tenantId: true, name: true, state: true, congressionalDistrict: true },
        orderBy: { id: 'asc' },
        take: PAGE_SIZE,
      }),
    );
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      evaluated += 1;
      try {
        const next = repairFacilityDistrict(row.state, row.congressionalDistrict);
        if (next == null) {
          counts.skipped += 1;
          continue;
        }
        repaired += 1;
        changes.push({
          id: row.id,
          name: row.name,
          state: row.state,
          from: row.congressionalDistrict!,
          to: next,
        });

        if (options.commit) {
          const original = row.congressionalDistrict!;
          await withBypass(prisma, async (tx) => {
            await tx.clientFacility.update({
              where: { id: row.id },
              data: { congressionalDistrict: next },
            });
            // `districtSource` is deliberately NOT touched. This is a format
            // correction, not a re-determination of the district — rewriting a
            // 'geocoded' row to 'user' would destroy the provenance that
            // district-nexus.verification.ts uses to decide how much to trust it.
            await tx.auditLog.create({
              data: {
                tenantId: row.tenantId,
                actorUserId: null,
                actorRole: 'system',
                action: 'client_facility.congressional_district.normalized',
                entityType: 'client_facilities',
                entityId: row.id,
                before: { congressionalDistrict: original } as Prisma.InputJsonValue,
                after: {
                  congressionalDistrict: next,
                  reason: 'facility storage form is 2-char zero-padded',
                } as Prisma.InputJsonValue,
                requestId: SOURCE,
              },
            });
          });
        }
        counts.updated += 1;
      } catch (error) {
        counts.errors += 1;
        console.warn(`[${SOURCE}] facility ${row.id} failed: ${(error as Error).message}`);
      }
    }

    if (rows.length < PAGE_SIZE) break;
  }

  return { ...counts, evaluated, repaired, changes };
}

async function main(): Promise<void> {
  const args = parseRepairFacilityDistrictArgs(process.argv);
  const prisma = new PrismaClient();
  try {
    const execute = async (): Promise<RunCounts> => {
      const result = await repairFacilityDistrictCodes(prisma, args);
      console.log(
        `[${SOURCE}] ${args.commit ? 'COMMITTED' : 'DRY RUN'} evaluated=${result.evaluated} ` +
          `repaired=${result.repaired} unchanged=${result.skipped} errors=${result.errors}`,
      );
      // Printed in full, not counted: seven rows is reviewable, and an operator
      // committing a data change should see exactly which rows move.
      for (const change of result.changes) {
        console.log(
          `[${SOURCE}]   ${change.state ?? '??'} ${change.from} -> ${change.to}  ${change.name} (${change.id})`,
        );
      }
      return result;
    };
    // No SyncRun row in dry-run mode: the ledger records that a rail RAN, and a
    // dry run did not.
    if (args.commit) {
      await runWithSyncRun(prisma as never, SOURCE, execute, { skipIfRunning: false });
    } else {
      await execute();
    }
  } finally {
    await prisma.$disconnect();
  }
}

const direct = /repair-facility-district-codes(\.[cm]?[tj]s)?$/.test(
  (process.argv[1] ?? '').replace(/\\/g, '/'),
);
if (direct) {
  void main().catch((error) => {
    console.error(`[${SOURCE}] FAILED`, error);
    process.exit(1);
  });
}

export { main };
