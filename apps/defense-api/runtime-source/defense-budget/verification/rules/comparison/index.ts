/** Barrel exports for comparison rules. */
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
  HISTORICAL_CONSISTENCY_RULE,
} from './comparison.rules.js';
export {
  COMMITTEE_REQUEST_REFERENCE_RULE,
  committeeRequestComparablesV1,
} from './committee-request-baseline.rules.js';
export {
  NDAA_CONFERENCE_CHAMBER_REFERENCE_RULE,
  ndaaConferenceComparablesV1,
} from './ndaa-conference-chamber.rules.js';
export { APPROPRIATIONS_CONFERENCE_CHAMBER_REFERENCE_RULE } from './appropriations-conference-chamber.rules.js';
