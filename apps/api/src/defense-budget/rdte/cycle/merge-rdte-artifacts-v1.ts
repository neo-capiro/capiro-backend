/** Deterministically merge semantic artifacts built from the same source PDF. */
import { ArtifactBuilderV1 } from '../../contracts/artifact-builders.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';

export function mergeRdteArtifactsV1(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
): DefenseBudgetExtractionArtifactV1 {
  if (artifacts.length === 0) throw new Error('cannot merge zero RDT&E artifacts');
  const [first] = artifacts;
  if (!first) throw new Error('missing first RDT&E artifact');
  for (const artifact of artifacts) {
    if (
      artifact.source.manifestDocumentKey !== first.source.manifestDocumentKey ||
      artifact.source.sourcePdfSha256 !== first.source.sourcePdfSha256 ||
      artifact.source.sourceDocumentId !== first.source.sourceDocumentId
    ) {
      throw new Error('RDT&E artifact merge requires identical source identity');
    }
  }

  const builder = new ArtifactBuilderV1(first.source);
  const parserRunIds = new Set<string>();
  const evidenceIds = new Set<string>();
  const sourceFactIds = new Set<string>();
  const assertionIds = new Set<string>();
  const warningIds = new Set<string>();
  const omissionIds = new Set<string>();

  for (const artifact of artifacts) {
    for (const value of artifact.parserRuns) {
      if (!parserRunIds.has(value.parserRunId)) {
        parserRunIds.add(value.parserRunId);
        builder.addParserRun(value);
      }
    }
    for (const value of artifact.evidence) {
      if (!evidenceIds.has(value.evidenceId)) {
        evidenceIds.add(value.evidenceId);
        builder.addEvidence(value);
      }
    }
    for (const value of artifact.sourceFacts) {
      if (!sourceFactIds.has(value.factId)) {
        sourceFactIds.add(value.factId);
        builder.addSourceFact(value);
      }
    }
    for (const value of artifact.assertions) {
      if (!assertionIds.has(value.assertionId)) {
        assertionIds.add(value.assertionId);
        builder.addAssertion(value);
      }
    }
    for (const value of artifact.warnings) {
      if (!warningIds.has(value.warningId)) {
        warningIds.add(value.warningId);
        builder.addWarning(value);
      }
    }
    for (const value of artifact.omissions) {
      if (!omissionIds.has(value.omissionId)) {
        omissionIds.add(value.omissionId);
        builder.addOmission(value);
      }
    }
  }
  return builder.finalize();
}
