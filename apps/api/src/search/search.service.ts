import { federalHearingWhere } from '../hearing-discovery/hearing-geography.js';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Global keyword search across all ingested reference datasets (bills, awards,
 * LDA filings, hearings, SEC/FARA filings, GAO/CRS reports, regulatory dockets,
 * intel articles, state bills, federal register docs, program elements).
 *
 * These are GLOBAL read-only tables (not tenant-scoped) — the same federal data
 * every tenant sees — so we query `this.prisma.<model>` directly, no withTenant.
 * Each source runs a case-insensitive `contains` over its key text columns,
 * capped per-source, and results are normalized to a single shape the top-bar
 * search renders. No embeddings: this is exact/substring keyword lookup, which
 * is what a "jump to a bill/agency/stakeholder" search bar needs.
 */
export type SearchCategory =
  | 'bill'
  | 'award'
  | 'lda_filing'
  | 'hearing'
  | 'sec_filing'
  | 'fara_registration'
  | 'gao_report'
  | 'crs_report'
  | 'regulatory_docket'
  | 'intel_article'
  | 'state_bill'
  | 'federal_register'
  | 'program_element';

export interface SearchResult {
  category: SearchCategory;
  id: string;
  title: string;
  subtitle?: string | null;
  date?: string | null;
  /** Relative app route the UI can navigate to for this record. */
  href?: string | null;
}

export interface SearchResponse {
  query: string;
  total: number;
  results: SearchResult[];
  byCategory: Record<string, number>;
}

const PER_SOURCE_DEFAULT = 5;
const MIN_QUERY_LEN = 2;

@Injectable()
export class SearchService {
  private readonly logger = new Logger(SearchService.name);

  constructor(private readonly prisma: PrismaService) {}

  async search(rawQuery: string, perSource = PER_SOURCE_DEFAULT): Promise<SearchResponse> {
    const q = (rawQuery ?? '').trim();
    if (q.length < MIN_QUERY_LEN) {
      return { query: q, total: 0, results: [], byCategory: {} };
    }
    const take = Math.max(1, Math.min(perSource, 20));
    const contains = { contains: q, mode: 'insensitive' as const };

    // Run every source in parallel; a single source failing (e.g. a column
    // rename) must not blank the whole search, so each is wrapped fail-soft.
    const safe = async (fn: () => Promise<SearchResult[]>): Promise<SearchResult[]> => {
      try {
        return await fn();
      } catch (err) {
        this.logger.warn(`search source failed: ${(err as Error).message}`);
        return [];
      }
    };

    const [
      bills,
      awards,
      ldaFilings,
      hearings,
      secFilings,
      faraRegs,
      gaoReports,
      crsReports,
      dockets,
      intelArticles,
      stateBills,
      fedReg,
      programElements,
    ] = await Promise.all([
      safe(() => this.searchBills(contains, take)),
      safe(() => this.searchAwards(contains, take)),
      safe(() => this.searchLda(contains, take)),
      safe(() => this.searchHearings(contains, take)),
      safe(() => this.searchSec(contains, take)),
      safe(() => this.searchFara(contains, take)),
      safe(() => this.searchGao(contains, take)),
      safe(() => this.searchCrs(contains, take)),
      safe(() => this.searchDockets(contains, take)),
      safe(() => this.searchIntel(contains, take)),
      safe(() => this.searchStateBills(contains, take)),
      safe(() => this.searchFederalRegister(contains, take)),
      safe(() => this.searchProgramElements(contains, take)),
    ]);

    const results = [
      ...bills,
      ...awards,
      ...ldaFilings,
      ...hearings,
      ...secFilings,
      ...faraRegs,
      ...gaoReports,
      ...crsReports,
      ...dockets,
      ...intelArticles,
      ...stateBills,
      ...fedReg,
      ...programElements,
    ];

    const byCategory: Record<string, number> = {};
    for (const r of results) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;

    return { query: q, total: results.length, results, byCategory };
  }

  private iso(d: Date | null | undefined): string | null {
    return d ? new Date(d).toISOString().slice(0, 10) : null;
  }

  private async searchBills(
    c: { contains: string; mode: 'insensitive' },
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.congressBill.findMany({
      where: { OR: [{ title: c }, { billNumber: c }, { sponsorName: c }] },
      select: {
        id: true,
        billNumber: true,
        title: true,
        sponsorName: true,
        latestActionDate: true,
      },
      take,
      orderBy: { latestActionDate: 'desc' },
    });
    return rows.map((r) => ({
      category: 'bill' as const,
      id: r.id,
      title: `${r.billNumber} — ${r.title}`.slice(0, 200),
      subtitle: r.sponsorName ? `Sponsor: ${r.sponsorName}` : null,
      date: this.iso(r.latestActionDate),
      href: `/explorer/bills?q=${encodeURIComponent(r.billNumber)}`,
    }));
  }

  private async searchAwards(
    c: { contains: string; mode: 'insensitive' },
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.federalAward.findMany({
      where: { OR: [{ contractorName: c }, { awardingAgency: c }, { fundingTasTitle: c }] },
      select: { id: true, contractorName: true, awardingAgency: true, awardedAt: true },
      take,
      orderBy: { awardedAt: 'desc' },
    });
    return rows.map((r) => ({
      category: 'award' as const,
      id: r.id,
      title: r.contractorName ?? 'Federal award',
      subtitle: r.awardingAgency ? `Agency: ${r.awardingAgency}` : null,
      date: this.iso(r.awardedAt),
      href: `/explorer/contractors?q=${encodeURIComponent(r.contractorName ?? '')}`,
    }));
  }

  private async searchLda(
    c: { contains: string; mode: 'insensitive' },
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.ldaFiling.findMany({
      where: { OR: [{ clientName: c }, { registrantName: c }] },
      select: { id: true, clientName: true, registrantName: true, dtPosted: true },
      take,
      orderBy: { dtPosted: 'desc' },
    });
    return rows.map((r) => ({
      category: 'lda_filing' as const,
      id: r.id,
      title: r.clientName || r.registrantName || 'LDA filing',
      subtitle: r.registrantName ? `Registrant: ${r.registrantName}` : null,
      date: this.iso(r.dtPosted),
      href: `/explorer/lda?q=${encodeURIComponent(r.clientName || r.registrantName || '')}`,
    }));
  }

  private async searchHearings(
    c: { contains: string; mode: 'insensitive' },
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.committeeHearing.findMany({
      where: federalHearingWhere({ OR: [{ title: c }, { committeeName: c }] }),
      select: { id: true, title: true, committeeName: true, date: true },
      take,
      orderBy: { date: 'desc' },
    });
    return rows.map((r) => ({
      category: 'hearing' as const,
      id: r.id,
      title: r.title.slice(0, 200),
      subtitle: r.committeeName ? `Committee: ${r.committeeName}` : null,
      date: this.iso(r.date),
      href: `/explorer/hearings?q=${encodeURIComponent(r.title.slice(0, 60))}`,
    }));
  }

  private async searchSec(
    c: { contains: string; mode: 'insensitive' },
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.secFiling.findMany({
      where: { companyName: c },
      select: { id: true, companyName: true, filingDate: true },
      take,
      orderBy: { filingDate: 'desc' },
    });
    return rows.map((r) => ({
      category: 'sec_filing' as const,
      id: r.id,
      title: r.companyName,
      subtitle: 'SEC filing',
      date: this.iso(r.filingDate),
      href: null,
    }));
  }

  private async searchFara(
    c: { contains: string; mode: 'insensitive' },
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.faraRegistration.findMany({
      where: { registrantName: c },
      select: { id: true, registrantName: true, registrationDate: true },
      take,
      orderBy: { registrationDate: 'desc' },
    });
    return rows.map((r) => ({
      category: 'fara_registration' as const,
      id: r.id,
      title: r.registrantName,
      subtitle: 'FARA registration',
      date: this.iso(r.registrationDate),
      href: null,
    }));
  }

  private async searchGao(
    c: { contains: string; mode: 'insensitive' },
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.gaoReport.findMany({
      where: { OR: [{ title: c }, { id: c }] },
      select: { id: true, title: true, publishDate: true },
      take,
      orderBy: { publishDate: 'desc' },
    });
    return rows.map((r) => ({
      category: 'gao_report' as const,
      id: r.id,
      title: `${r.id} — ${r.title}`.slice(0, 200),
      subtitle: 'GAO report',
      date: this.iso(r.publishDate),
      href: null,
    }));
  }

  private async searchCrs(
    c: { contains: string; mode: 'insensitive' },
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.crsReport.findMany({
      where: { OR: [{ title: c }, { id: c }] },
      select: { id: true, title: true, date: true },
      take,
      orderBy: { date: 'desc' },
    });
    return rows.map((r) => ({
      category: 'crs_report' as const,
      id: r.id,
      title: `${r.id} — ${r.title}`.slice(0, 200),
      subtitle: 'CRS report',
      date: this.iso(r.date),
      href: null,
    }));
  }

  private async searchDockets(
    c: { contains: string; mode: 'insensitive' },
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.regulatoryDocket.findMany({
      where: { title: c },
      select: { id: true, title: true, postedDate: true },
      take,
      orderBy: { postedDate: 'desc' },
    });
    return rows.map((r) => ({
      category: 'regulatory_docket' as const,
      id: r.id,
      title: r.title.slice(0, 200),
      subtitle: 'Regulatory docket',
      date: this.iso(r.postedDate),
      href: null,
    }));
  }

  private async searchIntel(
    c: { contains: string; mode: 'insensitive' },
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.intelArticle.findMany({
      where: { OR: [{ title: c }, { summary: c }] },
      select: { id: true, title: true, publishedAt: true },
      take,
      orderBy: { publishedAt: 'desc' },
    });
    return rows.map((r) => ({
      category: 'intel_article' as const,
      id: r.id,
      title: r.title.slice(0, 200),
      subtitle: 'Intel article',
      date: this.iso(r.publishedAt),
      href: null,
    }));
  }

  private async searchStateBills(
    c: { contains: string; mode: 'insensitive' },
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.stateBill.findMany({
      where: { OR: [{ title: c }, { sponsorName: c }] },
      select: { id: true, title: true, sponsorName: true, latestActionDate: true },
      take,
      orderBy: { latestActionDate: 'desc' },
    });
    return rows.map((r) => ({
      category: 'state_bill' as const,
      id: r.id,
      title: r.title.slice(0, 200),
      subtitle: r.sponsorName ? `Sponsor: ${r.sponsorName}` : 'State bill',
      date: this.iso(r.latestActionDate),
      href: null,
    }));
  }

  private async searchFederalRegister(
    c: { contains: string; mode: 'insensitive' },
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.federalRegisterDocument.findMany({
      where: { title: c },
      select: { id: true, documentNumber: true, title: true, publicationDate: true },
      take,
      orderBy: { publicationDate: 'desc' },
    });
    return rows.map((r) => ({
      category: 'federal_register' as const,
      id: r.id,
      title: r.title.slice(0, 200),
      subtitle: `Federal Register ${r.documentNumber}`,
      date: this.iso(r.publicationDate),
      href: `/explorer/federal-register?q=${encodeURIComponent(r.documentNumber)}`,
    }));
  }

  /**
   * Defense Program Elements (PE codes). Global reference data — same table the
   * PE finder uses. Soft-retired rows stay out of search so Context accept cannot
   * pin a PE that list/detail already hide by default.
   *
   * Locator id is the PE code (primary key), not a surrogate UUID.
   */
  private async searchProgramElements(
    c: { contains: string; mode: 'insensitive' },
    take: number,
  ): Promise<SearchResult[]> {
    const rows = await this.prisma.programElement.findMany({
      where: {
        retiredAt: null,
        OR: [
          { peCode: c },
          { title: c },
          { service: c },
          { budgetActivity: c },
          { budgetActivityName: c },
          { programOfRecord: c },
          { description: c },
        ],
      },
      select: {
        peCode: true,
        title: true,
        service: true,
        budgetActivity: true,
        budgetActivityName: true,
        lastSyncedAt: true,
      },
      take,
      orderBy: [{ peCode: 'asc' }],
    });
    return rows.map((r) => {
      const service = r.service?.trim() || null;
      const ba = r.budgetActivityName?.trim() || r.budgetActivity?.trim() || null;
      const subtitleParts = [service, ba ? `BA ${ba}` : null].filter(Boolean);
      return {
        category: 'program_element' as const,
        id: r.peCode,
        title: `${r.peCode} — ${r.title}`.slice(0, 200),
        subtitle: subtitleParts.length ? subtitleParts.join(' · ') : 'Program element',
        date: this.iso(r.lastSyncedAt),
        href: `/program-elements/${encodeURIComponent(r.peCode)}`,
      };
    });
  }
}
