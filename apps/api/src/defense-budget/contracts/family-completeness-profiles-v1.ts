/**
 * Phase 5 family completeness profiles for non-RDT&E budget exhibits.
 *
 * Each profile declares the required data categories, expected identity kinds,
 * and completeness rules for one exhibit family. The manifest references these
 * profiles so a cycle can certify that every required document, identity
 * category, and comparison source is present.
 *
 * Pure data module. No runtime side effects.
 */
import { z } from 'zod';
import {
  budgetLineKindV1Schema,
  requiredDataCategoryV1Schema,
} from './budget-cycle-manifest-v1.js';

/* ------------------------------------------------------------------ */
/* Summary/detail role vocabulary                                       */
/* ------------------------------------------------------------------ */

export const SUMMARY_DETAIL_ROLE_V1_VALUES = [
  'summary',
  'detail',
  'standalone',
] as const;
export const summaryDetailRoleV1Schema = z.enum(SUMMARY_DETAIL_ROLE_V1_VALUES);
export type SummaryDetailRoleV1 = z.infer<typeof summaryDetailRoleV1Schema>;

/* ------------------------------------------------------------------ */
/* Procurement advance/base designation                                  */
/* ------------------------------------------------------------------ */

export const PROCUREMENT_BASE_ADVANCE_V1_VALUES = [
  'base',
  'advance',
  'both',
] as const;
export const procurementBaseAdvanceV1Schema = z.enum(PROCUREMENT_BASE_ADVANCE_V1_VALUES);
export type ProcurementBaseAdvanceV1 = z.infer<typeof procurementBaseAdvanceV1Schema>;

/* ------------------------------------------------------------------ */
/* Family completeness profile schema                                    */
/* ------------------------------------------------------------------ */

const nonBlankString = z
  .string()
  .min(1)
  .refine((s) => s.trim().length > 0, { message: 'must be nonblank' });

/**
 * A family completeness profile declares what a manifest document must
 * contain for the cycle to certify that exhibit family.
 *
 * Profiles are exhibit-specific. They are referenced by exhibit type and
 * enforced by the manifest semantic validator.
 */
export const familyCompletenessProfileV1Schema = z
  .object({
    exhibit: z.enum([
      'P-1',
      'P-40',
      'P-5',
      'P-5A',
      'P-21',
      'P-3A',
      'O-1',
      'OP-5',
      'C-1',
      'DD1391',
    ]),
    family: z.enum(['procurement', 'om', 'milcon']),
    expectedLineKind: budgetLineKindV1Schema,
    summaryDetailRole: summaryDetailRoleV1Schema,
    requiredDataCategories: z.array(requiredDataCategoryV1Schema).min(1),
    /** Documents that must be present for this exhibit's family to certify. */
    requiredComparisonDocuments: z.array(nonBlankString).optional(),
    /** Account/appropriation identity is required for this exhibit. */
    requiresAccount: z.boolean(),
    /** Component/service is required for this exhibit. */
    requiresComponent: z.boolean(),
    /** Base vs advance procurement designation is required (procurement only). */
    requiresBaseAdvanceDesignation: z.boolean().optional(),
    /** Expected BA/BAG/SAG hierarchy depth (O&M only). */
    expectedHierarchyDepth: z
      .enum(['budget_activity', 'activity_group', 'subactivity_group'])
      .optional(),
    /** Expected project-number namespace (MILCON only). */
    requiresProjectNumber: z.boolean().optional(),
    /** Required quantity categories. */
    requiredQuantityCategories: z.array(nonBlankString).optional(),
    /** Required unit-cost categories. */
    requiredUnitCostCategories: z.array(nonBlankString).optional(),
    /** Required narrative sections. */
    requiredNarrativeSections: z.array(nonBlankString).optional(),
    /** Authoritative comparison document keys (summary ↔ detail). */
    authoritativeComparisonKeys: z.array(nonBlankString).optional(),
    /** When true, a missing document of this exhibit blocks cycle certification. */
    blocksCycleWhenMissing: z.boolean(),
  })
  .strict();
export type FamilyCompletenessProfileV1 = z.infer<typeof familyCompletenessProfileV1Schema>;

/* ------------------------------------------------------------------ */
/* Built-in profiles for Phase 5 exhibits                               */
/* ------------------------------------------------------------------ */

export const PHASE_5_FAMILY_PROFILES: readonly FamilyCompletenessProfileV1[] = [
  {
    exhibit: 'P-1',
    family: 'procurement',
    expectedLineKind: 'PROCUREMENT_BLIN',
    summaryDetailRole: 'summary',
    requiredDataCategories: ['identity', 'funding', 'procurement_lines', 'quantities'],
    requiresAccount: true,
    requiresComponent: true,
    requiresBaseAdvanceDesignation: true,
    requiredQuantityCategories: ['procurement_quantity'],
    authoritativeComparisonKeys: ['P-40'],
    blocksCycleWhenMissing: true,
  },
  {
    exhibit: 'P-40',
    family: 'procurement',
    expectedLineKind: 'PROCUREMENT_BLIN',
    summaryDetailRole: 'detail',
    requiredDataCategories: [
      'identity',
      'funding',
      'procurement_lines',
      'quantities',
      'unit_cost',
      'narrative',
    ],
    requiresAccount: true,
    requiresComponent: true,
    requiresBaseAdvanceDesignation: true,
    requiredQuantityCategories: ['procurement_quantity'],
    requiredUnitCostCategories: ['gross_weapon_system_unit_cost'],
    requiredNarrativeSections: ['item_description', 'program_status', 'justification'],
    authoritativeComparisonKeys: ['P-1'],
    blocksCycleWhenMissing: true,
  },
  {
    exhibit: 'P-5',
    family: 'procurement',
    expectedLineKind: 'PROCUREMENT_BLIN',
    summaryDetailRole: 'detail',
    requiredDataCategories: ['identity', 'funding', 'quantities', 'unit_cost'],
    requiresAccount: true,
    requiresComponent: true,
    requiresBaseAdvanceDesignation: false,
    requiredUnitCostCategories: ['recurring_cost', 'nonrecurring_cost'],
    authoritativeComparisonKeys: ['P-40'],
    blocksCycleWhenMissing: false,
  },
  {
    exhibit: 'P-5A',
    family: 'procurement',
    expectedLineKind: 'PROCUREMENT_BLIN',
    summaryDetailRole: 'detail',
    requiredDataCategories: ['identity', 'funding', 'quantities'],
    requiresAccount: true,
    requiresComponent: true,
    requiresBaseAdvanceDesignation: false,
    authoritativeComparisonKeys: ['P-40'],
    blocksCycleWhenMissing: false,
  },
  {
    exhibit: 'P-21',
    family: 'procurement',
    expectedLineKind: 'PROCUREMENT_BLIN',
    summaryDetailRole: 'detail',
    requiredDataCategories: ['identity', 'quantities', 'milestones'],
    requiresAccount: true,
    requiresComponent: true,
    requiresBaseAdvanceDesignation: false,
    requiredNarrativeSections: ['production_schedule', 'delivery_schedule'],
    authoritativeComparisonKeys: ['P-40'],
    blocksCycleWhenMissing: false,
  },
  {
    exhibit: 'P-3A',
    family: 'procurement',
    expectedLineKind: 'PROCUREMENT_BLIN',
    summaryDetailRole: 'detail',
    requiredDataCategories: ['identity', 'narrative', 'relationships'],
    requiresAccount: true,
    requiresComponent: true,
    requiresBaseAdvanceDesignation: false,
    requiredNarrativeSections: ['modification_description'],
    authoritativeComparisonKeys: ['P-40'],
    blocksCycleWhenMissing: false,
  },
  {
    exhibit: 'O-1',
    family: 'om',
    expectedLineKind: 'OM_SAG',
    summaryDetailRole: 'summary',
    requiredDataCategories: ['identity', 'funding', 'om_lines'],
    requiresAccount: true,
    requiresComponent: true,
    expectedHierarchyDepth: 'subactivity_group',
    authoritativeComparisonKeys: ['OP-5'],
    blocksCycleWhenMissing: true,
  },
  {
    exhibit: 'OP-5',
    family: 'om',
    expectedLineKind: 'OM_SAG',
    summaryDetailRole: 'detail',
    requiredDataCategories: ['identity', 'funding', 'narrative', 'om_lines'],
    requiresAccount: true,
    requiresComponent: true,
    expectedHierarchyDepth: 'subactivity_group',
    requiredNarrativeSections: ['mission', 'budget_justification'],
    authoritativeComparisonKeys: ['O-1'],
    blocksCycleWhenMissing: true,
  },
  {
    exhibit: 'C-1',
    family: 'milcon',
    expectedLineKind: 'MILCON_PROJECT',
    summaryDetailRole: 'summary',
    requiredDataCategories: ['identity', 'funding', 'milcon_projects'],
    requiresAccount: true,
    requiresComponent: true,
    requiresProjectNumber: true,
    authoritativeComparisonKeys: ['DD1391'],
    blocksCycleWhenMissing: true,
  },
  {
    exhibit: 'DD1391',
    family: 'milcon',
    expectedLineKind: 'MILCON_PROJECT',
    summaryDetailRole: 'detail',
    requiredDataCategories: [
      'identity',
      'funding',
      'milcon_projects',
      'narrative',
      'milestones',
    ],
    requiresAccount: true,
    requiresComponent: true,
    requiresProjectNumber: true,
    requiredNarrativeSections: [
      'requirement',
      'current_situation',
      'impact_if_not_provided',
      'project_scope',
    ],
    authoritativeComparisonKeys: ['C-1'],
    blocksCycleWhenMissing: true,
  },
];

/* ------------------------------------------------------------------ */
/* Profile lookup                                                       */
/* ------------------------------------------------------------------ */

const PROFILE_BY_EXHIBIT = new Map<string, FamilyCompletenessProfileV1>(
  PHASE_5_FAMILY_PROFILES.map((p) => [p.exhibit, p]),
);

/** Get the built-in profile for an exhibit type, or undefined. */
export function getFamilyProfile(exhibit: string): FamilyCompletenessProfileV1 | undefined {
  return PROFILE_BY_EXHIBIT.get(exhibit);
}

/**
 * Gap matrix: maps every required Phase 5 fact to its representation route
 * in the V1 contract. Used to verify that no required fact is unrepresentable.
 *
 * Each entry declares:
 *   - the fact name
 *   - the V1 assertion kind or source-fact category that represents it
 *   - the V1 field that carries it
 *   - the omission route when the fact is missing
 */
export interface Phase5GapMatrixEntry {
  factName: string;
  family: 'procurement' | 'om' | 'milcon';
  representationKind:
    | 'assertion'
    | 'source_fact'
    | 'metadata'
    | 'omission';
  v1AssertionKind?: string;
  v1Field?: string;
  omissionReason: string;
}

export const PHASE_5_GAP_MATRIX: readonly Phase5GapMatrixEntry[] = [
  // Procurement identity
  {
    factName: 'procurement_blin_code',
    family: 'procurement',
    representationKind: 'assertion',
    v1AssertionKind: 'procurement_line',
    v1Field: 'parentIdentity.code',
    omissionReason: 'invalid_identity',
  },
  {
    factName: 'procurement_account',
    family: 'procurement',
    representationKind: 'assertion',
    v1AssertionKind: 'procurement_line',
    v1Field: 'parentIdentity.account',
    omissionReason: 'invalid_identity',
  },
  {
    factName: 'procurement_component',
    family: 'procurement',
    representationKind: 'assertion',
    v1AssertionKind: 'procurement_line',
    v1Field: 'parentIdentity.component',
    omissionReason: 'invalid_identity',
  },
  {
    factName: 'procurement_base_advance',
    family: 'procurement',
    representationKind: 'assertion',
    v1AssertionKind: 'procurement_line',
    v1Field: 'parentIdentity.advanceProcurement',
    omissionReason: 'missing_value',
  },
  {
    factName: 'procurement_funding',
    family: 'procurement',
    representationKind: 'assertion',
    v1AssertionKind: 'funding',
    v1Field: 'money',
    omissionReason: 'missing_value',
  },
  {
    factName: 'procurement_quantity',
    family: 'procurement',
    representationKind: 'assertion',
    v1AssertionKind: 'quantity',
    v1Field: 'quantity',
    omissionReason: 'missing_value',
  },
  {
    factName: 'procurement_unit_cost',
    family: 'procurement',
    representationKind: 'assertion',
    v1AssertionKind: 'unit_cost',
    v1Field: 'unitCostDollars',
    omissionReason: 'missing_value',
  },
  {
    factName: 'procurement_narrative',
    family: 'procurement',
    representationKind: 'assertion',
    v1AssertionKind: 'narrative',
    v1Field: 'text',
    omissionReason: 'missing_value',
  },
  {
    factName: 'procurement_pe_reference',
    family: 'procurement',
    representationKind: 'assertion',
    v1AssertionKind: 'relationship',
    v1Field: 'to',
    omissionReason: 'missing_value',
  },
  // O&M identity
  {
    factName: 'om_sag_code',
    family: 'om',
    representationKind: 'assertion',
    v1AssertionKind: 'om_line',
    v1Field: 'identity.code',
    omissionReason: 'invalid_identity',
  },
  {
    factName: 'om_account',
    family: 'om',
    representationKind: 'assertion',
    v1AssertionKind: 'om_line',
    v1Field: 'identity.account',
    omissionReason: 'invalid_identity',
  },
  {
    factName: 'om_hierarchy',
    family: 'om',
    representationKind: 'assertion',
    v1AssertionKind: 'om_line',
    v1Field: 'budgetActivity/activityGroup/subActivityGroup',
    omissionReason: 'missing_value',
  },
  {
    factName: 'om_funding',
    family: 'om',
    representationKind: 'assertion',
    v1AssertionKind: 'funding',
    v1Field: 'money',
    omissionReason: 'missing_value',
  },
  {
    factName: 'om_narrative',
    family: 'om',
    representationKind: 'assertion',
    v1AssertionKind: 'narrative',
    v1Field: 'text',
    omissionReason: 'missing_value',
  },
  // MILCON identity
  {
    factName: 'milcon_project_number',
    family: 'milcon',
    representationKind: 'assertion',
    v1AssertionKind: 'milcon_project',
    v1Field: 'identity.projectCode',
    omissionReason: 'invalid_identity',
  },
  {
    factName: 'milcon_component',
    family: 'milcon',
    representationKind: 'assertion',
    v1AssertionKind: 'milcon_project',
    v1Field: 'identity.component',
    omissionReason: 'invalid_identity',
  },
  {
    factName: 'milcon_location',
    family: 'milcon',
    representationKind: 'assertion',
    v1AssertionKind: 'milcon_project',
    v1Field: 'identity.location',
    omissionReason: 'missing_value',
  },
  {
    factName: 'milcon_authorization_amount',
    family: 'milcon',
    representationKind: 'assertion',
    v1AssertionKind: 'milcon_project',
    v1Field: 'authorizationAmount',
    omissionReason: 'missing_value',
  },
  {
    factName: 'milcon_appropriation_amount',
    family: 'milcon',
    representationKind: 'assertion',
    v1AssertionKind: 'milcon_project',
    v1Field: 'appropriationAmount',
    omissionReason: 'missing_value',
  },
  {
    factName: 'milcon_request_amount',
    family: 'milcon',
    representationKind: 'assertion',
    v1AssertionKind: 'funding',
    v1Field: 'money',
    omissionReason: 'missing_value',
  },
  {
    factName: 'milcon_scope',
    family: 'milcon',
    representationKind: 'assertion',
    v1AssertionKind: 'milcon_project',
    v1Field: 'scope',
    omissionReason: 'missing_value',
  },
  {
    factName: 'milcon_narrative',
    family: 'milcon',
    representationKind: 'assertion',
    v1AssertionKind: 'narrative',
    v1Field: 'text',
    omissionReason: 'missing_value',
  },
  {
    factName: 'milcon_schedule',
    family: 'milcon',
    representationKind: 'assertion',
    v1AssertionKind: 'milestone',
    v1Field: 'plannedDate',
    omissionReason: 'missing_value',
  },
];
