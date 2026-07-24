import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import LRUCache = require('lru-cache');
import type { TenantContext } from '@capiro/shared';
import {
  fundingCurrentCoalesceSql,
  fundingCurrentStageSql,
  currentFunding,
  currentCycleFyOf,
  FUNDING_STAGE_LABEL,
  FUNDING_STAGE_VEHICLE,
  renderPeFundingForModel,
  type FundingStageValues,
  type ModelFundingYear,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientPeRelevanceService } from '../intelligence/client-pe-relevance.service.js';
import { EMBEDDING_MODEL } from '../embeddings/embedder.js';
import { ConferenceProbabilityService } from './models/conference-probability.service.js';
import { compareProofPackSources } from './proof-pack.js';
import { confidenceBand } from './matching/program-match-thresholds.js';
import { computePbComparison, type BudgetPositionLike } from './budget-position.js';
import { assembleFundingNarrative } from './pe-funding-narrative.helpers.js';
import { normalizeServiceFilter } from './service-filter.js';
import { buildIntelligence } from './intelligence/build-intelligence.js';
import { normalizeBillStage } from './intelligence/bill-stage.js';

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
  /**
   * 'true' restricts the list to PEs the CURRENT user is watching (drives the
   * finder's "Watchlist" mode). Requires a user/tenant context; without one it
   * yields an empty list (no watch rows are visible).
   */
  watched?: string;
  /** BL-1: filter by intelligence-cache line type (RDTE_PE | PROCUREMENT_BLIN | OM_BLI). */
  lineType?: string;
  /** BL-1: filter to lines with an accepted match to this capability slug. */
  capability?: string;
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
  /**
   * RC7: match scope, derived from matchBasis. `pe_specific` when the link cites
   * this PE's own code or a project of it; `program_level` when matched via a
   * program alias (FY committee reports name PROGRAMS, not PE codes), so the same
   * provision may legitimately apply to SIBLING PEs in the program. Lets a caller
   * avoid attributing a program-wide provision solely to this PE.
   */
  matchScope: 'pe_specific' | 'program_level';
  /**
   * RC7: human-facing attribution caveat, non-null ONLY for `program_level`
   * links, so a memo never states a program-wide provision as exclusive to this
   * PE. Null for `pe_specific`.
   */
  attributionCaveat: string | null;
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
    const watchedOnly = query.watched === 'true';
    const userId = ctx?.userId ?? null;
    // BL-1 money-graph facets: line_type filters on the intelligence cache;
    // capability filters via the auditable match table (accepted rows only).
    const lineType = query.lineType?.trim();
    const capability = query.capability?.trim();

    type ListRow = {
      peCode: string;
      title: string;
      service: string | null;
      budgetActivity: string | null;
      appropriationType: string | null;
      status: string | null;
      lastSyncedAt: Date;
      hasData: boolean;
      watched: boolean;
      billCount: number | null;
      latestRequest: number | null;
      latestRequestFy: number | null;
      latestEnacted: number | null;
      latestEnactedFy: number | null;
      latestCurrent: number | null;
      latestCurrentFy: number | null;
      latestCurrentStage: string | null;
      deltaPct: number | null;
      spark: number[] | null;
      signalType: string | null;
      signalScore: number | null;
      signalDeltaPct: number | null;
      lineType: string | null;
      maturity: number | null;
      appropTier: string | null;
      appropScore: number | null;
      actionSignalType: string | null;
      actionSignalTone: string | null;
      valleyOfDeath: boolean | null;
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

    // Per-user watch flag. Runs inside withTenant (below) so the program_element_watch
    // RLS policy is satisfied; FALSE when there is no user context.
    const watchedExpr = userId
      ? Prisma.sql`EXISTS (SELECT 1 FROM program_element_watch pw WHERE pw.pe_code = pe.pe_code AND pw.user_id = ${userId}::uuid)`
      : Prisma.sql`FALSE`;

    // The redesigned finder shows per-row money, a 6-yr funding sparkline, a bill
    // count, the watch flag and the most-material live signal. The page of PEs is
    // selected + counted first (cheap base columns), then enriched via LATERALs and
    // the detail MV so the expensive per-PE lookups run only for the <=limit rows on
    // the page — not for the whole catalog.
    const listSql = Prisma.sql`
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
          ${watchedExpr} AS watched,
          CASE WHEN ${q ? 1 : 0} = 1 THEN GREATEST(similarity(pe.title, ${q ?? ''}), 0) ELSE 0 END AS score,
          COUNT(*) OVER()::int AS total_count
        FROM program_element pe
        WHERE pe.retired_at IS NULL
          AND (${service ? Prisma.sql`pe.service ILIKE ${service}` : Prisma.sql`TRUE`})
          AND (${budgetActivity ? Prisma.sql`pe.budget_activity ILIKE ${budgetActivity}` : Prisma.sql`TRUE`})
          AND (${lineType ? Prisma.sql`EXISTS (SELECT 1 FROM program_element_intelligence_cache ic WHERE ic.pe_code = pe.pe_code AND ic.line_type = ${lineType})` : Prisma.sql`TRUE`})
          AND (${capability ? Prisma.sql`EXISTS (SELECT 1 FROM capability_budget_line_match cm JOIN capability c ON c.id = cm.capability_id WHERE cm.pe_code = pe.pe_code AND cm.status = 'accepted' AND c.slug = ${capability})` : Prisma.sql`TRUE`})
          AND (${hasDataOnly ? hasDataExpr : Prisma.sql`TRUE`})
          AND (${watchedOnly ? watchedExpr : Prisma.sql`TRUE`})
          AND (
            ${q ? Prisma.sql`pe.title ILIKE ${`%${q}%`} OR pe.pe_code ILIKE ${`%${q}%`} OR similarity(pe.title, ${q}) > 0.2` : Prisma.sql`TRUE`}
          )
        ORDER BY
          CASE WHEN ${q ? 1 : 0} = 1 THEN GREATEST(similarity(pe.title, ${q ?? ''}), 0) ELSE 0 END DESC,
          pe.service ASC NULLS LAST,
          pe.pe_code ASC
        LIMIT ${limit}
        OFFSET ${(page - 1) * limit}
      )
      SELECT
        f.pe_code AS "peCode",
        f.title,
        f.service,
        f.budget_activity AS "budgetActivity",
        f.appropriation_type AS "appropriationType",
        f.status,
        f.last_synced_at AS "lastSyncedAt",
        f.has_data AS "hasData",
        f.watched,
        f.total_count AS "totalCount",
        mv.bill_count::int AS "billCount",
        lr.request::double precision AS "latestRequest",
        lr.fy AS "latestRequestFy",
        le.enacted::double precision AS "latestEnacted",
        le.fy AS "latestEnactedFy",
        ${Prisma.raw(fundingCurrentCoalesceSql('lc.'))}::double precision AS "latestCurrent",
        lc.fy AS "latestCurrentFy",
        ${Prisma.raw(fundingCurrentStageSql('lc.'))} AS "latestCurrentStage",
        CASE
          WHEN le.enacted IS NOT NULL AND ler.request IS NOT NULL AND ler.request <> 0
          THEN ((le.enacted::double precision - ler.request::double precision) / ler.request::double precision) * 100
          ELSE NULL
        END AS "deltaPct",
        spk.spark AS spark,
        sig.delta_type AS "signalType",
        sig.materiality_score::double precision AS "signalScore",
        sig.delta_pct AS "signalDeltaPct",
        ic.line_type AS "lineType",
        ic.maturity,
        ic.approp_tier AS "appropTier",
        ic.approp_score AS "appropScore",
        ic.signal_type AS "actionSignalType",
        ic.signal_tone AS "actionSignalTone",
        ic.valley_of_death AS "valleyOfDeath"
      FROM filtered f
      LEFT JOIN program_element_detail_mv mv ON mv.pe_code = f.pe_code
      LEFT JOIN program_element_intelligence_cache ic ON ic.pe_code = f.pe_code
      LEFT JOIN LATERAL (
        SELECT y.request, y.fy
        FROM program_element_year y
        WHERE y.pe_code = f.pe_code AND y.request IS NOT NULL AND y.request <> 0
        ORDER BY y.fy DESC
        LIMIT 1
      ) lr ON TRUE
      LEFT JOIN LATERAL (
        SELECT y.enacted, y.fy
        FROM program_element_year y
        WHERE y.pe_code = f.pe_code AND y.enacted IS NOT NULL AND y.enacted <> 0
        ORDER BY y.fy DESC
        LIMIT 1
      ) le ON TRUE
      LEFT JOIN LATERAL (
        SELECT y.request, y.hasc_mark, y.sasc_mark, y.hac_d_mark, y.sac_d_mark, y.conference, y.enacted, y.fy
        FROM program_element_year y
        WHERE y.pe_code = f.pe_code AND ${Prisma.raw(fundingCurrentCoalesceSql('y.'))} IS NOT NULL
        ORDER BY y.fy DESC
        LIMIT 1
      ) lc ON TRUE
      LEFT JOIN LATERAL (
        SELECT y.request
        FROM program_element_year y
        WHERE y.pe_code = f.pe_code AND y.fy = le.fy
        LIMIT 1
      ) ler ON TRUE
      LEFT JOIN LATERAL (
        SELECT json_agg(v ORDER BY fy) AS spark
        FROM (
          SELECT y.fy AS fy, ${Prisma.raw(fundingCurrentCoalesceSql('y.'))}::double precision AS v
          FROM program_element_year y
          WHERE y.pe_code = f.pe_code AND ${Prisma.raw(fundingCurrentCoalesceSql('y.'))} IS NOT NULL
          ORDER BY y.fy DESC
          LIMIT 6
        ) s
      ) spk ON TRUE
      LEFT JOIN LATERAL (
        SELECT d.delta_type, d.materiality_score, d.delta_pct
        FROM program_element_delta d
        WHERE d.pe_code = f.pe_code AND d.superseded_at IS NULL
        ORDER BY d.materiality_score DESC NULLS LAST
        LIMIT 1
      ) sig ON TRUE
      ORDER BY f.score DESC, f.service ASC NULLS LAST, f.pe_code ASC
    `;

    // Run inside the tenant transaction when we have one so the per-user watch
    // EXISTS clears RLS on program_element_watch; the program_element catalog itself
    // is global reference data and is unaffected by the tenant GUC.
    const rows = ctx?.tenantId
      ? await this.prisma.withTenant(ctx.tenantId, (tx) => tx.$queryRaw<ListRow[]>(listSql))
      : await this.prisma.$queryRaw<ListRow[]>(listSql);

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
   * Portfolio-level aggregates for the finder's summary strip (tracked count, latest
   * request/enacted totals, average enacted-vs-request delta, open markups, a 6-yr
   * funding trend, and the per-service split for the donut). Grouped queries over
   * program_element_year (indexed on fy); the request/enacted totals use per-PE
   * LATERALs over the catalog (index-supported on (pe_code, fy), bounded, cached).
   * Aggregates are catalog-wide (not service-filtered) so the donut/legend can
   * drive the table filter without the KPIs shifting under it.
   */
  async getSummary(query: { service?: string; hasData?: string }, ctx?: TenantContext) {
    const hasDataOnly = query.hasData === 'true';
    const hasDataExpr = Prisma.sql`(
      EXISTS (SELECT 1 FROM program_element_year y WHERE y.pe_code = pe.pe_code)
      OR EXISTS (SELECT 1 FROM federal_award fa WHERE fa.pe_code = pe.pe_code)
      OR EXISTS (SELECT 1 FROM congress_bill b WHERE pe.pe_code = ANY(b.pe_codes))
    )`;

    const [trackedRows, byServiceRows, moneyRows, trendRows, markupRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ tracked: number; withData: number }>>(Prisma.sql`
        SELECT
          COUNT(*)::int AS tracked,
          COUNT(*) FILTER (WHERE ${hasDataExpr})::int AS "withData"
        FROM program_element pe
        WHERE pe.retired_at IS NULL
          AND (${hasDataOnly ? hasDataExpr : Prisma.sql`TRUE`})
      `),
      this.prisma.$queryRaw<Array<{ service: string | null; count: number }>>(Prisma.sql`
        SELECT pe.service AS service, COUNT(*)::int AS count
        FROM program_element pe
        WHERE pe.retired_at IS NULL AND (${hasDataOnly ? hasDataExpr : Prisma.sql`TRUE`})
        GROUP BY pe.service
        ORDER BY count DESC NULLS LAST
      `),
      // Portfolio money as a MATCHED-PAIR sum: for each PE, its own latest FY with a
      // real enacted value, and the request recorded AT THAT SAME FY (if any).
      // Both totals — and avgDeltaPct — are built from this one identical set of
      // (request, enacted) pairs, so the three numbers are ARITHMETICALLY
      // guaranteed to reconcile (avgDeltaPct = (Σenacted − Σrequest)/Σrequest,
      // computed from the exact same rows shown).
      //
      // Earlier attempts pinned both totals to a single global fiscal year instead
      // (first "the latest FY with any enacted value", then "the FY with the most
      // enacted PEs"). Both broke on the same underlying fact: budget-justification
      // books record a PRIOR/CURRENT year's dollars as enacted-only (no request
      // field) far more often than they carry a matching historical request — so
      // "enacted" coverage for any single past FY is much broader than "request"
      // coverage for that same FY. Summing each column independently over one FY
      // mixed a near-universal enacted total against a sparse request total from a
      // DIFFERENT, smaller set of PEs (e.g. $454B enacted vs $204B request at FY25 —
      // a nonsensical +122%). Matching per-PE at each PE's own enacted year sidesteps
      // that: a PE contributes to BOTH totals only when it has a genuine
      // request-vs-enacted pair to compare, so the delta is never an artifact of
      // mismatched coverage. There is no longer a single portfolio FY to tag (each
      // PE's pair can be a different year), so the UI shows "aggregate" without an
      // FY chip — the per-FY forward/backward picture lives in the trend sparkline
      // and the detail page's own funding chart.
      this.prisma.$queryRaw<
        Array<{
          totalRequest: number | null;
          totalEnacted: number | null;
          avgDeltaPct: number | null;
        }>
      >(Prisma.sql`
        SELECT
          COALESCE(SUM(ler.request) FILTER (WHERE ler.request IS NOT NULL AND ler.request <> 0), 0)::double precision AS "totalRequest",
          COALESCE(SUM(le.enacted) FILTER (WHERE ler.request IS NOT NULL AND ler.request <> 0), 0)::double precision AS "totalEnacted",
          (
            CASE
              WHEN SUM(ler.request) FILTER (WHERE ler.request IS NOT NULL AND ler.request <> 0) > 0
              THEN (
                (
                  SUM(le.enacted) FILTER (WHERE ler.request IS NOT NULL AND ler.request <> 0)
                  - SUM(ler.request) FILTER (WHERE ler.request IS NOT NULL AND ler.request <> 0)
                )
                / SUM(ler.request) FILTER (WHERE ler.request IS NOT NULL AND ler.request <> 0)
              ) * 100
              ELSE NULL
            END
          )::double precision AS "avgDeltaPct"
        FROM program_element pe
        LEFT JOIN LATERAL (
          SELECT y.enacted, y.fy FROM program_element_year y
          WHERE y.pe_code = pe.pe_code AND y.enacted IS NOT NULL AND y.enacted <> 0
          ORDER BY y.fy DESC LIMIT 1
        ) le ON TRUE
        LEFT JOIN LATERAL (
          SELECT y.request FROM program_element_year y
          WHERE y.pe_code = pe.pe_code AND y.fy = le.fy LIMIT 1
        ) ler ON TRUE
        WHERE pe.retired_at IS NULL AND (${hasDataOnly ? hasDataExpr : Prisma.sql`TRUE`})
      `),
      this.prisma.$queryRaw<Array<{ fy: number; total: number }>>(Prisma.sql`
        WITH mx AS (SELECT MAX(fy) AS fy FROM program_element_year)
        SELECT y.fy AS fy, COALESCE(SUM(${Prisma.raw(fundingCurrentCoalesceSql('y.'))}), 0)::double precision AS total
        FROM program_element_year y, mx
        WHERE y.fy > mx.fy - 6
        GROUP BY y.fy
        ORDER BY y.fy ASC
      `),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(DISTINCT pe_code)::int AS count
        FROM program_element_delta
        WHERE superseded_at IS NULL
          AND delta_type IN ('mark_vs_request', 'mark_vs_mark', 'conference_vs_marks')
      `),
    ]);

    let watched = 0;
    if (ctx?.tenantId && ctx?.userId) {
      const wr = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
          SELECT COUNT(*)::int AS count FROM program_element_watch WHERE user_id = ${ctx.userId}::uuid
        `),
      );
      watched = wr[0]?.count ?? 0;
    }

    return {
      tracked: trackedRows[0]?.tracked ?? 0,
      withData: trackedRows[0]?.withData ?? 0,
      watched,
      // No single FY tag — each PE's matched pair can fall in a different year (see
      // the query comment above), so the UI shows plain "aggregate".
      latestRequestFy: null,
      totalRequest: moneyRows[0]?.totalRequest ?? null,
      latestEnactedFy: null,
      totalEnacted: moneyRows[0]?.totalEnacted ?? null,
      avgDeltaPct: moneyRows[0]?.avgDeltaPct ?? null,
      openMarkups: markupRows[0]?.count ?? 0,
      trend: trendRows.map((r) => ({ fy: r.fy, total: r.total })),
      byService: byServiceRows.map((r) => ({ service: r.service, count: r.count })),
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
            fy: true,
            request: true,
            hascMark: true,
            sascMark: true,
            hacDMark: true,
            sacDMark: true,
            conference: true,
            ndaaConference: true,
            enacted: true,
          },
        },
      },
    });
    if (!pe) throw new NotFoundException(`Unknown program element ${peCode}`);
    const dec = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
    const years = pe.years.map((y) => ({
      fy: y.fy,
      request: dec(y.request),
      hascMark: dec(y.hascMark),
      sascMark: dec(y.sascMark),
      hacDMark: dec(y.hacDMark),
      sacDMark: dec(y.sacDMark),
      // The intelligence layer's "conference" signal (posture + prior-year trajectory)
      // is the NDAA conference — the only conference value ever populated — so feed it
      // ndaaConference here. The appropriations `conference` rung stays out of this
      // (it drives currentFunding via @capiro/shared, not the intelligence posture).
      conference: dec(y.ndaaConference),
      enacted: dec(y.enacted),
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
    // BL-1: the derive-time cache carries the graph-aware verdicts (maturity
    // ladder needs relationship edges + award counts; appropriability needs the
    // full evidence census) — computed nightly by derive-intelligence-cache, not
    // re-derivable cheaply per request. Null until the first derive run.
    const cache = await this.prisma.programElementIntelligenceCache.findUnique({
      where: { peCode: code },
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
      lineType: cache?.lineType ?? null,
      maturityLadder: cache?.maturityJson ?? null,
      appropriability: cache?.appropJson ?? null,
      valleyOfDeath: cache?.valleyOfDeath ?? false,
      cacheComputedAt: cache?.computedAt ?? null,
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
    // currentCycleFy is the FY with the most PEs carrying a live PB request (the
    // mode, same pattern as getSummary's last-enacted-FY pick) — i.e. "the current
    // budget cycle" the vast majority of active PEs are in. Lets the UI flag a PE
    // whose own latest year of record predates it (e.g. a program that finished
    // RDT&E and dropped out of the current year's justification books) as
    // historical rather than silently sparse/broken-looking.
    const [projectCount, sourceCount, cycleRows] = await Promise.all([
      this.prisma.programElementProject.count({ where: { peCode } }),
      this.prisma.programElementSource.count({ where: { peCode } }),
      this.prisma.$queryRaw<Array<{ fy: number | null }>>(Prisma.sql`
        SELECT fy
        FROM program_element_year
        WHERE request IS NOT NULL AND request <> 0
        GROUP BY fy
        ORDER BY COUNT(*) DESC, fy DESC
        LIMIT 1
      `),
    ]);

    const numDec = (d: Prisma.Decimal | null): number | null => (d == null ? null : Number(d));
    const fundingYears = programElement.years.map(
      (y): ModelFundingYear => ({
        fy: y.fy,
        request: numDec(y.request),
        hascMark: numDec(y.hascMark),
        sascMark: numDec(y.sascMark),
        hacDMark: numDec(y.hacDMark),
        sacDMark: numDec(y.sacDMark),
        conference: numDec(y.conference),
        ndaaConference: numDec(y.ndaaConference),
        enacted: numDec(y.enacted),
      }),
    );

    const detail: Record<string, unknown> = {
      // RC1: canonical labeled funding block for LLM callers (FY + stage +
      // authorization/appropriations vehicle + signed vs-request + NDAA
      // conference surfaced separately), from the SAME shared serializer the
      // timeline tool and outreach truth block use. Web ignores this field.
      // The catalog-wide mode currentCycleFy is set below; the summary uses THIS
      // PE's own mark-bearing cycle so its outyear tags are correct.
      // RC9: kept BEFORE the `...programElement` spread (whose `years` array is
      // the bulk of the payload) so a record-safe truncation of an oversized
      // detail keeps the funding summary intact rather than cutting it off the tail.
      fundingSummary: renderPeFundingForModel({
        peCode: programElement.peCode,
        title: programElement.title,
        service: programElement.service,
        currentCycleFy: currentCycleFyOf(fundingYears),
        years: fundingYears,
      }),
      ...programElement,
      billCount: mvRows[0]?.billCount ?? null,
      projectCount,
      sourceCount,
      currentCycleFy: cycleRows[0]?.fy ?? null,
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
      select: {
        peCode: true,
        title: true,
        service: true,
        appropriationType: true,
        budgetActivity: true,
        lineNumber: true,
      },
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

    // The current budget CYCLE = the latest FY that carries a congressional mark
    // (HASC/SASC/HAC-D/SAC-D/conference). Congress only marks the year currently in
    // the appropriations process; later FYs in the book are FYDP OUTYEAR
    // PROJECTIONS (request-only), and earlier FYs are historical/enacted. Without
    // this label a consumer (human or LLM) can't tell a FY2031 projection from the
    // live FY2027 request — the exact swap the Boresight analysis made. Falls back
    // to the latest request-bearing FY when no mark exists yet.
    const num = (d: unknown): number | null => (d == null ? null : Number(d));
    const hasMark = (y: (typeof years)[number]): boolean =>
      y.hascMark != null ||
      y.sascMark != null ||
      y.hacDMark != null ||
      y.sacDMark != null ||
      y.conference != null;
    const markFys = years.filter(hasMark).map((y) => y.fy);
    const requestFys = years.filter((y) => y.request != null).map((y) => y.fy);
    const currentCycleFy = markFys.length
      ? Math.max(...markFys)
      : requestFys.length
        ? Math.max(...requestFys)
        : null;

    const yearsWithConferenceProbability = await Promise.all(
      years.map(async (year) => {
        // GAI-25: read path must not write — compute + return, never persist.
        const prediction = await this.conferenceProbabilityService.predict(peCode, year.fy, false);
        const values: FundingStageValues = {
          request: num(year.request),
          hascMark: num(year.hascMark),
          sascMark: num(year.sascMark),
          hacDMark: num(year.hacDMark),
          sacDMark: num(year.sacDMark),
          conference: num(year.conference),
          enacted: num(year.enacted),
        };
        const pick = currentFunding(values);
        // 'current' = the live request/markup cycle; 'outyear' = an FYDP projection
        // (never quote as "the request"); 'historical' = a prior, settled year.
        const cycle: 'historical' | 'current' | 'outyear' | 'unknown' =
          currentCycleFy == null
            ? 'unknown'
            : year.fy < currentCycleFy
              ? 'historical'
              : year.fy === currentCycleFy
                ? 'current'
                : 'outyear';
        return {
          ...year,
          cycle,
          current: pick.value,
          currentStage: pick.stage,
          currentStageLabel: FUNDING_STAGE_LABEL[pick.stage],
          // RC1: tag the current figure with its legislative vehicle and its
          // signed direction vs the request so the model never mislabels an
          // appropriations mark as authorization or invents a direction.
          currentVehicle: FUNDING_STAGE_VEHICLE[pick.stage],
          currentDeltaVsRequestM:
            pick.value != null && values.request != null && pick.stage !== 'request'
              ? pick.value - values.request
              : null,
          // GAI-28: `predicted` is a forecast conference DOLLAR amount (in $M),
          // NOT a probability. Exposed under an honest name so no downstream
          // surface (LLM prompt, web, client brief) can read a funding level as a
          // percentage. CI bounds are also $M; confidence is the model's 0–1
          // confidence in the forecast.
          predictedConferenceAmount: prediction?.predicted ?? null,
          predictedConferenceAmountCiLow: prediction?.ciLow ?? null,
          predictedConferenceAmountCiHigh: prediction?.ciHigh ?? null,
          predictedConferenceConfidence: prediction?.confidence ?? null,
        };
      }),
    );

    // RC1: a canonical, fully-labeled funding block (FY + stage + vehicle +
    // signed vs-request + NDAA conference surfaced separately) for LLM callers,
    // rendered from the SAME shared serializer the outreach truth block uses so
    // no surface can drift. Web consumers ignore this extra field.
    const fundingSummary = renderPeFundingForModel({
      peCode,
      title: programElement.title,
      service: programElement.service,
      currentCycleFy,
      years: years.map(
        (y): ModelFundingYear => ({
          fy: y.fy,
          request: num(y.request),
          hascMark: num(y.hascMark),
          sascMark: num(y.sascMark),
          hacDMark: num(y.hacDMark),
          sacDMark: num(y.sacDMark),
          conference: num(y.conference),
          ndaaConference: num(y.ndaaConference),
          enacted: num(y.enacted),
        }),
      ),
    });

    return {
      peCode,
      title: programElement.title,
      service: programElement.service,
      appropriationType: programElement.appropriationType,
      budgetActivity: programElement.budgetActivity,
      lineNumber: programElement.lineNumber,
      currentCycleFy,
      fundingSummary,
      years: yearsWithConferenceProbability,
      milestones,
    };
  }

  /**
   * Phase 4 (4.1) — the assembled "request → marks → enactment" narrative for
   * the current budget cycle: one ordered, stage-labeled story per PE, with the
   * FY's materiality-scored deltas surfaced alongside (4.1.2). Pure assembly over
   * getTimeline + getDeltas — no new data modeling.
   */
  async getNarrative(peCode: string) {
    const nn = (v: unknown): number | null => (v == null ? null : Number(v));
    const timeline = await this.getTimeline(peCode);
    const fy = timeline.currentCycleFy;
    const currentYear = fy != null ? timeline.years.find((y) => y.fy === fy) : undefined;
    const steps = currentYear
      ? assembleFundingNarrative({
          request: nn(currentYear.request),
          hasc: nn(currentYear.hascMark),
          sasc: nn(currentYear.sascMark),
          hacd: nn(currentYear.hacDMark),
          sacd: nn(currentYear.sacDMark),
          conference: nn(currentYear.conference),
          enacted: nn(currentYear.enacted),
        })
      : [];
    // The FY's material moves, most-material first (4.1.2 — surface, don't fuzzily join per-step).
    const deltas = fy != null ? await this.getDeltas(peCode, { fy, limit: 5 }) : { data: [] };
    return {
      peCode,
      title: timeline.title,
      service: timeline.service,
      currentCycleFy: fy,
      predictedConferenceAmount:
        currentYear && 'predictedConferenceAmount' in currentYear
          ? (currentYear as { predictedConferenceAmount: number | null }).predictedConferenceAmount
          : null,
      steps,
      materiality: deltas.data.map((d) => ({
        deltaType: (d as { deltaType?: string }).deltaType ?? null,
        materialityScore: (d as { materialityScore?: number | null }).materialityScore ?? null,
        materialityFactors: (d as { materialityFactors?: unknown }).materialityFactors ?? null,
      })),
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
    // LEG-B: evidence-typed link rows for THIS pe across the returned bills.
    // Falls back gracefully (link: null) for bills linked only via the legacy
    // peCodes array (extractor not yet re-run against them).
    const links = await this.prisma.billBudgetLineLink.findMany({
      where: { peCode, billId: { in: bills.map((b) => b.id) }, status: { not: 'rejected' } },
      select: { billId: true, linkType: true, confidence: true, evidence: true, status: true },
    });
    const linkByBill = new Map(links.map((l) => [l.billId, l]));

    // R4 §4.2: the budget package each bill rides in, so the PE panel can label the
    // legislative vehicle's cycle ("FY27 Defense Budget · authorization · house").
    // ONE query for every bill; absent for a bill that is not a budget vehicle, which
    // is the normal case and renders as no label rather than a guess.
    const vehicles = await this.prisma.budgetPackageVehicle.findMany({
      where: { billId: { in: bills.map((b) => b.id) } },
      select: {
        billId: true,
        track: true,
        stage: true,
        package: { select: { name: true, fiscalYear: true } },
      },
    });
    const packageByBill = new Map(
      vehicles
        .filter((v): v is typeof v & { billId: string } => Boolean(v.billId))
        .map((v) => [
          v.billId,
          {
            name: v.package.name,
            fiscalYear: v.package.fiscalYear,
            track: v.track,
            stage: v.stage,
          },
        ]),
    );

    const mapped = bills.map(({ committeeRefs, sponsorName, peCodes, ...bill }) => ({
      ...bill,
      sponsor: sponsorName,
      committee: committeeRefs[0]?.committeeName ?? null,
      peCodeCount: peCodes?.length ?? 0,
      link: linkByBill.get(bill.id)
        ? {
            type: linkByBill.get(bill.id)!.linkType,
            confidence: linkByBill.get(bill.id)!.confidence,
            evidence: linkByBill.get(bill.id)!.evidence,
            status: linkByBill.get(bill.id)!.status,
          }
        : null,
      budgetPackage: packageByBill.get(bill.id) ?? null,
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

  /**
   * Full legislative-action history for the bills touching this PE
   * (legislative-timeline plan LEG-A). Reads the congress_bill_action rows
   * sync-congress already stores for lobbying-relevant bills and classifies
   * each with the pure stage normalizer at read time — the raw action text is
   * returned verbatim alongside the stage, never replaced by it. Bounded:
   * the 40 most PE-specific bills × their actions, newest 200 events overall.
   */
  async getBillActions(peCode: string) {
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    const bills = await this.prisma.congressBill.findMany({
      where: { peCodes: { has: peCode } },
      orderBy: [{ latestActionDate: 'desc' }],
      take: 40,
      select: {
        id: true,
        congress: true,
        billType: true,
        billNumber: true,
        title: true,
        peCodes: true,
        actions: {
          orderBy: { date: 'desc' },
          take: 60,
          select: { date: true, text: true, type: true, chamber: true },
        },
      },
    });

    const events = bills.flatMap((b) =>
      b.actions.map((a) => {
        const stage = normalizeBillStage(a.text, a.type, a.chamber);
        return {
          billId: b.id,
          congress: b.congress,
          billType: b.billType,
          billNumber: b.billNumber,
          billTitle: b.title,
          /** How many PEs the bill references — lets the UI de-emphasize blanket authorizers. */
          peCodeCount: b.peCodes?.length ?? 0,
          date: a.date,
          text: a.text,
          type: a.type,
          chamber: a.chamber,
          stage: stage.stage,
          stageLabel: stage.label,
          stageRank: stage.rank,
        };
      }),
    );
    events.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return { data: events.slice(0, 200), billCount: bills.length };
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
      Array<{
        fy: number;
        quantity: number | null;
        dollars: number | null;
        unitCost: number | null;
      }>
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
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
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
    decorated.sort(
      (a, b) => b.effectiveScore - a.effectiveScore || b.materialityScore - a.materialityScore,
    );
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
        tx.programElementWatch.findMany({
          where: { peCode: { in: peCodes } },
          select: { peCode: true },
        }),
        tx.clientCapability.findMany({
          where: { peNumber: { in: peCodes } },
          select: { peNumber: true },
        }),
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
      const probeCodes = peCodes.filter((code) => !set.has(code)).slice(0, MAX_RELEVANCE_PROBES);
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
   * PE Watch email-alert preference (PE Watch plan Phase 2). Absence of a row
   * means 'daily' — the opt-out default for users who watch PEs.
   */
  async getPeAlertEmailPref(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.peAlertEmailPref.findFirst({
        where: { userId: ctx.userId, tenantId: ctx.tenantId },
        select: { mode: true },
      });
      return { mode: row?.mode ?? 'daily' };
    });
  }

  async setPeAlertEmailPref(mode: string, ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.peAlertEmailPref.upsert({
        where: { userId_tenantId: { userId: ctx.userId, tenantId: ctx.tenantId } },
        create: { userId: ctx.userId, tenantId: ctx.tenantId, mode },
        update: { mode },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.alert_email_pref.set',
          entityType: 'pe_alert_email_pref',
          entityId: null,
          after: { mode },
        },
      });
      return { mode };
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
      if (
        rawSource === null ||
        rawSource === undefined ||
        rawSource === '' ||
        !Number.isFinite(Number(rawSource))
      ) {
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

    const provisionSelect = {
      id: true,
      committee: true,
      fy: true,
      heading: true,
      text: true,
      pageStart: true,
      pageEnd: true,
      actionType: true,
      sourceDocument: { select: { sourceUrl: true } },
    } as const;

    // Two link paths to this PE, unioned:
    //   (a) DIRECT — provision_pe_link.pe_code = this PE (pe_code / project_title bases).
    //   (b) PROGRAM — provision mentions a PROGRAM (program_alias basis, pe_code NULL);
    //       that program maps to this PE via an ACCEPTED pe_program_match. FY committee
    //       reports name programs ("PATRIOT"), not PE codes — verified: FY2027 reports
    //       carry ZERO PE codes across 2,220 pages — so nearly every real link is the
    //       program path. Filtering by pe_code alone (the original bug) surfaced none.
    // The program path is inherently program-level (one program → many PEs), so those
    // rows are always CANDIDATE and are ranked/labeled below their PE-direct peers.
    const programMatches = await this.prisma.peProgramMatch.findMany({
      where: { peCode: code, status: 'accepted' },
      select: { programId: true },
    });
    const programIds = [...new Set(programMatches.map((m) => m.programId))];

    const [directLinks, programLinks] = await Promise.all([
      this.prisma.provisionPeLink.findMany({
        where: { peCode: code, reviewStatus: { in: ['accepted', 'candidate'] } },
        select: {
          matchBasis: true,
          reviewStatus: true,
          confidence: true,
          provision: { select: provisionSelect },
        },
      }),
      programIds.length
        ? this.prisma.provisionPeLink.findMany({
            where: {
              programId: { in: programIds },
              reviewStatus: { in: ['accepted', 'candidate'] },
            },
            select: {
              matchBasis: true,
              reviewStatus: true,
              confidence: true,
              provision: { select: provisionSelect },
            },
          })
        : Promise.resolve([]),
    ]);

    // Merge, keeping the STRONGEST link per provision (a provision reachable both
    // directly and via program keeps its direct, higher-status row).
    const byProvision = new Map<string, ProvisionItem>();
    const rank = (m: string) => (m === 'pe_code' ? 0 : m === 'project_title' ? 1 : 2);
    // RC7: pe_code / project_title cite THIS PE (or a project of it); anything
    // else (program_alias) is a program-level candidate that may apply to sibling
    // PEs — carry that distinction to the model so a program-wide provision is
    // never attributed as exclusive to this PE.
    const scopeOf = (m: string): 'pe_specific' | 'program_level' =>
      m === 'pe_code' || m === 'project_title' ? 'pe_specific' : 'program_level';
    for (const l of [...directLinks, ...programLinks]) {
      const existing = byProvision.get(l.provision.id);
      if (existing && rank(existing.matchBasis) <= rank(l.matchBasis)) continue;
      const matchScope = scopeOf(l.matchBasis);
      byProvision.set(l.provision.id, {
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
        matchScope,
        attributionCaveat:
          matchScope === 'program_level'
            ? 'Program-level match: this provision names a program that maps to this PE, not this PE code directly. It may apply to sibling PEs in the same program — attribute it at the program level, not exclusively to this PE.'
            : null,
      });
    }

    const items = [...byProvision.values()];
    // accepted → pe-direct candidate → program-level candidate; newest FY first;
    // capped so a heavily-referenced program can't flood a single PE profile.
    const statusRank = (s: string) => (s === 'accepted' ? 0 : 1);
    items.sort(
      (a, b) =>
        statusRank(a.reviewStatus) - statusRank(b.reviewStatus) ||
        rank(a.matchBasis) - rank(b.matchBasis) ||
        b.fy - a.fy ||
        b.confidence - a.confidence,
    );
    return items.slice(0, 50);
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
