/**
 * enrich-award-pe-tas.ts  (Layer 2/3 — USAspending File C TAS+ProgramActivity crosswalk
 *                          + UEI/name confirmation against R-3 named primes)
 *
 *   tsx scripts/enrich-award-pe-tas.ts --limit 2000 --min-amount 100000
 *   tsx scripts/enrich-award-pe-tas.ts --refresh --limit 500
 *
 * WHY: sync-federal-award's spending_by_award SEARCH endpoint returns no funding
 * account. The per-award FUNDING endpoint (/api/v2/awards/funding/) returns the DATA
 * Act File C breakdown: Treasury Account Symbol (federal_account), Program Activity
 * (code+name), Object Class, fiscal year and obligations. TAS + Program Activity is the
 * federal mechanism that ties an award to the appropriation it was funded from.
 *
 * HONEST PRECISION MODEL (this tool goes in front of congressional staff):
 *   - TAS + Program Activity is MANY-to-one to PE (one RDT&E account/PA funds hundreds of
 *     PEs). So we DO store the dominant TAS+PA on the award for display + dollar context,
 *     but we DO NOT assert a single pe_code from TAS+PA alone.
 *   - We assert a pe_code ONLY when we can CONFIRM it: the award's recipient matches an
 *     R-3 named prime (program_element_performer) by normalized name. That is the
 *     government-stated PE->prime link. peCodeSource='uei_confirmed_r3_prime',
 *     peCodeConfidence=1.0. When the match resolves to exactly one PE we set pe_code;
 *     when a prime serves multiple PEs we record candidateCount and leave pe_code null
 *     (the UI shows "named prime on N programs" rather than a false 1:1).
 *
 * Idempotent: by default processes contract awards where funding_tas IS NULL,
 * highest-dollar first, capped by --limit. --refresh re-reads already-enriched rows
 * (e.g. after the performer table grows). Read-only against USAspending; writes only
 * federal_award. Rate-limited with exponential backoff (same as enrich-award-pe).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

const FUNDING_URL = 'https://api.usaspending.gov/api/v2/awards/funding/';
const DELAY_MS = Number(process.env.USASPENDING_DELAY_MS ?? 150);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface FundingRow {
  federal_account: string | null;
  account_title: string | null;
  program_activity_code: string | null;
  program_activity_name: string | null;
  reporting_fiscal_year: number | null;
  transaction_obligated_amount: number | null;
  gross_outlay_amount: number | null;
}

interface DominantFunding {
  tas: string | null;
  tasTitle: string | null;
  paCode: string | null;
  paName: string | null;
  fy: number | null;
}

/** Page through /awards/funding/ and pick the dominant (largest-obligation) TAS+PA. */
async function fetchDominantFunding(awardId: string): Promise<DominantFunding | null | undefined> {
  // undefined = transient failure (skip, retry later); null = no funding rows (record as processed)
  const MAX_ATTEMPTS = 4;
  const agg = new Map<string, { row: FundingRow; oblig: number }>();
  let page = 1;
  for (;;) {
    let json: { results?: FundingRow[]; page_metadata?: { hasNext?: boolean } } | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const res = await fetch(FUNDING_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ award_id: awardId, page, limit: 100, sort: 'reporting_fiscal_date', order: 'desc' }),
        });
        if (res.status === 429 || res.status >= 500) {
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1) + Math.random() * 250));
            continue;
          }
          return undefined;
        }
        if (!res.ok) return null;
        json = (await res.json()) as typeof json;
        break;
      } catch {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
          continue;
        }
        return undefined;
      }
    }
    const results = json?.results ?? [];
    for (const r of results) {
      const key = `${r.federal_account ?? ''}|${r.program_activity_code ?? ''}|${r.reporting_fiscal_year ?? ''}`;
      const oblig = Math.abs(Number(r.transaction_obligated_amount ?? 0)) || Math.abs(Number(r.gross_outlay_amount ?? 0));
      const cur = agg.get(key);
      if (cur) cur.oblig += oblig;
      else agg.set(key, { row: r, oblig });
    }
    if (!json?.page_metadata?.hasNext || results.length === 0) break;
    page += 1;
    if (page > 50) break; // circuit breaker
  }
  if (agg.size === 0) return null;
  const dominant = [...agg.values()].sort((a, b) => b.oblig - a.oblig)[0].row;
  return {
    tas: dominant.federal_account ?? null,
    tasTitle: dominant.account_title ?? null,
    paCode: dominant.program_activity_code ?? null,
    paName: dominant.program_activity_name ?? null,
    fy: dominant.reporting_fiscal_year ?? null,
  };
}

/** Normalize a recipient/performer name the same way the extractor's normalize_performer does. */
const US_STATE = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);
function normalizeName(name: string | null): string {
  if (!name) return '';
  let n = name.replace(/\s+/g, ' ').trim().toUpperCase().replace(/[.,]/g, '');
  n = n.replace(/CORPORATION/g, 'CORP').replace(/INCORPORATED/g, 'INC').replace(/\bL L C\b/g, 'LLC');
  n = n.replace(/\s+(CORP|INC|CO|LLC|LTD|LP|PLC)$/g, '').trim();
  return n;
}

async function coverage(prisma: PrismaClient): Promise<Record<string, number>> {
  const [total, withTas, ueiConfirmed] = await Promise.all([
    prisma.federalAward.count(),
    prisma.federalAward.count({ where: { fundingTas: { not: null } } }),
    prisma.federalAward.count({ where: { peCodeSource: 'uei_confirmed_r3_prime' } }),
  ]);
  return { total, withTas, ueiConfirmed };
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/enrich-award-pe-tas.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const limit = Number(arg('limit') ?? 2000);
  const minAmount = arg('min-amount') ? Number(arg('min-amount')) : null;
  const refresh = hasFlag('refresh');

  const prisma = new PrismaClient();
  await prisma.$connect();
  const t0 = Date.now();

  try {
    // Build normalized-performer -> Set<peCode> from the R-3 named primes (named companies only).
    const performers = await prisma.programElementPerformer.findMany({
      where: { isNamedCompany: true },
      select: { peCode: true, performerNormalized: true },
    });
    const primeToPes = new Map<string, Set<string>>();
    for (const p of performers) {
      const k = normalizeName(p.performerNormalized);
      if (!k) continue;
      if (!primeToPes.has(k)) primeToPes.set(k, new Set());
      primeToPes.get(k)!.add(p.peCode.toUpperCase());
    }

    const before = await coverage(prisma);
    console.log(
      `[enrich-award-pe-tas] limit=${limit} minAmount=${minAmount ?? 'none'} refresh=${refresh} ` +
        `primeNames=${primeToPes.size} coverage=${JSON.stringify(before)}`,
    );

    const rows = await prisma.federalAward.findMany({
      where: {
        ...(refresh ? {} : { fundingTas: null }),
        ...(minAmount != null ? { amount: { gte: minAmount } } : {}),
      },
      select: { id: true, awardUniqueId: true, contractorName: true, recipientUei: true, peCode: true },
      orderBy: { amount: 'desc' },
      take: limit,
    });
    console.log(`[enrich-award-pe-tas] ${rows.length} award(s) to process`);

    let withFunding = 0;
    let ueiConfirmed = 0;
    let primeMultiPe = 0;
    let noFunding = 0;
    let failed = 0;

    for (const row of rows) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
      const funding = await fetchDominantFunding(row.awardUniqueId);
      if (funding === undefined) {
        failed += 1;
        continue;
      }
      if (funding === null) {
        noFunding += 1;
        continue;
      }
      withFunding += 1;

      // Attempt UEI/name confirmation against R-3 named primes.
      const recip = normalizeName(row.contractorName);
      const candidatePes = recip ? primeToPes.get(recip) : undefined;
      let peUpdate: Record<string, unknown> = {};
      if (candidatePes && candidatePes.size === 1) {
        const pe = [...candidatePes][0];
        peUpdate = {
          peCode: pe,
          peCodeSource: 'uei_confirmed_r3_prime',
          peCodeConfidence: 1.0,
          peCodeCandidateCount: 1,
        };
        ueiConfirmed += 1;
      } else if (candidatePes && candidatePes.size > 1) {
        // A named prime that serves several PEs — record the ambiguity, don't force a 1:1.
        peUpdate = {
          peCodeConfidence: 0.7,
          peCodeCandidateCount: candidatePes.size,
          peCodeSource: 'r3_prime_multi_pe',
        };
        primeMultiPe += 1;
      }

      try {
        await prisma.federalAward.update({
          where: { id: row.id },
          data: {
            fundingTas: funding.tas,
            fundingTasTitle: funding.tasTitle,
            programActivityCode: funding.paCode,
            programActivityName: funding.paName,
            fundingFy: funding.fy ?? undefined,
            ...peUpdate,
          },
        });
      } catch (err) {
        failed += 1;
        console.warn(`[enrich-award-pe-tas] update failed for ${row.id}: ${(err as Error).message}`);
      }

      if (withFunding % 100 === 0) {
        console.log(`[enrich-award-pe-tas] withFunding=${withFunding} ueiConfirmed=${ueiConfirmed} primeMultiPe=${primeMultiPe} noFunding=${noFunding} failed=${failed}`);
      }
    }

    const after = await coverage(prisma);
    console.log(
      JSON.stringify(
        {
          processed: rows.length,
          withFunding,
          ueiConfirmed,
          primeMultiPe,
          noFunding,
          failed,
          coverageBefore: before,
          coverageAfter: after,
          seconds: ((Date.now() - t0) / 1000).toFixed(1),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
void main().catch((err) => {
  console.error('[enrich-award-pe-tas] FAILED', err);
  process.exit(1);
});
}
