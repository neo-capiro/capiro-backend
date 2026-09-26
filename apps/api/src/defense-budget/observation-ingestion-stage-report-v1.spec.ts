import { observationIngestionStageReportV1 } from './observation-ingestion-stage-report-v1.js';
import type {
  ParserHandoffResult,
  VerifierDecision,
} from './observation-ingestion-bridge.ports.js';

const artifactLocator = 's3://parser-artifacts/execution-1/extraction-artifact.json';

function handoff(decision: VerifierDecision, finalState: string): ParserHandoffResult {
  return { invoked: true, decision, finalState, artifactLocator };
}

describe('operator ingestion stages', () => {
  test('a durably persisted REVIEW extraction is visible without implying verification or publication', () => {
    const result = observationIngestionStageReportV1({
      sourceDocumentBound: true,
      durableEvidencePersisted: true,
      handoff: handoff('REVIEW', 'TERMINAL_REVIEW'),
    });
    expect(result).toEqual({
      extraction: 'artifact_created',
      evidence: 'persisted',
      verification: 'REVIEW',
      persistedForReview: true,
      publication: 'not_assessed',
      artifactLocator,
      parserFinalState: 'TERMINAL_REVIEW',
    });
  });

  test('a missing governed congressional packet claims neither parser verification nor evidence', () => {
    const result = observationIngestionStageReportV1({
      sourceDocumentBound: true,
      durableEvidencePersisted: false,
      handoff: {
        ...handoff('REVIEW', 'governed_review'),
        artifactLocator: 'none',
        governedReview: {
          code: 'CONGRESSIONAL_GOVERNED_PACKET_MISSING',
          scope: {
            fiscalYear: 2027,
            authorityTrack: 'authorization',
            stage: 'hasc_mark',
            sourceFamily: 'auth_committee_mark',
            sourceDocumentId: 'doc-1',
          },
        },
      },
    });
    expect(result).toEqual({
      extraction: 'not_confirmed',
      evidence: 'not_confirmed',
      verification: null,
      persistedForReview: false,
      publication: 'not_assessed',
      artifactLocator: null,
      parserFinalState: null,
    });
  });

  test.each([
    ['PASS', 'TERMINAL_PASSED'],
    ['REJECT', 'TERMINAL_REJECTED'],
  ] as const)(
    '%s still reports the artifact and its actual verifier decision',
    (decision, finalState) => {
      const result = observationIngestionStageReportV1({
        sourceDocumentBound: true,
        durableEvidencePersisted: true,
        handoff: handoff(decision, finalState),
      });
      expect(result).toMatchObject({
        extraction: 'artifact_created',
        evidence: 'persisted',
        verification: decision,
        persistedForReview: false,
        publication: 'not_assessed',
      });
    },
  );

  test('the router can end at TERMINAL_REVIEW with UNKNOWN and no artifact', () => {
    const result = observationIngestionStageReportV1({
      sourceDocumentBound: true,
      durableEvidencePersisted: false,
      handoff: { ...handoff('UNKNOWN', 'TERMINAL_REVIEW'), artifactLocator: 'none' },
    });
    expect(result).toMatchObject({
      extraction: 'not_confirmed',
      evidence: 'not_confirmed',
      verification: 'UNKNOWN',
      persistedForReview: false,
      artifactLocator: null,
      publication: 'not_assessed',
    });
  });

  test.each([
    { sourceDocumentBound: false, durableEvidencePersisted: true },
    { sourceDocumentBound: true, durableEvidencePersisted: false },
  ])('REVIEW requires both bound identity and durable evidence: %j', (facts) => {
    const result = observationIngestionStageReportV1({
      ...facts,
      handoff: handoff('REVIEW', 'TERMINAL_REVIEW'),
    });
    expect(result.extraction).toBe('artifact_created');
    expect(result.persistedForReview).toBe(false);
  });

  test.each(['none', '', '   '])(
    'REVIEW cannot manufacture an extraction from locator %j',
    (locator) => {
      const result = observationIngestionStageReportV1({
        sourceDocumentBound: true,
        durableEvidencePersisted: true,
        handoff: { ...handoff('REVIEW', 'TERMINAL_REVIEW'), artifactLocator: locator },
      });
      expect(result.extraction).toBe('not_confirmed');
      expect(result.persistedForReview).toBe(false);
    },
  );

  test('an exception or skipped handoff makes no claims about partial downstream work', () => {
    expect(
      observationIngestionStageReportV1({
        sourceDocumentBound: true,
        durableEvidencePersisted: false,
        handoff: null,
      }),
    ).toEqual({
      extraction: 'not_confirmed',
      evidence: 'not_confirmed',
      verification: null,
      persistedForReview: false,
      publication: 'not_assessed',
      artifactLocator: null,
      parserFinalState: null,
    });
  });
});
