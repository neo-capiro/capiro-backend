/**
 * defense_budget_verification_policy_v1 — document-family verification policies.
 *
 * Policies are strict, versioned, and hashable. The same artifact, manifest,
 * verifier version, and policy must produce the same policy SHA.
 *
 * Manifest requirements may strengthen policy but may not weaken hard
 * defaults. A manifest cannot:
 *   - allow an empty required R-1 document
 *   - remove required request fields from R-1 when funding is required
 *   - make `document_only` money evidence sufficient
 *   - disable required archive proof for policies requiring it
 *   - convert a required comparison to optional
 */
import { z } from 'zod';
import {
  budgetFamilyV1Schema,
  exhibitV1Schema,
  extractionMethodV1Schema,
  fundingFieldV1Schema,
  type BudgetFamilyV1,
  type ExhibitV1,
  type ExtractionMethodV1,
  type FundingFieldV1,
  type BudgetLineKindV1,
} from '../contracts/extraction-artifact-v1.js';
import {
  requiredDataCategoryV1Schema,
  budgetLineKindV1Schema,
  type RequiredDataCategoryV1,
} from '../contracts/budget-cycle-manifest-v1.js';
import {
  canonicalJsonStringify,
} from '../contracts/canonical-json.js';
import { isCanonicalDecimalString } from '../contracts/decimal-string.js';
import { createHash } from 'node:crypto';
import {
  DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
} from './verification-contract-v1.js';

/* ------------------------------------------------------------------ */
/* D1. Policy structure                                                */
/* ------------------------------------------------------------------ */

const evidenceGranularityV1Schema = z.enum(['page_only', 'cell_bbox', 'text_span']);

export const verificationPolicyV1Schema = z
  .object({
    policyVersion: z.literal(DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION),
    family: budgetFamilyV1Schema,
    exhibit: exhibitV1Schema,
    requiredDataCategories: z.array(requiredDataCategoryV1Schema),
    requiredFundingFields: z.array(fundingFieldV1Schema),
    requiredLineKinds: z.array(budgetLineKindV1Schema),
    allowedParserMethods: z.array(extractionMethodV1Schema),
    minimumMoneyEvidenceGranularity: evidenceGranularityV1Schema,
    pageOnlyMayPassWithIndependentReconciliation: z.boolean(),
    requireImmutableArchive: z.boolean(),
    requireParserRunProof: z.boolean(),
    requiredComparisonRules: z.array(z.string()),
    reviewComparisonRules: z.array(z.string()),
    arithmeticRules: z.array(z.string()),
    manualAlwaysReview: z.boolean(),
    ocrMoneyAlwaysReview: z.boolean(),
    congressionalMoneyAlwaysReviewWhenUncorroborated: z.boolean(),
    enactedAlwaysReviewWhenUncorroborated: z.boolean(),
    highMaterialityThresholdMillions: z.string().refine(isCanonicalDecimalString, {
      message: 'highMaterialityThresholdMillions must be a canonical decimal string',
    }),
    riskThresholds: z.object({
      automaticPassMax: z.number().int().min(0).max(100),
      targetedReextractionMax: z.number().int().min(0).max(100),
      paidVerifierMax: z.number().int().min(0).max(100),
    }),
  })
  .strict()
  .refine(
    (p) =>
      p.riskThresholds.automaticPassMax <= p.riskThresholds.targetedReextractionMax &&
      p.riskThresholds.targetedReextractionMax <= p.riskThresholds.paidVerifierMax,
    {
      message: 'risk thresholds must be ordered: automaticPassMax <= targetedReextractionMax <= paidVerifierMax',
      path: ['riskThresholds'],
    },
  );

export type VerificationPolicyV1 = z.infer<typeof verificationPolicyV1Schema>;

/**
 * All monetary thresholds must be canonical decimal strings.
 */

/* ------------------------------------------------------------------ */
/* D4. Policy SHA                                                      */
/* ------------------------------------------------------------------ */

/**
 * Canonicalize policy JSON using the Phase 1 canonical serializer and compute
 * `policySha256`. Every run persists the exact policy SHA.
 */
export function computePolicySha256(policy: VerificationPolicyV1): string {
  const canonicalJson = canonicalJsonStringify(policy as unknown as import('../contracts/canonical-json.js').JsonValue);
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

/* ------------------------------------------------------------------ */
/* D3. Manifest cannot weaken safety                                    */
/* ------------------------------------------------------------------ */

/**
 * Merge manifest requirements with policy defaults. Manifest may strengthen
 * but may not weaken hard defaults.
 */
export function mergeManifestWithPolicy(
  policy: VerificationPolicyV1,
  manifestRequirements: {
    requiredDataCategories?: readonly RequiredDataCategoryV1[];
    requiredFundingFields?: readonly FundingFieldV1[];
    requiredLineKinds?: readonly BudgetLineKindV1[];
  },
): VerificationPolicyV1 {
  // Manifest can ADD categories/fields/kinds but cannot REMOVE policy defaults
  const policyCats = new Set(policy.requiredDataCategories);
  if (manifestRequirements.requiredDataCategories) {
    for (const cat of manifestRequirements.requiredDataCategories) {
      policyCats.add(cat);
    }
  }

  const policyFields = new Set(policy.requiredFundingFields);
  if (manifestRequirements.requiredFundingFields) {
    for (const field of manifestRequirements.requiredFundingFields) {
      policyFields.add(field);
    }
  }

  const policyKinds = new Set(policy.requiredLineKinds);
  if (manifestRequirements.requiredLineKinds) {
    for (const kind of manifestRequirements.requiredLineKinds) {
      policyKinds.add(kind);
    }
  }

  return {
    ...policy,
    requiredDataCategories: [...policyCats],
    requiredFundingFields: [...policyFields],
    requiredLineKinds: [...policyKinds],
  };
}

/**
 * Validate that a manifest does not weaken policy defaults.
 * Returns findings (empty = OK).
 */
export interface PolicyWeakeningFinding {
  code: string;
  message: string;
}

export function checkManifestDoesNotWeakenPolicy(
  policy: VerificationPolicyV1,
  manifestRequirements: {
    requiredDataCategories?: readonly RequiredDataCategoryV1[];
    requiredFundingFields?: readonly FundingFieldV1[];
    requiredLineKinds?: readonly BudgetLineKindV1[];
  },
): PolicyWeakeningFinding[] {
  const findings: PolicyWeakeningFinding[] = [];

  // Manifest cannot remove required categories
  if (manifestRequirements.requiredDataCategories) {
    const manifestCats = new Set(manifestRequirements.requiredDataCategories);
    for (const cat of policy.requiredDataCategories) {
      if (!manifestCats.has(cat)) {
        findings.push({
          code: 'manifest_weakened_category',
          message: `manifest removed required data category "${cat}" from policy`,
        });
      }
    }
  }

  // Manifest cannot remove required funding fields
  if (manifestRequirements.requiredFundingFields) {
    const manifestFields = new Set(manifestRequirements.requiredFundingFields);
    for (const field of policy.requiredFundingFields) {
      if (!manifestFields.has(field)) {
        findings.push({
          code: 'manifest_weakened_field',
          message: `manifest removed required funding field "${field}" from policy`,
        });
      }
    }
  }

  // Manifest cannot remove required line kinds
  if (manifestRequirements.requiredLineKinds) {
    const manifestKinds = new Set(manifestRequirements.requiredLineKinds);
    for (const kind of policy.requiredLineKinds) {
      if (!manifestKinds.has(kind)) {
        findings.push({
          code: 'manifest_weakened_kind',
          message: `manifest removed required line kind "${kind}" from policy`,
        });
      }
    }
  }

  return findings;
}

/* ------------------------------------------------------------------ */
/* Re-exported types                                                    */
/* ------------------------------------------------------------------ */

export {
  DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION,
} from './verification-contract-v1.js';
export type {
  BudgetFamilyV1,
  ExhibitV1,
  ExtractionMethodV1,
  FundingFieldV1,
  BudgetLineKindV1,
} from '../contracts/extraction-artifact-v1.js';
export type {
  RequiredDataCategoryV1,
} from '../contracts/budget-cycle-manifest-v1.js';