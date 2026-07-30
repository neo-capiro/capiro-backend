/**
 * Program Elements Phase G — current-cycle, track-aware funding claim contract.
 *
 * Every API dollar figure that can become a headline MUST be representable as a
 * FundingClaim (value + FY + stage + vehicle + cycle class + projection flag).
 * Pure / DB-free. All money values are USD millions.
 *
 * Invariants:
 * - Zero is a real value (never treated as missing; never skipped by "latest nonzero").
 * - Authorization and appropriations never share a comparison series.
 * - Percentage deltas require identical fiscal years (and a non-zero base).
 * - Outyear (FYDP) rows are projections and cannot be labeled "the current request".
 * - Capability / movement KPIs disclose coverage denominators.
 */

export type FundingClaimStage =
  | 'request'
  | 'hasc'
  | 'sasc'
  | 'ndaa_conference'
  | 'hacd'
  | 'sacd'
  | 'appropriations_conference'
  | 'enacted'
  | 'none';

/** Coarse class relative to the PE's (or portfolio's) live process year. */
export type FundingCycleClass = 'historical' | 'current' | 'outyear' | 'unknown';

/**
 * Legislative vehicle for a dollar claim. Intentionally finer than the older
 * FundingVehicle on the appropriations ladder alone so authorization conference
 * (NDAA) and appropriations conference (Defense Approps / JES) never collude.
 */
export type FundingClaimLegislativeVehicle =
  | 'request'
  | 'authorization'
  | 'appropriations'
  | 'authorization_conference'
  | 'appropriations_conference'
  | 'enacted'
  | 'none';

export const FUNDING_CLAIM_STAGE_LABEL: Record<FundingClaimStage, string> = {
  request: 'Request',
  hasc: 'HASC',
  sasc: 'SASC',
  ndaa_conference: 'NDAA conference report',
  hacd: 'HAC-D',
  sacd: 'SAC-D',
  appropriations_conference: 'Appropriations conference',
  enacted: 'Enacted',
  none: 'No data',
};

export const FUNDING_CLAIM_VEHICLE: Record<FundingClaimStage, FundingClaimLegislativeVehicle> = {
  request: 'request',
  hasc: 'authorization',
  sasc: 'authorization',
  ndaa_conference: 'authorization_conference',
  hacd: 'appropriations',
  sacd: 'appropriations',
  appropriations_conference: 'appropriations_conference',
  enacted: 'enacted',
  none: 'none',
};

/** Shared claim shape for every PE funding dollar surface. */
export interface FundingClaim {
  /** USD millions. `null` means absent; `0` is present and real. */
  value: number | null;
  fiscalYear: number | null;
  stage: FundingClaimStage;
  stageLabel: string;
  legislativeVehicle: FundingClaimLegislativeVehicle;
  cycleClass: FundingCycleClass;
  /** True only when cycleClass === 'outyear' (FYDP projection). */
  isProjection: boolean;
  unit: 'USD millions';
}

/**
 * Why a mark cell is empty (missing-mark taxonomy — plan Phase 4).
 * - present: value is on the row (including zero)
 * - not_applicable: stage does not apply to this line/vehicle class
 * - not_started: process has not reached this stage yet
 * - candidate_gap: peer mark present on the same track, this cell empty
 * - unknown_coverage: cannot tell applicability from stored evidence
 */
export type MissingMarkStatus =
  | 'present'
  | 'not_applicable'
  | 'not_started'
  | 'candidate_gap'
  | 'unknown_coverage';

export type ContractorEvidenceClass =
  | 'accepted_direct'
  | 'candidate'
  | 'unmatched_dollars';

export interface ContractorEvidenceBucket {
  evidenceClass: ContractorEvidenceClass;
  amountM: number;
  count: number;
  label: string;
}

export interface CoverageDenominator {
  /** Full filtered population size (denominator). */
  populationSize: number;
  /** Members that contributed a usable pair/value to the total. */
  contributedCount: number;
  /** populationSize - contributedCount when both known; else null. */
  missingCount: number | null;
  /** Human-readable disclosure for UI/trust surfaces. */
  disclosure: string;
}

export interface CapabilityTotalClaim {
  fiscalYear: number | null;
  unit: 'USD millions';
  /** Sum of request at the shared fiscal year (zeros included when present). */
  totalRequestM: number;
  lineCount: number;
  linesWithRequestAtFy: number;
  coverage: CoverageDenominator;
}

export interface MovementKpiClaim {
  unit: 'USD millions';
  /** Sum of (enacted - request) over pairs that qualify. */
  totalDeltaM: number | null;
  /** (Σenacted - Σrequest) / Σrequest * 100; null if base zero or no pairs. */
  avgDeltaPct: number | null;
  totalRequestM: number;
  totalEnactedM: number;
  coverage: CoverageDenominator;
}

export function classifyCycleClass(
  fiscalYear: number | null | undefined,
  currentCycleFy: number | null | undefined,
): FundingCycleClass {
  if (fiscalYear == null || currentCycleFy == null) return 'unknown';
  if (fiscalYear < currentCycleFy) return 'historical';
  if (fiscalYear === currentCycleFy) return 'current';
  return 'outyear';
}

export function buildFundingClaim(input: {
  value: number | null | undefined;
  fiscalYear: number | null | undefined;
  stage: FundingClaimStage;
  currentCycleFy?: number | null;
}): FundingClaim {
  const value =
    input.value == null || (typeof input.value === 'number' && !Number.isFinite(input.value))
      ? null
      : input.value;
  const fiscalYear = input.fiscalYear ?? null;
  const cycleClass = classifyCycleClass(fiscalYear, input.currentCycleFy ?? null);
  const stage = input.stage;
  return {
    value,
    fiscalYear,
    stage,
    stageLabel: FUNDING_CLAIM_STAGE_LABEL[stage],
    legislativeVehicle: FUNDING_CLAIM_VEHICLE[stage],
    cycleClass,
    isProjection: cycleClass === 'outyear',
    unit: 'USD millions',
  };
}

/**
 * Pick the latest FY's value WITHOUT skipping zeros. A year whose value is
 * exactly 0 beats an older non-zero year. Null (missing) years are skipped.
 */
export function selectLatestPreservingZero<T extends { fy: number; value: number | null | undefined }>(
  years: readonly T[],
): T | null {
  let best: T | null = null;
  for (const y of years) {
    if (y.value == null || (typeof y.value === 'number' && !Number.isFinite(y.value))) continue;
    if (best == null || y.fy > best.fy) best = y;
  }
  return best;
}

/**
 * Portfolio / PE "current cycle" FY from stage marks — DOES NOT skip zero marks.
 * Prefer latest FY with any non-null congressional mark (auth or approps track);
 * else latest FY with a non-null request (including 0). Null if nothing present.
 */
export function currentCycleFyPreservingZero(
  years: readonly {
    fy: number;
    request?: number | null;
    hascMark?: number | null;
    sascMark?: number | null;
    hacDMark?: number | null;
    sacDMark?: number | null;
    conference?: number | null;
    ndaaConference?: number | null;
  }[],
): number | null {
  const hasMark = (y: (typeof years)[number]): boolean =>
    y.hascMark != null ||
    y.sascMark != null ||
    y.hacDMark != null ||
    y.sacDMark != null ||
    y.conference != null ||
    y.ndaaConference != null;
  const markFys = years.filter(hasMark).map((y) => y.fy);
  if (markFys.length) return Math.max(...markFys);
  const reqFys = years.filter((y) => y.request != null).map((y) => y.fy);
  return reqFys.length ? Math.max(...reqFys) : null;
}

/**
 * Percentage change only when both values share a fiscal year and the base is
 * a finite non-zero number. Refuses cross-FY identity theft.
 */
export function percentDeltaSameFiscalYear(input: {
  value: number | null | undefined;
  base: number | null | undefined;
  valueFy: number | null | undefined;
  baseFy: number | null | undefined;
}): number | null {
  const { value, base, valueFy, baseFy } = input;
  if (value == null || base == null || valueFy == null || baseFy == null) return null;
  if (valueFy !== baseFy) return null;
  if (!Number.isFinite(value) || !Number.isFinite(base) || base === 0) return null;
  return ((value - base) / base) * 100;
}

/** True when both claims can legally headline a % move. */
export function canCompareClaimsForPct(a: FundingClaim, b: FundingClaim): boolean {
  return (
    a.value != null &&
    b.value != null &&
    a.fiscalYear != null &&
    a.fiscalYear === b.fiscalYear &&
    a.legislativeVehicle !== 'none' &&
    b.legislativeVehicle !== 'none' &&
    // Never blend authorization track with appropriations track.
    sameMoneyTrack(a.legislativeVehicle, b.legislativeVehicle)
  );
}

function sameMoneyTrack(
  a: FundingClaimLegislativeVehicle,
  b: FundingClaimLegislativeVehicle,
): boolean {
  const track = (v: FundingClaimLegislativeVehicle): 'auth' | 'approps' | 'request' | 'other' => {
    if (v === 'authorization' || v === 'authorization_conference') return 'auth';
    if (v === 'appropriations' || v === 'appropriations_conference' || v === 'enacted') return 'approps';
    if (v === 'request') return 'request';
    return 'other';
  };
  const ta = track(a);
  const tb = track(b);
  if (ta === 'other' || tb === 'other') return false;
  // request may compare against either track as the base; both non-request must match.
  if (ta === 'request' || tb === 'request') return true;
  return ta === tb;
}

export function percentDeltaBetweenClaims(a: FundingClaim, b: FundingClaim): number | null {
  if (!canCompareClaimsForPct(a, b)) return null;
  // Treat `b` as base when comparing "a vs b".
  return percentDeltaSameFiscalYear({
    value: a.value,
    base: b.value,
    valueFy: a.fiscalYear,
    baseFy: b.fiscalYear,
  });
}

/**
 * Map DEV ladder stage keys (FundingStage) onto FundingClaimStage so legacy
 * currentFunding() picks can be promoted to claims without track loss.
 * 'conference' on the ladder is appropriations conference, never NDAA.
 */
export function fundingStageToClaimStage(
  stage: string | null | undefined,
): FundingClaimStage {
  switch (stage) {
    case 'enacted':
      return 'enacted';
    case 'conference':
      return 'appropriations_conference';
    case 'sacd':
      return 'sacd';
    case 'hacd':
      return 'hacd';
    case 'sasc':
      return 'sasc';
    case 'hasc':
      return 'hasc';
    case 'request':
      return 'request';
    case 'ndaa_conference':
      return 'ndaa_conference';
    default:
      return 'none';
  }
}

export function claimFromLadderPick(input: {
  value: number | null;
  stage: string;
  fiscalYear: number | null;
  currentCycleFy: number | null;
}): FundingClaim {
  return buildFundingClaim({
    value: input.value,
    fiscalYear: input.fiscalYear,
    stage: fundingStageToClaimStage(input.stage),
    currentCycleFy: input.currentCycleFy,
  });
}

/**
 * Missing-mark taxonomy for one chamber/stage cell on a cycle year row.
 * trackPeers: other marks on the SAME vehicle track (e.g. HASC vs SASC).
 */
export function classifyMissingMark(input: {
  value: number | null | undefined;
  /** Has the budget process reached a stage that implies this cell, for this FY? */
  processReached: boolean;
  /** Is this stage applicable to the line (e.g. auth marks on an R-1)? */
  applicable: boolean;
  /** Any peer on the same track has a present (incl. zero) value. */
  peerPresentOnTrack: boolean;
}): MissingMarkStatus {
  if (input.value != null) return 'present';
  if (!input.applicable) return 'not_applicable';
  if (!input.processReached) return 'not_started';
  if (input.peerPresentOnTrack) return 'candidate_gap';
  return 'unknown_coverage';
}

export function coverageDenominator(
  populationSize: number,
  contributedCount: number,
  subject: string,
): CoverageDenominator {
  const pop = Math.max(0, populationSize);
  const contrib = Math.max(0, Math.min(contributedCount, pop || contributedCount));
  const missing = pop > 0 ? Math.max(0, pop - contrib) : null;
  const disclosure =
    pop > 0
      ? `${subject}: ${contrib} of ${pop} in filtered population` +
        (missing != null && missing > 0 ? ` (${missing} without a usable value)` : '')
      : `${subject}: ${contrib} contributed (population size not stated)`;
  return {
    populationSize: pop,
    contributedCount: contrib,
    missingCount: missing,
    disclosure,
  };
}

/**
 * Movement KPI over the FULL filtered population. Only same-row pairs in which
 * both request and enacted are non-null (zero allowed) contribute to sums;
 * coverage uses populationSize as the denominator.
 */
export function buildMovementKpi(input: {
  populationSize: number;
  pairs: readonly { request: number | null; enacted: number | null }[];
}): MovementKpiClaim {
  let totalRequestM = 0;
  let totalEnactedM = 0;
  let contributed = 0;
  for (const p of input.pairs) {
    if (p.request == null || p.enacted == null) continue;
    if (!Number.isFinite(p.request) || !Number.isFinite(p.enacted)) continue;
    totalRequestM += p.request;
    totalEnactedM += p.enacted;
    contributed += 1;
  }
  const totalDeltaM = contributed > 0 ? totalEnactedM - totalRequestM : null;
  const avgDeltaPct =
    contributed > 0 && totalRequestM !== 0
      ? ((totalEnactedM - totalRequestM) / totalRequestM) * 100
      : null;
  return {
    unit: 'USD millions',
    totalDeltaM,
    avgDeltaPct,
    totalRequestM,
    totalEnactedM,
    coverage: coverageDenominator(input.populationSize, contributed, 'Matched request/enacted pairs'),
  };
}

/**
 * Capability total at ONE fiscal year. Lines missing a request at that FY do
 * not invent zeros; they reduce coverage instead.
 */
export function buildCapabilityTotal(input: {
  fiscalYear: number | null;
  /** One entry per matched line in the capability set. */
  lineRequestsAtFy: readonly (number | null | undefined)[];
}): CapabilityTotalClaim {
  const populationSize = input.lineRequestsAtFy.length;
  let totalRequestM = 0;
  let linesWithRequestAtFy = 0;
  for (const v of input.lineRequestsAtFy) {
    if (v == null || !Number.isFinite(v)) continue;
    totalRequestM += v;
    linesWithRequestAtFy += 1;
  }
  return {
    fiscalYear: input.fiscalYear,
    unit: 'USD millions',
    totalRequestM,
    lineCount: populationSize,
    linesWithRequestAtFy,
    coverage: coverageDenominator(
      populationSize,
      linesWithRequestAtFy,
      input.fiscalYear != null
        ? `Capability request total at FY${input.fiscalYear}`
        : 'Capability request total (FY unset)',
    ),
  };
}

/**
 * Partition contractor/performer dollar evidence into the three honest classes.
 * Unmatched dollars stay visible and are never folded into accepted totals.
 */
export function partitionContractorEvidence(input: {
  acceptedDirectAmountM?: number;
  acceptedDirectCount?: number;
  candidateAmountM?: number;
  candidateCount?: number;
  unmatchedAmountM?: number;
  unmatchedCount?: number;
}): ContractorEvidenceBucket[] {
  return [
    {
      evidenceClass: 'accepted_direct',
      amountM: input.acceptedDirectAmountM ?? 0,
      count: input.acceptedDirectCount ?? 0,
      label: 'Accepted / direct evidence (named prime or PE-coded award)',
    },
    {
      evidenceClass: 'candidate',
      amountM: input.candidateAmountM ?? 0,
      count: input.candidateCount ?? 0,
      label: 'Candidate evidence (program-linked or unreviewed match)',
    },
    {
      evidenceClass: 'unmatched_dollars',
      amountM: input.unmatchedAmountM ?? 0,
      count: input.unmatchedCount ?? 0,
      label: 'Unmatched dollars (not attributed to this PE)',
    },
  ];
}

/**
 * SQL predicate fragment helpers — trusted column expressions only.
 * Callers must never interpolate user input into these.
 */

/** "Value is present" — includes zero. Use instead of `col <> 0`. */
export function sqlPresentIncludingZero(columnSql: string): string {
  return `${columnSql} IS NOT NULL`;
}

/**
 * Catalog / PE current-cycle FY expression over program_element_year alias `y`
 * (or bare columns when alias is ''). Mirrors currentCycleFyPreservingZero.
 */
export function sqlCurrentCycleFyExpr(alias = 'y'): string {
  const p = alias ? `${alias}.` : '';
  return `COALESCE(
    MAX(${p}fy) FILTER (WHERE ${p}hasc_mark IS NOT NULL OR ${p}sasc_mark IS NOT NULL
      OR ${p}hac_d_mark IS NOT NULL OR ${p}sac_d_mark IS NOT NULL OR ${p}conference IS NOT NULL),
    MAX(${p}fy) FILTER (WHERE ${p}request IS NOT NULL)
  )`;
}
