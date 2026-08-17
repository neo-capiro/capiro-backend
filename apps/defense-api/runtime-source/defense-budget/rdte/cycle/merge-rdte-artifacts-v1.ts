/** Deterministically merge semantic artifacts built from the same source PDF. */
import { ArtifactBuilderV1 } from '../../contracts/artifact-builders.js';
import { canonicalJsonStringify, type JsonValue } from '../../contracts/canonical-json.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ParserRunV1,
  SourceEvidenceV1,
  SourceFactV1,
  DefenseBudgetAssertionV1,
  ExtractionWarningV1,
  ExtractionOmissionV1,
} from '../../contracts/extraction-artifact-v1.js';

type MergeableValue =
  | ParserRunV1
  | SourceEvidenceV1
  | SourceFactV1
  | DefenseBudgetAssertionV1
  | ExtractionWarningV1
  | ExtractionOmissionV1;

function addOrRejectConflict<T extends MergeableValue>(input: {
  seen: Map<string, T>;
  id: string;
  value: T;
  label: string;
  add(value: T): void;
}): void {
  const existing = input.seen.get(input.id);
  if (!existing) {
    input.seen.set(input.id, input.value);
    input.add(input.value);
    return;
  }
  const prior = canonicalJsonStringify(existing as unknown as JsonValue);
  const current = canonicalJsonStringify(input.value as unknown as JsonValue);
  if (prior !== current) {
    throw new Error(
      `RDT&E artifact merge conflict: ${input.label} ${input.id} has different payloads`,
    );
  }
}

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
  const parserRuns = new Map<string, ParserRunV1>();
  const evidence = new Map<string, SourceEvidenceV1>();
  const sourceFacts = new Map<string, SourceFactV1>();
  const assertions = new Map<string, DefenseBudgetAssertionV1>();
  const warnings = new Map<string, ExtractionWarningV1>();
  const omissions = new Map<string, ExtractionOmissionV1>();

  for (const artifact of artifacts) {
    for (const value of artifact.parserRuns) {
      addOrRejectConflict({
        seen: parserRuns,
        id: value.parserRunId,
        value,
        label: 'parserRunId',
        add: (item) => builder.addParserRun(item),
      });
    }
    for (const value of artifact.evidence) {
      addOrRejectConflict({
        seen: evidence,
        id: value.evidenceId,
        value,
        label: 'evidenceId',
        add: (item) => builder.addEvidence(item),
      });
    }
    for (const value of artifact.sourceFacts) {
      addOrRejectConflict({
        seen: sourceFacts,
        id: value.factId,
        value,
        label: 'factId',
        add: (item) => builder.addSourceFact(item),
      });
    }
    for (const value of artifact.assertions) {
      addOrRejectConflict({
        seen: assertions,
        id: value.assertionId,
        value,
        label: 'assertionId',
        add: (item) => builder.addAssertion(item),
      });
    }
    for (const value of artifact.warnings) {
      addOrRejectConflict({
        seen: warnings,
        id: value.warningId,
        value,
        label: 'warningId',
        add: (item) => builder.addWarning(item),
      });
    }
    for (const value of artifact.omissions) {
      addOrRejectConflict({
        seen: omissions,
        id: value.omissionId,
        value,
        label: 'omissionId',
        add: (item) => builder.addOmission(item),
      });
    }
  }
  return builder.finalize();
}
