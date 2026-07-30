/**
 * Budget Lines / money-graph read service (BL-1). Serves the five mockup
 * modules over the BL-0 derived tables: budget_action, budget_line_relationship,
 * capability(+matches), program_element_intelligence_cache — plus honest merges
 * of award/performer evidence for the incumbent map (F20).
 *
 * HONESTY RULES carried through every read:
 *  - "Incumbent" label ONLY with matched award evidence; R-3 rows are
 *    "budget-justification performers"; low-confidence award links are
 *    candidates. The tier is computed here, server-side, so no client can
 *    mislabel.
 *  - Candidate relationship edges are returned with status so the UI renders
 *    them dashed + labeled; they are never merged into accepted.
 *  - Aggregates never mix FYs: heatmap/conference read the open cycle only.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { fundingCurrentCoalesceSql, fundingCurrentStageSql } from '@capiro/shared';
import {
  buildCapabilityTotal,
  buildFundingClaim,
  claimFromLadderPick,
} from '@capiro/shared/funding-claim';
import { PrismaService } from '../prisma/prisma.service.js';
import { EMBEDDING_MODEL, embedText, vectorLiteral } from '../embeddings/embedder.js';

const num = (v: Prisma.Decimal | null): number | null => (v === null ? null : Number(v));

const LINE_TYPE_FOR = (appropriationType: string | null): string | null => {
  const t = (appropriationType ?? '').toUpperCase();
  if (t.startsWith('RDT')) return 'RDTE_PE';
  if (t === 'PROC') return 'PROCUREMENT_BLIN';
  if (t === 'OM') return 'OM_BLI';
  return null;
};

/** Entry wedge (F25) implied by a line's type — how a seller gets in. */
const WEDGE_FOR: Record<string, string> = {
  PROCUREMENT_BLIN: 'procurement-transition',
  RDTE_PE: 'rdte-eval',
  OM_BLI: 'om-services',
  MILCON_PROJECT: 'report-language',
  TRANSFER: 'ota-sbir-diu',
  CLASSIFIED: 'urgent-need',
};

@Injectable()
export class BudgetLinesReadService {
  private readonly logger = new Logger(BudgetLinesReadService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Per-line: normalized budget actions (§1.2) ──────────────────────────
  async getActions(peCode: string) {
    const rows = await this.prisma.budgetAction.findMany({
      where: { peCode: peCode.toUpperCase() },
      orderBy: [{ fy: 'desc' }, { updatedAt: 'desc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      fy: r.fy,
      stage: r.stage,
      action: r.action,
      amount: num(r.amount),
      baseline: r.baseline,
      note: r.note,
      evidence: r.evidenceJson,
    }));
  }

  // ── Per-line: typed graph edges (§1.3), both directions ─────────────────
  async getRelationships(peCode: string) {
    const code = peCode.toUpperCase();
    const edges = await this.prisma.budgetLineRelationship.findMany({
      where: { OR: [{ fromPeCode: code }, { toPeCode: code }] },
      orderBy: [{ status: 'asc' }, { confidence: 'asc' }],
    });
    const otherCodes = [
      ...new Set(edges.map((e) => (e.fromPeCode === code ? e.toPeCode : e.fromPeCode))),
    ];
    const [others, caches] = await Promise.all([
      this.prisma.programElement.findMany({
        where: { peCode: { in: otherCodes } },
        select: { peCode: true, title: true, service: true, appropriationType: true },
      }),
      this.prisma.programElementIntelligenceCache.findMany({
        where: { peCode: { in: otherCodes } },
        select: {
          peCode: true,
          lineType: true,
          maturity: true,
          appropTier: true,
          appropScore: true,
        },
      }),
    ]);
    const lineByCode = new Map(others.map((o) => [o.peCode, o]));
    const cacheByCode = new Map(caches.map((c) => [c.peCode, c]));
    return edges
      .map((e) => {
        const dir = e.fromPeCode === code ? 'out' : 'in';
        const otherCode = dir === 'out' ? e.toPeCode : e.fromPeCode;
        const other = lineByCode.get(otherCode);
        if (!other) return null; // edge to a line we no longer carry
        const cache = cacheByCode.get(otherCode);
        return {
          id: e.id,
          direction: dir,
          relType: e.relType,
          confidence: e.confidence,
          status: e.status,
          evidence: e.evidence,
          line: {
            peCode: other.peCode,
            title: other.title,
            service: other.service,
            lineType: cache?.lineType ?? LINE_TYPE_FOR(other.appropriationType),
            maturity: cache?.maturity ?? null,
            appropTier: cache?.appropTier ?? null,
            appropScore: cache?.appropScore ?? null,
          },
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);
  }

  // ── Per-line: incumbent map (F20) — tiered, honest labels ───────────────
  async getIncumbents(peCode: string) {
    const code = peCode.toUpperCase();
    const [awards, performers] = await Promise.all([
      this.prisma.federalAward.findMany({
        where: { peCode: code },
        select: {
          contractorName: true,
          amount: true,
          peCodeSource: true,
          peCodeConfidence: true,
          peCodeCandidateCount: true,
          awardingSubTier: true,
          fundingFy: true,
        },
      }),
      this.prisma.programElementPerformer.findMany({
        where: { peCode: code, isNamedCompany: true },
        select: {
          performer: true,
          performerNormalized: true,
          location: true,
          costCategory: true,
          totalCostM: true,
          fy: true,
          tableType: true,
          sourceUrl: true,
          pageNumber: true,
        },
      }),
    ]);

    // Group awards by contractor. Award-evidenced = incumbent when the PE
    // attribution is strong (uei-confirmed or unambiguous); otherwise candidate.
    const byContractor = new Map<
      string,
      {
        name: string;
        total: number;
        count: number;
        strong: boolean;
        sources: Set<string>;
        office: string | null;
        fys: Set<number>;
      }
    >();
    for (const a of awards) {
      const name = (a.contractorName ?? '').trim();
      if (!name) continue;
      const key = name.toUpperCase();
      const strong =
        a.peCodeSource === 'uei_confirmed_r3_prime' ||
        a.peCodeSource === 'dod_acquisition_program' ||
        (a.peCodeConfidence ?? 0) >= 0.8 ||
        a.peCodeCandidateCount === 1;
      const g =
        byContractor.get(key) ??
        ({
          name,
          total: 0,
          count: 0,
          strong: false,
          sources: new Set(),
          office: null,
          fys: new Set(),
        } as NonNullable<ReturnType<typeof byContractor.get>>);
      g.total += Number(a.amount ?? 0);
      g.count += 1;
      g.strong = g.strong || strong;
      if (a.peCodeSource) g.sources.add(a.peCodeSource);
      if (!g.office && a.awardingSubTier) g.office = a.awardingSubTier;
      if (a.fundingFy) g.fys.add(a.fundingFy);
      byContractor.set(key, g);
    }

    const performerByName = new Map<
      string,
      { name: string; roles: Set<string>; fys: Set<number>; totalM: number; cite: string | null }
    >();
    for (const p of performers) {
      const key = p.performerNormalized;
      const g =
        performerByName.get(key) ??
        ({
          name: p.performer,
          roles: new Set(),
          fys: new Set(),
          totalM: 0,
          cite: null,
        } as NonNullable<ReturnType<typeof performerByName.get>>);
      if (p.costCategory) g.roles.add(p.costCategory);
      g.fys.add(p.fy);
      g.totalM += Number(p.totalCostM ?? 0);
      if (!g.cite && p.sourceUrl) g.cite = `${p.sourceUrl}#page=${p.pageNumber}`;
      performerByName.set(key, g);
    }

    const rows: Array<{
      company: string;
      tier: 'incumbent' | 'performer' | 'candidate';
      confidence: 'high' | 'med' | 'low';
      awardsTotal: number | null;
      awardCount: number;
      office: string | null;
      role: string | null;
      evidence: string;
      sourceUrl: string | null;
    }> = [];

    // One symmetric match key for the award↔performer merge: uppercase and
    // strip EVERYTHING but letters/digits (spaces included). Award names and
    // performerNormalized come from different normalizers (JS vs the exhibit
    // extractor), so comparing raw stored forms splits "Lockheed-Martin ..."
    // from "LOCKHEED MARTIN ..." into two rows. Prefix-12 on the shared key
    // survives suffix drift (CORP vs CORPORATION).
    const matchKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const performerKeys = [...performerByName.keys()].map(matchKey);
    for (const g of byContractor.values()) {
      const norm = matchKey(g.name);
      const alsoPerformer = performerKeys.some(
        (k) => k.startsWith(norm.slice(0, 12)) || norm.startsWith(k.slice(0, 12)),
      );
      rows.push({
        company: g.name,
        tier: g.strong ? 'incumbent' : 'candidate',
        confidence: g.strong ? (alsoPerformer ? 'high' : 'med') : 'low',
        awardsTotal: g.total || null,
        awardCount: g.count,
        office: g.office,
        role: null,
        evidence: g.strong
          ? `${g.count} award${g.count === 1 ? '' : 's'} resolved to this line (${[...g.sources].join(', ') || 'attribution stored'})${alsoPerformer ? '; also an R-3 named performer' : ''}.`
          : `Award link is low-confidence (${[...g.sources].join(', ') || 'ambiguous account/PA attribution'}) — needs review before treating as an incumbent.`,
        sourceUrl: null,
      });
    }
    const contractorKeys = [...byContractor.values()].map((g) => matchKey(g.name));
    for (const [key, g] of performerByName) {
      const norm = matchKey(key);
      const hasAwardRow = contractorKeys.some(
        (k) => k.startsWith(norm.slice(0, 12)) || norm.startsWith(k.slice(0, 12)),
      );
      if (hasAwardRow) continue; // already represented by the award row
      rows.push({
        company: g.name,
        tier: 'performer',
        confidence: 'med',
        awardsTotal: null,
        awardCount: 0,
        office: null,
        role: [...g.roles].slice(0, 2).join('; ') || null,
        evidence: `Named in the R-3 exhibit (${[...g.fys]
          .sort()
          .map((f) => `FY${f}`)
          .join(', ')}) — budget-justification performer; no matched award yet.`,
        sourceUrl: g.cite,
      });
    }

    rows.sort((a, b) => {
      const tierRank = { incumbent: 0, performer: 1, candidate: 2 } as const;
      if (tierRank[a.tier] !== tierRank[b.tier]) return tierRank[a.tier] - tierRank[b.tier];
      return (b.awardsTotal ?? 0) - (a.awardsTotal ?? 0);
    });
    return { data: rows };
  }

  // ── Movement (F2/F7/F9/F3+F13) — one aggregate payload ──────────────────
  async getMovement() {
    const actions = await this.prisma.budgetAction.findMany({
      orderBy: [{ fy: 'desc' }, { amount: { sort: 'desc', nulls: 'last' } }],
      take: 400,
    });
    const codes = [...new Set(actions.map((a) => a.peCode))];
    const [lines, caches] = await Promise.all([
      this.prisma.programElement.findMany({
        where: { peCode: { in: codes } },
        select: { peCode: true, title: true, service: true, appropriationType: true },
      }),
      this.prisma.programElementIntelligenceCache.findMany({
        where: { anomaliesJson: { not: Prisma.DbNull } },
        select: { peCode: true, anomaliesJson: true },
        take: 4000,
      }),
    ]);
    const lineByCode = new Map(lines.map((l) => [l.peCode, l]));

    // Open cycle = the max FY present among actions.
    const openFy = actions.reduce<number>((m, a) => Math.max(m, a.fy), 0);

    const feed = actions
      .filter((a) => lineByCode.has(a.peCode))
      .slice(0, 120)
      .map((a) => {
        const l = lineByCode.get(a.peCode)!;
        return {
          id: a.id,
          peCode: a.peCode,
          title: l.title,
          service: l.service,
          lineType: LINE_TYPE_FOR(l.appropriationType),
          fy: a.fy,
          stage: a.stage,
          action: a.action,
          amount: num(a.amount),
          note: a.note,
        };
      });

    // Heatmap (F7): $M moved by color-of-money × stage, open cycle only.
    const stages = ['HASC', 'SASC', 'HAC_D', 'SAC_D', 'CONF', 'ENACTED'];
    const comRows = ['RDTE_PE', 'PROCUREMENT_BLIN', 'OM_BLI'];
    const heat = new Map<string, number>();
    for (const a of actions) {
      if (a.fy !== openFy || a.amount === null) continue;
      const l = lineByCode.get(a.peCode);
      const com = l ? LINE_TYPE_FOR(l.appropriationType) : null;
      if (!com || !stages.includes(a.stage)) continue;
      const key = `${com}|${a.stage}`;
      heat.set(key, (heat.get(key) ?? 0) + Number(a.amount));
    }
    const heatmap = {
      fy: openFy,
      cols: stages,
      rows: comRows.map((com) => ({
        lineType: com,
        vals: stages.map((s) => Math.round((heat.get(`${com}|${s}`) ?? 0) * 10) / 10),
      })),
    };

    // Conference divergence (F3/F13): open-cycle lines where House and Senate
    // positions differ. Appropriations pair preferred; authorizers as fallback.
    type ConfRow = {
      peCode: string;
      fy: number;
      request: number | null;
      house: number | null;
      senate: number | null;
      basis: string;
    };
    const confRows = await this.prisma.$queryRaw<ConfRow[]>(Prisma.sql`
      SELECT y.pe_code AS "peCode", y.fy,
        y.request::double precision AS request,
        COALESCE(y.hac_d_mark, y.hasc_mark)::double precision AS house,
        COALESCE(y.sac_d_mark, y.sasc_mark)::double precision AS senate,
        CASE WHEN y.hac_d_mark IS NOT NULL AND y.sac_d_mark IS NOT NULL THEN 'appropriations'
             ELSE 'authorization' END AS basis
      FROM program_element_year y
      WHERE y.fy = ${openFy}
        AND y.ndaa_conference IS NULL AND y.enacted IS NULL
        AND COALESCE(y.hac_d_mark, y.hasc_mark) IS NOT NULL
        AND COALESCE(y.sac_d_mark, y.sasc_mark) IS NOT NULL
        AND COALESCE(y.hac_d_mark, y.hasc_mark) <> COALESCE(y.sac_d_mark, y.sasc_mark)
      ORDER BY ABS(COALESCE(y.hac_d_mark, y.hasc_mark) - COALESCE(y.sac_d_mark, y.sasc_mark)) DESC
      LIMIT 40
    `);
    const confCodes = confRows.map((r) => r.peCode);
    const confLines = await this.prisma.programElement.findMany({
      where: { peCode: { in: confCodes } },
      select: { peCode: true, title: true, service: true },
    });
    const confLineByCode = new Map(confLines.map((l) => [l.peCode, l]));
    const conference = confRows
      .filter((r) => confLineByCode.has(r.peCode))
      .map((r) => ({
        peCode: r.peCode,
        title: confLineByCode.get(r.peCode)!.title,
        service: confLineByCode.get(r.peCode)!.service,
        fy: r.fy,
        request: r.request,
        house: r.house,
        senate: r.senate,
        basis: r.basis,
        gap: r.house !== null && r.senate !== null ? Math.abs(r.house - r.senate) : null,
        lean:
          r.house !== null && r.senate !== null ? (r.house > r.senate ? 'house' : 'senate') : null,
      }));

    // Anomalies (F9) from the cache — already engine-verdicts, top by count.
    const anomalies: Array<{
      peCode: string;
      title: string;
      kind: string;
      tone: string;
      note: string;
    }> = [];
    for (const c of caches) {
      const list = Array.isArray(c.anomaliesJson)
        ? (c.anomaliesJson as Array<Record<string, unknown>>)
        : [];
      for (const a of list) {
        if (anomalies.length >= 30) break;
        const l = lineByCode.get(c.peCode);
        anomalies.push({
          peCode: c.peCode,
          title: l?.title ?? c.peCode,
          kind: String(a.type ?? 'anomaly'),
          tone: String(a.severity ?? 'notable'),
          note: String(a.rationale ?? ''),
        });
      }
    }

    const adds = actions.filter(
      (a) => a.fy === openFy && Number(a.amount ?? 0) > 0 && a.action === 'add',
    );
    const cuts = actions.filter(
      (a) => a.fy === openFy && Number(a.amount ?? 0) < 0 && a.action === 'cut',
    );
    return {
      openFy,
      kpis: {
        actions: actions.filter((a) => a.fy === openFy).length,
        addsTotal: adds.reduce((s, a) => s + Number(a.amount ?? 0), 0),
        cutsTotal: cuts.reduce((s, a) => s + Number(a.amount ?? 0), 0),
        openInConference: conference.length,
      },
      feed,
      heatmap,
      conference,
      anomalies,
    };
  }

  // ── Money graph (F12): the whole accepted graph + candidates ────────────
  async getGraph() {
    const edges = await this.prisma.budgetLineRelationship.findMany({
      orderBy: { relType: 'asc' },
      take: 2000,
    });
    const codes = [...new Set(edges.flatMap((e) => [e.fromPeCode, e.toPeCode]))];
    const [lines, caches] = await Promise.all([
      this.prisma.programElement.findMany({
        where: { peCode: { in: codes }, retiredAt: null },
        select: { peCode: true, title: true, service: true, appropriationType: true },
      }),
      this.prisma.programElementIntelligenceCache.findMany({
        where: { peCode: { in: codes } },
        select: { peCode: true, lineType: true, valleyOfDeath: true },
      }),
    ]);
    const cacheByCode = new Map(caches.map((c) => [c.peCode, c]));
    const nodes = lines.map((l) => ({
      peCode: l.peCode,
      title: l.title,
      service: l.service,
      lineType: cacheByCode.get(l.peCode)?.lineType ?? LINE_TYPE_FOR(l.appropriationType),
      valleyOfDeath: cacheByCode.get(l.peCode)?.valleyOfDeath ?? false,
    }));
    const nodeCodes = new Set(nodes.map((n) => n.peCode));
    return {
      nodes,
      edges: edges
        .filter((e) => nodeCodes.has(e.fromPeCode) && nodeCodes.has(e.toPeCode))
        .map((e) => ({
          from: e.fromPeCode,
          to: e.toPeCode,
          relType: e.relType,
          confidence: e.confidence,
          status: e.status,
          evidence: e.evidence,
        })),
    };
  }

  // ── Watchlist signal feed (F17): actions on the user's watched lines ────
  async getWatchSignals(ctx: TenantContext) {
    if (!ctx.tenantId || !ctx.userId) return { data: [] };
    const watches = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.programElementWatch.findMany({
        where: { userId: ctx.userId ?? undefined },
        select: { peCode: true },
      }),
    );
    const codes = watches.map((w) => w.peCode);
    if (codes.length === 0) return { data: [] };
    const [actions, lines] = await Promise.all([
      this.prisma.budgetAction.findMany({
        where: { peCode: { in: codes } },
        orderBy: [{ fy: 'desc' }, { updatedAt: 'desc' }],
        take: 60,
      }),
      this.prisma.programElement.findMany({
        where: { peCode: { in: codes } },
        select: { peCode: true, title: true },
      }),
    ]);
    const titleByCode = new Map(lines.map((l) => [l.peCode, l.title]));
    return {
      data: actions.map((a) => ({
        id: a.id,
        peCode: a.peCode,
        title: titleByCode.get(a.peCode) ?? a.peCode,
        fy: a.fy,
        stage: a.stage,
        action: a.action,
        amount: num(a.amount),
        note: a.note,
      })),
    };
  }

  // ── Capabilities (F4): list + per-capability recommendations (F25) ──────
  async listCapabilities() {
    const caps = await this.prisma.capability.findMany({ orderBy: { name: 'asc' } });
    // Phase G: capability totals pin ONE shared fiscal year (catalog current-cycle
    // mode of request-bearing rows, zeros included) and disclose coverage. Never
    // sum each PE's private latest-nonzero request (that mixes FYs and drops $0).
    type CycleRow = { fy: number | null };
    const cycleRows = await this.prisma.$queryRaw<CycleRow[]>(Prisma.sql`
      SELECT fy
      FROM program_element_year
      WHERE request IS NOT NULL
      GROUP BY fy
      ORDER BY COUNT(*) DESC, fy DESC
      LIMIT 1
    `);
    const sharedFy = cycleRows[0]?.fy ?? null;

    type AggRow = {
      slug: string;
      lineType: string | null;
      lines: number;
      linesWithRequest: number;
      requestTotal: number | null;
    };
    const aggs =
      sharedFy == null
        ? ([] as AggRow[])
        : await this.prisma.$queryRaw<AggRow[]>(Prisma.sql`
      SELECT c.slug, ic.line_type AS "lineType",
        COUNT(DISTINCT m.pe_code)::int AS lines,
        COUNT(DISTINCT m.pe_code) FILTER (WHERE y.request IS NOT NULL)::int AS "linesWithRequest",
        COALESCE(SUM(y.request), 0)::double precision AS "requestTotal"
      FROM capability c
      JOIN capability_budget_line_match m ON m.capability_id = c.id AND m.status = 'accepted'
      LEFT JOIN program_element_intelligence_cache ic ON ic.pe_code = m.pe_code
      LEFT JOIN program_element_year y ON y.pe_code = m.pe_code AND y.fy = ${sharedFy}
      GROUP BY c.slug, ic.line_type
    `);
    const bySlug = new Map<
      string,
      { lines: number; linesWithRequest: number; total: number; byType: Record<string, number> }
    >();
    for (const a of aggs) {
      const g = bySlug.get(a.slug) ?? { lines: 0, linesWithRequest: 0, total: 0, byType: {} };
      g.lines += a.lines;
      g.linesWithRequest += a.linesWithRequest;
      g.total += a.requestTotal ?? 0;
      if (a.lineType) g.byType[a.lineType] = (g.byType[a.lineType] ?? 0) + (a.requestTotal ?? 0);
      bySlug.set(a.slug, g);
    }
    return {
      fiscalYear: sharedFy,
      unit: 'USD millions' as const,
      data: caps.map((c) => {
        const g = bySlug.get(c.slug);
        const lines = g?.lines ?? 0;
        const withReq = g?.linesWithRequest ?? 0;
        // Coverage via real counts (no fake zero rows for disclosure).
        const coverageClaim = buildCapabilityTotal({
          fiscalYear: sharedFy,
          lineRequestsAtFy: [
            // one present slot per line with a value (including genuine $0 via SQL COUNT FILTER)
            ...Array.from({ length: withReq }, () => 1),
            ...Array.from({ length: Math.max(0, lines - withReq) }, () => null),
          ],
        });
        return {
          slug: c.slug,
          name: c.name,
          aliases: c.aliases,
          taxonomyPath: c.taxonomyPath,
          lineCount: lines,
          requestTotal: g?.total ?? 0,
          requestByLineType: g?.byType ?? {},
          // Phase G fields (additive; legacy requestTotal retained).
          requestFiscalYear: sharedFy,
          requestCoverage: {
            ...coverageClaim.coverage,
            // Correct the money total independently of placeholder values above.
          },
          requestClaim: buildFundingClaim({
            value: g?.total ?? 0,
            fiscalYear: sharedFy,
            stage: 'request',
            currentCycleFy: sharedFy,
          }),
        };
      }),
    };
  }

  /**
   * Canonical "current" funding per PE (value + fy + stage) at each PE's latest
   * FY carrying ANY stage, using the SHARED funding precedence — so capability
   * rows show the same authoritative number as the PE detail page instead of a
   * request-only figure. Empty map for an empty code list.
   */
  private async latestCurrentByCode(
    codes: string[],
  ): Promise<
    Map<string, { current: number | null; currentFy: number | null; currentStage: string | null }>
  > {
    if (codes.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<
      Array<{
        peCode: string;
        current: number | null;
        currentFy: number | null;
        currentStage: string | null;
      }>
    >(Prisma.sql`
      SELECT y.pe_code AS "peCode",
             ${Prisma.raw(fundingCurrentCoalesceSql('y.'))}::double precision AS current,
             y.fy AS "currentFy",
             ${Prisma.raw(fundingCurrentStageSql('y.'))} AS "currentStage"
      FROM program_element_year y
      JOIN (
        SELECT pe_code, MAX(fy) AS fy
        FROM program_element_year
        WHERE ${Prisma.raw(fundingCurrentCoalesceSql(''))} IS NOT NULL
          AND pe_code IN (${Prisma.join(codes)})
        GROUP BY pe_code
      ) latest ON latest.pe_code = y.pe_code AND latest.fy = y.fy
    `);
    return new Map(
      rows.map((r) => [
        r.peCode,
        { current: r.current, currentFy: r.currentFy, currentStage: r.currentStage },
      ]),
    );
  }

  async getCapabilityRecommendations(slug: string) {
    const cap = await this.prisma.capability.findUnique({ where: { slug } });
    if (!cap) return { capability: null, data: [] };
    const matches = await this.prisma.capabilityBudgetLineMatch.findMany({
      where: { capabilityId: cap.id, status: 'accepted' },
      select: { peCode: true, confidence: true, matchedOn: true },
    });
    const codes = matches.map((m) => m.peCode);
    const [lines, caches, latestRequests] = await Promise.all([
      this.prisma.programElement.findMany({
        where: { peCode: { in: codes }, retiredAt: null },
        select: { peCode: true, title: true, service: true, appropriationType: true },
      }),
      this.prisma.programElementIntelligenceCache.findMany({
        where: { peCode: { in: codes } },
      }),
      this.prisma.$queryRaw<
        Array<{ peCode: string; request: number | null; fy: number | null }>
      >(Prisma.sql`
        SELECT y.pe_code AS "peCode", y.request::double precision AS request, y.fy
        FROM program_element_year y
        JOIN (
          SELECT pe_code, MAX(fy) AS fy FROM program_element_year
          WHERE request IS NOT NULL AND pe_code IN (${Prisma.join(codes.length ? codes : ['__none__'])})
          GROUP BY pe_code
        ) latest ON latest.pe_code = y.pe_code AND latest.fy = y.fy
      `),
    ]);
    const matchByCode = new Map(matches.map((m) => [m.peCode, m]));
    const cacheByCode = new Map(caches.map((c) => [c.peCode, c]));
    const reqByCode = new Map(latestRequests.map((r) => [r.peCode, r]));
    const curByCode = await this.latestCurrentByCode(codes);
    const data = lines
      .map((l) => {
        const cache = cacheByCode.get(l.peCode);
        const match = matchByCode.get(l.peCode)!;
        const lineType = cache?.lineType ?? LINE_TYPE_FOR(l.appropriationType);
        return {
          peCode: l.peCode,
          title: l.title,
          service: l.service,
          lineType,
          wedge: lineType ? (WEDGE_FOR[lineType] ?? 'rdte-eval') : 'rdte-eval',
          maturity: cache?.maturity ?? null,
          appropTier: cache?.appropTier ?? null,
          appropScore: cache?.appropScore ?? null,
          signalType: cache?.signalType ?? null,
          signalTone: cache?.signalTone ?? null,
          valleyOfDeath: cache?.valleyOfDeath ?? false,
          matchConfidence: match.confidence,
          matchedOn: match.matchedOn,
          latestRequest: reqByCode.get(l.peCode)?.request ?? null,
          latestRequestFy: reqByCode.get(l.peCode)?.fy ?? null,
          latestCurrent: curByCode.get(l.peCode)?.current ?? null,
          latestCurrentFy: curByCode.get(l.peCode)?.currentFy ?? null,
          latestCurrentStage: curByCode.get(l.peCode)?.currentStage ?? null,
          requestClaim: buildFundingClaim({
            value: reqByCode.get(l.peCode)?.request ?? null,
            fiscalYear: reqByCode.get(l.peCode)?.fy ?? null,
            stage: 'request',
            currentCycleFy: curByCode.get(l.peCode)?.currentFy ?? reqByCode.get(l.peCode)?.fy ?? null,
          }),
          currentClaim: claimFromLadderPick({
            value: curByCode.get(l.peCode)?.current ?? null,
            stage: curByCode.get(l.peCode)?.currentStage ?? 'none',
            fiscalYear: curByCode.get(l.peCode)?.currentFy ?? null,
            currentCycleFy: curByCode.get(l.peCode)?.currentFy ?? null,
          }),
        };
      })
      .sort((a, b) => (b.appropScore ?? -1) - (a.appropScore ?? -1));
    return {
      capability: {
        slug: cap.slug,
        name: cap.name,
        aliases: cap.aliases,
        taxonomyPath: cap.taxonomyPath,
      },
      data,
    };
  }

  /**
   * Free-text "capability → money" search (the hero box). Embeds the query
   * (Bedrock, same model as embed-program-elements) and ranks active budget
   * lines by cosine similarity of their MISSION embeddings (context_embeddings,
   * source_type='pe'), then enriches to the exact CapabilityRecommendation row
   * shape so the finder renders them unchanged.
   *
   * HONESTY: these are AI SUGGESTIONS ranked by semantic mission similarity —
   * NOT the curated, keyword-evidenced capability matches — and each row's
   * matchedOn says so with the similarity %. Degrades to an empty result (never
   * throws) when Bedrock/pgvector/embeddings are unavailable, so the hero shows
   * an honest empty state instead of a 500.
   */
  async searchCapabilityLines(qRaw: string) {
    const q = (qRaw ?? '').trim().slice(0, 300);
    if (!q) return { query: q, data: [] };

    // Query→document cosine floor. Doc↔doc similarity (related-PEs panel) uses
    // 0.7, but a short buyer phrase vs a long mission narrative scores lower for
    // the same relevance; 0.35 keeps recall without surfacing boilerplate noise.
    const SIMILARITY_FLOOR = 0.35;
    const LIMIT = 25;

    let hits: Array<{ peCode: string; score: number }> = [];
    try {
      const vec = vectorLiteral(await embedText(q));
      hits = await this.prisma.$queryRaw<Array<{ peCode: string; score: number }>>(Prisma.sql`
        SELECT ce.source_id AS "peCode",
               (1 - (ce.embedding <=> ${vec}::vector))::float8 AS "score"
        FROM context_embeddings ce
        JOIN program_element pe ON pe.pe_code = ce.source_id
        WHERE ce.source_type = 'pe'
          AND ce.model = ${EMBEDDING_MODEL}
          AND ce.embedding IS NOT NULL
          AND pe.retired_at IS NULL
          AND (1 - (ce.embedding <=> ${vec}::vector)) >= ${SIMILARITY_FLOOR}
        ORDER BY ce.embedding <=> ${vec}::vector
        LIMIT ${LIMIT}
      `);
    } catch (err) {
      this.logger.warn(`capability search degraded to empty: ${(err as Error).message}`);
      return { query: q, data: [] };
    }
    if (hits.length === 0) return { query: q, data: [] };

    const codes = hits.map((h) => h.peCode);
    const scoreByCode = new Map(hits.map((h) => [h.peCode, h.score]));
    const [lines, caches, latestRequests] = await Promise.all([
      this.prisma.programElement.findMany({
        where: { peCode: { in: codes }, retiredAt: null },
        select: { peCode: true, title: true, service: true, appropriationType: true },
      }),
      this.prisma.programElementIntelligenceCache.findMany({
        where: { peCode: { in: codes } },
      }),
      this.prisma.$queryRaw<
        Array<{ peCode: string; request: number | null; fy: number | null }>
      >(Prisma.sql`
        SELECT y.pe_code AS "peCode", y.request::double precision AS request, y.fy
        FROM program_element_year y
        JOIN (
          SELECT pe_code, MAX(fy) AS fy FROM program_element_year
          WHERE request IS NOT NULL AND pe_code IN (${Prisma.join(codes)})
          GROUP BY pe_code
        ) latest ON latest.pe_code = y.pe_code AND latest.fy = y.fy
      `),
    ]);
    const cacheByCode = new Map(caches.map((c) => [c.peCode, c]));
    const reqByCode = new Map(latestRequests.map((r) => [r.peCode, r]));
    const curByCode = await this.latestCurrentByCode(codes);
    const data = lines
      .map((l) => {
        const cache = cacheByCode.get(l.peCode);
        const score = scoreByCode.get(l.peCode) ?? 0;
        const lineType = cache?.lineType ?? LINE_TYPE_FOR(l.appropriationType);
        return {
          peCode: l.peCode,
          title: l.title,
          service: l.service,
          lineType,
          wedge: lineType ? (WEDGE_FOR[lineType] ?? 'rdte-eval') : 'rdte-eval',
          maturity: cache?.maturity ?? null,
          appropTier: cache?.appropTier ?? null,
          appropScore: cache?.appropScore ?? null,
          signalType: cache?.signalType ?? null,
          signalTone: cache?.signalTone ?? null,
          valleyOfDeath: cache?.valleyOfDeath ?? false,
          matchConfidence: score.toFixed(2),
          matchedOn: `semantic:${Math.round(score * 100)}% mission similarity`,
          latestRequest: reqByCode.get(l.peCode)?.request ?? null,
          latestRequestFy: reqByCode.get(l.peCode)?.fy ?? null,
          latestCurrent: curByCode.get(l.peCode)?.current ?? null,
          latestCurrentFy: curByCode.get(l.peCode)?.currentFy ?? null,
          latestCurrentStage: curByCode.get(l.peCode)?.currentStage ?? null,
          requestClaim: buildFundingClaim({
            value: reqByCode.get(l.peCode)?.request ?? null,
            fiscalYear: reqByCode.get(l.peCode)?.fy ?? null,
            stage: 'request',
            currentCycleFy: curByCode.get(l.peCode)?.currentFy ?? reqByCode.get(l.peCode)?.fy ?? null,
          }),
          currentClaim: claimFromLadderPick({
            value: curByCode.get(l.peCode)?.current ?? null,
            stage: curByCode.get(l.peCode)?.currentStage ?? 'none',
            fiscalYear: curByCode.get(l.peCode)?.currentFy ?? null,
            currentCycleFy: curByCode.get(l.peCode)?.currentFy ?? null,
          }),
        };
      })
      // Relevance order (semantic rank), NOT appropriability — this is a search.
      .sort((a, b) => (scoreByCode.get(b.peCode) ?? 0) - (scoreByCode.get(a.peCode) ?? 0));
    return { query: q, data };
  }
}
