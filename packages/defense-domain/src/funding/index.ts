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

export type FundingCycleClass = 'historical' | 'current' | 'outyear' | 'unknown';

export type FundingClaimLegislativeVehicle =
  | 'request'
  | 'authorization'
  | 'appropriations'
  | 'authorization_conference'
  | 'appropriations_conference'
  | 'enacted'
  | 'none';

export const FUNDING_CLAIM_STAGE_LABEL: Readonly<Record<FundingClaimStage, string>> = {
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

export const FUNDING_CLAIM_VEHICLE: Readonly<
  Record<FundingClaimStage, FundingClaimLegislativeVehicle>
> = {
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

export interface FundingClaim {
  /** USD millions. Null means absent; zero remains a real value. */
  readonly value: number | null;
  readonly fiscalYear: number | null;
  readonly stage: FundingClaimStage;
  readonly stageLabel: string;
  readonly legislativeVehicle: FundingClaimLegislativeVehicle;
  readonly cycleClass: FundingCycleClass;
  readonly isProjection: boolean;
  readonly unit: 'USD millions';
}

export type MissingMarkStatus =
  | 'present'
  | 'not_applicable'
  | 'not_started'
  | 'candidate_gap'
  | 'unknown_coverage';

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
  readonly value: number | null | undefined;
  readonly fiscalYear: number | null | undefined;
  readonly stage: FundingClaimStage;
  readonly currentCycleFy?: number | null;
}): FundingClaim {
  const value =
    input.value == null || !Number.isFinite(input.value) ? null : input.value;
  const fiscalYear = input.fiscalYear ?? null;
  const cycleClass = classifyCycleClass(fiscalYear, input.currentCycleFy ?? null);
  return {
    value,
    fiscalYear,
    stage: input.stage,
    stageLabel: FUNDING_CLAIM_STAGE_LABEL[input.stage],
    legislativeVehicle: FUNDING_CLAIM_VEHICLE[input.stage],
    cycleClass,
    isProjection: cycleClass === 'outyear',
    unit: 'USD millions',
  };
}

export function selectLatestPreservingZero<
  T extends { readonly fy: number; readonly value: number | null | undefined },
>(years: readonly T[]): T | null {
  let best: T | null = null;
  for (const year of years) {
    if (year.value == null || !Number.isFinite(year.value)) continue;
    if (best == null || year.fy > best.fy) best = year;
  }
  return best;
}

export function currentCycleFyPreservingZero(
  years: readonly {
    readonly fy: number;
    readonly request?: number | null;
    readonly hascMark?: number | null;
    readonly sascMark?: number | null;
    readonly hacDMark?: number | null;
    readonly sacDMark?: number | null;
    readonly conference?: number | null;
    readonly ndaaConference?: number | null;
  }[],
): number | null {
  const marked = years
    .filter(
      (year) =>
        year.hascMark != null ||
        year.sascMark != null ||
        year.hacDMark != null ||
        year.sacDMark != null ||
        year.conference != null ||
        year.ndaaConference != null,
    )
    .map((year) => year.fy);
  if (marked.length > 0) return Math.max(...marked);

  const requested = years.filter((year) => year.request != null).map((year) => year.fy);
  return requested.length > 0 ? Math.max(...requested) : null;
}

export function percentDeltaSameFiscalYear(input: {
  readonly value: number | null | undefined;
  readonly base: number | null | undefined;
  readonly valueFy: number | null | undefined;
  readonly baseFy: number | null | undefined;
}): number | null {
  const { value, base, valueFy, baseFy } = input;
  if (value == null || base == null || valueFy == null || baseFy == null) return null;
  if (valueFy !== baseFy || !Number.isFinite(value) || !Number.isFinite(base) || base === 0) {
    return null;
  }
  return ((value - base) / base) * 100;
}

function moneyTrack(
  vehicle: FundingClaimLegislativeVehicle,
): 'authorization' | 'appropriations' | 'request' | 'none' {
  if (vehicle === 'authorization' || vehicle === 'authorization_conference') {
    return 'authorization';
  }
  if (
    vehicle === 'appropriations' ||
    vehicle === 'appropriations_conference' ||
    vehicle === 'enacted'
  ) {
    return 'appropriations';
  }
  if (vehicle === 'request') return 'request';
  return 'none';
}

export function canCompareClaimsForPct(a: FundingClaim, b: FundingClaim): boolean {
  if (
    a.value == null ||
    b.value == null ||
    a.fiscalYear == null ||
    a.fiscalYear !== b.fiscalYear
  ) {
    return false;
  }
  const aTrack = moneyTrack(a.legislativeVehicle);
  const bTrack = moneyTrack(b.legislativeVehicle);
  if (aTrack === 'none' || bTrack === 'none') return false;
  return aTrack === 'request' || bTrack === 'request' || aTrack === bTrack;
}
