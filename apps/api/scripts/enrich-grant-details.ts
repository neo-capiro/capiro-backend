/**
 * District Nexus Workstream C — per-opportunity detail enrichment for
 * federal_grant, from Grants.gov fetchOpportunity.
 *
 *   pnpm --filter @capiro/api enrich:grant-details
 *   tsx scripts/enrich-grant-details.ts --limit 300
 *
 * sync-grants.ts can only write the ten fields search2 returns. Everything
 * else on federal_grant lives on the fetchOpportunity payload and is written
 * here: category, fundingInstrument, awardCeiling/Floor, estimatedFunding,
 * description, eligibility, expectedAwards, plus the Workstream C detail
 * block (eligibilityText, costSharing, docType, revision, responseDateDesc,
 * amendmentCount, lastUpdatedAt, raw).
 *
 * TWO PAYLOAD SHAPES, verified live 2026-07-24 — they are not interchangeable:
 *   docType 'synopsis' → detail.synopsis: synopsisDesc, responseDate,
 *                        responseDateDesc, applicantEligibilityDesc
 *   docType 'forecast' → detail.forecast: forecastDesc,
 *                        estApplicationResponseDate(+Desc), and NO
 *                        applicantEligibilityDesc / responseDate at all
 * A forecast's date is an estimate, not a deadline, so this pass never writes
 * it into closeDate — the estimate is surfaced through responseDateDesc only.
 *
 * OVERWRITE SEMANTICS differ deliberately from
 * enrich-assistance-award-details.ts, which is strictly fill-only. A grant
 * opportunity is amendable: ceilings, deadlines and eligibility genuinely
 * change, and the detail payload is the authority for them. So a present
 * value in the payload always wins; a missing/null one never clobbers what is
 * already stored.
 *
 * `--limit` bounds one run. Candidates are never-enriched first
 * (detailSyncedAt IS NULL), then stalest-first, so repeated runs sweep the
 * table and pick up amendments without a cursor.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import {
  grantActiveWhere,
  grantClosedWhere,
} from '../src/funding-opportunities/source-lifecycle.js';

dotenvConfig();

const FETCH_URL = 'https://api.grants.gov/v1/api/fetchOpportunity';
const DELAY_MS = 300;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CodeDesc {
  id?: string;
  description?: string | null;
}

/** The synopsis and forecast blocks, unioned — read only through pickBlock(). */
export interface DetailBlock {
  synopsisDesc?: string | null;
  forecastDesc?: string | null;
  responseDateDesc?: string | null;
  estApplicationResponseDateDesc?: string | null;
  applicantEligibilityDesc?: string | null;
  costSharing?: boolean | null;
  numberOfAwards?: string | number | null;
  estimatedFunding?: string | number | null;
  awardCeiling?: string | number | null;
  awardFloor?: string | number | null;
  applicantTypes?: CodeDesc[] | null;
  fundingInstruments?: CodeDesc[] | null;
  lastUpdatedDate?: string | null;
}

export interface OpportunityDetailRaw {
  id?: number | string;
  revision?: number | null;
  docType?: string | null;
  opportunityCategory?: { category?: string; description?: string | null } | null;
  cfdas?: Array<{ cfdaNumber?: string | null }> | null;
  opportunityHistoryDetails?: unknown[] | null;
  synopsis?: DetailBlock | null;
  forecast?: DetailBlock | null;
}

/** Fetch one opportunity's detail. Caller sleeps between calls. */
export async function fetchOpportunityDetail(opportunityId: string): Promise<OpportunityDetailRaw> {
  // fetchOpportunity requires a NUMERIC opportunityId; search2 hands back the
  // same value as a string, so the cast is mandatory (a string id returns an
  // error envelope, not a 4xx).
  const numericId = Number(opportunityId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new Error(`non-numeric opportunity id ${JSON.stringify(opportunityId)}`);
  }
  const res = await fetch(FETCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opportunityId: numericId }),
  });
  if (!res.ok) throw new Error(`grants.gov fetchOpportunity ${res.status}`);
  const body = (await res.json()) as any;
  // Envelope: { errorcode, msg, data }. errorcode 0 === "Webservice Succeeds";
  // anything else is an application-level failure behind an HTTP 200.
  if (body?.errorcode !== undefined && body.errorcode !== 0) {
    throw new Error(`grants.gov fetchOpportunity errorcode ${body.errorcode}: ${body?.msg ?? ''}`);
  }
  return (body?.data ?? body) as OpportunityDetailRaw;
}

/** Whichever of the two mutually-exclusive blocks this opportunity carries. */
export function pickBlock(detail: OpportunityDetailRaw): DetailBlock {
  return detail.synopsis ?? detail.forecast ?? {};
}

function num(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function int(v: string | number | null | undefined): number | null {
  const n = num(v);
  return n == null ? null : Math.trunc(n);
}

/**
 * Grants.gov stamps timestamps like "Mar 20, 2025 10:28:30 AM EDT". V8's date
 * parser resolves the US timezone abbreviations (EST/EDT/CST/…) to a fixed
 * offset independently of the host TZ, so this is stable on a UTC container.
 */
export function parseVendorTimestamp(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/** Trim the bulky attachment/package arrays before persisting `raw`. */
export function trimRaw(detail: OpportunityDetailRaw): Record<string, unknown> {
  const {
    synopsisAttachmentFolders: _a,
    synopsisDocumentURLs: _b,
    opportunityPkgs: _c,
    closedOpportunityPkgs: _d,
    ...rest
  } = detail as Record<string, unknown>;
  return rest;
}

/**
 * Build the update payload. Only keys with a real value from the payload are
 * included — an absent field is left untouched rather than nulled.
 */
export function buildDetailUpdate(detail: OpportunityDetailRaw): Record<string, unknown> {
  const b = pickBlock(detail);
  const update: Record<string, unknown> = { detailSyncedAt: new Date(), raw: trimRaw(detail) };

  const set = (key: string, value: unknown) => {
    if (value !== null && value !== undefined && value !== '') update[key] = value;
  };

  set('category', detail.opportunityCategory?.description);
  set('docType', detail.docType);
  if (typeof detail.revision === 'number') update.revision = detail.revision;
  if (Array.isArray(detail.opportunityHistoryDetails)) {
    update.amendmentCount = detail.opportunityHistoryDetails.length;
  }

  const cfdas = (detail.cfdas ?? [])
    .map((c) => c?.cfdaNumber)
    .filter((c): c is string => typeof c === 'string' && c.length > 0);
  if (cfdas.length) update.cfdaNumbers = cfdas;

  set('description', b.synopsisDesc ?? b.forecastDesc);
  set('eligibilityText', b.applicantEligibilityDesc);
  set('responseDateDesc', b.responseDateDesc ?? b.estApplicationResponseDateDesc);
  if (typeof b.costSharing === 'boolean') update.costSharing = b.costSharing;

  set('awardCeiling', num(b.awardCeiling));
  set('awardFloor', num(b.awardFloor));
  set('estimatedFunding', num(b.estimatedFunding));
  set('expectedAwards', int(b.numberOfAwards));

  const eligibility = (b.applicantTypes ?? [])
    .map((a) => a?.description)
    .filter((d): d is string => typeof d === 'string' && d.length > 0);
  if (eligibility.length) update.eligibility = eligibility;

  const instruments = (b.fundingInstruments ?? [])
    .map((f) => f?.description)
    .filter((d): d is string => typeof d === 'string' && d.length > 0);
  if (instruments.length) update.fundingInstrument = instruments.join(', ');

  set('lastUpdatedAt', parseVendorTimestamp(b.lastUpdatedDate));

  return update;
}

export interface ExistingGrantRow {
  id: string;
}

export interface EnrichGrantsPrisma {
  federalGrant: {
    findMany(args: unknown): Promise<ExistingGrantRow[]>;
    update(args: { where: { id: string }; data: unknown }): Promise<unknown>;
  };
}

export interface EnrichDeps {
  fetchOpportunityDetail: typeof fetchOpportunityDetail;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Share of each run reserved for CURRENT/pursuable grants.
 *
 * 70/30 rather than all-or-nothing. Pursuable grants are what producers score and
 * what users read, so they get the majority; the archived tail gets a guaranteed
 * minority so it eventually completes instead of never starting.
 */
export const PURSUABLE_SHARE = 0.7;

/**
 * Validate `--limit`. Exported so the CLI and the tests agree on what is invalid.
 *
 * Previously `Number(arg('limit') ?? 300)` was passed straight through, so
 * `--limit abc` became `NaN` and `take: NaN` — which Prisma rejects at query time
 * with an opaque validation error after the run had already opened a SyncRun row —
 * and `--limit 0` or `--limit -5` produced a run that fetched nothing and reported
 * success.
 */
export function parseEnrichmentLimit(raw: string | undefined, fallback = 300): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `--limit must be a positive integer; received ${JSON.stringify(raw)}. A zero or negative limit would report a successful run that enriched nothing.`,
    );
  }
  return parsed;
}

/**
 * Split one run's budget between the two populations.
 *
 * Unused capacity on either side flows to the other, so a run always costs exactly
 * `limit` fetches when there is that much work — reserving a share must not mean
 * wasting it when one pool is empty.
 */
export function allocateEnrichmentBudget(
  limit: number,
  available: { pursuable: number; historical: number },
): { pursuable: number; historical: number } {
  const pursuableTarget = Math.max(1, Math.round(limit * PURSUABLE_SHARE));
  const historicalTarget = Math.max(1, limit - pursuableTarget);

  let pursuable = Math.min(pursuableTarget, available.pursuable);
  let historical = Math.min(historicalTarget, available.historical);
  // Reflow whatever the other side could not use.
  const spare = limit - pursuable - historical;
  if (spare > 0) {
    const extraPursuable = Math.min(spare, available.pursuable - pursuable);
    pursuable += extraPursuable;
    historical += Math.min(spare - extraPursuable, available.historical - historical);
  }
  return { pursuable, historical };
}

/** Exported for unit testing with a mocked fetcher/sleep — no live calls, no real DB. */
export async function enrichGrantCandidates(
  prisma: EnrichGrantsPrisma,
  limit: number,
  deps: EnrichDeps = { fetchOpportunityDetail, sleep },
): Promise<RunCounts> {
  // ── Each run RESERVES capacity for both populations.
  //
  // The `--all-statuses` reconcile grew federal_grant from ~5.5k to ~83k on
  // 2026-07-29, and 72,689 of those are `archived`. A single detailSyncedAt-ordered
  // sweep therefore drew almost entirely from archived rows at 300/run — roughly
  // nine months — while the ~850 unenriched grants producers actually score waited
  // behind them. `description` and `eligibility` come ONLY from this enrichment and
  // generate-funding-grant-candidates reads both, so that ordering starved the live
  // scorer.
  //
  // The fix for THAT starvation created the opposite one: taking `limit` pursuable
  // rows FIRST and only topping up from the archived tail meant that once the
  // pursuable pool exceeded 300 — which it permanently does, because pursuable rows
  // are re-enriched forever on a stalest-first cycle to catch amendments — the
  // archived tail was never touched again. Priority is not a schedule; a
  // continuously refreshed population with unconditional priority is a starvation
  // loop.
  //
  // So both get a reserved share, and unused capacity on either side flows to the
  // other so a run still costs exactly `limit` fetches when the work exists.
  const now = new Date();
  const pursuableWhere = grantActiveWhere(now) as never;
  const historicalWhere = grantClosedWhere(now) as never;
  const order = [{ detailSyncedAt: { sort: 'asc', nulls: 'first' } }];

  // Over-fetch each side to the FULL limit so the reflow has something to draw on
  // without a second round trip.
  const [pursuablePool, historicalPool] = await Promise.all([
    prisma.federalGrant.findMany({
      where: pursuableWhere,
      orderBy: order,
      take: limit,
      select: { id: true },
    }),
    prisma.federalGrant.findMany({
      where: historicalWhere,
      orderBy: order,
      take: limit,
      select: { id: true },
    }),
  ]);

  const budget = allocateEnrichmentBudget(limit, {
    pursuable: pursuablePool.length,
    historical: historicalPool.length,
  });
  const candidates = [
    ...pursuablePool.slice(0, budget.pursuable),
    ...historicalPool.slice(0, budget.historical),
  ];
  console.error(
    `[enrich-grant-details] budget limit=${limit} pursuable=${budget.pursuable} historical=${budget.historical}`,
  );

  let updated = 0;
  let errors = 0;
  for (const [i, grant] of candidates.entries()) {
    if (i > 0) await deps.sleep(DELAY_MS);
    try {
      const detail = await deps.fetchOpportunityDetail(grant.id);
      await prisma.federalGrant.update({
        where: { id: grant.id },
        data: buildDetailUpdate(detail),
      });
      updated += 1;
    } catch (e) {
      errors += 1;
      console.error(`[enrich-grant-details] ${grant.id} failed: ${(e as Error).message}`);
    }
  }
  return { inserted: 0, updated, skipped: 0, errors };
}

async function main(): Promise<void> {
  // Validated BEFORE the SyncRun row is opened, so an invalid limit fails loudly
  // rather than recording a run that fetched nothing.
  const limit = parseEnrichmentLimit(arg('limit'));
  const prisma = new PrismaClient();
  await prisma.$connect();
  console.error(`[enrich-grant-details] limit=${limit}`);

  try {
    const counts = await runWithSyncRun(
      prisma as unknown as Parameters<typeof runWithSyncRun>[0],
      'enrich-grant-details',
      async () => {
        const result = await enrichGrantCandidates(prisma as unknown as EnrichGrantsPrisma, limit);
        console.log(JSON.stringify({ source: 'enrich-grant-details', limit, ...result }, null, 2));
        return result;
      },
    );
    console.error(`[enrich-grant-details] DONE updated=${counts.updated} errors=${counts.errors}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
