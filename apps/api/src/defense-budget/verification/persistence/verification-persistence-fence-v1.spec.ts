import type { Prisma, PrismaClient } from '@prisma/client';
import { BudgetVerificationV1Service } from '../services/budget-verification-v1.service.js';
import type { TrustedProofResolutionV1, TrustedVerificationProofBundleV1 } from '../trusted-proof/trusted-proof-types.js';
import type { DefenseBudgetVerificationResultV1, VerificationRequestV1 } from '../verification-contract-v1.js';
import { PrismaBudgetVerificationRepositoryV1 } from './prisma-budget-verification.repository.js';
import { computeCandidateId, computeRunId } from './verification-persistence-mappers.js';
import type { BudgetVerificationRepositoryV1, CandidateIdentityV1, PersistCompletedVerificationInputV1 } from './verification-repository.js';

const sha = 'a'.repeat(64);
const now = '2026-01-01T00:00:00.000Z';
const identity: CandidateIdentityV1 = {
  cycleId: 'cycle-2026', manifestContentSha256: sha, manifestDocumentKey: 'source',
  sourceDocumentId: 'source', sourceSha256: sha, extractionArtifactId: 'artifact',
  extractionArtifactSha256: sha, extractionArtifactLocator: 's3://bucket/artifact',
  verifierVersion: 'defense_budget_verifier_v1', policyVersion: 'defense_budget_verification_policy_v1',
  policySha256: sha,
};
const result: DefenseBudgetVerificationResultV1 = {
  cycleId: identity.cycleId, manifestContentSha256: sha, manifestDocumentKey: 'source',
  sourceDocumentId: 'source', extractionArtifactId: 'artifact', extractionArtifactSha256: sha,
  policySha256: sha,
  verifierVersion: 'defense_budget_verifier_v1', policyVersion: 'defense_budget_verification_policy_v1',
  candidateId: 'snapshot-candidate', verificationRunId: 'snapshot-run', sourcePdfSha256: sha,
  decision: 'REVIEW', status: 'NEEDS_REVIEW', route: 'human_review', riskScore: 100,
  checks: [], discrepancies: [], acceptedAssertionIds: [], rejectedAssertionIds: [],
  referenceArtifactIds: [], startedAt: now, completedAt: now,
};

const proofBundle: TrustedVerificationProofBundleV1 = {
  manifest: { locator: '/manifest.json', contentSha256: sha, cycleId: identity.cycleId, fiscalYear: 2026, documentKey: 'source' },
  extractionArtifact: { locator: identity.extractionArtifactLocator, artifactId: 'artifact', contentSha256: sha, byteSha256: sha, schemaVersion: 'defense_budget_extraction_v1' },
  sourceDocument: { id: 'source', sourceKey: 'source-key', sourceSha256: sha },
  archive: { status: 'verified' }, parserRuns: [], resolvedReferenceArtifacts: [],
};
const input: PersistCompletedVerificationInputV1 = {
  candidateIdentity: identity, result, proofBundle, proofFindings: [], proofSnapshots: [],
  checks: [], discrepancies: [], startedAt: now, completedAt: now,
};

function legacyRows() {
  return {
    candidate: { ...identity, id: 'persisted-candidate', status: 'NEEDS_REVIEW', currentRunId: 'persisted-run', createdAt: now, updatedAt: now },
    run: { ...result, id: 'persisted-run', candidateId: 'persisted-candidate', sourceSha256: sha, resultSnapshot: result, createdAt: now },
  };
}

function harness(options: { existing?: boolean; uniqueConflict?: boolean } = {}) {
  let existing = options.existing ?? false;
  let conflict = options.uniqueConflict ?? false;
  const committed: string[] = [];
  const transactions: Prisma.TransactionClient[] = [];
  const candidateLookup = jest.fn(async () => existing ? legacyRows().candidate : null);
  const runLookup = jest.fn(async () => existing ? legacyRows().run : null);
  const transaction = jest.fn(async (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
    const writes: string[] = [];
    const tx = {
      budgetExtractionCandidateV1: {
        findUnique: candidateLookup,
        create: jest.fn(async () => {
          if (conflict) {
            conflict = false;
            existing = true; // A separate winning transaction has committed.
            throw Object.assign(new Error('unique conflict'), { code: 'P2002' });
          }
          writes.push('candidate');
        }),
        updateMany: jest.fn(async () => { writes.push('final-status'); return { count: 1 }; }),
      },
      budgetVerificationRunV1: {
        findFirst: runLookup,
        create: jest.fn(async () => { writes.push('run'); }),
      },
      budgetVerificationProofV1: { createMany: jest.fn(async () => { writes.push('proof'); }) },
    } as unknown as Prisma.TransactionClient;
    transactions.push(tx);
    const output = await work(tx);
    committed.push(...writes);
    return output;
  });
  const prisma = {
    $transaction: transaction,
    budgetExtractionCandidateV1: { findUnique: candidateLookup },
    budgetVerificationRunV1: { findFirst: runLookup },
  } as unknown as PrismaClient;
  return { prisma, transaction, transactions, committed };
}

describe('optional verification persistence fence', () => {
  it('awaits the checkpoint in the transaction containing candidate, run and evidence writes', async () => {
    const h = harness();
    const checkpoint = jest.fn(async (tx: Prisma.TransactionClient, actualIdentity: CandidateIdentityV1, candidateId: string, runId: string) => {
      await Promise.resolve();
      expect(tx).toBe(h.transactions[0]);
      expect(actualIdentity).toBe(identity);
      expect(candidateId).toBe(computeCandidateId(identity));
      expect(runId).toBe(computeRunId(identity, '0'));
      expect(tx.budgetExtractionCandidateV1.create).toHaveBeenCalledTimes(1);
      expect(tx.budgetVerificationRunV1.create).toHaveBeenCalledTimes(1);
      expect(tx.budgetExtractionCandidateV1.updateMany).toHaveBeenCalledTimes(1);
      expect(h.committed).toEqual([]);
    });
    const repository = new PrismaBudgetVerificationRepositoryV1(h.prisma, checkpoint);
    const saved = await repository.persistCompletedVerification(input);
    expect(saved.candidate.id).toBe(computeCandidateId(identity));
    expect(saved.run.resultSnapshot).toEqual(result);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(h.committed).toEqual(['candidate', 'run', 'proof', 'final-status']);
  });

  it('aborts all fresh writes when the caller rejects the lease checkpoint', async () => {
    const h = harness();
    const repository = new PrismaBudgetVerificationRepositoryV1(h.prisma, async () => { throw new Error('lease lost'); });
    await expect(repository.persistCompletedVerification(input)).rejects.toThrow('lease lost');
    expect(h.committed).toEqual([]);
  });

  it.each(['lookup', 'persist', 'P2002'] as const)('checkpoints exact existing row IDs on %s replay', async (path) => {
    const h = harness({ existing: path !== 'P2002', uniqueConflict: path === 'P2002' });
    const checkpoint = jest.fn(async () => undefined);
    const repository = new PrismaBudgetVerificationRepositoryV1(h.prisma, checkpoint);
    const saved = path === 'lookup'
      ? await repository.findTerminalRunByIdentity(identity)
      : await repository.persistCompletedVerification(input);
    expect(saved?.candidate.id).toBe('persisted-candidate');
    expect(saved?.run.id).toBe('persisted-run');
    expect(saved?.run.resultSnapshot).toEqual(result);
    expect(checkpoint).toHaveBeenCalledWith(h.transactions.at(-1), identity, 'persisted-candidate', 'persisted-run');
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(h.transaction).toHaveBeenCalledTimes(path === 'P2002' ? 2 : 1);
    expect(h.committed).toEqual([]);
  });

  it.each(['lookup', 'persist', 'P2002'] as const)('refuses %s replay when checkpoint fails', async (path) => {
    const h = harness({ existing: path !== 'P2002', uniqueConflict: path === 'P2002' });
    const repository = new PrismaBudgetVerificationRepositoryV1(h.prisma, async () => { throw new Error('lease lost'); });
    const replay = path === 'lookup'
      ? repository.findTerminalRunByIdentity(identity)
      : repository.persistCompletedVerification(input);
    await expect(replay).rejects.toThrow('lease lost');
    expect(h.committed).toEqual([]);
  });

  it('does not checkpoint a cache miss', async () => {
    const h = harness();
    const checkpoint = jest.fn(async () => undefined);
    expect(await new PrismaBudgetVerificationRepositoryV1(h.prisma, checkpoint).findTerminalRunByIdentity(identity)).toBeNull();
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('retains the ordinary unfenced cache path without opening a transaction', async () => {
    const h = harness({ existing: true });
    const saved = await new PrismaBudgetVerificationRepositoryV1(h.prisma).findTerminalRunByIdentity(identity);
    expect(saved?.run.id).toBe('persisted-run');
    expect(h.transaction).not.toHaveBeenCalled();
  });
});

describe('service exact persisted verification IDs', () => {
  const request: VerificationRequestV1 = {
    manifestLocator: '/manifest.json', manifestDocumentKey: 'source',
    extractionArtifactLocator: identity.extractionArtifactLocator, sourceDocumentId: 'source', mode: 'persist_audit',
  };
  function resolution(unsupported: boolean): TrustedProofResolutionV1 {
    return {
      manifest: { cycleId: identity.cycleId },
      manifestDocument: { family: unsupported ? 'unknown' : 'rdte', exhibit: unsupported ? 'UNKNOWN' : 'R-1', authority: 'president_budget', documentKey: 'source', documentType: 'R-1' },
      manifestContentSha256: sha, artifact: { artifactId: 'artifact' },
      extractionArtifactContentSha256: sha, extractionArtifactByteSha256: sha, proofBundle,
      proofFindings: [], referenceArtifacts: [], referenceArtifactsProofBundles: [], referenceArtifactsFindings: [],
    } as unknown as TrustedProofResolutionV1;
  }

  it('replaces legacy snapshot IDs with actual rows on the early cache return', async () => {
    const repository = {
      findTerminalRunByIdentity: jest.fn(async () => legacyRows()),
      persistCompletedVerification: jest.fn(),
    } as unknown as BudgetVerificationRepositoryV1;
    const service = new BudgetVerificationV1Service({ resolve: async () => resolution(false) }, repository);
    const saved = await service.verify(request);
    expect(saved.candidateId).toBe('persisted-candidate');
    expect(saved.verificationRunId).toBe('persisted-run');
    expect(saved.decision).toBe(result.decision);
    expect(repository.persistCompletedVerification).not.toHaveBeenCalled();
  });

  it('returns actual persisted IDs on the unsupported-policy path', async () => {
    const legacy = legacyRows();
    const { resultSnapshot: _snapshot, ...runWithoutSnapshot } = legacy.run;
    const repository = {
      persistCompletedVerification: jest.fn(async () => ({ candidate: legacy.candidate, run: runWithoutSnapshot })),
    } as unknown as BudgetVerificationRepositoryV1;
    const service = new BudgetVerificationV1Service({ resolve: async () => resolution(true) }, repository);
    const saved = await service.verify(request);
    expect(saved.candidateId).toBe('persisted-candidate');
    expect(saved.verificationRunId).toBe('persisted-run');
    expect(saved.decision).toBe('REVIEW');
    expect(saved.checks[0]?.code).toBe('verification_policy_not_implemented');
  });

  it('returns the concurrent winner decision and evidence instead of the losing computation', async () => {
    const winner: DefenseBudgetVerificationResultV1 = {
      ...result, decision: 'REJECT', status: 'REJECTED', route: 'none',
      checks: [{
        checkId: 'winner-check', code: 'winner-proof-failure', ruleVersion: 'v1',
        outcome: 'FAIL', required: true, blocking: true, riskPoints: 100,
        message: 'Persisted winner evidence', assertionIds: [], evidenceIds: ['winner-evidence'], referenceArtifactIds: [],
      }],
    };
    const rows = legacyRows();
    const repository = {
      persistCompletedVerification: jest.fn(async () => ({
        candidate: { ...rows.candidate, status: winner.status },
        run: { ...rows.run, decision: winner.decision, status: winner.status, route: winner.route, resultSnapshot: winner },
      })),
    } as unknown as BudgetVerificationRepositoryV1;
    const service = new BudgetVerificationV1Service({ resolve: async () => resolution(true) }, repository);
    const saved = await service.verify(request);
    expect(saved).toEqual({ ...winner, candidateId: 'persisted-candidate', verificationRunId: 'persisted-run' });
    expect(saved.checks[0]?.evidenceIds).toEqual(['winner-evidence']);
  });
});
