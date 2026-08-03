/**
 * Barrel exports for verification rules (Workstreams E–H).
 */
// Shared rule infrastructure
export type { VerificationRuleV1, RuleResultV1 } from './rule-types.js';
export { passCheck, failCheck, notRunCheck, skippedCheck, makeDiscrepancy } from './rule-types.js';
export {
  registerRule,
  lookupRule,
  getAllRules,
  getRulesByCodes,
  clearRuleRegistry,
} from './rule-registry.js';

// Workstream E — Manifest binding and completeness
export { CONTRACT_INTEGRITY_RULE } from './contract-integrity.rules.js';
export { MANIFEST_BINDING_RULE } from './manifest-binding.rules.js';
export { COMPLETENESS_RULE } from './completeness.rules.js';

// Workstream F — Evidence and parser-lineage
export {
  EVIDENCE_BINDING_RULE,
  MONEY_EVIDENCE_RULE,
  WARNING_POLICY_RULE,
} from './evidence.rules.js';

// Workstream G — Identity, ownership, numeric, duplicate
export { IDENTITY_RULE } from './identity.rules.js';
export { FUNDING_FIELD_OWNERSHIP_RULE } from './funding-field-ownership.rules.js';
export { NUMERIC_RULE } from './numeric.rules.js';
export { DUPLICATE_RULE } from './duplicate.rules.js';

// Workstream H — Exact arithmetic
export {
  RDTE_SUMMARY_DETAIL_RULE,
  PROJECT_ROLLUP_RULE,
  PROCUREMENT_ROLLUP_RULE,
  COMMITTEE_ADJUSTMENT_RULE,
} from './arithmetic/index.js';
export {
  addDecimals,
  subtractDecimals,
  multiplyByInteger,
  absDifference,
  compareWithTolerance,
  printedUnitToleranceMillions,
  sumDecimals,
} from './arithmetic/exact-arithmetic.js';

/**
 * All verification rules E–H, in execution order.
 * The engine iterates this array to produce checks and discrepancies.
 */
import { CONTRACT_INTEGRITY_RULE } from './contract-integrity.rules.js';
import { MANIFEST_BINDING_RULE } from './manifest-binding.rules.js';
import { COMPLETENESS_RULE } from './completeness.rules.js';
import {
  EVIDENCE_BINDING_RULE,
  MONEY_EVIDENCE_RULE,
  WARNING_POLICY_RULE,
} from './evidence.rules.js';
import { IDENTITY_RULE } from './identity.rules.js';
import { FUNDING_FIELD_OWNERSHIP_RULE } from './funding-field-ownership.rules.js';
import { NUMERIC_RULE } from './numeric.rules.js';
import { DUPLICATE_RULE } from './duplicate.rules.js';
import { RDTE_SUMMARY_DETAIL_RULE } from './arithmetic/rdte-summary-detail.rules.js';
import { PROJECT_ROLLUP_RULE } from './arithmetic/project-rollup.rules.js';
import { PROCUREMENT_ROLLUP_RULE } from './arithmetic/procurement-rollup.rules.js';
import { COMMITTEE_ADJUSTMENT_RULE } from './arithmetic/committee-adjustment.rules.js';
import type { VerificationRuleV1 } from './rule-types.js';

export const ALL_VERIFICATION_RULES: readonly VerificationRuleV1[] = [
  CONTRACT_INTEGRITY_RULE,
  MANIFEST_BINDING_RULE,
  COMPLETENESS_RULE,
  EVIDENCE_BINDING_RULE,
  MONEY_EVIDENCE_RULE,
  WARNING_POLICY_RULE,
  IDENTITY_RULE,
  FUNDING_FIELD_OWNERSHIP_RULE,
  NUMERIC_RULE,
  DUPLICATE_RULE,
  RDTE_SUMMARY_DETAIL_RULE,
  PROJECT_ROLLUP_RULE,
  PROCUREMENT_ROLLUP_RULE,
  COMMITTEE_ADJUSTMENT_RULE,
];
