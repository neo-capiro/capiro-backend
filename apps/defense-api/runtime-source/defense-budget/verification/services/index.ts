/**
 * Barrel exports for V1 budget verification services (Workstream L/M).
 */
export { BudgetVerificationV1Service } from './budget-verification-v1.service.js';
export type { VerificationClock } from './budget-verification-v1.service.js';

// Workstream M — immutable audit-only review
export {
  BudgetReviewV1Service,
  ReviewEligibilityError,
  DEFAULT_REVIEW_POLICY_V1,
  BLOCKING_REVIEW_CODES,
  BLOCKING_CHECK_CODES,
  hasNonWaivableBlockingFailure,
  hasNonWaivableBlockingProofFinding,
  hasNonWaivableBlockingProofSnapshot,
  hasNonWaivableBlockingDiscrepancy,
} from './budget-review-v1.service.js';
export type { ReviewInputV1, ReviewResultV1, ReviewPolicyV1 } from './budget-review-v1.service.js';
