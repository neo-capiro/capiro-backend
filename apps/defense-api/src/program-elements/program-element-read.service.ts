import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  fundingCurrentCoalesceSql,
  fundingCurrentStageSql,
  renderPeFundingForModel,
  type ModelFundingYear,
} from '@capiro/shared';
import {
  markupMonitorTrackDivergence,
  partitionContractorEvidence,
  sqlCurrentCycleFyExpr,
} from '@capiro/shared/funding-claim';
import {
  assembleFundingNarrative,
  buildIntelligence,
  buildWhyShown,
  compareProofPackSources,
  confidenceBand,
  currentCycleFyPreservingZero,
  mergeProvisionLinks,
  normalizeBillStage,
  normalizeServiceFilter,
  projectPeListRow,
  projectPeTimelineYear,
  type PeListSqlRow,
  type ProvisionItem,
  type ProvisionLinkRow,
} from '@capiro/defense-domain/pe-read';
import { computePbComparison } from '@capiro/defense-domain';
import {
  CLIENT_RELEVANCE_PORT,
  EMBEDDING_PORT,
  type ClientRelevancePort,
  type EmbeddingPort,
} from '@capiro/defense-contracts';
import {
  approveManualOverrideV1,
  canonicalTargetForLegacyPeYearV1,
  ManualOverrideRefusalError,
  proposeManualOverrideV1,
} from './promotion/manual-override-service-v1.js';
import { ManualOverrideRepositoryPrisma } from './promotion/manual-override-repository.prisma.js';
import { ConferenceProbabilityReadService } from './conference-probability-read.service.js';
import {
  DefenseTenantContext,
  assertFound,
  normalizeLimit,
  normalizePage,
  num,
  requirePeCode,
} from './program-elements.shared.js';

export interface ProgramElementListQuery {
  service?: string;
  budgetActivity?: string;
  q?: string;
  page?: number;
  limit?: number;
  mode?: 'markup-monitor';
  divergenceThreshold?: number;
  hasData?: string;
  watched?: string;
  lineType?: string;
  capability?: string;
}

export type ReconciliationDecision = 'keep_current' | 'accept_conflicting' | 'manual_value';

export interface ResolveReconciliationInput {
  decision: ReconciliationDecision;
  manualValue?: string | null;
  notes?: string | null;
}

/**
 * Cap on the not-already-matched candidate PEs the needs-attention feed probes
 * for client relevance. apps/api uses the same bound (MAX_RELEVANCE_PROBES) for
 * the same reason, except it spends it on sequential per-PE probes; here it caps
 * the size of ONE batched port call (Workstream E: no unbounded N+1 into apps/api).
 */
const MAX_RELEVANCE_PROBES = 50;

/**
 * Trailing window for USAspending obligation totals on `getContractors`. Part of
 * the response contract: the federal-award measure reports `windowMonths`
 * alongside its `asOf`, so a reader can tell a 24-month total from a 12-month one.
 * Keep this and the SQL interval in the query below in step.
 */
const AWARD_WINDOW_MONTHS = 24;

const LEGACY_PE_WATCH_CONSTRAINT = 'program_element_watch_user_pe_code_key';

/**
 * During the expand/contract window the legacy (user_id, pe_code) key still
 * exists so old containers can roll back safely. A user who already watches a PE
 * in another tenant will therefore hit that legacy key until the later contract
 * migration. Detect only that named constraint and fail closed: never rewrite
 * tenant_id and never reveal which other tenant owns the existing row.
 */
function isLegacyPeWatchConstraintConflict(error: unknown): boolean {
  const candidates: unknown[] = [String(error)];
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    candidates.push(record.message, record.code);
    if (record.meta && typeof record.meta === 'object') {
      candidates.push(...Object.values(record.meta as Record<string, unknown>));
    }
  }
  return candidates.some(
    (value) => typeof value === 'string' && value.includes(LEGACY_PE_WATCH_CONSTRAINT),
  );
}

/**
 * Bounded TTL cache for the PE detail payload, mirroring apps/api's
 * `LRUCache({ ttl: 60_000, max: 500 })` without adding a dependency.
 *
 * Only TENANT-AGNOSTIC catalog data is cached: `currentUserIsWatching` is
 * resolved per request and merged on top of the cached record, exactly as
 * apps/api does, so a cache hit can never leak one tenant's watch state to
 * another.
 */
class DetailCache {
  private readonly entries = new Map<string, { value: Record<string, unknown>; expires: number }>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly max = 500,
  ) {}

  get(key: string): Record<string, unknown> | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency so the eviction below is least-recently-used, not insertion order.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: Record<string, unknown>): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Session 3 Program Elements read/mutation service.
 *
 * Real DB logic against defense-api's own Prisma client (never importing apps/api
 * service code). Every response contract here is a field-by-field port of
 * `apps/api/src/program-element/program-element-read.service.ts`; the pure money,
 * funding-claim, provenance-ordering, provision-merge and intelligence decisions
 * are made by `@capiro/defense-domain/pe-read`, which wraps the SAME
 * `@capiro/shared` primitives apps/api wraps — so those semantics are identical by
 * construction rather than by two implementations agreeing.
 *
 * Cross-domain reads (Congress bills, SAM notices, USAspending awards, committee
 * provisions) go through the bounded read-only projections declared in this app's
 * own Prisma schema, joined here. Cross-domain reads that need ANOTHER context's
 * live logic (client<->PE relevance, query embedding) go through the typed,
 * batched ports in `@capiro/defense-contracts` — never a per-row call into apps/api.
 *
 * NATIVE IDENTITY BOUNDARIES preserved: peCode is a Program Element identity only.
 * No BLIN/O&M-BLI resolver exists in this module; cross-family reads
 * (federal_award.peCode, sam_opportunity_match.peCode, bill peCodes,
 * program_element_acquisition_program) use only the attribution the OWNING domain
 * already computed and persisted. This service never derives or coerces one
 * identity into another.
 */
@Injectable()
export class ProgramElementReadService {
  private readonly logger = new Logger(ProgramElementReadService.name);
  private readonly detailCache = new DetailCache();
  private readonly overrides: ManualOverrideRepositoryPrisma;

  constructor(
    private readonly prisma: PrismaService,
    private readonly conferenceProbability: ConferenceProbabilityReadService,
    @Optional()
    @Inject(CLIENT_RELEVANCE_PORT)
    private readonly clientRelevance?: ClientRelevancePort,
    @Optional()
    @Inject(EMBEDDING_PORT)
    private readonly embedding?: EmbeddingPort,
  ) {
    this.overrides = new ManualOverrideRepositoryPrisma(prisma);
  }

  // =========================================================================
  // Finder list + summary
  // =========================================================================

  async listProgramElements(query: ProgramElementListQuery, ctx?: DefenseTenantContext) {
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
    const tenantId = ctx?.tenantId ?? null;
    // BL-1 money-graph facets: line_type filters on the intelligence cache;
    // capability filters via the auditable match table (accepted rows only).
    const lineType = query.lineType?.trim();
    const capability = query.capability?.trim();

    // A PE "has data" if it has at least one FY history row, a PE-linked federal
    // award, or a bill that references it. Computed once per row via EXISTS so the
    // finder can flag (and optionally hide) sparse PEs whose detail panels are empty.
    const hasDataExpr = Prisma.sql`(
      EXISTS (SELECT 1 FROM program_element_year y WHERE y.pe_code = pe.pe_code)
      OR EXISTS (SELECT 1 FROM federal_award fa WHERE fa.pe_code = pe.pe_code)
      OR EXISTS (SELECT 1 FROM congress_bill b WHERE pe.pe_code = ANY(b.pe_codes))
    )`;

    // Per-user watch flag. Runs inside withTenant (below) so the
    // program_element_watch RLS policy is satisfied; FALSE with no user context.
    const watchedExpr =
      userId && tenantId
        ? Prisma.sql`EXISTS (SELECT 1 FROM program_element_watch pw WHERE pw.tenant_id = ${tenantId}::uuid AND pw.user_id = ${userId}::uuid AND pw.pe_code = pe.pe_code)`
        : Prisma.sql`FALSE`;

    // The redesigned finder shows per-row money, a 6-yr funding sparkline, a bill
    // count, the watch flag and the most-material live signal. The page of PEs is
    // selected + counted first (cheap base columns), then enriched via LATERALs and
    // the detail MV so the expensive per-PE lookups run only for the <=limit rows on
    // the page - not for the whole catalog.
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
        ler.request::double precision AS "requestAtEnactedFy",
        ${Prisma.raw(fundingCurrentCoalesceSql('lc.'))}::double precision AS "latestCurrent",
        lc.fy AS "latestCurrentFy",
        ${Prisma.raw(fundingCurrentStageSql('lc.'))} AS "latestCurrentStage",
        pcy.pe_current_cycle_fy AS "peCurrentCycleFy",
        -- Matched-pair % only: enacted vs request-at-enacted-FY (ler). Zero request -> null pct.
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
        WHERE y.pe_code = f.pe_code AND y.request IS NOT NULL
        ORDER BY y.fy DESC
        LIMIT 1
      ) lr ON TRUE
      LEFT JOIN LATERAL (
        SELECT y.enacted, y.fy
        FROM program_element_year y
        WHERE y.pe_code = f.pe_code AND y.enacted IS NOT NULL
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
        -- Mark-bearing PE cycle (incl NDAA); request-only FYDP outyears do not win.
        SELECT ${Prisma.raw(sqlCurrentCycleFyExpr('y'))} AS pe_current_cycle_fy
        FROM program_element_year y
        WHERE y.pe_code = f.pe_code
      ) pcy ON TRUE
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
    // EXISTS clears RLS on program_element_watch; the program_element catalog
    // itself is global reference data and is unaffected by the tenant GUC.
    type ListRow = PeListSqlRow & { totalCount: number };
    const rows = ctx?.tenantId
      ? await this.prisma.withTenant(ctx.tenantId, (tx) => tx.$queryRaw<ListRow[]>(listSql))
      : await this.prisma.$queryRaw<ListRow[]>(listSql);

    const total = rows[0]?.totalCount ?? 0;
    return {
      data: rows.map(({ totalCount: _ignored, ...rest }) => projectPeListRow(rest)),
      total,
      page,
      limit,
    };
  }

  private async listMarkupMonitor(query: ProgramElementListQuery, ctx?: DefenseTenantContext) {
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
      /** Max within-track chamber span % - never blends auth with approps. */
      divergencePct: number;
      authDivergencePct: number;
      appropsDivergencePct: number;
      divergenceTrack: 'authorization' | 'appropriations' | null;
      totalCount: number;
    };

    // Per-track divergence only (HASC<->SASC | HAC-D<->SAC-D). Cross-track
    // GREATEST/LEAST is forbidden (Phase G gate / review B1).
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRaw<MarkupMonitorRow[]>(Prisma.sql`
        WITH watched AS (
          SELECT DISTINCT pew.pe_code
          FROM program_element_watch pew
          WHERE pew.tenant_id = ${ctx.tenantId}::uuid
        ),
        pe_cycle AS (
          -- Mark-bearing / NDAA-aware cycle FY per PE (not bare MAX(fy)).
          SELECT pey.pe_code, ${Prisma.raw(sqlCurrentCycleFyExpr('pey'))} AS cycle_fy
          FROM program_element_year pey
          JOIN watched w ON w.pe_code = pey.pe_code
          GROUP BY pey.pe_code
        ),
        current_cycle AS (
          SELECT
            pey.pe_code,
            pey.fy,
            pey.request,
            pey.hasc_mark,
            pey.sasc_mark,
            pey.hac_d_mark,
            pey.sac_d_mark
          FROM program_element_year pey
          JOIN pe_cycle c ON c.pe_code = pey.pe_code AND pey.fy = c.cycle_fy
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
              WHEN cc.request IS NULL OR cc.request = 0 THEN 0::double precision
              ELSE (
                (
                  GREATEST(
                    COALESCE(cc.hasc_mark, cc.request),
                    COALESCE(cc.sasc_mark, cc.request)
                  )
                  -
                  LEAST(
                    COALESCE(cc.hasc_mark, cc.request),
                    COALESCE(cc.sasc_mark, cc.request)
                  )
                ) / cc.request::double precision
              ) * 100
            END AS "authDivergencePct",
            CASE
              WHEN cc.request IS NULL OR cc.request = 0 THEN 0::double precision
              ELSE (
                (
                  GREATEST(
                    COALESCE(cc.hac_d_mark, cc.request),
                    COALESCE(cc.sac_d_mark, cc.request)
                  )
                  -
                  LEAST(
                    COALESCE(cc.hac_d_mark, cc.request),
                    COALESCE(cc.sac_d_mark, cc.request)
                  )
                ) / cc.request::double precision
              ) * 100
            END AS "appropsDivergencePct"
          FROM current_cycle cc
          JOIN program_element pe ON pe.pe_code = cc.pe_code
          WHERE pe.retired_at IS NULL
            AND (${service ? Prisma.sql`pe.service ILIKE ${service}` : Prisma.sql`TRUE`})
        ),
        scored AS (
          SELECT
            "peCode",
            title,
            service,
            request,
            "hascMark",
            "sascMark",
            "hacDMark",
            "sacDMark",
            "authDivergencePct",
            "appropsDivergencePct",
            GREATEST("authDivergencePct", "appropsDivergencePct") AS "divergencePct",
            CASE
              WHEN GREATEST("authDivergencePct", "appropsDivergencePct") <= 0 THEN NULL
              WHEN "authDivergencePct" >= "appropsDivergencePct" THEN 'authorization'
              ELSE 'appropriations'
            END AS "divergenceTrack"
          FROM enriched
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
          "authDivergencePct",
          "appropsDivergencePct",
          "divergenceTrack",
          COUNT(*) OVER()::int AS "totalCount"
        FROM scored
        WHERE "divergencePct" >= ${divergenceThreshold}
        ORDER BY "divergencePct" DESC, "peCode" ASC
      `),
    );

    const total = rows[0]?.totalCount ?? 0;
    return {
      data: rows.map(({ totalCount: _ignored, ...rest }) => {
        // Re-assert track separation in TS so a bad SQL path cannot blend tracks.
        const track = markupMonitorTrackDivergence({
          request: rest.request,
          hascMark: rest.hascMark,
          sascMark: rest.sascMark,
          hacDMark: rest.hacDMark,
          sacDMark: rest.sacDMark,
        });
        return {
          ...rest,
          authDivergencePct: track.authDivergencePct,
          appropsDivergencePct: track.appropsDivergencePct,
          divergencePct: track.divergencePct,
          divergenceTrack: track.divergenceTrack,
        };
      }),
      total,
      page: 1,
      limit: rows.length,
    };
  }

  async getSummary(query: { service?: string; hasData?: string }, ctx?: DefenseTenantContext) {
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
      // Portfolio money as a MATCHED-PAIR sum: for each PE, its own latest FY with
      // a real enacted value, and the request recorded AT THAT SAME FY (if any).
      // Both totals - and avgDeltaPct - are built from this one identical set of
      // (request, enacted) pairs, so the three numbers are ARITHMETICALLY
      // guaranteed to reconcile. Summing each column independently over one global
      // FY does not: budget books record a prior year's dollars as enacted-only far
      // more often than they carry a matching historical request, so a single-FY
      // sum compares a near-universal enacted total against a sparse request total
      // from a DIFFERENT, smaller set of PEs. Matching per-PE at each PE's own
      // enacted year means a PE contributes to BOTH totals only when it has a
      // genuine request-vs-enacted pair, so the delta is never an artifact of
      // mismatched coverage. There is therefore no single portfolio FY to tag.
      this.prisma.$queryRaw<
        Array<{
          totalRequest: number | null;
          totalEnacted: number | null;
          avgDeltaPct: number | null;
          populationSize: number | null;
          contributedPairs: number | null;
        }>
      >(Prisma.sql`
        SELECT
          COALESCE(SUM(ler.request) FILTER (WHERE ler.request IS NOT NULL), 0)::double precision AS "totalRequest",
          COALESCE(SUM(le.enacted) FILTER (WHERE ler.request IS NOT NULL AND le.enacted IS NOT NULL), 0)::double precision AS "totalEnacted",
          (
            CASE
              WHEN SUM(ler.request) FILTER (WHERE ler.request IS NOT NULL AND le.enacted IS NOT NULL) <> 0
              THEN (
                (
                  SUM(le.enacted) FILTER (WHERE ler.request IS NOT NULL AND le.enacted IS NOT NULL)
                  - SUM(ler.request) FILTER (WHERE ler.request IS NOT NULL AND le.enacted IS NOT NULL)
                )
                / SUM(ler.request) FILTER (WHERE ler.request IS NOT NULL AND le.enacted IS NOT NULL)
              ) * 100
              ELSE NULL
            END
          )::double precision AS "avgDeltaPct",
          COUNT(*) FILTER (WHERE pe.retired_at IS NULL)::int AS "populationSize",
          COUNT(*) FILTER (WHERE ler.request IS NOT NULL AND le.enacted IS NOT NULL)::int AS "contributedPairs"
        FROM program_element pe
        LEFT JOIN LATERAL (
          SELECT y.enacted, y.fy FROM program_element_year y
          WHERE y.pe_code = pe.pe_code AND y.enacted IS NOT NULL
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
          SELECT COUNT(*)::int AS count
          FROM program_element_watch
          WHERE tenant_id = ${ctx.tenantId}::uuid
            AND user_id = ${ctx.userId}::uuid
        `),
      );
      watched = wr[0]?.count ?? 0;
    }

    const populationSize = moneyRows[0]?.populationSize ?? trackedRows[0]?.tracked ?? 0;
    const contributedPairs = moneyRows[0]?.contributedPairs ?? 0;
    return {
      tracked: trackedRows[0]?.tracked ?? 0,
      withData: trackedRows[0]?.withData ?? 0,
      watched,
      // No single FY tag - each PE's matched pair can fall in a different year, so
      // the UI shows plain "aggregate". Cross-FY % is impossible here because each
      // pair is same-FY by construction; zeros count.
      latestRequestFy: null,
      totalRequest: moneyRows[0]?.totalRequest ?? null,
      latestEnactedFy: null,
      totalEnacted: moneyRows[0]?.totalEnacted ?? null,
      avgDeltaPct: moneyRows[0]?.avgDeltaPct ?? null,
      openMarkups: markupRows[0]?.count ?? 0,
      trend: trendRows.map((r) => ({ fy: r.fy, total: r.total })),
      byService: byServiceRows.map((r) => ({ service: r.service, count: r.count })),
      // Phase G - movement KPI coverage over the FULL filtered PE population.
      movementCoverage: {
        populationSize,
        contributedCount: contributedPairs,
        missingCount: Math.max(0, populationSize - contributedPairs),
        disclosure: `Matched request/enacted pairs: ${contributedPairs} of ${populationSize} in filtered population`,
      },
    };
  }

  // =========================================================================
  // Detail / intelligence / timeline / narrative
  // =========================================================================

  async getProgramElement(peCodeRaw: string, ctx: DefenseTenantContext) {
    const peCode = requirePeCode(peCodeRaw);
    const cacheKey = peCode;

    const watch = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM program_element_watch
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND user_id = ${ctx.userId}::uuid
          AND pe_code = ${peCode}
        LIMIT 1
      `),
    );

    const cached = this.detailCache.get(cacheKey);
    if (cached) {
      return { ...cached, currentUserIsWatching: Boolean(watch[0]) };
    }

    // The base row is authoritative for every field the detail view renders AND it
    // carries the COMPLETE budget-year history: the FY chart, the per-FY mark
    // drawer and the win-rate calc all need every year, not just the latest.
    const programElement = await this.prisma.programElement.findUnique({
      where: { peCode },
      include: { years: { orderBy: { fy: 'asc' } } },
    });
    if (!programElement) throw new NotFoundException(`Program element ${peCode} not found`);

    // Best-effort enrichment from the detail materialized view: it precomputes the
    // (expensive) count of bills touching this PE. The MV can be absent or stale on
    // a fresh database, so a miss is non-fatal - the detail above still renders
    // fully from the authoritative base row.
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

    // Cheap counts so the profile can badge "Projects (n)" / "Sources (n)" and
    // lazy-load the panels only when present. currentCycleFy is the FY with the
    // most PEs carrying a live PB request (the catalog mode) - i.e. "the current
    // budget cycle" the vast majority of active PEs are in. Lets the UI flag a PE
    // whose own latest year of record predates it as historical rather than
    // silently sparse.
    const [projectCount, sourceCount, cycleRows] = await Promise.all([
      this.prisma.programElementProject.count({ where: { peCode } }),
      this.prisma.programElementSource.count({ where: { peCode } }),
      this.prisma.$queryRaw<Array<{ fy: number | null }>>(Prisma.sql`
        SELECT fy
        FROM program_element_year
        WHERE request IS NOT NULL
        GROUP BY fy
        ORDER BY COUNT(*) DESC, fy DESC
        LIMIT 1
      `),
    ]);

    const fundingYears = programElement.years.map(
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
    );

    const detail: Record<string, unknown> = {
      // RC1: canonical labeled funding block for LLM callers (FY + stage +
      // authorization/appropriations vehicle + signed vs-request + NDAA conference
      // surfaced separately), from the SAME shared serializer the timeline tool and
      // outreach truth block use. Web ignores this field. The catalog-wide
      // modeRequest currentCycleFy is set below (a separate catalog signal). The PE
      // mark-bearing cycle for fundingSummary MUST match getTimeline /
      // currentCycleFyPreservingZero incl NDAA (Phase 4 B6).
      // RC9: kept BEFORE the `...programElement` spread (whose `years` array is the
      // bulk of the payload) so a record-safe truncation of an oversized detail
      // keeps the funding summary intact rather than cutting it off the tail.
      fundingSummary: renderPeFundingForModel({
        peCode: programElement.peCode,
        title: programElement.title,
        service: programElement.service,
        currentCycleFy: currentCycleFyPreservingZero(fundingYears),
        years: fundingYears,
      }),
      ...programElement,
      billCount: mvRows[0]?.billCount ?? null,
      projectCount,
      sourceCount,
      currentCycleFy: cycleRows[0]?.fy ?? null,
    };

    this.detailCache.set(cacheKey, detail);

    return { ...detail, currentUserIsWatching: Boolean(watch[0]) };
  }

  async getIntelligence(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const pe = await this.prisma.programElement.findUnique({
      where: { peCode },
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

    const years = pe.years.map((y) => ({
      fy: y.fy,
      request: num(y.request),
      hascMark: num(y.hascMark),
      sascMark: num(y.sascMark),
      hacDMark: num(y.hacDMark),
      sacDMark: num(y.sacDMark),
      // The intelligence layer's "conference" signal (posture + prior-year
      // trajectory) is the NDAA conference - the only conference value ever
      // populated - so feed it ndaaConference here. The appropriations `conference`
      // rung stays out of this (it drives currentFunding via @capiro/shared, not
      // the intelligence posture).
      conference: num(y.ndaaConference),
      enacted: num(y.enacted),
    }));

    // Stated FYDP outyears (PB budget positions) extend the runway series.
    const positions = await this.prisma.programElementBudgetPosition.findMany({
      where: { peCode, valueKind: 'total', positionCycle: { startsWith: 'pb_' } },
      select: { assertedFy: true, amount: true },
    });
    const maxYearFy = years.reduce((m, y) => Math.max(m, y.fy), 0);
    const outyears = positions
      .filter((o) => o.assertedFy > maxYearFy)
      .map((o) => ({ fy: o.assertedFy, amount: num(o.amount) }));

    const line = await this.prisma.programElementProcurementLine.findFirst({
      where: { peCode, quantity: { not: null } },
      orderBy: { fy: 'desc' },
      select: { quantity: true },
    });

    // BL-1: the derive-time cache carries the graph-aware verdicts (the maturity
    // ladder needs relationship edges + award counts; appropriability needs the
    // full evidence census) - computed nightly by derive-intelligence-cache, not
    // re-derivable cheaply per request. Null until the first derive run.
    const cache = await this.prisma.programElementIntelligenceCache.findUnique({
      where: { peCode },
    });

    return {
      peCode: pe.peCode,
      ...buildIntelligence({
        appropriationType: pe.appropriationType,
        budgetActivity: pe.budgetActivity,
        years,
        outyears,
        quantity: line ? num(line.quantity) : null,
      }),
      lineType: cache?.lineType ?? null,
      maturityLadder: cache?.maturityJson ?? null,
      appropriability: cache?.appropJson ?? null,
      valleyOfDeath: cache?.valleyOfDeath ?? false,
      cacheComputedAt: cache?.computedAt ?? null,
    };
  }

  async getTimeline(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
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
      this.prisma.programElementYear.findMany({ where: { peCode }, orderBy: { fy: 'asc' } }),
      this.prisma.programElementMilestone.findMany({
        where: { peCode },
        orderBy: [{ plannedDate: 'asc' }, { milestoneType: 'asc' }],
      }),
    ]);

    // Current budget CYCLE FY via the shared helper (zeros + NDAA conference count
    // as real marks). Congress only marks the year in process; later FYs are FYDP
    // outyear projections. Omitting ndaaConference fails closed-wrongly: an
    // NDAA-only mark year would be labeled outyear (review B3).
    const currentCycleFy = currentCycleFyPreservingZero(
      years.map((y) => ({
        fy: y.fy,
        request: num(y.request),
        hascMark: num(y.hascMark),
        sascMark: num(y.sascMark),
        hacDMark: num(y.hacDMark),
        sacDMark: num(y.sacDMark),
        conference: num(y.conference),
        ndaaConference: num(y.ndaaConference),
      })),
    );

    const yearsWithConferenceProbability = await Promise.all(
      years.map(async (year) => {
        // GAI-25: the read path must not write - compute + return, never persist.
        // ConferenceProbabilityReadService has no persisting branch at all, and the
        // HTTP role holds no write grant on conference_probability.
        const prediction = await this.conferenceProbability.predict(peCode, year.fy);
        const values = {
          request: num(year.request),
          hascMark: num(year.hascMark),
          sascMark: num(year.sascMark),
          hacDMark: num(year.hacDMark),
          sacDMark: num(year.sacDMark),
          conference: num(year.conference),
          enacted: num(year.enacted),
          ndaaConference: num(year.ndaaConference),
        };
        return {
          ...this.serializeYearRow(year),
          ...projectPeTimelineYear({ fy: year.fy, values, currentCycleFy, prediction }),
        };
      }),
    );

    // RC1: a canonical, fully-labeled funding block for LLM callers, rendered from
    // the SAME shared serializer the outreach truth block uses so no surface can
    // drift. Web consumers ignore this extra field.
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
   * Phase 4 (4.1) - the assembled "request -> marks -> enactment" narrative for the
   * current budget cycle: one ordered, stage-labeled story per PE, with the FY's
   * materiality-scored deltas surfaced alongside (4.1.2). Pure assembly over
   * getTimeline + getDeltas - no new data modeling.
   */
  async getNarrative(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
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
    // The FY's material moves, most-material first (4.1.2 - surface, don't fuzzily
    // join per-step).
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

  // =========================================================================
  // Legislative
  // =========================================================================

  async getBills(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
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
        committeeRefs: { select: { committeeName: true }, take: 1 },
      },
    });

    // LEG-B: evidence-typed link rows for THIS pe across the returned bills. Falls
    // back gracefully (link: null) for bills linked only via the legacy peCodes
    // array (extractor not yet re-run against them).
    const links = await this.prisma.billBudgetLineLink.findMany({
      where: { peCode, billId: { in: bills.map((b) => b.id) }, status: { not: 'rejected' } },
      select: { billId: true, linkType: true, confidence: true, evidence: true, status: true },
    });
    const linkByBill = new Map(links.map((l) => [l.billId, l]));

    // R4 4.2: the budget package each bill rides in, so the PE panel can label the
    // legislative vehicle's cycle ("FY27 Defense Budget - authorization - house").
    // ONE query for every bill; absent for a bill that is not a budget vehicle,
    // which is the normal case and renders as no label rather than a guess.
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

    // peCodeCount = how many distinct PEs this bill references. This is the signal
    // the UI needs to stop showing "the same two bills on every PE": the annual
    // NDAA references 700+ PEs, so it surfaces on every program element and tells a
    // lobbyist nothing PE-specific. A bill that names a handful of PEs is genuinely
    // targeting this one. Sort the PE-specific bills first (fewest PEs), then by
    // recency, and tag the blanket authorizers so the panel can label +
    // de-emphasize them rather than hide real legislation.
    //
    // passageProbability is intentionally omitted - Congress.gov gives no such
    // signal, so the UI shows honest metadata rather than a fabricated score.
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
      if (a.peCodeCount !== b.peCodeCount) return a.peCodeCount - b.peCodeCount;
      const at = a.latestActionDate ? new Date(a.latestActionDate).getTime() : 0;
      const bt = b.latestActionDate ? new Date(b.latestActionDate).getTime() : 0;
      return bt - at;
    });
    return mapped;
  }

  /**
   * Full legislative-action history for the bills touching this PE (LEG-A). Each
   * action is classified with the pure stage normalizer AT READ TIME - the raw
   * action text is returned verbatim alongside the stage, never replaced by it.
   * Bounded: the 40 most-recent bills x their 60 newest actions, capped at 200
   * events overall.
   */
  async getBillActions(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
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
          /** How many PEs the bill references - lets the UI de-emphasize blanket authorizers. */
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

  // =========================================================================
  // Industry
  // =========================================================================

  async getContractors(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    // A live external observation dates itself at the moment it is taken. No
    // snapshot is resolved here: neither measure below is snapshot-backed (see the
    // provenance note on governmentExhibit), so resolving one would be a round trip
    // whose only use would be labelling data it did not produce.
    const awardsAsOf = new Date().toISOString();

    const tableExists = await this.prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'federal_award'
      ) AS "exists"
    `);

    if (!tableExists[0]?.exists) {
      return { data: [], todo: 'federal_award table not yet created (Step 28)' };
    }

    type ContractorRow = { contractorName: string; amount: number; awards: number; source: string };
    // federal_award.amount is stored in raw obligated DOLLARS, but the UI renders
    // contractor totals in millions - divide by 1e6 here. The 24-month window keys
    // off the action date with awarded_at as a fallback, because USAspending often
    // leaves awarded_at null while action_date is always populated.
    //
    // Linkage is two-tier and labeled for honest provenance:
    //   (a) direct: federal_award.pe_code = this PE (explicit/legacy resolution).
    //   (b) program: awards whose DoD acquisition (MDAP) program code maps to this
    //       PE via the reviewed program_element_acquisition_program table.
    //
    // NATIVE IDENTITY: (b) reads an association the OWNING domain already curated
    // and persisted (pe_code <-> acq_program_code). This service performs no
    // derivation of one identity from another - it joins a governed crosswalk.
    //
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

    // Provenance the UI can render verbatim so users know HOW a contractor was tied
    // to this PE.
    const data = rows.map((r) => ({
      ...r,
      attribution:
        r.source === 'direct'
          ? 'Award attributed to this program element'
          : 'Linked via DoD Acquisition Program (USAspending)',
    }));

    // Layer 1 (PRIMARY): named primes straight from the Service's own R-3 "Product
    // Development" exhibit. Zero inference - the government names the performing
    // activity per PE. Surface real named companies (isNamedCompany) first; this is
    // the defensible "who are the primes on this program" answer and is independent
    // of whether USAspending dollars have been linked yet.
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

    const directAwardM = data
      .filter((r) => r.source === 'direct')
      .reduce((s, r) => s + (r.amount ?? 0), 0);
    const directAwardN = data
      .filter((r) => r.source === 'direct')
      .reduce((s, r) => s + (r.awards ?? 0), 0);
    const candidateAwardM = data
      .filter((r) => r.source === 'program')
      .reduce((s, r) => s + (r.amount ?? 0), 0);
    const candidateAwardN = data
      .filter((r) => r.source === 'program')
      .reduce((s, r) => s + (r.awards ?? 0), 0);
    const namedPrimeM = namedPrimes.reduce((s, r) => s + (r.totalCostM ?? 0), 0);
    // These two measures are NEVER added. A government-stated R-3 exhibit value and
    // a rolling 24-month USAspending obligation total differ in source, temporal
    // semantics, financial meaning, reproducibility and update cadence; rendering
    // them as one dollar figure produces a number a reader cannot decompose, and
    // one that changes daily while claiming to describe an immutable exhibit.
    //
    // Each bucket carries its own attribution and its own "as of". The award side
    // keeps the Phase G evidence-class partition, which is meaningful WITHIN one
    // provenance kind - direct pe_code match vs MDAP-program link.
    //
    // No combined total is emitted. One would require defining and governing a real
    // metric that means something across both, and no such metric exists.
    const evidence = {
      governmentExhibit: {
        amountM: namedPrimeM,
        count: namedPrimes.length,
        unit: 'USD millions' as const,
        label: 'Government-named performer value (R-3 exhibit)',
        // `legacy_compatibility`, NOT `canonical_snapshot`. namedPrimes above reads
        // program_element_performer unconditionally, so claiming snapshot provenance
        // would attach a real snapshot id to legacy data the moment any snapshot
        // went active - exactly the misattribution this contract exists to prevent.
        //
        // This cannot become `canonical_snapshot` by migrating the read alone:
        // canonical_rdte_performer is declared moneyRule: 'none' with value axes
        // ['identity','text'], so the canonical row carries no totalCostM at all.
        // The exhibit VALUE has no canonical home until that entity gains a money axis.
        provenance: {
          kind: 'legacy_compatibility' as const,
          source: 'R-3',
          table: 'program_element_performer',
          reason:
            'canonical_rdte_performer carries no money axis (moneyRule: none), so the exhibit ' +
            'value has no canonical source; the read stays on the compatibility table',
        },
      },
      federalAwards: {
        amountM: directAwardM + candidateAwardM,
        count: directAwardN + candidateAwardN,
        unit: 'USD millions' as const,
        label: 'Recent federal award obligations (USAspending)',
        provenance: {
          kind: 'live_external' as const,
          source: 'USAspending',
          asOf: awardsAsOf,
          windowMonths: AWARD_WINDOW_MONTHS,
        },
        // Evidence classes within the award side only.
        buckets: partitionContractorEvidence({
          acceptedDirectAmountM: directAwardM,
          acceptedDirectCount: directAwardN,
          candidateAmountM: candidateAwardM,
          candidateCount: candidateAwardN,
          // Unmatched PE-universe dollars are not inventoried on this endpoint.
          unmatchedAmountM: 0,
          unmatchedCount: 0,
        }),
      },
    };

    return {
      // Named primes from the budget exhibit (Layer 1) - the primary, precise answer.
      namedPrimes,
      // Award dollar-flow over the last 24 months (Layer 2/3 - direct pe_code,
      // MDAP-program link, or UEI-confirmed R-3 prime via enrich-award-pe-tas).
      data,
      evidence,
      evidenceNote:
        'accepted_direct = PE-coded awards + R-3 named primes; candidate = MDAP-program-linked awards; unmatched_dollars not inventoried here (fail closed / listed as 0).',
      todo: null,
    };
  }

  /**
   * Secondary Distribution per-recipient procurement line items for a PE (P-40).
   * Each row is (recipient lineDescription x fiscal year) carrying quantity +
   * obligation-authority dollars, grouped per recipient so the UI can render a
   * multi-year table, with the distinct fiscal years present for a stable header.
   */
  async getProcurementLines(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
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
   * R-2A projects/sub-elements for a PE. Ordered by project code; each carries its
   * own page-level citation (sourceUrl + pageNumber) so the UI can deep-link to the
   * exact exhibit page. Empty array (never an error) when this PE has no extracted
   * projects.
   */
  async getProjects(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
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
   * Proof-pack: every page-level citation for a PE, each joined to its
   * SourceDocument (title/budgetCycle/sha256) and ordered in document order
   * (R-1 -> R-2 -> R-2A -> R-3 -> P-1 -> P-40), then FY desc, page asc - so the UI
   * can render "show me the source" with an open-at-page deep link.
   *
   * Provenance is the whole point of this endpoint, so exhibitType, publisher,
   * snippet, confidence, pageEnd and the source document are all part of the
   * contract. Returns a BARE ARRAY (not an envelope), matching apps/api.
   */
  async getSources(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
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
   * "Related Program Elements" - SUGGESTIONS, not hard links.
   *
   * Reads this PE's stored mission embedding (context_embeddings,
   * source_type='pe') and returns the nearest other PE vectors by cosine
   * similarity. Intentionally framed as "PEs with similar missions", never as a
   * definitive relationship: the score is a semantic-nearness signal, not a
   * documented fact, so the response carries the similarity and the UI labels it a
   * suggestion. Returns an empty list (never throws) when this PE has no embedding
   * yet, so the panel degrades gracefully before the backfill has run.
   */
  async getRelatedProgramElements(peCodeRaw: string, limit = 8) {
    const peCode = requirePeCode(peCodeRaw);
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    // Relevance floor (cosine similarity). Defense PE descriptions share a lot of
    // boilerplate, so this is set fairly high to avoid surfacing tangential PEs.
    const SIMILARITY_FLOOR = 0.7;
    const embeddingModel = this.embeddingModel();

    // Self-join on the pe vectors: <=> is pgvector cosine DISTANCE, so
    // (1 - distance) is similarity. The source vector is pulled inline by peCode
    // rather than round-tripped through an embedding provider - it already exists,
    // no model call needed, which is also why this route works in dark posture.
    // Read through capiro_defense_related_pe_vectors, NOT context_embeddings
    // directly. That table carries FORCE ROW LEVEL SECURITY whose policy references
    // the CRM's `clients` / `client_memory_access` tables, and PostgreSQL demands
    // privileges on every table a policy expression touches -- so a direct read
    // fails with "permission denied for table clients" unless the defense HTTP role
    // is also handed the client list, which is exactly the cross-domain coupling
    // this workstream removes. The function is fixed-shape, STABLE, and hard-scoped
    // to the GLOBAL (tenant_id IS NULL) source_type='pe' partition, so no
    // tenant-scoped or client-scoped vector is reachable through it.
    let rows: Array<{ peCode: string; score: number }> = [];
    try {
      rows = await this.prisma.$queryRaw<Array<{ peCode: string; score: number }>>(Prisma.sql`
        SELECT pe_code AS "peCode", score
        FROM capiro_defense_related_pe_vectors(
          ${peCode}, ${embeddingModel}, ${SIMILARITY_FLOOR}::double precision, ${limit}::int
        )
      `);
    } catch {
      // No pgvector / function absent / embedding missing - degrade to empty so the
      // panel renders its honest empty state rather than 500ing.
      rows = [];
    }

    // Titles/services come from the catalog, which serve reads directly.
    const neighbours = await this.prisma.programElement.findMany({
      where: { peCode: { in: rows.map((r) => r.peCode) } },
      select: { peCode: true, title: true, service: true },
    });
    const neighbourByCode = new Map(neighbours.map((n) => [n.peCode, n]));

    return {
      // Explicitly a suggestion list. The UI MUST label it as such.
      related: rows
        .filter((r) => neighbourByCode.has(r.peCode))
        .map((r) => ({
          peCode: r.peCode,
          title: neighbourByCode.get(r.peCode)!.title,
          service: neighbourByCode.get(r.peCode)!.service,
          // 0..1 cosine similarity, surfaced so the user can weigh the suggestion.
          similarity: Math.round(r.score * 100) / 100,
        })),
      todo:
        rows.length === 0
          ? 'No related program elements yet — similarity suggestions appear once mission embeddings are generated.'
          : null,
    };
  }

  // =========================================================================
  // Program graph / provisions / opportunities
  // =========================================================================

  async getProgramsForPe(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);

    const matches = await this.prisma.peProgramMatch.findMany({
      // Only accepted + candidate are ever surfaced; quarantined/rejected/weak-signal never are.
      where: { peCode, status: { in: ['accepted', 'candidate'] } },
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
      whyShown: buildWhyShown(m.evidence),
      evidence: m.evidence,
      resolvedAt: m.resolvedAt,
    });

    return {
      peCode,
      acceptedMatches: matches.filter((m) => m.status === 'accepted').map(decorate),
      candidateMatches: matches.filter((m) => m.status === 'candidate').map(decorate),
    };
  }

  /**
   * Committee-report LANGUAGE provisions linked to this PE.
   *
   * Two link paths, unioned:
   *   (a) DIRECT - provision_pe_link.pe_code = this PE (pe_code / project_title bases).
   *   (b) PROGRAM - the provision mentions a PROGRAM (program_alias basis, pe_code
   *       NULL) that maps to this PE via an ACCEPTED pe_program_match. FY committee
   *       reports name PROGRAMS, not PE codes (verified: FY2027 reports carry ZERO
   *       PE codes across 2,220 pages), so nearly every real link is the program
   *       path; filtering by pe_code alone surfaces none.
   *
   * Only ACCEPTED + CANDIDATE links are surfaced. The merge, RC7 scope/caveat and
   * ordering are the shared pure `mergeProvisionLinks`.
   */
  async getProvisionsForPe(peCodeRaw: string): Promise<ProvisionItem[]> {
    const peCode = requirePeCode(peCodeRaw);

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

    const programMatches = await this.prisma.peProgramMatch.findMany({
      where: { peCode, status: 'accepted' },
      select: { programId: true },
    });
    const programIds = [...new Set(programMatches.map((m) => m.programId))];

    const [directLinks, programLinks] = await Promise.all([
      this.prisma.provisionPeLink.findMany({
        where: { peCode, reviewStatus: { in: ['accepted', 'candidate'] } },
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

    return mergeProvisionLinks(
      directLinks as unknown as ProvisionLinkRow[],
      programLinks as unknown as ProvisionLinkRow[],
    );
  }

  /**
   * ACTIVE SAM.gov procurement notices linked to this PE.
   *
   * Only surfaces matches that are BOTH (a) reviewStatus accepted OR candidate AND
   * (b) on an active notice. QUARANTINED / rejected matches are NEVER returned - a
   * PSC/NAICS-only match lands as 'quarantined' and must clear human review first.
   * Ordered by responseDeadline ASCENDING with NULL deadlines LAST.
   *
   * The POC is the OFFICIAL contracting contact - surfaced for provenance, NEVER as
   * a lobbying/outreach target.
   */
  async listOpportunities(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);

    const matches = await this.prisma.samOpportunityMatch.findMany({
      where: {
        peCode,
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

    const items = matches.map((m) => ({
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

    // responseDeadline ascending, NULLs last (soonest-closing first; undated last).
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

  // =========================================================================
  // Positions / deltas
  // =========================================================================

  /**
   * Every (positionCycle, assertedFy, valueKind) value a budget book asserts for
   * this PE, optionally filtered to one assertedFy, each carrying its page-level
   * citation. Empty array (never an error) when this PE has no loaded positions.
   *
   * MONEY EXACTNESS: `amount`/`quantity` are returned as their exact decimal
   * STRINGS, not JS numbers. Prisma hands back Decimal instances whose `toJSON`
   * already produced this string over the wire; stringifying explicitly keeps that
   * true for any non-HTTP consumer and keeps a float coercion out of the path.
   */
  async getBudgetPositions(peCodeRaw: string, fy?: number) {
    const peCode = requirePeCode(peCodeRaw);
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    const rows = await this.prisma.programElementBudgetPosition.findMany({
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
    return rows.map((row) => ({
      positionCycle: row.positionCycle,
      assertedFy: row.assertedFy,
      amount: row.amount == null ? null : row.amount.toString(),
      quantity: row.quantity == null ? null : row.quantity.toString(),
      valueKind: row.valueKind,
      sourceUrl: row.sourceUrl,
      pageNumber: row.pageNumber,
    }));
  }

  async getPbComparison(peCodeRaw: string) {
    const peCode = requirePeCode(peCodeRaw);
    const exists = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!exists) throw new NotFoundException(`Program element ${peCode} not found`);

    const positions = await this.prisma.programElementBudgetPosition.findMany({
      where: { peCode, valueKind: 'total' },
      select: { positionCycle: true, assertedFy: true, amount: true, valueKind: true },
    });
    return {
      peCode,
      comparison: computePbComparison(
        positions.map((p) => ({
          positionCycle: p.positionCycle,
          assertedFy: p.assertedFy,
          amount: p.amount == null ? null : p.amount.toString(),
          valueKind: p.valueKind,
        })),
      ),
    };
  }

  /**
   * Typed, materiality-scored budget deltas for a PE (LIVE rows only - superseded
   * history excluded), most material first. Paginated; optional deltaType /
   * assertedFy filter.
   */
  async getDeltas(
    peCodeRaw: string,
    opts: { deltaType?: string; fy?: number; page?: number; limit?: number } = {},
  ) {
    const peCode = requirePeCode(peCodeRaw);
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
   * Cross-PE "needs attention" feed: live deltas at/above minScore, sorted by
   * materiality. clientRelevance is applied PER-TENANT at READ time (a delta on a
   * PE the tenant watches or has a client capability for is flagged + floated up)
   * and is NEVER stored globally.
   */
  async getNeedsAttention(
    ctx: DefenseTenantContext,
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

    const relevant = await this.tenantRelevantPeCodes(ctx, [
      ...new Set(rows.map((r) => r.peCode)),
    ]);
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
   * PEs (from the candidate set) the tenant is connected to. Tenant-scoped. A PE
   * counts as relevant if EITHER:
   *   (1) the tenant watches it, OR
   *   (2) a client is RELEVANT to it on any evidence path at/above 0.5, per the
   *       client-relevance port.
   * (2) is ADDITIVE - it never removes a (1) hit, and a port failure leaves the
   * watch set intact.
   *
   * DEVIATION FROM apps/api (deliberate, required by the Workstream E gate):
   * apps/api answers (2) with up to MAX_RELEVANCE_PROBES SEQUENTIAL per-PE probes,
   * each its own transaction. That is exactly the unbounded-N+1 fanout the master
   * plan forbids across the service boundary, so the port takes the whole candidate
   * set in ONE batched call. The ANSWER is the same set; the call pattern is not.
   *
   * apps/api's (1) also counts a legacy `client_capability.pe_number` naming the
   * PE. `client_capability` is CRM-owned, not defense-owned: reading it directly
   * from here would reintroduce precisely the cross-domain coupling this workstream
   * removes. It is therefore answered by the same relevance port, whose owning
   * context can see both signals.
   */
  private async tenantRelevantPeCodes(
    ctx: DefenseTenantContext,
    peCodes: string[],
  ): Promise<Set<string>> {
    if (peCodes.length === 0) return new Set<string>();

    const set = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const watches = await tx.programElementWatch.findMany({
        where: { tenantId: ctx.tenantId, peCode: { in: peCodes } },
        select: { peCode: true },
      });
      const found = new Set<string>();
      for (const w of watches) found.add(w.peCode);
      return found;
    });

    if (this.clientRelevance) {
      const probeCodes = peCodes.filter((code) => !set.has(code)).slice(0, MAX_RELEVANCE_PROBES);
      if (probeCodes.length > 0) {
        try {
          const relevant = await this.clientRelevance.relevantPeCodes({
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            peCodes: probeCodes,
            minScore: 0.5,
          });
          for (const code of relevant) set.add(code);
        } catch (error) {
          // Non-fatal: a relevance failure simply omits the relevance signal.
          this.logger.warn(
            `client-relevance enrichment skipped: ${(error as Error).message}`,
          );
        }
      }
    }

    return set;
  }

  // =========================================================================
  // Watch / preferences
  // =========================================================================

  async setWatching(peCodeRaw: string, watching: boolean, ctx: DefenseTenantContext) {
    const peCode = requirePeCode(peCodeRaw);
    const programElement = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true },
    });
    if (!programElement) throw new NotFoundException(`Program element ${peCode} not found`);

    return this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      if (watching) {
        let inserted: Array<{ id: string }>;
        try {
          inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            INSERT INTO program_element_watch (id, tenant_id, user_id, pe_code, created_at)
            VALUES (gen_random_uuid(), ${ctx.tenantId}::uuid, ${ctx.userId}::uuid, ${peCode}, now())
            ON CONFLICT (tenant_id, user_id, pe_code)
            DO UPDATE SET pe_code = EXCLUDED.pe_code
            RETURNING id
          `);
        } catch (error) {
          // Only the NAMED legacy (user_id, pe_code) constraint is translated, and
          // it fails closed: never rewrite tenant_id, and never reveal which other
          // tenant owns the existing row. Any other error propagates unchanged -
          // swallowing every failure into one 409 (as the prior implementation did)
          // reports a real database fault as a benign rollout conflict and leaks the
          // raw driver message to the caller.
          if (isLegacyPeWatchConstraintConflict(error)) {
            throw new ConflictException({
              statusCode: 409,
              code: 'PE_WATCH_TENANT_KEY_ROLLOUT_PENDING',
              message:
                'This watch cannot be added while the tenant-isolation rollout is in progress. No existing watch was changed.',
            });
          }
          throw error;
        }

        const watchId = inserted[0]?.id ?? null;

        await tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            action: 'program_element.watch.set',
            entityType: 'program_element_watch',
            entityId: watchId,
            after: { tenantId: ctx.tenantId, peCode, watching: true },
          },
        });

        return { peCode, watching: true };
      }

      const removed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        DELETE FROM program_element_watch
        WHERE tenant_id = ${ctx.tenantId}::uuid
          AND user_id = ${ctx.userId}::uuid
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
          after: { tenantId: ctx.tenantId, peCode, watching: false },
        },
      });

      return { peCode, watching: false };
    });
  }

  /**
   * PE Watch email-alert preference. Absence of a row means 'daily' - the opt-out
   * default for users who watch PEs.
   */
  async getPeAlertEmailPref(ctx: DefenseTenantContext) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.peAlertEmailPref.findFirst({
        where: { userId: ctx.userId, tenantId: ctx.tenantId },
        select: { mode: true },
      });
      return { mode: row?.mode ?? 'daily' };
    });
  }

  async setPeAlertEmailPref(mode: string, ctx: DefenseTenantContext) {
    return this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      await tx.peAlertEmailPref.upsert({
        where: { userId_tenantId: { userId: ctx.userId, tenantId: ctx.tenantId } },
        create: {
          userId: ctx.userId,
          tenantId: ctx.tenantId,
          mode,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        update: { mode, updatedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.alert_email_pref.set',
          entityType: 'pe_alert_email_pref',
          after: { mode },
        },
      });
      return { mode };
    });
  }

  // =======================================================================
  // Reconciliation review queue + governed manual overrides
  //
  // Unchanged from the reviewed Session 3 implementation: the exact-money
  // canonicalization, the fundingField-scoped open-proposal lookup and the
  // author != approver rule all carry DB-backed regression tests, and the money
  // path here never touches a JS float.
  // =======================================================================

  async listReconciliationQueue(status = 'open', page = 1, limit = 50) {
    const take = normalizeLimit(limit, 200);
    const skip = (normalizePage(page) - 1) * take;
    const where: Prisma.ReconciliationReviewQueueWhereInput = status === 'all' ? {} : { status };
    const [rows, total] = await Promise.all([
      this.prisma.reconciliationReviewQueue.findMany({ where, orderBy: { queuedAt: 'desc' }, skip, take }),
      this.prisma.reconciliationReviewQueue.count({ where }),
    ]);
    return { data: rows, total, page: normalizePage(page), limit: take };
  }

  async resolveReconciliation(id: string, input: ResolveReconciliationInput, ctx: DefenseTenantContext) {
    const entry = await this.prisma.reconciliationReviewQueue.findUnique({ where: { id } });
    assertFound(entry, `Reconciliation entry ${id} not found`);
    if (entry!.status !== 'open') {
      throw new BadRequestException(`Reconciliation entry ${id} is already ${entry!.status}`);
    }

    let proposedValue: string | null = null;
    let proposedOverrideId: string | null = null;
    if (input.decision === 'accept_conflicting' || input.decision === 'manual_value') {
      const rawSource = input.decision === 'accept_conflicting' ? entry!.conflictingValue : input.manualValue;
      if (rawSource === null || rawSource === undefined || String(rawSource).trim() === '') {
        throw new BadRequestException(
          input.decision === 'manual_value'
            ? 'manualValue (exact decimal string, in $ millions) is required for decision=manual_value'
            : `Conflicting value for entry ${id} is absent and cannot be accepted`,
        );
      }
      proposedValue = String(rawSource).trim();

      try {
        const record = await proposeManualOverrideV1(
          {
            overrideId: randomUUID(),
            target: canonicalTargetForLegacyPeYearV1({ peCode: entry!.peCode, fy: entry!.fy, fieldName: entry!.fieldName }),
            value: { originalValue: proposedValue, originalUnit: 'millions', valueMillions: proposedValue },
            authorActorId: ctx.userId,
            reason: input.notes?.trim() || 'reconciliation queue resolution',
            evidenceIds: [`reconciliation_review_queue:${id}`],
            effectiveFrom: new Date().toISOString(),
            proposedAt: new Date().toISOString(),
          },
          this.overrides,
        );
        proposedOverrideId = record.overrideId;
      } catch (error) {
        if (error instanceof ManualOverrideRefusalError) {
          throw new BadRequestException(`${error.reason}: ${error.message}`);
        }
        throw error;
      }
    }

    const nextStatus = proposedOverrideId == null ? 'resolved' : 'pending_approval';
    await this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      await tx.reconciliationReviewQueue.update({
        where: { id },
        data: {
          status: nextStatus,
          resolvedByUserId: nextStatus === 'resolved' ? ctx.userId : null,
          resolvedAt: nextStatus === 'resolved' ? new Date() : null,
          resolutionNotes: input.notes?.trim() || null,
          proposedOverrideId,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: nextStatus === 'resolved' ? 'program_element.reconciliation.resolve' : 'program_element.reconciliation.propose_override',
          entityType: 'reconciliation_review_queue',
          entityId: id,
          before: { status: entry!.status, conflictingValue: entry!.conflictingValue },
          after: { decision: input.decision, proposedValue, proposedOverrideId, status: nextStatus },
        },
      });
    });

    return {
      resolved: nextStatus === 'resolved',
      pendingApproval: nextStatus === 'pending_approval',
      id,
      decision: input.decision,
      peCode: entry!.peCode,
      fy: entry!.fy,
      fieldName: entry!.fieldName,
      proposedValue,
      proposedOverrideId,
    };
  }

  async approveReconciliation(id: string, ctx: DefenseTenantContext) {
    const entry = await this.prisma.reconciliationReviewQueue.findUnique({ where: { id } });
    assertFound(entry, `Reconciliation entry ${id} not found`);
    if (entry!.status !== 'pending_approval' || entry!.proposedOverrideId == null) {
      throw new BadRequestException(`Reconciliation entry ${id} is ${entry!.status} and has no correction awaiting approval`);
    }

    try {
      await approveManualOverrideV1(
        { overrideId: entry!.proposedOverrideId, approverActorId: ctx.userId, approverRole: ctx.role, approvedAt: new Date().toISOString() },
        this.overrides,
      );
    } catch (error) {
      if (error instanceof ManualOverrideRefusalError) {
        throw new BadRequestException(`${error.reason}: ${error.message}`);
      }
      throw error;
    }

    await this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      await tx.reconciliationReviewQueue.update({
        where: { id },
        data: { status: 'resolved', resolvedByUserId: ctx.userId, resolvedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'program_element.reconciliation.approve_override',
          entityType: 'reconciliation_review_queue',
          entityId: id,
          before: { status: entry!.status, proposedOverrideId: entry!.proposedOverrideId },
          after: { status: 'resolved', approvedOverrideId: entry!.proposedOverrideId },
        },
      });
    });

    return { approved: true as const, id, overrideId: entry!.proposedOverrideId, peCode: entry!.peCode, fy: entry!.fy, fieldName: entry!.fieldName };
  }
  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * The embedding model whose vectors are stored in `context_embeddings.model`.
   * Sourced from the embedding port when one is wired (so a provider swap moves
   * both sides together) and otherwise resolved exactly the way apps/api resolves
   * `EMBEDDING_MODEL`. Related-PE suggestions need only the STORED vector, so this
   * route is fully functional with no embedder configured.
   */
  private embeddingModel(): string {
    return this.embedding?.model ?? process.env.EMBEDDINGS_MODEL ?? 'amazon.titan-embed-text-v2:0';
  }

  /** Display-only serialization of one FY row (Decimal -> number). */
  private serializeYearRow(y: {
    id?: string;
    peCode?: string;
    fy: number;
    request: Prisma.Decimal | null;
    hascMark: Prisma.Decimal | null;
    sascMark: Prisma.Decimal | null;
    hacDMark: Prisma.Decimal | null;
    sacDMark: Prisma.Decimal | null;
    ndaaConference: Prisma.Decimal | null;
    conference: Prisma.Decimal | null;
    enacted: Prisma.Decimal | null;
  }) {
    return {
      ...(y.id !== undefined ? { id: y.id } : {}),
      ...(y.peCode !== undefined ? { peCode: y.peCode } : {}),
      fy: y.fy,
      request: num(y.request),
      hascMark: num(y.hascMark),
      sascMark: num(y.sascMark),
      hacDMark: num(y.hacDMark),
      sacDMark: num(y.sacDMark),
      ndaaConference: num(y.ndaaConference),
      conference: num(y.conference),
      enacted: num(y.enacted),
    };
  }
}
