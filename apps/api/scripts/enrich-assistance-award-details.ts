/**
 * District Nexus — per-award detail enrichment for federal_assistance_award.
 *
 *   pnpm --filter @capiro/api enrich:assistance-awards
 *   tsx scripts/enrich-assistance-award-details.ts --limit 500
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

const DELAY_MS = 300;

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

/** Fetch one award's detail record. Not rate-limited itself — caller sleeps between calls. */
export async function fetchAwardDetail(awardUniqueId: string): Promise<AwardDetailRaw> {
  const url = `https://api.usaspending.gov/api/v2/awards/${encodeURIComponent(awardUniqueId)}/`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`USAspending award detail ${res.status}: ${await res.text().catch(() => '')}`);
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
): Promise<RunCounts> {
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
  for (const [i, award] of candidates.entries()) {
    if (i > 0) await deps.sleep(DELAY_MS);
    try {
      const detail = await deps.fetchAwardDetail(award.awardUniqueId);
      const update = buildEnrichmentUpdate(award, detail);
      await prisma.federalAssistanceAward.update({ where: { id: award.id }, data: update });
      updated += 1;
    } catch (e) {
      errors += 1;
      console.error(`[enrich-assistance-award-details] ${award.awardUniqueId} failed: ${(e as Error).message}`);
    }
  }
  return { inserted: 0, updated, skipped: 0, errors };
}

async function main(): Promise<void> {
  const limit = Number(arg('limit') ?? 500);
  const prisma = new PrismaClient();
  await prisma.$connect();
  console.error(`[enrich-assistance-award-details] limit=${limit}`);

  try {
    const counts = await runWithSyncRun(
      prisma as unknown as Parameters<typeof runWithSyncRun>[0],
      'enrich-assistance-award-details',
      async () => {
        const result = await enrichCandidates(prisma as unknown as EnrichPrisma, limit);
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
