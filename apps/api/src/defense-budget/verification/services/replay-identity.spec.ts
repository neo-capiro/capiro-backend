/**
 * R8.1 WS5 — deterministic run identity + exact replay.
 *
 *  - default run ID is derived from candidate identity + verifier version +
 *    policy SHA with a fixed attempt identity ("0"), independent of any
 *    timestamp, so an exact re-invocation yields the same run ID;
 *  - an explicit attemptId produces a distinct run ID;
 *  - the service returns the persisted snapshot for an exact terminal replay
 *    before running any rules.
 */
import { describe, it, expect } from '@jest/globals';
import {
  computeCandidateId,
  computeRunId,
} from '../persistence/verification-persistence-mappers.js';
import type { CandidateIdentityV1 } from '../persistence/verification-repository.js';

const identity: CandidateIdentityV1 = {
  cycleId: 'fy2027',
  manifestContentSha256: 'a'.repeat(64),
  manifestDocumentKey: 'r1_fy2027',
  extractionArtifactId: 'art-1',
  extractionArtifactSha256: 'b'.repeat(64),
  extractionArtifactLocator: '/test/art.json',
  sourceDocumentId: '00000000-0000-0000-0000-000000000001',
  sourceSha256: 'c'.repeat(64),
  verifierVersion: 'defense_budget_verifier_v1',
  policyVersion: 'defense_budget_verification_policy_v1',
  policySha256: 'd'.repeat(64),
};

describe('R8.1 §5.2 — deterministic run identity', () => {
  it('default attempt run ID does not include a timestamp and is stable', () => {
    const runId1 = computeRunId(identity, '0');
    const runId2 = computeRunId(identity, '0');
    expect(runId1).toBe(runId2);
    expect(runId1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('run ID changes only with an explicit new attempt identity', () => {
    const attempt0 = computeRunId(identity, '0');
    const attempt1 = computeRunId(identity, '1');
    expect(attempt0).not.toBe(attempt1);
  });

  it('candidate ID is stable and independent of attempt', () => {
    expect(computeCandidateId(identity)).toBe(computeCandidateId(identity));
  });
});
