/**
 * Workstream L3/L4/L7 — Concrete transactional Prisma repository.
 *
 * R3 remediation: Uses generated Prisma types directly. No PrismaLike
 * interface, no `as unknown as` casts, no `findUniqueById`.
 *
 * One transaction must:
 *   1. create or reuse the exact candidate (deterministic ID);
 *   2. set/verify VALIDATING state;
 *   3. insert completed run (deterministic ID);
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
 *
 * R3: Idempotent exact replay — if a terminal candidate exists for the
 * same identity, return the existing immutable result without inserting
 * duplicate evidence.
 */
import type { PrismaClient, Prisma } from '@prisma/client';
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
  computeCandidateId,
  computeRunId,
} from './verification-persistence-mappers.js';

/* ------------------------------------------------------------------ */
/* Terminal status set                                                 */
/* ------------------------------------------------------------------ */

const TERMINAL_STATUSES = new Set([
  'VERIFICATION_PASSED',
  'NEEDS_REVIEW',
  'REJECTED',
  'REVIEW_ACCEPTED',
]);

/* ------------------------------------------------------------------ */
/* Concrete Prisma repository                                          */
/* ------------------------------------------------------------------ */

export class PrismaBudgetVerificationRepositoryV1 implements BudgetVerificationRepositoryV1 {
  constructor(private readonly prisma: PrismaClient) {}

  async findTerminalRunByIdentity(
    identity: CandidateIdentityV1,
  ): Promise<{ candidate: ReadCandidateV1; run: ReadRunV1 } | null> {
    const candidate = await this.prisma.budgetExtractionCandidateV1.findUnique({
      where: {
        cycleId_manifestContentSha256_manifestDocumentKey_sourceDocumentId_sourceSha256_extractionArtifactId_extractionArtifactSha256_verifierVersion_policyVersion_policySha256:
          {
            cycleId: identity.cycleId,
            manifestContentSha256: identity.manifestContentSha256,
            manifestDocumentKey: identity.manifestDocumentKey,
            sourceDocumentId: identity.sourceDocumentId,
            sourceSha256: identity.sourceSha256,
            extractionArtifactId: identity.extractionArtifactId,
            extractionArtifactSha256: identity.extractionArtifactSha256,
            verifierVersion: identity.verifierVersion,
            policyVersion: identity.policyVersion,
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
    // R3: Generate deterministic IDs before persistence
    const candidateId = computeCandidateId(input.candidateIdentity);
    const runId = computeRunId(input.candidateIdentity, input.startedAt);

    return this.prisma.$transaction(async (tx) => {
      const { candidateIdentity, result, proofSnapshots, checks, discrepancies } = input;

      // R3: Idempotent — check for existing terminal candidate
      const existing = await tx.budgetExtractionCandidateV1.findUnique({
        where: {
          cycleId_manifestContentSha256_manifestDocumentKey_sourceDocumentId_sourceSha256_extractionArtifactId_extractionArtifactSha256_verifierVersion_policyVersion_policySha256:
            {
              cycleId: candidateIdentity.cycleId,
              manifestContentSha256: candidateIdentity.manifestContentSha256,
              manifestDocumentKey: candidateIdentity.manifestDocumentKey,
              sourceDocumentId: candidateIdentity.sourceDocumentId,
              sourceSha256: candidateIdentity.sourceSha256,
              extractionArtifactId: candidateIdentity.extractionArtifactId,
              extractionArtifactSha256: candidateIdentity.extractionArtifactSha256,
              verifierVersion: candidateIdentity.verifierVersion,
              policyVersion: candidateIdentity.policyVersion,
              policySha256: candidateIdentity.policySha256,
            },
        },
      });

      if (existing && TERMINAL_STATUSES.has(existing.status)) {
        // R3: Return existing immutable result — no duplicate evidence
        if (existing.currentRunId) {
          const existingRun = await tx.budgetVerificationRunV1.findFirst({
            where: { id: existing.currentRunId },
            orderBy: { createdAt: 'desc' },
          });
          if (existingRun) {
            return {
              candidate: {
                id: existing.id,
                status: existing.status,
                currentRunId: existing.currentRunId,
              },
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

      let candidateIdToUse = candidateId;

      if (existing) {
        // Re-verify: transition to VALIDATING
        assertValidTransition(existing.status, 'VALIDATING');
        // R3: Use updateMany to update candidate (avoids needing findUnique by id
        // inside transaction — updateMany is available on the tx client)
        await tx.budgetExtractionCandidateV1.updateMany({
          where: { id: existing.id },
          data: { status: 'VALIDATING', updatedAt: new Date() },
        });
        candidateIdToUse = existing.id;
      } else {
        // R3: Create new candidate with deterministic ID
        await tx.budgetExtractionCandidateV1.create({
          data: {
            id: candidateId,
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

      // R3: Insert completed run with deterministic ID
      const runRow = mapResultToRunRow(result, candidateIdToUse);
      await tx.budgetVerificationRunV1.create({
        data: {
          id: runId,
          candidateId: runRow.candidateId,
          verifierVersion: runRow.verifierVersion,
          policyVersion: runRow.policyVersion,
          policySha256: runRow.policySha256,
          decision: runRow.decision,
          status: runRow.status,
          route: runRow.route,
          riskScore: runRow.riskScore,
          startedAt: new Date(runRow.startedAt),
          completedAt: new Date(runRow.completedAt),
          manifestContentSha256: runRow.manifestContentSha256,
          extractionArtifactSha256: runRow.extractionArtifactSha256,
          sourceSha256: runRow.sourceSha256,
          resultSnapshot: runRow.resultSnapshot as Prisma.InputJsonValue,
        },
      });

      // R3: Insert proof snapshots
      if (proofSnapshots.length > 0) {
        await tx.budgetVerificationProofV1.createMany({
          data: proofSnapshots.map((s) =>
            mapProofSnapshotToRow(runId, s),
          ) as Prisma.BudgetVerificationProofV1CreateManyInput[],
        });
      }

      // R3: Insert checks
      if (checks.length > 0) {
        await tx.budgetVerificationCheckV1.createMany({
          data: checks.map((c) =>
            mapCheckToRow(runId, c),
          ) as Prisma.BudgetVerificationCheckV1CreateManyInput[],
        });
      }

      // R3: Insert discrepancies
      if (discrepancies.length > 0) {
        await tx.budgetVerificationDiscrepancyV1.createMany({
          data: discrepancies.map((d) =>
            mapDiscrepancyToRow(runId, candidateIdToUse, d),
          ) as Prisma.BudgetVerificationDiscrepancyV1CreateManyInput[],
        });
      }

      // R3: Update final candidate status
      const finalStatus = statusFromDecision(result.decision);
      assertValidTransition('VALIDATING', finalStatus);
      await tx.budgetExtractionCandidateV1.updateMany({
        where: { id: candidateIdToUse },
        data: { status: finalStatus, currentRunId: runId, updatedAt: new Date() },
      });

      return {
        candidate: { id: candidateIdToUse, status: finalStatus, currentRunId: runId },
        run: {
          id: runId,
          candidateId: candidateIdToUse,
          decision: result.decision,
          status: result.status,
          route: result.route,
          riskScore: result.riskScore,
        },
      };
    });
  }

  async persistReviewDecision(
    input: PersistReviewDecisionInputV1,
  ): Promise<PersistedReviewDecisionV1> {
    return this.prisma.$transaction(async (tx) => {
      // R3: Look up candidate by candidateId using findFirst (real Prisma method)
      const candidate = await tx.budgetExtractionCandidateV1.findFirst({
        where: { id: input.candidateId },
      });

      if (!candidate) {
        throw new Error(`candidate not found: ${input.candidateId}`);
      }

      if (candidate.status !== 'NEEDS_REVIEW') {
        throw new Error(
          `candidate ${input.candidateId} is not in NEEDS_REVIEW state (got ${candidate.status})`,
        );
      }

      // R3: Hash binding — verify expected hashes match
      if (candidate.sourceSha256 !== input.expectedSourceSha256) {
        throw new Error('source SHA mismatch — review hash binding failed');
      }
      if (candidate.extractionArtifactSha256 !== input.expectedExtractionArtifactSha256) {
        throw new Error('artifact SHA mismatch — review hash binding failed');
      }
      if (candidate.manifestContentSha256 !== input.expectedManifestContentSha256) {
        throw new Error('manifest SHA mismatch — review hash binding failed');
      }

      // R3: Verify run belongs to candidate
      const run = await tx.budgetVerificationRunV1.findFirst({
        where: { id: input.verificationRunId, candidateId: input.candidateId },
      });
      if (!run) {
        throw new Error(
          `run ${input.verificationRunId} not found for candidate ${input.candidateId}`,
        );
      }

      // R3: Insert immutable review decision
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
          evidenceJson: { evidenceIds: input.evidenceIds } as Prisma.InputJsonValue,
        },
      });

      // R3: Update candidate status
      const newStatus = input.decision === 'accept' ? 'REVIEW_ACCEPTED' : 'REJECTED';
      assertValidTransition('NEEDS_REVIEW', newStatus);
      await tx.budgetExtractionCandidateV1.updateMany({
        where: { id: input.candidateId, status: 'NEEDS_REVIEW' },
        data: { status: newStatus, updatedAt: new Date() },
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
    const row = await this.prisma.budgetExtractionCandidateV1.findFirst({
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
  return new PrismaBudgetVerificationRepositoryV1(prisma);
}
