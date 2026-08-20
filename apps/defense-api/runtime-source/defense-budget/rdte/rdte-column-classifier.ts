/**
 * rdte-column-classifier — classify a normalized header column into an
 * RDT&E column role given the cycle fiscal year.
 *
 * Pure module. Uses rdte-header-normalizer output only; never guesses.
 */
import type { NormalizedHeaderColumnV1 } from './rdte-header-normalizer.js';
import type { RdteColumnRoleV1 } from './rdte-column-role-v1.js';

export interface ColumnClassification {
  role: RdteColumnRoleV1;
  fiscalYear?: number;
  /** True when the classification is certain from explicit labels. */
  confident: boolean;
  /** Human-readable reason for audit. */
  reason: string;
}

/**
 * Classify one normalized header column.
 *
 * Mapping (Phase 4 plan §7):
 *   FY2025 Actual        → prior_actual_context
 *   FY2026 Enacted       → current_enacted_context
 *   FY2027 Request       → budget_year_request
 *   FY2028               → outyear_projection when printed in FY2027 PB
 *   Cost to Complete     → cost_to_complete
 *   Total Cost           → total_cost
 *   FY2027 Base          → base_component
 *   FY2027 OCO           → oco_component
 *   FY2027 Total         → total_component
 */
export function classifyRdteColumn(input: {
  column: NormalizedHeaderColumnV1;
  cycleFiscalYear: number;
}): ColumnClassification {
  const { column, cycleFiscalYear } = input;

  /* Non-annual cost columns. */
  if (column.fiscalLabelKind === 'cost_to_complete') {
    return {
      role: 'cost_to_complete',
      confident: true,
      reason: 'explicit cost-to-complete label',
    };
  }
  if (column.fiscalLabelKind === 'total_cost') {
    return {
      role: 'total_cost',
      confident: true,
      reason: 'explicit total-cost label',
    };
  }
  if (column.fiscalLabelKind === 'quantity') {
    return {
      role: 'quantity',
      confident: true,
      reason: 'explicit quantity label',
    };
  }

  /* Component columns take precedence over stage when both are present. */
  if (column.componentLabel === 'base') {
    return {
      role: 'base_component',
      fiscalYear: column.explicitFiscalYear,
      confident: column.explicitFiscalYear != null,
      reason: 'explicit base component label',
    };
  }
  if (column.componentLabel === 'oco') {
    return {
      role: 'oco_component',
      fiscalYear: column.explicitFiscalYear,
      confident: column.explicitFiscalYear != null,
      reason: 'explicit OCO component label',
    };
  }
  if (column.componentLabel === 'total' && column.fiscalLabelKind !== 'unlabeled') {
    return {
      role: 'total_component',
      fiscalYear: column.explicitFiscalYear,
      confident: column.explicitFiscalYear != null,
      reason: 'explicit total component label with fiscal year',
    };
  }

  /* Stage-driven classification. */
  const fy = column.explicitFiscalYear;
  if (fy == null) {
    return {
      role: 'unknown',
      confident: false,
      reason: 'no fiscal year label available',
    };
  }

  if (column.stageLabel === 'actual') {
    return {
      role: 'prior_actual_context',
      fiscalYear: fy,
      confident: true,
      reason: 'explicit actual label',
    };
  }
  if (column.stageLabel === 'enacted') {
    return {
      role: 'current_enacted_context',
      fiscalYear: fy,
      confident: true,
      reason: 'explicit enacted label',
    };
  }
  if (column.stageLabel === 'request') {
    if (fy === cycleFiscalYear) {
      return {
        role: 'budget_year_request',
        fiscalYear: fy,
        confident: true,
        reason: 'explicit request label for cycle fiscal year',
      };
    }
    return {
      role: 'outyear_projection',
      fiscalYear: fy,
      confident: true,
      reason: 'request label for non-cycle fiscal year is an outyear projection',
    };
  }
  if (column.stageLabel === 'projection') {
    return {
      role: 'outyear_projection',
      fiscalYear: fy,
      confident: true,
      reason: 'explicit projection/outyear label',
    };
  }

  /* No stage label: infer from fiscal year relative to cycle FY. */
  if (fy < cycleFiscalYear - 1) {
    return {
      role: 'prior_actual_context',
      fiscalYear: fy,
      confident: false,
      reason: 'fiscal year well before cycle FY without explicit stage label',
    };
  }
  if (fy === cycleFiscalYear - 1) {
    return {
      role: 'prior_actual_context',
      fiscalYear: fy,
      confident: false,
      reason: 'prior fiscal year without explicit stage label',
    };
  }
  if (fy === cycleFiscalYear) {
    return {
      role: 'budget_year_request',
      fiscalYear: fy,
      confident: false,
      reason: 'cycle fiscal year without explicit stage label',
    };
  }
  // fy > cycleFiscalYear
  return {
    role: 'outyear_projection',
    fiscalYear: fy,
    confident: false,
    reason: 'fiscal year after cycle FY without explicit stage label',
  };
}

/**
 * Classify every column in a normalized header.
 */
export function classifyRdteHeader(input: {
  columns: readonly NormalizedHeaderColumnV1[];
  cycleFiscalYear: number;
}): ColumnClassification[] {
  return input.columns.map((column) =>
    classifyRdteColumn({ column, cycleFiscalYear: input.cycleFiscalYear }),
  );
}
