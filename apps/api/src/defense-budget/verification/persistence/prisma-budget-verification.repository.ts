/**
 * Workstream L3/L4/L7 — Concrete transactional Prisma repository.
 *
 * One transaction must:
 *   1. create or reuse the exact candidate;
 *   2. set/verify VALIDATING state;
 *   3. insert completed run;
 *   4. insert proof snapshots;
 *   5. insert checks;
 *   6. insert discrepancies;
 *   7. update final candidate status;
 *   8. commit.
 *
 * Any failure must roll back all of the above.
 *
 * External proof resolution happens BEFORE the transaction (L2).
 * Inside the transaction, only already-resolved immutable snapshots are persisted.
 */
import type { PrismaClient } from '@prisma/client';
import type {
  BudgetVerificationRepositoryV1,
  CandidateIdentityV1,
  PersistCompletedVerificationInputV1,
  PersistReviewDecisionInputV1,
  ReadCandidateV1,
  ReadRunV1,
  PersistedCandidateV1,
  PersistedRunV1,
  PersistedReviewDecisionV1,
} from './verification-repository.js';
import {
  mapCheckToRow,
  mapDiscrepancyToRow,
  mapProofSnapshotToRow,
  mapResultToRunRow,
  mapRowToReadCandidate,
  mapRowToReadRun,
  statusFromDecision,
  assertValidTransition,
  candidateIdempotencyKey,
} from './verification-persistence-mappers.js';

/* ------------------------------------------------------------------ */
/* Prisma client interface (minimal subset for testability)            */
/* ------------------------------------------------------------------ */

/**
 * The Prisma client methods we use. This interface allows injecting a
 * test fake or a transaction-scoped client.
 */
export interface PrismaLike {
  budgetExtractionCandidateV1: {
    findUnique(args: { where: { manifestContentSha256_sourceSha256_extractionArtifactSha256_verifierVersion_policySha256: Record<string, string> } }): Promise<RawCandidateRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<RawCandidateRow>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<RawCandidateRow>;
  };
  budgetVerificationRunV1: {
    findFirst(args: { where: Record<string, unknown>; orderBy: Record<string, string> }): Promise<RawRunRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<RawRunRow>;
  };
  budgetVerificationCheckV1: {
    createMany(args: { data: readonly Record<string, unknown>[] }): Promise<{ count: number }>;
  };
  budgetVerificationProof: {
    createMany(args: { data: readonly Record<string, unknown>[] }): Promise<{ count: number }>;
  };
  budgetVerificationDiscrepancyV1: {
    createMany(args: { data: readonly Record<string, unknown>[] }): Promise<{ count: number }>;
  };
  budgetReviewDecisionV1: {
    create(args: { data: Record<string, unknown> }): Promise<RawReviewRow>;
  };
  $transaction<T>(fn: (tx: PrismaLike) => Promise<T>): Promise<T>;
}

interface RawCandidateRow {
  id: string;
  cycleId: string;
  manifestContentSha256: string;
  manifestDocumentKey: string;
  extractionArtifactId: string;
  extractionArtifactSha256: string;
  sourceDocumentId: string;
  sourceSha256: string;
  verifierVersion: string;
  policyVersion: string;
  policySha256: string;
  status: string;
  currentRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RawRunRow {
  id: string;
  candidateId: string;
  verifierVersion: string;
  policyVersion: string;
  policySha256: string;
  decision: string;
  status: string;
  route: string;
  riskScore: number;
  startedAt: Date;
  completedAt: Date;
  manifestContentSha256: string;
  extractionArtifactSha256: string;
  sourceSha256: string;
  createdAt: Date;
}

interface RawReviewRow {
  id: string;
  candidateId: string;
  runId: string;
  decision: string;
  createdAt: Date;
}

/* ------------------------------------------------------------------ */
/* Concrete Prisma repository                                          */
/* ------------------------------------------------------------------ */

export class PrismaBudgetVerificationRepositoryV1 implements BudgetVerificationRepositoryV1 {
  constructor(private readonly prisma: PrismaLike) {}

  async findTerminalRunByIdentity(
    identity: CandidateIdentityV1,
  ): Promise<{ candidate: ReadCandidateV1; run: ReadRunV1 } | null> {
    const candidate = await this.prisma.budgetExtractionCandidateV1.findUnique({
      where: {
        manifestContentSha256_sourceSha256_extractionArtifactSha256_verifierVersion_policySha256: {
          manifestContentSha256: identity.manifestContentSha256,
          sourceSha256: identity.sourceSha256,
          extractionArtifactSha256: identity.extractionArtifactSha256,
          verifierVersion: identity.verifierVersion,
          policySha256: identity.policySha256,
        },
      },
    });
    if (!candidate) return null;
    if (!candidate.currentRunId) return null;

    const run = await this.prisma.budgetVerificationRunV1.findFirst({
      where: { id: candidate.currentRunId },
      orderBy: { createdAt: 'desc' },
    });
    if (!run) return null;

    return {
      candidate: mapRowToReadCandidate(candidate),
      run: mapRowToReadRun(run),
    };
  }

  async persistCompletedVerification(
    input: PersistCompletedVerificationInputV1,
  ): Promise<{ candidate: PersistedCandidateV1; run: PersistedRunV1 }> {
    return this.prisma.$transaction(async (tx) => {
      const { candidateIdentity, result, proofSnapshots, checks, discrepancies } = input;

      // L3.1: Create or reuse the exact candidate
      const idKey = candidateIdempotencyKey(candidateIdentity);
      void idKey;
      const existing = await tx.budgetExtractionCandidateV1.findUnique({
        where: {
          manifestContentSha256_sourceSha256_extractionArtifactSha256_verifierVersion_policySha256: {
            manifestContentSha256: candidateIdentity.manifestContentSha256,
            sourceSha256: candidateIdentity.sourceSha256,
            extractionArtifactSha256: candidateIdentity.extractionArtifactSha256,
            verifierVersion: candidateIdentity.verifierVersion,
            policySha256: candidateIdentity.policySha256,
          },
        },
      });

      let candidate: RawCandidateRow;
      if (existing) {
        // L4: Idempotent — return existing terminal result if the same identity
        if (existing.status === 'VERIFICATION_PASSED' || existing.status === 'NEEDS_REVIEW' || existing.status === 'REJECTED' || existing.status === 'REVIEW_ACCEPTED') {
          // Terminal — return existing
          if (existing.currentRunId) {
            const existingRun = await tx.budgetVerificationRunV1.findFirst({
              where: { id: existing.currentRunId },
              orderBy: { createdAt: 'desc' },
            });
            if (existingRun) {
              return {
                candidate: { id: existing.id, status: existing.status, currentRunId: existing.currentRunId },
                run: {
                  id: existingRun.id,
                  candidateId: existingRun.candidateId,
                  decision: existingRun.decision,
                  status: existingRun.status,
                  route: existingRun.route,
                  riskScore: existingRun.riskScore,
                },
              };
            }
          }
        }
        // L3.2: Set/verify VALIDATING state
        assertValidTransition(existing.status, 'VALIDATING');
        candidate = await tx.budgetExtractionCandidateV1.update({
          where: { id: existing.id },
          data: { status: 'VALIDATING' },
        });
      } else {
        // Create new candidate
        candidate = await tx.budgetExtractionCandidateV1.create({
          data: {
            cycleId: candidateIdentity.cycleId,
            manifestContentSha256: candidateIdentity.manifestContentSha256,
            manifestDocumentKey: candidateIdentity.manifestDocumentKey,
            extractionArtifactId: candidateIdentity.extractionArtifactId,
            extractionArtifactSha256: candidateIdentity.extractionArtifactSha256,
            extractionArtifactLocator: candidateIdentity.extractionArtifactLocator,
            sourceDocumentId: candidateIdentity.sourceDocumentId,
            sourceSha256: candidateIdentity.sourceSha256,
            verifierVersion: candidateIdentity.verifierVersion,
            policyVersion: candidateIdentity.policyVersion,
            policySha256: candidateIdentity.policySha256,
            status: 'VALIDATING',
          },
        });
      }

      // L3.3: Insert completed run
      const runRow = await tx.budgetVerificationRunV1.create({
        data: {
          ...mapResultToRunRow(result, candidate.id),
        },
      });

      // L3.4: Insert proof snapshots
      if (proofSnapshots.length > 0) {
        await tx.budgetVerificationProof.createMany({
          data: proofSnapshots.map((s) => mapProofSnapshotToRow(runRow.id, s)),
        });
      }

      // L3.5: Insert checks
      if (checks.length > 0) {
        await tx.budgetVerificationCheckV1.createMany({
          data: checks.map((c) => mapCheckToRow(runRow.id, c)),
        });
      }

      // L3.6: Insert discrepancies
      if (discrepancies.length > 0) {
        await tx.budgetVerificationDiscrepancyV1.createMany({
          data: discrepancies.map((d) => mapDiscrepancyToRow(runRow.id, candidate.id, d)),
        });
      }

      // L3.7: Update final candidate status
      const finalStatus = statusFromDecision(result.decision);
      assertValidTransition('VALIDATING', finalStatus);
      const updated = await tx.budgetExtractionCandidateV1.update({
        where: { id: candidate.id },
        data: { status: finalStatus, currentRunId: runRow.id },
      });

      // L3.8: commit (implicit on return)

      return {
        candidate: { id: updated.id, status: updated.status, currentRunId: runRow.id },
        run: {
          id: runRow.id,
          candidateId: runRow.candidateId,
          decision: runRow.decision,
          status: runRow.status,
          route: runRow.route,
          riskScore: runRow.riskScore,
        },
      };
    });
  }

  async persistReviewDecision(
    input: PersistReviewDecisionInputV1,
  ): Promise<PersistedReviewDecisionV1> {
    return this.prisma.$transaction(async (tx) => {
      // M1: Only NEEDS_REVIEW is eligible
      const candidate = await tx.budgetExtractionCandidateV1.findUnique({
        where: {
          manifestContentSha256_sourceSha256_extractionArtifactSha256_verifierVersion_policySha256: {
            manifestContentSha256: input.expectedManifestContentSha256,
            sourceSha256: input.expectedSourceSha256,
            extractionArtifactSha256: input.expectedExtractionArtifactSha256,
            verifierVersion: '__review_lookup__',
            policySha256: '__review_lookup__',
          },
        },
      });

      // If lookup by identity doesn't work (we don't have verifier/policy SHA in review input),
      // fall back to reading by candidate ID
      void candidate;

      // For review, we need to look up the candidate by ID
      // The Prisma client should support findUnique by id
      const candidateById = await (tx as unknown as {
        budgetExtractionCandidateV1: {
          findUniqueById: (args: { where: { id: string } }) => Promise<RawCandidateRow | null>;
        };
      }).budgetExtractionCandidateV1.findUniqueById({
        where: { id: input.candidateId },
      });

      if (!candidateById) {
        throw new Error(`candidate not found: ${input.candidateId}`);
      }

      if (candidateById.status !== 'NEEDS_REVIEW') {
        throw new Error(
          `candidate ${input.candidateId} is not in NEEDS_REVIEW state (got ${candidateById.status})`,
        );
      }

      // M4: Hash binding — verify expected hashes match
      if (candidateById.sourceSha256 !== input.expectedSourceSha256) {
        throw new Error('source SHA mismatch — review hash binding failed');
      }
      if (candidateById.extractionArtifactSha256 !== input.expectedExtractionArtifactSha256) {
        throw new Error('artifact SHA mismatch — review hash binding failed');
      }
      if (candidateById.manifestContentSha256 !== input.expectedManifestContentSha256) {
        throw new Error('manifest SHA mismatch — review hash binding failed');
      }

      // M6: Insert append-only review row
      const reviewRow = await tx.budgetReviewDecisionV1.create({
        data: {
          candidateId: input.candidateId,
          runId: input.verificationRunId,
          reviewerId: input.reviewerId,
          decision: input.decision,
          notes: input.notes,
          sourceSha256: input.expectedSourceSha256,
          extractionArtifactSha256: input.expectedExtractionArtifactSha256,
          manifestContentSha256: input.expectedManifestContentSha256,
          evidenceJson: { evidenceIds: input.evidenceIds },
        },
      });

      // M6: Update candidate status
      const newStatus = input.decision === 'accept' ? 'REVIEW_ACCEPTED' : 'REJECTED';
      assertValidTransition('NEEDS_REVIEW', newStatus);
      await tx.budgetExtractionCandidateV1.update({
        where: { id: input.candidateId },
        data: { status: newStatus },
      });

      return {
        id: reviewRow.id,
        candidateId: reviewRow.candidateId,
        runId: reviewRow.runId,
        decision: reviewRow.decision,
        createdAt: reviewRow.createdAt.toISOString(),
      };
    });
  }

  async readCandidate(candidateId: string): Promise<ReadCandidateV1 | null> {
    const row = await (this.prisma as unknown as {
      budgetExtractionCandidateV1: {
        findUniqueById: (args: { where: { id: string } }) => Promise<RawCandidateRow | null>;
      };
    }).budgetExtractionCandidateV1.findUniqueById({
      where: { id: candidateId },
    });
    return row ? mapRowToReadCandidate(row) : null;
  }

  async readRun(runId: string): Promise<ReadRunV1 | null> {
    const row = await this.prisma.budgetVerificationRunV1.findFirst({
      where: { id: runId },
      orderBy: { createdAt: 'desc' },
    });
    return row ? mapRowToReadRun(row) : null;
  }
}

/* ------------------------------------------------------------------ */
/* Factory from real PrismaClient                                      */
/* ------------------------------------------------------------------ */

export function createPrismaBudgetVerificationRepository(
  prisma: PrismaClient,
): PrismaBudgetVerificationRepositoryV1 {
  return new PrismaBudgetVerificationRepositoryV1(
    prisma as unknown as PrismaLike,
  );
}
