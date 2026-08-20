import { describe, expect, it } from '@jest/globals';
import type { DefenseBudgetVerificationResultV1 } from '../verification/verification-contract-v1.js';
import { rdteVerificationRefFromResult } from './rdte-cycle-bundle-v1.js';

const CONTENT_SHA = 'a'.repeat(64);
const BYTE_SHA = 'b'.repeat(64);
const POLICY_SHA = 'c'.repeat(64);
const SOURCE_SHA = 'd'.repeat(64);
const MANIFEST_SHA = 'e'.repeat(64);

function result(): DefenseBudgetVerificationResultV1 {
  return {
    verifierVersion: 'defense_budget_verifier_v1',
    policyVersion: 'defense_budget_verification_policy_v1',
    policySha256: POLICY_SHA,
    verificationRunId: 'verification-run',
    candidateId: 'candidate',
    cycleId: 'pb_fy2027',
    manifestContentSha256: MANIFEST_SHA,
    manifestDocumentKey: 'r1_army',
    extractionArtifactId: `dbx1_${CONTENT_SHA}`,
    extractionArtifactSha256: CONTENT_SHA,
    sourceDocumentId: 'source-document',
    sourcePdfSha256: SOURCE_SHA,
    decision: 'PASS',
    status: 'VERIFICATION_PASSED',
    route: 'none',
    riskScore: 0,
    checks: [],
    discrepancies: [],
    acceptedAssertionIds: ['assertion-a'],
    rejectedAssertionIds: [],
    referenceArtifactIds: [],
    startedAt: '2026-08-05T00:00:00Z',
    completedAt: '2026-08-05T00:00:01Z',
  };
}

describe('RDT&E verification reference SHA binding', () => {
  it('preserves distinct canonical-content and serialized-byte hashes', () => {
    const ref = rdteVerificationRefFromResult({
      result: result(),
      artifactContentSha256: CONTENT_SHA,
      artifactByteSha256: BYTE_SHA,
    });

    expect(ref.artifactContentSha256).toBe(CONTENT_SHA);
    expect(ref.artifactByteSha256).toBe(BYTE_SHA);
  });

  it('rejects a Phase 2 result bound to a different artifact content hash', () => {
    expect(() =>
      rdteVerificationRefFromResult({
        result: result(),
        artifactContentSha256: 'f'.repeat(64),
        artifactByteSha256: BYTE_SHA,
      }),
    ).toThrow(/content SHA/);
  });
});
