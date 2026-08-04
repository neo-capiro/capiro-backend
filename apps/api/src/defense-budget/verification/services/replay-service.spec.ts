/**
 * R8.1 §5.1 — exact terminal replay returns the persisted snapshot before
 * any rules execute, and creates no new rows.
 */
import { describe, it, expect } from '@jest/globals';
import { BudgetVerificationV1Service } from './budget-verification-v1.service.js';
import type { VerificationRequestV1 } from '../verification-contract-v1.js';
import type {
  TrustedVerificationProofResolverV1,
  TrustedProofResolutionV1,
} from '../trusted-proof/trusted-proof-types.js';
import type {
  BudgetVerificationRepositoryV1,
  ReadCandidateV1,
  ReadRunV1,
  PersistedCandidateV1,
  PersistedRunV1,
} from '../persistence/verification-repository.js';

const SHA = 'a'.repeat(64);

// A resolution sufficient for the service to compute candidate identity.
function makeResolution(): TrustedProofResolutionV1 {
  return {
    manifest: {
      cycleId: 'fy2027',
      fiscalYear: 2027,
      documents: [
        {
          documentKey: 'r1_fy2027',
          family: 'rdte',
          exhibit: 'R-1',
          required: true,
        },
      ],
    } as never,
    manifestDocument: {
      documentKey: 'r1_fy2027',
      family: 'rdte',
      exhibit: 'R-1',
    } as never,
    manifestContentSha256: SHA,
    artifact: {
      artifactId: 'art-1',
      assertions: [],
      parserRuns: [],
    } as never,
    extractionArtifactByteSha256: SHA,
    extractionArtifactContentSha256: SHA,
    proofBundle: { sourceDocument: { sourceSha256: SHA } } as never,
    proofFindings: [],
    referenceArtifacts: [],
    referenceArtifactsProofBundles: [],
    referenceArtifactsFindings: [],
  };
}

const PERSISTED_RESULT = {
  verifierVersion: 'defense_budget_verifier_v1',
  policyVersion: 'defense_budget_verification_policy_v1',
  policySha256: SHA,
  verificationRunId: 'run-persisted-0',
  candidateId: 'cand-persisted',
  cycleId: 'fy2027',
  manifestContentSha256: SHA,
  manifestDocumentKey: 'r1_fy2027',
  extractionArtifactId: 'art-1',
  extractionArtifactSha256: SHA,
  sourceDocumentId: 'sd-1',
  sourcePdfSha256: SHA,
  decision: 'PASS',
  status: 'VERIFICATION_PASSED',
  route: 'none',
  riskScore: 0,
  checks: [],
  discrepancies: [],
  acceptedAssertionIds: [],
  rejectedAssertionIds: [],
  referenceArtifactIds: [],
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:00:01Z',
};

class ReplayResolver implements TrustedVerificationProofResolverV1 {
  async resolve(): Promise<TrustedProofResolutionV1> {
    return makeResolution();
  }
}

class ReplayRepository implements Partial<BudgetVerificationRepositoryV1> {
  findCalls = 0;
  persistCalls = 0;

  async findTerminalRunByIdentity(): Promise<{
    candidate: ReadCandidateV1;
    run: ReadRunV1;
  } | null> {
    this.findCalls++;
    return {
      candidate: { id: 'cand-persisted', status: 'VERIFICATION_PASSED' } as ReadCandidateV1,
      run: {
        id: 'run-persisted-0',
        candidateId: 'cand-persisted',
        resultSnapshot: PERSISTED_RESULT,
      } as unknown as ReadRunV1,
    };
  }

  async persistCompletedVerification(): Promise<{
    candidate: PersistedCandidateV1;
    run: PersistedRunV1;
  }> {
    this.persistCalls++;
    throw new Error('must not persist on exact replay');
  }
}

describe('R8.1 §5.1 — exact terminal replay', () => {
  it('returns the persisted snapshot and runs no rules / writes no rows', async () => {
    const repo = new ReplayRepository();
    const service = new BudgetVerificationV1Service(
      new ReplayResolver(),
      repo as unknown as BudgetVerificationRepositoryV1,
    );

    const request: VerificationRequestV1 = {
      manifestLocator: '/m.json',
      manifestDocumentKey: 'r1_fy2027',
      extractionArtifactLocator: '/a.json',
      sourceDocumentId: 'sd-1',
      mode: 'persist_audit',
    };

    const result = await service.verify(request);
    expect(result.verificationRunId).toBe('run-persisted-0');
    expect(result.candidateId).toBe('cand-persisted');
    expect(result.decision).toBe('PASS');
    expect(result.startedAt).toBe('2026-01-01T00:00:00Z');
    expect(repo.findCalls).toBe(1);
    expect(repo.persistCalls).toBe(0);
  });
});
