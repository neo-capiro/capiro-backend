import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Intelligence Center service.
 *
 * Each method below is a typed query against ONE federal intelligence source
 * (LDA filings, federal contractors, etc.). They share a common pattern:
 *   - accept a free-text search term `q`
 *   - accept source-specific filter arrays
 *   - support sort + paginated limit/offset
 *   - return `{ rows, total }`
 *
 * Filters are applied as AND across keys, IN-style within a key. Page is
 * always 1-based. Default page size is 25 rows.
 */
@Injectable()
export class ExplorerService {
  constructor(private readonly prisma: PrismaService) {}

  /* ── LDA filings, the largest data set ─────────────────────────────── */

  async ldaFilings(opts: {
    q?: string;
    issueCodes?: string[];
    years?: number[];
    filingTypes?: string[];
    states?: string[];
    periods?: string[];
    minIncome?: number;
    maxIncome?: number;
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.LdaFilingWhereInput = {};
    if (opts.q) {
      const term = opts.q.trim();
      where.OR = [
        { clientName: { contains: term, mode: 'insensitive' } },
        { registrantName: { contains: term, mode: 'insensitive' } },
        { clientDescription: { contains: term, mode: 'insensitive' } },
        { clientState: { contains: term, mode: 'insensitive' } },
        // Match an issue code typed directly (e.g. "DEF", "HCR").
        { issueCodes: { has: term.toUpperCase() } },
      ];
    }
    if (opts.issueCodes?.length) where.issueCodes = { hasSome: opts.issueCodes };
    if (opts.years?.length) where.filingYear = { in: opts.years };
    if (opts.filingTypes?.length) where.filingType = { in: opts.filingTypes };
    if (opts.states?.length) where.clientState = { in: opts.states };
    if (opts.periods?.length) where.filingPeriod = { in: opts.periods };
    const incomeFilter: Prisma.DecimalFilter = {};
    if (opts.minIncome != null && opts.minIncome > 0) {
      incomeFilter.gte = new Prisma.Decimal(opts.minIncome);
    }
    if (opts.maxIncome != null && opts.maxIncome > 0) {
      incomeFilter.lte = new Prisma.Decimal(opts.maxIncome);
    }
    if (incomeFilter.gte != null || incomeFilter.lte != null) {
      where.income = incomeFilter;
    }

    const orderBy = ldaSortClause(opts.sort);
    const [rows, total] = await Promise.all([
      this.prisma.ldaFiling.findMany({ where, orderBy, take: limit, skip: offset }),
      this.prisma.ldaFiling.count({ where }),
    ]);

    return {
      rows: rows.map((r) => ({
        id: r.id,
        filingUuid: r.filingUuid,
        filingType: r.filingType,
        filingYear: r.filingYear,
        filingPeriod: r.filingPeriod,
        income: r.income ? Number(r.income) : null,
        expenses: r.expenses ? Number(r.expenses) : null,
        dtPosted: r.dtPosted?.toISOString() ?? null,
        registrantName: r.registrantName,
        clientName: r.clientName,
        clientState: r.clientState,
        issueCodes: r.issueCodes ?? [],
      })),
      total,
    };
  }

  /* ── Federal contractors ────────────────────────────────────────────── */

  async federalContractors(opts: {
    q?: string;
    categories?: string[];
    hasNoBid?: boolean;
    minContracts?: number;
    maxContracts?: number;
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.FederalContractorWhereInput = {};
    if (opts.q) {
      where.OR = [
        { name: { contains: opts.q, mode: 'insensitive' } },
        { uei: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.categories?.length) where.category = { in: opts.categories };
    if (opts.hasNoBid) where.noBidTotal = { gt: new Prisma.Decimal(0) };
    const contractsFilter: Prisma.DecimalFilter = {};
    if (opts.minContracts != null && opts.minContracts > 0) {
      contractsFilter.gte = new Prisma.Decimal(opts.minContracts);
    }
    if (opts.maxContracts != null && opts.maxContracts > 0) {
      contractsFilter.lte = new Prisma.Decimal(opts.maxContracts);
    }
    if (contractsFilter.gte != null || contractsFilter.lte != null) {
      where.totalContracts = contractsFilter;
    }

    const orderBy: Prisma.FederalContractorOrderByWithRelationInput =
      opts.sort === 'no-bid'
        ? { noBidTotal: { sort: 'desc', nulls: 'last' } }
        : opts.sort === 'name'
          ? { name: 'asc' }
          : { totalContracts: { sort: 'desc', nulls: 'last' } };

    const [rows, total] = await Promise.all([
      this.prisma.federalContractor.findMany({ where, orderBy, take: limit, skip: offset }),
      this.prisma.federalContractor.count({ where }),
    ]);

    return {
      rows: rows.map((r) => ({
        id: r.id,
        name: r.name,
        uei: r.uei,
        category: r.category,
        totalContracts: r.totalContracts ? Number(r.totalContracts) : null,
        pctOfAllContracts: r.pctOfAllContracts ? Number(r.pctOfAllContracts) : null,
        rankByContracts: r.rankByContracts,
        noBidTotal: r.noBidTotal ? Number(r.noBidTotal) : null,
        subsidiaries: r.subsidiaries,
      })),
      total,
    };
  }

  /* ── Congress bills ─────────────────────────────────────────────────── */

  async congressBills(opts: {
    q?: string;
    congress?: number[];
    subjects?: string[];
    sponsorParty?: string[];
    originChamber?: string[];
    policyAreas?: string[];
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.CongressBillWhereInput = {};
    if (opts.q) {
      where.OR = [
        { title: { contains: opts.q, mode: 'insensitive' } },
        { sponsorName: { contains: opts.q, mode: 'insensitive' } },
        { latestActionText: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.congress?.length) where.congress = { in: opts.congress };
    if (opts.sponsorParty?.length) where.sponsorParty = { in: opts.sponsorParty };
    if (opts.originChamber?.length) where.originChamber = { in: opts.originChamber };
    if (opts.policyAreas?.length) where.policyArea = { in: opts.policyAreas };
    if (opts.subjects?.length) {
      where.subjectRefs = { some: { name: { in: opts.subjects } } };
    }

    const orderBy: Prisma.CongressBillOrderByWithRelationInput =
      opts.sort === 'introduced'
        ? { introducedDate: { sort: 'desc', nulls: 'last' } }
        : opts.sort === 'cosponsors'
          ? { cosponsorsCount: 'desc' }
          : { latestActionDate: { sort: 'desc', nulls: 'last' } };

    const [rows, total] = await Promise.all([
      this.prisma.congressBill.findMany({ where, orderBy, take: limit, skip: offset }),
      this.prisma.congressBill.count({ where }),
    ]);

    return {
      rows: rows.map((b) => ({
        id: b.id,
        congress: b.congress,
        billType: b.billType,
        billNumber: b.billNumber,
        title: b.title,
        introducedDate: b.introducedDate?.toISOString() ?? null,
        sponsorName: b.sponsorName,
        sponsorState: b.sponsorState,
        sponsorParty: b.sponsorParty,
        latestActionText: b.latestActionText,
        latestActionDate: b.latestActionDate?.toISOString() ?? null,
        policyArea: b.policyArea,
        cosponsorsCount: b.cosponsorsCount,
        originChamber: b.originChamber,
        url: b.url,
      })),
      total,
    };
  }

  /* ── Federal Register documents ─────────────────────────────────────── */

  async federalRegisterDocs(opts: {
    q?: string;
    types?: string[];
    agencies?: string[];
    topics?: string[];
    significantOnly?: boolean;
    openCommentOnly?: boolean;
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.FederalRegisterDocumentWhereInput = {};
    if (opts.q) {
      where.OR = [
        { title: { contains: opts.q, mode: 'insensitive' } },
        { abstract: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.types?.length) where.type = { in: opts.types };
    if (opts.agencies?.length) where.agencyNames = { hasSome: opts.agencies };
    if (opts.topics?.length) where.topics = { hasSome: opts.topics };
    if (opts.significantOnly) where.significantRule = true;
    if (opts.openCommentOnly) {
      where.commentEndDate = { gt: new Date() };
    }

    const orderBy: Prisma.FederalRegisterDocumentOrderByWithRelationInput =
      opts.sort === 'comment-close'
        ? { commentEndDate: { sort: 'asc', nulls: 'last' } }
        : { publicationDate: 'desc' };

    const [rows, total] = await Promise.all([
      this.prisma.federalRegisterDocument.findMany({ where, orderBy, take: limit, skip: offset }),
      this.prisma.federalRegisterDocument.count({ where }),
    ]);

    return {
      rows: rows.map((d) => ({
        id: d.id,
        documentNumber: d.documentNumber,
        type: d.type,
        title: d.title,
        agencyNames: d.agencyNames,
        publicationDate: d.publicationDate.toISOString(),
        commentEndDate: d.commentEndDate?.toISOString() ?? null,
        effectiveDate: d.effectiveDate?.toISOString() ?? null,
        topics: d.topics,
        significantRule: d.significantRule,
        htmlUrl: d.htmlUrl,
      })),
      total,
    };
  }

  /* ── Facets (filter dropdowns) ──────────────────────────────────────── */

  async ldaFacets() {
    const [issueCodes, years, states, periods] = await Promise.all([
      this.prisma.ldaIssueCode.findMany({
        select: { code: true, name: true },
        orderBy: { code: 'asc' },
      }),
      this.prisma.$queryRaw<Array<{ year: number }>>`
        SELECT DISTINCT filing_year AS year FROM lda_filing
        WHERE filing_year IS NOT NULL ORDER BY filing_year DESC
      `,
      this.prisma.$queryRaw<Array<{ state: string }>>`
        SELECT DISTINCT client_state AS state FROM lda_filing
        WHERE client_state IS NOT NULL AND client_state <> '' ORDER BY client_state ASC
      `,
      this.prisma.$queryRaw<Array<{ period: string }>>`
        SELECT DISTINCT filing_period AS period FROM lda_filing
        WHERE filing_period IS NOT NULL AND filing_period <> '' ORDER BY filing_period ASC
      `,
    ]);
    return {
      issueCodes,
      years: years.map((r) => r.year),
      filingTypes: ['LD-2', 'LD-1', 'LD-2A', 'LD-203'],
      states: states.map((r) => r.state),
      periods: periods.map((r) => r.period),
    };
  }

  async contractorFacets() {
    const rows = await this.prisma.$queryRaw<Array<{ category: string | null }>>`
      SELECT DISTINCT category FROM federal_contractor
      WHERE category IS NOT NULL ORDER BY category ASC
    `;
    return { categories: rows.map((r) => r.category).filter((c): c is string => Boolean(c)) };
  }

  async billFacets() {
    const [congresses, subjects, chambers, parties, policyAreas] = await Promise.all([
      this.prisma.$queryRaw<Array<{ congress: number }>>`
        SELECT DISTINCT congress FROM congress_bill ORDER BY congress DESC LIMIT 6
      `,
      this.prisma.$queryRaw<Array<{ name: string; n: bigint }>>`
        SELECT name, COUNT(*)::bigint AS n
        FROM congress_bill_subject
        GROUP BY name ORDER BY n DESC LIMIT 30
      `,
      this.prisma.$queryRaw<Array<{ chamber: string }>>`
        SELECT DISTINCT origin_chamber AS chamber FROM congress_bill
        WHERE origin_chamber IS NOT NULL ORDER BY chamber
      `,
      this.prisma.$queryRaw<Array<{ party: string }>>`
        SELECT DISTINCT sponsor_party AS party FROM congress_bill
        WHERE sponsor_party IS NOT NULL ORDER BY party
      `,
      this.prisma.$queryRaw<Array<{ area: string }>>`
        SELECT DISTINCT policy_area AS area FROM congress_bill
        WHERE policy_area IS NOT NULL ORDER BY area LIMIT 50
      `,
    ]);
    return {
      congresses: congresses.map((r) => r.congress),
      subjects: subjects.map((r) => r.name),
      chambers: chambers.map((r) => r.chamber),
      parties: parties.map((r) => r.party),
      policyAreas: policyAreas.map((r) => r.area),
    };
  }

  async fedRegFacets() {
    const [types, agencies, topics] = await Promise.all([
      this.prisma.$queryRaw<Array<{ type: string }>>`
        SELECT DISTINCT type FROM federal_register_document ORDER BY type
      `,
      this.prisma.$queryRaw<Array<{ agency: string; n: bigint }>>`
        SELECT agency, COUNT(*)::bigint AS n
        FROM federal_register_document, unnest(agency_names) AS agency
        GROUP BY agency ORDER BY n DESC LIMIT 50
      `,
      this.prisma.$queryRaw<Array<{ topic: string; n: bigint }>>`
        SELECT topic, COUNT(*)::bigint AS n
        FROM federal_register_document, unnest(topics) AS topic
        WHERE topic IS NOT NULL AND topic <> ''
        GROUP BY topic ORDER BY n DESC LIMIT 50
      `,
    ]);
    return {
      types: types.map((r) => r.type),
      agencies: agencies.map((r) => r.agency),
      topics: topics.map((r) => r.topic),
    };
  }

  /* ── Committee hearings ─────────────────────────────────────────────── */

  async committeeHearings(opts: {
    q?: string;
    chambers?: string[];
    committees?: string[];
    types?: string[];
    futureOnly?: boolean;
    dateFilter?: 'upcoming' | 'past' | 'all';
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.CommitteeHearingWhereInput = {};
    if (opts.q) {
      where.OR = [
        { title: { contains: opts.q, mode: 'insensitive' } },
        { committeeName: { contains: opts.q, mode: 'insensitive' } },
        { location: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.chambers?.length) where.chamber = { in: opts.chambers };
    if (opts.committees?.length) where.committeeName = { in: opts.committees };
    if (opts.types?.length) where.type = { in: opts.types };
    // Date window. `dateFilter` is the modern control; `futureOnly` kept for
    // backward-compat (older clients). 'all' applies no date constraint.
    // Compare against start-of-today so a hearing earlier today still counts
    // as upcoming (the column is a DATE, no time component).
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const effectiveFilter: 'upcoming' | 'past' | 'all' =
      opts.dateFilter ?? (opts.futureOnly ? 'upcoming' : 'all');
    if (effectiveFilter === 'upcoming') where.date = { gte: startOfToday };
    else if (effectiveFilter === 'past') where.date = { lt: startOfToday };

    // Sort: for an upcoming view, soonest-first is the natural default;
    // for past/all, most-recent-first. Explicit sort always wins.
    const sortKey = opts.sort ?? (effectiveFilter === 'upcoming' ? 'soonest' : 'recent');
    const orderBy: Prisma.CommitteeHearingOrderByWithRelationInput =
      sortKey === 'soonest' || sortKey === 'future' ? { date: 'asc' } : { date: 'desc' };

    const [rows, total] = await Promise.all([
      this.prisma.committeeHearing.findMany({ where, orderBy, take: limit, skip: offset }),
      this.prisma.committeeHearing.count({ where }),
    ]);
    return {
      rows: rows.map((h) => ({
        id: h.id,
        chamber: h.chamber,
        committeeName: h.committeeName,
        committeeCode: h.committeeCode,
        title: h.title,
        date: h.date.toISOString(),
        time: h.time,
        location: h.location,
        type: h.type,
        witnesses: h.witnesses ?? [],
        url: h.url,
      })),
      total,
    };
  }

  async hearingFacets() {
    const [chambers, committees, types] = await Promise.all([
      this.prisma.$queryRaw<Array<{ chamber: string }>>`
        SELECT DISTINCT chamber FROM committee_hearing ORDER BY chamber
      `,
      this.prisma.$queryRaw<Array<{ committee: string; n: bigint }>>`
        SELECT committee_name AS committee, COUNT(*)::bigint AS n
        FROM committee_hearing GROUP BY committee_name ORDER BY n DESC LIMIT 40
      `,
      this.prisma.$queryRaw<Array<{ type: string }>>`
        SELECT DISTINCT type FROM committee_hearing WHERE type IS NOT NULL ORDER BY type
      `,
    ]);
    return {
      chambers: chambers.map((r) => r.chamber),
      committees: committees.map((r) => r.committee),
      types: types.map((r) => r.type),
    };
  }

  /* ── GAO reports ────────────────────────────────────────────────────── */

  async gaoReports(opts: {
    q?: string;
    reportTypes?: string[];
    topics?: string[];
    agencies?: string[];
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.GaoReportWhereInput = {};
    if (opts.q) {
      where.OR = [
        { title: { contains: opts.q, mode: 'insensitive' } },
        { summary: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.reportTypes?.length) where.reportType = { in: opts.reportTypes };
    if (opts.topics?.length) where.topics = { hasSome: opts.topics };
    if (opts.agencies?.length) where.agencies = { hasSome: opts.agencies };

    const orderBy: Prisma.GaoReportOrderByWithRelationInput =
      opts.sort === 'recs'
        ? { recommendations: { sort: 'desc', nulls: 'last' } }
        : { publishDate: { sort: 'desc', nulls: 'last' } };

    const [rows, total] = await Promise.all([
      this.prisma.gaoReport.findMany({ where, orderBy, take: limit, skip: offset }),
      this.prisma.gaoReport.count({ where }),
    ]);
    return {
      rows: rows.map((r) => ({
        id: r.id,
        title: r.title,
        url: r.url,
        publishDate: r.publishDate?.toISOString() ?? null,
        reportType: r.reportType,
        topics: r.topics ?? [],
        agencies: r.agencies ?? [],
        summary: r.summary,
        recommendations: r.recommendations,
      })),
      total,
    };
  }

  async gaoFacets() {
    const [types, topics, agencies] = await Promise.all([
      this.prisma.$queryRaw<Array<{ t: string }>>`
        SELECT DISTINCT report_type AS t FROM gao_report WHERE report_type IS NOT NULL ORDER BY t
      `,
      this.prisma.$queryRaw<Array<{ topic: string; n: bigint }>>`
        SELECT topic, COUNT(*)::bigint AS n
        FROM gao_report, unnest(topics) AS topic
        GROUP BY topic ORDER BY n DESC LIMIT 30
      `,
      this.prisma.$queryRaw<Array<{ agency: string; n: bigint }>>`
        SELECT agency, COUNT(*)::bigint AS n
        FROM gao_report, unnest(agencies) AS agency
        WHERE agency IS NOT NULL AND agency <> ''
        GROUP BY agency ORDER BY n DESC LIMIT 30
      `,
    ]);
    return {
      reportTypes: types.map((r) => r.t),
      topics: topics.map((r) => r.topic),
      agencies: agencies.map((r) => r.agency),
    };
  }

  /* ── CRS reports ────────────────────────────────────────────────────── */

  async crsReports(opts: {
    q?: string;
    topics?: string[];
    activeOnly?: boolean;
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.CrsReportWhereInput = {};
    if (opts.q) {
      where.OR = [
        { title: { contains: opts.q, mode: 'insensitive' } },
        { summary: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.topics?.length) where.topics = { hasSome: opts.topics };
    if (opts.activeOnly) where.active = true;

    const [rows, total] = await Promise.all([
      this.prisma.crsReport.findMany({
        where,
        orderBy: { date: { sort: 'desc', nulls: 'last' } },
        take: limit,
        skip: offset,
      }),
      this.prisma.crsReport.count({ where }),
    ]);
    return {
      rows: rows.map((r) => ({
        id: r.id,
        title: r.title,
        date: r.date?.toISOString() ?? null,
        authors: r.authors ?? [],
        topics: r.topics ?? [],
        summary: r.summary,
        pdfUrl: r.pdfUrl,
        htmlUrl: r.htmlUrl,
        active: r.active,
      })),
      total,
    };
  }

  async crsFacets() {
    const topics = await this.prisma.$queryRaw<Array<{ topic: string; n: bigint }>>`
      SELECT topic, COUNT(*)::bigint AS n
      FROM crs_report, unnest(topics) AS topic
      GROUP BY topic ORDER BY n DESC LIMIT 30
    `;
    return { topics: topics.map((r) => r.topic) };
  }

  /* ── FEC contributions ──────────────────────────────────────────────── */

  async fecContributions(opts: {
    q?: string;
    cycles?: number[];
    states?: string[];
    minAmount?: number;
    maxAmount?: number;
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.FecContributionWhereInput = {};
    if (opts.q) {
      where.OR = [
        { contributorName: { contains: opts.q, mode: 'insensitive' } },
        { contributorEmployer: { contains: opts.q, mode: 'insensitive' } },
        { committeeName: { contains: opts.q, mode: 'insensitive' } },
        { candidateName: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.cycles?.length) where.cycle = { in: opts.cycles };
    if (opts.states?.length) where.state = { in: opts.states };
    const amountFilter: Prisma.DecimalFilter = {};
    if (opts.minAmount != null && opts.minAmount > 0) {
      amountFilter.gte = new Prisma.Decimal(opts.minAmount);
    }
    if (opts.maxAmount != null && opts.maxAmount > 0) {
      amountFilter.lte = new Prisma.Decimal(opts.maxAmount);
    }
    if (amountFilter.gte != null || amountFilter.lte != null) {
      where.amount = amountFilter;
    }

    const orderBy: Prisma.FecContributionOrderByWithRelationInput =
      opts.sort === 'date'
        ? { contributionDate: { sort: 'desc', nulls: 'last' } }
        : { amount: 'desc' };

    const [rows, total] = await Promise.all([
      this.prisma.fecContribution.findMany({ where, orderBy, take: limit, skip: offset }),
      this.prisma.fecContribution.count({ where }),
    ]);
    return {
      rows: rows.map((c) => ({
        id: c.id,
        committeeId: c.committeeId,
        committeeName: c.committeeName,
        candidateId: c.candidateId,
        candidateName: c.candidateName,
        contributorName: c.contributorName,
        contributorEmployer: c.contributorEmployer,
        contributorOccupation: c.contributorOccupation,
        amount: Number(c.amount),
        contributionDate: c.contributionDate?.toISOString() ?? null,
        receiptType: c.receiptType,
        state: c.state,
        cycle: c.cycle,
      })),
      total,
    };
  }

  async fecFacets() {
    const [cycles, states] = await Promise.all([
      this.prisma.$queryRaw<Array<{ cycle: number }>>`
        SELECT DISTINCT cycle FROM fec_contribution ORDER BY cycle DESC LIMIT 6
      `,
      this.prisma.$queryRaw<Array<{ state: string }>>`
        SELECT DISTINCT state FROM fec_contribution
        WHERE state IS NOT NULL AND state <> '' ORDER BY state
      `,
    ]);
    return {
      cycles: cycles.map((r) => r.cycle),
      states: states.map((r) => r.state),
    };
  }

  /* ── FARA registrations ─────────────────────────────────────────────── */

  async faraRegistrations(opts: {
    q?: string;
    countries?: string[];
    statuses?: string[];
    states?: string[];
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.FaraRegistrationWhereInput = {};
    if (opts.q) {
      where.OR = [
        { registrantName: { contains: opts.q, mode: 'insensitive' } },
        { foreignPrincipal: { contains: opts.q, mode: 'insensitive' } },
        { description: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.countries?.length) where.country = { in: opts.countries };
    if (opts.statuses?.length) where.status = { in: opts.statuses };
    if (opts.states?.length) where.state = { in: opts.states };

    const orderBy: Prisma.FaraRegistrationOrderByWithRelationInput =
      opts.sort === 'oldest'
        ? { registrationDate: { sort: 'asc', nulls: 'last' } }
        : { registrationDate: { sort: 'desc', nulls: 'last' } };

    const [rows, total] = await Promise.all([
      this.prisma.faraRegistration.findMany({ where, orderBy, take: limit, skip: offset }),
      this.prisma.faraRegistration.count({ where }),
    ]);
    return {
      rows: rows.map((r) => ({
        id: r.id,
        registrationNumber: r.registrationNumber,
        registrantName: r.registrantName,
        foreignPrincipal: r.foreignPrincipal,
        country: r.country,
        status: r.status,
        registrationDate: r.registrationDate?.toISOString() ?? null,
        terminationDate: r.terminationDate?.toISOString() ?? null,
        state: r.state,
        description: r.description,
      })),
      total,
    };
  }

  async faraFacets() {
    const [countries, statuses, states] = await Promise.all([
      this.prisma.$queryRaw<Array<{ country: string; n: bigint }>>`
        SELECT country, COUNT(*)::bigint AS n FROM fara_registration
        WHERE country IS NOT NULL GROUP BY country ORDER BY n DESC LIMIT 50
      `,
      this.prisma.$queryRaw<Array<{ status: string }>>`
        SELECT DISTINCT status FROM fara_registration WHERE status IS NOT NULL ORDER BY status
      `,
      this.prisma.$queryRaw<Array<{ state: string }>>`
        SELECT DISTINCT state FROM fara_registration
        WHERE state IS NOT NULL AND state <> '' ORDER BY state
      `,
    ]);
    return {
      countries: countries.map((r) => r.country),
      statuses: statuses.map((r) => r.status),
      states: states.map((r) => r.state),
    };
  }

  /* ── SEC filings ────────────────────────────────────────────────────── */

  async secFilings(opts: {
    q?: string;
    formTypes?: string[];
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.SecFilingWhereInput = {};
    if (opts.q) {
      where.OR = [
        { companyName: { contains: opts.q, mode: 'insensitive' } },
        { description: { contains: opts.q, mode: 'insensitive' } },
        { cik: { contains: opts.q.replace(/^0+/, ''), mode: 'insensitive' } },
      ];
    }
    if (opts.formTypes?.length) where.formType = { in: opts.formTypes };

    const [rows, total] = await Promise.all([
      this.prisma.secFiling.findMany({
        where,
        orderBy: { filingDate: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.secFiling.count({ where }),
    ]);
    return {
      rows: rows.map((f) => ({
        id: f.id,
        cik: f.cik,
        companyName: f.companyName,
        formType: f.formType,
        accessionNumber: f.accessionNumber,
        filingDate: f.filingDate.toISOString(),
        reportDate: f.reportDate?.toISOString() ?? null,
        description: f.description,
        sic: f.sic,
        url: f.url,
      })),
      total,
    };
  }

  async secFacets() {
    const formTypes = await this.prisma.$queryRaw<Array<{ t: string; n: bigint }>>`
      SELECT form_type AS t, COUNT(*)::bigint AS n
      FROM sec_filing GROUP BY form_type ORDER BY n DESC LIMIT 25
    `;
    return { formTypes: formTypes.map((r) => r.t) };
  }

  /* ── SAM.gov contract opportunities ─────────────────────────────────── */

  async samOpportunities(opts: {
    q?: string;
    noticeTypes?: string[];
    agencies?: string[];
    naics?: string;
    psc?: string;
    activeOnly?: boolean;
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.SamOpportunityWhereInput = {};
    if (opts.q) {
      where.OR = [
        { title: { contains: opts.q, mode: 'insensitive' } },
        { description: { contains: opts.q, mode: 'insensitive' } },
        { agency: { contains: opts.q, mode: 'insensitive' } },
        { office: { contains: opts.q, mode: 'insensitive' } },
        { solicitationNumber: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.noticeTypes?.length) where.noticeType = { in: opts.noticeTypes };
    if (opts.agencies?.length) where.agency = { in: opts.agencies };
    if (opts.naics) where.naicsCode = { startsWith: opts.naics.trim() };
    if (opts.psc) where.pscCode = { startsWith: opts.psc.trim().toUpperCase() };
    // Active = notice's archive date hasn't passed. Default to active-only since a
    // closed solicitation can't be bid on; users opt into history explicitly.
    if (opts.activeOnly !== false) where.active = true;

    // 'deadline' = soonest response deadline first (nulls last); default newest-posted.
    const orderBy: Prisma.SamOpportunityOrderByWithRelationInput =
      opts.sort === 'deadline'
        ? { responseDeadline: 'asc' }
        : opts.sort === 'oldest'
          ? { postedDate: 'asc' }
          : { postedDate: 'desc' };

    const [rows, total] = await Promise.all([
      this.prisma.samOpportunity.findMany({ where, orderBy, take: limit, skip: offset }),
      this.prisma.samOpportunity.count({ where }),
    ]);
    return {
      rows: rows.map((o) => ({
        id: o.id,
        noticeId: o.noticeId,
        solicitationNumber: o.solicitationNumber,
        title: o.title,
        noticeType: o.noticeType,
        agency: o.agency,
        office: o.office,
        pscCode: o.pscCode,
        naicsCode: o.naicsCode,
        postedDate: o.postedDate?.toISOString() ?? null,
        responseDeadline: o.responseDeadline?.toISOString() ?? null,
        active: o.active,
        url: o.sourceUrl,
      })),
      total,
    };
  }

  async samOpportunityFacets() {
    const [noticeTypes, agencies] = await Promise.all([
      this.prisma.$queryRaw<Array<{ t: string; n: bigint }>>`
        SELECT notice_type AS t, COUNT(*)::bigint AS n
        FROM sam_opportunity WHERE notice_type IS NOT NULL
        GROUP BY notice_type ORDER BY n DESC LIMIT 25
      `,
      this.prisma.$queryRaw<Array<{ a: string; n: bigint }>>`
        SELECT agency AS a, COUNT(*)::bigint AS n
        FROM sam_opportunity WHERE agency IS NOT NULL AND agency <> ''
        GROUP BY agency ORDER BY n DESC LIMIT 30
      `,
    ]);
    return {
      noticeTypes: noticeTypes.map((r) => r.t),
      agencies: agencies.map((r) => r.a),
    };
  }

  /* ── Federal awards (USAspending) ───────────────────────────────────── */

  async federalAwards(opts: {
    q?: string;
    agencies?: string[];
    states?: string[];
    fiscalYears?: number[];
    minAmount?: number;
    maxAmount?: number;
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.FederalAwardWhereInput = {};
    if (opts.q) {
      where.OR = [
        { contractorName: { contains: opts.q, mode: 'insensitive' } },
        { description: { contains: opts.q, mode: 'insensitive' } },
        { awardingAgency: { contains: opts.q, mode: 'insensitive' } },
        { dodAcqProgramName: { contains: opts.q, mode: 'insensitive' } },
        { piid: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.agencies?.length) where.awardingAgency = { in: opts.agencies };
    if (opts.states?.length) where.popState = { in: opts.states };
    if (opts.fiscalYears?.length) where.fundingFy = { in: opts.fiscalYears };
    if (opts.minAmount != null || opts.maxAmount != null) {
      where.amount = {};
      if (opts.minAmount != null) where.amount.gte = opts.minAmount;
      if (opts.maxAmount != null) where.amount.lte = opts.maxAmount;
    }

    const orderBy: Prisma.FederalAwardOrderByWithRelationInput =
      opts.sort === 'recent'
        ? { actionDate: 'desc' }
        : opts.sort === 'oldest'
          ? { actionDate: 'asc' }
          : { amount: 'desc' };

    const [rows, total] = await Promise.all([
      this.prisma.federalAward.findMany({ where, orderBy, take: limit, skip: offset }),
      this.prisma.federalAward.count({ where }),
    ]);
    return {
      rows: rows.map((a) => ({
        id: a.id,
        piid: a.piid,
        contractorName: a.contractorName,
        awardingAgency: a.awardingAgency,
        awardingSubTier: a.awardingSubTier,
        amount: a.amount != null ? Number(a.amount) : null,
        description: a.description,
        peCode: a.peCode,
        dodAcqProgramName: a.dodAcqProgramName,
        popState: a.popState,
        fundingFy: a.fundingFy,
        actionDate: a.actionDate?.toISOString() ?? null,
        url: a.awardUniqueId
          ? `https://www.usaspending.gov/award/${encodeURIComponent(a.awardUniqueId)}`
          : null,
      })),
      total,
    };
  }

  async federalAwardFacets() {
    const [agencies, states, fiscalYears] = await Promise.all([
      this.prisma.$queryRaw<Array<{ a: string; n: bigint }>>`
        SELECT awarding_agency AS a, COUNT(*)::bigint AS n
        FROM federal_award WHERE awarding_agency IS NOT NULL AND awarding_agency <> ''
        GROUP BY awarding_agency ORDER BY n DESC LIMIT 30
      `,
      this.prisma.$queryRaw<Array<{ s: string }>>`
        SELECT DISTINCT pop_state AS s FROM federal_award
        WHERE pop_state IS NOT NULL AND pop_state <> '' ORDER BY pop_state
      `,
      this.prisma.$queryRaw<Array<{ fy: number }>>`
        SELECT DISTINCT funding_fy AS fy FROM federal_award
        WHERE funding_fy IS NOT NULL ORDER BY fy DESC
      `,
    ]);
    return {
      agencies: agencies.map((r) => r.a),
      states: states.map((r) => r.s),
      fiscalYears: fiscalYears.map((r) => Number(r.fy)),
    };
  }

  /* ── Federal grants (Grants.gov) ────────────────────────────────────── */

  async federalGrants(opts: {
    q?: string;
    agencies?: string[];
    statuses?: string[];
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.FederalGrantWhereInput = {};
    if (opts.q) {
      where.OR = [
        { title: { contains: opts.q, mode: 'insensitive' } },
        { description: { contains: opts.q, mode: 'insensitive' } },
        { agency: { contains: opts.q, mode: 'insensitive' } },
        { opportunityNumber: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.agencies?.length) where.agency = { in: opts.agencies };
    if (opts.statuses?.length) where.status = { in: opts.statuses };

    const orderBy: Prisma.FederalGrantOrderByWithRelationInput =
      opts.sort === 'close'
        ? { closeDate: 'asc' }
        : opts.sort === 'oldest'
          ? { openDate: 'asc' }
          : { openDate: 'desc' };

    const [rows, total] = await Promise.all([
      this.prisma.federalGrant.findMany({ where, orderBy, take: limit, skip: offset }),
      this.prisma.federalGrant.count({ where }),
    ]);
    return {
      rows: rows.map((g) => ({
        id: g.id,
        title: g.title,
        agency: g.agency,
        subAgency: g.subAgency,
        opportunityNumber: g.opportunityNumber,
        category: g.category,
        fundingInstrument: g.fundingInstrument,
        awardCeiling: g.awardCeiling,
        estimatedFunding: g.estimatedFunding,
        openDate: g.openDate?.toISOString() ?? null,
        closeDate: g.closeDate?.toISOString() ?? null,
        status: g.status,
        url: g.url,
      })),
      total,
    };
  }

  async federalGrantFacets() {
    const [agencies, statuses] = await Promise.all([
      this.prisma.$queryRaw<Array<{ a: string; n: bigint }>>`
        SELECT agency AS a, COUNT(*)::bigint AS n
        FROM federal_grant WHERE agency IS NOT NULL AND agency <> ''
        GROUP BY agency ORDER BY n DESC LIMIT 30
      `,
      this.prisma.$queryRaw<Array<{ s: string }>>`
        SELECT DISTINCT status AS s FROM federal_grant
        WHERE status IS NOT NULL AND status <> '' ORDER BY status
      `,
    ]);
    return {
      agencies: agencies.map((r) => r.a),
      statuses: statuses.map((r) => r.s),
    };
  }

  /* ── State legislators (OpenStates) ─────────────────────────────────── */

  async stateLegislators(opts: {
    q?: string;
    states?: string[];
    chambers?: string[];
    parties?: string[];
    /**
     * Single committee NAME (exact, case-insensitive) — keep legislators who
     * sit on a committee with this name. Singular (not the CSV `arrayOrSplit`
     * multi-filter the other params use) on purpose: state committee names
     * routinely contain commas (e.g. "Health, Welfare & Institutions"), which a
     * CSV split would shred into bogus tokens. Match is on the relational
     * state_committee_membership → state_committee join, so it reflects current
     * roster membership, not the denormalized JSON snapshot.
     */
    committee?: string;
    /** Include each legislator's current committees in the returned rows. */
    includeCommittees?: boolean;
    activeOnly?: boolean;
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.StateLegislatorWhereInput = {};
    if (opts.q) {
      where.OR = [
        { name: { contains: opts.q, mode: 'insensitive' } },
        { district: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.states?.length) where.state = { in: opts.states };
    if (opts.chambers?.length) where.chamber = { in: opts.chambers };
    if (opts.parties?.length) where.party = { in: opts.parties };
    if (opts.committee) {
      where.committeeMemberships = {
        some: { committee: { name: { equals: opts.committee, mode: 'insensitive' } } },
      };
    }
    if (opts.activeOnly !== false) where.active = true;

    // The committee include is unconditional so `rows` stays a single Prisma
    // type (a runtime-conditional include would union the row type and defeat
    // the projection below). The `committees` key is only ATTACHED to the
    // response when asked for, so existing callers get the exact same shape.
    const [rows, total] = await Promise.all([
      this.prisma.stateLegislator.findMany({
        where,
        orderBy: [{ state: 'asc' }, { name: 'asc' }],
        take: limit,
        skip: offset,
        include: {
          committeeMemberships: {
            include: { committee: { select: { id: true, name: true, chamber: true } } },
            orderBy: [{ committee: { name: 'asc' } }],
          },
        },
      }),
      this.prisma.stateLegislator.count({ where }),
    ]);
    return {
      rows: rows.map((l) => ({
        id: l.id,
        name: l.name,
        state: l.state,
        chamber: l.chamber,
        district: l.district,
        party: l.party,
        email: l.email,
        image: l.image,
        url: l.url,
        ...(opts.includeCommittees
          ? {
              committees: l.committeeMemberships.map((m) => ({
                id: m.committee.id,
                name: m.committee.name,
                chamber: m.committee.chamber,
                role: m.role,
              })),
            }
          : {}),
      })),
      total,
    };
  }

  /**
   * Full profile for one state legislator (State Legislators directory tab).
   * Committees come from the relational state_committee_membership table
   * (normalize-state-committees.ts), not the denormalized JSON snapshot on
   * StateLegislator itself, since the relational rows carry a real committee
   * id/name to link against.
   *
   * Sponsored bills join StateBillSponsor by legiscanPeopleId — the ONLY
   * reliable key today (legislatorId on state_bill_sponsor is a schema-level
   * soft ref that ingestion never actually populates). That id is stamped only
   * by the OpenStates↔LegiScan crosswalk (crosswalkLegiscanPerson /
   * crosswalk-state-people), so a legislator the crosswalk hasn't linked yet
   * would otherwise show `sponsoredBills: null` even when its sponsor rows are
   * sitting in the table. To avoid that, when the stored id is null we fall
   * back to an UNAMBIGUOUS same-state name match: if the sponsor rows in this
   * legislator's state that carry their (case-insensitive) name all resolve to
   * exactly one legiscan_people_id, we use it. Zero or multiple distinct ids
   * leave `sponsoredBills: null` (honest "not yet linked", never a guessed
   * identity — PD2). The durable fix is crosswalk coverage; this is the
   * read-time safety net so deployed data isn't blank in the meantime.
   */
  async stateLegislatorDetail(id: string) {
    const legislator = await this.prisma.stateLegislator.findUnique({
      where: { id },
      include: {
        committeeMemberships: {
          include: { committee: true },
          orderBy: [{ committee: { name: 'asc' } }],
        },
      },
    });
    if (!legislator) return null;
    const committeeRows = legislator.committeeMemberships;

    // Resolve the join key: the stored crosswalk id, or an unambiguous
    // same-state name fallback when it hasn't been stamped yet.
    let resolvedPeopleId: number | null = legislator.legiscanPeopleId;
    if (resolvedPeopleId == null) {
      const nameMatches = await this.prisma.stateBillSponsor.findMany({
        where: {
          name: { equals: legislator.name, mode: 'insensitive' },
          bill: { state: legislator.state },
        },
        select: { legiscanPeopleId: true },
        distinct: ['legiscanPeopleId'],
      });
      const distinctIds = nameMatches
        .map((m) => m.legiscanPeopleId)
        .filter((x): x is number => x != null);
      if (distinctIds.length === 1) resolvedPeopleId = distinctIds[0]!;
    }

    let sponsoredBills: Array<{
      billId: string;
      identifier: string;
      title: string;
      chamber: string | null;
      status: string | null;
      statusAt: string | null;
      sponsorType: string;
    }> | null = null;
    let sponsoredBillsTotal = 0;

    if (resolvedPeopleId != null) {
      const [sponsorRows, count] = await Promise.all([
        this.prisma.stateBillSponsor.findMany({
          where: { legiscanPeopleId: resolvedPeopleId },
          include: {
            bill: {
              select: {
                id: true,
                identifier: true,
                title: true,
                chamber: true,
                status: true,
                statusAt: true,
              },
            },
          },
          // nulls: 'last' — bills without a derived status yet (pre-backfill)
          // must not crowd out actually-dated bills ahead of the take cap.
          orderBy: [{ bill: { statusAt: { sort: 'desc', nulls: 'last' } } }],
          take: 25,
        }),
        this.prisma.stateBillSponsor.count({
          where: { legiscanPeopleId: resolvedPeopleId },
        }),
      ]);
      sponsoredBills = sponsorRows.map((s) => ({
        billId: s.bill.id,
        identifier: s.bill.identifier,
        title: s.bill.title,
        chamber: s.bill.chamber,
        status: s.bill.status,
        statusAt: s.bill.statusAt?.toISOString() ?? null,
        sponsorType: s.sponsorType,
      }));
      sponsoredBillsTotal = count;
    }

    return {
      id: legislator.id,
      name: legislator.name,
      state: legislator.state,
      chamber: legislator.chamber,
      district: legislator.district,
      party: legislator.party,
      email: legislator.email,
      image: legislator.image,
      url: legislator.url,
      active: legislator.active,
      legiscanPeopleId: legislator.legiscanPeopleId,
      syncedAt: legislator.syncedAt.toISOString(),
      committees: committeeRows.map((c) => ({
        id: c.committee.id,
        name: c.committee.name,
        chamber: c.committee.chamber,
        role: c.role,
      })),
      sponsoredBills,
      sponsoredBillsTotal,
    };
  }

  async stateLegislatorFacets(opts?: { states?: string[] }) {
    const [states, chambers, parties] = await Promise.all([
      this.prisma.$queryRaw<Array<{ s: string }>>`
        SELECT DISTINCT state AS s FROM state_legislator
        WHERE state IS NOT NULL AND state <> '' ORDER BY state
      `,
      this.prisma.$queryRaw<Array<{ c: string }>>`
        SELECT DISTINCT chamber AS c FROM state_legislator
        WHERE chamber IS NOT NULL AND chamber <> '' ORDER BY chamber
      `,
      this.prisma.$queryRaw<Array<{ p: string; n: bigint }>>`
        SELECT party AS p, COUNT(*)::bigint AS n FROM state_legislator
        WHERE party IS NOT NULL AND party <> ''
        GROUP BY party ORDER BY n DESC LIMIT 15
      `,
    ]);
    // Committee names are scoped to the requested state(s): there are thousands
    // of state committees nationwide and their names are state-specific, so an
    // unscoped list is neither usable in a picker nor meaningful to filter on.
    // No state(s) → empty list (the caller gates the committee filter on a
    // chosen state). states/chambers/parties stay global and unaffected.
    const committeeRows = opts?.states?.length
      ? await this.prisma.stateCommittee.findMany({
          where: { state: { in: opts.states } },
          select: { name: true },
          distinct: ['name'],
          orderBy: { name: 'asc' },
        })
      : [];
    return {
      states: states.map((r) => r.s),
      chambers: chambers.map((r) => r.c),
      parties: parties.map((r) => r.p),
      committees: committeeRows.map((c) => c.name),
    };
  }

  /* ── Intel articles (news) ──────────────────────────────────────────── */

  async intelArticles(opts: {
    q?: string;
    sources?: string[];
    topics?: string[];
    agencies?: string[];
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.IntelArticleWhereInput = {};
    if (opts.q) {
      where.OR = [
        { title: { contains: opts.q, mode: 'insensitive' } },
        { summary: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.sources?.length) where.source = { in: opts.sources };
    if (opts.topics?.length) where.topics = { hasSome: opts.topics };
    if (opts.agencies?.length) where.agencies = { hasSome: opts.agencies };

    const [rows, total] = await Promise.all([
      this.prisma.intelArticle.findMany({
        where,
        orderBy: { publishedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.intelArticle.count({ where }),
    ]);
    return {
      rows: rows.map((a) => ({
        id: a.id,
        source: a.source,
        title: a.title,
        url: a.url,
        author: a.author,
        publishedAt: a.publishedAt.toISOString(),
        summary: a.summary,
        topics: a.topics ?? [],
        agencies: a.agencies ?? [],
      })),
      total,
    };
  }

  async intelArticleFacets() {
    const [sources, topics, agencies] = await Promise.all([
      this.prisma.$queryRaw<Array<{ s: string; n: bigint }>>`
        SELECT source AS s, COUNT(*)::bigint AS n
        FROM intel_article GROUP BY source ORDER BY n DESC LIMIT 30
      `,
      this.prisma.$queryRaw<Array<{ topic: string; n: bigint }>>`
        SELECT topic, COUNT(*)::bigint AS n
        FROM intel_article, unnest(topics) AS topic
        GROUP BY topic ORDER BY n DESC LIMIT 30
      `,
      this.prisma.$queryRaw<Array<{ agency: string; n: bigint }>>`
        SELECT agency, COUNT(*)::bigint AS n
        FROM intel_article, unnest(agencies) AS agency
        GROUP BY agency ORDER BY n DESC LIMIT 30
      `,
    ]);
    return {
      sources: sources.map((r) => r.s),
      topics: topics.map((r) => r.topic),
      agencies: agencies.map((r) => r.agency),
    };
  }

  /* ── State bills ────────────────────────────────────────────────────── */

  async stateBills(opts: {
    q?: string;
    states?: string[];
    subjects?: string[];
    sponsorParty?: string[];
    chambers?: string[];
    sort?: string;
    page?: number;
    pageSize?: number;
  }) {
    const limit = clampPageSize(opts.pageSize);
    const offset = ((opts.page ?? 1) - 1) * limit;
    const where: Prisma.StateBillWhereInput = {};
    if (opts.q) {
      where.OR = [
        { title: { contains: opts.q, mode: 'insensitive' } },
        { sponsorName: { contains: opts.q, mode: 'insensitive' } },
        { identifier: { contains: opts.q, mode: 'insensitive' } },
        { latestActionText: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    if (opts.states?.length) where.state = { in: opts.states };
    if (opts.subjects?.length) where.subjects = { hasSome: opts.subjects };
    if (opts.sponsorParty?.length) where.sponsorParty = { in: opts.sponsorParty };
    if (opts.chambers?.length) where.chamber = { in: opts.chambers };

    const [rows, total] = await Promise.all([
      this.prisma.stateBill.findMany({
        where,
        orderBy: { latestActionDate: { sort: 'desc', nulls: 'last' } },
        take: limit,
        skip: offset,
      }),
      this.prisma.stateBill.count({ where }),
    ]);
    return {
      rows: rows.map((b) => ({
        id: b.id,
        state: b.state,
        session: b.session,
        identifier: b.identifier,
        title: b.title,
        chamber: b.chamber,
        classification: b.classification ?? [],
        subjects: b.subjects ?? [],
        sponsorName: b.sponsorName,
        sponsorParty: b.sponsorParty,
        latestActionDate: b.latestActionDate?.toISOString() ?? null,
        latestActionText: b.latestActionText,
        url: b.url,
        // State Legislation Platform (S7.4) — canonical derived status (S3),
        // additive: null on any not-yet-derived row (pre-S3 backfill state).
        status: b.status,
      })),
      total,
    };
  }

  async stateBillFacets() {
    const [states, subjects, parties, chambers] = await Promise.all([
      this.prisma.$queryRaw<Array<{ state: string; n: bigint }>>`
        SELECT state, COUNT(*)::bigint AS n FROM state_bill GROUP BY state ORDER BY n DESC LIMIT 60
      `,
      this.prisma.$queryRaw<Array<{ subject: string; n: bigint }>>`
        SELECT subject, COUNT(*)::bigint AS n
        FROM state_bill, unnest(subjects) AS subject
        GROUP BY subject ORDER BY n DESC LIMIT 30
      `,
      this.prisma.$queryRaw<Array<{ party: string }>>`
        SELECT DISTINCT sponsor_party AS party FROM state_bill
        WHERE sponsor_party IS NOT NULL ORDER BY party
      `,
      this.prisma.$queryRaw<Array<{ chamber: string }>>`
        SELECT DISTINCT chamber FROM state_bill
        WHERE chamber IS NOT NULL AND chamber <> '' ORDER BY chamber
      `,
    ]);
    return {
      states: states.map((r) => r.state),
      subjects: subjects.map((r) => r.subject),
      parties: parties.map((r) => r.party),
      chambers: chambers.map((r) => r.chamber),
    };
  }

  /* ── Row drill-in: full record + related lookups ────────────────────── */

  async ldaFilingDetail(id: string) {
    const filing = await this.prisma.ldaFiling.findUnique({ where: { id } });
    if (!filing) return null;

    // Related: same registrant's recent filings, same client's recent filings,
    // and human-friendly issue-code names.
    const [registrantRecent, clientRecent, codeRows] = await Promise.all([
      this.prisma.ldaFiling.findMany({
        where: { registrantName: filing.registrantName, id: { not: filing.id } },
        orderBy: { dtPosted: { sort: 'desc', nulls: 'last' } },
        take: 5,
      }),
      filing.clientId
        ? this.prisma.ldaFiling.findMany({
            where: { clientId: filing.clientId, id: { not: filing.id } },
            orderBy: { dtPosted: { sort: 'desc', nulls: 'last' } },
            take: 5,
          })
        : Promise.resolve([]),
      filing.issueCodes.length
        ? this.prisma.ldaIssueCode.findMany({
            where: { code: { in: filing.issueCodes } },
            select: { code: true, name: true },
          })
        : Promise.resolve([]),
    ]);

    return {
      filing: {
        ...filing,
        income: filing.income ? Number(filing.income) : null,
        expenses: filing.expenses ? Number(filing.expenses) : null,
        dtPosted: filing.dtPosted?.toISOString() ?? null,
      },
      registrantRecent: registrantRecent.map((r) => ({
        id: r.id,
        filingYear: r.filingYear,
        filingPeriod: r.filingPeriod,
        clientName: r.clientName,
        income: r.income ? Number(r.income) : null,
      })),
      clientRecent: clientRecent.map((r) => ({
        id: r.id,
        filingYear: r.filingYear,
        filingPeriod: r.filingPeriod,
        registrantName: r.registrantName,
        income: r.income ? Number(r.income) : null,
      })),
      issueCodes: codeRows,
    };
  }

  async billDetail(id: string) {
    const bill = await this.prisma.congressBill.findUnique({
      where: { id },
      include: {
        actions: { orderBy: { date: 'desc' }, take: 12 },
        committeeRefs: true,
        subjectRefs: true,
      },
    });
    if (!bill) return null;
    return {
      bill: {
        ...bill,
        introducedDate: bill.introducedDate?.toISOString() ?? null,
        latestActionDate: bill.latestActionDate?.toISOString() ?? null,
        updateDate: bill.updateDate?.toISOString() ?? null,
        actions: bill.actions.map((a) => ({
          id: a.id,
          date: a.date.toISOString(),
          text: a.text,
          type: a.type,
          chamber: a.chamber,
        })),
      },
    };
  }

  async contractorDetail(id: string) {
    const c = await this.prisma.federalContractor.findUnique({ where: { id } });
    if (!c) return null;
    return {
      contractor: {
        ...c,
        totalContracts: c.totalContracts ? Number(c.totalContracts) : null,
        pctOfAllContracts: c.pctOfAllContracts ? Number(c.pctOfAllContracts) : null,
        costPerTaxpayer: c.costPerTaxpayer ? Number(c.costPerTaxpayer) : null,
        noBidTotal: c.noBidTotal ? Number(c.noBidTotal) : null,
      },
    };
  }

  async fedRegDetail(id: string) {
    const d = await this.prisma.federalRegisterDocument.findUnique({ where: { id } });
    if (!d) return null;
    return {
      document: {
        ...d,
        publicationDate: d.publicationDate.toISOString(),
        commentEndDate: d.commentEndDate?.toISOString() ?? null,
        effectiveDate: d.effectiveDate?.toISOString() ?? null,
      },
    };
  }

  /* ── Detail endpoints for the 8 newer sources ──────────────────────── */

  async hearingDetail(id: string) {
    const h = await this.prisma.committeeHearing.findUnique({ where: { id } });
    if (!h) return null;
    return {
      hearing: {
        ...h,
        date: h.date.toISOString(),
      },
    };
  }

  async gaoDetail(id: string) {
    const r = await this.prisma.gaoReport.findUnique({ where: { id } });
    if (!r) return null;
    return {
      report: {
        ...r,
        publishDate: r.publishDate?.toISOString() ?? null,
      },
    };
  }

  async crsDetail(id: string) {
    const r = await this.prisma.crsReport.findUnique({ where: { id } });
    if (!r) return null;
    return {
      report: {
        ...r,
        date: r.date?.toISOString() ?? null,
      },
    };
  }

  async fecDetail(id: string) {
    const c = await this.prisma.fecContribution.findUnique({ where: { id } });
    if (!c) return null;
    return {
      contribution: {
        ...c,
        amount: c.amount ? Number(c.amount) : 0,
        contributionDate: c.contributionDate?.toISOString() ?? null,
      },
    };
  }

  async faraDetail(id: string) {
    const r = await this.prisma.faraRegistration.findUnique({ where: { id } });
    if (!r) return null;
    return {
      registration: {
        ...r,
        registrationDate: r.registrationDate?.toISOString() ?? null,
        terminationDate: r.terminationDate?.toISOString() ?? null,
      },
    };
  }

  async secDetail(id: string) {
    const f = await this.prisma.secFiling.findUnique({ where: { id } });
    if (!f) return null;
    return {
      filing: {
        ...f,
        filingDate: f.filingDate.toISOString(),
        reportDate: f.reportDate?.toISOString() ?? null,
      },
    };
  }

  async intelArticleDetail(id: string) {
    const a = await this.prisma.intelArticle.findUnique({ where: { id } });
    if (!a) return null;
    return {
      article: {
        ...a,
        publishedAt: a.publishedAt.toISOString(),
      },
    };
  }

  /**
   * State Legislation Platform (S7.4) — additive fields beyond the pre-Phase-0
   * shape: status (S3 canonical derivation, already a plain column so free on
   * the base spread), actions[] (newest 15), votes[] (roll-call summaries —
   * NO per-member breakdown here, DD7 keeps this view metadata-only), versions[]
   * (metadata only, no text blobs — DD7), links[] (companions/same-as/etc.).
   * `state_roll_call_vote`/`state_bill_link` are SOFT refs (billKey nullable,
   * no enforced FK — S1.4/S4 tolerate an unlinked vote/target), so votes are a
   * separate query rather than a Prisma `include` relation.
   */
  async stateBillDetail(id: string) {
    const b = await this.prisma.stateBill.findUnique({
      where: { id },
      include: {
        actions: { orderBy: [{ date: 'desc' }, { orderKey: 'desc' }], take: 15 },
        versions: { orderBy: { date: 'desc' } },
        links: true,
      },
    });
    if (!b) return null;
    const votes = await this.prisma.stateRollCallVote.findMany({
      where: { billKey: id },
      orderBy: { date: 'desc' },
    });
    return {
      bill: {
        ...b,
        // 2026-07-10 hot-fix: the web drawer/drill-in reads `abstract` (the
        // DTO/schema-comment contract), but the raw Prisma row only has
        // `description` (LegiScan's own field name) — the Abstract section
        // was always dead. Reconciled here rather than renaming the schema
        // column, since `description` is the LegiScan-sourced field name
        // used elsewhere in ingestion.
        abstract: b.description ?? null,
        latestActionDate: b.latestActionDate?.toISOString() ?? null,
        statusAt: b.statusAt?.toISOString() ?? null,
        textDate: b.textDate?.toISOString() ?? null,
        actions: b.actions.map((a) => ({
          id: a.id,
          date: a.date.toISOString(),
          text: a.text,
          chamber: a.chamber,
        })),
        votes: votes.map((v) => ({
          id: v.id,
          date: v.date.toISOString(),
          motion: v.motion,
          chamber: v.chamber,
          yeas: v.yeas,
          nays: v.nays,
          nv: v.nv,
          absent: v.absent,
          passed: v.passed,
          sourceUrl: v.sourceUrl,
        })),
        versions: b.versions.map((v) => ({
          id: v.id,
          versionType: v.versionType,
          date: v.date.toISOString(),
          stateUrl: v.stateUrl,
        })),
        links: b.links.map((l) => ({
          id: l.id,
          linkType: l.linkType,
          relatedBillKey: l.relatedBillKey,
        })),
      },
    };
  }
}

function clampPageSize(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value < 1) return 25;
  return Math.min(value, 200);
}

function ldaSortClause(sort: string | undefined): Prisma.LdaFilingOrderByWithRelationInput {
  switch (sort) {
    case 'income':
      return { income: { sort: 'desc', nulls: 'last' } };
    case 'year':
      return { filingYear: 'desc' };
    case 'client':
      return { clientName: 'asc' };
    case 'registrant':
      return { registrantName: 'asc' };
    case 'recent':
    default:
      return { dtPosted: { sort: 'desc', nulls: 'last' } };
  }
}
