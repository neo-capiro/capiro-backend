/**
 * Default policy registry for defense_budget_verification_policy_v1.
 *
 * Creates policies for currently supported Phase 1 artifact families:
 *   - R-1, R-2, R-2A, R-3
 *   - committee reports: HASC, SASC, HAC-D, SAC-D, NDAA conference,
 *     appropriations conference, public law
 *   - P-doc/procurement
 *
 * For O&M and MILCON contracts that Phase 1 can represent but does not yet
 * have complete adapters for:
 *   - policy must not pretend support
 *   - return NEEDS_REVIEW or REJECTED according to manifest requirements
 *   - record an explicit `verification_policy_not_implemented` finding
 */
import type { BudgetFamilyV1, ExhibitV1, FundingFieldV1 } from '../contracts/extraction-artifact-v1.js';
import type { RequiredDataCategoryV1 } from '../contracts/budget-cycle-manifest-v1.js';
import type { VerificationPolicyV1 } from './verification-policy-v1.js';
import { DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION } from './verification-contract-v1.js';

/* ------------------------------------------------------------------ */
/* Shared defaults                                                     */
/* ------------------------------------------------------------------ */

const COMMON_RISK_THRESHOLDS = {
  automaticPassMax: 10,
  targetedReextractionMax: 30,
  paidVerifierMax: 60,
};

const HIGH_MATERIALITY_THRESHOLD_MILLIONS = '1000';

/* ------------------------------------------------------------------ */
/* R-1 policy (RDT&E PB Exhibit)                                       */
/* ------------------------------------------------------------------ */

const R1_POLICY: VerificationPolicyV1 = {
  policyVersion: DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
  family: 'rdte',
  exhibit: 'R-1',
  requiredDataCategories: ['identity', 'funding', 'narrative', 'projects', 'project_funding', 'performers'],
  requiredFundingFields: ['request'],
  requiredLineKinds: ['RDTE_PE'],
  allowedParserMethods: ['native_structured', 'deterministic_pdfplumber', 'camelot', 'docling', 'llamaparse'],
  minimumMoneyEvidenceGranularity: 'cell_bbox',
  pageOnlyMayPassWithIndependentReconciliation: true,
  requireImmutableArchive: true,
  requireParserRunProof: true,
  requiredComparisonRules: ['rdte_summary_detail'],
  reviewComparisonRules: ['historical_consistency'],
  arithmeticRules: ['rdte_summary_detail', 'project_rollup'],
  manualAlwaysReview: true,
  ocrMoneyAlwaysReview: true,
  congressionalMoneyAlwaysReviewWhenUncorroborated: true,
  enactedAlwaysReviewWhenUncorroborated: true,
  highMaterialityThresholdMillions: HIGH_MATERIALITY_THRESHOLD_MILLIONS,
  riskThresholds: COMMON_RISK_THRESHOLDS,
};

/* ------------------------------------------------------------------ */
/* R-2 policy (RDT&E Exhibit)                                          */
/* ------------------------------------------------------------------ */

const R2_POLICY: VerificationPolicyV1 = {
  policyVersion: DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
  family: 'rdte',
  exhibit: 'R-2',
  requiredDataCategories: ['identity', 'funding', 'narrative', 'projects'],
  requiredFundingFields: ['request'],
  requiredLineKinds: ['RDTE_PE'],
  allowedParserMethods: ['native_structured', 'deterministic_pdfplumber', 'camelot', 'docling', 'llamaparse'],
  minimumMoneyEvidenceGranularity: 'cell_bbox',
  pageOnlyMayPassWithIndependentReconciliation: true,
  requireImmutableArchive: true,
  requireParserRunProof: true,
  requiredComparisonRules: ['rdte_summary_detail'],
  reviewComparisonRules: ['historical_consistency'],
  arithmeticRules: ['rdte_summary_detail'],
  manualAlwaysReview: true,
  ocrMoneyAlwaysReview: true,
  congressionalMoneyAlwaysReviewWhenUncorroborated: true,
  enactedAlwaysReviewWhenUncorroborated: true,
  highMaterialityThresholdMillions: HIGH_MATERIALITY_THRESHOLD_MILLIONS,
  riskThresholds: COMMON_RISK_THRESHOLDS,
};

/* ------------------------------------------------------------------ */
/* R-2A policy (RDT&E Project Summary)                                */
/* ------------------------------------------------------------------ */

const R2A_POLICY: VerificationPolicyV1 = {
  policyVersion: DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
  family: 'rdte',
  exhibit: 'R-2A',
  requiredDataCategories: ['identity', 'funding', 'projects', 'project_funding', 'performers'],
  requiredFundingFields: ['request'],
  requiredLineKinds: ['RDTE_PE'],
  allowedParserMethods: ['native_structured', 'deterministic_pdfplumber', 'camelot', 'docling', 'llamaparse'],
  minimumMoneyEvidenceGranularity: 'cell_bbox',
  pageOnlyMayPassWithIndependentReconciliation: true,
  requireImmutableArchive: true,
  requireParserRunProof: true,
  requiredComparisonRules: ['project_rollup_reference'],
  reviewComparisonRules: ['historical_consistency'],
  arithmeticRules: ['project_rollup'],
  manualAlwaysReview: true,
  ocrMoneyAlwaysReview: true,
  congressionalMoneyAlwaysReviewWhenUncorroborated: true,
  enactedAlwaysReviewWhenUncorroborated: true,
  highMaterialityThresholdMillions: HIGH_MATERIALITY_THRESHOLD_MILLIONS,
  riskThresholds: COMMON_RISK_THRESHOLDS,
};

/* ------------------------------------------------------------------ */
/* R-3 policy (RDT&E Performers)                                        */
/* ------------------------------------------------------------------ */

const R3_POLICY: VerificationPolicyV1 = {
  policyVersion: DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
  family: 'rdte',
  exhibit: 'R-3',
  requiredDataCategories: ['identity', 'performers'],
  requiredFundingFields: [],
  requiredLineKinds: ['RDTE_PE'],
  allowedParserMethods: ['native_structured', 'deterministic_pdfplumber', 'camelot', 'docling', 'llamaparse'],
  minimumMoneyEvidenceGranularity: 'cell_bbox',
  pageOnlyMayPassWithIndependentReconciliation: true,
  requireImmutableArchive: true,
  requireParserRunProof: true,
  requiredComparisonRules: [],
  reviewComparisonRules: ['historical_consistency'],
  arithmeticRules: [],
  manualAlwaysReview: true,
  ocrMoneyAlwaysReview: true,
  congressionalMoneyAlwaysReviewWhenUncorroborated: true,
  enactedAlwaysReviewWhenUncorroborated: true,
  highMaterialityThresholdMillions: HIGH_MATERIALITY_THRESHOLD_MILLIONS,
  riskThresholds: COMMON_RISK_THRESHOLDS,
};

/* ------------------------------------------------------------------ */
/* Committee report policies                                           */
/* ------------------------------------------------------------------ */

function committeePolicy(
  authority: string,
  fundingFields: FundingFieldV1[],
): VerificationPolicyV1 {
  return {
    policyVersion: DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
    family: 'committee',
    exhibit: 'committee_report',
    requiredDataCategories: ['identity', 'funding', 'narrative'],
    requiredFundingFields: fundingFields,
    requiredLineKinds: ['RDTE_PE', 'PROCUREMENT_BLIN', 'OM_SAG'],
    allowedParserMethods: ['native_structured', 'deterministic_pdfplumber', 'camelot', 'docling', 'paddleocr', 'llamaparse'],
    minimumMoneyEvidenceGranularity: 'cell_bbox',
    pageOnlyMayPassWithIndependentReconciliation: true,
    requireImmutableArchive: true,
    requireParserRunProof: true,
    requiredComparisonRules: ['committee_request_reference'],
    reviewComparisonRules: ['historical_consistency'],
    arithmeticRules: ['committee_adjustment'],
    manualAlwaysReview: true,
    ocrMoneyAlwaysReview: true,
    congressionalMoneyAlwaysReviewWhenUncorroborated: true,
    enactedAlwaysReviewWhenUncorroborated: true,
    highMaterialityThresholdMillions: HIGH_MATERIALITY_THRESHOLD_MILLIONS,
    riskThresholds: COMMON_RISK_THRESHOLDS,
  };
}

const HASC_POLICY = committeePolicy('hasc', ['request', 'hascMark']);
const SASC_POLICY = committeePolicy('sasc', ['request', 'sascMark']);
const HACD_POLICY = committeePolicy('hac_d', ['request', 'hacDMark']);
const SACD_POLICY = committeePolicy('sac_d', ['request', 'sacDMark']);

const NDAA_CONFERENCE_POLICY: VerificationPolicyV1 = {
  ...committeePolicy('ndaa_conference', ['request', 'ndaaConference']),
  exhibit: 'conference_report',
};

const APPROPRIATIONS_CONFERENCE_POLICY: VerificationPolicyV1 = {
  ...committeePolicy('appropriations_conference', ['request', 'conference']),
  exhibit: 'conference_report',
};

const PUBLIC_LAW_POLICY: VerificationPolicyV1 = {
  policyVersion: DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
  family: 'public_law',
  exhibit: 'public_law',
  requiredDataCategories: ['identity', 'funding', 'narrative'],
  requiredFundingFields: ['enacted'],
  requiredLineKinds: ['RDTE_PE', 'PROCUREMENT_BLIN', 'OM_SAG', 'MILCON_PROJECT'],
  allowedParserMethods: ['native_structured', 'deterministic_pdfplumber', 'camelot', 'docling', 'paddleocr', 'llamaparse'],
  minimumMoneyEvidenceGranularity: 'cell_bbox',
  pageOnlyMayPassWithIndependentReconciliation: true,
  requireImmutableArchive: true,
  requireParserRunProof: true,
  requiredComparisonRules: ['committee_request_reference'],
  reviewComparisonRules: ['historical_consistency'],
  arithmeticRules: [],
  manualAlwaysReview: true,
  ocrMoneyAlwaysReview: true,
  congressionalMoneyAlwaysReviewWhenUncorroborated: true,
  enactedAlwaysReviewWhenUncorroborated: true,
  highMaterialityThresholdMillions: HIGH_MATERIALITY_THRESHOLD_MILLIONS,
  riskThresholds: COMMON_RISK_THRESHOLDS,
};

/* ------------------------------------------------------------------ */
/* P-doc / Procurement policy                                          */
/* ------------------------------------------------------------------ */

const PDOC_POLICY: VerificationPolicyV1 = {
  policyVersion: DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
  family: 'procurement',
  exhibit: 'P-1',
  requiredDataCategories: ['identity', 'funding', 'procurement_lines', 'quantities', 'unit_cost'],
  requiredFundingFields: ['request'],
  requiredLineKinds: ['PROCUREMENT_BLIN'],
  allowedParserMethods: ['native_structured', 'deterministic_pdfplumber', 'camelot', 'docling', 'llamaparse'],
  minimumMoneyEvidenceGranularity: 'cell_bbox',
  pageOnlyMayPassWithIndependentReconciliation: true,
  requireImmutableArchive: true,
  requireParserRunProof: true,
  requiredComparisonRules: ['procurement_summary_detail'],
  reviewComparisonRules: ['historical_consistency'],
  arithmeticRules: ['procurement_rollup'],
  manualAlwaysReview: true,
  ocrMoneyAlwaysReview: true,
  congressionalMoneyAlwaysReviewWhenUncorroborated: true,
  enactedAlwaysReviewWhenUncorroborated: true,
  highMaterialityThresholdMillions: HIGH_MATERIALITY_THRESHOLD_MILLIONS,
  riskThresholds: COMMON_RISK_THRESHOLDS,
};

/* ------------------------------------------------------------------ */
/* Unsupported families — honest "not implemented" policies           */
/* ------------------------------------------------------------------ */

function unsupportedPolicy(family: BudgetFamilyV1, exhibit: ExhibitV1): VerificationPolicyV1 {
  return {
    policyVersion: DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
    family,
    exhibit,
    requiredDataCategories: [],
    requiredFundingFields: [],
    requiredLineKinds: [],
    allowedParserMethods: [],
    minimumMoneyEvidenceGranularity: 'cell_bbox',
    pageOnlyMayPassWithIndependentReconciliation: false,
    requireImmutableArchive: true,
    requireParserRunProof: true,
    requiredComparisonRules: [],
    reviewComparisonRules: [],
    arithmeticRules: [],
    manualAlwaysReview: true,
    ocrMoneyAlwaysReview: true,
    congressionalMoneyAlwaysReviewWhenUncorroborated: true,
    enactedAlwaysReviewWhenUncorroborated: true,
    highMaterialityThresholdMillions: '0',
    riskThresholds: { automaticPassMax: 0, targetedReextractionMax: 0, paidVerifierMax: 0 },
  };
}

const OM_UNSUPPORTED = unsupportedPolicy('om', 'O-1');
const MILCON_UNSUPPORTED = unsupportedPolicy('milcon', 'C-1');

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export interface PolicyRegistryEntry {
  key: string;
  policy: VerificationPolicyV1;
  supported: boolean;
}

const REGISTRY: PolicyRegistryEntry[] = [
  { key: 'R-1', policy: R1_POLICY, supported: true },
  { key: 'R-2', policy: R2_POLICY, supported: true },
  { key: 'R-2A', policy: R2A_POLICY, supported: true },
  { key: 'R-3', policy: R3_POLICY, supported: true },
  { key: 'HASC', policy: HASC_POLICY, supported: true },
  { key: 'SASC', policy: SASC_POLICY, supported: true },
  { key: 'HAC-D', policy: HACD_POLICY, supported: true },
  { key: 'SAC-D', policy: SACD_POLICY, supported: true },
  { key: 'NDAA_CONFERENCE', policy: NDAA_CONFERENCE_POLICY, supported: true },
  { key: 'APPROPRIATIONS_CONFERENCE', policy: APPROPRIATIONS_CONFERENCE_POLICY, supported: true },
  { key: 'PUBLIC_LAW', policy: PUBLIC_LAW_POLICY, supported: true },
  { key: 'P-1', policy: PDOC_POLICY, supported: true },
  { key: 'O-1', policy: OM_UNSUPPORTED, supported: false },
  { key: 'C-1', policy: MILCON_UNSUPPORTED, supported: false },
];

/**
 * Look up a policy by exhibit key.
 * Returns `null` when no policy exists for the exhibit.
 */
export function lookupPolicyByExhibit(exhibit: ExhibitV1): VerificationPolicyV1 | null {
  const entry = REGISTRY.find((e) => e.key === exhibit);
  return entry?.policy ?? null;
}

/**
 * Look up a policy by family + exhibit.
 */
export function lookupPolicy(family: BudgetFamilyV1, exhibit: ExhibitV1): VerificationPolicyV1 | null {
  const entry = REGISTRY.find((e) => e.policy.family === family && e.policy.exhibit === exhibit);
  return entry?.policy ?? null;
}

/**
 * Check if a family+exhibit combination is supported.
 */
export function isPolicySupported(family: BudgetFamilyV1, exhibit: ExhibitV1): boolean {
  return REGISTRY.some((e) => e.policy.family === family && e.policy.exhibit === exhibit && e.supported);
}

/**
 * Get all registered policies.
 */
export function getAllPolicies(): readonly PolicyRegistryEntry[] {
  return REGISTRY;
}

/**
 * Get all supported policies.
 */
export function getSupportedPolicies(): readonly PolicyRegistryEntry[] {
  return REGISTRY.filter((e) => e.supported);
}