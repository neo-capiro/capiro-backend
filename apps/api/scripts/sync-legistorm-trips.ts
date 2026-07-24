/**
 * LegiStorm Privately Funded Travel refresh — dry-run-first CLI (WS-F,
 * LegiStorm gaps/enrichment plan).
 *
 * DELIBERATELY SEPARATE from sync-legistorm-directory.ts (runbook:
 * legistorm-directory-refresh.md line ~199 — "do not fold new datasets into
 * this member-directory job; each gets its own script + schedule +
 * retention").
 *
 * UNLIKE WS-B's districts job, this fetches INCREMENTALLY
 * (updated_from/updated_to, same as the directory job's staff/offices
 * window) — and BECAUSE it is incremental, it must NOT reconcile deletions
 * the way WS-B's full-reconciliation districts job does: an incremental
 * fetch never re-sees a trip from outside its date window, so "delete
 * anything not in this batch" would wrongly delete every historical trip on
 * every run. There is also no /trips/retired-ids endpoint (confirmed against
 * the real spec — only caucus/office/staff/townhall have one). Rows are
 * upserted by id and NEVER deleted by this script — an accepted limitation.
 *
 *   pnpm --filter @capiro/api sync:legistorm-trips                     # dry run, incremental
 *   pnpm --filter @capiro/api sync:legistorm-trips -- --commit         # write
 *   pnpm --filter @capiro/api sync:legistorm-trips -- --commit --full  # full reconciliation window (floor..today)
 *   pnpm --filter @capiro/api sync:legistorm-trips -- --commit --since=2026-06-01
 *
 * Commit execution is wrapped in runWithSyncRun so the run is represented in
 * sync_run and emits exactly one INGESTION_METRIC. Dry runs never open a run
 * or write to the database (existingIds is a read, not a write).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import {
  LegiStormClient,
  type LegiStormDateRange,
  type LegiStormPagedResult,
} from '../src/directory/legistorm/legistorm-client.js';
import type {
  LegiStormCorePerson,
  LegiStormTripRecord,
} from '../src/directory/legistorm/legistorm-types.js';
import { lastSuccessfulWatermark, runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';

export const SYNC_SOURCE = 'sync-legistorm-trips';
export const DEFAULT_FULL_FLOOR_DATE = '2000-01-01';

/** The client surface this script needs — lets tests inject a fake. */
export interface LegiStormTripSource {
  fetchTrips(range: LegiStormDateRange): Promise<LegiStormPagedResult<LegiStormTripRecord>>;
}

export interface TripDestinationRow {
  id: number;
  name: string | null;
  stateId: string | null;
}

export interface TripSponsorRow {
  id: number;
  name: string | null;
}

export interface TripRow {
  id: number;
  approverMemberId: number | null;
  approverName: string | null;
  /** Populated when the traveler was a MEMBER (mutually exclusive with travelerStaffId). */
  travelerMemberId: number | null;
  /** Populated when the traveler was a STAFFER (mutually exclusive with travelerMemberId). */
  travelerStaffId: number | null;
  travelerName: string | null;
  companionName: string | null;
  companionStatus: string | null;
  startDate: Date | null;
  endDate: Date | null;
  durationDays: number | null;
  purpose: string | null;
  comment: string | null;
  totalCost: number | null;
  transportationExpenses: number | null;
  lodgingExpenses: number | null;
  mealExpenses: number | null;
  otherExpenses: number | null;
  companionTransportationExpenses: number | null;
  companionLodgingExpenses: number | null;
  companionOtherExpenses: number | null;
  destinations: TripDestinationRow[];
  sponsors: TripSponsorRow[];
  filedDate: Date | null;
  amendedDate: Date | null;
  vendorUpdatedAt: Date | null;
}

function toNullableInt(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNullableFloat(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function displayName(person: LegiStormCorePerson | undefined): string | null {
  if (!person) return null;
  const first = person.preferred_first_name || person.first_name || '';
  const last = person.preferred_last_name || person.last_name || '';
  const name = `${first} ${last}`.trim();
  return name.length > 0 ? name : null;
}

/**
 * Transform one vendor record into our storage row. Denormalizes display
 * names at ingest time (mirrors ClientTarget's own philosophy) so the
 * profile-surfacing read (directory.service.ts getContactTrips, WS-F) never
 * needs an extra directory round-trip. Mutual exclusivity of
 * travelerMemberId/travelerStaffId is enforced explicitly here, not just
 * trusted from the vendor's own "either/or" description.
 */
export function toTripRow(record: LegiStormTripRecord): TripRow {
  const approver = record.approver;
  const travelerMember = record.traveler_member;
  const travelerStaffer = record.traveler_staffer;

  const travelerMemberId = travelerMember ? toNullableInt(travelerMember.member_id) : null;
  const travelerStaffId =
    !travelerMember && travelerStaffer?.staffer ? toNullableInt(travelerStaffer.staffer.id) : null;
  const travelerName = travelerMember
    ? displayName(travelerMember.profile)
    : displayName(travelerStaffer?.staffer);

  return {
    id: record.id,
    approverMemberId: approver ? toNullableInt(approver.member_id) : null,
    approverName: displayName(approver?.profile),
    travelerMemberId,
    travelerStaffId,
    travelerName,
    companionName: record.companion_name ?? null,
    companionStatus: record.companion_status ?? null,
    startDate: toNullableDate(record.start_date),
    endDate: toNullableDate(record.end_date),
    durationDays: toNullableInt(record.duration),
    purpose: record.purpose ?? null,
    comment: record.comment ?? null,
    totalCost: toNullableFloat(record.total_cost),
    transportationExpenses: toNullableFloat(record.transportation_expenses),
    lodgingExpenses: toNullableFloat(record.lodging_expenses),
    mealExpenses: toNullableFloat(record.meal_expenses),
    otherExpenses: toNullableFloat(record.other_expenses),
    companionTransportationExpenses: toNullableFloat(record.companion_transportation_expenses),
    companionLodgingExpenses: toNullableFloat(record.companion_lodging_expenses),
    companionOtherExpenses: toNullableFloat(record.companion_other_expenses),
    destinations: (record.destinations ?? []).map((d) => ({
      id: d.id,
      name: d.name ?? null,
      stateId: d.state_id ?? null,
    })),
    sponsors: (record.sponsors ?? []).map((s) => ({ id: s.id, name: s.name ?? null })),
    filedDate: toNullableDate(record.filed_date),
    amendedDate: toNullableDate(record.amended_date),
    vendorUpdatedAt: toNullableDate(record.updated_at),
  };
}

export interface FetchTripRowsResult {
  rows: TripRow[];
  fetchedCount: number;
}

/** Fetch + transform in one step — shared by the dry-run and commit paths so
 * there is exactly one place that calls fetchTrips and maps toTripRow. */
export async function fetchTripRows(
  client: LegiStormTripSource,
  window: LegiStormDateRange,
): Promise<FetchTripRowsResult> {
  const { records } = await client.fetchTrips(window);
  return { rows: records.map(toTripRow), fetchedCount: records.length };
}

/** Persistence surface — lets tests inject a fake store with no real database. */
export interface TripStore {
  /** Ids that already exist among the ones fetched, to classify insert vs update. */
  existingIds(ids: number[]): Promise<Set<number>>;
  /** Upsert every row. Deliberately NO delete/reconcile method — see the file header. */
  upsertAll(rows: TripRow[]): Promise<void>;
}

/** Classify insert vs update (via a pre-fetch of existing ids), then delegate the write. */
export async function applyTripRows(store: TripStore, rows: TripRow[]): Promise<RunCounts> {
  if (!rows.length) return { inserted: 0, updated: 0, skipped: 0, errors: 0 };
  const existing = await store.existingIds(rows.map((r) => r.id));
  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    if (existing.has(row.id)) updated += 1;
    else inserted += 1;
  }
  await store.upsertAll(rows);
  return { inserted, updated, skipped: 0, errors: 0 };
}

class PrismaTripStore implements TripStore {
  constructor(private readonly prisma: PrismaClient) {}

  async existingIds(ids: number[]): Promise<Set<number>> {
    if (!ids.length) return new Set();
    const rows = await this.prisma.legistormTrip.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  async upsertAll(rows: TripRow[]): Promise<void> {
    const now = new Date();
    const ops: Prisma.PrismaPromise<unknown>[] = rows.map((row) =>
      this.prisma.legistormTrip.upsert({
        where: { id: row.id },
        create: { ...row, syncedAt: now },
        update: { ...row, syncedAt: now },
      }),
    );
    await this.prisma.$transaction(ops);
  }
}

/** Parse process.argv into CLI options. Unknown flags are ignored. */
export function parseArgs(argv: string[]): {
  commit: boolean;
  full: boolean;
  since: string | null;
} {
  const args = argv.slice(2);
  const sinceArg = args.find((a) => a.startsWith('--since='));
  return {
    commit: args.includes('--commit'),
    full: args.includes('--full'),
    since: sinceArg ? sinceArg.slice('--since='.length) : null,
  };
}

function toDateStringUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDaysUTC(dateStr: string, deltaDays: number): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return toDateStringUTC(date);
}

/**
 * Resolve the fetch window: full -> floor..today; explicit --since ->
 * since..today (no overlap); else watermark-minus-overlap..today, falling
 * back to the floor when the source has never succeeded.
 */
export function computeWindow(
  options: { full: boolean; since: string | null },
  watermark: Date | null,
  today: string,
  overlapDays: number,
  floorDate: string,
): LegiStormDateRange {
  if (options.full) return { updatedFrom: floorDate, updatedTo: today };
  if (options.since) return { updatedFrom: options.since, updatedTo: today };
  if (watermark) {
    const from = shiftDaysUTC(toDateStringUTC(watermark), -Math.max(0, overlapDays));
    return { updatedFrom: from, updatedTo: today };
  }
  return { updatedFrom: floorDate, updatedTo: today };
}

/** Aggregate-only summary line — never a traveler/approver name, sponsor, or destination. */
function formatSummary(
  window: LegiStormDateRange,
  fetchedCount: number,
  committed: boolean,
  counts?: RunCounts,
): string {
  const summary = {
    source: SYNC_SOURCE,
    committed,
    window,
    fetchedCount,
    ...(counts ? { counts: { inserted: counts.inserted, updated: counts.updated } } : {}),
  };
  return `SYNC_LEGISTORM_TRIPS_SUMMARY ${JSON.stringify(summary)}`;
}

async function main(): Promise<void> {
  dotenvConfig();
  const parsed = parseArgs(process.argv);

  const apiKey = (process.env.LEGISTORM_API_KEY ?? '').trim();
  if (!apiKey) throw new Error('LEGISTORM_API_KEY is required');

  // Same base URL as the directory job (Congressional API) — trips lives
  // under /trips/list on that SAME base, unlike WS-B's districts, which
  // needed a completely different base URL entirely.
  const client = new LegiStormClient({
    apiKey,
    baseUrl: process.env.LEGISTORM_BASE_URL,
    pageSize: Number(process.env.LEGISTORM_PAGE_SIZE ?? 100),
    requestDelayMs: Number(process.env.LEGISTORM_REQUEST_DELAY_MS ?? 400),
    requestTimeoutMs: Number(process.env.LEGISTORM_REQUEST_TIMEOUT_MS ?? 30_000),
    maxRetryDelayMs: Number(process.env.LEGISTORM_MAX_RETRY_DELAY_MS ?? 30_000),
  });
  const prisma = new PrismaClient();
  const overlapDays = Number(process.env.LEGISTORM_OVERLAP_DAYS ?? 2);
  const floorDate = DEFAULT_FULL_FLOOR_DATE;

  try {
    if (!parsed.commit) {
      // Dry run: existingIds is a READ, not a write — safe to call for a
      // richer preview (projected insert/update split) without violating
      // "dry run performs zero database writes".
      const watermark = await lastSuccessfulWatermark(prisma as never, SYNC_SOURCE);
      const window = computeWindow(
        parsed,
        watermark,
        toDateStringUTC(new Date()),
        overlapDays,
        floorDate,
      );
      const { rows, fetchedCount } = await fetchTripRows(client, window);
      const store = new PrismaTripStore(prisma);
      const existing = rows.length ? await store.existingIds(rows.map((r) => r.id)) : new Set<number>();
      const projectedInserted = rows.filter((r) => !existing.has(r.id)).length;
      const projectedUpdated = rows.length - projectedInserted;
      console.log(
        formatSummary(window, fetchedCount, false, {
          inserted: projectedInserted,
          updated: projectedUpdated,
          skipped: 0,
          errors: 0,
        }),
      );
      console.log(
        '[sync-legistorm-trips] DRY RUN — no database writes. Pass --commit to write.',
      );
      return;
    }

    await runWithSyncRun(prisma as never, SYNC_SOURCE, async (ctx) => {
      const window = computeWindow(
        parsed,
        ctx.since,
        toDateStringUTC(new Date()),
        overlapDays,
        floorDate,
      );
      const { rows, fetchedCount } = await fetchTripRows(client, window);
      const store = new PrismaTripStore(prisma);
      const counts = await applyTripRows(store, rows);
      console.log(formatSummary(window, fetchedCount, true, counts));
      return counts;
    });
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[sync-legistorm-trips] FAILED', (error as Error).message);
    process.exit(1);
  });
}
