import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClientPeRelevanceService } from '../../intelligence/client-pe-relevance.service.js';
import type { BudgetPositionLike } from '../budget-position.js';
import {
  deltasFromPositions,
  deltasFromProcurement,
  deltasFromYear,
  newStartFromYears,
  type DerivedDelta,
  type ProcurementLineLike,
  type YearLike,
} from './delta-compute.js';
import {
  DEFAULT_MATERIALITY_WEIGHTS,
  MATERIALITY_THRESHOLDS,
  scoreMateriality,
  type MaterialityWeights,
} from './materiality-scorer.js';

/**
 * Step 1.4 — Budget-delta engine.
 *
 * Recomputes the typed, materiality-scored deltas for one PE (or a whole FY across all
 * PEs) from existing data, and persists them idempotently (latest-wins via supersededAt).
 * Emits ONE IntelligenceChange per NEW material delta (score ≥0.4) to the affected tenants
 * (watches ∪ ClientCapability.peNumber) — without re-emitting on a recompute that finds no
 * change.
 *
 * DELTA TYPES & WHERE THEY COME FROM (authoritative definitions — the pure math lives in
 * delta-compute.ts):
 *   - mark_vs_request:     ProgramElementYear, a committee mark vs the request, same FY.  [REAL]
 *   - mark_vs_mark:        ProgramElementYear, two marks WITHIN a track (HASC/SASC|HAC-D/SAC-D). [REAL]
 *   - conference_vs_marks: ProgramElementYear, NDAA conference vs the authorization marks.  [REAL]
 *   - enacted_vs_request:  ProgramElementYear, enacted public law vs the request.          [REAL]
 *   - new_start:           ProgramElementBudgetPosition (newInPb) OR a single brand-new FY
 *                          year row with no prior PB.                                       [REAL/year path]
 *   - termination:         ProgramElementBudgetPosition (droppedFromPb).                    [dormant: needs 2 PB books]
 *   - zeroed:              ProgramElementYear, a positive value cut to exactly 0.           [REAL]
 *   - transfer_candidate:  cross-PE: a termination in one PE + a new_start in another in
 *                          the SAME component with title trigram ≥0.6 OR same project
 *                          title. Marked as CANDIDATE only, NEVER asserted.                [dormant: needs 2 PB books]
 *   - outyear_shift:       ProgramElementBudgetPosition, |ΔFYDP total| ≥ max($20M,15%)
 *                          on an outyear FY between two PB cycles.                          [dormant: needs 2 PB books]
 *   - quantity_change:     ProgramElementProcurementLine, quantity across FYs.             [dormant: needs P-1]
 *   - unit_cost_change:    ProgramElementProcurementLine, unit cost across FYs.            [dormant: needs P-1]
 *   - pb_vs_prior_pb:      ProgramElementBudgetPosition, current vs prior PB for an FY.     [dormant: needs 2 PB books]
 *   - project_level_change: project-level value change (Step 1.5).                          [dormant: not modeled yet]
 *
 * [REAL] = produces rows on today's data. [dormant] = computes gracefully empty until the
 * upstream data (a second PB book / P-1 procurement lines) lands — no errors, just [].
 *
 * Money convention: $ MILLIONS throughout (project-wide; see program-element-writer).
 */

const TRANSFER_TRIGRAM_THRESHOLD = 0.6;

export interface ComputeOptions {
  /** Persist the recompute (default false = dry run; the engine itself never half-writes). */
  commit?: boolean;
  /** Emit IntelligenceChange for new material deltas (default = same as commit). */
  emit?: boolean;
  /** Override the materiality weights (defaults documented in the scorer). */
  weights?: MaterialityWeights;
}

export interface PeDeltaResult {
  peCode: string;
  derived: number;
  inserted: number;
  superseded: number;
  unchanged: number;
  emitted: number;
}

@Injectable()
export class DeltaEngineService {
  private readonly logger = new Logger(DeltaEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Step 2.3 — explainable client⇄PE relevance, used by getAffectedTenants to additively
    // pull relevance-only clients into a delta's relatedClientIds. Optional only so the
    // hand-wired `deltas:compute` CLI (`new DeltaEngineService(prisma)`) keeps compiling;
    // Nest always injects it in the running app via ProgramElementModule → IntelligenceModule.
    private readonly relevanceService?: ClientPeRelevanceService,
  ) {}

  /** Derive (and optionally persist/emit) deltas for every PE that has data for `fy`, or all PEs. */
  async computeAll(fy?: number, opts: ComputeOptions = {}): Promise<PeDeltaResult[]> {
    // PEs with any signal we can derive from: a year row, a position, or a procurement line.
    const yearWhere = fy !== undefined ? { fy } : {};
    const [yearPes, posPes, procPes] = await Promise.all([
      this.prisma.programElementYear.findMany({
        where: yearWhere,
        select: { peCode: true },
        distinct: ['peCode'],
      }),
      this.prisma.programElementBudgetPosition.findMany({
        select: { peCode: true },
        distinct: ['peCode'],
      }),
      this.prisma.programElementProcurementLine.findMany({
        select: { peCode: true },
        distinct: ['peCode'],
      }),
    ]);
    const peCodes = [...new Set([...yearPes, ...posPes, ...procPes].map((r) => r.peCode))].sort();

    const results: PeDeltaResult[] = [];
    for (const peCode of peCodes) {
      results.push(await this.computeForPe(peCode, fy, opts));
    }

    // transfer_candidate is cross-PE; run it once over the full set of derived terminations
    // / new_starts after the per-PE pass (only meaningful when ≥2 PB books are loaded).
    await this.computeTransferCandidates(opts).catch((err) => {
      this.logger.warn(`transfer_candidate pass failed (non-fatal): ${String(err)}`);
    });

    return results;
  }

  /** Derive the (unscored) deltas for one PE from its years / positions / procurement lines. */
  async deriveForPe(peCode: string, fy?: number): Promise<DerivedDelta[]> {
    const [years, positions, procurement] = await Promise.all([
      this.prisma.programElementYear.findMany({
        where: { peCode, ...(fy !== undefined ? { fy } : {}) },
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
      }),
      this.prisma.programElementBudgetPosition.findMany({
        where: { peCode, valueKind: 'total' },
        select: { positionCycle: true, assertedFy: true, amount: true, valueKind: true },
      }),
      this.prisma.programElementProcurementLine.findMany({
        where: { peCode },
        select: {
          lineDescription: true,
          fy: true,
          quantity: true,
          unitCost: true,
          sourceUrl: true,
        },
      }),
    ]);

    const yearLikes: YearLike[] = years.map((y) => ({
      fy: y.fy,
      request: dec(y.request),
      hascMark: dec(y.hascMark),
      sascMark: dec(y.sascMark),
      hacDMark: dec(y.hacDMark),
      sacDMark: dec(y.sacDMark),
      conference: dec(y.conference),
      ndaaConference: dec(y.ndaaConference),
      enacted: dec(y.enacted),
    }));
    const positionLikes: BudgetPositionLike[] = positions.map((p) => ({
      positionCycle: p.positionCycle,
      assertedFy: p.assertedFy,
      amount: dec(p.amount),
      valueKind: p.valueKind,
    }));
    const procLikes: ProcurementLineLike[] = procurement.map((l) => ({
      lineDescription: l.lineDescription,
      fy: l.fy,
      quantity: dec(l.quantity),
      unitCost: dec(l.unitCost),
      sourceUrl: l.sourceUrl,
    }));

    const hasPriorPb =
      new Set(
        positionLikes
          .map((p) => /^pb_fy(\d{4})$/i.exec(p.positionCycle)?.[1])
          .filter((v): v is string => Boolean(v)),
      ).size >= 2;

    const derived: DerivedDelta[] = [];
    for (const y of yearLikes) derived.push(...deltasFromYear(y));
    derived.push(...deltasFromPositions(positionLikes));
    derived.push(...deltasFromProcurement(procLikes));
    derived.push(...newStartFromYears(yearLikes, hasPriorPb));
    return derived;
  }

  /** Recompute + persist (idempotent) + emit for one PE. */
  async computeForPe(
    peCode: string,
    fy?: number,
    opts: ComputeOptions = {},
  ): Promise<PeDeltaResult> {
    const weights = opts.weights ?? DEFAULT_MATERIALITY_WEIGHTS;
    const commit = opts.commit ?? false;
    const emit = opts.emit ?? commit;

    const derived = await this.deriveForPe(peCode, fy);
    const result: PeDeltaResult = {
      peCode,
      derived: derived.length,
      inserted: 0,
      superseded: 0,
      unchanged: 0,
      emitted: 0,
    };

    // Existing LIVE deltas for this PE keyed by natural key, so a recompute is idempotent.
    const live = await this.prisma.programElementDelta.findMany({
      where: { peCode, supersededAt: null, ...(fy !== undefined ? { assertedFy: fy } : {}) },
    });
    const liveByKey = new Map(
      live.map((d) => [naturalKey(d.peCode, d.assertedFy, d.deltaType, d.fromRef, d.toRef), d]),
    );

    for (const d of derived) {
      const scored = scoreMateriality(
        { deltaType: d.deltaType, deltaAbsM: d.deltaAbs, deltaPct: d.deltaPct, stage: d.stage },
        weights,
      );
      const key = naturalKey(peCode, d.assertedFy, d.deltaType, d.fromRef, d.toRef);
      const existing = liveByKey.get(key);

      if (existing && !this.magnitudeChanged(existing, d)) {
        result.unchanged += 1;
        liveByKey.delete(key); // keep it (still current)
        continue;
      }

      if (!commit) {
        // Dry run: count what WOULD change, emit nothing.
        if (existing) result.superseded += 1;
        result.inserted += 1;
        liveByKey.delete(key);
        continue;
      }

      // Latest-wins: supersede the prior live row, insert the recomputed one.
      if (existing) {
        await this.prisma.programElementDelta.update({
          where: { id: existing.id },
          data: { supersededAt: new Date() },
        });
        result.superseded += 1;
      }

      await this.prisma.programElementDelta.create({
        data: {
          peCode,
          assertedFy: d.assertedFy,
          deltaType: d.deltaType,
          fromRef: d.fromRef,
          toRef: d.toRef,
          amountFrom: toDec(d.amountFrom),
          amountTo: toDec(d.amountTo),
          deltaAbs: toDec(d.deltaAbs),
          deltaPct: d.deltaPct,
          evidence: d.evidence as Prisma.InputJsonValue,
          materialityScore: scored.score,
          materialityFactors: scored.factors as unknown as Prisma.InputJsonValue,
        },
      });
      result.inserted += 1;
      liveByKey.delete(key);

      // Emit ONE IntelligenceChange per NEW material delta (≥0.4). A recompute that merely
      // re-creates an unchanged delta never reaches here (handled by the unchanged branch),
      // so re-running with no data change emits nothing.
      if (emit && scored.score >= MATERIALITY_THRESHOLDS.notable) {
        const wasNew = !existing;
        if (wasNew) {
          result.emitted += await this.emitForDelta(peCode, d, scored.score, scored.severity);
        }
      }
    }

    // Any live deltas NOT re-derived this run are stale (the underlying data no longer
    // supports them) → supersede them so the live set matches the current derivation.
    if (commit) {
      for (const stale of liveByKey.values()) {
        await this.prisma.programElementDelta.update({
          where: { id: stale.id },
          data: { supersededAt: new Date() },
        });
        result.superseded += 1;
      }
    }

    return result;
  }

  /**
   * cross-PE transfer_candidate: a termination in one PE + a new_start in another within the
   * SAME component, where the titles share a trigram similarity ≥0.6. CANDIDATE only (never
   * asserted) — stored as a delta with deltaType='transfer_candidate'. Dormant until ≥2 PB
   * books exist (terminations come from droppedFromPb). Best-effort; never throws into the run.
   */
  private async computeTransferCandidates(opts: ComputeOptions): Promise<void> {
    if (!(opts.commit ?? false)) return;
    const live = await this.prisma.programElementDelta.findMany({
      where: { supersededAt: null, deltaType: { in: ['termination', 'new_start'] } },
      select: { peCode: true, assertedFy: true, deltaType: true, amountFrom: true, amountTo: true },
    });
    if (live.length === 0) return;

    const peMeta = await this.prisma.programElement.findMany({
      where: { peCode: { in: [...new Set(live.map((d) => d.peCode))] } },
      select: { peCode: true, serviceCode: true, title: true },
    });
    const metaByPe = new Map(peMeta.map((m) => [m.peCode, m]));

    const terms = live.filter((d) => d.deltaType === 'termination');
    const starts = live.filter((d) => d.deltaType === 'new_start');

    for (const term of terms) {
      const tMeta = metaByPe.get(term.peCode);
      if (!tMeta) continue;
      for (const start of starts) {
        if (start.peCode === term.peCode) continue;
        const sMeta = metaByPe.get(start.peCode);
        if (!sMeta || sMeta.serviceCode !== tMeta.serviceCode || !tMeta.serviceCode) continue;
        const sim = trigramSimilarity(tMeta.title, sMeta.title);
        if (sim < TRANSFER_TRIGRAM_THRESHOLD) continue;

        // Store the candidate against the NEW-start PE (where the money landed).
        const key = naturalKey(
          start.peCode,
          start.assertedFy,
          'transfer_candidate',
          term.peCode,
          start.peCode,
        );
        const exists = await this.prisma.programElementDelta.findFirst({
          where: {
            peCode: start.peCode,
            assertedFy: start.assertedFy,
            deltaType: 'transfer_candidate',
            fromRef: term.peCode,
            toRef: start.peCode,
            supersededAt: null,
          },
        });
        if (exists) continue;
        await this.prisma.programElementDelta.create({
          data: {
            peCode: start.peCode,
            assertedFy: start.assertedFy,
            deltaType: 'transfer_candidate',
            fromRef: term.peCode,
            toRef: start.peCode,
            amountFrom: term.amountFrom,
            amountTo: start.amountTo,
            deltaAbs: start.amountTo,
            deltaPct: null,
            evidence: {
              note: 'CANDIDATE only — never asserted. Title trigram match across PEs in the same component.',
              trigramSimilarity: Math.round(sim * 100) / 100,
              fromPe: term.peCode,
              toPe: start.peCode,
              key,
            },
            // Conservative score — a candidate is a lead, not a fact; it still gets the
            // unusual-pattern boost so it surfaces for review.
            materialityScore: scoreMateriality({
              deltaType: 'transfer_candidate',
              deltaAbsM: toNum(start.amountTo),
              deltaPct: null,
              stage: 'pb',
            }).score,
            materialityFactors: {},
          },
        });
      }
    }
  }

  private magnitudeChanged(
    existing: { amountTo: Prisma.Decimal | null; deltaAbs: Prisma.Decimal | null },
    d: DerivedDelta,
  ): boolean {
    const exTo = existing.amountTo === null ? null : existing.amountTo.toNumber();
    const exAbs = existing.deltaAbs === null ? null : existing.deltaAbs.toNumber();
    return !numEq(exTo, d.amountTo) || !numEq(exAbs, d.deltaAbs);
  }

  private async emitForDelta(
    peCode: string,
    d: DerivedDelta,
    score: number,
    severity: 'info' | 'notable' | 'critical',
  ): Promise<number> {
    const affected = await this.getAffectedTenants(peCode);
    if (affected.length === 0) return 0;

    // Re-read the freshly inserted live delta to carry its id in the change payload.
    const row = await this.prisma.programElementDelta.findFirst({
      where: {
        peCode,
        assertedFy: d.assertedFy,
        deltaType: d.deltaType,
        fromRef: d.fromRef,
        toRef: d.toRef,
        supersededAt: null,
      },
      select: { id: true },
      orderBy: { computedAt: 'desc' },
    });

    const title = this.buildTitle(peCode, d, score);
    const data: Prisma.InputJsonValue = {
      deltaId: row?.id ?? null,
      deltaType: d.deltaType,
      assertedFy: d.assertedFy,
      amountFrom: d.amountFrom,
      amountTo: d.amountTo,
      deltaAbs: d.deltaAbs,
      deltaPct: d.deltaPct,
      materialityScore: score,
      evidence: d.evidence as Prisma.InputJsonValue,
    };

    let emitted = 0;
    await Promise.all(
      affected.map(({ tenantId, relatedClientIds }) =>
        this.prisma.intelligenceChange
          .create({
            data: {
              source: 'program_element',
              changeType: this.changeTypeForDelta(d),
              severity,
              title,
              description: `${labelForType(d.deltaType)} for PE ${peCode} (FY${d.assertedFy}).`,
              relatedClientIds,
              relatedIssues: [],
              relatedPeCodes: [peCode],
              data,
            },
          })
          .then(() => {
            emitted += 1;
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(`Failed to emit delta change for tenant ${tenantId}: ${message}`);
          }),
      ),
    );
    return emitted;
  }

  private changeTypeForDelta(d: DerivedDelta): string {
    switch (d.deltaType) {
      case 'new_start':
        return 'pe_mark_added';
      case 'termination':
      case 'zeroed':
        return 'pe_value_decreased';
      default: {
        const abs = d.deltaAbs ?? 0;
        return abs >= 0 ? 'pe_value_increased' : 'pe_value_decreased';
      }
    }
  }

  private buildTitle(peCode: string, d: DerivedDelta, score: number): string {
    const m = (v: number | null) => (v === null ? '—' : `$${v.toFixed(0)}M`);
    const pctStr =
      d.deltaPct !== null
        ? ` (${d.deltaPct >= 0 ? '+' : ''}${(d.deltaPct * 100).toFixed(0)}%)`
        : '';
    return `${labelForType(d.deltaType)}: PE ${peCode} FY${d.assertedFy} ${m(d.amountFrom)}→${m(d.amountTo)}${pctStr}`;
  }

  private async getAffectedTenants(
    peCode: string,
  ): Promise<Array<{ tenantId: string; relatedClientIds: string[] }>> {
    // Step 2.3 — affected tenants are the union of THREE signals:
    //   (1) a user in the tenant WATCHES this PE,
    //   (2) a client capability explicitly names this PE (legacy peNumber == peCode),
    //   (3) a client is RELEVANT to this PE on any evidence path (keyword / prior-award /
    //       facility-district / ecosystem) at/above 0.5 — surfaced cross-tenant by the
    //       relevance service's SYSTEM path.
    // (3) is ADDITIVE: it pulls in clients with NO watch and NO peNumber capability, so a
    // keyword/award/facility-relevant client still appears in relatedClientIds.
    const [{ watches, capabilities }, relevant] = await Promise.all([
      // Both of these enumerations are cross-tenant BY DESIGN, and BOTH tables are
      // RLS-FORCED — client_capabilities since the tenancy migration, and
      // program_element_watch as of the Phase C tenant-isolation migration. The
      // runtime role (capiro_app) is NOT BYPASSRLS, so a plain read returns zero
      // rows with no error. For the watch leg that failure is silent and total:
      // every tenant reached ONLY by a watch would drop out of alert routing. Keep
      // both reads on the system (bypass) path, in one transaction so the fan-out
      // costs a single pooled connection.
      this.prisma.withSystem(async (tx) => {
        // Which tenants watch this PE — used to route per-tenant alerts.
        const watchRows = await tx.programElementWatch.findMany({
          where: { peCode },
          select: { tenantId: true },
        });
        // Match BOTH the legacy scalar peNumber and the multi-PE peNumbers[] array
        // directly, so a peNumbers[]-only capability is caught here (not only via the
        // relevance leg, which has a .catch->[] fallback that could silently drop it).
        const capabilityRows = await tx.clientCapability.findMany({
          where: { OR: [{ peNumber: peCode }, { peNumbers: { has: peCode } }] },
          select: { tenantId: true, clientId: true },
        });
        return { watches: watchRows, capabilities: capabilityRows };
      }),
      this.relevanceService
        ? this.relevanceService
            .getRelevantTenantClientsForPe(peCode, { minScore: 0.5 })
            .catch((err: unknown) => {
              // Relevance is an enrichment, never a gate: a failure must not drop the
              // watch/capability-derived recipients. Degrade to no relevance signal.
              const message = err instanceof Error ? err.message : String(err);
              this.logger.warn(`relevance lookup failed for PE ${peCode} (non-fatal): ${message}`);
              return [] as Array<{ tenantId: string; clientId: string; score: number }>;
            })
        : Promise.resolve([] as Array<{ tenantId: string; clientId: string; score: number }>),
    ]);
    const byTenant = new Map<string, Set<string>>();
    for (const w of watches) if (!byTenant.has(w.tenantId)) byTenant.set(w.tenantId, new Set());
    for (const c of capabilities) {
      const set = byTenant.get(c.tenantId) ?? new Set<string>();
      set.add(c.clientId);
      byTenant.set(c.tenantId, set);
    }
    for (const r of relevant) {
      const set = byTenant.get(r.tenantId) ?? new Set<string>();
      set.add(r.clientId);
      byTenant.set(r.tenantId, set);
    }
    return [...byTenant.entries()].map(([tenantId, ids]) => ({
      tenantId,
      relatedClientIds: [...ids],
    }));
  }
}

// ── pure helpers (no this) ────────────────────────────────────────────────────

function naturalKey(
  peCode: string,
  fy: number,
  deltaType: string,
  fromRef: string | null,
  toRef: string | null,
): string {
  return `${peCode}::${fy}::${deltaType}::${fromRef ?? ''}::${toRef ?? ''}`;
}

function dec(v: Prisma.Decimal | null): number | string | null {
  return v === null ? null : (v as unknown as string | number);
}

function toDec(v: number | null): Prisma.Decimal | null {
  return v === null ? null : new Prisma.Decimal(v);
}

function toNum(v: Prisma.Decimal | null): number | null {
  return v === null ? null : v.toNumber();
}

function numEq(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 1e-6;
}

function labelForType(deltaType: string): string {
  const labels: Record<string, string> = {
    pb_vs_prior_pb: 'PB-vs-prior-PB change',
    mark_vs_request: 'Committee mark vs request',
    mark_vs_mark: 'Mark divergence',
    conference_vs_marks: 'Conference change',
    enacted_vs_request: 'Enacted vs request',
    new_start: 'New program start',
    termination: 'Program termination',
    zeroed: 'Funding zeroed',
    transfer_candidate: 'Possible transfer (candidate)',
    quantity_change: 'Quantity change',
    unit_cost_change: 'Unit-cost change',
    outyear_shift: 'Outyear shift',
    project_level_change: 'Project-level change',
  };
  return labels[deltaType] ?? deltaType;
}

/**
 * Dice-coefficient trigram similarity in [0,1] — the standard "title trigram" measure the
 * plan references for transfer candidates. Pure, deterministic, no pg_trgm dependency.
 */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return (2 * shared) / (ta.size + tb.size);
}

function trigrams(s: string): Set<string> {
  const norm = `  ${s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
  const out = new Set<string>();
  for (let i = 0; i < norm.length - 2; i += 1) out.add(norm.slice(i, i + 3));
  return out;
}
