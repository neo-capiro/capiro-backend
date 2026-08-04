/**
 * Rule execution types for defense_budget_verification_v1.
 *
 * Every verification rule conforms to this contract. Rules are
 * deterministic functions of the verification context, policy, and
 * proof — no I/O, no random, no side effects.
 */
import {
  computeVerificationCheckId,
  computeVerificationDiscrepancyId,
  type VerificationCheckV1,
  type VerificationDiscrepancyV1,
  type CheckOutcomeV1,
  type JsonValue,
} from '../verification-contract-v1.js';
import type { VerificationContextV1 } from '../verification-input-v1.js';
import type { ProofFindingV1 } from '../trusted-proof/trusted-proof-types.js';
import type {
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
} from '../../contracts/extraction-artifact-v1.js';
import type { VerificationPolicyV1 } from '../verification-policy-v1.js';

/* ------------------------------------------------------------------ */
/* Rule interface                                                       */
/* ------------------------------------------------------------------ */

/** The result of executing one verification rule. */
export interface RuleResultV1 {
  /** The check that was produced, or null if the rule was skipped entirely. */
  check: VerificationCheckV1 | null;
  /** Any discrepancies the rule found. */
  discrepancies: VerificationDiscrepancyV1[];
}

/**
 * A verification rule. Rules are pure functions: given a context and
 * policy, they return a deterministic result. They never touch the
 * database, S3, filesystem, or clock.
 */
export interface VerificationRuleV1 {
  /** Stable rule code (e.g. "contract_integrity", "manifest_binding"). */
  readonly code: string;
  /** Human-readable rule name. */
  readonly name: string;
  /** Rule version string. */
  readonly version: string;
  /** Whether this rule is required (non-skippable). */
  readonly required: boolean;
  /** Whether a FAIL from this rule blocks automatic PASS. */
  readonly blocking: boolean;
  /** Policy risk points for a FAIL outcome. */
  readonly riskPoints: number;
  /** Execute the rule and return a check + discrepancies. */
  execute(ctx: VerificationContextV1): RuleResultV1;
}

/* ------------------------------------------------------------------ */
/* Check builders                                                       */
/* ------------------------------------------------------------------ */

/**
 * R8.1 §3.1 — Policy-resolved check attribute overrides.
 *
 * A rule's static `required`/`blocking` flags describe the rule in isolation.
 * The POLICY decides whether a given check is required for this document.
 * Builders must persist the policy-resolved value, never a bare
 * `required: false` merely because the static rule definition is optional.
 */
export interface CheckOverrides {
  required?: boolean;
  blocking?: boolean;
  riskPoints?: number;
}

export function passCheck(
  rule: VerificationRuleV1,
  verificationRunId: string,
  assertionIds: readonly string[],
  evidenceIds: readonly string[],
  referenceArtifactIds: readonly string[],
  message?: string,
  details?: Record<string, JsonValue>,
  overrides?: CheckOverrides,
): VerificationCheckV1 {
  return {
    checkId: computeVerificationCheckId({
      verificationRunId,
      code: rule.code,
      assertionIds,
      evidenceIds,
      referenceArtifactIds,
    }),
    code: rule.code,
    ruleVersion: rule.version,
    outcome: 'PASS',
    required: overrides?.required ?? rule.required,
    blocking: overrides?.blocking ?? rule.blocking,
    riskPoints: overrides?.riskPoints ?? 0,
    message: message ?? `${rule.name}: passed`,
    assertionIds: [...assertionIds],
    evidenceIds: [...evidenceIds],
    referenceArtifactIds: [...referenceArtifactIds],
    details,
  };
}

export function failCheck(
  rule: VerificationRuleV1,
  verificationRunId: string,
  assertionIds: readonly string[],
  evidenceIds: readonly string[],
  referenceArtifactIds: readonly string[],
  message: string,
  details?: Record<string, JsonValue>,
  overrides?: CheckOverrides,
): VerificationCheckV1 {
  return {
    checkId: computeVerificationCheckId({
      verificationRunId,
      code: rule.code,
      assertionIds,
      evidenceIds,
      referenceArtifactIds,
    }),
    code: rule.code,
    ruleVersion: rule.version,
    outcome: 'FAIL',
    required: overrides?.required ?? rule.required,
    blocking: overrides?.blocking ?? rule.blocking,
    riskPoints: overrides?.riskPoints ?? rule.riskPoints,
    message,
    assertionIds: [...assertionIds],
    evidenceIds: [...evidenceIds],
    referenceArtifactIds: [...referenceArtifactIds],
    details,
  };
}

export function notRunCheck(
  rule: VerificationRuleV1,
  verificationRunId: string,
  assertionIds: readonly string[],
  evidenceIds: readonly string[],
  referenceArtifactIds: readonly string[],
  message: string,
  details?: Record<string, JsonValue>,
  overrides?: CheckOverrides,
): VerificationCheckV1 {
  return {
    checkId: computeVerificationCheckId({
      verificationRunId,
      code: rule.code,
      assertionIds,
      evidenceIds,
      referenceArtifactIds,
    }),
    code: rule.code,
    ruleVersion: rule.version,
    outcome: 'NOT_RUN',
    required: overrides?.required ?? rule.required,
    blocking: overrides?.blocking ?? rule.blocking,
    riskPoints: overrides?.riskPoints ?? rule.riskPoints,
    message,
    assertionIds: [...assertionIds],
    evidenceIds: [...evidenceIds],
    referenceArtifactIds: [...referenceArtifactIds],
    details,
  };
}

export function skippedCheck(
  rule: VerificationRuleV1,
  verificationRunId: string,
  message: string,
  overrides?: CheckOverrides,
): VerificationCheckV1 {
  return {
    checkId: computeVerificationCheckId({
      verificationRunId,
      code: rule.code,
      assertionIds: [],
      evidenceIds: [],
      referenceArtifactIds: [],
    }),
    code: rule.code,
    ruleVersion: rule.version,
    outcome: 'SKIPPED',
    required: overrides?.required ?? rule.required,
    blocking: overrides?.blocking ?? rule.blocking,
    riskPoints: overrides?.riskPoints ?? 0,
    message,
    assertionIds: [],
    evidenceIds: [],
    referenceArtifactIds: [],
  };
}

/* ------------------------------------------------------------------ */
/* Discrepancy builder                                                  */
/* ------------------------------------------------------------------ */

export function makeDiscrepancy(
  code: string,
  severity: 'blocking' | 'review' | 'informational',
  description: string,
  assertionIds: readonly string[],
  evidenceIds: readonly string[],
  referenceArtifactIds: readonly string[],
  details?: Record<string, JsonValue>,
): VerificationDiscrepancyV1 {
  return {
    discrepancyId: computeVerificationDiscrepancyId({
      code,
      assertionIds,
      evidenceIds,
      referenceArtifactIds,
    }),
    code,
    severity,
    description,
    assertionIds: [...assertionIds],
    evidenceIds: [...evidenceIds],
    referenceArtifactIds: [...referenceArtifactIds],
    details,
  };
}

/* ------------------------------------------------------------------ */
/* Re-exports                                                            */
/* ------------------------------------------------------------------ */

export type {
  VerificationCheckV1,
  VerificationDiscrepancyV1,
  CheckOutcomeV1,
  VerificationContextV1,
  ProofFindingV1,
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
  VerificationPolicyV1,
};
