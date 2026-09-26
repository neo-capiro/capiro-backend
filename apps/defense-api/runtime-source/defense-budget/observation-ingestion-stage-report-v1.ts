import type {
  ParserHandoffResult,
  VerifierDecision,
} from './observation-ingestion-bridge.ports.js';

/** Operator observations only. No field authorizes an outbox transition or publication. */
export interface ObservationIngestionStageReportV1 {
  /** An extraction artifact exists; this does not assert completeness or correctness. */
  readonly extraction: 'artifact_created' | 'not_confirmed';
  readonly evidence: 'persisted' | 'not_confirmed';
  readonly verification: VerifierDecision | null;
  readonly persistedForReview: boolean;
  /** Per-observation ingestion does not inspect canonical publication. */
  readonly publication: 'not_assessed';
  readonly artifactLocator: string | null;
  readonly parserFinalState: string | null;
}

export function observationIngestionStageReportV1(input: {
  sourceDocumentBound: boolean;
  durableEvidencePersisted: boolean;
  handoff: ParserHandoffResult | null;
}): ObservationIngestionStageReportV1 {
  if (input.handoff?.governedReview) {
    return {
      extraction: 'not_confirmed',
      evidence: 'not_confirmed',
      verification: null,
      persistedForReview: false,
      publication: 'not_assessed',
      artifactLocator: null,
      parserFinalState: null,
    };
  }
  const locator = input.handoff?.artifactLocator.trim();
  // The router uses 'none' when no extraction artifact was produced. A
  // resolved REVIEW (or terminal router state) alone cannot prove extraction.
  const artifactLocator = locator && locator !== 'none' ? locator : null;
  return {
    extraction: artifactLocator ? 'artifact_created' : 'not_confirmed',
    evidence: input.durableEvidencePersisted ? 'persisted' : 'not_confirmed',
    verification: input.handoff?.decision ?? null,
    persistedForReview:
      input.sourceDocumentBound &&
      input.durableEvidencePersisted &&
      input.handoff?.decision === 'REVIEW' &&
      artifactLocator !== null,
    publication: 'not_assessed',
    artifactLocator,
    parserFinalState: input.handoff?.finalState ?? null,
  };
}
