/**
 * Workstream H — Arithmetic rule types.
 *
 * Shared types for arithmetic rules that compare sums, rollups, and
 * adjustments across assertions.
 */
import type { VerificationRuleV1 } from '../rule-types.js';

/** An arithmetic comparison between a parent value and child values. */
export interface ArithmeticComparison {
  /** Rule code (e.g. "rdte_summary_detail"). */
  ruleCode: string;
  /** Parent assertion ID. */
  parentAssertionId: string;
  /** Parent value in millions. */
  parentValueMillions: string;
  /** Child assertion IDs. */
  childAssertionIds: string[];
  /** Child values in millions. */
  childValuesMillions: string[];
  /** Sum of child values in millions. */
  childSumMillions: string;
  /** Absolute difference |parent - childSum|. */
  differenceMillions: string;
  /** Tolerance applied. */
  toleranceMillions: string;
  /** Whether the difference is within tolerance. */
  withinTolerance: boolean;
}

/** Extract funding assertion values by identity + fiscalYear + field. */
export interface FundingGroupKey {
  identity: unknown;
  fiscalYear: number;
  field: string;
}
