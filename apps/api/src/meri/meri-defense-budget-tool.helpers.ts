/**
 * Model-facing PE / procurement budget-line helpers for Meri tools (Phase 7 / J).
 *
 * Classification comes from @capiro/shared so API Meri tools and Workspace cannot
 * disagree. Funding claims use the Phase G FundingClaim contract
 * (@capiro/shared/funding-claim) — value/fiscalYear/legislativeVehicle etc.
 */
import {
  currentCycleFyOf,
  defenseBudgetExhibitLabel,
  isProcurementBudgetLine,
  isRdteBudgetLine,
  peSourceCoverageModelCaveat,
  type DefenseBudgetLineIdentity,
  type FundingStageValues,
  type FundingYearMarks,
  currentFunding,
} from '@capiro/shared';
import {
  buildFundingClaim,
  claimFromLadderPick,
  fundingStageToClaimStage,
  type FundingClaim,
  type FundingClaimStage,
} from '@capiro/shared/funding-claim';

export type ModelBudgetIdentifierKind = 'pe' | 'procurement_line_item' | 'other';

export interface ModelBudgetLineMetadata {
  identifierKind: ModelBudgetIdentifierKind;
  budgetExhibitType: string;
}

/**
 * Model-facing line identity. Classification is delegated to @capiro/shared so
 * the search, detail, timeline, and Workspace surfaces cannot disagree.
 */
export function modelBudgetLineMetadata(
  input: DefenseBudgetLineIdentity,
): ModelBudgetLineMetadata {
  if (isRdteBudgetLine(input)) {
    return {
      identifierKind: 'pe',
      budgetExhibitType: defenseBudgetExhibitLabel(input),
    };
  }
  if (isProcurementBudgetLine(input)) {
    return {
      identifierKind: 'procurement_line_item',
      budgetExhibitType: defenseBudgetExhibitLabel(input),
    };
  }
  return {
    identifierKind: 'other',
    budgetExhibitType: defenseBudgetExhibitLabel(input),
  };
}

function finiteNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteFy(value: unknown): number | null {
  const parsed = finiteNumber(value);
  return parsed != null && Number.isInteger(parsed) ? parsed : null;
}

export interface ModelFundingYearLike {
  fy: unknown;
  request?: unknown;
  hascMark?: unknown;
  sascMark?: unknown;
  hacDMark?: unknown;
  sacDMark?: unknown;
  conference?: unknown;
  enacted?: unknown;
}

export interface SearchFundingClaimInput {
  valueM: unknown;
  fy: unknown;
  stage: unknown;
}

function normalizeSearchStage(stage: unknown): FundingClaimStage | null {
  if (typeof stage !== 'string') return null;
  const mapped = fundingStageToClaimStage(stage.toLowerCase());
  return mapped === 'none' ? null : mapped;
}

/**
 * Finder rows do not carry the catalog's reliable current-cycle FY. Return a
 * shared FundingClaim with cycleClass='unknown' rather than guessing that the
 * latest row is the current request or an outyear.
 */
export function searchFundingClaimForModel(input: SearchFundingClaimInput): FundingClaim | null {
  const valueM = finiteNumber(input.valueM);
  const fy = finiteFy(input.fy);
  const stage = normalizeSearchStage(input.stage);
  if (valueM == null || fy == null || stage == null) return null;
  return buildFundingClaim({
    value: valueM,
    fiscalYear: fy,
    stage,
    currentCycleFy: null,
  });
}

export interface FundingClaimsForModel<T extends ModelFundingYearLike> {
  currentCycleFy: number | null;
  currentFundingClaim: FundingClaim | null;
  years: Array<T & { fundingClaim: FundingClaim | null }>;
}

function stageValues(row: ModelFundingYearLike): FundingStageValues {
  return {
    request: finiteNumber(row.request),
    hascMark: finiteNumber(row.hascMark),
    sascMark: finiteNumber(row.sascMark),
    hacDMark: finiteNumber(row.hacDMark),
    sacDMark: finiteNumber(row.sacDMark),
    conference: finiteNumber(row.conference),
    enacted: finiteNumber(row.enacted),
  };
}

/**
 * Attach one fully labeled FundingClaim to every FY. The current cycle is
 * recomputed from the line's own rows when the caller does not provide it.
 * Zero survives; malformed values become null instead of NaN.
 */
export function fundingClaimsForModel<T extends ModelFundingYearLike>(
  rows: readonly T[],
  suppliedCurrentCycleFy?: number | null,
): FundingClaimsForModel<T> {
  const marks: FundingYearMarks[] = rows.flatMap((row) => {
    const fy = finiteFy(row.fy);
    if (fy == null) return [];
    const values = stageValues(row);
    return [{ fy, ...values }];
  });
  const currentCycleFy =
    suppliedCurrentCycleFy === undefined
      ? currentCycleFyOf(marks)
      : finiteFy(suppliedCurrentCycleFy);
  const years = rows.map((row) => {
    const fy = finiteFy(row.fy);
    if (fy == null) {
      return { ...row, fundingClaim: null };
    }
    const pick = currentFunding(stageValues(row));
    return {
      ...row,
      fundingClaim: claimFromLadderPick({
        value: pick.value,
        stage: pick.stage,
        fiscalYear: fy,
        currentCycleFy,
      }),
    };
  });
  const currentFundingClaim =
    years.find((row) => row.fundingClaim?.cycleClass === 'current')?.fundingClaim ?? null;
  return { currentCycleFy, currentFundingClaim, years };
}

/** Honest negative assertion for the report-language tool. */
export function noReportLanguageCoverageNote(): string {
  return (
    "No committee report language is linked to this budget line in Capiro's loaded source " +
    'coverage. Do not infer why a mark changed. This is not proof that no language exists ' +
    'outside the loaded source set. ' +
    peSourceCoverageModelCaveat()
  );
}

export interface ReportLanguageMatchLike {
  matchScope?: unknown;
}

/**
 * Preserve the backend's program-level attribution boundary in the model-facing
 * note. Exact provisions remain in the payload; this note only explains scope.
 */
export function reportLanguageNoteForModel(
  provisions: readonly ReportLanguageMatchLike[],
): string | undefined {
  if (provisions.length === 0) return noReportLanguageCoverageNote();
  const programLevel = provisions.filter((p) => p.matchScope === 'program_level').length;
  if (programLevel === 0) return undefined;
  return (
    `${programLevel} of ${provisions.length} linked provision(s) are PROGRAM-LEVEL matches ` +
    '(matched via a program alias, because FY committee reports name programs, not PE codes). ' +
    'They may apply to sibling PEs in the same program — attribute such language at the program ' +
    'level, not exclusively to this budget line. Each carries matchScope:"program_level" and an ' +
    'attributionCaveat.'
  );
}
