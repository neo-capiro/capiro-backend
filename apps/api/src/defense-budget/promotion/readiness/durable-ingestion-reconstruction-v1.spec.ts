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
});
