/**
 * District Nexus — per-award detail enrichment for federal_assistance_award.
 *
 *   pnpm --filter @capiro/api enrich:assistance-awards
 *   tsx scripts/enrich-assistance-award-details.ts --limit 500
 *   tsx scripts/enrich-assistance-award-details.ts --limit 500 --delay-ms 2000
 *
 * NOT a backfill rail. USAspending's edge blocked this client outright on
 * 2026-07-28 under a sustained 3.3 req/s walk; see UpstreamBlockedError. The
 * run now aborts on a block instead of burning its whole limit, but the ~238k
 * backlog still belongs to the bulk-download path, not to this per-award pass.
 *
 * The search-endpoint sync (sync-federal-assistance-awards.ts) already
 * captures UEI, ALN, outlays, and place-of-performance/recipient-location
 * directly from spending_by_award — this pass is intentionally THIN. It only
 * fills the handful of fields verified live 2026-07-24 to require the
 * per-award detail call (GET /api/v2/awards/{generated_unique_award_id}/):
 *   - fain / uri            (an aggregate assistance award can carry a URI
 *                            the search endpoint's "Award ID" field omits)
 *   - subawardCount         (detail's `subaward_count`)
 *   - nonFederalFundingAmount (detail's `non_federal_funding` — NOT available
 *                            from search at all, verified live)
 *   - fundingOpportunityNumber (detail's `funding_opportunity.number` —
 *                            frequently the literal sentinel "NOT APPLICABLE",
 *                            stored verbatim, never filtered/guessed)
 *   - parentRecipientName / parentRecipientUei (detail's `recipient.
 *                            parent_recipient_name` / `parent_recipient_uei`,
 *                            field names verified live 2026-07-24). The UEI is
 *                            shape-gated through `asUei` — see the note on
 *                            `parent_recipient_unique_id`, which is the retired
 *                            DUNS and must never land in a UEI column.)
 *
 * Processes the highest-value, not-yet-enriched awards first
 * (detailEnrichedAt IS NULL, ORDER BY totalObligatedAmount DESC). Rate-
 * limited and resumable — safe to interrupt and re-run; each award is only
 * ever visited once per run and is marked detailEnrichedAt on completion even
 * if the detail response added nothing (so a re-run doesn't loop forever on
 * an award with no further data). Never overwrites an existing non-null value
 * — only fills fields that are still null, so a more-precise value already
 * present from search (or a prior enrichment pass) is never downgraded.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

/**
 * Raised from 300 ms after USAspending's edge blocked this client outright on
 * 2026-07-28 (see UpstreamBlockedError). 300 ms is ~3.3 req/s sustained across
 * a 238k-row backlog — roughly 20 hours of uninterrupted hammering from a
 * single NAT IP.
 *
 * To be clear about what this does and does not buy: a gentler rate lowers the
 * chance of being blocked, it does NOT make this script a viable route for the
 * full backlog. Even at 1 req/s that is ~66 hours. Depth belongs to the bulk
 * download rail (`/api/v2/bulk_download/awards/`) that the Rev 2 plan already
 * documents; this pass is for keeping the recent head enriched.
 */
const DEFAULT_DELAY_MS = 1_000;

/**
 * Consecutive failures tolerated before the run gives up. A single award can
 * legitimately 404 or 500; two dozen in a row means the upstream is refusing
 * us, and every further attempt is waste.
 */
const MAX_CONSECUTIVE_FAILURES = 25;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AwardDetailRaw {
  fain?: string | null;
  uri?: string | null;
  subaward_count?: number | null;
  non_federal_funding?: number | null;
  funding_opportunity?: { number?: string | null } | null;
  recipient?: {
    parent_recipient_name?: string | null;
    /** The live, correct parent identifier. Verified against the API 2026-07-24. */
    parent_recipient_uei?: string | null;
    /**
     * DELIBERATELY TYPED, DELIBERATELY NEVER READ.
     *
     * This is the retired DUNS number, which USAspending still returns on many
     * award detail records. It is NOT a UEI and must never reach a UEI column:
     * DUNS is 9 digits, UEI is 12 alphanumerics, and anything downstream that
     * joins on UEI would silently match nothing (or, worse, match the wrong
     * entity). It is declared here so the shape is documented and so a future
     * reader does not "helpfully" fall back to it when parent_recipient_uei is
     * null. `asUei` below is the only path into the column, and it rejects this.
     */
    parent_recipient_unique_id?: string | null;
  } | null;
}

/** A UEI is exactly 12 alphanumerics. */
const UEI_SHAPE = /^[A-Z0-9]{12}$/;

/**
 * Gate for anything headed to a UEI column. Returns the normalized UEI, or null
 * if the value is not UEI-shaped — which is what keeps a 9-digit DUNS
 * (`parent_recipient_unique_id`) out of `parentRecipientUei`.
 */
export function asUei(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return UEI_SHAPE.test(normalized) ? normalized : null;
}

/**
 * USAspending's edge rejected this client wholesale on 2026-07-28: the same
 * award ids returned HTTP 200 from a workstation AND from a low-volume probe
 * inside the same subnet/security group, while the sustained run failed
 * 214/214 then 120/121. The rejection arrives as an HTML page titled
 * "The URL you requested has been blocked", surfaced as a 5xx.
 *
 * That is categorically different from "this one award errored": every
 * subsequent request will fail too, so continuing only burns the remaining
 * limit and deepens the block. It gets its own type so the caller can stop.
 */
export class UpstreamBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamBlockedError';
  }
}

/** Distinguishes an edge/WAF rejection from a genuine API error. */
export function isBlockResponse(
  status: number,
  body: string,
  contentType: string | null,
): boolean {
  const lower = body.toLowerCase();
  if (lower.includes('has been blocked') || lower.includes('access denied')) return true;
  // A JSON API answering an award lookup with an HTML document is an edge
  // appliance talking, not the application.
  return status >= 500 && (contentType ?? '').toLowerCase().includes('text/html');
}

/** Fetch one award's detail record. Not rate-limited itself — caller sleeps between calls. */
export async function fetchAwardDetail(awardUniqueId: string): Promise<AwardDetailRaw> {
  const url = `https://api.usaspending.gov/api/v2/awards/${encodeURIComponent(awardUniqueId)}/`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const contentType =
      typeof res.headers?.get === 'function' ? res.headers.get('content-type') : null;
    if (isBlockResponse(res.status, body, contentType)) {
      throw new UpstreamBlockedError(
        `USAspending edge blocked this client (HTTP ${res.status}). Every further request will ` +
          `fail; re-running immediately deepens the block. Lower the rate (--delay-ms) or use ` +
          `the bulk-download rail.`,
      );
    }
    // Truncated deliberately: a block page is ~40 KB of base64 and floods the
    // log, which is what obscured this failure in the first place.
    throw new Error(`USAspending award detail ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as AwardDetailRaw;
}

export interface ExistingAssistanceAwardRow {
  id: string;
  awardUniqueId: string;
  fain: string | null;
  uri: string | null;
  subawardCount: number | null;
  nonFederalFundingAmount: unknown | null;
  fundingOpportunityNumber: string | null;
  parentRecipientName: string | null;
  parentRecipientUei: string | null;
}

/**
 * Fill-only diff: returns just the fields that were null and now have a
 * verified value, plus detailEnrichedAt. Never includes a field the row
 * already has a non-null value for.
 */
export function buildEnrichmentUpdate(
  existing: ExistingAssistanceAwardRow,
  detail: AwardDetailRaw,
): Record<string, unknown> {
  const update: Record<string, unknown> = { detailEnrichedAt: new Date() };
  if (existing.fain == null && detail.fain != null) update.fain = detail.fain;
  if (existing.uri == null && detail.uri != null) update.uri = detail.uri;
  if (existing.subawardCount == null && detail.subaward_count != null) {
    update.subawardCount = detail.subaward_count;
  }
  if (existing.nonFederalFundingAmount == null && detail.non_federal_funding != null) {
    update.nonFederalFundingAmount = detail.non_federal_funding;
  }
  if (existing.fundingOpportunityNumber == null && detail.funding_opportunity?.number != null) {
    update.fundingOpportunityNumber = detail.funding_opportunity.number;
  }
  if (existing.parentRecipientName == null && detail.recipient?.parent_recipient_name != null) {
    update.parentRecipientName = detail.recipient.parent_recipient_name;
  }
  // Shape-gated: a non-UEI value (notably the retired DUNS in
  // parent_recipient_unique_id) yields null and simply isn't written, leaving
  // the column honestly empty rather than populated with an identifier that
  // looks joinable and isn't.
  const parentUei = asUei(detail.recipient?.parent_recipient_uei);
  if (existing.parentRecipientUei == null && parentUei != null) {
    update.parentRecipientUei = parentUei;
  }
  return update;
}

export interface EnrichPrisma {
  federalAssistanceAward: {
    findMany(args: unknown): Promise<ExistingAssistanceAwardRow[]>;
    update(args: { where: { id: string }; data: unknown }): Promise<unknown>;
  };
}

export interface EnrichDeps {
  fetchAwardDetail: typeof fetchAwardDetail;
  sleep: (ms: number) => Promise<void>;
}

/** Exported for unit testing with a mocked fetchAwardDetail/sleep — no live calls, no real DB. */
export async function enrichCandidates(
  prisma: EnrichPrisma,
  limit: number,
  deps: EnrichDeps = { fetchAwardDetail, sleep },
  options: { delayMs?: number } = {},
): Promise<RunCounts> {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const candidates = await prisma.federalAssistanceAward.findMany({
    where: { detailEnrichedAt: null },
    orderBy: [{ totalObligatedAmount: 'desc' }, { lastSyncedAt: 'desc' }],
    take: limit,
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

  let updated = 0;
  let errors = 0;
  let consecutiveFailures = 0;
  let abortReason: string | null = null;

  for (const [i, award] of candidates.entries()) {
    if (i > 0) await deps.sleep(delayMs);
    try {
      const detail = await deps.fetchAwardDetail(award.awardUniqueId);
      const update = buildEnrichmentUpdate(award, detail);
      await prisma.federalAssistanceAward.update({ where: { id: award.id }, data: update });
      updated += 1;
      consecutiveFailures = 0;
    } catch (e) {
      errors += 1;
      consecutiveFailures += 1;
      const message = (e as Error).message;
      console.error(`[enrich-assistance-award-details] ${award.awardUniqueId} failed: ${message}`);

      // An edge block is terminal for this run by definition — it is not about
      // this award, and the next 49,999 attempts would fail identically.
      if (e instanceof UpstreamBlockedError || (e as Error).name === 'UpstreamBlockedError') {
        abortReason = `upstream block detected after ${i + 1} of ${candidates.length} awards`;
        break;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        abortReason =
          `${MAX_CONSECUTIVE_FAILURES} consecutive failures after ${i + 1} of ` +
          `${candidates.length} awards — treating upstream as unavailable`;
        break;
      }
    }
  }

  if (abortReason) {
    // Loud and unambiguous. The original failure mode was a run that exited 0
    // having enriched nothing, which read as success in the ledger.
    console.error(
      `[enrich-assistance-award-details] ABORTED: ${abortReason}. ` +
        `Enriched ${updated} before stopping. This run is INCOMPLETE — do NOT simply re-run at ` +
        `the same rate; raise --delay-ms or switch to the bulk-download rail.`,
    );
  }

  return { inserted: 0, updated, skipped: 0, errors };
}

async function main(): Promise<void> {
  const limit = Number(arg('limit') ?? 500);
  const delayArg = arg('delay-ms');
  const delayMs = delayArg != null && delayArg !== '' ? Number(delayArg) : DEFAULT_DELAY_MS;
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(`--delay-ms must be a non-negative number (got ${String(delayArg)})`);
  }
  const prisma = new PrismaClient();
  await prisma.$connect();
  console.error(`[enrich-assistance-award-details] limit=${limit} delayMs=${delayMs}`);

  try {
    const counts = await runWithSyncRun(
      prisma as unknown as Parameters<typeof runWithSyncRun>[0],
      'enrich-assistance-award-details',
      async () => {
        const result = await enrichCandidates(
          prisma as unknown as EnrichPrisma,
          limit,
          { fetchAwardDetail, sleep },
          { delayMs },
        );
        console.log(JSON.stringify({ source: 'enrich-assistance-award-details', limit, ...result }, null, 2));
        return result;
      },
    );
    console.error(`[enrich-assistance-award-details] DONE updated=${counts.updated} errors=${counts.errors}`);
  } finally {
    await prisma.$disconnect();
  }
}

// Guard against firing on import — this module's testable exports
// (fetchAwardDetail, buildEnrichmentUpdate, enrichCandidates) are imported
// directly by the spec, which must not trigger a live PrismaClient connect.
if (require.main === module) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
