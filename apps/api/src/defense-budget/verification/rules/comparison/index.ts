/**
 * Barrel exports for comparison rules (Workstream I).
 */
export type {
  ComparisonKindV1,
  ComparisonOutcomeV1,
  ComparisonResultV1,
  ComparisonMismatchDetailV1,
  ReferenceMatchResultV1,
  ReferenceArtifactEntryV1,
  ReferenceIndexKeyV1,
} from './comparison-types.js';
export { isHistoricalConsistency, COMPARISON_KIND_V1_VALUES } from './comparison-types.js';

export { ReferenceArtifactIndexV1, identityNaturalKey } from './reference-artifact-index.js';

export type { ComparisonProviderV1 } from './comparison-provider.js';
export { createComparisonProvider } from './comparison-provider.js';

export {
  CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
  COMMITTEE_REQUEST_REFERENCE_RULE,
  HISTORICAL_CONSISTENCY_RULE,
} from './comparison.rules.js';
