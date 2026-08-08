/**
 * MakeGov/Tango subaward sync for the shared federal-market substrate.
 *
 * DRY-RUN BY DEFAULT. A first unbounded committed run additionally requires
 * --allow-full so a typo cannot start a catalog-wide write.
 *
 * Tango's subaward endpoint does not expose a `modified_after` filter. It does
 * support `ordering=-last_modified_date`, so incremental runs walk newest-first
 * and stop only when a complete page is provably older than the persisted
 * overlap watermark. Rows with no source modification timestamp are processed
 * rather than silently skipped.
 */
import { createHash } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { TangoSubawardClient } from '../src/external/tango/tango-subaward.client.js';
import { mapTangoSubaward } from '../src/external/tango/tango-subaward.mapper.js';
import type {
  TangoSubaward,
  TangoSubawardGateway,
  TangoSubawardListOptions,
} from '../src/external/tango/tango-subaward.types.js';

dotenvConfig();

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_OVERLAP_HOURS = 6;

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
function value(argv: string[], name: string): string | undefined {
  const equal = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (equal) return equal.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}
function boundedInteger(
  raw: string | undefined,
  fallback: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`expected an integer from ${min} to ${max}, received "${raw}"`);
  }
  return parsed;
}
function optionalIso(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ISO date: ${raw}`);
  return new Date(parsed).toISOString();
}
function optionalUei(raw: string | undefined): string | undefined {
  if (raw == null) return undefined;
  const normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z0-9]{12}$/.test(normalized)) throw new Error(`invalid UEI: ${raw}`);
  return normalized;
}

export interface ParsedArgs {
  commit: boolean;
  allowFull: boolean;
  limit?: number;
  pageSize: number;
  overlapHours: number;
  /** Local newest-first stop watermark; it is not sent as an unsupported API filter. */
  modifiedAfter?: string;
  fiscalYear?: number;
  primeUei?: string;
  subawardeeUei?: string;
  /** Local post-map filter. Tango's documented endpoint has no state filter. */
  state?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const stateRaw = value(argv, 'state')?.trim().toUpperCase();
  if (stateRaw && !/^[A-Z]{2}$/.test(stateRaw)) throw new Error(`invalid state: ${stateRaw}`);
  return {
    commit: flag(argv, 'commit'),
    allowFull: flag(argv, 'allow-full'),
    limit: boundedInteger(value(argv, 'limit'), undefined, 1, 1_000_000),
    pageSize: boundedInteger(value(argv, 'page-size'), DEFAULT_PAGE_SIZE, 1, 100)!,
    overlapHours: boundedInteger(value(argv, 'overlap-hours'), DEFAULT_OVERLAP_HOURS, 0, 168)!,
    modifiedAfter: optionalIso(value(argv, 'modified-after')),
    fiscalYear: boundedInteger(value(argv, 'fiscal-year'), undefined, 1900, 2200),
    primeUei: optionalUei(value(argv, 'prime-uei')),
    subawardeeUei: optionalUei(value(argv, 'subawardee-uei')),
    state: stateRaw || undefined,
  };
}

export interface SubawardCheckpoint {
  windowStart: Date | null;
  windowEnd: Date | null;
  nextPage: number;
  completeness: 'complete' | 'in_progress';
  rowsProcessed: bigint;
}

export interface SubawardSyncDeps {
  gateway: TangoSubawardGateway;
  readCheckpoint: (syncKey: string) => Promise<SubawardCheckpoint | null>;
  writeCheckpoint: (
    syncKey: string,
    checkpoint: Omit<SubawardCheckpoint, 'rowsProcessed'> & { rowsProcessed: number },
  ) => Promise<void>;
  upsert: (row: TangoSubaward) => Promise<'written' | 'unchanged'>;
  now?: () => Date;
}

export interface SubawardSyncSummary {
  processed: number;
  mapped: number;
  written: number;
  unchanged: number;
  unmappable: number;
  filteredOut: number;
  olderThanWatermark: number;
  pages: number;
  totalReported: number | null;
  completeness: 'complete' | 'in_progress';
  nextPage: number | null;
  modifiedAfter: string | null;
  firstRun: boolean;
  commit: boolean;
}

function syncKeyFor(options: ParsedArgs): string {
  const stableFilters = JSON.stringify({
    fiscalYear: options.fiscalYear ?? null,
    primeUei: options.primeUei ?? null,
    subawardeeUei: options.subawardeeUei ?? null,
    state: options.state ?? null,
  });
  return `subawards:${createHash('sha256').update(stableFilters).digest('hex').slice(0, 32)}`;
}

export async function runSubawardSync(
  deps: SubawardSyncDeps,
  options: ParsedArgs,
): Promise<SubawardSyncSummary> {
  const now = deps.now ?? (() => new Date());
  const runStartedAt = now();
  const syncKey = syncKeyFor(options);
  const checkpoint = await deps.readCheckpoint(syncKey);
  const firstRun = checkpoint == null;

  const derivedModifiedAfter =
    options.modifiedAfter ??
    (checkpoint?.completeness === 'in_progress'
      ? checkpoint.windowStart?.toISOString()
      : checkpoint?.windowEnd
        ? new Date(checkpoint.windowEnd.getTime() - options.overlapHours * 3_600_000).toISOString()
        : undefined);
  const cutoffMs = derivedModifiedAfter ? Date.parse(derivedModifiedAfter) : null;

  if (
    options.commit &&
    firstRun &&
    derivedModifiedAfter == null &&
    options.fiscalYear == null &&
    options.primeUei == null &&
    options.subawardeeUei == null &&
    options.state == null &&
    !options.allowFull
  ) {
    throw new Error('first unbounded committed subaward sync requires --allow-full');
  }

  let pageNumber = checkpoint?.completeness === 'in_progress' ? checkpoint.nextPage : 1;
  let processed = 0;
  let mapped = 0;
  let written = 0;
  let unchanged = 0;
  let unmappable = 0;
  let filteredOut = 0;
  let olderThanWatermark = 0;
  let pages = 0;
  let totalReported: number | null = null;
  let nextPage: number | null = pageNumber;

  for (;;) {
    const remaining = options.limit == null ? options.pageSize : options.limit - processed;
    if (remaining <= 0) break;

    const request: TangoSubawardListOptions = {
      page: pageNumber,
      limit: Math.min(options.pageSize, remaining),
      ...(options.fiscalYear != null ? { fiscalYear: options.fiscalYear } : {}),
      ...(options.primeUei ? { primeUei: options.primeUei } : {}),
      ...(options.subawardeeUei ? { subawardeeUei: options.subawardeeUei } : {}),
    };
    const sourcePage = await deps.gateway.listSubawards(request);
    pages += 1;
    totalReported ??= sourcePage.totalCount;

    let pageOldRows = 0;
    let pageHasNewUnknownOrUnmappable = false;

    for (const raw of sourcePage.items) {
      processed += 1;
      const row = mapTangoSubaward(raw, runStartedAt.toISOString());
      if (!row) {
        unmappable += 1;
        pageHasNewUnknownOrUnmappable = true;
        continue;
      }
      mapped += 1;

      if (cutoffMs != null) {
        const modifiedMs = row.providerModifiedAt ? Date.parse(row.providerModifiedAt) : NaN;
        if (Number.isFinite(modifiedMs) && modifiedMs < cutoffMs) {
          pageOldRows += 1;
          olderThanWatermark += 1;
          continue;
        }
        // Missing/unparseable timestamps are processed rather than used as proof
        // that a page is safely older than the watermark.
        pageHasNewUnknownOrUnmappable = true;
      }

      if (options.state && row.placeOfPerformance?.state !== options.state) {
        filteredOut += 1;
        continue;
      }

      if (options.commit) {
        const result = await deps.upsert(row);
        if (result === 'written') written += 1;
        else unchanged += 1;
      }
    }

    // Because the provider response is ordered newest-first, one full page made
    // entirely of source-timestamped rows older than the overlap cutoff proves
    // every following page is also outside the incremental window.
    const reachedWatermark =
      cutoffMs != null &&
      sourcePage.items.length > 0 &&
      pageOldRows === sourcePage.items.length &&
      !pageHasNewUnknownOrUnmappable;
    nextPage = reachedWatermark ? null : sourcePage.nextPage;
    const complete = nextPage == null;

    if (options.commit) {
      await deps.writeCheckpoint(syncKey, {
        windowStart: derivedModifiedAfter ? new Date(derivedModifiedAfter) : null,
        windowEnd: complete ? runStartedAt : (checkpoint?.windowEnd ?? runStartedAt),
        nextPage: nextPage ?? 1,
        completeness: complete ? 'complete' : 'in_progress',
        rowsProcessed: processed,
      });
    }
    if (complete) break;
    // `complete` is `nextPage == null`, so past this guard nextPage is a number;
    // TS cannot narrow a closure-captured let, so assert it.
    pageNumber = nextPage!;
  }

  const stoppedByLimit = options.limit != null && processed >= options.limit && nextPage != null;
  return {
    processed,
    mapped,
    written,
    unchanged,
    unmappable,
    filteredOut,
    olderThanWatermark,
    pages,
    totalReported,
    completeness: stoppedByLimit || nextPage != null ? 'in_progress' : 'complete',
    nextPage,
    modifiedAfter: derivedModifiedAfter ?? null,
    firstRun,
    commit: options.commit,
  };
}

function readCheckpoint(prisma: PrismaClient): SubawardSyncDeps['readCheckpoint'] {
  return async (syncKey) => {
    const rows = await prisma.$queryRaw<
      Array<{
        windowStart: Date | null;
        windowEnd: Date | null;
        nextPage: number;
        completeness: string;
        rowsProcessed: bigint;
      }>
    >(Prisma.sql`
      SELECT window_start AS "windowStart", window_end AS "windowEnd",
             next_page AS "nextPage", completeness,
             rows_processed AS "rowsProcessed"
        FROM tango_subaward_sync_checkpoint
       WHERE sync_key = ${syncKey}
    `);
    const row = rows[0];
    if (!row) return null;
    return {
      windowStart: row.windowStart,
      windowEnd: row.windowEnd,
      nextPage: row.nextPage,
      completeness: row.completeness === 'in_progress' ? 'in_progress' : 'complete',
      rowsProcessed: row.rowsProcessed,
    };
  };
}

function writeCheckpoint(prisma: PrismaClient): SubawardSyncDeps['writeCheckpoint'] {
  return async (syncKey, checkpoint) => {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO tango_subaward_sync_checkpoint
        (sync_key, window_start, window_end, next_page, completeness, rows_processed, updated_at)
      VALUES
        (${syncKey}, ${checkpoint.windowStart}, ${checkpoint.windowEnd}, ${checkpoint.nextPage},
         ${checkpoint.completeness}, ${BigInt(checkpoint.rowsProcessed)}, CURRENT_TIMESTAMP)
      ON CONFLICT (sync_key) DO UPDATE SET
        window_start = EXCLUDED.window_start,
        window_end = EXCLUDED.window_end,
        next_page = EXCLUDED.next_page,
        completeness = EXCLUDED.completeness,
        rows_processed = EXCLUDED.rows_processed,
        updated_at = CURRENT_TIMESTAMP
    `);
  };
}

function upsertSubaward(prisma: PrismaClient): SubawardSyncDeps['upsert'] {
  return async (row) => {
    const pop = row.placeOfPerformance;
    const returned = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO tango_subaward (
        provider_key, award_key, prime_award_key, piid, subaward_number, subaward_type,
        subaward_amount, action_date, fiscal_year, description, naics_code,
        prime_recipient_uei, prime_recipient_name, prime_parent_uei, prime_parent_name,
        subawardee_uei, subawardee_name, subawardee_parent_uei, subawardee_parent_name,
        awarding_agency, awarding_office, funding_agency, funding_office,
        pop_country, pop_state, pop_city, pop_zip, pop_congressional_district,
        source_url, provider_modified_at, content_sha256, normalized_jsonb, active,
        first_synced_at, last_synced_at, created_at, updated_at
      ) VALUES (
        ${row.providerKey}, ${row.awardKey}, ${row.primeAwardKey}, ${row.piid},
        ${row.subawardNumber}, ${row.subawardType}, ${row.subawardAmount},
        ${row.actionDate ? new Date(`${row.actionDate}T00:00:00.000Z`) : null},
        ${row.fiscalYear}, ${row.description}, ${row.naicsCode},
        ${row.primeRecipientUei}, ${row.primeRecipientName}, ${row.primeParentUei}, ${row.primeParentName},
        ${row.subawardeeUei}, ${row.subawardeeName}, ${row.subawardeeParentUei}, ${row.subawardeeParentName},
        ${row.awardingAgency}, ${row.awardingOffice}, ${row.fundingAgency}, ${row.fundingOffice},
        ${pop?.country ?? null}, ${pop?.state ?? null}, ${pop?.city ?? null}, ${pop?.zip ?? null},
        ${pop?.congressionalDistrict ?? null}, ${row.sourceUrl},
        ${row.providerModifiedAt ? new Date(row.providerModifiedAt) : null},
        ${row.contentSha256}, ${JSON.stringify(row.normalized)}::jsonb, TRUE,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT (provider_key) DO UPDATE SET
        award_key = EXCLUDED.award_key,
        prime_award_key = EXCLUDED.prime_award_key,
        piid = EXCLUDED.piid,
        subaward_number = EXCLUDED.subaward_number,
        subaward_type = EXCLUDED.subaward_type,
        subaward_amount = EXCLUDED.subaward_amount,
        action_date = EXCLUDED.action_date,
        fiscal_year = EXCLUDED.fiscal_year,
        description = EXCLUDED.description,
        naics_code = EXCLUDED.naics_code,
        prime_recipient_uei = EXCLUDED.prime_recipient_uei,
        prime_recipient_name = EXCLUDED.prime_recipient_name,
        prime_parent_uei = EXCLUDED.prime_parent_uei,
        prime_parent_name = EXCLUDED.prime_parent_name,
        subawardee_uei = EXCLUDED.subawardee_uei,
        subawardee_name = EXCLUDED.subawardee_name,
        subawardee_parent_uei = EXCLUDED.subawardee_parent_uei,
        subawardee_parent_name = EXCLUDED.subawardee_parent_name,
        awarding_agency = EXCLUDED.awarding_agency,
        awarding_office = EXCLUDED.awarding_office,
        funding_agency = EXCLUDED.funding_agency,
        funding_office = EXCLUDED.funding_office,
        pop_country = EXCLUDED.pop_country,
        pop_state = EXCLUDED.pop_state,
        pop_city = EXCLUDED.pop_city,
        pop_zip = EXCLUDED.pop_zip,
        pop_congressional_district = EXCLUDED.pop_congressional_district,
        source_url = EXCLUDED.source_url,
        provider_modified_at = EXCLUDED.provider_modified_at,
        content_sha256 = EXCLUDED.content_sha256,
        normalized_jsonb = EXCLUDED.normalized_jsonb,
        active = TRUE,
        last_synced_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE tango_subaward.content_sha256 IS DISTINCT FROM EXCLUDED.content_sha256
      RETURNING id
    `);
    return returned.length ? 'written' : 'unchanged';
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = (process.env.TANGO_API_KEY ?? '').trim();
  if (!apiKey) throw new Error('No TANGO_API_KEY configured');

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const gateway = new TangoSubawardClient({
      apiKey,
      baseUrl: process.env.TANGO_API_BASE_URL,
      timeoutMs: process.env.TANGO_TIMEOUT_MS ? Number(process.env.TANGO_TIMEOUT_MS) : undefined,
    });
    const summary = await runSubawardSync(
      {
        gateway,
        readCheckpoint: readCheckpoint(prisma),
        writeCheckpoint: writeCheckpoint(prisma),
        upsert: upsertSubaward(prisma),
      },
      args,
    );
    console.log(`TANGO_SUBAWARD_SYNC_DONE ${JSON.stringify(summary)}`);
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = /sync-tango-subawards(\.[cm]?[tj]s)?$/.test(
  (process.argv[1] ?? '').replace(/\\/g, '/'),
);
if (isDirectRun) {
  void main().catch((error: unknown) => {
    const secret = process.env.TANGO_API_KEY ?? '';
    const message = (error instanceof Error ? error.message : String(error)).replace(
      secret,
      '[REDACTED]',
    );
    console.error('TANGO_SUBAWARD_SYNC_ERR', message);
    process.exitCode = 1;
  });
}

export { main };
