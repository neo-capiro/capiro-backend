/**
 * rdte-column-role-v1 — RDT&E-specific column role, exhibit role, value
 * disposition, and coverage vocabulary.
 *
 * This module is pure: no NestJS, Prisma, AWS, parser, or writer dependency.
 * It is the shared vocabulary that every RDT&E semantic extractor and the
 * cycle reconciler use to classify printed money/quantity columns truthfully.
 *
 * Governing rules (Phase 4 plan §6, §21):
 *   - contextual/historical and nonannual columns are never canonical stages;
 *   - only `budget_year_request` may become `canonical_request_candidate`;
 *   - outyear values are FYDP positions tied to the printing PB cycle;
 *   - cost-to-complete/total-cost are never annual funding.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Exhibit roles                                                       */
/* ------------------------------------------------------------------ */

export const RDTE_EXHIBIT_ROLE_V1_VALUES = [
  'r1_catalog',
  'r2_pe_summary',
  'r2a_project_detail',
  'r3_cost_analysis',
  'r4_schedule',
] as const;
export const rdteExhibitRoleV1Schema = z.enum(RDTE_EXHIBIT_ROLE_V1_VALUES);
export type RdteExhibitRoleV1 = z.infer<typeof rdteExhibitRoleV1Schema>;

/* ------------------------------------------------------------------ */
/* Column roles                                                        */
/* ------------------------------------------------------------------ */

export const RDTE_COLUMN_ROLE_V1_VALUES = [
  'prior_actual_context',
  'current_enacted_context',
  'budget_year_request',
  'outyear_projection',
  'base_component',
  'oco_component',
  'total_component',
  'cost_to_complete',
  'total_cost',
  'quantity',
  'unknown',
] as const;
export const rdteColumnRoleV1Schema = z.enum(RDTE_COLUMN_ROLE_V1_VALUES);
export type RdteColumnRoleV1 = z.infer<typeof rdteColumnRoleV1Schema>;

/* ------------------------------------------------------------------ */
/* Value dispositions                                                  */
/* ------------------------------------------------------------------ */

export const RDTE_VALUE_DISPOSITION_V1_VALUES = [
  'canonical_request_candidate',
  'pe_budget_position',
  'project_budget_position',
  'contextual_only',
  'non_annual_cost',
  'omitted',
] as const;
export const rdteValueDispositionV1Schema = z.enum(RDTE_VALUE_DISPOSITION_V1_VALUES);
export type RdteValueDispositionV1 = z.infer<typeof rdteValueDispositionV1Schema>;

/* ------------------------------------------------------------------ */
/* Coverage status                                                     */
/* ------------------------------------------------------------------ */

export const RDTE_COVERAGE_STATUS_V1_VALUES = [
  'verified',
  'needs_review',
  'rejected',
  'missing',
  'not_applicable',
] as const;
export const rdteCoverageStatusV1Schema = z.enum(RDTE_COVERAGE_STATUS_V1_VALUES);
export type RdteCoverageStatusV1 = z.infer<typeof rdteCoverageStatusV1Schema>;

/* ------------------------------------------------------------------ */
/* Role → disposition policy (single source of truth)                  */
/* ------------------------------------------------------------------ */

/**
 * The ONLY dispositions a column role may carry for a year-bearing annual
 * value. `unknown` and `quantity` have no money disposition mapping here —
 * quantity is not money and `unknown` must route to omission/review, never
 * a silent disposition.
 */
export const RDTE_ROLE_ALLOWED_DISPOSITIONS: Readonly<
  Record<RdteColumnRoleV1, readonly RdteValueDispositionV1[]>
> = {
  prior_actual_context: ['contextual_only'],
  current_enacted_context: ['contextual_only'],
  budget_year_request: ['canonical_request_candidate'],
  outyear_projection: ['pe_budget_position', 'project_budget_position'],
  base_component: ['contextual_only'],
  oco_component: ['contextual_only'],
  total_component: ['contextual_only'],
  cost_to_complete: ['non_annual_cost'],
  total_cost: ['non_annual_cost'],
  quantity: [],
  unknown: [],
};

/** True when the disposition is lawful for the column role. */
export function isDispositionAllowedForRole(
  role: RdteColumnRoleV1,
  disposition: RdteValueDispositionV1,
): boolean {
  return RDTE_ROLE_ALLOWED_DISPOSITIONS[role].includes(disposition);
}

/** True when the role represents a year-bearing annual funding value. */
export function isAnnualFundingRole(role: RdteColumnRoleV1): boolean {
  return role === 'budget_year_request' || role === 'outyear_projection';
}

/** True when the role is historical/contextual and must never be canonical. */
export function isContextualRole(role: RdteColumnRoleV1): boolean {
  return (
    role === 'prior_actual_context' ||
    role === 'current_enacted_context' ||
    role === 'base_component' ||
    role === 'oco_component' ||
    role === 'total_component'
  );
}

/** True when the role is a non-annual cost aggregate. */
export function isNonAnnualCostRole(role: RdteColumnRoleV1): boolean {
  return role === 'cost_to_complete' || role === 'total_cost';
}
