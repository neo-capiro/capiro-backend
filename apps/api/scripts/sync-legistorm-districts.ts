/**
 * LegiStorm Legislative Districts refresh — dry-run-first CLI (WS-B, LegiStorm
 * gaps/enrichment plan).
 *
 * DELIBERATELY SEPARATE from sync-legistorm-directory.ts (runbook:
 * legistorm-directory-refresh.md line ~199 — "do not fold new datasets into
 * this member-directory job; each gets its own script + schedule +
 * retention"). Districts have no updated_from/updated_to window and no
 * retired-ids endpoint — they change only at redistricting, so this does a
 * FULL reconciliation every run rather than an incremental one.
 *
 *   pnpm --filter @capiro/api sync:legistorm-districts                          # dry run, all jurisdictions
 *   pnpm --filter @capiro/api sync:legistorm-districts -- --commit              # write
 *   pnpm --filter @capiro/api sync:legistorm-districts -- --states=WY           # ONE jurisdiction — the
 *                                                                                #   recommended first real run
 *   pnpm --filter @capiro/api sync:legistorm-districts -- --commit --states=WY,DC
 *   pnpm --filter @capiro/api sync:legistorm-districts -- --commit --with-kml   # also fetch+store boundaries
 *
 * Commit execution is wrapped in runWithSyncRun so the run is represented in
 * sync_run and emits exactly one INGESTION_METRIC, exactly like every other
 * ingestion job. Dry runs never open a run or write to the database.
 *
 * Aggregate-only console output: no member names, bioguide ids, or KML
 * URLs/content are ever printed (KML URLs embed our own API key in the path).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  LegiStormClient,
  type LegiStormDistrictListResult,
} from '../src/directory/legistorm/legistorm-client.js';
import type { LegiStormCongressDistrictRecord } from '../src/directory/legistorm/legistorm-types.js';
import { runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';

export const SYNC_SOURCE = 'sync-legistorm-districts';
/**
 * NOT the same base URL as the Congressional API (v2.019.10/congress). This
 * is the correct default REGARDLESS of whether LEGISTORM_DISTRICTS_BASE_URL
 * is ever wired into the deploy environment — belt-and-suspenders against the
 * exact "silently hits the congress endpoint" risk the plan flagged, since
 * LEGISTORM_BASE_URL (the congress one) is not even in apiSharedEnv today.
 */
export const DEFAULT_DISTRICTS_BASE_URL =
  'https://api.legistorm.com/v2.023.07/legislative_districts';

/**
 * 50 states + DC + the 5 territories with a non-voting House delegate /
 * resident commissioner. This is congressional apportionment knowledge, NOT
 * derived from any LegiStorm response — the Districts API is queried
 * per-jurisdiction, so the full set to query must be supplied by us.
 */
export const ALL_DISTRICT_JURISDICTIONS: readonly string[] = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC', 'PR', 'GU', 'AS', 'VI', 'MP',
];

/** Sleep function injected for testability (mirrors LegiStormClient's own pattern). */
export type Sleep = (ms: number) => Promise<void>;

/** The client surface this script needs — lets tests inject a fake. */
export interface LegiStormDistrictSource {
  fetchCongressDistrictList(
    state: string,
    status?: 'C' | 'F',
  ): Promise<LegiStormDistrictListResult>;
  fetchDistrictKml(kmlUrl: string): Promise<string>;
}

export interface LegislativeDistrictRow {
  id: string;
  legistormDistrictId: number;
  chamber: string;
  state: string;
  districtNo: string | null;
  senateClass: number | null;
  name: string;
  status: string;
  effectiveDate: Date | null;
  enactedDate: Date | null;
  currentMemberBioguides: string[];
  /**
   * In-memory only. NEVER persisted, logged, or sent to a client — it embeds
   * our own LegiStorm API key in the URL path. See kmlS3Key for the
   * persistable, re-hosted equivalent.
   */
  kmlUrl: string | null;
  kmlS3Key: string | null;
}

/** Row counts extended with `removed` — districts have no vendor retired-ids
 * endpoint, so deletions are reconciled by "not seen in this fetch", tracked
 * separately from the SyncRun ledger's inserted/updated/skipped/errors shape. */
export interface DistrictSyncCounts extends RunCounts {
  removed: number;
}

function toNullableInt(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Transform one vendor record into our storage row. `requestedStatus` is the
 * status we asked the API for; used as a fallback when the vendor response
 * omits its own `status` field — verified live 2026-07-24: /congress/zipcode
 * can omit status/dates entirely, while /congress/list?status=F always
 * includes them.
 */
export function toLegislativeDistrictRow(
  record: LegiStormCongressDistrictRecord,
  requestedStatus: 'C' | 'F',
): LegislativeDistrictRow {
  const status = record.status ?? requestedStatus;
  // Spec text says 'House' | 'Senate'; matched case-insensitively since we
  // have no live-verified Senate sample to pin the exact casing.
  const chamber = record.office_type.trim().toLowerCase() === 'senate' ? 'senate' : 'house';
  const districtNo = record.district_no != null ? String(record.district_no) : null;
  const kmlUrl = typeof record.kml === 'string' && record.kml.length > 0 ? record.kml : null;
  const currentMemberBioguides = record.members
    .map((m) => (typeof m.bioguide_id === 'string' ? m.bioguide_id : null))
    .filter((id): id is string => id !== null && id.trim().length > 0);

  return {
    id: `${record.id}-${status}`,
    legistormDistrictId: record.id,
    chamber,
    state: record.state,
    districtNo,
    senateClass: toNullableInt(record.senate_class),
    name: record.name,
    status,
    effectiveDate: toNullableDate(record.effective_date),
    enactedDate: toNullableDate(record.enacted_date),
    currentMemberBioguides,
    kmlUrl,
    kmlS3Key: null,
  };
}

export interface FetchAllDistrictsResult {
  rows: LegislativeDistrictRow[];
  fetchedByState: Record<string, { current: number; future: number }>;
}

/**
 * Fetch BOTH the current ('C') and future ('F') maps for every jurisdiction.
 * Sequential per-jurisdiction with a courtesy delay rather than firing all
 * requests at once — LegiStorm's docs ask for "respectful" use with no hard
 * rate limit, and this job runs infrequently (districts change only at
 * redistricting), so there's no reason to burst 112 requests simultaneously.
 */
export async function fetchAllDistricts(
  client: LegiStormDistrictSource,
  jurisdictions: readonly string[],
  sleepImpl: Sleep,
  delayMs: number,
): Promise<FetchAllDistrictsResult> {
  const rows: LegislativeDistrictRow[] = [];
  const fetchedByState: Record<string, { current: number; future: number }> = {};

  for (const state of jurisdictions) {
    const [current, future] = await Promise.all([
      client.fetchCongressDistrictList(state, 'C'),
      client.fetchCongressDistrictList(state, 'F'),
    ]);
    for (const record of current.records) rows.push(toLegislativeDistrictRow(record, 'C'));
    for (const record of future.records) rows.push(toLegislativeDistrictRow(record, 'F'));
    fetchedByState[state] = { current: current.records.length, future: future.records.length };
    if (delayMs > 0) await sleepImpl(delayMs);
  }

  return { rows, fetchedByState };
}

/** Persistence surface — lets tests inject a fake store with no real database. */
export interface LegislativeDistrictStore {
  /** Ids that already exist for these states, to classify insert vs update. */
  existingIdsForStates(states: readonly string[]): Promise<Set<string>>;
  /** Upsert every row AND delete any row for a fetched jurisdiction no longer
   * present in this run's result — one atomic operation. Returns rows removed. */
  applyReconciliation(
    rows: LegislativeDistrictRow[],
    jurisdictions: readonly string[],
  ): Promise<{ removed: number }>;
}

/**
 * Classify insert vs update (via a pre-fetch of existing ids), then delegate
 * the actual write + stale-row cleanup to the store in one call.
 */
export async function applyDistrictRows(
  store: LegislativeDistrictStore,
  rows: LegislativeDistrictRow[],
  jurisdictions: readonly string[],
): Promise<DistrictSyncCounts> {
  const existing = await store.existingIdsForStates(jurisdictions);
  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    if (existing.has(row.id)) updated += 1;
    else inserted += 1;
  }

  const { removed } = await store.applyReconciliation(rows, jurisdictions);
  return { inserted, updated, skipped: 0, errors: 0, removed };
}

/** KML persistence surface — lets tests inject a fake, no real S3. */
export interface KmlStore {
  /** Upload KML content; returns OUR OWN reference (never the raw vendor URL). */
  store(row: LegislativeDistrictRow, kmlText: string): Promise<string>;
}

/**
 * Fetch + re-host the KML boundary for every row that has one. Gated behind
 * the caller's own decision to invoke this (the --with-kml flag): KML is
 * served from www.legistorm.com, a DIFFERENT host than the JSON API with
 * unknown rate-limit behavior, so it is never fetched implicitly.
 */
export async function fetchAndStoreKml(
  client: Pick<LegiStormDistrictSource, 'fetchDistrictKml'>,
  kmlStore: KmlStore,
  rows: readonly LegislativeDistrictRow[],
  sleepImpl: Sleep,
  delayMs: number,
): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  for (const row of rows) {
    if (!row.kmlUrl) continue;
    const text = await client.fetchDistrictKml(row.kmlUrl);
    const key = await kmlStore.store(row, text);
    keys.set(row.id, key);
    if (delayMs > 0) await sleepImpl(delayMs);
  }
  return keys;
}

class PrismaLegislativeDistrictStore implements LegislativeDistrictStore {
  constructor(private readonly prisma: PrismaClient) {}

  async existingIdsForStates(states: readonly string[]): Promise<Set<string>> {
    if (!states.length) return new Set();
    const rows = await this.prisma.legislativeDistrict.findMany({
      where: { state: { in: [...states] } },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  async applyReconciliation(
    rows: LegislativeDistrictRow[],
    jurisdictions: readonly string[],
  ): Promise<{ removed: number }> {
    const idsByState = new Map<string, string[]>();
    for (const row of rows) {
      const list = idsByState.get(row.state) ?? [];
      list.push(row.id);
      idsByState.set(row.state, list);
    }

    const now = new Date();
    const upserts: Prisma.PrismaPromise<unknown>[] = rows.map((row) => {
      // Never persist kmlUrl — it embeds our own API key in its path.
      const { kmlUrl: _kmlUrl, ...data } = row;
      return this.prisma.legislativeDistrict.upsert({
        where: { id: row.id },
        create: { ...data, syncedAt: now },
        update: { ...data, syncedAt: now },
      });
    });

    // Reconcile deletions: districts have no vendor retired-ids endpoint, so
    // "not present in this fetch for a jurisdiction we DID successfully
    // query" is the only available deletion signal. `notIn: []` for a
    // jurisdiction with zero rows in this run deletes everything we
    // previously had for it — correct as long as the fetch itself succeeded
    // (LegiStormClient throws on any HTTP error / non-array response, so an
    // empty array here is a genuine "no districts" result, not a swallowed
    // failure).
    const deletes: Prisma.PrismaPromise<{ count: number }>[] = jurisdictions.map((state) =>
      this.prisma.legislativeDistrict.deleteMany({
        where: { state, id: { notIn: idsByState.get(state) ?? [] } },
      }),
    );

    const results = await this.prisma.$transaction([...upserts, ...deletes]);
    const deleteResults = results.slice(upserts.length) as Array<{ count: number }>;
    const removed = deleteResults.reduce((sum, r) => sum + r.count, 0);
    return { removed };
  }
}

class S3KmlStore implements KmlStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly prefix: string,
  ) {}

  async store(row: LegislativeDistrictRow, kmlText: string): Promise<string> {
    const key = `${this.prefix}/${row.id}.kml`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: kmlText,
        ContentType: 'application/vnd.google-earth.kml+xml',
      }),
    );
    return key;
  }
}

/** Parse process.argv into CLI options. Unknown flags are ignored. */
export function parseArgs(argv: string[]): {
  commit: boolean;
  withKml: boolean;
  jurisdictions: readonly string[];
} {
  const args = argv.slice(2);
  const statesArg = args.find((a) => a.startsWith('--states='));
  const jurisdictions = statesArg
    ? statesArg
        .slice('--states='.length)
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length > 0)
    : ALL_DISTRICT_JURISDICTIONS;

  return {
    commit: args.includes('--commit'),
    withKml: args.includes('--with-kml'),
    jurisdictions,
  };
}

/** Aggregate-only summary line — never a member name, bioguide id, or KML URL. */
function formatSummary(
  rows: readonly LegislativeDistrictRow[],
  fetchedByState: Record<string, { current: number; future: number }>,
  committed: boolean,
  withKml: boolean,
  counts?: DistrictSyncCounts,
): string {
  const summary = {
    source: SYNC_SOURCE,
    committed,
    withKml,
    jurisdictionsFetched: Object.keys(fetchedByState).length,
    totalRows: rows.length,
    currentRows: rows.filter((r) => r.status === 'C').length,
    futureRows: rows.filter((r) => r.status === 'F').length,
    fetchedByState,
    ...(counts
      ? { counts: { inserted: counts.inserted, updated: counts.updated, removed: counts.removed } }
      : {}),
  };
  return `SYNC_LEGISTORM_DISTRICTS_SUMMARY ${JSON.stringify(summary)}`;
}

async function main(): Promise<void> {
  dotenvConfig();
  const parsed = parseArgs(process.argv);

  const apiKey = (process.env.LEGISTORM_API_KEY ?? '').trim();
  if (!apiKey) throw new Error('LEGISTORM_API_KEY is required');

  const client = new LegiStormClient({
    apiKey,
    baseUrl: process.env.LEGISTORM_DISTRICTS_BASE_URL ?? DEFAULT_DISTRICTS_BASE_URL,
    requestDelayMs: Number(process.env.LEGISTORM_REQUEST_DELAY_MS ?? 400),
    requestTimeoutMs: Number(process.env.LEGISTORM_REQUEST_TIMEOUT_MS ?? 30_000),
    maxRetryDelayMs: Number(process.env.LEGISTORM_MAX_RETRY_DELAY_MS ?? 30_000),
  });
  const sleepImpl: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const delayMs = Number(process.env.LEGISTORM_REQUEST_DELAY_MS ?? 400);
  const prisma = new PrismaClient();

  try {
    if (!parsed.commit) {
      // Dry run: fetch only, ZERO database writes, no SyncRun row opened.
      const { rows, fetchedByState } = await fetchAllDistricts(
        client,
        parsed.jurisdictions,
        sleepImpl,
        delayMs,
      );
      console.log(formatSummary(rows, fetchedByState, false, parsed.withKml));
      console.log(
        '[sync-legistorm-districts] DRY RUN — no database writes. Pass --commit to write.',
      );
      return;
    }

    await runWithSyncRun(
      // Matches the dominant real precedent for this exact calling shape (a
      // directly-passed, module-scope `new PrismaClient()`, not passed
      // through an intermediate object-literal property): ~30 of the ~36
      // scripts calling runWithSyncRun this way use `as never` (e.g.
      // emit-state-changes.ts, sync-congress-members.ts, sync-cbo.ts). Only
      // scripts that thread prisma through a deps object (sync-legistorm-
      // directory.ts's `deps.prisma`) compile without it — a different
      // structural check than a direct positional argument.
      prisma as never,
      SYNC_SOURCE,
      async (): Promise<DistrictSyncCounts> => {
        const { rows, fetchedByState } = await fetchAllDistricts(
          client,
          parsed.jurisdictions,
          sleepImpl,
          delayMs,
        );

        let finalRows = rows;
        if (parsed.withKml) {
          const bucket = process.env.DIRECTORY_S3_BUCKET ?? 'updated-directory-967807252336-us-east-1';
          const region = process.env.AWS_REGION_DEFAULT ?? process.env.AWS_REGION ?? 'us-east-1';
          const kmlStore = new S3KmlStore(new S3Client({ region }), bucket, 'UPDATED DISTRICTS/kml');
          const keys = await fetchAndStoreKml(client, kmlStore, rows, sleepImpl, delayMs);
          finalRows = rows.map((row) => ({ ...row, kmlS3Key: keys.get(row.id) ?? row.kmlS3Key }));
        }

        const store = new PrismaLegislativeDistrictStore(prisma);
        const counts = await applyDistrictRows(store, finalRows, parsed.jurisdictions);
        console.log(formatSummary(finalRows, fetchedByState, true, parsed.withKml, counts));
        return counts;
      },
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[sync-legistorm-districts] FAILED', (error as Error).message);
    process.exit(1);
  });
}
