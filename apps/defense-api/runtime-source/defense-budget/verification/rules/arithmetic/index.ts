/** Barrel exports for arithmetic rules. */
export { RDTE_SUMMARY_DETAIL_RULE } from './rdte-summary-detail.rules.js';
export { PROJECT_ROLLUP_RULE } from './project-rollup.rules.js';
export { PROCUREMENT_ROLLUP_RULE } from './procurement-rollup.rules.js';
export { COMMITTEE_ADJUSTMENT_RULE } from './committee-adjustment.rules.js';
export { NDAA_CONFERENCE_ARITHMETIC_RULE } from './ndaa-conference-arithmetic.rules.js';
export type { ArithmeticComparison, FundingGroupKey } from './arithmetic-rule-types.js';
export {
  addDecimals,
  subtractDecimals,
  multiplyByInteger,
  absDifference,
  compareWithTolerance,
  printedUnitToleranceMillions,
  sumDecimals,
} from './exact-arithmetic.js';
