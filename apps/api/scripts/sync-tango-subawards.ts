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
 *
 * STABLE PAGINATION (R4 repair, 2026-09-08): Tango paginates by OFFSET, so
 * "page N" only identifies a stable slice of the corpus for ONE fixed request
 * limit. The first committed run used --limit 25, which shrank its request to
 * 25 rows; its checkpoint stored next_page=2 but not that size, so a resume at
 * the default 100 would jump to item 101 and silently skip items 26-100. The
 * walk's page size is now persisted in the checkpoint and is authoritative
 * for resumes; a legacy checkpoint without one fails closed and is recovered
 * only by the explicit --resume-page-size operator assertion. Within a run the
 * request limit NEVER shrinks for a partial final page — a bounded run
 * processes whole pages and stops, so page boundaries never move mid-walk.
 */
import { config as dotenvConfig } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { TangoSubawardClient } from '../src/external/tango/tango-subaward.client.js';
import { mapTangoSubaward } from '../src/external/tango/tango-subaward.mapper.js';
import { subawardSyncKeyFor } from '../src/external/tango/tango-subaward-sync-key.js';
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
  name: string,
  raw: string | undefined,
  fallback: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name}: expected an integer from ${min} to ${max}, received "${raw}"`);
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
  /**
   * Operator assertion that a legacy in_progress checkpoint (written before
   * page sizes were persisted) was produced with this page size. Required to
   * resume such a checkpoint; refused when the checkpoint already knows its
   * size or when there is nothing to recover.
   */
  resumePageSize?: number;
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
    limit: boundedInteger('limit', value(argv, 'limit'), undefined, 1, 1_000_000),
    pageSize: boundedInteger('page-size', value(argv, 'page-size'), DEFAULT_PAGE_SIZE, 1, 100)!,
    resumePageSize: boundedInteger(
      'resume-page-size',
      value(argv, 'resume-page-size'),
      undefined,
      1,
      100,
    ),
    overlapHours: boundedInteger(
      'overlap-hours',
      value(argv, 'overlap-hours'),
      DEFAULT_OVERLAP_HOURS,
      0,
      168,
    )!,
    modifiedAfter: optionalIso(value(argv, 'modified-after')),
    fiscalYear: boundedInteger('fiscal-year', value(argv, 'fiscal-year'), undefined, 1900, 2200),
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
  /** Page size the in_progress walk was actually using; null on legacy rows. */
  pageSize: number | null;
  /** How pageSize was established: 'run_arg' | 'checkpoint' | 'resume_flag'. */
  pageSizeSource: string | null;
  /** Last provider-reported catalog total observed by this walk; null when never reported. */
  totalReported: bigint | null;
}

export interface SubawardSyncDeps {
  gateway: TangoSubawardGateway;
  readCheckpoint: (syncKey: string) => Promise<SubawardCheckpoint | null>;
  writeCheckpoint: (
    syncKey: string,
    checkpoint: Omit<SubawardCheckpoint, 'rowsProcessed' | 'totalReported'> & {
      rowsProcessed: number;
      totalReported: number | null;
    },
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
  /** Page size this run actually requested on every page (stable within the walk). */
  effectivePageSize: number;
  /** How effectivePageSize was established for this run. */
  pageSizeSource: 'run_arg' | 'checkpoint' | 'resume_flag';
  /** True when a CLI --page-size was deliberately overridden by the persisted walk size. */
  requestedPageSizeIgnored: boolean;
}

function syncKeyFor(options: ParsedArgs): string {
  return subawardSyncKeyFor({
    fiscalYear: options.fiscalYear ?? null,
    primeUei: options.primeUei ?? null,
    subawardeeUei: options.subawardeeUei ?? null,
    state: options.state ?? null,
  });
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
  const resuming = checkpoint?.completeness === 'in_progress';

  const derivedModifiedAfter =
    options.modifiedAfter ??
    (checkpoint?.completeness === 'in_progress'
      ? checkpoint.windowStart?.toISOString()
      : checkpoint?.windowEnd
        ? new Date(checkpoint.windowEnd.getTime() - options.overlapHours * 3_600_000).toISOString()
        : undefined);
  const cutoffMs = derivedModifiedAfter ? Date.parse(derivedModifiedAfter) : null;

  // --- --resume-page-size coherence, validated BEFORE the allow-full guard. ---
  // It is a pure state check (no provider I/O), and its error is strictly more
  // specific than the generic unbounded-run acknowledgement. Reordering does
  // not weaken that guard: a genuinely fresh unbounded committed run without
  // --resume-page-size still hits it below.
  if (options.resumePageSize != null && !resuming) {
    throw new Error(
      firstRun
        ? '--resume-page-size requires an in_progress checkpoint to recover; there is no checkpoint for this sync key.'
        : '--resume-page-size requires an in_progress checkpoint to recover; this sync key is already complete (nothing to recover).',
    );
  }
  if (resuming && checkpoint!.pageSize != null && options.resumePageSize != null) {
    if (options.resumePageSize !== checkpoint!.pageSize) {
      throw new Error(
        `--resume-page-size ${options.resumePageSize} contradicts the checkpoint's ` +
          `recorded page size ${checkpoint!.pageSize} for ${syncKey}; ` +
          `a size change mid-walk moves provider page boundaries and skips records. ` +
          `Resume without --resume-page-size to continue at ${checkpoint!.pageSize}.`,
      );
    }
  }

  if (
    options.commit &&
    firstRun &&
    derivedModifiedAfter == null &&
    options.fiscalYear == null &&
    options.primeUei == null &&
    options.subawardeeUei == null &&
    options.state == null &&
    options.limit == null &&
    !options.allowFull
  ) {
    throw new Error('first unbounded committed subaward sync requires --allow-full');
  }

  // --- Effective page size: the stable walk size, resolved ONCE per run. ---
  // A fresh bounded run with limit < page size establishes the walk at the
  // smaller size (exactly what the 2026-09-08 first run did with --limit 25);
  // a limit at or above the page size walks whole pages and may overshoot the
  // limit to the next whole-page boundary, never under-delivering and never
  // renumbering mid-walk. Resumes always continue at the persisted size.
  let effectivePageSize: number;
  let pageSizeSource: 'run_arg' | 'checkpoint' | 'resume_flag';
  if (resuming) {
    if (checkpoint!.pageSize == null) {
      // Legacy in_progress checkpoint (pre-2026-09-08 schema/write): the page
      // numbering's meaning is unknown. Resuming at ANY size can skip records;
      // fail closed unless the operator explicitly asserts the original size.
      if (options.resumePageSize == null) {
        throw new Error(
          `in_progress subaward checkpoint ${syncKey} has no recorded page size; ` +
            `resuming at --page-size ${options.pageSize} could skip records. ` +
            `Recover explicitly with --resume-page-size <size of the original run> ` +
            `(the 2026-09-08 bounded first run used 25), or let a fresh walk restart.`,
        );
      }
      effectivePageSize = options.resumePageSize;
      pageSizeSource = 'resume_flag';
    } else {
      effectivePageSize = checkpoint!.pageSize;
      pageSizeSource = 'checkpoint';
    }
  } else {
    effectivePageSize =
      options.limit == null ? options.pageSize : Math.min(options.pageSize, options.limit);
    pageSizeSource = 'run_arg';
  }
  const requestedPageSizeIgnored =
    pageSizeSource === 'checkpoint' && options.pageSize !== effectivePageSize;
  // The checkpoint's recorded source is the ORIGINAL establishment of the
  // walk's size (how we know it), not how this particular run resolved it;
  // writing 'checkpoint' would be circular, so a known size carries its
  // provenance forward and only a legacy recovery rewrites it.
  const establishedSource: 'run_arg' | 'checkpoint' | 'resume_flag' =
    resuming && checkpoint!.pageSize != null
      ? ((checkpoint!.pageSizeSource as 'run_arg' | 'resume_flag' | null) ?? 'checkpoint')
      : pageSizeSource;

  let pageNumber = resuming ? checkpoint!.nextPage : 1;
  let processed = 0;
  let mapped = 0;
  let written = 0;
  let unchanged = 0;
  let unmappable = 0;
  let filteredOut = 0;
  let olderThanWatermark = 0;
  let pages = 0;
  let totalReported: number | null = checkpoint?.totalReported
    ? Number(checkpoint.totalReported)
    : null;
  let nextPage: number | null = pageNumber;

  for (;;) {
    // A bounded run stops at a whole-page boundary BEFORE requesting a page it
    // does not intend to consume. It never shrinks the request: a smaller
    // final request moves the provider's page boundaries and skips records on
    // resume. --limit therefore bounds rows "up to the next page boundary"
    // (processed can exceed limit by at most one partial page's remainder —
    // never under-deliver, never renumber mid-walk).
    if (options.limit != null && processed >= options.limit) break;

    const request: TangoSubawardListOptions = {
      page: pageNumber,
      limit: effectivePageSize,
      ...(options.fiscalYear != null ? { fiscalYear: options.fiscalYear } : {}),
      ...(options.primeUei ? { primeUei: options.primeUei } : {}),
      ...(options.subawardeeUei ? { subawardeeUei: options.subawardeeUei } : {}),
    };
    const sourcePage = await deps.gateway.listSubawards(request);
    pages += 1;
    if (sourcePage.totalCount != null) totalReported = sourcePage.totalCount;

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
        pageSize: effectivePageSize,
        pageSizeSource: establishedSource,
        totalReported,
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
    effectivePageSize,
    pageSizeSource,
    requestedPageSizeIgnored,
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
        pageSize: number | null;
        pageSizeSource: string | null;
        totalReported: bigint | null;
      }>
    >(Prisma.sql`
      SELECT window_start AS "windowStart", window_end AS "windowEnd",
             next_page AS "nextPage", completeness,
             rows_processed AS "rowsProcessed",
             page_size AS "pageSize", page_size_source AS "pageSizeSource",
             total_reported AS "totalReported"
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
      pageSize: row.pageSize,
      pageSizeSource: row.pageSizeSource,
      totalReported: row.totalReported,
    };
  };
}

function writeCheckpoint(prisma: PrismaClient): SubawardSyncDeps['writeCheckpoint'] {
  return async (syncKey, checkpoint) => {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO tango_subaward_sync_checkpoint
        (sync_key, window_start, window_end, next_page, completeness, rows_processed,
         page_size, page_size_source, total_reported, updated_at)
      VALUES
        (${syncKey}, ${checkpoint.windowStart}, ${checkpoint.windowEnd}, ${checkpoint.nextPage},
         ${checkpoint.completeness}, ${BigInt(checkpoint.rowsProcessed)},
         ${checkpoint.pageSize}, ${checkpoint.pageSizeSource},
         ${checkpoint.totalReported == null ? null : BigInt(checkpoint.totalReported)},
         CURRENT_TIMESTAMP)
      ON CONFLICT (sync_key) DO UPDATE SET
        window_start = EXCLUDED.window_start,
        window_end = EXCLUDED.window_end,
        next_page = EXCLUDED.next_page,
        completeness = EXCLUDED.completeness,
        rows_processed = EXCLUDED.rows_processed,
        page_size = EXCLUDED.page_size,
        page_size_source = EXCLUDED.page_size_source,
        total_reported = EXCLUDED.total_reported,
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
  const prisma = new PrismaClient();
  const commit = process.argv.includes('--commit');
  try {
    await runWithSyncRun(
      prisma,
      `sync-tango-subawards${commit ? '' : ':dry-run'}`,
      async () => {
        const args = parseArgs(process.argv.slice(2));
        const apiKey = (process.env.TANGO_API_KEY ?? '').trim();
        if (!apiKey) throw new Error('No TANGO_API_KEY configured');
        const gateway = new TangoSubawardClient({
          apiKey,
          baseUrl: process.env.TANGO_API_BASE_URL,
          timeoutMs: process.env.TANGO_TIMEOUT_MS
            ? Number(process.env.TANGO_TIMEOUT_MS)
            : undefined,
        });
        // Tango's page checkpoint is authoritative; the generic SyncRun watermark
        // must not replace its overlap window or advance an unfinished backfill.
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
        return {
          inserted: 0,
          updated: summary.written,
          skipped: summary.unchanged + summary.filteredOut + summary.olderThanWatermark,
          errors: summary.unmappable,
          complete: commit && summary.completeness === 'complete',
          incompleteReason: commit
            ? 'Bounded run; resume at persisted Tango page checkpoint'
            : 'Dry run: no facts or checkpoint committed',
        };
      },
      { metricFormat: 'json' },
    );
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = /sync-tango-subawards(\.[cm]?[jt]s)?$/.test(
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
