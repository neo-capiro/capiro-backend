import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface FederalContractorSummary {
  id: string;
  name: string;
  slug: string | null;
  uei: string | null;
  totalContracts: number | null;
  pctOfAllContracts: number | null;
  costPerTaxpayer: number | null;
  category: string | null;
  subsidiaries: number | null;
  rankByContracts: number | null;
  yearlySpend: { year: number; amount: number }[];
  topAgencies: { slug?: string; name: string; amount: number }[];
  topAwards: {
    awardId: string;
    recipient: string;
    amount: number;
    agency: string;
    description?: string;
    startDate?: string;
  }[];
  noBidAwards: {
    awardId: string;
    recipient: string;
    amount: number;
    agency: string;
    description?: string;
  }[];
  noBidTotal: number | null;
}

export interface FederalAgencySummary {
  slug: string;
  name: string;
  abbreviation: string | null;
  displayName: string | null;
  budgetAuthority: number | null;
  obligated: number | null;
  outlays: number | null;
  pctOfTotal: number | null;
  pctContracts: number | null;
  costPerAmerican: number | null;
  rankBySpending: number | null;
  contractsTotal: number | null;
  grantsTotal: number | null;
  yearlyBudget: { year: number; amount: number }[];
  topContractors: { name: string; amount: number }[];
}

export interface FederalIndustrySummary {
  code: string;
  name: string;
  slug: string | null;
  totalSpending: number | null;
  rank: number | null;
  pctOfTotal: number | null;
}

export interface FederalSpendingOverview {
  totalContractors: number;
  totalAgencies: number;
  totalIndustries: number;
  topContractors: FederalContractorSummary[];
  topAgencies: FederalAgencySummary[];
  topIndustries: FederalIndustrySummary[];
  topNoBidContractors: { name: string; total: number; count: number }[];
  lastSyncedAt: Date | null;
}

const decToNumber = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * Service exposing federal spending intelligence (OpenSpending / USASpending).
 *
 * Tables are GLOBAL (no tenant_id, no RLS), same dataset for every tenant.
 * Read-only from the API; populated by `pnpm sync:openspending`.
 */
@Injectable()
export class FederalSpendingService {
  private readonly logger = new Logger(FederalSpendingService.name);

  constructor(private readonly prisma: PrismaService) {}

  private toContractor(row: {
    id: string;
    name: string;
    slug: string | null;
    uei: string | null;
    totalContracts: unknown;
    pctOfAllContracts: number | null;
    costPerTaxpayer: number | null;
    category: string | null;
    subsidiaries: number | null;
    rankByContracts: number | null;
    yearlySpend: unknown;
    topAgencies: unknown;
    topAwards: unknown;
    noBidAwards: unknown;
    noBidTotal: unknown;
  }): FederalContractorSummary {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      uei: row.uei,
      totalContracts: decToNumber(row.totalContracts),
      pctOfAllContracts: row.pctOfAllContracts,
      costPerTaxpayer: row.costPerTaxpayer,
      category: row.category,
      subsidiaries: row.subsidiaries,
      rankByContracts: row.rankByContracts,
      yearlySpend: Array.isArray(row.yearlySpend)
        ? (row.yearlySpend as { year: number; amount: number }[])
        : [],
      topAgencies: Array.isArray(row.topAgencies)
        ? (row.topAgencies as { slug?: string; name: string; amount: number }[])
        : [],
      topAwards: Array.isArray(row.topAwards)
        ? (row.topAwards as FederalContractorSummary['topAwards'])
        : [],
      noBidAwards: Array.isArray(row.noBidAwards)
        ? (row.noBidAwards as FederalContractorSummary['noBidAwards'])
        : [],
      noBidTotal: decToNumber(row.noBidTotal),
    };
  }

  private toAgency(row: {
    slug: string;
    name: string;
    abbreviation: string | null;
    displayName: string | null;
    budgetAuthority: unknown;
    obligated: unknown;
    outlays: unknown;
    pctOfTotal: number | null;
    pctContracts: number | null;
    costPerAmerican: number | null;
    rankBySpending: number | null;
    contractsTotal: unknown;
    grantsTotal: unknown;
    yearlyBudget: unknown;
    topContractors: unknown;
  }): FederalAgencySummary {
    return {
      slug: row.slug,
      name: row.name,
      abbreviation: row.abbreviation,
      displayName: row.displayName,
      budgetAuthority: decToNumber(row.budgetAuthority),
      obligated: decToNumber(row.obligated),
      outlays: decToNumber(row.outlays),
      pctOfTotal: row.pctOfTotal,
      pctContracts: row.pctContracts,
      costPerAmerican: row.costPerAmerican,
      rankBySpending: row.rankBySpending,
      contractsTotal: decToNumber(row.contractsTotal),
      grantsTotal: decToNumber(row.grantsTotal),
      yearlyBudget: Array.isArray(row.yearlyBudget)
        ? (row.yearlyBudget as { year: number; amount: number }[])
        : [],
      topContractors: Array.isArray(row.topContractors)
        ? (row.topContractors as { name: string; amount: number }[])
        : [],
    };
  }

  private toIndustry(row: {
    code: string;
    name: string;
    slug: string | null;
    totalSpending: unknown;
    rank: number | null;
    pctOfTotal: number | null;
  }): FederalIndustrySummary {
    return {
      code: row.code,
      name: row.name,
      slug: row.slug,
      totalSpending: decToNumber(row.totalSpending),
      rank: row.rank,
      pctOfTotal: row.pctOfTotal,
    };
  }

  async overview(): Promise<FederalSpendingOverview> {
    const [
      topContractors,
      topAgencies,
      topIndustries,
      totalContractors,
      totalAgencies,
      totalIndustries,
    ] = await Promise.all([
      this.prisma.federalContractor.findMany({
        orderBy: { totalContracts: 'desc' },
        take: 20,
      }),
      this.prisma.federalAgency.findMany({
        orderBy: { budgetAuthority: 'desc' },
        take: 15,
      }),
      this.prisma.federalIndustry.findMany({
        orderBy: { totalSpending: 'desc' },
        take: 15,
      }),
      this.prisma.federalContractor.count(),
      this.prisma.federalAgency.count(),
      this.prisma.federalIndustry.count(),
    ]);

    // Pull no-bid leaderboard from the raw aggregates on the top contractors.
    const topNoBidContractors = topContractors
      .filter((c) => c.noBidTotal != null && Number(c.noBidTotal) > 0)
      .sort((a, b) => Number(b.noBidTotal) - Number(a.noBidTotal))
      .slice(0, 10)
      .map((c) => ({
        name: c.name,
        total: Number(c.noBidTotal),
        count: Array.isArray(c.noBidAwards) ? (c.noBidAwards as unknown[]).length : 0,
      }));

    const lastSyncedAt = topContractors[0]?.lastSyncedAt ?? topAgencies[0]?.lastSyncedAt ?? null;

    return {
      totalContractors,
      totalAgencies,
      totalIndustries,
      topContractors: topContractors.map((r) => this.toContractor(r)),
      topAgencies: topAgencies.map((r) => this.toAgency(r)),
      topIndustries: topIndustries.map((r) => this.toIndustry(r)),
      topNoBidContractors,
      lastSyncedAt,
    };
  }

  async listAgencies(): Promise<FederalAgencySummary[]> {
    const rows = await this.prisma.federalAgency.findMany({
      orderBy: { budgetAuthority: 'desc' },
    });
    return rows.map((r) => this.toAgency(r));
  }

  async getAgency(slug: string): Promise<FederalAgencySummary | null> {
    const row = await this.prisma.federalAgency.findUnique({ where: { slug } });
    return row ? this.toAgency(row) : null;
  }

  async listContractors(limit = 50): Promise<FederalContractorSummary[]> {
    const rows = await this.prisma.federalContractor.findMany({
      orderBy: { totalContracts: 'desc' },
      take: Math.max(1, Math.min(limit, 100)),
    });
    return rows.map((r) => this.toContractor(r));
  }

  async searchContractors(q: string, limit = 25): Promise<FederalContractorSummary[]> {
    const term = q.trim();
    if (!term) return [];
    const rows = await this.prisma.federalContractor.findMany({
      where: { name: { contains: term, mode: 'insensitive' } },
      orderBy: { totalContracts: 'desc' },
      take: Math.max(1, Math.min(limit, 100)),
    });
    return rows.map((r) => this.toContractor(r));
  }

  async getContractor(slug: string): Promise<FederalContractorSummary | null> {
    const row = await this.prisma.federalContractor.findFirst({ where: { slug } });
    return row ? this.toContractor(row) : null;
  }

  async listIndustries(): Promise<FederalIndustrySummary[]> {
    const rows = await this.prisma.federalIndustry.findMany({
      orderBy: { totalSpending: 'desc' },
    });
    return rows.map((r) => this.toIndustry(r));
  }

  /**
   * Look up a federal contractor by Capiro client name (exact case-insensitive,
   * then pg_trgm fuzzy). Mirrors the LobbyIntelService.lookupByClientName pattern.
   */
  async lookupByClientName(clientName: string): Promise<FederalContractorSummary | null> {
    const name = clientName.trim();
    if (!name) return null;

    const exact = await this.prisma.federalContractor.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (exact) return this.toContractor(exact);

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        slug: string | null;
        uei: string | null;
        total_contracts: string | null;
        pct_of_all_contracts: number | null;
        cost_per_taxpayer: number | null;
        category: string | null;
        subsidiaries: number | null;
        rank_by_contracts: number | null;
        yearly_spend_jsonb: unknown;
        top_agencies_jsonb: unknown;
        top_awards_jsonb: unknown;
        no_bid_awards_jsonb: unknown;
        no_bid_total: string | null;
        sim: number;
      }>
    >`
      SELECT id, name, slug, uei, total_contracts, pct_of_all_contracts,
             cost_per_taxpayer, category, subsidiaries, rank_by_contracts,
             yearly_spend_jsonb, top_agencies_jsonb, top_awards_jsonb,
             no_bid_awards_jsonb, no_bid_total,
             similarity(name, ${name}) AS sim
      FROM federal_contractor
      WHERE name % ${name}
      ORDER BY sim DESC
      LIMIT 1
    `;

    if (!rows.length) return null;
    const r = rows[0];
    if (!r || r.sim < 0.4) return null;

    return this.toContractor({
      id: r.id,
      name: r.name,
      slug: r.slug,
      uei: r.uei,
      totalContracts: r.total_contracts,
      pctOfAllContracts: r.pct_of_all_contracts,
      costPerTaxpayer: r.cost_per_taxpayer,
      category: r.category,
      subsidiaries: r.subsidiaries,
      rankByContracts: r.rank_by_contracts,
      yearlySpend: r.yearly_spend_jsonb,
      topAgencies: r.top_agencies_jsonb,
      topAwards: r.top_awards_jsonb,
      noBidAwards: r.no_bid_awards_jsonb,
      noBidTotal: r.no_bid_total,
    });
  }

  /**
   * Compact federal-spending context for AI doc-gen.
   * Returns the matched contractor's headline numbers if any, plus the
   * highest-budget agencies overall.
   */
  async getAiContext(clientName: string | null): Promise<{
    matchedContractor: {
      name: string;
      totalContracts: number | null;
      rankByContracts: number | null;
      category: string | null;
      topAgencies: { name: string; amount: number }[];
    } | null;
    topAgencyTotals: { name: string; budget: number | null }[];
  }> {
    const matched = clientName ? await this.lookupByClientName(clientName) : null;
    const topAgencies = await this.prisma.federalAgency.findMany({
      orderBy: { budgetAuthority: 'desc' },
      take: 5,
      select: { name: true, abbreviation: true, budgetAuthority: true },
    });
    return {
      matchedContractor: matched
        ? {
            name: matched.name,
            totalContracts: matched.totalContracts,
            rankByContracts: matched.rankByContracts,
            category: matched.category,
            topAgencies: matched.topAgencies.slice(0, 4).map((a) => ({
              name: a.name,
              amount: a.amount,
            })),
          }
        : null,
      topAgencyTotals: topAgencies.map((a) => ({
        name: a.abbreviation ?? a.name,
        budget: a.budgetAuthority == null ? null : Number(a.budgetAuthority),
      })),
    };
  }
}
