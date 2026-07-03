import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import LRUCache = require('lru-cache');
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientPeRelevanceService } from '../intelligence/client-pe-relevance.service.js';
import { EMBEDDING_MODEL } from '../embeddings/embedder.js';
import { ConferenceProbabilityService } from './models/conference-probability.service.js';
import { compareProofPackSources } from './proof-pack.js';
import { confidenceBand } from './matching/program-match-thresholds.js';
import { computePbComparison, type BudgetPositionLike } from './budget-position.js';
import { normalizeServiceFilter } from './service-filter.js';
import { buildIntelligence } from './intelligence/build-intelligence.js';

export interface ProgramElementListQuery {
  service?: string;
  budgetActivity?: string;
  q?: string;
  page?: number;
  limit?: number;
  mode?: 'markup-monitor';
  divergenceThreshold?: number;
  /** 'true' restricts to PEs with at least one data signal (year/award/bill). */
  hasData?: string;
}

/**
 * One committee-report provision surfaced on a PE profile (Step 2.4 follow-on). Joins a
 * provision_pe_link (matchBasis/reviewStatus/confidence) to its committee_report_provision
 * (committee/fy/heading/text/pages/actionType) and the provision's SourceDocument
 * (sourceUrl). The shape the web "Report language" panel renders.
 */
export interface ProvisionItem {
  id: string;
  committee: string;
  fy: number;
  heading: string;
  text: string;
  pageStart: number | null;
  pageEnd: number | null;
  actionType: string | null;
  /** From the provision's SourceDocument when present (deep-link to the report); else null. */
  sourceUrl: string | null;
  matchBasis: string;
  reviewStatus: string;
  confidence: number;
}

/**
 * Step 3.1 — one SAM.gov procurement notice surfaced on a PE profile. Joins a
 * SamOpportunityMatch (matchBasis/reviewStatus/confidence/peCode) to its SamOpportunity
 * (the notice metadata + the public procurement POC). The shape the web "Procurement
 * activity" panel renders. The POC is the OFFICIAL contracting contact — it is surfaced
 * for provenance, NEVER as a lobbying/outreach target.
 */
export interface OpportunityItem {
  id: string;
  noticeId: string;
  title: string;
  noticeType: string;
  agency: string | null;
  office: string | null;
  pscCode: string | null;
  naicsCode: string | null;
  postedDate: Date | null;
  responseDeadline: Date | null;
  sourceUrl: string | null;
  pocName: string | null;
  pocEmail: string | null;
  matchBasis: string;
  reviewStatus: string;
  confidence: number;
}

/**
 * Cap on the number of not-already-matched candidate PEs the needs-attention feed probes
 * against the relevance service per request. Each probe is its own withTenant transaction,
 * so this bounds a new tenant's (no watches/caps) request to MAX_RELEVANCE_PROBES sequential
 * scoring transactions instead of one per over-fetched PE.
 */
const MAX_RELEVANCE_PROBES = 50;

@Injectable()
export class ProgramElementReadService {
  private readonly detailCache = new LRUCache<string, Record<string, unknown>>({
    ttl: 60_000,
    max: 500,
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly conferenceProbabilityService: ConferenceProbabilityService,
    // Step 2.3 — explainable client⇄PE relevance. Optional only so the narrow
    // reconciliation-resolve unit spec (which constructs this service directly and never
    // touches the needs-attention path) keeps compiling; Nest always injects it in prod.
    private readonly relevanceService?: ClientPeRelevanceService,
  ) {}

  async listProgramElements(query: ProgramElementListQuery, ctx?: TenantContext) {
    if (query.mode === 'markup-monitor') {
      return this.listMarkupMonitor(query, ctx);
    }

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));

    const service = normalizeServiceFilter(query.service);
    const budgetActivity = query.budgetActivity?.trim();
    const q = query.q?.trim();
    const hasDataOnly = query.hasData === 'true';

    type ListRow = {
      peCode: string;
      title: string;
      service: string | null;
      budgetActivity: string | null;
      appropriationType: string | null;
      status: string | null;
      lastSyncedAt: Date;
      hasData: boolean;
      totalCount: number;
    };

    // A PE "has data" if it has at least one FY history row, a PE-linked federal
    // award, or a bill that references it. Computed once per row via EXISTS so the
    // finder can flag (and optionally hide) sparse PEs whose detail panels are empty.
    const hasDataExpr = Prisma.sql`(
      EXISTS (SELECT 1 FROM program_element_year y WHERE y.pe_code = pe.pe_code)
      OR EXISTS (SELECT 1 FROM federal_award fa WHERE fa.pe_code = pe.pe_code)
      OR EXISTS (SELECT 1 FROM congress_bill b WHERE pe.pe_code = ANY(b.pe_codes))
    )`;

    const rows = await this.prisma.$queryRaw<ListRow[]>(Prisma.sql`
      WITH filtered AS (
        SELECT
          pe.pe_code,
          pe.title,
          pe.service,
          pe.budget_activity,
          pe.appropriation_type,
          pe.status,
          pe.last_synced_at,
          ${hasDataExpr} AS has_data,
          CASE WHEN ${q ? 1 : 0} = 1 THEN GREATEST(similarity(pe.title, ${q ?? ''}), 0) ELSE 0 END AS score
        FROM program_element pe
        WHERE pe.retired_at IS NULL
          AND (${service ? Prisma.sql`pe.service ILIKE ${service}` : Prisma.sql`TRUE`})
          AND (${budgetActivity ? Prisma.sql`pe.budget_activity ILIKE ${budgetActivity}` : Prisma.sql`TRUE`})
          AND (${hasDataOnly ? hasDataExpr : Prisma.sql`TRUE`})
          AND (
            ${q ? Prisma.sql`pe.title ILIKE ${`%${q}%`} OR pe.pe_code ILIKE ${`%${q}%`} OR similarity(pe.title, ${q}) > 0.2` : Prisma.sql`TRUE`}
          )
      )
      SELECT
        pe_code AS "peCode",
        title,
        service,
        budget_activity AS "budgetActivity",
        appropriation_type AS "appropriationType",
        status,
        last_synced_at AS "lastSyncedAt",
        has_data AS "hasData",
        COUNT(*) OVER()::int AS "totalCount"
      FROM filtered
      ORDER BY
        CASE WHEN ${q ? 1 : 0} = 1 THEN score ELSE NULL END DESC,
        service ASC NULLS LAST,
        pe_code ASC
      LIMIT ${limit}
      OFFSET ${(page - 1) * limit}
    `);

    const total = rows[0]?.totalCount ?? 0;
    return {
      data: rows.map(({ totalCount: _ignored, ...rest }) => rest),
      total,
      page,
      limit,
    };
  }

  private async listMarkupMonitor(query: ProgramElementListQuery, ctx?: TenantContext) {
    const service = normalizeServiceFilter(query.service);
    const divergenceThreshold = query.divergenceThreshold ?? 0;

    if (!ctx?.tenantId) {
      return { data: [], total: 0, page: 1, limit: 0 };
    }

    type MarkupMonitorRow = {
      peCode: string;
      title: string;
      service: string | null;
      request: number | null;
      hascMark: number | null;
      sascMark: number | null;
      hacDMark: number | null;
      sacDMark: number | null;
      divergencePct: number;
      totalCount: number;
    };

    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRaw<MarkupMonitorRow[]>(Prisma.sql`
        WITH watched AS (
          SELECT DISTINCT pew.pe_code
          FROM program_element_watch pew
          WHERE pew.tenant_id = ${ctx.tenantId}::uuid
        ),
        current_cycle AS (
          SELECT DISTINCT ON (pey.pe_code)
            pey.pe_code,
            pey.fy,
            pey.request,
            pey.hasc_mark,
            pey.sasc_mark,
            pey.hac_d_mark,
            pey.sac_d_mark
          FROM program_element_year pey
          JOIN watched w ON w.pe_code = pey.pe_code
          ORDER BY pey.pe_code, pey.fy DESC
        ),
        enriched AS (
          SELECT
            pe.pe_code AS "peCode",
            pe.title,
            pe.service,
            cc.request::double precision AS request,
            cc.hasc_mark::double precision AS "hascMark",
            cc.sasc_mark::double precision AS "sascMark",
            cc.hac_d_mark::double precision AS "hacDMark",
            cc.sac_d_mark::double precision AS "sacDMark",
            CASE
              WHEN cc.request IS NULL OR cc.request = 0 THEN 0
              ELSE (
                (
                  GREATEST(
                    COALESCE(cc.hasc_mark, cc.request),
                    COALESCE(cc.sasc_mark, cc.request),
                    COALESCE(cc.hac_d_mark, cc.request),
                    COALESCE(cc.sac_d_mark, cc.request)
                  )
                  -
                  LEAST(
                    COALESCE(cc.hasc_mark, cc.request),
                    COALESCE(cc.sasc_mark, cc.request),
                    COALESCE(cc.hac_d_mark, cc.request),
                    COALESCE(cc.sac_d_mark, cc.request)
                  )
                ) / cc.request::double precision
              ) * 100
            END AS "divergencePct"
          FROM current_cycle cc
          JOIN program_element pe ON pe.pe_code = cc.pe_code
          WHERE pe.retired_at IS NULL
            AND (${service ? Prisma.sql`pe.service ILIKE ${service}` : Prisma.sql`TRUE`})
        )
        SELECT
          "peCode",
          title,
          service,
          request,
          "hascMark",
          "sascMark",
          "hacDMark",
          "sacDMark",
          "divergencePct",
          COUNT(*) OVER()::int AS "totalCount"
        FROM enriched
        WHERE "divergencePct" >= ${divergenceThreshold}
        ORDER BY "divergencePct" DESC, "peCode" ASC
      `),
    );

    const total = rows[0]?.totalCount ?? 0;
    return {
      data: rows.map(({ totalCount: _ignored, ...rest }) => rest),
      total,
      page: 1,
      limit: rows.length,
    };
  }

  /**
   * Intelligence verdict for one budget line (product plan F1 chips): committee
   * posture, procurement runway, acquisition maturity, anomalies — computed by
   * the pure classifiers over the line's stored rows. Tenant-agnostic reference
   * data; small queries, no cache (the underlying rows change only on loads).
   */
  async getIntelligence(peCode: string) {
    const code = peCode.toUpperCase();
    const pe = await this.prisma.programElement.findUnique({
      where: { peCode: code },
      select: {
        peCode: true,
        appropriationType: true,
        budgetActivity: true,
        years: {
          orderBy: { fy: 'asc' },
          select: {
            fy: true, request: true, hascMark: true, sascMark: true,
            hacDMark: true, sacDMark: true, conference: true, enacted: true,
          },
        },
      },
    });
    if (!pe) throw new NotFoundException(`Unknown program element ${peCode}`);
    const dec = (v: unknown): number | null =>
      v === null || v === undefined ? null : Number(v);
    const years = pe.years.map((y) => ({
      fy: y.fy,
      request: dec(y.request), hascMark: dec(y.hascMark), sascMark: dec(y.sascMark),
      hacDMark: dec(y.hacDMark), sacDMark: dec(y.sacDMark),
      conference: dec(y.conference), enacted: dec(y.enacted),
    }));
    // Stated FYDP outyears (PB budget positions) extend the runway series.
    const positions = await this.prisma.programElementBudgetPosition.findMany({
      where: { peCode: code, valueKind: 'total', positionCycle: { startsWith: 'pb_' } },
      select: { assertedFy: true, amount: true },
    });
    const maxYearFy = years.reduce((m, y) => Math.max(m, y.fy), 0);
    const outyears = positions
      .filter((o) => o.assertedFy > maxYearFy)
      .map((o) => ({ fy: o.assertedFy, amount: dec(o.amount) }));
    const line = await this.prisma.programElementProcurementLine.findFirst({
      where: { peCode: code, quantity: { not: null } },
      orderBy: { fy: 'desc' },
      select: { quantity: true },
    });
    return {
      peCode: pe.peCode,
      ...buildIntelligence({
        appropriationType: pe.appropriationType,
        budgetActivity: pe.budgetActivity,
        years,
        outyears,
        quantity: line ? dec(line.quantity) : null,
      }),
    };
  }

  async getProgramElement(peCode: string, ctx: TenantContext) {
    const cacheKey = peCode.toUpperCase();

    const watch = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM program_element_watch
        WHERE user_id = ${ctx.userId}::uuid
          AND pe_code = ${peCode}
        LIMIT 1
      `),
    );

    const cached = this.detailCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        currentUserIsWatching: Boolean(watch[0]),
      };
    }

    // The base Program Element row is authoritative for every field the detail
    // view renders — appropriation type, status, first-seen FY — AND it carries
    // the COMPLETE budget-year history. The FY timeline chart, the per-FY mark
    // drawer, and the win-rate calc all need every year, not just the latest, so
    // we always hydrate the full `years` relation here (ascending by FY).
    const programElement = await this.prisma.programElement.findUnique({
      where: { peCode },
      include: {
        years: {
          orderBy: { fy: 'asc' },
        },
      },
    });

    if (!programElement) {
      throw new NotFoundException(`Program element ${peCode} not found`);
    }

    // Best-effort enrichment from the detail materialized view: it precomputes
    // the (expensive) count of bills touching this PE. The MV can be absent or
    // stale on a fresh database, so a miss is non-fatal — the detail above still
    // renders fully from the authoritative base row.
    const mvRows = await this.prisma
      .$queryRaw<Array<{ billCount: number | null }>>(
        Prisma.sql`
        SELECT bill_count::int AS "billCount"
        FROM program_element_detail_mv
        WHERE pe_code = ${peCode}
        LIMIT 1
      `,
      )
      .catch(() => [] as Array<{ billCount: number | null }>);

    // Cheap counts so the profile can badge "Projects (n)" / "Sources (n)" and lazy-load the
    // panels only when present (Step 1.2). Cached with the rest of the detail.
    const [projectCount, sourceCount] = await Promise.all([
      this.prisma.programElementProject.count({ where: { peCode } }),
      this.prisma.programElementSource.count({ where: { peCode } }),
    ]);

    const detail: Record<string, unknown> = {
      ...programElement,
      billCount: mvRows[0]?.billCount ?? null,
      projectCount,
      sourceCount,
    };

    this.detailCache.set(cacheKey, detail);

    return {
      ...detail,
      currentUserIsWatching: Boolean(watch[0]),
    };
  }

  async getTimeline(peCode: string) {
    const programElement = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!programElement) throw new NotFoundException(`Program element ${peCode} not found`);

    const [years, milestones] = await Promise.all([
      this.prisma.programElementYear.findMany({
        where: { peCode },
        orderBy: { fy: 'asc' },
      }),
      this.prisma.programElementMilestone.findMany({
        where: { peCode },
        orderBy: [{ plannedDate: 'asc' }, { milestoneType: 'asc' }],
      }),
    ]);

    const yearsWithConferenceProbability = await Promise.all(
      years.map(async (year) => {
        const prediction = await this.conferenceProbabilityService.predict(peCode, year.fy);
        return {
          ...year,
          conferenceProbability: prediction?.predicted ?? null,
          conferenceProbabilityCiLow: prediction?.ciLow ?? null,
          conferenceProbabilityCiHigh: prediction?.ciHigh ?? null,
          conferenceProbabilityConfidence: prediction?.confidence ?? null,
        };
      }),
    );

    return {
      peCode,
      years: yearsWithConferenceProbability,
      milestones,
    };
  }

  async getBills(peCode: string) {
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    const bills = await this.prisma.congressBill.findMany({
      where: { peCodes: { has: peCode } },
      orderBy: [{ latestActionDate: 'desc' }, { introducedDate: 'desc' }],
      take: 100,
      select: {
        id: true,
        congress: true,
        billType: true,
        billNumber: true,
        title: true,
        policyArea: true,
        latestActionText: true,
        latestActionDate: true,
        url: true,
        sponsorName: true,
        peCodes: true,
        committeeRefs: {
          select: { committeeName: true },
          take: 1,
        },
      },
    });

    // Flatten the sponsor + lead committee onto each bill so the "Bills touching
    // this PE" panel can show real attribution instead of "N/A". passageProbability
    // is intentionally omitted — Congress.gov gives us no such signal, so the UI
    // shows honest metadata (sponsor, committee, latest action) rather than a
    // fabricated score.
    //
    // peCodeCount = how many distinct PEs this bill references. This is the signal
    // the UI needs to stop showing "the same two bills on every PE": the annual
    // NDAA references 700+ PEs (it authorizes nearly all of them), so it surfaces
    // on every program element and tells a lobbyist nothing PE-specific. A bill
    // that names a handful of PEs is genuinely targeting this one. We sort the
    // PE-specific bills first (fewest PEs), then by recency, and tag the blanket
    // authorizers so the panel can label + de-emphasize them rather than hide
    // real legislation.
    const mapped = bills.map(({ committeeRefs, sponsorName, peCodes, ...bill }) => ({
      ...bill,
      sponsor: sponsorName,
      committee: committeeRefs[0]?.committeeName ?? null,
      peCodeCount: peCodes?.length ?? 0,
    }));
    mapped.sort((a, b) => {
      // PE-specific bills (fewer PEs) ahead of blanket authorizers.
      if (a.peCodeCount !== b.peCodeCount) return a.peCodeCount - b.peCodeCount;
      // Then most-recent action first (nulls last).
      const at = a.latestActionDate ? new Date(a.latestActionDate).getTime() : 0;
      const bt = b.latestActionDate ? new Date(b.latestActionDate).getTime() : 0;
      return bt - at;
    });
    return mapped;
  }

  async getContractors(peCode: string) {
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    const tableExists = await this.prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'federal_award'
      ) AS "exists"
    `);

    if (!tableExists[0]?.exists) {
      return {
        data: [],
        todo: 'federal_award table not yet created (Step 28)',
      };
    }

    type ContractorRow = { contractorName: string; amount: number; awards: number; source: string };
    // federal_award.amount is stored in raw obligated DOLLARS, but the UI renders
    // contractor totals in millions ($X.XM / $X.XB) — divide by 1e6 here so the
    // panel shows the right magnitude. The 24-month window keys off the action
    // date with awarded_at as a fallback, because USAspending often leaves
    // awarded_at null while action_date is always populated.
    //
    // Linkage is two-tier and labeled for honest provenance:
    //   (a) direct: federal_award.pe_code = this PE (explicit/legacy resolution).
    //   (b) program: awards whose DoD acquisition (MDAP) program code maps to this
    //       PE via the reviewed program_element_acquisition_program table. This is
    //       the production tier — USAspending carries no PE on contracts, but it
    //       always carries the program code, and the PE link is curated, so the
    //       attribution is defensible ("primes on this program") rather than empty
    //       or fabricated.
    // A contractor reached by BOTH tiers is counted once; an award is matched by
    // pe_code OR program code (DISTINCT award id) so dollars are never double-added.
    const rows = await this.prisma.$queryRaw<ContractorRow[]>(Prisma.sql`
      WITH linked_programs AS (
        SELECT acq_program_code
        FROM program_element_acquisition_program
        WHERE pe_code = ${peCode}
      ),
      matched AS (
        SELECT DISTINCT ON (fa.id)
          fa.id,
          fa.contractor_name,
          fa.amount,
          CASE WHEN fa.pe_code = ${peCode} THEN 'direct' ELSE 'program' END AS match_kind
        FROM federal_award fa
        WHERE fa.contractor_name IS NOT NULL
          AND COALESCE(fa.action_date, fa.awarded_at::date) >= (NOW() - INTERVAL '24 months')::date
          AND (
            fa.pe_code = ${peCode}
            OR fa.dod_acq_program_code IN (SELECT acq_program_code FROM linked_programs)
          )
      )
      SELECT
        contractor_name AS "contractorName",
        (COALESCE(SUM(amount), 0) / 1e6)::double precision AS amount,
        COUNT(*)::int AS awards,
        CASE WHEN bool_or(match_kind = 'direct') THEN 'direct' ELSE 'program' END AS source
      FROM matched
      GROUP BY contractor_name
      ORDER BY amount DESC
      LIMIT 10
    `);

    // Provenance the UI can render verbatim so users know HOW a contractor was
    // tied to this PE. 'program' = linked via the contract's DoD acquisition
    // program code; 'direct' = the award itself carried this PE code.
    const data = rows.map((r) => ({
      ...r,
      attribution:
        r.source === 'direct'
          ? 'Award attributed to this program element'
          : 'Linked via DoD Acquisition Program (USAspending)',
    }));

    // ── Layer 1 (PRIMARY): named primes straight from the Service's own R-3
    // "Product Development" exhibit. Zero inference — the government names the
    // performing activity per PE. We surface real named companies (isNamedCompany)
    // first; this is the defensible "who are the primes on this program" answer and
    // is independent of whether USAspending dollars have been linked yet.
    let namedPrimes: Array<{
      contractorName: string;
      location: string | null;
      contractMethod: string | null;
      totalCostM: number | null;
      fy: number | null;
      sourceUrl: string | null;
      pageNumber: number | null;
      publisher: string | null;
      attribution: string;
    }> = [];
    const performerTableExists = await this.prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'program_element_performer'
      ) AS "exists"
    `);
    if (performerTableExists[0]?.exists) {
      // Aggregate per company (a prime can appear under several cost categories);
      // keep the richest provenance row (max total cost) for the deep-link.
      const primeRows = await this.prisma.$queryRaw<
        Array<{
          contractorName: string;
          location: string | null;
          contractMethod: string | null;
          totalCostM: number | null;
          fy: number | null;
          sourceUrl: string | null;
          pageNumber: number | null;
          publisher: string | null;
        }>
      >(Prisma.sql`
        SELECT DISTINCT ON (performer_normalized)
          performer        AS "contractorName",
          NULLIF(location, '') AS "location",
          NULLIF(contract_method, '') AS "contractMethod",
          total_cost_m::double precision AS "totalCostM",
          fy               AS "fy",
          source_url       AS "sourceUrl",
          page_number      AS "pageNumber",
          publisher        AS "publisher"
        FROM program_element_performer
        WHERE pe_code = ${peCode}
          AND is_named_company = true
        ORDER BY performer_normalized, total_cost_m DESC NULLS LAST, fy DESC
      `);
      namedPrimes = primeRows
        .map((r) => ({
          ...r,
          attribution: `Named prime per ${r.publisher ?? 'DoD'} FY${r.fy ?? ''} R-3 exhibit${r.pageNumber ? ` (p. ${r.pageNumber})` : ''}`,
        }))
        // Highest stated contract value first; null costs (e.g. support rows) after.
        .sort((a, b) => (b.totalCostM ?? -1) - (a.totalCostM ?? -1))
        .slice(0, 25);
    }

    return {
      // Named primes from the budget exhibit (Layer 1) — the primary, precise answer.
      namedPrimes,
      // Award dollar-flow over the last 24 months (Layer 2/3 — direct pe_code,
      // MDAP-program link, or UEI-confirmed R-3 prime via enrich-award-pe-tas).
      data,
      todo: null,
    };
  }

  /**
   * Secondary Distribution per-recipient procurement line items for a PE (P-40).
   * Each row is (recipient lineDescription × fiscal year) carrying quantity +
   * obligation-authority dollars. Ordered by recipient then FY so the UI can
   * render a per-recipient multi-year table. Empty array (never an error) when
   * this PE has no procurement lines (e.g. RDT&E PEs, or PROC PEs whose book had
   * no Secondary Distribution block). Returns the distinct fiscal years present
   * so the panel can build a stable column header.
   */
  async getProcurementLines(peCode: string) {
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    const rows = await this.prisma.programElementProcurementLine.findMany({
      where: { peCode },
      orderBy: [{ lineDescription: 'asc' }, { fy: 'asc' }],
      select: {
        id: true,
        lineDescription: true,
        fy: true,
        quantity: true,
        dollars: true,
        unitCost: true,
        source: true,
        sourceUrl: true,
      },
    });

    // Convert Prisma Decimals to numbers for the wire; group by recipient.
    const num = (d: Prisma.Decimal | null): number | null => (d == null ? null : Number(d));
    const years = Array.from(new Set(rows.map((r) => r.fy))).sort((a, b) => a - b);
    const byRecipient = new Map<
      string,
      Array<{ fy: number; quantity: number | null; dollars: number | null; unitCost: number | null }>
    >();
    for (const r of rows) {
      if (!byRecipient.has(r.lineDescription)) byRecipient.set(r.lineDescription, []);
      byRecipient.get(r.lineDescription)!.push({
        fy: r.fy,
        quantity: num(r.quantity),
        dollars: num(r.dollars),
        unitCost: num(r.unitCost),
      });
    }
    const recipients = Array.from(byRecipient.entries()).map(([recipient, fyRows]) => ({
      recipient,
      fyRows,
    }));
    const sourceUrl = rows.find((r) => r.sourceUrl)?.sourceUrl ?? null;

    return { peCode, years, recipients, sourceUrl, totalRows: rows.length };
  }

  /**
   * R-2A projects/sub-elements for a PE (Step 1.2). Ordered by project code; each carries
   * its own page-level citation (sourceUrl + pageNumber) so the UI can deep-link to the
   * exact exhibit page. Empty array (never an error) when this PE has no extracted projects.
   */
  async getProjects(peCode: string) {
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    return this.prisma.programElementProject.findMany({
      where: { peCode },
      orderBy: [{ projectCode: 'asc' }],
      select: {
        id: true,
        projectCode: true,
        title: true,
        mission: true,
        budgetActivity: true,
        fy: true,
        sourceUrl: true,
        pageNumber: true,
        confidence: true,
      },
    });
  }

  /**
   * Proof-pack: every page-level citation for a PE (Step 1.2, §11), each joined to its
   * SourceDocument (title/budgetCycle/sha256) and ordered in document order (R-1 → R-2 →
   * R-2A → R-3 → P-1 → P-40), then FY desc, page asc — so the UI can render "show me the
   * source" with an open-at-page deep link.
   */
  async getSources(peCode: string) {
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    const rows = await this.prisma.programElementSource.findMany({
      where: { peCode },
      select: {
        id: true,
        docType: true,
        exhibitType: true,
        fy: true,
        sourceUrl: true,
        pageNumber: true,
        pageEnd: true,
        snippet: true,
        publisher: true,
        confidence: true,
        sourceDocument: { select: { title: true, budgetCycle: true, sha256: true } },
      },
    });

    return [...rows].sort((a, b) => compareProofPackSources(a, b));
  }

  /**
   * Budget positions for a PE (Step 1.3) — every (positionCycle, assertedFy, valueKind)
   * value a budget book asserts, optionally filtered to a single assertedFy. Each row
   * carries its page-level citation so the UI can deep-link to the exhibit page. Empty
   * array (never an error) when this PE has no loaded positions yet — which is the case
   * today, since the committed R-1 artifact carries no per-line dollar columns
   * (DATA-PENDING: see budget-position-writer.ts). Ordered by FY then cycle.
   */
  async getBudgetPositions(peCode: string, fy?: number) {
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    return this.prisma.programElementBudgetPosition.findMany({
      where: { peCode, ...(fy !== undefined ? { assertedFy: fy } : {}) },
      orderBy: [{ assertedFy: 'asc' }, { positionCycle: 'asc' }, { valueKind: 'asc' }],
      select: {
        positionCycle: true,
        assertedFy: true,
        amount: true,
        quantity: true,
        valueKind: true,
        sourceUrl: true,
        pageNumber: true,
      },
    });
  }

  /**
   * PB-vs-prior-PB comparison for a PE (Step 1.3, plan §5). For each assertedFy present
   * across the two most-recent PB cycles → {assertedFy, pbCurrent, pbPrior, deltaAbs,
   * deltaPct, newInPb, droppedFromPb}. The math is a PURE, unit-tested helper
   * (computePbComparison); this method only fetches the value_kind='total' positions and
   * delegates. Returns [] (honest empty) when fewer than two PB books are loaded — which
   * is the case today (DATA-PENDING: the FY2026 prior PB book is not yet loaded).
   */
  async getPbComparison(peCode: string) {
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    const positions = await this.prisma.programElementBudgetPosition.findMany({
      where: { peCode, valueKind: 'total' },
      select: { positionCycle: true, assertedFy: true, amount: true, valueKind: true },
    });

    // Decimal columns arrive as Prisma.Decimal; the pure helper coerces via Number().
    const comparison = computePbComparison(
      positions.map(
        (p): BudgetPositionLike => ({
          positionCycle: p.positionCycle,
          assertedFy: p.assertedFy,
          amount: p.amount as unknown as number | string | null,
          valueKind: p.valueKind,
        }),
      ),
    );
    return { peCode, comparison };
  }

  /**
   * Step 1.4 — typed, materiality-scored budget deltas for a PE (LIVE rows only — superseded
   * history excluded), most material first. Paginated; optional deltaType / assertedFy filter.
   */
  async getDeltas(
    peCode: string,
    opts: { deltaType?: string; fy?: number; page?: number; limit?: number } = {},
  ) {
    const exists = await this.prisma.programElement.findUnique({ where: { peCode }, select: { peCode: true } });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const page = Math.max(opts.page ?? 1, 1);
    const where = {
      peCode,
      supersededAt: null,
      ...(opts.deltaType ? { deltaType: opts.deltaType } : {}),
      ...(opts.fy !== undefined ? { assertedFy: opts.fy } : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.programElementDelta.findMany({
        where,
        orderBy: [{ materialityScore: 'desc' }, { computedAt: 'desc' }],
        skip: (page - 1) * take,
        take,
      }),
      this.prisma.programElementDelta.count({ where }),
    ]);
    return { data, total, page, limit: take };
  }

  /**
   * Step 1.4 — cross-PE "needs attention" feed: live deltas at/above minScore, sorted by
   * materiality. clientRelevance is applied PER-TENANT at READ time (a delta on a PE the tenant
   * watches or has a client capability for is flagged + floated up) and is NEVER stored globally.
   */
  async getNeedsAttention(
    ctx: TenantContext,
    opts: { minScore?: number; fy?: number; limit?: number } = {},
  ) {
    const minScore = opts.minScore ?? 0.4;
    const take = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = await this.prisma.programElementDelta.findMany({
      where: {
        supersededAt: null,
        materialityScore: { gte: minScore },
        ...(opts.fy !== undefined ? { assertedFy: opts.fy } : {}),
      },
      orderBy: { materialityScore: 'desc' },
      take: take * 2, // over-fetch so the per-tenant relevance re-sort has headroom
    });

    const relevant = await this.tenantRelevantPeCodes(ctx, [...new Set(rows.map((r) => r.peCode))]);
    const decorated = rows.map((r) => {
      const clientRelevant = relevant.has(r.peCode);
      // Read-time boost: a relevant delta floats up without mutating the stored score.
      const effectiveScore = Math.min(1, r.materialityScore + (clientRelevant ? 0.15 : 0));
      return { ...r, clientRelevant, effectiveScore };
    });
    decorated.sort((a, b) => b.effectiveScore - a.effectiveScore || b.materialityScore - a.materialityScore);
    return { data: decorated.slice(0, take), total: decorated.length, minScore };
  }

  /**
   * PEs (from the candidate set) the tenant is connected to. Tenant-scoped. A PE counts as
   * relevant if EITHER:
   *   (1) the tenant watches it, OR a client capability explicitly names it (legacy peNumber), OR
   *   (2) Step 2.3 — a client is RELEVANT to it on any evidence path (keyword / prior-award /
   *       facility-district / ecosystem) at/above 0.5, per the relevance service.
   * (2) is ADDITIVE — it never removes a (1) hit. getNeedsAttention boosts whatever lands here.
   */
  private async tenantRelevantPeCodes(ctx: TenantContext, peCodes: string[]): Promise<Set<string>> {
    if (peCodes.length === 0) return new Set<string>();
    const set = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [watches, caps] = await Promise.all([
        tx.programElementWatch.findMany({ where: { peCode: { in: peCodes } }, select: { peCode: true } }),
        tx.clientCapability.findMany({ where: { peNumber: { in: peCodes } }, select: { peNumber: true } }),
      ]);
      const found = new Set<string>();
      for (const w of watches) found.add(w.peCode);
      for (const c of caps) if (c.peNumber) found.add(c.peNumber);
      return found;
    });

    // Step 2.3 — additively fold in evidence-path relevance for the candidate PEs NOT already
    // matched by a watch/capability. Relevance is enrichment, never a gate: a failure leaves
    // the watch/capability set intact.
    if (this.relevanceService) {
      // Each probe runs its own withTenant transaction, so an uncapped probe list (a brand-new
      // tenant with no watches/caps probes every over-fetched PE) would fire hundreds of
      // sequential transactions per request. peCodes derives from the materiality-sorted
      // delta page, so slicing to MAX_RELEVANCE_PROBES keeps the most material PEs.
      const probeCodes = peCodes
        .filter((code) => !set.has(code))
        .slice(0, MAX_RELEVANCE_PROBES);
      await Promise.all(
        probeCodes.map(async (peCode) => {
          try {
            const clients = await this.relevanceService!.getRelevantClientsForPe(ctx, peCode, {
              minScore: 0.5,
            });
            if (clients.length > 0) set.add(peCode);
          } catch {
            // Non-fatal: a relevance probe failure simply omits this PE's relevance signal.
          }
        }),
      );
    }

    return set;
  }

  /**
   * "Related Program Elements" — SUGGESTIONS, not hard links.
   *
   * Reads this PE's stored mission embedding (context_embeddings,
   * source_type='pe') and returns the nearest other PE vectors by cosine
   * similarity. This is intentionally framed as "PEs with similar missions",
   * never as a definitive relationship: the score is a semantic-nearness signal,
   * not a documented fact, so the UI labels it as a suggestion and shows the
   * similarity so a lobbyist can judge it. Returns an empty list (never throws)
   * when this PE has no embedding yet, so the panel degrades gracefully before
   * the embed-program-elements backfill has run.
   */
  async getRelatedProgramElements(peCode: string, limit = 8) {
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    // Relevance floor (cosine similarity). Defense PE descriptions share a lot of
    // boilerplate, so we set this fairly high to avoid surfacing tangential PEs;
    // mirrors the issue-bill linker's 0.65 floor.
    const SIMILARITY_FLOOR = 0.7;

    // Self-join on the pe vectors: <=> is pgvector cosine DISTANCE, so
    // (1 - distance) is similarity. We pull the source vector inline by peCode
    // rather than round-tripping it through Bedrock — the embedding already
    // exists, no model call needed.
    let rows: Array<{
      peCode: string;
      title: string;
      service: string | null;
      score: number;
    }> = [];
    try {
      rows = await this.prisma.$queryRaw<
        Array<{ peCode: string; title: string; service: string | null; score: number }>
      >(Prisma.sql`
        WITH src AS (
          SELECT embedding
          FROM context_embeddings
          WHERE source_type = 'pe'
            AND source_id = ${peCode}
            AND model = ${EMBEDDING_MODEL}
            AND embedding IS NOT NULL
          LIMIT 1
        )
        SELECT pe.pe_code AS "peCode",
               pe.title   AS "title",
               pe.service AS "service",
               (1 - (ce.embedding <=> (SELECT embedding FROM src)))::float8 AS "score"
        FROM context_embeddings ce
        JOIN program_element pe ON pe.pe_code = ce.source_id
        WHERE ce.source_type = 'pe'
          AND ce.model = ${EMBEDDING_MODEL}
          AND ce.embedding IS NOT NULL
          AND ce.source_id <> ${peCode}
          AND pe.retired_at IS NULL
          AND EXISTS (SELECT 1 FROM src)
          AND (1 - (ce.embedding <=> (SELECT embedding FROM src))) >= ${SIMILARITY_FLOOR}
        ORDER BY ce.embedding <=> (SELECT embedding FROM src)
        LIMIT ${limit}
      `);
    } catch {
      // No pgvector / table absent / embedding missing — degrade to empty so the
      // panel renders its honest empty state rather than 500ing.
      rows = [];
    }

    return {
      // Explicitly a suggestion list. The UI MUST label it as such.
      related: rows.map((r) => ({
        peCode: r.peCode,
        title: r.title,
        service: r.service,
        // 0..1 cosine similarity, surfaced so the user can weigh the suggestion.
        similarity: Math.round(r.score * 100) / 100,
      })),
      todo:
        rows.length === 0
          ? 'No related program elements yet — similarity suggestions appear once mission embeddings are generated.'
          : null,
    };
  }

  async setWatching(peCode: string, watching: boolean, ctx: TenantContext) {
    const programElement = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!programElement) throw new NotFoundException(`Program element ${peCode} not found`);

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (watching) {
        const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          INSERT INTO program_element_watch (user_id, tenant_id, pe_code)
          VALUES (${ctx.userId}::uuid, ${ctx.tenantId}::uuid, ${peCode})
          ON CONFLICT (user_id, pe_code)
          DO UPDATE SET tenant_id = EXCLUDED.tenant_id
          RETURNING id
        `);

        const watchId = inserted[0]?.id ?? null;

        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            action: 'program_element.watch.set',
            entityType: 'program_element_watch',
            entityId: watchId,
            after: { peCode, watching: true },
          },
        });

        return { peCode, watching: true };
      }

      const removed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        DELETE FROM program_element_watch
        WHERE user_id = ${ctx.userId}::uuid
          AND pe_code = ${peCode}
        RETURNING id
      `);

      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.watch.set',
          entityType: 'program_element_watch',
          entityId: removed[0]?.id ?? null,
          after: { peCode, watching: false },
        },
      });

      return { peCode, watching: false };
    });
  }

  /**
   * Cross-source reconciliation review queue (Step 29 §4.1). Global table —
   * capiro_admin only (gated at the controller). Not tenant-scoped: it reflects
   * intel-data conflicts, not tenant data.
   */
  async listReconciliationQueue(status = 'open', page = 1, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 200);
    const skip = (Math.max(page, 1) - 1) * take;
    const where = status === 'all' ? {} : { status };
    const [rows, total] = await Promise.all([
      this.prisma.reconciliationReviewQueue.findMany({
        where,
        orderBy: { queuedAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.reconciliationReviewQueue.count({ where }),
    ]);
    return { data: rows, total, page: Math.max(page, 1), limit: take };
  }

  /**
   * Resolve a reconciliation review-queue entry (Step 0.2, capiro_admin only — gated at the
   * controller). `keep_current` only marks the entry resolved. `accept_conflicting` /
   * `manual_value` write the chosen value (in $ millions) through `applyAccepted`, which must
   * route through the writer's `upsertProgramElementYear(..., 'manual_override')` so the
   * canonical program_element_year row updates and is_winner flips consistently (never bypass
   * the writer). The queue-status update + AuditLog run inside withTenant so the RLS-protected
   * AuditLog insert passes; the queue table itself is a global (RLS-exempt) table.
   */
  async resolveReconciliation(
    id: string,
    input: ResolveReconciliationInput,
    ctx: TenantContext,
    applyAccepted: (peCode: string, fy: number, fieldName: string, value: number) => Promise<void>,
  ) {
    const entry = await this.prisma.reconciliationReviewQueue.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException(`Reconciliation entry ${id} not found`);
    if (entry.status !== 'open') {
      throw new BadRequestException(`Reconciliation entry ${id} is already ${entry.status}`);
    }

    let appliedValue: number | null = null;
    if (input.decision === 'accept_conflicting' || input.decision === 'manual_value') {
      // Validate the RAW value before coercing — Number(null) is 0, which would otherwise
      // slip past the guard and silently write $0 as the canonical value.
      const rawSource: string | number | null | undefined =
        input.decision === 'accept_conflicting' ? entry.conflictingValue : input.manualValue;
      if (rawSource === null || rawSource === undefined || rawSource === '' || !Number.isFinite(Number(rawSource))) {
        throw new BadRequestException(
          input.decision === 'manual_value'
            ? 'manualValue (number, in $ millions) is required for decision=manual_value'
            : `Conflicting value for entry ${id} is not numeric and cannot be accepted`,
        );
      }
      appliedValue = Number(rawSource);
      // Apply through the writer path (manual_override source) BEFORE marking the entry
      // resolved. This ordering is deliberately fail-safe + NOT atomic with the status/audit
      // write below: if the resolve-and-audit transaction fails after the value is applied,
      // the entry stays OPEN (visible + retryable) rather than resolved-without-applying, and
      // a retry is idempotent (the writer no-ops on an identical canonical value).
      await applyAccepted(entry.peCode, entry.fy, entry.fieldName, appliedValue);
    }

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.reconciliationReviewQueue.update({
        where: { id },
        data: {
          status: 'resolved',
          resolvedByUserId: ctx.userId,
          resolvedAt: new Date(),
          resolutionNotes: input.notes?.trim() || null,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.reconciliation.resolve',
          entityType: 'reconciliation_review_queue',
          entityId: id,
          before: {
            status: entry.status,
            currentValue: entry.currentValue,
            conflictingValue: entry.conflictingValue,
          },
          after: {
            decision: input.decision,
            appliedValue,
            peCode: entry.peCode,
            fy: entry.fy,
            fieldName: entry.fieldName,
          },
        },
      });
    });

    return {
      resolved: true as const,
      id,
      decision: input.decision,
      peCode: entry.peCode,
      fy: entry.fy,
      fieldName: entry.fieldName,
      appliedValue,
    };
  }

  /**
   * Step 2.1 — PE-keyed read of the Program graph for the PE profile "Programs" panel.
   * The programs API is program-centric; this is the thin PE→programs view the panel needs.
   *
   * Returns accepted matches and candidate matches in SEPARATE buckets (the panel renders
   * candidates only behind a "requires review" badge). Quarantined / rejected / weak-signal
   * matches are NEVER returned. Each row carries the program name + mdapCode, the confidence
   * band, the Why-shown evidence line (built from the evidence jsonb, same shape as
   * programs.service.buildWhyShown), the status, and last-reviewed timestamp.
   */
  async getProgramsForPe(peCode: string) {
    const code = peCode.trim();
    if (!code) return { peCode: code, acceptedMatches: [], candidateMatches: [] };

    const matches = await this.prisma.peProgramMatch.findMany({
      // Only accepted + candidate are ever surfaced; quarantined/rejected/weak-signal never are.
      where: { peCode: code, status: { in: ['accepted', 'candidate'] } },
      orderBy: [{ status: 'asc' }, { score: 'desc' }],
    });

    const programIds = Array.from(new Set(matches.map((m) => m.programId)));
    const programs = await this.prisma.program.findMany({
      where: { id: { in: programIds } },
      select: { id: true, canonicalName: true, component: true, mdapCode: true, status: true },
    });
    const programById = new Map(programs.map((p) => [p.id, p]));

    const decorate = (m: (typeof matches)[number]) => ({
      id: m.id,
      programId: m.programId,
      program: programById.get(m.programId) ?? null,
      peCode: m.peCode,
      projectCode: m.projectCode,
      score: m.score,
      confidenceBand: confidenceBand(m.score),
      evidenceTier: m.evidenceTier,
      status: m.status,
      whyShown: buildProgramWhyShown(m.evidence),
      evidence: m.evidence,
      resolvedAt: m.resolvedAt,
    });

    return {
      peCode: code,
      acceptedMatches: matches.filter((m) => m.status === 'accepted').map(decorate),
      candidateMatches: matches.filter((m) => m.status === 'candidate').map(decorate),
    };
  }

  /**
   * Step 2.4 follow-on — committee-report LANGUAGE provisions linked to this PE.
   *
   * Joins provision_pe_link (peCode) → committee_report_provision (+ its SourceDocument
   * for the deep-link sourceUrl). Only ACCEPTED + CANDIDATE links are surfaced — any other
   * reviewStatus (e.g. 'rejected' / quarantined) is EXCLUDED. Ordered accepted-first, then
   * by fiscal year descending (newest report cycle first). These are GLOBAL tables (no RLS),
   * so read via this.prisma directly. Empty array (never an error) when this PE has no
   * linked provisions — which is the case today, since the real committee_provisions_*
   * artifacts are DATA-PENDING (the deferred pdfplumber language-extraction pass).
   */
  async getProvisionsForPe(peCode: string): Promise<ProvisionItem[]> {
    const code = peCode.trim();
    if (!code) return [];

    const links = await this.prisma.provisionPeLink.findMany({
      // Quarantined/rejected (any non-accepted/candidate reviewStatus) are NEVER surfaced.
      where: { peCode: code, reviewStatus: { in: ['accepted', 'candidate'] } },
      select: {
        matchBasis: true,
        reviewStatus: true,
        confidence: true,
        provision: {
          select: {
            id: true,
            committee: true,
            fy: true,
            heading: true,
            text: true,
            pageStart: true,
            pageEnd: true,
            actionType: true,
            sourceDocument: { select: { sourceUrl: true } },
          },
        },
      },
    });

    const items: ProvisionItem[] = links.map((l) => ({
      id: l.provision.id,
      committee: l.provision.committee,
      fy: l.provision.fy,
      heading: l.provision.heading,
      text: l.provision.text,
      pageStart: l.provision.pageStart,
      pageEnd: l.provision.pageEnd,
      actionType: l.provision.actionType,
      sourceUrl: l.provision.sourceDocument?.sourceUrl ?? null,
      matchBasis: l.matchBasis,
      reviewStatus: l.reviewStatus,
      confidence: l.confidence,
    }));

    // Accepted first, then candidate; within a status, newest fiscal year first.
    const statusRank = (s: string) => (s === 'accepted' ? 0 : 1);
    items.sort((a, b) => statusRank(a.reviewStatus) - statusRank(b.reviewStatus) || b.fy - a.fy);
    return items;
  }

  /**
   * Step 3.1 — ACTIVE SAM.gov procurement notices linked to this PE.
   *
   * Joins SamOpportunityMatch (peCode) → SamOpportunity (notice metadata + procurement POC).
   * Only surfaces matches that are BOTH (a) reviewStatus accepted OR candidate AND (b) on an
   * active notice (active=true). QUARANTINED / rejected matches are NEVER returned — a PSC/
   * NAICS-only match lands as 'quarantined' and must clear human review before it appears.
   * Ordered by the notice's responseDeadline ASCENDING with NULL deadlines LAST (soonest-to-
   * close first; undated notices after), so the panel's deadline countdown is most-urgent-first.
   * These are GLOBAL tables (no RLS), so read via this.prisma directly. Empty array (never an
   * error) when this PE has no active matched opportunities.
   */
  /**
   * Keyword/NAICS search over the raw SAM.gov opportunity feed (GLOBAL table, no
   * RLS — read via this.prisma directly, same as getOpportunitiesForPe). Active
   * notices by default, newest-posted first. Backs Meri's
   * search_sam_opportunities tool.
   */
  async listSamOpportunities(filters: {
    query?: string;
    naics?: string;
    includeInactive?: boolean;
    limit?: number;
  }) {
    const limit = Math.min(50, Math.max(1, filters.limit ?? 20));
    const where: Prisma.SamOpportunityWhereInput = {};
    if (!filters.includeInactive) where.active = true;
    if (filters.naics) where.naicsCode = { startsWith: filters.naics.trim() };
    const query = filters.query?.trim();
    if (query) {
      where.OR = [
        { title: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
        { agency: { contains: query, mode: 'insensitive' } },
        { office: { contains: query, mode: 'insensitive' } },
        { solicitationNumber: { contains: query, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.samOpportunity.findMany({
        where,
        orderBy: { postedDate: 'desc' },
        take: limit,
        select: {
          id: true,
          noticeId: true,
          solicitationNumber: true,
          title: true,
          noticeType: true,
          agency: true,
          office: true,
          pscCode: true,
          naicsCode: true,
          postedDate: true,
          responseDeadline: true,
          description: true,
          sourceUrl: true,
          active: true,
        },
      }),
      this.prisma.samOpportunity.count({ where }),
    ]);

    return { data, total };
  }

  async getOpportunitiesForPe(peCode: string): Promise<OpportunityItem[]> {
    const code = peCode.trim();
    if (!code) return [];

    const matches = await this.prisma.samOpportunityMatch.findMany({
      // Quarantined/rejected are NEVER surfaced; only active notices are returned.
      where: {
        peCode: code,
        reviewStatus: { in: ['accepted', 'candidate'] },
        opportunity: { is: { active: true } },
      },
      select: {
        matchBasis: true,
        reviewStatus: true,
        confidence: true,
        opportunity: {
          select: {
            id: true,
            noticeId: true,
            title: true,
            noticeType: true,
            agency: true,
            office: true,
            pscCode: true,
            naicsCode: true,
            postedDate: true,
            responseDeadline: true,
            sourceUrl: true,
            pocName: true,
            pocEmail: true,
          },
        },
      },
    });

    const items: OpportunityItem[] = matches.map((m) => ({
      id: m.opportunity.id,
      noticeId: m.opportunity.noticeId,
      title: m.opportunity.title,
      noticeType: m.opportunity.noticeType,
      agency: m.opportunity.agency,
      office: m.opportunity.office,
      pscCode: m.opportunity.pscCode,
      naicsCode: m.opportunity.naicsCode,
      postedDate: m.opportunity.postedDate,
      responseDeadline: m.opportunity.responseDeadline,
      sourceUrl: m.opportunity.sourceUrl,
      pocName: m.opportunity.pocName,
      pocEmail: m.opportunity.pocEmail,
      matchBasis: m.matchBasis,
      reviewStatus: m.reviewStatus,
      confidence: m.confidence,
    }));

    // responseDeadline ascending, NULLs last (soonest-closing notices first; undated last).
    items.sort((a, b) => {
      const at = a.responseDeadline ? new Date(a.responseDeadline).getTime() : null;
      const bt = b.responseDeadline ? new Date(b.responseDeadline).getTime() : null;
      if (at === null && bt === null) return 0;
      if (at === null) return 1;
      if (bt === null) return -1;
      return at - bt;
    });
    return items;
  }
}

/**
 * Build the "Why-shown" evidence summary line from a PeProgramMatch's evidence jsonb
 * (e.g. "project title exact match + R-2A p.144 + P-1 line 027"). Replicated minimally
 * from programs.service (which does not export its helper) so the PE panel renders the
 * same line. Guards against non-array / malformed evidence.
 */
function buildProgramWhyShown(evidence: unknown): string {
  if (!Array.isArray(evidence)) return '';
  const parts: string[] = [];
  for (const item of evidence as Array<Record<string, unknown>>) {
    const kind = typeof item?.kind === 'string' ? item.kind : '';
    const page = typeof item?.pageNumber === 'number' ? ` p.${item.pageNumber}` : '';
    const quote = typeof item?.quote === 'string' ? item.quote : '';
    if (kind === 'mdap_curated') parts.push('curated MDAP map');
    else if (kind === 'other_funding_link') parts.push(`shared P-1 line${page}`);
    else if (kind.startsWith('alias_trigram')) parts.push(quote || 'alias match');
    else if (quote) parts.push(`${quote}${page}`);
    else if (kind) parts.push(`${kind}${page}`);
  }
  return parts.join(' + ');
}

export type ReconciliationDecision = 'keep_current' | 'accept_conflicting' | 'manual_value';

export interface ResolveReconciliationInput {
  decision: ReconciliationDecision;
  /** Numeric value in $ millions; required for decision=manual_value. */
  manualValue?: number | null;
  notes?: string | null;
}
