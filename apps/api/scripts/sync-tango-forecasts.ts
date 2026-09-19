/**
 * MakeGov/Tango agency-forecast incremental sync (Funding Opportunities
 * P24).
 *
 *   tsx scripts/sync-tango-forecasts.ts               # dry run
 *   tsx scripts/sync-tango-forecasts.ts --commit
 *   tsx scripts/sync-tango-forecasts.ts --commit --limit=500   # cap, for a first backfill or a test run
 *
 * DRY-RUN BY DEFAULT.
 *
 * ── Pre-SAM early signals, never a competition ──────────────────────────────
 *
 * A forecast is "here is what an agency expects to buy" — never a
 * solicitation, never an active competition. Client visibility is separately
 * gated by funding_opportunities_forecasts and the candidate producer. This
 * global source sync never enables customer capabilities.
 *
 * ── Pages to EXHAUSTION, not to a row limit ─────────────────────────────────
 *
 * Unlike P19's entity sync or P22's vehicle sync — both of which cap a
 * bounded walk over Capiro's OWN client list — this sync's natural unit of
 * work is "everything the provider says changed since last time", which for
 * a healthy incremental run is a small fraction of the ~25,000-row catalog.
 * Capping it the way a full-catalog walk is capped would silently leave
 * same-day changes unsynced. `--limit` still exists, for a deliberate first
 * backfill or a bounded test run, but the default is "walk until the
 * provider says there is no more."
 *
 * ── Incremental, WITH OVERLAP ────────────────────────────────────────────────
 *
 * A checkpoint stores the whole walk's lower bound in windowStart and its
 * ORIGINAL start time in windowEnd. While cursor is non-null, windowEnd is a
 * pending upper bound, not a successful watermark. Every resumed attempt keeps
 * both bounds. Only the completed cursor-null walk commits that original bound;
 * the next incremental read starts there minus the safety overlap. This catches
 * updates to early pages even when a backfill takes several days to finish.
 *
 * Checkpoint format v3 has a distinct fingerprint because the forecast provider
 * now receives a calendar-date query instead of the prior timestamp query. An
 * unfinished v2 cursor must not be reused against those changed query semantics;
 * the first v3 run deliberately replays the catalog once. Existing forecast rows
 * and human work remain intact; upserts are idempotent.
 *
 * ── Resilience ───────────────────────────────────────────────────────────────
 *
 * Goes through TangoResilienceService (P18), constructed directly here, same
 * pattern as every other Funding Opportunities sync script. A request-
 * ceiling hit stops the run cleanly (`ceilingReached: true`), preserving
 * this run's own checkpoint progress for a resumed attempt.
 *
 * ── Not versioned like tango_resource_snapshot, on purpose ──────────────────
 *
 * `tango_procurement_forecast` (P24's own migration) is a single current-
 * state table, upserted on every sync, not layered on P15's versioned
 * snapshot store — see that migration's own header and decision-log D-46
 * for why. This script therefore never calls `TangoStoreService.writeSnapshot`;
 * it only uses the store for the sync checkpoint (resumability + the
 * incremental window), which is orthogonal to whether the DATA itself is
 * versioned.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun, emptyCounts } from '../src/ingestion/sync-run.helper.js';
import { TangoGatewayService } from '../src/external/tango/tango.client.js';
import {
  TangoResilienceService,
  TangoRequestCeilingExceededError,
} from '../src/external/tango/tango-resilience.service.js';
import {
  TangoStoreService,
  computeFilterFingerprint,
} from '../src/external/tango/tango-store.service.js';
import {
  toForecastRow,
  type TangoForecastRow,
} from '../src/external/tango/tango-forecast.mapper.js';
import type { TangoGateway } from '../src/external/tango/tango.types.js';
import { redact, redactWithKnownSecret } from '../src/external/tango/tango.errors.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

dotenvConfig();

const SYNC_VERB = 'sync-tango-forecasts';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_OVERLAP_HOURS = 4;

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
  /** Undefined means "no cap" — page to exhaustion. */
  limit: number | undefined;
  overlapHours: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const limitRaw = flagValue(argv, 'limit');
  const parsedLimit = limitRaw != null ? Number(limitRaw) : NaN;
  const overlapRaw = flagValue(argv, 'overlap-hours');
  const parsedOverlap = overlapRaw != null ? Number(overlapRaw) : NaN;
  return {
    commit: hasFlag(argv, 'commit'),
    limit:
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50_000) : undefined,
    overlapHours:
      Number.isFinite(parsedOverlap) && parsedOverlap >= 0 ? parsedOverlap : DEFAULT_OVERLAP_HOURS,
  };
}

// ── Injectable dependencies (the testable surface) ──────────────────────────

export interface ForecastSyncDeps {
  gateway: TangoGateway;
  store: TangoStoreService;
  upsertForecast: (row: TangoForecastRow) => Promise<void>;
  /** The caller's clock. Never `new Date()` inside the core walk. */
  now?: () => Date;
}

export interface ForecastSyncOptions {
  commit: boolean;
  /** Undefined = page to exhaustion. */
  limit?: number;
  overlapHours?: number;
  batchSize?: number;
}

export interface ForecastSyncSummary {
  processed: number;
  /** Would-be or actual upserts — real only when `commit` is true, matching every other sync's summary shape in this program. */
  written: number;
  /** No usable title — dropped, not stored with a fabricated one. */
  unmappable: number;
  errored: number;
  ceilingReached: boolean;
  completeness: 'complete' | 'in_progress';
  isFirstRun: boolean;
  /** The modified_after actually used for this run, or null on a first/full run. */
  modifiedAfter: string | null;
}

/**
 * The core walk. Pure with respect to its dependencies — every DB and
 * network effect is behind `deps`, so this runs against fakes in
 * sync-tango-forecasts.spec.ts with no real Postgres and no real Tango call.
 */
export async function runForecastSync(
  deps: ForecastSyncDeps,
  options: ForecastSyncOptions,
): Promise<ForecastSyncSummary> {
  const now = deps.now ?? (() => new Date());
  const runStartedAt = now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const overlapMs = (options.overlapHours ?? DEFAULT_OVERLAP_HOURS) * 60 * 60 * 1000;

  // Version the checkpoint format, not the provider query. Safe one-time replay
  // avoids treating a legacy unfinished window as a proven watermark.
  // v3 deliberately invalidates v2 checkpoints: forecast modified_after now
  // has provider calendar-date semantics, so an old partial cursor must not be
  // reused against the widened query window.
  const filterFingerprint = computeFilterFingerprint({
    cursorWindowVersion: 3,
  });
  const checkpoint = await deps.store.readCheckpoint(SYNC_VERB, 'forecast', filterFingerprint);
  const isFirstRun = checkpoint == null;

  // A v2 cursor belongs to the stored lower/upper bounds. Completion is the
  // only point at which the pending original upper bound becomes a watermark.
  const resuming = checkpoint?.cursor != null;
  const modifiedAfter = resuming
    ? (checkpoint.windowStart?.toISOString() ?? null)
    : checkpoint?.windowEnd != null
      ? new Date(checkpoint.windowEnd.getTime() - overlapMs).toISOString()
      : null;
  const walkStartedAt = resuming ? (checkpoint.windowEnd ?? runStartedAt) : runStartedAt;

  let cursor: string | null = checkpoint?.cursor ?? null;
  let processed = 0;
  let written = 0;
  let unmappable = 0;
  let errored = 0;
  let ceilingReached = false;
  let pageFailed = false;

  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  outer: for (;;) {
    const remaining = limit - processed;
    if (remaining <= 0) break;

    // Capped to `remaining`, not just `batchSize` — a page longer than what
    // this run should consume would force a mid-page stop that skips the
    // cursor/checkpoint update below (decision-log D-43's own finding,
    // avoided here from the start rather than discovered again).
    let page;
    try {
      page = await deps.gateway.listForecasts({
        cursor,
        limit: Math.min(batchSize, remaining),
        ...(modifiedAfter ? { changedSince: modifiedAfter } : {}),
      });
    } catch (error) {
      if (error instanceof TangoRequestCeilingExceededError) {
        // Stop cleanly. This run's own checkpoint (from the last successful
        // page) already reflects real progress; a resumed attempt continues
        // from there rather than restarting the window.
        ceilingReached = true;
        break outer;
      }
      throw error;
    }

    for (const forecast of page.items) {
      processed += 1;
      const row = toForecastRow(forecast);
      if (row == null) {
        unmappable += 1;
        continue;
      }
      written += 1;
      if (options.commit) {
        try {
          await deps.upsertForecast(row);
        } catch {
          errored += 1;
          written -= 1;
          pageFailed = true;
        }
      }
    }

    // An upsert failure must replay this entire page. Advancing either the
    // cursor or the incremental watermark here permanently loses the failed row.
    // Successful rows are safe to upsert again; leave the last durable checkpoint.
    if (pageFailed) break;
    cursor = page.nextCursor;
    const isDone = cursor == null;
    if (options.commit) {
      await deps.store.writeCheckpoint({
        syncVerb: SYNC_VERB,
        resourceType: 'forecast',
        filterFingerprint,
        cursor,
        // Retain the original window even while incomplete. Consumers may use
        // its upper bound as a watermark ONLY after completeness='complete'.
        windowStart: modifiedAfter,
        windowEnd: walkStartedAt.toISOString(),
        completeness: isDone ? 'complete' : 'in_progress',
        rowsProcessed: page.items.length,
      });
    }
    if (isDone) break;
  }

  return {
    processed,
    written,
    unmappable,
    errored,
    ceilingReached,
    completeness: pageFailed || ceilingReached || cursor != null ? 'in_progress' : 'complete',
    isFirstRun,
    modifiedAfter,
  };
}

// ── Real wiring ──────────────────────────────────────────────────────────────

function prismaServiceFromClient(client: PrismaClient): PrismaService {
  return client as unknown as PrismaService;
}

function realUpsertForecast(prisma: PrismaClient): ForecastSyncDeps['upsertForecast'] {
  return async (row) => {
    await prisma.tangoProcurementForecast.upsert({
      where: { tangoForecastId: row.tangoForecastId },
      create: row,
      update: {
        ...row,
        lastSyncedAt: new Date(),
      },
    });
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = (process.env.TANGO_API_KEY ?? '').trim();

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const rawGateway = new TangoGatewayService({
      apiKey,
      baseUrl: process.env.TANGO_API_BASE_URL,
      timeoutMs: process.env.TANGO_TIMEOUT_MS ? Number(process.env.TANGO_TIMEOUT_MS) : undefined,
    });
    const store = new TangoStoreService(prismaServiceFromClient(prisma));
    const gateway = new TangoResilienceService(rawGateway, store, {
      requestCeiling: process.env.TANGO_REQUEST_CEILING_PER_RUN
        ? Number(process.env.TANGO_REQUEST_CEILING_PER_RUN)
        : undefined,
      breakerThreshold: process.env.TANGO_CIRCUIT_BREAKER_THRESHOLD
        ? Number(process.env.TANGO_CIRCUIT_BREAKER_THRESHOLD)
        : undefined,
      breakerCooldownMs: process.env.TANGO_CIRCUIT_BREAKER_COOLDOWN_MS
        ? Number(process.env.TANGO_CIRCUIT_BREAKER_COOLDOWN_MS)
        : undefined,
    });

    const execute = async () => {
      if (!apiKey) throw new Error('No TANGO_API_KEY configured.');
      const summary = await runForecastSync(
        { gateway, store, upsertForecast: realUpsertForecast(prisma) },
        {
          commit: args.commit,
          limit: args.limit,
          overlapHours: args.overlapHours,
        },
      );
      if (summary.errored || summary.completeness !== 'complete') process.exitCode = 1;
      console.log(
        `TANGO_FORECAST_SYNC_DONE ${JSON.stringify({ ...summary, commit: args.commit, health: gateway.getHealth() })}`,
      );
      return {
        ...emptyCounts(),
        updated: summary.written,
        skipped: summary.unmappable,
        errors: summary.errored,
        complete: summary.completeness === 'complete',
        ...(summary.completeness !== 'complete'
          ? {
              incompleteReason:
                'Forecast page walk incomplete; durable checkpoint retained for retry.',
            }
          : {}),
      };
    };
    if (args.commit) await runWithSyncRun(prisma, SYNC_VERB, execute);
    else await execute();
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /sync-tango-forecasts(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      'TANGO_FORECAST_SYNC_ERR',
      redactWithKnownSecret(redact(message), process.env.TANGO_API_KEY ?? null),
    );
    process.exitCode = 1;
  });
}

export { main };
