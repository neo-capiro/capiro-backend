/**
 * R8.3 — deterministic run identity + exact replay.
 *
 * Exact immutable candidate identity has exactly one deterministic run ID,
 * independent of timestamps. Corrections require changed source, manifest,
 * artifact, policy, or verifier identity rather than a public retry/attempt
 * parameter.
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

describe('R8.3 deterministic run identity', () => {
  it('uses a fixed internal replay identity and is stable', () => {
    const runId1 = computeRunId(identity, '0');
    const runId2 = computeRunId(identity, '0');
    expect(runId1).toBe(runId2);
    expect(runId1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('candidate and run IDs change when immutable artifact identity changes', () => {
    const correctedIdentity: CandidateIdentityV1 = {
      ...identity,
      extractionArtifactSha256: 'e'.repeat(64),
    };
    expect(computeCandidateId(correctedIdentity)).not.toBe(computeCandidateId(identity));
    expect(computeRunId(correctedIdentity, '0')).not.toBe(computeRunId(identity, '0'));
  });

  it('candidate ID is stable for exact replay', () => {
    expect(computeCandidateId(identity)).toBe(computeCandidateId(identity));
  });
});
