/**
 * District Nexus — USAspending financial assistance awards sync.
 *
 *   pnpm --filter @capiro/api sync:federal-assistance-awards
 *   tsx scripts/sync-federal-assistance-awards.ts --days 7
 *   tsx scripts/sync-federal-assistance-awards.ts --backfill --since 2024-10-01
 *   tsx scripts/sync-federal-assistance-awards.ts --backfill --min-amount 100000
 *   tsx scripts/sync-federal-assistance-awards.ts --agency "Department of Health and Human Services"
 *
 * USAspending API v2 (api.usaspending.gov/api/v2/search/spending_by_award),
 * award_type_codes 02/03/04/05 (block grant / formula grant / project grant /
 * cooperative agreement) — financial ASSISTANCE, never contracts. Kept fully
 * separate from sync-federal-award.ts / federal_award: different data
 * product, different identity keys, different geography semantics.
 *
 * Unlike the contract sync, this uses USAspending's documented KEYSET
 * pagination (page_metadata.last_record_unique_id / last_record_sort_value)
 * instead of date-window bisection. Verified live 2026-07-24: the page/limit
 * depth cap is 50,000 results (not ~10,000 as previously assumed), and
 * passing the cursor back (dropping `page`) resumes correctly past it — so a
 * single window never needs to be split. No agency filter by default —
 * District Nexus supports all agencies; --agency scopes one run for a
 * canary/backfill. --min-amount uses the documented award_amounts filter to
 * bound backfill volume server-side (verified live).
 *
 * Fields requested were verified against a real response captured 2026-07-24
 * (fixture in this script's .spec.ts) — Recipient UEI, Assistance Listings,
 * Total Outlays, and Primary Place of Performance / Recipient Location
 * (including congressional_code) all come back directly from search; no
 * per-award detail call is required for the core sync (see
 * enrich-assistance-award-details.ts for the thin gap-fill pass).
 *
 * Upsert by generated_internal_id (award_unique_id) — stable idempotency key.
 * Preserves raw place-of-performance / recipient-location congressional-
 * district codes exactly as returned (including sentinels "00"/"90"/"98"/
 * "ZZ") — never guesses or normalizes away a sentinel. Stores the vendor
 * payload verbatim in raw_jsonb (fixes a known federal_award defect, which
 * stores its own mapped object instead of the source response).
 *
 * Idempotent: re-running the same window changes nothing but timestamps.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

const USASPENDING = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
const ASSISTANCE_AWARD_TYPE_CODES = ['02', '03', '04', '05'];
const DELAY_MS = 300;

/**
 * Transient-failure retry (added 2026-07-26 after the first live canary).
 *
 * A bounded backfill is 500+ sequential requests over 10+ minutes against a
 * government API. The first real run died at page ~510 with
 * `SocketError: other side closed` after 106 MB — not a throttle, not a bad
 * request, just the far end hanging up mid-stream. With no retry at all, a
 * single blip discards the whole walk, so the odds of ever completing a large
 * window were effectively zero.
 *
 * 4 attempts with exponential backoff (1s, 2s, 4s) — enough to ride out a
 * dropped connection without turning a genuine outage into a 20-minute stall.
 */
const FETCH_MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 1000;

// Deterministic normalization of USAspending's "Award Type" descriptive label
// back to its filed award_type_code — NOT inferred per-record. This mirrors
// the exact 4 codes filtered on (award types whitepaper, verified 2026-07-24:
// fedspendingtransparency.github.io/whitepapers/types/). Matched by prefix
// since the API appends a parenthetical letter suffix, e.g. "BLOCK GRANT (A)".
const AWARD_TYPE_LABEL_PREFIXES: Array<[string, string]> = [
  ['BLOCK GRANT', '02'],
  ['FORMULA GRANT', '03'],
  ['PROJECT GRANT', '04'],
  ['COOPERATIVE AGREEMENT', '05'],
];

export function awardTypeCodeFromLabel(label: string | null | undefined): string | null {
  if (!label) return null;
  const upper = label.toUpperCase();
  for (const [prefix, code] of AWARD_TYPE_LABEL_PREFIXES) {
    if (upper.startsWith(prefix)) return code;
  }
  return null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PlaceOfPerformance {
  state_code?: string | null;
  congressional_code?: string | null;
  city_name?: string | null;
  zip5?: string | null;
  location_country_code?: string | null;
}

export interface AssistanceAwardRaw {
  generated_internal_id?: string;
  internal_id?: number | string;
  'Award ID'?: string;
  'Recipient Name'?: string;
  'Recipient UEI'?: string;
  'Award Amount'?: number;
  'Total Outlays'?: number;
  Description?: string;
  'Awarding Agency'?: string;
  'Awarding Sub Agency'?: string;
  'Funding Agency'?: string;
  'Funding Sub Agency'?: string;
  'Start Date'?: string;
  'End Date'?: string;
  'Last Modified Date'?: string;
  'Assistance Listings'?: Array<{ cfda_number?: string; cfda_program_title?: string }>;
  'CFDA Number'?: string;
  'SAI Number'?: string;
  'Award Type'?: string;
  'Primary Place of Performance'?: PlaceOfPerformance;
  'Recipient Location'?: PlaceOfPerformance;
  [key: string]: unknown;
}

export interface PageMetadata {
  hasNext?: boolean;
  last_record_unique_id?: number | string;
  last_record_sort_value?: string;
}

export interface FetchPageArgs {
  startDate: string;
  endDate: string;
  agency?: string;
  minAmount?: number;
  cursor?: { lastRecordUniqueId: number | string; lastRecordSortValue: string };
}

/** Fetch one page of assistance awards, following USAspending's keyset cursor. */
export async function fetchPage(
  args: FetchPageArgs,
): Promise<{ results: AssistanceAwardRaw[]; pageMetadata: PageMetadata }> {
  const filters: Record<string, unknown> = {
    time_period: [{ start_date: args.startDate, end_date: args.endDate, date_type: 'action_date' }],
    award_type_codes: ASSISTANCE_AWARD_TYPE_CODES,
  };
  if (args.agency) {
    filters.agencies = [{ type: 'awarding', tier: 'toptier', name: args.agency }];
  }
  if (args.minAmount != null) {
    filters.award_amounts = [{ lower_bound: args.minAmount }];
  }

  const body: Record<string, unknown> = {
    filters,
    fields: [
      'Award ID', 'Recipient Name', 'Recipient UEI', 'Award Amount', 'Total Outlays',
      'Description', 'Awarding Agency', 'Awarding Sub Agency', 'Funding Agency', 'Funding Sub Agency',
      'Start Date', 'End Date', 'Last Modified Date', 'Assistance Listings', 'CFDA Number',
      'SAI Number', 'Award Type', 'Primary Place of Performance', 'Recipient Location',
    ],
    limit: 100,
    sort: 'Award Amount',
    order: 'desc',
  };
  // Keyset pagination: verified live 2026-07-24 that passing these two fields
  // back (and omitting `page`) resumes correctly past the 50,000-row page x
  // limit depth cap. First page omits them (equivalent to `page: 1`).
  if (args.cursor) {
    body.last_record_unique_id = args.cursor.lastRecordUniqueId;
    body.last_record_sort_value = args.cursor.lastRecordSortValue;
  } else {
    body.page = 1;
  }

  const res = await fetch(USASPENDING, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Carry the status so the retry wrapper can tell a throttle/outage apart
    // from a permanently-malformed request.
    const err = new Error(
      `USAspending ${res.status}: ${await res.text().catch(() => '')}`,
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const json = (await res.json()) as { results?: AssistanceAwardRaw[]; page_metadata?: PageMetadata };
  return { results: json.results ?? [], pageMetadata: json.page_metadata ?? {} };
}

/**
 * Worth retrying? Socket/network failures carry no HTTP status at all (undici
 * throws `TypeError: fetch failed` wrapping e.g. `UND_ERR_SOCKET`) — those are
 * the ones that actually bit us. 429 and 5xx are the server asking us to come
 * back later. Any other 4xx is a defect in the request we just built and will
 * fail identically forever, so retrying it only wastes the backoff.
 */
export function isTransientFetchError(err: unknown): boolean {
  const status = (err as { status?: number } | null | undefined)?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  return true;
}

/**
 * `fetchPage` with bounded retry. Exported for unit test.
 *
 * Takes its collaborators through `deps` (rather than closing over the module
 * functions) so a spec can drive the retry path with a mocked fetchPage and a
 * no-op sleep — no live calls, no real waiting.
 */
export async function fetchPageWithRetry(
  args: FetchPageArgs,
  deps: SyncAssistanceAwardsDeps,
  maxAttempts: number = FETCH_MAX_ATTEMPTS,
): Promise<{ results: AssistanceAwardRaw[]; pageMetadata: PageMetadata }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await deps.fetchPage(args);
    } catch (err) {
      lastError = err;
      if (!isTransientFetchError(err) || attempt === maxAttempts) break;
      const backoffMs = RETRY_BASE_MS * 2 ** (attempt - 1);
      console.warn(
        `[sync-federal-assistance-awards] fetch attempt ${attempt}/${maxAttempts} failed (${
          (err as Error)?.message ?? err
        }); retrying in ${backoffMs}ms`,
      );
      await deps.sleep(backoffMs);
    }
  }
  throw lastError;
}

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export function toAwardData(a: AssistanceAwardRaw): Record<string, unknown> {
  const pop = a['Primary Place of Performance'] ?? {};
  const recip = a['Recipient Location'] ?? {};
  const assistanceListings = a['Assistance Listings'] ?? [];
  const primaryListing = assistanceListings[0];

  return {
    fain: a['Award ID'] ?? null,
    awardTypeCode: awardTypeCodeFromLabel(a['Award Type']),
    awardTypeLabel: a['Award Type'] ?? null,
    recipientName: a['Recipient Name'] ?? null,
    recipientUei: a['Recipient UEI'] ?? null,
    assistanceListings: assistanceListings.length ? (assistanceListings as object) : null,
    assistanceListingNumber: a['CFDA Number'] ?? primaryListing?.cfda_number ?? null,
    assistanceListingTitle: primaryListing?.cfda_program_title ?? null,
    saiNumber: a['SAI Number'] ?? null,
    awardingAgency: a['Awarding Agency'] ?? null,
    awardingSubTier: a['Awarding Sub Agency'] ?? null,
    fundingAgency: a['Funding Agency'] ?? null,
    fundingSubTier: a['Funding Sub Agency'] ?? null,
    totalObligatedAmount: a['Award Amount'] ?? null,
    totalOutlayedAmount: a['Total Outlays'] ?? null,
    description: a['Description'] ?? null,
    startDate: safeDate(a['Start Date']),
    endDate: safeDate(a['End Date']),
    lastModifiedDate: safeDate(a['Last Modified Date']),
    // Raw preserved verbatim (incl. sentinels "00"/"90"/"98"/"ZZ" — never
    // guessed) alongside a normalized copy for joins; both null when absent.
    popState: pop.state_code ?? null,
    popCongressionalDistrictRaw: pop.congressional_code ?? null,
    popCongressionalDistrict: pop.congressional_code ?? null,
    // The search endpoint returns the AS-REPORTED (original) vintage only.
    popCdVintage: pop.congressional_code ? 'original' : null,
    popCity: pop.city_name ?? null,
    popZip: pop.zip5 ?? null,
    popCountry: pop.location_country_code ?? null,
    recipientState: recip.state_code ?? null,
    recipientCongressionalDistrictRaw: recip.congressional_code ?? null,
    recipientCongressionalDistrict: recip.congressional_code ?? null,
    recipientCity: recip.city_name ?? null,
    recipientZip: recip.zip5 ?? null,
    raw: a as object,
    lastSyncedAt: new Date(),
  };
}

/** Minimal duck-typed slice of PrismaClient — keeps this unit-testable without a real DB. */
export interface AssistanceAwardPrisma {
  federalAssistanceAward: {
    findUnique(args: { where: { awardUniqueId: string }; select: { id: true } }): Promise<{ id: string } | null>;
    upsert(args: { where: { awardUniqueId: string }; create: unknown; update: unknown }): Promise<unknown>;
  };
}

export interface SyncAssistanceAwardsDeps {
  fetchPage: typeof fetchPage;
  sleep: (ms: number) => Promise<void>;
}

export interface SyncWindowArgs {
  startDate: string;
  endDate: string;
  agency?: string;
  minAmount?: number;
  maxPages: number;
}

/** Exported for unit testing with a mocked fetchPage/sleep — no live calls, no real DB. */
export async function syncAssistanceAwardsWindow(
  prisma: AssistanceAwardPrisma,
  windowArgs: SyncWindowArgs,
  deps: SyncAssistanceAwardsDeps = { fetchPage, sleep },
): Promise<RunCounts> {
  let inserted = 0;
  let updated = 0;
  let errors = 0;
  let cursor: FetchPageArgs['cursor'];

  for (let page = 0; page < windowArgs.maxPages; page += 1) {
    if (page > 0) await deps.sleep(DELAY_MS);

    let results: AssistanceAwardRaw[];
    let pageMetadata: PageMetadata;
    try {
      ({ results, pageMetadata } = await fetchPageWithRetry(
        {
          startDate: windowArgs.startDate,
          endDate: windowArgs.endDate,
          agency: windowArgs.agency,
          minAmount: windowArgs.minAmount,
          cursor,
        },
        deps,
      ));
    } catch (err) {
      // Retries exhausted. Everything upserted so far is REAL and already
      // committed, so stop the walk and return the true counts rather than
      // throwing them away: `errors > 0` makes runWithSyncRun record
      // `success_with_errors`, which is an honest "wrote N, then broke".
      //
      // The first live canary is exactly why this exists — it wrote 51,000
      // rows, threw on a socket drop, and logged `rows_inserted: 0`, so the
      // ingestion ledger flatly contradicted the database.
      errors += 1;
      console.error(
        `[sync-federal-assistance-awards] stopping at page ${page} after ${FETCH_MAX_ATTEMPTS} attempts: ${
          (err as Error)?.message ?? err
        }. Committed so far: inserted=${inserted} updated=${updated}. Window is INCOMPLETE — re-run to continue.`,
      );
      break;
    }

    for (const a of results) {
      const awardUniqueId = a.generated_internal_id ? String(a.generated_internal_id) : null;
      if (!awardUniqueId) {
        errors += 1;
        continue;
      }
      const data = { awardUniqueId, ...toAwardData(a) };
      const existing = await prisma.federalAssistanceAward.findUnique({
        where: { awardUniqueId },
        select: { id: true },
      });
      await prisma.federalAssistanceAward.upsert({ where: { awardUniqueId }, create: data, update: data });
      if (existing) updated += 1;
      else inserted += 1;
    }

    if (!results.length) break;
    if (!pageMetadata.hasNext || pageMetadata.last_record_unique_id == null) break;
    cursor = {
      lastRecordUniqueId: pageMetadata.last_record_unique_id,
      lastRecordSortValue: pageMetadata.last_record_sort_value ?? '',
    };
  }

  return { inserted, updated, skipped: 0, errors };
}

async function main(): Promise<void> {
  const backfill = hasFlag('backfill');
  const endDate = isoDaysAgo(0);
  const startDate = backfill ? (arg('since') ?? '2020-10-01') : isoDaysAgo(Number(arg('days') ?? 7));
  const agency = arg('agency');
  const minAmountArg = arg('min-amount');
  const minAmount = minAmountArg ? Number(minAmountArg) : undefined;
  // Circuit breaker. The DAILY branch stays at 200 (a 7-day window is small;
  // 20,000 records is already far more than a normal day, so hitting it means
  // something is wrong and stopping is correct).
  //
  // The BACKFILL branch was 1000, which silently truncated: a live run of
  // `--since 2025-10-01 --min-amount 100000` on 2026-07-26 stopped at exactly
  // 100,000 records (1000 pages x 100) against a true total of 217,289 —
  // it looked like a clean success. Because results are sorted by Award Amount
  // desc, the cut landed at $1,153,549: everything above was captured, the
  // long tail below was silently absent.
  //
  // 3000 covers that window (2,173 pages) with headroom. Raising it is safe
  // because the walk stops on `hasNext: false` anyway — this bound only ever
  // binds on a runaway, and the retry/backoff added alongside it means a long
  // walk now survives the transient socket drops that used to kill it.
  const maxPages = backfill ? 3000 : 200;

  const prisma = new PrismaClient();
  await prisma.$connect();
  console.error(
    `[sync-federal-assistance-awards] window ${startDate}..${endDate}` +
      (agency ? ` agency=${agency}` : '') +
      (minAmount != null ? ` minAmount=${minAmount}` : ''),
  );

  try {
    const counts = await runWithSyncRun(
      prisma as unknown as Parameters<typeof runWithSyncRun>[0],
      'sync-federal-assistance-awards',
      async () => {
        const result = await syncAssistanceAwardsWindow(prisma as unknown as AssistanceAwardPrisma, {
          startDate,
          endDate,
          agency,
          minAmount,
          maxPages,
        });
        console.log(
          JSON.stringify(
            { source: 'sync-federal-assistance-awards', window: { startDate, endDate }, ...result },
            null,
            2,
          ),
        );
        return result;
      },
    );
    console.error(
      `[sync-federal-assistance-awards] DONE inserted=${counts.inserted} updated=${counts.updated} errors=${counts.errors}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

// Guard against firing on import — this module's testable exports (fetchPage,
// toAwardData, syncAssistanceAwardsWindow) are imported directly by the spec,
// which must not trigger a live PrismaClient connect + USAspending call.
if (require.main === module) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
