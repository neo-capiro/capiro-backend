/**
 * Sync federal spending intelligence from OpenSpending (USASpending.gov-derived).
 *
 *   pnpm --filter @capiro/api sync:openspending
 *
 * Pulls ~200KB of pre-aggregated JSON from https://www.openspending.us/data/
 * and joins them into three GLOBAL reference tables:
 *   - federal_contractor  (top contractors with parent-company UEI rollup)
 *   - federal_agency      (97 federal agencies w/ budgets + top contractors)
 *   - federal_industry    (top NAICS industries by contract spending)
 *
 * Idempotent. Safe to run on cron. Takes ~5-10 seconds.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

dotenvConfig();

const BASE = 'https://www.openspending.us/data';

// ─── Source schemas ──────────────────────────────────────────────────────

interface Agency {
  name: string;
  abbreviation?: string;
  code?: string;
  slug: string;
  budgetAuthority?: number;
  obligated?: number;
  outlays?: number;
  pctOfTotal?: number;
  pctOfBudget?: number;
  pctContracts?: number;
  costPerAmerican?: number;
  rankBySpending?: number;
  displayName?: string;
}

interface AgencySpendingRow {
  name: string;
  code?: string;
  slug: string;
  contracts?: number;
  grants?: number;
}

interface AgencyTrendRow {
  code?: string;
  abbr?: string;
  name?: string;
  years: Record<string, number>;
}
type AgencyTrends = Record<string, AgencyTrendRow>;

interface AgencyContractor {
  name: string;
  amount: number;
}
type AgencyContractors = Record<string, AgencyContractor[]>;

interface TopContractor {
  name: string;
  amount: number;
  recipientId?: string;
  uei?: string;
}

interface DedupedContractor {
  name: string;
  amount: number;
  subsidiaries?: number;
  pctOfAllContracts?: number;
  costPerTaxpayer?: number;
  category?: string;
}

interface ContractorTrend {
  name: string;
  years: Record<string, number>;
}

interface Award {
  awardId: string;
  recipient: string;
  amount: number;
  agency: string;
  description?: string;
  startDate?: string;
}

interface NoBidDataset {
  contracts: Award[];
  total?: number;
  count?: number;
  byRecipient?: { name: string; total: number; count: number }[];
  byAgency?: { name: string; total: number; count: number }[];
}

interface Industry {
  code: string;
  name: string;
  slug?: string;
  amount?: number;
  totalSpending?: number;
  rank?: number;
  pctOfTotal?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function fetchJson<T>(name: string): Promise<T> {
  const url = `${BASE}/${name}`;
  let resp: Response;
  try {
    resp = await fetch(url);
  } catch (err) {
    throw new Error(`Network error fetching ${url}: ${err instanceof Error ? err.message : err}`);
  }
  if (!resp.ok) {
    throw new Error(`Fetch ${url} failed: ${resp.status} ${resp.statusText}`);
  }
  return (await resp.json()) as T;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

// Normalize a contractor name for matching across files (uppercase, strip
// trailing punctuation, collapse whitespace).
function normName(s: string): string {
  return s.toUpperCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

// Convert {2021: 12345, 2022: 67890} into [{year, amount}] sorted by year.
function yearsObjToArray(obj: Record<string, number> | undefined): { year: number; amount: number }[] {
  if (!obj) return [];
  return Object.entries(obj)
    .map(([y, v]) => ({ year: Number(y), amount: Number(v) }))
    .filter((r) => Number.isFinite(r.year) && Number.isFinite(r.amount))
    .sort((a, b) => a.year - b.year);
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/sync-openspending.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log('[openspending-sync] starting');

  try {
    console.log('[openspending-sync] fetching all source files');
    const [
      agencies,
      agencySpending,
      agencyTrends,
      agencyContractors,
      topContractors,
      dedupedContractors,
      contractorTrends,
      topAwards,
      noBid,
      industries,
    ] = await Promise.all([
      fetchJson<Agency[]>('agencies.json'),
      fetchJson<AgencySpendingRow[]>('agency-spending.json'),
      fetchJson<AgencyTrends>('agency-trends.json'),
      fetchJson<AgencyContractors>('agency-contractors.json'),
      fetchJson<TopContractor[]>('top-contractors.json'),
      fetchJson<DedupedContractor[]>('top-contractors-deduped.json'),
      fetchJson<ContractorTrend[]>('contractor-trends.json'),
      fetchJson<Award[]>('top-awards.json'),
      fetchJson<NoBidDataset>('no-bid-contracts.json'),
      fetchJson<Industry[]>('industry-details.json'),
    ]);

    // ── 1. Agencies ──────────────────────────────────────────────────────
    // Build lookup maps for joining.
    const spendingBySlug = new Map(agencySpending.map((r) => [r.slug, r]));
    // agency-trends.json is keyed by abbreviation (HHS, DOD, etc.) not slug -
    // build a slug-based lookup by matching on the row's name field when present.
    const trendBySlug = new Map<string, AgencyTrendRow>();
    for (const [, row] of Object.entries(agencyTrends)) {
      const slug = row.name ? slugify(row.name) : null;
      if (slug) trendBySlug.set(slug, row);
    }
    // Also try matching on abbreviation against agencies' abbreviation.
    const trendByAbbr = new Map<string, AgencyTrendRow>();
    for (const [key, row] of Object.entries(agencyTrends)) {
      trendByAbbr.set(key.toUpperCase(), row);
      if (row.abbr) trendByAbbr.set(row.abbr.toUpperCase(), row);
    }

    let agencyCount = 0;
    for (const a of agencies) {
      if (!a?.slug || !a?.name) continue;
      const sp = spendingBySlug.get(a.slug);
      const trend =
        trendBySlug.get(a.slug) ??
        (a.abbreviation ? trendByAbbr.get(a.abbreviation.toUpperCase()) : undefined);
      const topC = (agencyContractors[a.slug] ?? [])
        .filter((c) => c?.name)
        .slice(0, 10);
      const yearlyBudget = yearsObjToArray(trend?.years);

      try {
        await prisma.federalAgency.upsert({
          where: { slug: a.slug },
          update: {
            name: a.name,
            abbreviation: a.abbreviation ?? null,
            code: a.code ?? null,
            displayName: a.displayName ?? null,
            budgetAuthority: a.budgetAuthority ?? null,
            obligated: a.obligated ?? null,
            outlays: a.outlays ?? null,
            pctOfTotal: a.pctOfTotal ?? null,
            pctOfBudget: a.pctOfBudget ?? null,
            pctContracts: a.pctContracts ?? null,
            costPerAmerican: a.costPerAmerican ?? null,
            rankBySpending: a.rankBySpending ?? null,
            contractsTotal: sp?.contracts ?? null,
            grantsTotal: sp?.grants ?? null,
            yearlyBudget: yearlyBudget as object,
            topContractors: topC as object,
            lastSyncedAt: new Date(),
          },
          create: {
            slug: a.slug,
            name: a.name,
            abbreviation: a.abbreviation ?? null,
            code: a.code ?? null,
            displayName: a.displayName ?? null,
            budgetAuthority: a.budgetAuthority ?? null,
            obligated: a.obligated ?? null,
            outlays: a.outlays ?? null,
            pctOfTotal: a.pctOfTotal ?? null,
            pctOfBudget: a.pctOfBudget ?? null,
            pctContracts: a.pctContracts ?? null,
            costPerAmerican: a.costPerAmerican ?? null,
            rankBySpending: a.rankBySpending ?? null,
            contractsTotal: sp?.contracts ?? null,
            grantsTotal: sp?.grants ?? null,
            yearlyBudget: yearlyBudget as object,
            topContractors: topC as object,
          },
        });
        agencyCount++;
      } catch (err) {
        console.warn(`[openspending-sync] skip agency ${a.slug}:`, (err as Error).message);
      }
    }
    console.log(`[openspending-sync] upserted ${agencyCount} agencies`);

    // ── 2. Contractors ───────────────────────────────────────────────────
    // Build a name → UEI / recipientId map from top-contractors.json.
    const topMeta = new Map<string, TopContractor>();
    for (const c of topContractors) topMeta.set(normName(c.name), c);

    // Build a name → yearly trends map.
    const trendMap = new Map<string, ContractorTrend>();
    for (const t of contractorTrends) trendMap.set(normName(t.name), t);

    // Build name → list of agencies awarding them money (from agency-contractors).
    const agencyAwardsByContractor = new Map<
      string,
      { slug: string; name: string; amount: number }[]
    >();
    const agencyMetaBySlug = new Map(agencies.map((a) => [a.slug, a]));
    for (const [agencySlug, list] of Object.entries(agencyContractors)) {
      const agencyMeta = agencyMetaBySlug.get(agencySlug);
      const agencyName = agencyMeta?.displayName ?? agencyMeta?.name ?? agencySlug;
      for (const item of list) {
        const key = normName(item.name);
        const arr = agencyAwardsByContractor.get(key) ?? [];
        arr.push({ slug: agencySlug, name: agencyName, amount: item.amount });
        agencyAwardsByContractor.set(key, arr);
      }
    }

    // Build name → top awards list.
    const awardsByRecipient = new Map<string, Award[]>();
    for (const a of topAwards) {
      const key = normName(a.recipient);
      const arr = awardsByRecipient.get(key) ?? [];
      arr.push(a);
      awardsByRecipient.set(key, arr);
    }

    // Build name → no-bid awards list + no-bid total.
    const noBidByRecipient = new Map<string, Award[]>();
    for (const c of noBid.contracts ?? []) {
      const key = normName(c.recipient);
      const arr = noBidByRecipient.get(key) ?? [];
      arr.push(c);
      noBidByRecipient.set(key, arr);
    }
    const noBidTotalByRecipient = new Map<string, number>();
    for (const r of noBid.byRecipient ?? []) {
      noBidTotalByRecipient.set(normName(r.name), r.total);
    }

    // Iterate the deduped list (parent companies, the source of truth) and
    // back-fill UEI/recipientId via the top-contractors map when names match.
    let contractorCount = 0;
    for (let i = 0; i < dedupedContractors.length; i++) {
      const c = dedupedContractors[i];
      if (!c?.name) continue;
      const key = normName(c.name);
      const meta = topMeta.get(key);
      const trend = trendMap.get(key);
      const yearlySpend = yearsObjToArray(trend?.years);
      const awardingAgencies = (agencyAwardsByContractor.get(key) ?? [])
        .filter((a) => a?.name)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 8);
      const recipientAwards = (awardsByRecipient.get(key) ?? [])
        .filter((a) => a?.awardId)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5);
      const recipientNoBid = (noBidByRecipient.get(key) ?? [])
        .filter((a) => a?.awardId)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5);
      const noBidTotal = noBidTotalByRecipient.get(key) ?? null;

      try {
        await prisma.federalContractor.upsert({
          where: { name: c.name },
          update: {
            slug: slugify(c.name),
            uei: meta?.uei ?? null,
            recipientId: meta?.recipientId ?? null,
            totalContracts: c.amount ?? null,
            pctOfAllContracts: c.pctOfAllContracts ?? null,
            costPerTaxpayer: c.costPerTaxpayer ?? null,
            category: c.category ?? null,
            subsidiaries: c.subsidiaries ?? null,
            yearlySpend: yearlySpend as object,
            topAgencies: awardingAgencies as object,
            topAwards: recipientAwards as object,
            noBidAwards: recipientNoBid as object,
            noBidTotal,
            rankByContracts: i + 1,
            lastSyncedAt: new Date(),
            raw: c as object,
          },
          create: {
            id: randomUUID(),
            name: c.name,
            slug: slugify(c.name),
            uei: meta?.uei ?? null,
            recipientId: meta?.recipientId ?? null,
            totalContracts: c.amount ?? null,
            pctOfAllContracts: c.pctOfAllContracts ?? null,
            costPerTaxpayer: c.costPerTaxpayer ?? null,
            category: c.category ?? null,
            subsidiaries: c.subsidiaries ?? null,
            yearlySpend: yearlySpend as object,
            topAgencies: awardingAgencies as object,
            topAwards: recipientAwards as object,
            noBidAwards: recipientNoBid as object,
            noBidTotal,
            rankByContracts: i + 1,
            raw: c as object,
          },
        });
        contractorCount++;
      } catch (err) {
        console.warn(`[openspending-sync] skip contractor ${c.name}:`, (err as Error).message);
      }
    }

    // Also upsert any top-contractors that are NOT in the deduped list (smaller
    // non-parent entities), preserves UEIs and ranks for fuzzy matching later.
    for (let i = 0; i < topContractors.length; i++) {
      const c = topContractors[i];
      if (!c?.name) continue;
      const key = normName(c.name);
      // Skip if a deduped parent already covers this exact name.
      if (dedupedContractors.some((d) => d?.name && normName(d.name) === key)) continue;
      const trend = trendMap.get(key);
      const yearlySpend = yearsObjToArray(trend?.years);
      const awardingAgencies = (agencyAwardsByContractor.get(key) ?? [])
        .filter((a) => a?.name)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 8);
      const recipientAwards = (awardsByRecipient.get(key) ?? [])
        .filter((a) => a?.awardId)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5);
      const recipientNoBid = (noBidByRecipient.get(key) ?? [])
        .filter((a) => a?.awardId)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5);
      const noBidTotal = noBidTotalByRecipient.get(key) ?? null;
      try {
        await prisma.federalContractor.upsert({
          where: { name: c.name },
          update: {
            slug: slugify(c.name),
            uei: c.uei ?? null,
            recipientId: c.recipientId ?? null,
            totalContracts: c.amount ?? null,
            yearlySpend: yearlySpend as object,
            topAgencies: awardingAgencies as object,
            topAwards: recipientAwards as object,
            noBidAwards: recipientNoBid as object,
            noBidTotal,
            lastSyncedAt: new Date(),
            raw: c as object,
          },
          create: {
            id: randomUUID(),
            name: c.name,
            slug: slugify(c.name),
            uei: c.uei ?? null,
            recipientId: c.recipientId ?? null,
            totalContracts: c.amount ?? null,
            yearlySpend: yearlySpend as object,
            topAgencies: awardingAgencies as object,
            topAwards: recipientAwards as object,
            noBidAwards: recipientNoBid as object,
            noBidTotal,
            raw: c as object,
          },
        });
        contractorCount++;
      } catch (err) {
        console.warn(`[openspending-sync] skip contractor ${c.name}:`, (err as Error).message);
      }
    }
    console.log(`[openspending-sync] upserted ${contractorCount} contractors`);

    // ── 3. Industries ────────────────────────────────────────────────────
    let industryCount = 0;
    for (const ind of industries) {
      if (!ind?.code || !ind?.name) continue;
      const amt = ind.totalSpending ?? ind.amount ?? null;
      try {
        await prisma.federalIndustry.upsert({
          where: { code: ind.code },
          update: {
            name: ind.name,
            slug: ind.slug ?? slugify(`${ind.code}-${ind.name}`),
            totalSpending: amt,
            rank: ind.rank ?? null,
            pctOfTotal: ind.pctOfTotal ?? null,
            lastSyncedAt: new Date(),
          },
          create: {
            code: ind.code,
            name: ind.name,
            slug: ind.slug ?? slugify(`${ind.code}-${ind.name}`),
            totalSpending: amt,
            rank: ind.rank ?? null,
            pctOfTotal: ind.pctOfTotal ?? null,
          },
        });
        industryCount++;
      } catch (err) {
        console.warn(`[openspending-sync] skip industry ${ind.code}:`, (err as Error).message);
      }
    }
    console.log(`[openspending-sync] upserted ${industryCount} industries`);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[openspending-sync] DONE in ${elapsed}s`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
main().catch((err) => {
  console.error('[openspending-sync] FAILED', err);
  process.exit(1);
});
}
