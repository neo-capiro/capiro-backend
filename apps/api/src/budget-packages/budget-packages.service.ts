import { Injectable, NotFoundException } from '@nestjs/common';
import {
  BUDGET_VEHICLE_CLASS_LABELS,
  FUNDING_STAGES,
  FUNDING_STAGE_LABELS,
  type BudgetFundingStage,
  type BudgetVehicleClass,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Budget Package read APIs (Release R3, plan §3.4).
 *
 * GLOBAL public-domain data: budget_package and its children carry no tenant_id,
 * so these reads take no tenant predicate — exactly like the Program Element read
 * service. Nothing here writes.
 *
 * Two invariants shape every method:
 *
 *  1. A figure is only meaningful with its (fiscalYear, stage, vehicleClass, scope,
 *     source). Every position this service returns carries all five, so a caller
 *     can never render a bare number.
 *  2. A delta is only computed between the SAME fiscal year and the SAME scope
 *     (§3.2 hard rule). {@link diffAgainstRequest} is the single place that decides
 *     comparability, and it returns null rather than a misleading number.
 *
 * Authorization and appropriation stay distinct rows throughout — they are never
 * coalesced into one "current" amount (§5 edge case 14).
 */

/** Result caps: a package read is bounded, like every other read path in the repo. */
const MAX_POSITIONS = 500;
const MAX_VEHICLES = 200;
const MAX_PE_IMPACTS = 200;
const MAX_PACKAGES = 100;

/** The four matrix rows the plan names, in display order. */
const MATRIX_TRACKS: BudgetVehicleClass[] = [
  'request',
  'authorization',
  'appropriation',
  'interim_funding',
];
/** Extra tracks are appended only when the package actually has such a vehicle. */
const EXTRA_TRACKS: BudgetVehicleClass[] = ['supplemental', 'reconciliation'];

export interface FundingPositionView {
  id: string;
  vehicleId: string | null;
  billId: string | null;
  fiscalYear: number;
  vehicleClass: string;
  vehicleClassLabel: string;
  stage: string;
  stageLabel: string;
  scope: string;
  amountMillions: number;
  effectiveDate: string | null;
  sourceUrl: string | null;
  sourcePage: number | null;
  sourceDocumentId: string | null;
  note: string | null;
  verificationStatus: string;
}

export interface VehicleView {
  id: string;
  track: string;
  trackLabel: string;
  stage: string;
  stageLabel: string;
  billId: string | null;
  reportNumber: string | null;
  publicLaw: string | null;
  chamber: string | null;
  label: string;
  status: string;
  statusAt: string | null;
  sourceUrl: string | null;
  sourceDocumentId: string | null;
  positions: FundingPositionView[];
}

export interface PackageSummaryView {
  id: string;
  domain: string;
  fiscalYear: number;
  name: string;
  status: string;
  vehicleCount: number;
  positionCount: number;
  /** Live (non-superseded) scopes present, so a caller knows what is comparable. */
  scopes: string[];
  updatedAt: string;
}

export interface MatrixCell {
  stage: string;
  stageLabel: string;
  /** A stage MAY hold several vehicles (omnibus/minibus/multiple chamber bills). */
  vehicles: VehicleView[];
}

export interface MatrixRow {
  track: string;
  trackLabel: string;
  cells: MatrixCell[];
}

export interface StatusMatrixView {
  package: PackageSummaryView;
  stages: Array<{ stage: string; label: string }>;
  rows: MatrixRow[];
  /** Vehicles whose track is outside the matrix rows — surfaced, never dropped. */
  unmatchedVehicles: VehicleView[];
}

export interface ScopeComparisonView {
  scope: string;
  fiscalYear: number;
  /** The request row for this (FY, scope), if one exists — the delta baseline. */
  requestMillions: number | null;
  entries: Array<{
    stage: string;
    vehicleClass: string;
    amountMillions: number;
    /** Same-FY, same-scope delta vs the request. Null when not comparable. */
    deltaMillions: number | null;
    pct: number | null;
    verificationStatus: string;
    vehicleId: string | null;
    billId: string | null;
  }>;
}

/** Millions → millions delta, ONLY when fiscal year and scope match (§3.2). */
export function diffAgainstRequest(
  baseline: { fiscalYear: number; scope: string; amountMillions: number } | null,
  row: { fiscalYear: number; scope: string; amountMillions: number },
): { deltaMillions: number | null; pct: number | null } {
  if (!baseline) return { deltaMillions: null, pct: null };
  if (baseline.fiscalYear !== row.fiscalYear) return { deltaMillions: null, pct: null };
  if (baseline.scope !== row.scope) return { deltaMillions: null, pct: null };
  const delta = row.amountMillions - baseline.amountMillions;
  const pct = baseline.amountMillions === 0 ? null : (delta / baseline.amountMillions) * 100;
  return { deltaMillions: delta, pct: pct == null ? null : Number(pct.toFixed(2)) };
}

/**
 * Group vehicles into the (track × stage) matrix. Pure so the shape is unit-tested
 * without a database. A cell with no vehicle is present-but-empty (the UI must be
 * able to say "no Senate appropriations vehicle yet" rather than imply zero
 * dollars), and any vehicle whose track is not a matrix row is returned separately
 * instead of being silently dropped.
 */
export function buildStatusMatrix(vehicles: VehicleView[]): {
  rows: MatrixRow[];
  unmatchedVehicles: VehicleView[];
} {
  const present = new Set(vehicles.map((v) => v.track));
  const tracks = [...MATRIX_TRACKS, ...EXTRA_TRACKS.filter((t) => present.has(t))];
  const rows: MatrixRow[] = tracks.map((track) => ({
    track,
    trackLabel: BUDGET_VEHICLE_CLASS_LABELS[track],
    cells: FUNDING_STAGES.map((stage) => ({
      stage,
      stageLabel: FUNDING_STAGE_LABELS[stage],
      vehicles: vehicles.filter((v) => v.track === track && v.stage === stage),
    })),
  }));
  const known = new Set<string>(tracks);
  const unmatchedVehicles = vehicles.filter(
    (v) => !known.has(v.track) || !FUNDING_STAGES.includes(v.stage as BudgetFundingStage),
  );
  return { rows, unmatchedVehicles };
}

type RawPosition = {
  id: string;
  vehicleId: string | null;
  billId: string | null;
  fiscalYear: number;
  vehicleClass: string;
  stage: string;
  scope: string;
  amountMillions: unknown;
  effectiveDate: Date | null;
  sourceUrl: string | null;
  sourcePage: number | null;
  sourceDocumentId: string | null;
  note: string | null;
  verificationStatus: string;
};

function toIso(d: Date | null | undefined): string | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

function labelOf<T extends string>(map: Record<string, string>, key: T): string {
  return map[key] ?? key;
}

function toPositionView(p: RawPosition): FundingPositionView {
  return {
    id: p.id,
    vehicleId: p.vehicleId,
    billId: p.billId,
    fiscalYear: p.fiscalYear,
    vehicleClass: p.vehicleClass,
    vehicleClassLabel: labelOf(BUDGET_VEHICLE_CLASS_LABELS, p.vehicleClass),
    stage: p.stage,
    stageLabel: labelOf(FUNDING_STAGE_LABELS, p.stage),
    scope: p.scope,
    amountMillions: Number(p.amountMillions),
    effectiveDate: toIso(p.effectiveDate),
    sourceUrl: p.sourceUrl,
    sourcePage: p.sourcePage,
    sourceDocumentId: p.sourceDocumentId,
    note: p.note,
    verificationStatus: p.verificationStatus,
  };
}

@Injectable()
export class BudgetPackagesService {
  constructor(private readonly prisma: PrismaService) {}

  /** All packages, newest fiscal year first. Global data — no tenant predicate. */
  async list(domain?: string): Promise<PackageSummaryView[]> {
    const rows = await this.prisma.budgetPackage.findMany({
      where: domain ? { domain } : {},
      orderBy: [{ fiscalYear: 'desc' }, { domain: 'asc' }],
      take: MAX_PACKAGES,
      include: {
        _count: { select: { vehicles: true } },
        positions: {
          where: { verificationStatus: { not: 'superseded' } },
          select: { scope: true },
        },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      fiscalYear: r.fiscalYear,
      name: r.name,
      status: r.status,
      vehicleCount: r._count.vehicles,
      positionCount: r.positions.length,
      scopes: [...new Set(r.positions.map((p) => p.scope))].sort(),
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /**
   * One package with its vehicles and each vehicle's LIVE positions.
   * Superseded rows are excluded here and available through {@link history}.
   */
  async get(id: string): Promise<{ package: PackageSummaryView; vehicles: VehicleView[] }> {
    const pkg = await this.loadPackage(id);
    const vehicles = await this.loadVehicles(id);
    return { package: pkg, vehicles };
  }

  /**
   * The Request / Authorization / Appropriations / Interim-Funding grid across
   * President / House / Senate / Conference / Enacted (§3.4).
   */
  async statusMatrix(id: string): Promise<StatusMatrixView> {
    const pkg = await this.loadPackage(id);
    const vehicles = await this.loadVehicles(id);
    const { rows, unmatchedVehicles } = buildStatusMatrix(vehicles);
    return {
      package: pkg,
      stages: FUNDING_STAGES.map((s) => ({ stage: s, label: FUNDING_STAGE_LABELS[s] })),
      rows,
      unmatchedVehicles,
    };
  }

  /**
   * Audit history: every superseded position (what the number used to be, and when
   * it changed) plus the fiscal year's interim-funding / lapse windows.
   */
  async history(id: string): Promise<{
    package: PackageSummaryView;
    supersededPositions: FundingPositionView[];
    interimFundingPeriods: Array<{
      id: string;
      sequence: number;
      vehicleLabel: string;
      startDate: string | null;
      coverageThrough: string | null;
      billId: string | null;
      publicLaw: string | null;
      shutdownDays: number | null;
      notes: string | null;
      sourceUrl: string | null;
    }>;
  }> {
    const pkg = await this.loadPackage(id);
    const [superseded, periods] = await Promise.all([
      this.prisma.fundingPosition.findMany({
        where: { packageId: id, verificationStatus: 'superseded' },
        orderBy: { updatedAt: 'desc' },
        take: MAX_POSITIONS,
      }),
      this.prisma.budgetInterimFundingPeriod.findMany({
        where: { domain: pkg.domain, fiscalYear: pkg.fiscalYear },
        orderBy: { sequence: 'asc' },
      }),
    ]);
    return {
      package: pkg,
      supersededPositions: superseded.map((p) => toPositionView(p as RawPosition)),
      interimFundingPeriods: periods.map((p) => ({
        id: p.id,
        sequence: p.sequence,
        vehicleLabel: p.vehicleLabel,
        startDate: toIso(p.startDate),
        coverageThrough: toIso(p.coverageThrough),
        billId: p.billId,
        publicLaw: p.publicLaw,
        shutdownDays: p.shutdownDays,
        notes: p.notes,
        sourceUrl: p.sourceUrl,
      })),
    };
  }

  /**
   * Same-FY, same-scope comparison of every live position against the request row
   * for that scope. A scope with no request row yields entries with null deltas —
   * the figure is still shown, the comparison simply is not claimed.
   */
  async scopeComparison(id: string): Promise<ScopeComparisonView[]> {
    const pkg = await this.loadPackage(id);
    const positions = await this.prisma.fundingPosition.findMany({
      where: { packageId: id, verificationStatus: { not: 'superseded' } },
      orderBy: [{ scope: 'asc' }, { stage: 'asc' }],
      take: MAX_POSITIONS,
    });
    const views = positions.map((p) => toPositionView(p as RawPosition));
    const byScope = new Map<string, FundingPositionView[]>();
    for (const v of views) {
      const key = `${v.fiscalYear}|${v.scope}`;
      const list = byScope.get(key) ?? [];
      list.push(v);
      byScope.set(key, list);
    }
    const out: ScopeComparisonView[] = [];
    for (const [key, list] of byScope) {
      const [fyStr, scope] = key.split('|');
      const fiscalYear = Number(fyStr);
      const baseline = list.find((v) => v.stage === 'president') ?? null;
      out.push({
        scope: scope as string,
        fiscalYear,
        requestMillions: baseline ? baseline.amountMillions : null,
        entries: list.map((v) => {
          const d = diffAgainstRequest(
            baseline
              ? {
                  fiscalYear: baseline.fiscalYear,
                  scope: baseline.scope,
                  amountMillions: baseline.amountMillions,
                }
              : null,
            { fiscalYear: v.fiscalYear, scope: v.scope, amountMillions: v.amountMillions },
          );
          return {
            stage: v.stage,
            vehicleClass: v.vehicleClass,
            amountMillions: v.amountMillions,
            deltaMillions: d.deltaMillions,
            pct: d.pct,
            verificationStatus: v.verificationStatus,
            vehicleId: v.vehicleId,
            billId: v.billId,
          };
        }),
      });
    }
    // Deterministic order regardless of the package's fiscal-year spread.
    out.sort((a, b) => b.fiscalYear - a.fiscalYear || a.scope.localeCompare(b.scope));
    void pkg;
    return out;
  }

  /**
   * Cross-fiscal-year interim-funding (CR) and lapse history for a domain
   * (R4 §4.4) — how each year was actually funded: the CR sequence, what each
   * vehicle funded THROUGH, whether a lapse followed, and the enacted full-year
   * vehicle when one exists.
   *
   * Deliberately an API-only surface in R4: the plan adds no package-level screen
   * until Budget Cycle 360 (R7). Verified through this endpoint and its tests so the
   * final Policy Portfolio Funding tab consumes already-proven records.
   *
   * `totalDaysCovered` and `lapseDays` are SUMS of stored facts, never estimates; a
   * period missing dates contributes nothing rather than a guessed span.
   */
  async interimFundingHistory(domain = 'defense'): Promise<
    Array<{
      fiscalYear: number;
      packageId: string | null;
      packageName: string | null;
      packageStatus: string | null;
      periods: Array<{
        id: string;
        sequence: number;
        vehicleLabel: string;
        startDate: string | null;
        coverageThrough: string | null;
        billId: string | null;
        publicLaw: string | null;
        shutdownDays: number | null;
        notes: string | null;
        sourceUrl: string | null;
      }>;
      crCount: number;
      lapseDays: number;
      /** The enacted vehicle for the year, when the package records one. */
      enactedVehicle: { label: string; billId: string | null; publicLaw: string | null } | null;
      /** Enacted-stage figures for the year, so a reader sees the amount AND its scope. */
      enactedPositions: FundingPositionView[];
    }>
  > {
    const [periods, packages] = await Promise.all([
      this.prisma.budgetInterimFundingPeriod.findMany({
        where: { domain },
        orderBy: [{ fiscalYear: 'desc' }, { sequence: 'asc' }],
        take: MAX_POSITIONS,
      }),
      this.prisma.budgetPackage.findMany({
        where: { domain },
        orderBy: { fiscalYear: 'desc' },
        take: MAX_PACKAGES,
        include: {
          vehicles: { where: { stage: 'enacted' }, take: MAX_VEHICLES },
          positions: {
            where: { stage: 'enacted', verificationStatus: { not: 'superseded' } },
            take: MAX_POSITIONS,
          },
        },
      }),
    ]);

    // Every fiscal year that appears in EITHER source — a year can have CRs with no
    // package row yet, or an enacted package with no CR at all.
    const years = [
      ...new Set([...periods.map((p) => p.fiscalYear), ...packages.map((p) => p.fiscalYear)]),
    ].sort((a, b) => b - a);

    return years.map((fiscalYear) => {
      const yearPeriods = periods.filter((p) => p.fiscalYear === fiscalYear);
      const pkg = packages.find((p) => p.fiscalYear === fiscalYear) ?? null;
      const enacted = pkg?.vehicles[0] ?? null;
      return {
        fiscalYear,
        packageId: pkg?.id ?? null,
        packageName: pkg?.name ?? null,
        packageStatus: pkg?.status ?? null,
        periods: yearPeriods.map((p) => ({
          id: p.id,
          sequence: p.sequence,
          vehicleLabel: p.vehicleLabel,
          startDate: toIso(p.startDate),
          coverageThrough: toIso(p.coverageThrough),
          billId: p.billId,
          publicLaw: p.publicLaw,
          shutdownDays: p.shutdownDays,
          notes: p.notes,
          sourceUrl: p.sourceUrl,
        })),
        crCount: yearPeriods.length,
        lapseDays: yearPeriods.reduce((n, p) => n + (p.shutdownDays ?? 0), 0),
        enactedVehicle: enacted
          ? { label: enacted.label, billId: enacted.billId, publicLaw: enacted.publicLaw }
          : null,
        enactedPositions: (pkg?.positions ?? []).map((p) => toPositionView(p as RawPosition)),
      };
    });
  }

  /**
   * Program Element lines touched by this package's bill vehicles, with the PE
   * ladder for the package fiscal year and a same-FY delta vs the PE request.
   *
   * Scoped by `bill_budget_line_link` (the reviewed bill→PE link), so a package with
   * no linked bills returns an empty list rather than every PE in the fiscal year.
   * The PE row remains the line-level source of truth — this is a package-level
   * rollup over it, never a second funding model (§4.2).
   */
  async programElementImpacts(id: string): Promise<{
    package: PackageSummaryView;
    impacts: Array<{
      peCode: string;
      title: string | null;
      requestMillions: number | null;
      houseMillions: number | null;
      senateMillions: number | null;
      enactedMillions: number | null;
      deltaVsRequestMillions: number | null;
      pct: number | null;
      matchBasis: string;
      reviewStatus: string;
      confidence: number;
      billId: string;
    }>;
  }> {
    const pkg = await this.loadPackage(id);
    const vehicles = await this.prisma.budgetPackageVehicle.findMany({
      where: { packageId: id, billId: { not: null } },
      select: { billId: true },
      take: MAX_VEHICLES,
    });
    const billIds = [...new Set(vehicles.map((v) => v.billId).filter((b): b is string => !!b))];
    if (!billIds.length) return { package: pkg, impacts: [] };

    const links = await this.prisma.billBudgetLineLink.findMany({
      where: { billId: { in: billIds }, status: { not: 'rejected' } },
      orderBy: [{ confidence: 'desc' }],
      take: MAX_PE_IMPACTS,
    });
    if (!links.length) return { package: pkg, impacts: [] };

    const peCodes = [...new Set(links.map((l) => l.peCode))];
    const [years, elements] = await Promise.all([
      this.prisma.programElementYear.findMany({
        where: { peCode: { in: peCodes }, fy: pkg.fiscalYear },
      }),
      this.prisma.programElement.findMany({
        where: { peCode: { in: peCodes } },
        select: { peCode: true, title: true },
      }),
    ]);
    const yearByPe = new Map(years.map((y) => [y.peCode, y]));
    const titleByPe = new Map(elements.map((e) => [e.peCode, e.title]));

    const impacts = links.map((l) => {
      const y = yearByPe.get(l.peCode);
      const num = (v: unknown): number | null => (v == null ? null : Number(v));
      const request = num(y?.request);
      // House/Senate at the PE level: the appropriations mark is the funding number;
      // the authorization mark is a DIFFERENT track and is not substituted for it.
      const house = num(y?.hacDMark);
      const senate = num(y?.sacDMark);
      const enacted = num(y?.enacted);
      // Same-FY by construction (both sides are this package's fiscal year). The
      // comparison target is the furthest available appropriations stage.
      const latest = enacted ?? senate ?? house;
      const delta = request != null && latest != null ? latest - request : null;
      const pct =
        delta != null && request != null && request !== 0
          ? Number(((delta / request) * 100).toFixed(2))
          : null;
      return {
        peCode: l.peCode,
        title: titleByPe.get(l.peCode) ?? null,
        requestMillions: request,
        houseMillions: house,
        senateMillions: senate,
        enactedMillions: enacted,
        deltaVsRequestMillions: delta,
        pct,
        matchBasis: l.linkType,
        reviewStatus: l.status,
        confidence: l.confidence,
        billId: l.billId,
      };
    });
    impacts.sort(
      (a, b) => Math.abs(b.deltaVsRequestMillions ?? 0) - Math.abs(a.deltaVsRequestMillions ?? 0),
    );
    return { package: pkg, impacts };
  }

  /**
   * The package(s) a bill participates in, plus that bill's own vehicles and live
   * positions. Returns an empty list (not a 404) when a bill is simply not a budget
   * vehicle — most bills are not.
   */
  async byBill(billId: string): Promise<
    Array<{
      package: PackageSummaryView;
      vehicles: VehicleView[];
      positions: FundingPositionView[];
    }>
  > {
    const vehicles = await this.prisma.budgetPackageVehicle.findMany({
      where: { billId },
      take: MAX_VEHICLES,
      include: {
        package: true,
        positions: {
          where: { verificationStatus: { not: 'superseded' } },
          orderBy: [{ scope: 'asc' }],
          take: MAX_POSITIONS,
        },
      },
    });
    if (!vehicles.length) return [];

    const byPackage = new Map<string, typeof vehicles>();
    for (const v of vehicles) {
      const list = byPackage.get(v.packageId) ?? [];
      list.push(v);
      byPackage.set(v.packageId, list);
    }
    return [...byPackage.values()].map((list) => {
      const pkgRow = list[0]!.package;
      return {
        package: {
          id: pkgRow.id,
          domain: pkgRow.domain,
          fiscalYear: pkgRow.fiscalYear,
          name: pkgRow.name,
          status: pkgRow.status,
          vehicleCount: list.length,
          positionCount: list.reduce((n, v) => n + v.positions.length, 0),
          scopes: [...new Set(list.flatMap((v) => v.positions.map((p) => p.scope)))].sort(),
          updatedAt: pkgRow.updatedAt.toISOString(),
        },
        vehicles: list.map((v) => ({
          id: v.id,
          track: v.track,
          trackLabel: labelOf(BUDGET_VEHICLE_CLASS_LABELS, v.track),
          stage: v.stage,
          stageLabel: labelOf(FUNDING_STAGE_LABELS, v.stage),
          billId: v.billId,
          reportNumber: v.reportNumber,
          publicLaw: v.publicLaw,
          chamber: v.chamber,
          label: v.label,
          status: v.status,
          statusAt: toIso(v.statusAt),
          sourceUrl: v.sourceUrl,
          sourceDocumentId: v.sourceDocumentId,
          positions: v.positions.map((p) => toPositionView(p as RawPosition)),
        })),
        positions: list.flatMap((v) => v.positions.map((p) => toPositionView(p as RawPosition))),
      };
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async loadPackage(id: string): Promise<PackageSummaryView> {
    const row = await this.prisma.budgetPackage.findUnique({
      where: { id },
      include: {
        _count: { select: { vehicles: true } },
        positions: {
          where: { verificationStatus: { not: 'superseded' } },
          select: { scope: true },
        },
      },
    });
    if (!row) throw new NotFoundException('BUDGET_PACKAGE_NOT_FOUND');
    return {
      id: row.id,
      domain: row.domain,
      fiscalYear: row.fiscalYear,
      name: row.name,
      status: row.status,
      vehicleCount: row._count.vehicles,
      positionCount: row.positions.length,
      scopes: [...new Set(row.positions.map((p) => p.scope))].sort(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async loadVehicles(packageId: string): Promise<VehicleView[]> {
    const rows = await this.prisma.budgetPackageVehicle.findMany({
      where: { packageId },
      orderBy: [{ track: 'asc' }, { stage: 'asc' }, { label: 'asc' }],
      take: MAX_VEHICLES,
      include: {
        positions: {
          where: { verificationStatus: { not: 'superseded' } },
          orderBy: [{ scope: 'asc' }],
          take: MAX_POSITIONS,
        },
      },
    });
    return rows.map((v) => ({
      id: v.id,
      track: v.track,
      trackLabel: labelOf(BUDGET_VEHICLE_CLASS_LABELS, v.track),
      stage: v.stage,
      stageLabel: labelOf(FUNDING_STAGE_LABELS, v.stage),
      billId: v.billId,
      reportNumber: v.reportNumber,
      publicLaw: v.publicLaw,
      chamber: v.chamber,
      label: v.label,
      status: v.status,
      statusAt: toIso(v.statusAt),
      sourceUrl: v.sourceUrl,
      sourceDocumentId: v.sourceDocumentId,
      positions: v.positions.map((p) => toPositionView(p as RawPosition)),
    }));
  }
}
