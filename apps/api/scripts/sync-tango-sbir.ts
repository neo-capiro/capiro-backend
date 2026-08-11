/**
 * SBIR/STTR incremental sync — Funding Opportunities P42 part 3.
 *
 *   tsx scripts/sync-tango-sbir.ts                          # dry run, both endpoints
 *   tsx scripts/sync-tango-sbir.ts --commit
 *   tsx scripts/sync-tango-sbir.ts --commit --full          # ignore the window, reconcile everything
 *   tsx scripts/sync-tango-sbir.ts --commit --since=2026-08-01
 *   tsx scripts/sync-tango-sbir.ts --endpoint=topic --limit=200
 *
 * DRY-RUN BY DEFAULT, like every other mutating command in this program.
 *
 * ── NOTHING HERE HAS EVER SEEN A REAL RESPONSE ──────────────────────────────
 *
 * Stronger than P40's version of this warning, because P17's 2026-08-08 probe
 * confirmed the envelope for `/api/dibbs/` ONLY. **No call has ever been made to
 * `/api/sbir/`.** The client, the schema, the mappers and this walk are all
 * written against the published field list (docs.makegov.com, transcribed in
 * dibbs-sbir-rest-contract.md). A separately authorized live run is required
 * before any of it is trusted, and any mismatch it finds is a CONTRACT UPDATE
 * AND A NEW FIXTURE — never a permissive fallback here.
 *
 * The shipped schedule is DISABLED for exactly that reason.
 *
 * ── WHY THIS SYNC KEEPS NO tango_sync_checkpoint ROW ────────────────────────
 *
 * Same answer as the DIBBS sync, and verified the same way — by reading the
 * migration rather than assuming, which is the D-63 lesson:
 *
 *   1. `tango_sync_checkpoint.resource_type` carries a CHECK admitting exactly
 *      `entity, opportunity, notice, forecast, vehicle, vehicle_awardee`
 *      (20260821010000_tango_source_substrate). It is the ONLY migration that
 *      mentions that constraint — nothing has ever widened it, and P42's own
 *      migration does not either. An SBIR checkpoint is literally unstorable.
 *
 *   2. It would be the wrong abstraction even if it fit. A checkpoint stores a
 *      modification-time high-water mark, and the SBIR endpoints publish no
 *      `modified_after` filter — only `release_date_after`, `open_date_after`,
 *      `close_date_after` (topics) and `start_date_after`, `end_date_after`
 *      (solicitations). Storing an "as of" instant would encode a guarantee the
 *      provider never offered.
 *
 * So the window comes from the DATA THIS SYNC ALREADY WROTE — the newest
 * release/start date per endpoint, minus an overlap — and the summary always
 * states the window it actually used.
 *
 * ── THE WINDOW IS A PUBLICATION-DATE WINDOW, NOT A MODIFICATION WINDOW ──────
 *
 * READ THIS BEFORE ENABLING THE SCHEDULE. `release_date_after` selects topics
 * RELEASED since a date. A topic amended after release — a changed close date,
 * a revised title, a status moving to Closed — does NOT re-enter that window, so
 * an incremental run will not see the change. Identical limitation to DIBBS
 * (D-63), and for the identical reason: the published filter set offers no
 * modification field.
 *
 * `--full` is the mitigation. The upserts key on the provider's own
 * `topic_id`/`solicitation_id`, so a full run is idempotent and simply
 * refreshes every row. A schedule that only ever runs incrementally WILL drift,
 * which is why the shipped pair couples a frequent incremental with a periodic
 * full reconciliation.
 *
 * ── CYCLES ARE WALKED BEFORE TOPICS ─────────────────────────────────────────
 *
 * Not a correctness requirement — there is no FK, and an orphan topic is
 * explicitly allowed to survive (see the migration header). It is ordered this
 * way so that a run interrupted midway leaves a more useful database: parents
 * present and some children missing reads better, and joins better, than
 * children pointing at cycles that were never fetched.
 *
 * ── COUNTS ARE PER ENDPOINT, NEVER POOLED ───────────────────────────────────
 *
 * A pooled "12 records dropped" cannot tell you WHICH endpoint's contract
 * drifted, which is the only thing the number is for.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  TangoSbirClient,
  TangoSbirEnvelopeError,
  TangoSbirHttpError,
  type TangoSbirGateway,
  type TangoSbirPage,
} from '../src/external/tango/tango-sbir.client.js';
import {
  mapSbirSolicitation,
  mapSbirTopic,
  type TangoSbirSolicitationRow,
  type TangoSbirTopicRow,
} from '../src/external/tango/tango-sbir.mapper.js';
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
/**
 * Hard ceiling on any single provider-directed sleep (proactive throttle wait
 * OR 429 retry wait), regardless of what `resetIn`/`retryAfter` says.
 *
 * Mirrors the identical fix in `sync-tango-dibbs.ts` — see that file's
 * constant doc for the full incident (a first full DIBBS walk stalled 4.5+
 * hours on exactly this unbounded sleep). SBIR shares the same client
 * shape and has never made enough requests in a burst to have exercised
 * this path against a real response either, so it gets the same ceiling
 * pre-emptively rather than waiting to reproduce the same incident here.
 */
const MAX_PROVIDER_WAIT_MS = 120_000;

/**
 * Cycles first — see the file header. The order of this array IS the run order.
 */
export const SBIR_ENDPOINTS = ['solicitation', 'topic'] as const;
export type SbirEndpoint = (typeof SBIR_ENDPOINTS)[number];

/**
 * The provider's own id field, per endpoint.
 *
 * Table-driven because getting this wrong is silent: topics key on `topic_id`
 * and solicitations on `solicitation_id`, and NEITHER is the `uuid` DIBBS uses.
 * A walk that reached for `uuid` would drop every record and report a clean
 * "0 written, complete".
 */
const ID_FIELD: Readonly<Record<SbirEndpoint, string>> = Object.freeze({
  solicitation: 'solicitation_id',
  topic: 'topic_id',
});

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
  endpoints: SbirEndpoint[];
}

function parseEndpoints(raw: string | undefined): SbirEndpoint[] {
  if (raw == null || raw.trim() === '') return [...SBIR_ENDPOINTS];
  const requested = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== '');
  // An unrecognised name is DROPPED, and if nothing survives the run does
  // nothing rather than silently walking both — `--endpoint=topics` (a real
  // typo, since the endpoint PATH is plural while the name here is not) must
  // not quietly become a full catalog sync.
  const known = requested.filter((value): value is SbirEndpoint =>
    (SBIR_ENDPOINTS as readonly string[]).includes(value),
  );
  // Preserve SBIR_ENDPOINTS order rather than the caller's, so cycles are still
  // walked before topics however the flag was written.
  return SBIR_ENDPOINTS.filter((endpoint) => known.includes(endpoint));
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
    limit:
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50_000) : undefined,
    overlapDays:
      Number.isFinite(parsedOverlap) && parsedOverlap >= 0 ? parsedOverlap : DEFAULT_OVERLAP_DAYS,
    endpoints: parseEndpoints(flagValue(argv, 'endpoint')),
  };
}

// ── Injectable dependencies (the testable surface) ──────────────────────────

export interface SbirSyncDeps {
  gateway: TangoSbirGateway;
  upsertSolicitation: (row: TangoSbirSolicitationRow) => Promise<void>;
  upsertTopic: (row: TangoSbirTopicRow) => Promise<void>;
  /**
   * Newest release/start date this sync has already stored for an endpoint, or
   * null if it has stored none. Replaces the checkpoint row this sync cannot
   * write — see the file header.
   */
  highWaterMark: (endpoint: SbirEndpoint) => Promise<Date | null>;
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

export interface SbirSyncOptions {
  commit: boolean;
  full?: boolean;
  since?: string | null;
  limit?: number;
  overlapDays?: number;
  batchSize?: number;
  endpoints?: SbirEndpoint[];
  maxRateLimitRetries?: number;
}

export interface SbirEndpointSummary {
  endpoint: SbirEndpoint;
  pagesRead: number;
  processed: number;
  /** Would-be or actual upserts — real only when `commit` is true. */
  written: number;
  /** No provider id for THIS endpoint's own id field. Cannot be upserted without inventing an identity. */
  droppedNoId: number;
  /** Had an id but lacked the endpoint's other NOT NULL field (`solicitation_number`). */
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

export interface SbirSyncSummary {
  endpoints: SbirEndpointSummary[];
  /**
   * Topics that stated NO parent cycle.
   *
   * Allowed and stored — the column is nullable precisely so this case is
   * representable. But MATERIALLY NONZERO IS A CONTRACT SIGNAL, NOT NOISE: the
   * topic-to-cycle relationship is one of P42's own acceptance lines, and if
   * most topics arrive without a `solicitation_number` then the reading of that
   * field is probably wrong. Investigate the contract; do not synthesise a
   * parent from the topic number or from `official_solicitation_url`.
   */
  topicsWithNoStatedCycle: number;
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
 * refusing, too long idles a scheduled task for no reason.
 *
 * Retries are BOUNDED. A provider that refuses indefinitely is not a transient
 * condition to wait out — it is a run that should stop and say so, which is why
 * exhausting the retries re-throws rather than returning an empty page.
 */
async function fetchWithRateLimitRetry(
  fetchPage: () => Promise<TangoSbirPage>,
  deps: SbirSyncDeps,
  options: SbirSyncOptions,
  summary: SbirEndpointSummary,
): Promise<TangoSbirPage> {
  const maxRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchPage();
    } catch (error) {
      const rateLimited = error instanceof TangoSbirHttpError && error.isRateLimited;
      if (!rateLimited || attempt >= maxRetries) throw error;

      const retryAfterSec =
        error.rate?.retryAfter ?? error.rate?.resetIn ?? DEFAULT_RATE_LIMIT_WAIT_SECONDS;
      const waitMs = Math.min(retryAfterSec * 1000, MAX_PROVIDER_WAIT_MS);
      summary.rateLimitRetries += 1;
      console.log(
        `TANGO_SBIR_SYNC_RATE_LIMIT_RETRY ${JSON.stringify({ attempt, retryAfterSec, waitMs })}`,
      );
      await deps.sleep(waitMs);
    }
  }
}

/**
 * One endpoint's page-complete walk.
 *
 * Every endpoint gets its own window, its own counters and its own completeness
 * verdict — a partial topic walk must not make the cycle walk look partial, or
 * vice versa.
 */
async function walkEndpoint(
  endpoint: SbirEndpoint,
  deps: SbirSyncDeps,
  options: SbirSyncOptions,
  windowFrom: string | null,
  onTopicWithNoCycle: () => void,
): Promise<SbirEndpointSummary> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  const summary: SbirEndpointSummary = {
    endpoint,
    pagesRead: 0,
    processed: 0,
    written: 0,
    droppedNoId: 0,
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

    // Capped to `remaining`, not just `batchSize` — a page longer than what this
    // run should consume would force a mid-page stop (decision-log D-43).
    const pageSize = Math.min(batchSize, remaining);
    const fetchPage = (): Promise<TangoSbirPage> => {
      switch (endpoint) {
        case 'solicitation':
          return deps.gateway.listSolicitations({
            page: page!,
            limit: pageSize,
            ...(windowFrom ? { startDateAfter: windowFrom } : {}),
          });
        case 'topic':
          return deps.gateway.listTopics({
            page: page!,
            limit: pageSize,
            ...(windowFrom ? { releaseDateAfter: windowFrom } : {}),
          });
      }
    };

    let result: TangoSbirPage;
    try {
      result = await fetchWithRateLimitRetry(fetchPage, deps, options, summary);
    } catch (error) {
      // A rate limit that survives every retry stops THIS endpoint and leaves it
      // `complete: false`. It does not abort the run: the other endpoint has its
      // own window and counters, and killing it too would turn one throttled
      // walk into two unsynced datasets.
      if (error instanceof TangoSbirHttpError && error.isRateLimited) {
        summary.rateLimited = true;
        return summary;
      }
      throw error;
    }
    summary.pagesRead += 1;

    // Proactive throttle. Waiting for the 429 works, but it spends a request to
    // learn something the previous response already said.
    if (result.rate?.remaining === 0 && result.rate.resetIn != null) {
      const waitMs = Math.min(result.rate.resetIn * 1000, MAX_PROVIDER_WAIT_MS);
      summary.throttleWaits += 1;
      console.log(
        `TANGO_SBIR_SYNC_THROTTLE_WAIT ${JSON.stringify({ endpoint, page, resetIn: result.rate.resetIn, waitMs })}`,
      );
      await deps.sleep(waitMs);
    }

    for (const raw of result.items) {
      summary.processed += 1;

      const row = endpoint === 'solicitation' ? mapSbirSolicitation(raw) : mapSbirTopic(raw);
      if (row == null) {
        // THIS endpoint's own id field — never `uuid`, and never the sibling's.
        // See ID_FIELD.
        if (str(raw[ID_FIELD[endpoint]]) == null) summary.droppedNoId += 1;
        else summary.droppedNoRequiredField += 1;
        continue;
      }

      if (endpoint === 'topic' && (row as TangoSbirTopicRow).solicitationNumber == null) {
        onTopicWithNoCycle();
      }

      summary.written += 1;
      if (options.commit) {
        try {
          if (endpoint === 'solicitation') {
            await deps.upsertSolicitation(row as TangoSbirSolicitationRow);
          } else {
            await deps.upsertTopic(row as TangoSbirTopicRow);
          }
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
 * effect is behind `deps`, so this runs against fakes in sync-tango-sbir.spec.ts
 * with no real Postgres and no real Tango call.
 */
export async function runSbirSync(
  deps: SbirSyncDeps,
  options: SbirSyncOptions,
): Promise<SbirSyncSummary> {
  const now = deps.now ?? (() => new Date());
  const overlapDays = options.overlapDays ?? DEFAULT_OVERLAP_DAYS;
  const endpoints = options.endpoints ?? [...SBIR_ENDPOINTS];

  const windowKind: SbirSyncSummary['windowKind'] = options.full
    ? 'full'
    : options.since
      ? 'explicit-since'
      : 'derived-high-water';

  let topicsWithNoStatedCycle = 0;
  const onTopicWithNoCycle = () => {
    topicsWithNoStatedCycle += 1;
  };

  const summaries: SbirEndpointSummary[] = [];
  for (const endpoint of endpoints) {
    let windowFrom: string | null = null;
    if (!options.full) {
      if (options.since) {
        windowFrom = options.since;
      } else {
        const mark = await deps.highWaterMark(endpoint);
        // No stored rows yet means no window at all: the first run is a full
        // historical read by design, exactly like the DIBBS and forecast syncs.
        // There is nothing to be incremental relative to.
        if (mark != null) {
          windowFrom = isoDay(new Date(mark.getTime() - overlapDays * 24 * 60 * 60 * 1000));
        }
      }
    }
    summaries.push(await walkEndpoint(endpoint, deps, options, windowFrom, onTopicWithNoCycle));
  }

  // `now` is read so a caller-supplied clock is honoured even though no field
  // currently derives from it; keeping the dependency explicit means adding a
  // timestamped field later cannot reintroduce a hidden `new Date()`.
  void now;

  return {
    endpoints: summaries,
    topicsWithNoStatedCycle,
    commit: options.commit,
    windowKind,
    completeness: summaries.every((s) => s.complete) ? 'complete' : 'in_progress',
    rateLimited: summaries.some((s) => s.rateLimited),
  };
}

// ── Real wiring ──────────────────────────────────────────────────────────────

function realUpsertSolicitation(prisma: PrismaClient): SbirSyncDeps['upsertSolicitation'] {
  return async (row) => {
    await prisma.tangoSbirSolicitation.upsert({
      where: { tangoSbirId: row.tangoSbirId },
      create: row,
      update: { ...row, lastSyncedAt: new Date() },
    });
  };
}

function realUpsertTopic(prisma: PrismaClient): SbirSyncDeps['upsertTopic'] {
  return async (row) => {
    await prisma.tangoSbirTopic.upsert({
      where: { tangoSbirId: row.tangoSbirId },
      create: row,
      update: { ...row, lastSyncedAt: new Date() },
    });
  };
}

/**
 * The high-water mark, read from what this sync already stored.
 *
 * Deliberately the provider's own publication DATE, not `lastSyncedAt`: the
 * window filters on the provider's date field, so the mark has to be in the
 * provider's own terms or the overlap means nothing.
 *
 * Each endpoint uses the field its own window filters on — `startDate` for a
 * cycle, `releaseDate` for a topic. Reading one endpoint's mark for the other
 * would produce a window in the wrong units and silently skip records.
 */
function realHighWaterMark(prisma: PrismaClient): SbirSyncDeps['highWaterMark'] {
  return async (endpoint) => {
    if (endpoint === 'solicitation') {
      const row = await prisma.tangoSbirSolicitation.aggregate({ _max: { startDate: true } });
      return row._max.startDate ?? null;
    }
    const row = await prisma.tangoSbirTopic.aggregate({ _max: { releaseDate: true } });
    return row._max.releaseDate ?? null;
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = (process.env.TANGO_API_KEY ?? '').trim();
  if (!apiKey) {
    console.error('TANGO_SBIR_SYNC_ERR No TANGO_API_KEY configured.');
    process.exitCode = 1;
    return;
  }
  if (args.endpoints.length === 0) {
    console.error(
      `TANGO_SBIR_SYNC_ERR --endpoint matched none of: ${SBIR_ENDPOINTS.join(', ')}. Nothing to do.`,
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const gateway = new TangoSbirClient({
      apiKey,
      baseUrl: process.env.TANGO_API_BASE_URL,
      timeoutMs: process.env.TANGO_TIMEOUT_MS ? Number(process.env.TANGO_TIMEOUT_MS) : undefined,
    });

    const summary = await runSbirSync(
      {
        gateway,
        upsertSolicitation: realUpsertSolicitation(prisma),
        upsertTopic: realUpsertTopic(prisma),
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

    console.log(`TANGO_SBIR_SYNC_DONE ${JSON.stringify({ ...summary, commit: args.commit })}`);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Anchored to the END of the path, not a substring match.
 *
 * A loose `includes('sync-tango-sbir')` would also fire for a spec file or any
 * path that happens to contain the name, turning an import into a real run
 * against a real database. Same form the DIBBS sync uses.
 */
const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /sync-tango-sbir(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // An envelope mismatch is the one failure this program most wants a human to
    // read, and for SBIR it is the MOST likely failure on the first real run —
    // nothing has ever called this API. Labelled rather than folded into a
    // generic error.
    const label =
      error instanceof TangoSbirEnvelopeError
        ? 'TANGO_SBIR_SYNC_ERR CONTRACT MISMATCH —'
        : 'TANGO_SBIR_SYNC_ERR';
    console.error(label, redactWithKnownSecret(redact(message), process.env.TANGO_API_KEY ?? null));
    process.exitCode = 1;
  });
}

export { main };
