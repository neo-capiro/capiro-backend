/**
 * District Nexus — assistance-award enrichment via USAspending's BULK DOWNLOAD.
 *
 *   # dry run (submits + downloads + parses, writes NOTHING)
 *   tsx scripts/backfill-assistance-awards-bulk.ts --start 2026-01-01 --end 2026-01-31
 *   # real backfill, one month at a time, matching the ingest floor
 *   tsx scripts/backfill-assistance-awards-bulk.ts \
 *       --start 2024-10-01 --end 2026-07-31 --chunk-months 1 --min-amount 100000 --commit
 *
 * WHY THIS EXISTS
 * ---------------
 * `enrich-assistance-award-details.ts` walks the per-award detail endpoint one
 * award at a time. On 2026-07-28 USAspending's edge blocked this NAT IP outright
 * under that load, and even unblocked at 1 req/s the ~238k-row backlog is ~66
 * hours of uninterrupted hammering. That script is now correctly scoped to
 * keeping the recent HEAD enriched; depth belongs here.
 *
 * This rail makes ONE request per time-chunk instead of one per award: the
 * server does the work, we fetch a zip.
 *
 * CONTRACT — every line below was verified live against api.usaspending.gov on
 * 2026-07-28, not taken from documentation.
 *
 *  - `POST /api/v2/download/awards/` → `{file_name, file_url, status_url}`.
 *    Filters accepted (and ECHOED BACK, which is how they were verified):
 *      award_type_codes: ['02','03','04','05']    ← assistance only, never contracts
 *      time_period:      [{date_type:'action_date', start_date, end_date}]
 *      award_amounts:    [{lower_bound: n}]       ← matches the ingest's own floor
 *    ⚠️ The sibling endpoint `/api/v2/bulk_download/awards/` takes a DIFFERENT
 *    filter schema (`prime_award_types`, `date_range`) and returns
 *    TRANSACTION-level rows. Sending this endpoint's filters to that one, or
 *    vice versa, does not error — the unrecognised keys are silently dropped and
 *    you get an unfiltered, wrong-grain download. Verified by reading the echoed
 *    `download_request.filters` back on both.
 *
 *  - `GET /api/v2/download/status?file_name=…` → `{status, total_rows,
 *    total_columns, total_size}`. Observed statuses: `running`, `finished`,
 *    `failed`. A VT/Jan-2026 request finished in ~17s.
 *
 *  - The zip contains TWO members for assistance:
 *      Assistance_PrimeAwardSummaries_*.csv  (100 cols, ONE ROW PER AWARD)
 *      Assistance_Subawards_*.csv            (113 cols, one row per subaward)
 *
 *  - Join key: the summaries file's `assistance_award_unique_key` IS our
 *    `federal_assistance_award.award_unique_id` (both `ASST_NON_…`). Verified by
 *    taking the five largest VT/Jan-2026 keys from a real download and matching
 *    5 of 5 in the live table.
 *
 *  - Subawards join on `prime_award_unique_key`.
 *
 * FIELD MAP — the six fields the per-award pass exists to fill:
 *      award_id_fain                      → fain
 *      award_id_uri                       → uri
 *      total_non_federal_funding_amount   → nonFederalFundingAmount
 *      funding_opportunity_number         → fundingOpportunityNumber
 *      recipient_parent_name              → parentRecipientName
 *      recipient_parent_uei               → parentRecipientUei   (shape-gated)
 *      COUNT(subaward rows)               → subawardCount        (only when > 0)
 *
 *  ⚠️ `total_non_federal_funding_amount` is the AWARD-level total. The
 *  transaction-level file's `non_federal_funding_amount` is per-transaction and
 *  would understate a multi-transaction award. Only the summaries file is read.
 *
 *  ⚠️ `recipient_parent_duns` sits directly beside `recipient_parent_uei` in the
 *  CSV (columns 44 and 43). It is the retired DUNS and must never reach a UEI
 *  column; `asUei` is the only path in and it rejects a 9-digit DUNS.
 *
 * HONESTY RULES
 * -------------
 *  - Fill-only. `buildEnrichmentUpdate` is imported from the per-award script
 *    rather than reimplemented, so both rails share one definition of "never
 *    overwrite a value we already have".
 *  - `subawardCount` is written ONLY when the download actually contained
 *    subaward rows for that award. The subaward file is filtered by the same
 *    time window, so an award's subawards can legitimately fall outside the
 *    chunk — writing 0 would assert "this award has no subawards", which the
 *    data does not support. It stays null instead.
 *  - `detailEnrichedAt` is stamped only on awards actually present in the file.
 *  - A chunk whose row count reaches the server's 500,000 cap is TRUNCATED, and
 *    that fails the run loudly rather than being recorded as a complete pass.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import JSZip from 'jszip';
import { runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import {
  asUei,
  buildEnrichmentUpdate,
  type AwardDetailRaw,
  type ExistingAssistanceAwardRow,
} from './enrich-assistance-award-details.js';

dotenvConfig();

export const SYNC_SOURCE = 'backfill-assistance-awards-bulk';

const DOWNLOAD_URL = 'https://api.usaspending.gov/api/v2/download/awards/';
const STATUS_URL = 'https://api.usaspending.gov/api/v2/download/status';

/** Assistance only: block grant / formula grant / project grant / cooperative agreement. */
export const ASSISTANCE_AWARD_TYPE_CODES = ['02', '03', '04', '05'] as const;

/**
 * The server's own per-download row cap, echoed as `limit` in the submit
 * response (verified live: 500000). A chunk that REACHES it has been silently
 * truncated server-side, which is the one failure mode that would look like
 * success — so it is treated as fatal for the chunk.
 */
export const SERVER_ROW_CAP = 500_000;

/** Poll cadence and ceiling for the server-side file generation. */
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000;

/** DB write batch size — keeps a single transaction from getting unreasonable. */
const UPDATE_BATCH = 250;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Chunking ───────────────────────────────────────────────────────────────

export interface DateChunk {
  startDate: string;
  endDate: string;
}

/**
 * Split an inclusive [start, end] range into month-aligned chunks of
 * `chunkMonths`. Month-aligned rather than fixed-day so a chunk boundary is
 * reproducible across runs — a resumed backfill re-requests exactly the same
 * windows, which is what makes the fill-only writes idempotent.
 */
export function buildDateChunks(start: string, end: string, chunkMonths: number): DateChunk[] {
  if (chunkMonths < 1) throw new Error(`--chunk-months must be >= 1 (got ${chunkMonths})`);
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime())) throw new Error(`--start is not a date: ${start}`);
  if (Number.isNaN(endDate.getTime())) throw new Error(`--end is not a date: ${end}`);
  if (startDate > endDate) throw new Error(`--start ${start} is after --end ${end}`);

  const chunks: DateChunk[] = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    // First day of the month `chunkMonths` after the cursor's month, minus 1 day.
    const nextBoundary = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + chunkMonths, 1),
    );
    const chunkEnd = new Date(nextBoundary.getTime() - 24 * 60 * 60 * 1000);
    const effectiveEnd = chunkEnd > endDate ? endDate : chunkEnd;
    chunks.push({
      startDate: cursor.toISOString().slice(0, 10),
      endDate: effectiveEnd.toISOString().slice(0, 10),
    });
    cursor = new Date(effectiveEnd.getTime() + 24 * 60 * 60 * 1000);
  }
  return chunks;
}

// ─── USAspending download client ────────────────────────────────────────────

export interface DownloadSubmission {
  fileName: string;
  fileUrl: string;
  /** The filters the server echoed back — the only way to know a key was accepted. */
  echoedFilters: Record<string, unknown>;
}

export interface DownloadStatus {
  status: string;
  totalRows: number | null;
  totalColumns: number | null;
  totalSizeKb: number | null;
  message: string | null;
}

export interface BulkDownloadClient {
  submit(chunk: DateChunk, minAmount: number | null): Promise<DownloadSubmission>;
  status(fileName: string): Promise<DownloadStatus>;
  fetchZip(fileUrl: string): Promise<Uint8Array>;
}

export function buildDownloadRequest(
  chunk: DateChunk,
  minAmount: number | null,
): Record<string, unknown> {
  const filters: Record<string, unknown> = {
    award_type_codes: [...ASSISTANCE_AWARD_TYPE_CODES],
    time_period: [
      { start_date: chunk.startDate, end_date: chunk.endDate, date_type: 'action_date' },
    ],
  };
  if (minAmount != null) filters.award_amounts = [{ lower_bound: minAmount }];
  return { filters, columns: [], file_format: 'csv' };
}

/**
 * The filter keys we depend on. If the server stops echoing one of these back,
 * it stopped honouring it, and the download is silently broader than requested
 * — so the run stops instead of writing data from the wrong window.
 */
export function assertFiltersHonoured(
  echoed: Record<string, unknown>,
  minAmount: number | null,
): void {
  const required = ['award_type_codes', 'time_period', ...(minAmount != null ? ['award_amounts'] : [])];
  const missing = required.filter((k) => !(k in echoed));
  if (missing.length) {
    throw new Error(
      `USAspending did not honour filter(s) ${missing.join(', ')} — it echoed only ` +
        `${Object.keys(echoed).join(', ')}. The generated file would cover a wider window than ` +
        `requested; refusing to enrich from it.`,
    );
  }
}

export const liveDownloadClient: BulkDownloadClient = {
  async submit(chunk, minAmount) {
    const res = await fetch(DOWNLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildDownloadRequest(chunk, minAmount)),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`USAspending download submit ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      file_name: string;
      file_url: string;
      download_request?: { filters?: Record<string, unknown> };
    };
    return {
      fileName: json.file_name,
      fileUrl: json.file_url,
      echoedFilters: json.download_request?.filters ?? {},
    };
  },

  async status(fileName) {
    const url = `${STATUS_URL}?file_name=${encodeURIComponent(fileName)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`USAspending download status ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      status?: string;
      total_rows?: number | null;
      total_columns?: number | null;
      total_size?: number | null;
      message?: string | null;
    };
    return {
      status: json.status ?? 'unknown',
      totalRows: json.total_rows ?? null,
      totalColumns: json.total_columns ?? null,
      totalSizeKb: json.total_size ?? null,
      message: json.message ?? null,
    };
  },

  async fetchZip(fileUrl) {
    const res = await fetch(fileUrl);
    if (!res.ok) {
      throw new Error(`USAspending download fetch ${res.status} for ${fileUrl}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  },
};

/** Poll until the server finishes generating the file, or give up loudly. */
export async function waitForDownload(
  client: Pick<BulkDownloadClient, 'status'>,
  fileName: string,
  deps: { sleep: (ms: number) => Promise<void>; now: () => number } = { sleep, now: Date.now },
): Promise<DownloadStatus> {
  const deadline = deps.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const status = await client.status(fileName);
    if (status.status === 'finished') return status;
    if (status.status === 'failed') {
      throw new Error(
        `USAspending reported the download failed: ${status.message ?? '(no message)'}`,
      );
    }
    if (deps.now() >= deadline) {
      throw new Error(
        `USAspending download ${fileName} still "${status.status}" after ` +
          `${Math.round(POLL_TIMEOUT_MS / 60000)} minutes — giving up rather than polling forever.`,
      );
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}

// ─── CSV ────────────────────────────────────────────────────────────────────

/**
 * RFC-4180-ish row reader. Deliberately a local copy of the shape used by
 * `fara-enrichment.parseCsv` rather than an import: these files carry quoted
 * award descriptions containing commas AND embedded newlines, so a line-split
 * parser silently mangles rows, and this one is exercised by this script's own
 * fixture test.
 */
export function parseCsvRows(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c === '\r') {
      /* swallow; \n closes the row */
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length < 2) return [];
  // Strip a UTF-8 BOM off the first header cell if present.
  const header = rows[0]!.map((h, idx) => (idx === 0 ? h.replace(/^﻿/, '') : h).trim());
  return rows
    .slice(1)
    .filter((r) => r.some((cell) => cell.trim().length))
    .map((r) => {
      const obj: Record<string, string> = {};
      header.forEach((h, idx) => {
        obj[h] = (r[idx] ?? '').trim();
      });
      return obj;
    });
}

/** `''` is "absent" in these files; never coerce it to 0 or to a string. */
function nullableString(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length ? trimmed : null;
}

function nullableNumber(value: string | undefined): number | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed.length) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// ─── Zip → award patches ────────────────────────────────────────────────────

export interface BulkChunkContents {
  /** One entry per award, keyed by `assistance_award_unique_key`. */
  awards: Map<string, AwardDetailRaw>;
  /** Subaward counts keyed by `prime_award_unique_key`; only awards WITH subawards appear. */
  subawardCounts: Map<string, number>;
  summaryRowCount: number;
  subawardRowCount: number;
}

/**
 * Map one award-summaries CSV row onto the same shape the per-award detail
 * endpoint returns, so `buildEnrichmentUpdate` — the single definition of the
 * fill-only rules — can be reused verbatim for both rails.
 */
export function summaryRowToDetail(row: Record<string, string>): AwardDetailRaw {
  return {
    fain: nullableString(row.award_id_fain),
    uri: nullableString(row.award_id_uri),
    non_federal_funding: nullableNumber(row.total_non_federal_funding_amount),
    funding_opportunity: { number: nullableString(row.funding_opportunity_number) },
    recipient: {
      parent_recipient_name: nullableString(row.recipient_parent_name),
      // asUei rejects the DUNS sitting in the adjacent column.
      parent_recipient_uei: asUei(nullableString(row.recipient_parent_uei)),
    },
  };
}

export async function readChunkZip(zipBytes: Uint8Array): Promise<BulkChunkContents> {
  const zip = await JSZip.loadAsync(zipBytes);
  const names = Object.keys(zip.files);
  const summaryNames = names.filter((n) => /Assistance_PrimeAwardSummaries.*\.csv$/i.test(n));
  const subawardNames = names.filter((n) => /Assistance_Subawards.*\.csv$/i.test(n));

  if (!summaryNames.length) {
    throw new Error(
      `No Assistance_PrimeAwardSummaries CSV in the download (members: ${names.join(', ')}). ` +
        `A contracts-only or transaction-level file means the request went to the wrong ` +
        `endpoint or carried the wrong award_type_codes.`,
    );
  }

  const awards = new Map<string, AwardDetailRaw>();
  let summaryRowCount = 0;
  for (const name of summaryNames) {
    const text = await zip.files[name]!.async('string');
    for (const row of parseCsvRows(text)) {
      const key = nullableString(row.assistance_award_unique_key);
      if (!key) continue;
      summaryRowCount += 1;
      awards.set(key, summaryRowToDetail(row));
    }
  }

  const subawardCounts = new Map<string, number>();
  let subawardRowCount = 0;
  for (const name of subawardNames) {
    const text = await zip.files[name]!.async('string');
    for (const row of parseCsvRows(text)) {
      const key = nullableString(row.prime_award_unique_key);
      if (!key) continue;
      subawardRowCount += 1;
      subawardCounts.set(key, (subawardCounts.get(key) ?? 0) + 1);
    }
  }

  return { awards, subawardCounts, summaryRowCount, subawardRowCount };
}

// ─── Persistence ────────────────────────────────────────────────────────────

export interface BulkPrisma {
  federalAssistanceAward: {
    findMany(args: unknown): Promise<ExistingAssistanceAwardRow[]>;
    update(args: { where: { id: string }; data: unknown }): Promise<unknown>;
  };
}

export interface ChunkOutcome extends RunCounts {
  /** Awards present in the download that we do not hold — expected, not an error. */
  notHeld: number;
  summaryRowCount: number;
  subawardRowCount: number;
}

/**
 * Apply one chunk's contents. Only rows we already hold are touched — this rail
 * enriches, it never inserts. An award in the file that we never ingested is
 * counted as `notHeld` and skipped: inserting it here would smuggle rows past
 * the ingest's own filters and provenance.
 */
export async function applyChunk(
  prisma: BulkPrisma,
  contents: BulkChunkContents,
  options: { commit: boolean },
): Promise<ChunkOutcome> {
  const keys = [...contents.awards.keys()];
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let matched = 0;

  for (let i = 0; i < keys.length; i += UPDATE_BATCH) {
    const batchKeys = keys.slice(i, i + UPDATE_BATCH);
    const existing = await prisma.federalAssistanceAward.findMany({
      where: { awardUniqueId: { in: batchKeys } },
      select: {
        id: true,
        awardUniqueId: true,
        fain: true,
        uri: true,
        subawardCount: true,
        nonFederalFundingAmount: true,
        fundingOpportunityNumber: true,
        parentRecipientName: true,
        parentRecipientUei: true,
      },
    });
    matched += existing.length;

    for (const row of existing) {
      const detail = contents.awards.get(row.awardUniqueId);
      if (!detail) continue;
      // Only assert a subaward count when the file actually carried subawards
      // for this award; absence here is "unknown", not "zero".
      const subawardCount = contents.subawardCounts.get(row.awardUniqueId);
      const withSubawards: AwardDetailRaw =
        subawardCount != null ? { ...detail, subaward_count: subawardCount } : detail;

      const update = buildEnrichmentUpdate(row, withSubawards);
      // `detailEnrichedAt` is always present, so >1 key means real new data.
      const fieldsFilled = Object.keys(update).length - 1;
      if (!options.commit) {
        if (fieldsFilled > 0) updated += 1;
        else skipped += 1;
        continue;
      }
      try {
        await prisma.federalAssistanceAward.update({ where: { id: row.id }, data: update });
        if (fieldsFilled > 0) updated += 1;
        else skipped += 1;
      } catch (e) {
        errors += 1;
        console.error(
          `[${SYNC_SOURCE}] ${row.awardUniqueId} update failed: ${(e as Error).message}`,
        );
      }
    }
  }

  return {
    inserted: 0,
    updated,
    skipped,
    errors,
    notHeld: keys.length - matched,
    summaryRowCount: contents.summaryRowCount,
    subawardRowCount: contents.subawardRowCount,
  };
}

// ─── Orchestration ──────────────────────────────────────────────────────────

export interface BackfillOptions {
  chunks: DateChunk[];
  minAmount: number | null;
  commit: boolean;
}

export async function runBackfill(
  prisma: BulkPrisma,
  client: BulkDownloadClient,
  options: BackfillOptions,
  deps: { sleep: (ms: number) => Promise<void>; now: () => number } = { sleep, now: Date.now },
): Promise<RunCounts> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const [index, chunk] of options.chunks.entries()) {
    const label = `${chunk.startDate}..${chunk.endDate}`;
    console.error(`[${SYNC_SOURCE}] chunk ${index + 1}/${options.chunks.length} ${label} — submitting`);

    const submission = await client.submit(chunk, options.minAmount);
    assertFiltersHonoured(submission.echoedFilters, options.minAmount);

    const status = await waitForDownload(client, submission.fileName, deps);

    // The one failure mode that would otherwise read as success.
    if (status.totalRows != null && status.totalRows >= SERVER_ROW_CAP) {
      throw new Error(
        `chunk ${label} returned ${status.totalRows} rows, at or above the server cap of ` +
          `${SERVER_ROW_CAP}. The file is TRUNCATED and this chunk is incomplete. Re-run with a ` +
          `smaller --chunk-months (or a higher --min-amount) rather than accepting a partial pass.`,
      );
    }

    const zipBytes = await client.fetchZip(submission.fileUrl);
    const contents = await readChunkZip(zipBytes);
    const outcome = await applyChunk(prisma, contents, { commit: options.commit });

    inserted += outcome.inserted;
    updated += outcome.updated;
    skipped += outcome.skipped;
    errors += outcome.errors;

    console.log(
      `BULK_CHUNK ${JSON.stringify({
        source: SYNC_SOURCE,
        chunk: label,
        committed: options.commit,
        serverRows: status.totalRows,
        sizeKb: status.totalSizeKb,
        summaryRows: outcome.summaryRowCount,
        subawardRows: outcome.subawardRowCount,
        enriched: outcome.updated,
        alreadyComplete: outcome.skipped,
        notHeldLocally: outcome.notHeld,
        errors: outcome.errors,
      })}`,
    );
  }

  return { inserted, updated, skipped, errors };
}

async function main(): Promise<void> {
  const start = arg('start');
  const end = arg('end');
  if (!start || !end) {
    throw new Error('--start YYYY-MM-DD and --end YYYY-MM-DD are both required');
  }
  const chunkMonths = Number(arg('chunk-months') ?? 1);
  const minAmountArg = arg('min-amount');
  const minAmount = minAmountArg != null && minAmountArg !== '' ? Number(minAmountArg) : null;
  if (minAmount != null && !Number.isFinite(minAmount)) {
    throw new Error(`--min-amount must be a number (got ${String(minAmountArg)})`);
  }
  const commit = process.argv.includes('--commit');
  const chunks = buildDateChunks(start, end, chunkMonths);

  console.error(
    `[${SYNC_SOURCE}] ${chunks.length} chunk(s) ${start}..${end} chunkMonths=${chunkMonths} ` +
      `minAmount=${minAmount ?? 'none'} commit=${commit}`,
  );

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    if (!commit) {
      // Dry run submits, downloads and parses for real — the only thing it skips
      // is the write, so the numbers it prints are the numbers a commit would get.
      const counts = await runBackfill(
        prisma as unknown as BulkPrisma,
        liveDownloadClient,
        { chunks, minAmount, commit: false },
      );
      console.log(JSON.stringify({ source: SYNC_SOURCE, committed: false, ...counts }, null, 2));
      console.error(`[${SYNC_SOURCE}] DRY RUN — no database writes. Pass --commit to write.`);
      return;
    }

    const counts = await runWithSyncRun(
      prisma as unknown as Parameters<typeof runWithSyncRun>[0],
      SYNC_SOURCE,
      async () => {
        const result = await runBackfill(
          prisma as unknown as BulkPrisma,
          liveDownloadClient,
          { chunks, minAmount, commit: true },
        );
        console.log(JSON.stringify({ source: SYNC_SOURCE, committed: true, ...result }, null, 2));
        return result;
      },
    );
    console.error(
      `[${SYNC_SOURCE}] DONE updated=${counts.updated} skipped=${counts.skipped} errors=${counts.errors}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((err) => {
    console.error(`[${SYNC_SOURCE}] FAILED`, (err as Error).message);
    process.exit(1);
  });
}
