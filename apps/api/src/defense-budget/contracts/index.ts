/**
 * Barrel exports for the defense-budget extraction contract.
 */
export {
  canonicalJsonStringify,
  sha256CanonicalJson,
  sha256Hex,
  type JsonPrimitive,
  type JsonValue,
} from './canonical-json.js';
export {
  integerToCanonicalString,
  isCanonicalDecimalString,
  moneyToMillionsString,
  parseCanonicalDecimalString,
  scaleDecimalString,
  type MoneyUnitV1,
} from './decimal-string.js';
export {
  ArtifactBuilderV1,
  ArtifactBuildError,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  omissionIdV1,
  parserRunIdV1,
  warningIdV1,
} from './artifact-builders.js';
export {
  assertDefenseBudgetExtractionArtifactV1,
  computeArtifactContentSha256,
  computeArtifactSummary,
  parseDefenseBudgetExtractionArtifactV1,
  validateDefenseBudgetExtractionArtifactV1,
  type ContractFindingV1,
} from './extraction-artifact-v1.semantic.js';
export * from './extraction-artifact-v1.js';
