/**
 * Restart-safety proof: this suite reconstructs outcomes from persistence-shaped
 * plain objects only. It does not use Prisma, a live bridge run, or any in-memory
 * ObservationIngestionBridgeResult.
 */
import { reconstructReadinessIngestionOutcomeV1 } from './cycle-family-readiness-v1.js';

const SHA = 'a'.repeat(64);
const base = (decision: string) => ({
  observation: { observationState: 'ingested', sourceDocumentId: 'doc', contentSha256: SHA },
  sourceDocument: { id: 'doc', sha256: SHA },
  parseJobs: [{ inputSha256: SHA, status: 'succeeded' }],
  candidates: [{ id: 'candidate', sourceDocumentId: 'doc', sourceSha256: SHA, currentRunId: 'run' }],
  verificationRuns: [{ id: 'run', candidateId: 'candidate', decision, completedAt: '2027-01-01T00:00:00Z' }],
});

describe('durable ingestion reconstruction v1', () => {
  it.each([['PASS', 'ingested_pass'], ['REVIEW', 'ingested_review'], ['REJECT', 'ingested_reject']])(
    'reconstructs %s', (decision, expected) => {
      expect(reconstructReadinessIngestionOutcomeV1(base(decision))).toBe(expected);
    },
  );

  it('never treats observation_state=ingested alone as PASS', () => {
    expect(reconstructReadinessIngestionOutcomeV1({
      ...base('PASS'), sourceDocument: null, parseJobs: [], candidates: [], verificationRuns: [],
    })).toBe('ingestion_incomplete');
  });

  it('a named currentRunId that cannot be resolved fails closed to ingestion_incomplete, even when an older run PASSED', () => {
    // currentRunId names 'run-new', but the only verification run present is
    // the OLDER 'run-old' with decision PASS. The exact named current run
    // must exist; falling back to the newest-by-time OTHER run would
    // silently promote a stale/superseded PASS into the current readiness
    // result — this must never happen.
    const input = {
      observation: { observationState: 'ingested', sourceDocumentId: 'doc', contentSha256: SHA },
      sourceDocument: { id: 'doc', sha256: SHA },
      parseJobs: [{ inputSha256: SHA, status: 'succeeded' }],
      candidates: [{ id: 'candidate', sourceDocumentId: 'doc', sourceSha256: SHA, currentRunId: 'run-new' }],
      verificationRuns: [
        { id: 'run-old', candidateId: 'candidate', decision: 'PASS', completedAt: '2027-01-01T00:00:00Z' },
      ],
    };
    expect(reconstructReadinessIngestionOutcomeV1(input)).toBe('ingestion_incomplete');
  });

  it('a named currentRunId that exists but belongs to a DIFFERENT candidate is unresolved and fails closed', () => {
    const input = {
      observation: { observationState: 'ingested', sourceDocumentId: 'doc', contentSha256: SHA },
      sourceDocument: { id: 'doc', sha256: SHA },
      parseJobs: [{ inputSha256: SHA, status: 'succeeded' }],
      candidates: [{ id: 'candidate', sourceDocumentId: 'doc', sourceSha256: SHA, currentRunId: 'run-elsewhere' }],
      verificationRuns: [
        // Same run id, but bound to a different candidate — the exact named
        // run for THIS candidate is still unresolved.
        { id: 'run-elsewhere', candidateId: 'other-candidate', decision: 'PASS', completedAt: '2027-06-01T00:00:00Z' },
      ],
    };
    expect(reconstructReadinessIngestionOutcomeV1(input)).toBe('ingestion_incomplete');
  });

  it('currentRunId=null legitimately falls back to the latest completed run by time', () => {
    const input = {
      observation: { observationState: 'ingested', sourceDocumentId: 'doc', contentSha256: SHA },
      sourceDocument: { id: 'doc', sha256: SHA },
      parseJobs: [{ inputSha256: SHA, status: 'succeeded' }],
      candidates: [{ id: 'candidate', sourceDocumentId: 'doc', sourceSha256: SHA, currentRunId: null }],
      verificationRuns: [
        { id: 'run-old', candidateId: 'candidate', decision: 'REJECT', completedAt: '2027-01-01T00:00:00Z' },
        { id: 'run-newest', candidateId: 'candidate', decision: 'PASS', completedAt: '2027-06-01T00:00:00Z' },
      ],
    };
    expect(reconstructReadinessIngestionOutcomeV1(input)).toBe('ingested_pass');
  });

  it('a resolved currentRunId is honored exactly, even when an unrelated older run has a different decision', () => {
    const input = {
      observation: { observationState: 'ingested', sourceDocumentId: 'doc', contentSha256: SHA },
      sourceDocument: { id: 'doc', sha256: SHA },
      parseJobs: [{ inputSha256: SHA, status: 'succeeded' }],
      candidates: [{ id: 'candidate', sourceDocumentId: 'doc', sourceSha256: SHA, currentRunId: 'run-current' }],
      verificationRuns: [
        { id: 'run-old', candidateId: 'candidate', decision: 'PASS', completedAt: '2027-01-01T00:00:00Z' },
        { id: 'run-current', candidateId: 'candidate', decision: 'REJECT', completedAt: '2027-06-01T00:00:00Z' },
      ],
    };
    expect(reconstructReadinessIngestionOutcomeV1(input)).toBe('ingested_reject');
  });
});
