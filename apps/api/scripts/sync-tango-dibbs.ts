/**
 * DLA bid-board (DIBBS) incremental sync — Funding Opportunities P40 part 3.
 *
 *   tsx scripts/sync-tango-dibbs.ts                      # dry run, all three endpoints
 *   tsx scripts/sync-tango-dibbs.ts --commit
 *   tsx scripts/sync-tango-dibbs.ts --commit --full      # ignore the window, reconcile everything
 *   tsx scripts/sync-tango-dibbs.ts --commit --since=2026-08-01
 *   tsx scripts/sync-tango-dibbs.ts --endpoint=rfq --limit=200
 *
 * DRY-RUN BY DEFAULT, like every other mutating command in this program.
 *
 * ── NOTHING HERE HAS EVER SEEN A REAL RESPONSE ──────────────────────────────
 *
 * The mappers, the schema and this walk are all written against the PUBLISHED
 * FIELD LIST (docs.makegov.com, transcribed in dibbs-sbir-rest-contract.md).
 * No live call has been made — no key was available, and per plan §4.6 a key
 * must never pass through an agent session. A separately authorized live
 * contract-validation run is still required before any of this is trusted, and
 * any mismatch it finds is a CONTRACT UPDATE AND A NEW FIXTURE, never a
 * permissive fallback here.
 *
 * ── WHY THIS SYNC KEEPS NO tango_sync_checkpoint ROW ────────────────────────
 *
 * Every other Funding Opportunities sync resumes from `TangoStoreService`'s
 * checkpoint. This one cannot, and the reason is worth stating because it looks
 * like an omission:
 *
 *   1. `tango_sync_checkpoint.resource_type` carries a CHECK admitting exactly
 *      `entity, opportunity, notice, forecast, vehicle, vehicle_awardee`
 *      (20260821010000_tango_source_substrate). No migration has ever widened
 *      it, and P40's own migration does not either. A DIBBS checkpoint is
 *      literally unstorable without a new migration.
 *
 *   2. More importantly, it would be the WRONG ABSTRACTION even if it fit. A
 *      checkpoint stores a modification-time high-water mark, and DIBBS
 *      publishes no `modified_after` filter — only `issue_date_after`,
 *      `issued_date_after` and `posted_date_after`. Storing an "as of" instant
 *      would encode a guarantee the provider never offered.
 *
 * So the window is derived from the DATA THIS SYNC ALREADY WROTE — the newest
 * issued/posted date per endpoint, minus an overlap — and the summary always
 * states the window it actually used.
 *
 * ── THE WINDOW IS AN ISSUE-DATE WINDOW, NOT A MODIFICATION WINDOW ───────────
 *
 * READ THIS BEFORE SCHEDULING IT. `issue_date_after` selects records ISSUED
 * since a date. A solicitation amended after it was issued does NOT re-enter
 * that window, so an incremental run will not see the amendment. This is a real
 * and permanent limit of the published filter set, not a tuning problem.
 *
 * The mitigation is `--full`, which drops the window and reconciles the whole
 * catalog; the upsert is keyed on the provider's `uuid`, so a full run is
 * idempotent and simply refreshes every row. A schedule that only ever runs
 * incrementally will drift. The shipped (disabled) schedule therefore pairs a
 * frequent incremental with a periodic `--full`, exactly like the LegiStorm
 * directory pair in ingestion-schedule.ts.
 *
 * ── COUNTS ARE PER ENDPOINT, NEVER POOLED ───────────────────────────────────
 *
 * A pooled "12 records dropped" cannot tell you WHICH endpoint's contract
 * drifted, which is the only thing the number is for. Every counter below is
 * per endpoint.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  TangoDibbsClient,
  TangoDibbsEnvelopeError,
  TangoDibbsHttpError,
  type TangoDibbsGateway,
  type TangoDibbsPage,
} from '../src/external/tango/tango-dibbs.client.js';
import {
  decimalString,
  mapDibbsAward,
  mapDibbsRfp,
  mapDibbsRfq,
  reconcileQuantity,
  type TangoDibbsAwardRow,
  type TangoDibbsSolicitationRow,
} from '../src/external/tango/tango-dibbs.mapper.js';
import { str } from '../src/external/tango/tango.mappers.js';
import { redact, redactWithKnownSecret } from '../src/external/tango/tango.errors.js';

dotenvConfig();

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_OVERLAP_DAYS = 7;
/**
 * P17's live probe (2026-08-08) measured this account at 25 requests per ~31s.
 * A page-complete catalog walk reaches that routinely, so rate limiting is a
 * normal operating condition here, not an exceptional one.
 */
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5;
/** Only used when the provider sends neither `Retry-After` nor `resetIn`. */
const DEFAULT_RATE_LIMIT_WAIT_SECONDS = 35;
/** A runaway `next` chain must not page forever. Hit means in_progress, never "complete". */
const MAX_PAGES_PER_ENDPOINT = 10_000;

export const DIBBS_ENDPOINTS = ['rfq', 'rfp', 'award'] as const;
export type DibbsEndpoint = (typeof DIBBS_ENDPOINTS)[number];

// ── CLI ──────────────────────────────────────────────────────────────────────

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export interface ParsedArgs {
  commit: boolean;
  /** Drop the window entirely and reconcile the whole catalog. */
  full: boolean;
  /** Explicit `YYYY-MM-DD` window start, overriding the derived high-water mark. */
  since: string | null;
  /** Undefined means "no cap" — page to exhaustion. */
  limit: number | undefined;
  overlapDays: number;
  endpoints: DibbsEndpoint[];
}

function parseEndpoints(raw: string | undefined): DibbsEndpoint[] {
  if (raw == null || raw.trim() === '') return [...DIBBS_ENDPOINTS];
  const requested = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '');
  // An unrecognised name is DROPPED, and if nothing survives the run does
  // nothing rather than silently walking all three — `--endpoint=rfqs` (a real
  // typo, the endpoint path is plural but the document type is not) must not
  // quietly become a full catalog sync.
  const known = requested.filter((value): value is DibbsEndpoint =>
    (DIBBS_ENDPOINTS as readonly string[]).includes(value),
  );
  return [...new Set(known)];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const limitRaw = flagValue(argv, 'limit');
  const parsedLimit = limitRaw != null ? Number(limitRaw) : NaN;
  const overlapRaw = flagValue(argv, 'overlap-days');
  const parsedOverlap = overlapRaw != null ? Number(overlapRaw) : NaN;
  const sinceRaw = flagValue(argv, 'since');
  return {
    commit: hasFlag(argv, 'commit'),
    full: hasFlag(argv, 'full'),
    // Only an unambiguous calendar day is accepted. A half-parsed date would
    // silently narrow the window, which is the one failure this script cannot
    // detect afterwards.
    since: sinceRaw != null && /^\d{4}-\d{2}-\d{2}$/.test(sinceRaw.trim()) ? sinceRaw.trim() : null,
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50_000) : undefined,
    overlapDays:
      Number.isFinite(parsedOverlap) && parsedOverlap >= 0 ? parsedOverlap : DEFAULT_OVERLAP_DAYS,
    endpoints: parseEndpoints(flagValue(argv, 'endpoint')),
  };
}

// ── Injectable dependencies (the testable surface) ──────────────────────────

export interface DibbsSyncDeps {
  gateway: TangoDibbsGateway;
  upsertSolicitation: (row: TangoDibbsSolicitationRow) => Promise<void>;
  upsertAward: (row: TangoDibbsAwardRow) => Promise<void>;
  /**
   * Newest issued/posted date this sync has already stored for an endpoint, or
   * null if it has stored none. Replaces the checkpoint row this sync cannot
   * write — see the file header.
   */
  highWaterMark: (endpoint: DibbsEndpoint) => Promise<Date | null>;
  /** The caller's clock. Never `new Date()` inside the core walk. */
  now?: () => Date;
  /**
   * The caller's delay. Injected rather than called directly so the rate-limit
   * paths are testable in milliseconds instead of half-minutes — a retry test
   * that really waited 31 seconds would be deleted by the first person whose
   * suite got slow.
   */
  sleep: (ms: number) => Promise<void>;
}

export interface DibbsSyncOptions {
  commit: boolean;
  full?: boolean;
  since?: string | null;
  limit?: number;
  overlapDays?: number;
  batchSize?: number;
  endpoints?: DibbsEndpoint[];
  maxRateLimitRetries?: number;
}

export interface DibbsEndpointSummary {
  endpoint: DibbsEndpoint;
  pagesRead: number;
  processed: number;
  /** Would-be or actual upserts — real only when `commit` is true. */
  written: number;
  /** No provider `uuid`. Cannot be upserted without inventing an identity. */
  droppedNoUuid: number;
  /** Had a `uuid` but lacked the endpoint's other NOT NULL field (`solicitation`, or `award_number`). */
  droppedNoRequiredField: number;
  errored: number;
  /** The `*_date_after` value actually sent, or null for a full/first walk. */
  windowFrom: string | null;
  /**
   * False when the walk stopped early — limit, page ceiling, an unparseable
   * `next`, or a rate limit that outlasted the retries.
   */
  complete: boolean;
  /** A 429 outlasted every retry and stopped THIS endpoint. Never aborts the run. */
  rateLimited: boolean;
  /** 429s that were retried and then succeeded. Nonzero is normal on a big walk. */
  rateLimitRetries: number;
  /** Deliberate pauses taken because the previous page reported `remaining: 0`. */
  throttleWaits: number;
}

export interface DibbsSyncSummary {
  endpoints: DibbsEndpointSummary[];
  /**
   * `reconcileQuantity` dropped a quantity because its unit was absent. Only
   * RFQ can produce this — an RFP states no quantity at all.
   *
   * MATERIALLY NONZERO IS A CONTRACT SIGNAL, NOT NOISE. It means the reading of
   * `quantity` or `unit_of_issue` is probably wrong. Investigate the contract;
   * do not suppress it and do not invent a unit.
   */
  quantityDroppedMissingUnit: number;
  commit: boolean;
  windowKind: 'full' | 'explicit-since' | 'derived-high-water';
  completeness: 'complete' | 'in_progress';
  /**
   * At least one endpoint was cut short by the provider's rate limit.
   *
   * Surfaced at run level as well as per endpoint because this is the field an
   * operator or a scheduled-task alarm reads first: `completeness` alone cannot
   * distinguish "capped by --limit, as instructed" from "the provider throttled
   * us and the catalog is now partially synced".
   */
  rateLimited: boolean;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * One page fetch, retried while the provider says "too many requests".
 *
 * `Retry-After` is honoured when the provider sends it, because guessing is
 * strictly worse in both directions: too short hammers a limit that is already
 * refusing, too long idles a scheduled task for no reason. Falls back to a
 * fixed wait only when the header is absent.
 *
 * Retries are BOUNDED. A provider that refuses indefinitely is not a transient
 * condition to wait out — it is a run that should stop and say so, which is
 * why exhausting the retries re-throws rather than returning an empty page.
 */
async function fetchWithRateLimitRetry(
  fetchPage: () => Promise<TangoDibbsPage>,
  deps: DibbsSyncDeps,
  options: DibbsSyncOptions,
  summary: DibbsEndpointSummary,
): Promise<TangoDibbsPage> {
  const maxRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchPage();
    } catch (error) {
      const rateLimited = error instanceof TangoDibbsHttpError && error.isRateLimited;
      if (!rateLimited || attempt >= maxRetries) throw error;

      const retryAfterSec =
        error.rate?.retryAfter ?? error.rate?.resetIn ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS;
      summary.rateLimitRetries += 1;
      await deps.sleep(retryAfterSec * 1000);
    }
  }
}

/**
 * One endpoint's page-complete walk.
 *
 * Every endpoint gets its own window, its own counters and its own
 * completeness verdict — a partial RFQ walk must not make the RFP walk look
 * partial, or vice versa.
 */
async function walkEndpoint(
  endpoint: DibbsEndpoint,
  deps: DibbsSyncDeps,
  options: DibbsSyncOptions,
  windowFrom: string | null,
  onQuantityDropped: () => void,
): Promise<DibbsEndpointSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  const summary: DibbsEndpointSummary = {
    endpoint,
    pagesRead: 0,
    processed: 0,
    written: 0,
    droppedNoUuid: 0,
    droppedNoRequiredField: 0,
    errored: 0,
    windowFrom,
    complete: false,
    rateLimited: false,
    rateLimitRetries: 0,
    throttleWaits: 0,
  };

  let page: number | null = 1;

  while (page != null) {
    const remaining = limit - summary.processed;
    if (remaining <= 0) return summary; // stopped by --limit: complete stays false.
    if (summary.pagesRead >= MAX_PAGES_PER_ENDPOINT) return summary;

    // Capped to `remaining`, not just `batchSize` — a page longer than what
    // this run should consume would force a mid-page stop (decision-log D-43).
    const pageSize = Math.min(batchSize, remaining);
    const fetchPage = (): Promise<TangoDibbsPage> => {
      switch (endpoint) {
        case 'rfq':
          return deps.gateway.listRfqs({
            page: page!,
            limit: pageSize,
            ...(windowFrom ? { issueDateAfter: windowFrom } : {}),
          });
        case 'rfp':
          return deps.gateway.listRfps({
            page: page!,
            limit: pageSize,
            ...(windowFrom ? { issuedDateAfter: windowFrom } : {}),
          });
        case 'award':
          return deps.gateway.listAwards({
            page: page!,
            limit: pageSize,
            ...(windowFrom ? { postedDateAfter: windowFrom } : {}),
          });
      }
    };

    let result: TangoDibbsPage;
    try {
      result = await fetchWithRateLimitRetry(fetchPage, deps, options, summary);
    } catch (error) {
      // A rate limit that survives every retry stops THIS endpoint and leaves
      // it `complete: false`. It does not abort the run: the other endpoints
      // have their own windows and their own counters, and killing them too
      // would turn one throttled walk into three unsynced datasets.
      if (error instanceof TangoDibbsHttpError && error.isRateLimited) {
        summary.rateLimited = true;
        return summary;
      }
      throw error;
    }
    summary.pagesRead += 1;

    // Proactive throttle. Waiting for the 429 works, but it spends a request
    // to learn something the previous response already said. P17's live probe
    // measured this account at 25 requests per ~31s — small enough that a
    // page-complete walk reaches it routinely, not exceptionally.
    if (result.rate?.remaining === 0 && result.rate.resetIn != null) {
      summary.throttleWaits += 1;
      await deps.sleep(result.rate.resetIn * 1000);
    }

    for (const raw of result.items) {
      summary.processed += 1;

      if (endpoint === 'award') {
        const row = mapDibbsAward(raw);
        if (row == null) {
          if (str(raw['uuid']) == null) summary.droppedNoUuid += 1;
          else summary.droppedNoRequiredField += 1;
          continue;
        }
        summary.written += 1;
        if (options.commit) {
          try {
            await deps.upsertAward(row);
          } catch {
            summary.errored += 1;
            summary.written -= 1;
          }
        }
        continue;
      }

      const row = endpoint === 'rfq' ? mapDibbsRfq(raw) : mapDibbsRfp(raw);
      if (row == null) {
        if (str(raw['uuid']) == null) summary.droppedNoUuid += 1;
        else summary.droppedNoRequiredField += 1;
        continue;
      }

      // The mapper calls reconcileQuantity and discards the flag, so the count
      // is recomputed here by calling the SAME exported function on the SAME
      // inputs — rather than re-deriving the condition, which would be a second
      // thing that can disagree with the mapper. RFP is excluded because an RFP
      // states no quantity at all, so it cannot drop one.
      if (endpoint === 'rfq') {
        const { quantityDropped } = reconcileQuantity(
          decimalString(raw['quantity']),
          str(raw['unit_of_issue']),
        );
        if (quantityDropped) onQuantityDropped();
      }

      summary.written += 1;
      if (options.commit) {
        try {
          await deps.upsertSolicitation(row);
        } catch {
          summary.errored += 1;
          summary.written -= 1;
        }
      }
    }

    page = result.nextPage;
  }

  summary.complete = true;
  return summary;
}

/**
 * The core walk. Pure with respect to its dependencies — every DB and network
 * effect is behind `deps`, so this runs against fakes in
 * sync-tango-dibbs.spec.ts with no real Postgres and no real Tango call.
 */
export async function runDibbsSync(
  deps: DibbsSyncDeps,
  options: DibbsSyncOptions,
): Promise<DibbsSyncSummary> {
  const now = deps.now ?? (() => new Date());
  const overlapDays = options.overlapDays ?? DEFAULT_OVERLAP_DAYS;
  const endpoints = options.endpoints ?? [...DIBBS_ENDPOINTS];

  const windowKind: DibbsSyncSummary['windowKind'] = options.full
    ? 'full'
    : options.since
      ? 'explicit-since'
      : 'derived-high-water';

  let quantityDroppedMissingUnit = 0;
  const onQuantityDropped = () => {
    quantityDroppedMissingUnit += 1;
  };

  const summaries: DibbsEndpointSummary[] = [];
  for (const endpoint of endpoints) {
    let windowFrom: string | null = null;
    if (!options.full) {
      if (options.since) {
        windowFrom = options.since;
      } else {
        const mark = await deps.highWaterMark(endpoint);
        // No stored rows yet means no window at all: the first run is a full
        // historical read by design, exactly like sync-tango-forecasts' first
        // run. There is nothing to be incremental relative to.
        if (mark != null) {
          windowFrom = isoDay(new Date(mark.getTime() - overlapDays * 24 * 60 * 60 * 1000));
        }
      }
    }
    summaries.push(await walkEndpoint(endpoint, deps, options, windowFrom, onQuantityDropped));
  }

  // `now` is read so a caller-supplied clock is honoured even though no field
  // currently derives from it; keeping the dependency explicit means adding a
  // timestamped field later cannot reintroduce a hidden `new Date()`.
  void now;

  return {
    endpoints: summaries,
    quantityDroppedMissingUnit,
    commit: options.commit,
    windowKind,
    completeness: summaries.every((s) => s.complete) ? 'complete' : 'in_progress',
    rateLimited: summaries.some((s) => s.rateLimited),
  };
}

// ── Real wiring ──────────────────────────────────────────────────────────────

function realUpsertSolicitation(prisma: PrismaClient): DibbsSyncDeps['upsertSolicitation'] {
  return async (row) => {
    await prisma.tangoDibbsSolicitation.upsert({
      where: { tangoDibbsId: row.tangoDibbsId },
      create: row,
      update: { ...row, lastSyncedAt: new Date() },
    });
  };
}

function realUpsertAward(prisma: PrismaClient): DibbsSyncDeps['upsertAward'] {
  return async (row) => {
    await prisma.tangoDibbsAward.upsert({
      where: { tangoDibbsId: row.tangoDibbsId },
      create: row,
      update: { ...row, lastSyncedAt: new Date() },
    });
  };
}

/**
 * The high-water mark, read from what this sync already stored.
 *
 * Deliberately the provider's own issued/posted DATE, not `lastSyncedAt`: the
 * window filters on the provider's date field, so the mark has to be in the
 * provider's own terms or the overlap means nothing.
 */
function realHighWaterMark(prisma: PrismaClient): DibbsSyncDeps['highWaterMark'] {
  return async (endpoint) => {
    if (endpoint === 'award') {
      const row = await prisma.tangoDibbsAward.aggregate({ _max: { postedDate: true } });
      return row._max.postedDate ?? null;
    }
    const row = await prisma.tangoDibbsSolicitation.aggregate({
      _max: { issuedDate: true },
      where: { documentType: endpoint },
    });
    return row._max.issuedDate ?? null;
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = (process.env.TANGO_API_KEY ?? '').trim();
  if (!apiKey) {
    console.error('TANGO_DIBBS_SYNC_ERR No TANGO_API_KEY configured.');
    process.exitCode = 1;
    return;
  }
  if (args.endpoints.length === 0) {
    console.error(
      `TANGO_DIBBS_SYNC_ERR --endpoint matched none of: ${DIBBS_ENDPOINTS.join(', ')}. Nothing to do.`,
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const gateway = new TangoDibbsClient({
      apiKey,
      baseUrl: process.env.TANGO_API_BASE_URL,
      timeoutMs: process.env.TANGO_TIMEOUT_MS ? Number(process.env.TANGO_TIMEOUT_MS) : undefined,
    });

    const summary = await runDibbsSync(
      {
        gateway,
        upsertSolicitation: realUpsertSolicitation(prisma),
        upsertAward: realUpsertAward(prisma),
        highWaterMark: realHighWaterMark(prisma),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      {
        commit: args.commit,
        full: args.full,
        since: args.since,
        limit: args.limit,
        overlapDays: args.overlapDays,
        endpoints: args.endpoints,
      },
    );

    console.log(`TANGO_DIBBS_SYNC_DONE ${JSON.stringify({ ...summary, commit: args.commit })}`);
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /sync-tango-dibbs(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // An envelope mismatch is the one failure this program most wants a human
    // to read, so it is labelled rather than folded into a generic error.
    const label =
      error instanceof TangoDibbsEnvelopeError
        ? 'TANGO_DIBBS_SYNC_ERR CONTRACT MISMATCH —'
        : 'TANGO_DIBBS_SYNC_ERR';
    console.error(label, redactWithKnownSecret(redact(message), process.env.TANGO_API_KEY ?? null));
    process.exitCode = 1;
  });
}

export { main };
