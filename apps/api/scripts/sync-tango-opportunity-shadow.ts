/**
 * MakeGov/Tango opportunity SHADOW sync (Funding Opportunities P27).
 *
 *   tsx scripts/sync-tango-opportunity-shadow.ts                       # dry run
 *   tsx scripts/sync-tango-opportunity-shadow.ts --commit
 *   tsx scripts/sync-tango-opportunity-shadow.ts --commit --limit=500  # bounded run
 *   tsx scripts/sync-tango-opportunity-shadow.ts --commit --changed-since=2026-07-01
 *
 * DRY-RUN BY DEFAULT.
 *
 * ── SHADOW means: it reads two catalogs and writes about them, never to them ─
 *
 * This script writes exactly three things:
 *
 *   `tango_resource_snapshot`   — the provider's own observation (P15).
 *   `tango_resource_link`       — the crosswalk, basis `exact_identifier` (P15).
 *   `tango_opportunity_parity`  — the per-field ledger (P27).
 *
 * It never writes to `sam_opportunity`, `federal_grant`,
 * `client_funding_opportunity` or any tenant table. Plan §4.2: first-party
 * ingestion stays authoritative for canonical lifecycle fields, a Tango
 * observation may verify or identify a conflict, and no "last write wins"
 * merge is permitted. `sync-tango-opportunity-shadow.spec.ts` proves that
 * structurally as well as behaviourally — a grep for a write to any of those
 * models is part of the suite.
 *
 * ── Identity is an identifier or nothing ─────────────────────────────────────
 *
 * See `tango-opportunity.mapper.ts` for the rule in full. In one line: exactly
 * one local notice carrying the same solicitation number links; more than one
 * is `ambiguous` and links NOTHING; none is `unlinked`. There is no title
 * match and no scoring.
 *
 * ── Bounded by the provider's OWN incremental key, not an invented one ───────
 *
 * `TangoOpportunityListOptions` (P14's audited filter set) offers
 * `changedSince`, `solicitationNumber`, `naics`, `psc` and `active`. It offers
 * NO posted-date filter, so this script does not accept one: a filter with no
 * provider equivalent would either be silently dropped or force a client-side
 * scan of the whole catalog to apply, and both read as "the bound worked".
 *
 * `--changed-since` (default: 90 days back) is therefore the FLOOR for a first
 * or backfill run. This is a verification rail, so the useful window is
 * "notices recent enough that Capiro's own rail should also have them" —
 * reaching back years would produce `unlinked` rows for notices that predate
 * Capiro's own ingestion and report them as coverage gaps, which they are not.
 *
 * ── Incremental, WITH OVERLAP ────────────────────────────────────────────────
 *
 * Same checkpoint discipline as P24's forecast sync: the run's own start time
 * becomes the next run's high-water mark minus an overlap, and the mark only
 * advances on a fully-exhausted page walk. See that script's header for why.
 *
 * The one difference from P24: a FIRST run here is not an unbounded historical
 * read. It uses the `--changed-since` floor, because the whole opportunity
 * catalog reaches back further than Capiro's own SAM.gov ingestion does.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { TangoGatewayService } from '../src/external/tango/tango.client.js';
import {
  TangoResilienceService,
  TangoRequestCeilingExceededError,
} from '../src/external/tango/tango-resilience.service.js';
import { TangoStoreService, computeFilterFingerprint } from '../src/external/tango/tango-store.service.js';
import {
  compareParity,
  normalizeSolicitationNumber,
  resolveCrosswalk,
  toOpportunitySnapshot,
  type CrosswalkState,
  type ParityRow,
  type SamCandidate,
  type SamParitySource,
} from '../src/external/tango/tango-opportunity.mapper.js';
import type { TangoGateway, TangoOpportunity } from '../src/external/tango/tango.types.js';
import { redact, redactWithKnownSecret } from '../src/external/tango/tango.errors.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

dotenvConfig();

const SYNC_VERB = 'sync-tango-opportunity-shadow';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_OVERLAP_HOURS = 4;
const DEFAULT_CHANGED_SINCE_DAYS = 90;

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
  /**
   * ISO date floor for a first/backfill run. Undefined means "use the default
   * lookback from the caller's clock". An UNPARSEABLE value is treated as
   * undefined rather than passed through: sending garbage as the provider's
   * incremental key would either 400 or, worse, be ignored server-side and turn
   * a bounded run into a full-catalog walk.
   */
  changedSince: string | undefined;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const limitRaw = flagValue(argv, 'limit');
  const parsedLimit = limitRaw != null ? Number(limitRaw) : NaN;
  const overlapRaw = flagValue(argv, 'overlap-hours');
  const parsedOverlap = overlapRaw != null ? Number(overlapRaw) : NaN;
  const changedSinceRaw = flagValue(argv, 'changed-since');
  const changedSinceValid =
    changedSinceRaw != null && !Number.isNaN(new Date(changedSinceRaw).getTime())
      ? changedSinceRaw
      : undefined;
  return {
    commit: hasFlag(argv, 'commit'),
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 50_000) : undefined,
    overlapHours: Number.isFinite(parsedOverlap) && parsedOverlap >= 0 ? parsedOverlap : DEFAULT_OVERLAP_HOURS,
    changedSince: changedSinceValid,
  };
}

// ── Injectable dependencies (the testable surface) ──────────────────────────

export interface ParityWrite {
  tangoOpportunityId: string;
  samOpportunityId: string;
  rows: ParityRow[];
}

export interface OpportunityShadowDeps {
  gateway: TangoGateway;
  store: TangoStoreService;
  /** Local notices carrying this NORMALIZED solicitation number. */
  findSamCandidates: (normalizedSolicitationNumber: string) => Promise<SamCandidate[]>;
  /** The comparable columns of one local notice. Null when it vanished mid-run. */
  readSamParitySource: (samOpportunityId: string) => Promise<SamParitySource | null>;
  /** Upsert the per-field ledger for one linked pair. */
  writeParity: (write: ParityWrite) => Promise<void>;
  /** The caller's clock. Never `new Date()` inside the core walk. */
  now?: () => Date;
}

export interface OpportunityShadowOptions {
  commit: boolean;
  limit?: number;
  overlapHours?: number;
  batchSize?: number;
  changedSince?: string;
  changedSinceDays?: number;
}

export interface OpportunityShadowSummary {
  processed: number;
  linked: number;
  ambiguous: number;
  unlinked: number;
  /** Linked pairs whose local row disappeared between the query and the read. */
  vanished: number;
  /** Total per-field rows whose agreement is `conflict`. */
  conflicts: number;
  /** Provider observations written. Real only when `commit`. */
  snapshots: number;
  errored: number;
  ceilingReached: boolean;
  completeness: 'complete' | 'in_progress';
  isFirstRun: boolean;
  /** The `changedSince` actually sent to the provider for this run. */
  modifiedAfter: string;
  /** The floor a first/backfill run would use. Reported so a resumed run's window is checkable. */
  changedSinceFloor: string;
}

/**
 * The core walk. Every DB and network effect is behind `deps`, so this runs
 * against fakes with no real Postgres and no real Tango call.
 */
export async function runOpportunityShadowSync(
  deps: OpportunityShadowDeps,
  options: OpportunityShadowOptions,
): Promise<OpportunityShadowSummary> {
  const now = deps.now ?? (() => new Date());
  const runStartedAt = now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const overlapMs = (options.overlapHours ?? DEFAULT_OVERLAP_HOURS) * 60 * 60 * 1000;
  const lookbackDays = options.changedSinceDays ?? DEFAULT_CHANGED_SINCE_DAYS;
  const changedSinceFloor =
    options.changedSince ??
    new Date(runStartedAt.getTime() - lookbackDays * 86_400_000).toISOString().slice(0, 10);

  // The floor is part of the filter FINGERPRINT, not just of the request. A run
  // with a different window is a different walk, and resuming one from the
  // other's cursor would skip or repeat rows silently.
  const filterFingerprint = computeFilterFingerprint({ changedSince: changedSinceFloor });
  const checkpoint = await deps.store.readCheckpoint(SYNC_VERB, 'opportunity', filterFingerprint);
  const isFirstRun = checkpoint == null;

  // A first run uses the FLOOR; every later run uses its own high-water mark
  // minus the overlap. Unlike P24's forecast sync there is no "no window at
  // all" case — the opportunity catalog reaches back further than Capiro's own
  // SAM.gov ingestion, so an unbounded first read would report notices Capiro
  // never had a chance to ingest as coverage gaps.
  const modifiedAfter =
    checkpoint?.windowEnd != null
      ? new Date(checkpoint.windowEnd.getTime() - overlapMs).toISOString()
      : changedSinceFloor;

  let cursor: string | null = checkpoint?.cursor ?? null;
  const summary = {
    processed: 0,
    linked: 0,
    ambiguous: 0,
    unlinked: 0,
    vanished: 0,
    conflicts: 0,
    snapshots: 0,
    errored: 0,
  };
  let ceilingReached = false;

  const limit = options.limit ?? Number.POSITIVE_INFINITY;

  outer: for (;;) {
    const remaining = limit - summary.processed;
    if (remaining <= 0) break;

    let page;
    try {
      page = await deps.gateway.listOpportunities({
        cursor,
        // Capped to `remaining`, matching D-43's fix: a page longer than what
        // this run should consume forces a mid-page stop that would skip the
        // cursor/checkpoint update below.
        limit: Math.min(batchSize, remaining),
        changedSince: modifiedAfter,
      });
    } catch (error) {
      if (error instanceof TangoRequestCeilingExceededError) {
        ceilingReached = true;
        break outer;
      }
      throw error;
    }

    for (const opportunity of page.items) {
      summary.processed += 1;
      try {
        await processOne(deps, options, opportunity, summary);
      } catch {
        // Counted and continued. One provider record with a surprising shape
        // must not abandon the rest of the walk — the same posture P22's
        // vehicle sync takes for a per-vehicle failure.
        summary.errored += 1;
      }
    }

    cursor = page.nextCursor;
    const isDone = cursor == null;
    if (options.commit) {
      await deps.store.writeCheckpoint({
        syncVerb: SYNC_VERB,
        resourceType: 'opportunity',
        filterFingerprint,
        cursor,
        ...(isDone ? { windowStart: modifiedAfter, windowEnd: runStartedAt.toISOString() } : {}),
        completeness: isDone ? 'complete' : 'in_progress',
        rowsProcessed: page.items.length,
      });
    }
    if (isDone) break;
  }

  return {
    ...summary,
    ceilingReached,
    completeness: ceilingReached || cursor != null ? 'in_progress' : 'complete',
    isFirstRun,
    modifiedAfter,
    changedSinceFloor,
  };
}

/**
 * One provider opportunity: observe it, resolve identity, then — and only
 * then — compare.
 *
 * The ORDER matters. The snapshot is written for every record regardless of
 * whether it links, because "the provider has a notice Capiro's own rail does
 * not" is itself the finding a verification rail exists to surface, and
 * throwing that observation away because it did not match would hide it.
 */
async function processOne(
  deps: OpportunityShadowDeps,
  options: OpportunityShadowOptions,
  opportunity: TangoOpportunity,
  summary: {
    linked: number;
    ambiguous: number;
    unlinked: number;
    vanished: number;
    conflicts: number;
    snapshots: number;
  },
): Promise<void> {
  if (options.commit) {
    await deps.store.writeSnapshot({
      resourceType: 'opportunity',
      externalId: opportunity.opportunityId,
      sourceUpdatedAt: opportunity.provenance.providerUpdatedAt,
      sourceUrl: opportunity.sourceUrl,
      normalized: toOpportunitySnapshot(opportunity),
    });
  }
  summary.snapshots += 1;

  const normalized = normalizeSolicitationNumber(opportunity.solicitationNumber);
  const candidates = normalized ? await deps.findSamCandidates(normalized) : [];
  const crosswalk = resolveCrosswalk(opportunity, candidates);

  const state: CrosswalkState = crosswalk.state;
  if (state === 'ambiguous') {
    summary.ambiguous += 1;
    return;
  }
  if (state === 'unlinked') {
    summary.unlinked += 1;
    return;
  }

  const samOpportunityId = crosswalk.samOpportunityId!;
  const local = await deps.readSamParitySource(samOpportunityId);
  if (local == null) {
    // The candidate query and the column read are two statements; a notice can
    // be deleted between them. Counted rather than swallowed, and no link is
    // recorded for a row that is not there.
    summary.vanished += 1;
    return;
  }

  summary.linked += 1;

  const rows = compareParity(local, opportunity);
  summary.conflicts += rows.filter((r) => r.agreement === 'conflict').length;

  if (options.commit) {
    await deps.store.proposeLink({
      localResourceType: 'sam_opportunity',
      localResourceId: samOpportunityId,
      tangoResourceType: 'opportunity',
      tangoExternalId: opportunity.opportunityId,
      // The ONLY basis this script can produce. `reviewed_manual` requires a
      // human, and no fuzzy basis exists in the column's own CHECK.
      basis: 'exact_identifier',
      // A shared solicitation number matched to exactly one local notice is a
      // strong identity claim but not a perfect one — the number is the
      // agency's, not a globally unique key. `high` is reserved for a direct
      // id-to-id match, which this provider resource does not offer.
      confidenceBand: 'medium',
    });
    await deps.writeParity({
      tangoOpportunityId: opportunity.opportunityId,
      samOpportunityId,
      rows,
    });
  }
}

// ── Real wiring ──────────────────────────────────────────────────────────────

function prismaServiceFromClient(client: PrismaClient): PrismaService {
  return client as unknown as PrismaService;
}

/**
 * Local notices matching one NORMALIZED solicitation number.
 *
 * tenant-scope-exempt: `sam_opportunity` is a GLOBAL public-domain federal
 * reference table with no tenant_id and no RLS.
 *
 * The normalization happens in SQL rather than in TypeScript because the
 * alternative is loading every notice to normalize it in memory. The
 * expression matches `normalizeSolicitationNumber` exactly, and
 * `sync-tango-opportunity-shadow.spec.ts` pins the two against each other.
 */
function realFindSamCandidates(prisma: PrismaClient): OpportunityShadowDeps['findSamCandidates'] {
  return async (normalized) => {
    const rows = await prisma.$queryRaw<
      Array<{ id: string; notice_id: string; solicitation_number: string | null }>
    >`
      SELECT id::text AS id, notice_id, solicitation_number
      FROM sam_opportunity
      WHERE regexp_replace(upper(coalesce(solicitation_number, '')), '[^A-Z0-9]', '', 'g') = ${normalized}
      LIMIT 50
    `;
    return rows.map((r) => ({
      id: r.id,
      noticeId: r.notice_id,
      solicitationNumber: r.solicitation_number,
    }));
  };
}

function realReadSamParitySource(prisma: PrismaClient): OpportunityShadowDeps['readSamParitySource'] {
  return async (samOpportunityId) => {
    // tenant-scope-exempt: sam_opportunity is global federal reference data.
    const row = await prisma.samOpportunity.findUnique({
      where: { id: samOpportunityId },
      select: {
        title: true,
        solicitationNumber: true,
        responseDeadline: true,
        active: true,
        setAside: true,
        naicsCode: true,
        pscCode: true,
        agency: true,
      },
    });
    return row ?? null;
  };
}

/**
 * Upsert the ledger for one pair.
 *
 * `last_observed_at` always moves; `first_observed_at` moves ONLY when the
 * outcome changed. That is what lets the diagnostic say "this conflict has
 * stood for three weeks" rather than "this conflict was seen five minutes ago",
 * which is true of every conflict after every run and therefore useless.
 *
 * A REVIEWED row keeps its resolution: a re-run re-confirms the observation, it
 * does not un-review a human's decision about it.
 */
function realWriteParity(prisma: PrismaClient): OpportunityShadowDeps['writeParity'] {
  return async ({ tangoOpportunityId, samOpportunityId, rows }) => {
    const observedAt = new Date();
    for (const row of rows) {
      const existing = await prisma.tangoOpportunityParity.findUnique({
        where: {
          tangoOpportunityId_samOpportunityId_field: {
            tangoOpportunityId,
            samOpportunityId,
            field: row.field,
          },
        },
        select: { id: true, agreement: true, localValue: true, providerValue: true },
      });

      if (existing == null) {
        await prisma.tangoOpportunityParity.create({
          data: {
            tangoOpportunityId,
            samOpportunityId,
            field: row.field,
            localValue: row.localValue,
            providerValue: row.providerValue,
            agreement: row.agreement,
            firstObservedAt: observedAt,
            lastObservedAt: observedAt,
          },
        });
        continue;
      }

      const changed =
        existing.agreement !== row.agreement ||
        existing.localValue !== row.localValue ||
        existing.providerValue !== row.providerValue;

      await prisma.tangoOpportunityParity.update({
        where: { id: existing.id },
        data: {
          localValue: row.localValue,
          providerValue: row.providerValue,
          agreement: row.agreement,
          lastObservedAt: observedAt,
          ...(changed ? { firstObservedAt: observedAt } : {}),
        },
      });
    }
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = (process.env.TANGO_API_KEY ?? '').trim();
  if (!apiKey) {
    console.error('TANGO_OPP_SHADOW_ERR No TANGO_API_KEY configured.');
    process.exitCode = 1;
    return;
  }

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

    const summary = await runOpportunityShadowSync(
      {
        gateway,
        store,
        findSamCandidates: realFindSamCandidates(prisma),
        readSamParitySource: realReadSamParitySource(prisma),
        writeParity: realWriteParity(prisma),
      },
      {
        commit: args.commit,
        limit: args.limit,
        overlapHours: args.overlapHours,
        changedSince: args.changedSince,
      },
    );

    console.log(
      `TANGO_OPP_SHADOW_DONE ${JSON.stringify({ ...summary, commit: args.commit, health: gateway.getHealth() })}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /sync-tango-opportunity-shadow(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      'TANGO_OPP_SHADOW_ERR',
      redactWithKnownSecret(redact(message), process.env.TANGO_API_KEY ?? null),
    );
    process.exitCode = 1;
  });
}

export { main };
