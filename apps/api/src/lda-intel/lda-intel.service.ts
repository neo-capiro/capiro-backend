import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

// ─── Public interfaces ────────────────────────────────────────────────────────

export interface LdaDashboard {
  totalFilings: number;
  totalClients: number;
  totalRegistrants: number;
  totalLobbyists: number;
  totalIssueCodes: number;
  topIssueCodes: {
    code: string;
    name: string;
    totalFilings5y: number;
    totalSpending5y: number | null;
  }[];
  topClients: { id: number; name: string; totalFilings: number; totalSpending: number | null }[];
  topRegistrants: { id: number; name: string; totalFilings: number; totalClients: number }[];
  recentFilings: {
    filingUuid: string;
    filingYear: number;
    clientName: string;
    registrantName: string;
    income: number | null;
    issueCodes: string[];
  }[];
}

export interface FilingFilters {
  year?: number;
  issueCode?: string;
  clientName?: string;
  registrantName?: string;
  page?: number;
  limit?: number;
}

export interface ContributionFilters {
  year?: number;
  registrantName?: string;
  lobbyistName?: string;
  page?: number;
  limit?: number;
}

export interface PagedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Business logic for the Senate LDA lobbying intelligence dataset.
 * Tables are GLOBAL (no tenant_id). Read-only from the API.
 */
@Injectable()
export class LdaIntelService {
  private readonly logger = new Logger(LdaIntelService.name);

  constructor(private readonly prisma: PrismaService) {}

  private toNum(v: unknown): number | null {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────

  async getDashboard(): Promise<LdaDashboard> {
    const [
      totalFilings,
      totalClients,
      totalRegistrants,
      totalLobbyists,
      topIssueCodes,
      topClients,
      topRegistrants,
      recentFilings,
    ] = await Promise.all([
      this.prisma.ldaFiling.count(),
      this.prisma.ldaClient.count(),
      this.prisma.ldaRegistrant.count(),
      this.prisma.ldaLobbyist.count(),
      this.prisma.ldaIssueCode.findMany({
        orderBy: { totalFilings5y: 'desc' },
        take: 12,
      }),
      this.prisma.ldaClient.findMany({
        orderBy: { totalFilings: 'desc' },
        take: 10,
        select: { id: true, name: true, totalFilings: true, totalSpending: true },
      }),
      this.prisma.ldaRegistrant.findMany({
        orderBy: { totalFilings: 'desc' },
        take: 10,
        select: { id: true, name: true, totalFilings: true, totalClients: true },
      }),
      this.prisma.ldaFiling.findMany({
        orderBy: { dtPosted: 'desc' },
        take: 20,
        select: {
          filingUuid: true,
          filingYear: true,
          clientName: true,
          registrantName: true,
          income: true,
          issueCodes: true,
        },
      }),
    ]);

    return {
      totalFilings,
      totalClients,
      totalRegistrants,
      totalLobbyists,
      totalIssueCodes: topIssueCodes.length,
      topIssueCodes: topIssueCodes.map((ic) => ({
        code: ic.code,
        name: ic.name,
        totalFilings5y: ic.totalFilings5y,
        totalSpending5y: this.toNum(ic.totalSpending5y),
      })),
      topClients: topClients.map((c) => ({
        id: c.id,
        name: c.name,
        totalFilings: c.totalFilings,
        totalSpending: this.toNum(c.totalSpending),
      })),
      topRegistrants: topRegistrants.map((r) => ({
        id: r.id,
        name: r.name,
        totalFilings: r.totalFilings,
        totalClients: r.totalClients,
      })),
      recentFilings: recentFilings.map((f) => ({
        filingUuid: f.filingUuid,
        filingYear: f.filingYear,
        clientName: f.clientName,
        registrantName: f.registrantName,
        income: this.toNum(f.income),
        issueCodes: f.issueCodes ?? [],
      })),
    };
  }

  // ── Filings ────────────────────────────────────────────────────────────────

  async getFilings(filters: FilingFilters): Promise<PagedResult<object>> {
    const page = Math.max(1, filters.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (filters.year) where.filingYear = filters.year;
    if (filters.issueCode) where.issueCodes = { has: filters.issueCode };
    if (filters.clientName)
      where.clientName = { contains: filters.clientName, mode: 'insensitive' };
    if (filters.registrantName)
      where.registrantName = { contains: filters.registrantName, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      this.prisma.ldaFiling.findMany({
        where,
        orderBy: { dtPosted: 'desc' },
        skip,
        take: limit,
        select: {
          filingUuid: true,
          filingType: true,
          filingYear: true,
          filingPeriod: true,
          income: true,
          expenses: true,
          dtPosted: true,
          registrantId: true,
          registrantName: true,
          clientId: true,
          clientName: true,
          clientState: true,
          issueCodes: true,
        },
      }),
      this.prisma.ldaFiling.count({ where }),
    ]);

    return {
      data: data.map((f) => ({
        ...f,
        income: this.toNum(f.income),
        expenses: this.toNum(f.expenses),
      })),
      total,
      page,
      limit,
    };
  }

  async getFilingByUuid(uuid: string): Promise<object> {
    const f = await this.prisma.ldaFiling.findUnique({ where: { filingUuid: uuid } });
    if (!f) throw new NotFoundException(`Filing ${uuid} not found`);
    return { ...f, income: this.toNum(f.income), expenses: this.toNum(f.expenses) };
  }

  // ── Clients ────────────────────────────────────────────────────────────────

  async getClients(
    search?: string,
    issueCode?: string,
    state?: string,
    page = 1,
    limit = 25,
  ): Promise<PagedResult<object>> {
    const pg = Math.max(1, page);
    const lim = Math.min(100, Math.max(1, limit));
    const skip = (pg - 1) * lim;

    const where: Record<string, unknown> = {};
    if (search) where.name = { contains: search, mode: 'insensitive' };
    if (issueCode) where.issueCodes = { has: issueCode };
    if (state) where.state = state;

    const [data, total] = await Promise.all([
      this.prisma.ldaClient.findMany({
        where,
        orderBy: { totalFilings: 'desc' },
        skip,
        take: lim,
      }),
      this.prisma.ldaClient.count({ where }),
    ]);

    return {
      data: data.map((c) => ({ ...c, totalSpending: this.toNum(c.totalSpending) })),
      total,
      page: pg,
      limit: lim,
    };
  }

  async getClientDetail(id: number): Promise<object> {
    const client = await this.prisma.ldaClient.findUnique({ where: { id } });
    if (!client) throw new NotFoundException(`LDA client ${id} not found`);

    const recentFilings = await this.prisma.ldaFiling.findMany({
      where: { clientId: id },
      orderBy: { dtPosted: 'desc' },
      take: 10,
      select: {
        filingUuid: true,
        filingType: true,
        filingYear: true,
        filingPeriod: true,
        income: true,
        expenses: true,
        dtPosted: true,
        registrantId: true,
        registrantName: true,
        issueCodes: true,
      },
    });

    return {
      ...client,
      totalSpending: this.toNum(client.totalSpending),
      recentFilings: recentFilings.map((f) => ({
        ...f,
        income: this.toNum(f.income),
        expenses: this.toNum(f.expenses),
      })),
    };
  }

  async getClientFilings(clientId: number, page = 1, limit = 25): Promise<PagedResult<object>> {
    const pg = Math.max(1, page);
    const lim = Math.min(100, Math.max(1, limit));
    const skip = (pg - 1) * lim;

    const [data, total] = await Promise.all([
      this.prisma.ldaFiling.findMany({
        where: { clientId },
        orderBy: { dtPosted: 'desc' },
        skip,
        take: lim,
      }),
      this.prisma.ldaFiling.count({ where: { clientId } }),
    ]);

    return {
      data: data.map((f) => ({
        ...f,
        income: this.toNum(f.income),
        expenses: this.toNum(f.expenses),
      })),
      total,
      page: pg,
      limit: lim,
    };
  }

  // ── Registrants ────────────────────────────────────────────────────────────

  async getRegistrants(search?: string, page = 1, limit = 25): Promise<PagedResult<object>> {
    const pg = Math.max(1, page);
    const lim = Math.min(100, Math.max(1, limit));
    const skip = (pg - 1) * lim;

    const where: Record<string, unknown> = {};
    if (search) where.name = { contains: search, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      this.prisma.ldaRegistrant.findMany({
        where,
        orderBy: { totalFilings: 'desc' },
        skip,
        take: lim,
      }),
      this.prisma.ldaRegistrant.count({ where }),
    ]);

    return { data, total, page: pg, limit: lim };
  }

  async getRegistrantById(id: number): Promise<object> {
    const r = await this.prisma.ldaRegistrant.findUnique({ where: { id } });
    if (!r) throw new NotFoundException(`LDA registrant ${id} not found`);

    const topClients = await this.prisma.ldaFiling.groupBy({
      by: ['clientId', 'clientName'],
      where: { registrantId: id, clientId: { not: null } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
    });

    return {
      ...r,
      topClients: topClients.map((c) => ({
        clientId: c.clientId,
        clientName: c.clientName,
        filingCount: c._count.id,
      })),
    };
  }

  // ── Lobbyists ──────────────────────────────────────────────────────────────

  async getLobbyists(search?: string, page = 1, limit = 25): Promise<PagedResult<object>> {
    const pg = Math.max(1, page);
    const lim = Math.min(100, Math.max(1, limit));
    const skip = (pg - 1) * lim;

    const where: Record<string, unknown> = {};
    if (search) where.lastName = { contains: search, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      this.prisma.ldaLobbyist.findMany({
        where,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        skip,
        take: lim,
      }),
      this.prisma.ldaLobbyist.count({ where }),
    ]);

    return { data, total, page: pg, limit: lim };
  }

  async getLobbyistById(id: number): Promise<object> {
    const l = await this.prisma.ldaLobbyist.findUnique({ where: { id } });
    if (!l) throw new NotFoundException(`LDA lobbyist ${id} not found`);
    return l;
  }

  // ── Issue codes ────────────────────────────────────────────────────────────

  async getIssues(): Promise<object[]> {
    const rows = await this.prisma.ldaIssueCode.findMany({
      orderBy: { totalSpending5y: 'desc' },
    });
    return rows.map((r) => ({
      ...r,
      totalSpending5y: this.toNum(r.totalSpending5y),
    }));
  }

  async getIssueDetail(code: string): Promise<object> {
    const issue = await this.prisma.ldaIssueCode.findUnique({ where: { code } });
    if (!issue) throw new NotFoundException(`Issue code ${code} not found`);

    const topClients = await this.prisma.ldaClient.findMany({
      where: { issueCodes: { has: code } },
      orderBy: { totalSpending: 'desc' },
      take: 20,
      select: { id: true, name: true, state: true, totalFilings: true, totalSpending: true },
    });

    return {
      ...issue,
      totalSpending5y: this.toNum(issue.totalSpending5y),
      topClients: topClients.map((c) => ({
        ...c,
        totalSpending: this.toNum(c.totalSpending),
      })),
    };
  }

  // ── Government entities ────────────────────────────────────────────────────

  async getEntities(): Promise<object[]> {
    return this.prisma.ldaGovernmentEntity.findMany({
      orderBy: { totalFilings5y: 'desc' },
    });
  }

  // ── Contributions ──────────────────────────────────────────────────────────

  async getContributions(filters: ContributionFilters): Promise<PagedResult<object>> {
    const pg = Math.max(1, filters.page ?? 1);
    const lim = Math.min(100, Math.max(1, filters.limit ?? 25));
    const skip = (pg - 1) * lim;

    const where: Record<string, unknown> = {};
    if (filters.year) where.filingYear = filters.year;
    if (filters.registrantName)
      where.registrantName = { contains: filters.registrantName, mode: 'insensitive' };
    if (filters.lobbyistName)
      where.lobbyistName = { contains: filters.lobbyistName, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      this.prisma.ldaContribution.findMany({
        where,
        orderBy: { dtPosted: 'desc' },
        skip,
        take: lim,
      }),
      this.prisma.ldaContribution.count({ where }),
    ]);

    return { data, total, page: pg, limit: lim };
  }

  // ── Trends ────────────────────────────────────────────────────────────────

  async getTrends(): Promise<object[]> {
    // Quarterly spending aggregation across all filings.
    const rows = await this.prisma.$queryRaw<
      {
        year: number;
        period: string;
        total_income: string | null;
        total_expenses: string | null;
        filing_count: bigint;
      }[]
    >`
      SELECT
        filing_year                        AS year,
        COALESCE(filing_period, 'unknown') AS period,
        SUM(income)                        AS total_income,
        SUM(expenses)                      AS total_expenses,
        COUNT(*)                           AS filing_count
      FROM lda_filing
      WHERE filing_year >= 2021
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC
    `;

    return rows.map((r) => ({
      year: r.year,
      period: r.period,
      totalIncome: r.total_income != null ? Number(r.total_income) : null,
      totalExpenses: r.total_expenses != null ? Number(r.total_expenses) : null,
      filingCount: Number(r.filing_count),
    }));
  }

  // ── Congress bills ─────────────────────────────────────────────────────────

  async getCongressBills(
    search?: string,
    policyArea?: string,
    congress?: number,
    page = 1,
    limit = 25,
    activeSince?: string,
  ): Promise<PagedResult<object>> {
    const pg = Math.max(1, page);
    const lim = Math.min(100, Math.max(1, limit));
    const skip = (pg - 1) * lim;

    const where: Record<string, unknown> = {};
    if (search) where.title = { contains: search, mode: 'insensitive' };
    if (policyArea) where.policyArea = { contains: policyArea, mode: 'insensitive' };
    if (congress) where.congress = congress;
    if (activeSince) where.latestActionDate = { gte: new Date(activeSince) };

    const [data, total] = await Promise.all([
      this.prisma.congressBill.findMany({
        where,
        orderBy: { updateDate: 'desc' },
        skip,
        take: lim,
      }),
      this.prisma.congressBill.count({ where }),
    ]);

    return { data, total, page: pg, limit: lim };
  }

  // ── FEC committees ─────────────────────────────────────────────────────────

  async getFecCommittees(search?: string, page = 1, limit = 25): Promise<PagedResult<object>> {
    const pg = Math.max(1, page);
    const lim = Math.min(100, Math.max(1, limit));
    const skip = (pg - 1) * lim;

    const where: Record<string, unknown> = {};
    if (search) where.name = { contains: search, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      this.prisma.fecCommittee.findMany({
        where,
        orderBy: { totalReceipts: 'desc' },
        skip,
        take: lim,
      }),
      this.prisma.fecCommittee.count({ where }),
    ]);

    return {
      data: data.map((c) => ({
        ...c,
        totalReceipts: this.toNum(c.totalReceipts),
        totalDisbursements: this.toNum(c.totalDisbursements),
        cashOnHand: this.toNum(c.cashOnHand),
      })),
      total,
      page: pg,
      limit: lim,
    };
  }

  // ── Lobbyist revolving-door positions ────────────────────────────────────

  async getLobbyistPositions(id: number): Promise<object> {
    const l = await this.prisma.ldaLobbyist.findUnique({ where: { id } });
    if (!l) throw new NotFoundException(`LDA lobbyist ${id} not found`);
    const positions = Array.isArray(l.coveredPositions) ? l.coveredPositions : [];
    return {
      id: l.id,
      firstName: l.firstName,
      lastName: l.lastName,
      coveredPositions: positions,
      hasGovernmentExperience: positions.length > 0,
    };
  }

  // ── Client network ────────────────────────────────────────────────────────

  async getClientNetwork(id: number): Promise<object> {
    const client = await this.prisma.ldaClient.findUnique({ where: { id } });
    if (!client) throw new NotFoundException(`LDA client ${id} not found`);

    const [filings, relatedByIssue] = await Promise.all([
      this.prisma.ldaFiling.findMany({
        where: { clientId: id },
        select: {
          registrantId: true,
          registrantName: true,
          issueCodes: true,
          governmentEntities: true,
          lobbyists: true,
        },
        orderBy: { dtPosted: 'desc' },
        take: 200,
      }),
      // Other clients sharing issue codes (approximate)
      client.issueCodes.length > 0
        ? this.prisma.ldaClient.findMany({
            where: {
              id: { not: id },
              issueCodes: { hasSome: client.issueCodes.slice(0, 5) },
            },
            orderBy: { totalFilings: 'desc' },
            take: 10,
            select: {
              id: true,
              name: true,
              state: true,
              totalFilings: true,
              totalSpending: true,
              issueCodes: true,
            },
          })
        : Promise.resolve([]),
    ]);

    // Aggregate firms and lobbyists from filings.
    const firmMap = new Map<number, { id: number; name: string; filingCount: number }>();
    const govTargetSet = new Set<string>();
    const issueSet = new Set<string>();

    for (const f of filings) {
      if (f.registrantId) {
        const existing = firmMap.get(f.registrantId);
        if (existing) {
          existing.filingCount++;
        } else {
          firmMap.set(f.registrantId, {
            id: f.registrantId,
            name: f.registrantName,
            filingCount: 1,
          });
        }
      }
      for (const code of f.issueCodes ?? []) issueSet.add(code);
      const entities = Array.isArray(f.governmentEntities)
        ? (f.governmentEntities as { name?: string }[])
        : [];
      for (const e of entities) if (e.name) govTargetSet.add(e.name);
    }

    // Unique lobbyist IDs from filings.
    const lobbyistIds = new Set<number>();
    for (const f of filings) {
      const lobs = Array.isArray(f.lobbyists) ? (f.lobbyists as { id?: number }[]) : [];
      for (const l of lobs) if (l.id) lobbyistIds.add(l.id);
    }

    const lobbyists =
      lobbyistIds.size > 0
        ? await this.prisma.ldaLobbyist.findMany({
            where: { id: { in: [...lobbyistIds].slice(0, 50) } },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              coveredPositions: true,
              activeYears: true,
            },
          })
        : [];

    return {
      client: {
        id: client.id,
        name: client.name,
        state: client.state,
        issueCodes: client.issueCodes,
      },
      firms: [...firmMap.values()].sort((a, b) => b.filingCount - a.filingCount),
      lobbyists: lobbyists.map((l) => ({
        id: l.id,
        firstName: l.firstName,
        lastName: l.lastName,
        hasGovernmentExperience:
          Array.isArray(l.coveredPositions) && (l.coveredPositions as unknown[]).length > 0,
        activeYears: l.activeYears,
      })),
      issues: [...issueSet],
      governmentTargets: [...govTargetSet].slice(0, 20),
      relatedClients: relatedByIssue.map((c) => ({
        id: c.id,
        name: c.name,
        state: c.state,
        totalFilings: c.totalFilings,
        totalSpending: this.toNum(c.totalSpending),
        sharedIssues: c.issueCodes.filter((code) => client.issueCodes.includes(code)),
      })),
    };
  }

  // ── Intelligence insights ─────────────────────────────────────────────────

  async getInsights(tenantId: string, category?: string, limit = 20): Promise<object[]> {
    const where: Record<string, unknown> = {};
    if (category) where.category = category;
    // GAI-01: tenant isolation is enforced IN-QUERY, not by RLS — the app role
    // (capiro_app) bypasses row-level security (member of the owner role), so the
    // FORCE RLS policy is defense-in-depth only. This filter returns this tenant's
    // rows + reviewed public (NULL-tenant) rows, never the former global feed.
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelligenceInsight.findMany({
        where: {
          ...where,
          AND: [
            { OR: [{ tenantId }, { tenantId: null }] },
            { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          ],
        },
        orderBy: { generatedAt: 'desc' },
        take: Math.min(50, limit),
      }),
    );
    return rows;
  }

  async createInsight(data: {
    tenantId: string;
    category: string;
    title: string;
    body: string;
    severity?: string;
    dataPoints?: object;
    expiresAt?: Date;
  }): Promise<object> {
    // GAI-01: tenant-scoped write (withTenant satisfies the FORCE RLS WITH CHECK).
    return this.prisma.withTenant(data.tenantId, (tx) =>
      tx.intelligenceInsight.create({
        data: {
          tenantId: data.tenantId,
          category: data.category,
          title: data.title,
          body: data.body,
          severity: data.severity ?? 'info',
          dataPoints: data.dataPoints ?? undefined,
          expiresAt: data.expiresAt ?? undefined,
        },
      }),
    );
  }

  // ── Congress bill detail (with actions/committees/subjects) ───────────────

  async getCongressBillDetail(id: string): Promise<object> {
    const bill = await this.prisma.congressBill.findUnique({
      where: { id },
      include: {
        actions: { orderBy: { date: 'desc' } },
        committeeRefs: true,
        subjectRefs: { orderBy: { name: 'asc' } },
      },
    });
    if (!bill) throw new NotFoundException(`Congress bill ${id} not found`);
    return bill;
  }

  // ── Fuzzy match Capiro client → LDA client ────────────────────────────────

  async matchCapiroClient(clientName: string): Promise<object | null> {
    const name = clientName.trim();
    if (!name) return null;

    // Exact match first.
    const exact = await this.prisma.ldaClient.findFirst({
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (exact) return { ...exact, totalSpending: this.toNum(exact.totalSpending), similarity: 1.0 };

    // Trigram similarity fallback (requires pg_trgm, already enabled).
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: number;
        name: string;
        state: string | null;
        total_filings: number;
        total_spending: string | null;
        issue_codes: string[];
        sim: number;
      }>
    >`
      SELECT id, name, state, total_filings, total_spending, issue_codes,
             similarity(name, ${name}) AS sim
      FROM lda_client
      WHERE name % ${name}
      ORDER BY sim DESC
      LIMIT 5
    `;

    if (!rows.length || !rows[0] || rows[0].sim < 0.35) return null;

    const best = rows[0];
    return {
      id: best.id,
      name: best.name,
      state: best.state,
      totalFilings: best.total_filings,
      totalSpending: best.total_spending != null ? Number(best.total_spending) : null,
      issueCodes: best.issue_codes ?? [],
      similarity: best.sim,
      candidates: rows.slice(1).map((r) => ({
        id: r.id,
        name: r.name,
        similarity: r.sim,
      })),
    };
  }
}
