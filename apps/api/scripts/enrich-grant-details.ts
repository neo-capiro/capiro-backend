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

/** Exported for unit testing with a mocked fetcher/sleep — no live calls, no real DB. */
export async function enrichGrantCandidates(
  prisma: EnrichGrantsPrisma,
  limit: number,
  deps: EnrichDeps = { fetchOpportunityDetail, sleep },
): Promise<RunCounts> {
  const candidates = await prisma.federalGrant.findMany({
    orderBy: [{ detailSyncedAt: { sort: 'asc', nulls: 'first' } }],
    take: limit,
    select: { id: true },
  });

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
  const limit = Number(arg('limit') ?? 300);
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
