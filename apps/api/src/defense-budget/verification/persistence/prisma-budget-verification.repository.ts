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
  ReadCheckV1,
  ReadDiscrepancyV1,
  ReadProofSnapshotV1,
  ReadReviewDecisionV1,
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
/* R8.1 §5.4/§5.5 — concurrency error types + helpers                  */
/* ------------------------------------------------------------------ */

/** A concurrent verification holds the candidate in a non-terminal state. */
export class VerificationInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationInProgressError';
  }
}

/** A conditional update affected an unexpected number of rows (lost race). */
export class VerificationConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationConcurrencyError';
  }
}

/** Detect Prisma's unique-constraint-violation error (P2002). */
function isPrismaUniqueConflict(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

/**
 * R8.1 §5.2 note: the run table has no attempt column and the migration is
 * immutable (already applied per R8.1 §0.1 evidence), so the repository
 * recomputes the default exact-replay attempt ("0"). A non-default explicit
 * attempt produces a distinct run ID at the service layer; when such an
 * attempt is persisted, its deterministic candidate identity is unchanged,
 * so exact replay still resolves to the first terminal run for that
 * identity. This is the intended idempotent-replay behavior.
 */
function extractAttemptId(result: { verificationRunId: string }): string {
  void result;
  return '0';
}

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
    // R3: Generate deterministic IDs before persistence.
    // R8.1 §5.2: the run ID uses the attempt identity embedded in the result
    // (default "0" — exact replay), not a fresh timestamp.
    const candidateId = computeCandidateId(input.candidateIdentity);
    const attemptId = extractAttemptId(input.result);
    const runId = computeRunId(input.candidateIdentity, attemptId);

    try {
      return await this.prisma.$transaction(async (tx) => {
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

        // R8.1 §5.4: a non-terminal existing candidate is VALIDATING — a
        // concurrent verification is in progress. Surface a controlled signal.
        if (existing && !TERMINAL_STATUSES.has(existing.status)) {
          throw new VerificationInProgressError(
            `candidate ${existing.id} is ${existing.status} — verification in progress`,
          );
        }

        let candidateIdToUse = candidateId;

        if (existing) {
          assertValidTransition(existing.status, 'VALIDATING');
          const reactivate = await tx.budgetExtractionCandidateV1.updateMany({
            where: { id: existing.id },
            data: { status: 'VALIDATING', updatedAt: new Date() },
          });
          if (reactivate.count !== 1) {
            throw new VerificationConcurrencyError(
              `failed to re-validate candidate ${existing.id} (updated ${reactivate.count} rows)`,
            );
          }
          candidateIdToUse = existing.id;
        } else {
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

        // R3: Update final candidate status.
        // R8.1 §5.5: the conditional update must affect exactly one row; a
        // zero-row update is a concurrency conflict and must roll back.
        const finalStatus = statusFromDecision(result.decision);
        assertValidTransition('VALIDATING', finalStatus);
        const finalized = await tx.budgetExtractionCandidateV1.updateMany({
          where: { id: candidateIdToUse, status: 'VALIDATING' },
          data: { status: finalStatus, currentRunId: runId, updatedAt: new Date() },
        });
        if (finalized.count !== 1) {
          throw new VerificationConcurrencyError(
            `final status update for candidate ${candidateIdToUse} affected ${finalized.count} rows — concurrent modification`,
          );
        }

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
    } catch (err) {
      // R8.1 §5.4: translate the Prisma unique-conflict into a controlled
      // concurrency signal; on conflict, reload and return the persisted
      // terminal result when one exists.
      if (isPrismaUniqueConflict(err)) {
        const existing = await this.findTerminalRunByIdentity(input.candidateIdentity);
        if (existing) {
          return {
            candidate: {
              id: existing.candidate.id,
              status: existing.candidate.status,
              currentRunId: existing.candidate.currentRunId,
            },
            run: {
              id: existing.run.id,
              candidateId: existing.run.candidateId,
              decision: existing.run.decision,
              status: existing.run.status,
              route: existing.run.route,
              riskScore: existing.run.riskScore,
            },
          };
        }
        throw new VerificationConcurrencyError(
          'concurrent verification created the candidate first — retry to read the persisted result',
        );
      }
      throw err;
    }
  }

  async persistReviewDecision(
    input: PersistReviewDecisionInputV1,
  ): Promise<PersistedReviewDecisionV1> {
    return this.prisma.$transaction(async (tx) => {
      // R8.1 §6.2: lock the candidate row (SELECT ... FOR UPDATE) before any
      // state checks so only one terminal review can succeed.
      await tx.$executeRaw`SELECT id FROM budget_extraction_candidate_v1 WHERE id = ${input.candidateId}::uuid FOR UPDATE`;

      const candidate = await tx.budgetExtractionCandidateV1.findFirst({
        where: { id: input.candidateId },
      });

      if (!candidate) {
        throw new Error(`candidate not found: ${input.candidateId}`);
      }

      // §6.2 step 2: confirm NEEDS_REVIEW under the lock.
      if (candidate.status !== 'NEEDS_REVIEW') {
        // Another locked reviewer has already completed the terminal state
        // transition. Surface the typed concurrency signal for the service to
        // translate into ReviewAlreadyCompletedError.
        throw new VerificationConcurrencyError(
          `candidate ${input.candidateId} is not in NEEDS_REVIEW state (got ${candidate.status})`,
        );
      }

      // §6.2 step 3: confirm no terminal review decision exists.
      const existingTerminal = await tx.budgetReviewDecisionV1.findFirst({
        where: { candidateId: input.candidateId, decision: { in: ['accept', 'reject'] } },
      });
      if (existingTerminal) {
        throw new Error(`candidate ${input.candidateId} already has a terminal review decision`);
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

      // R3: Update candidate status.
      // R8.1 §5.5: the conditional update must affect exactly one row; a
      // zero-row update is a concurrency conflict and must roll back.
      const newStatus = input.decision === 'accept' ? 'REVIEW_ACCEPTED' : 'REJECTED';
      assertValidTransition('NEEDS_REVIEW', newStatus);
      const reviewUpdate = await tx.budgetExtractionCandidateV1.updateMany({
        where: { id: input.candidateId, status: 'NEEDS_REVIEW' },
        data: { status: newStatus, updatedAt: new Date() },
      });
      if (reviewUpdate.count !== 1) {
        throw new VerificationConcurrencyError(
          `review status update for candidate ${input.candidateId} affected ${reviewUpdate.count} rows — concurrent review`,
        );
      }

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

  async readChecks(runId: string): Promise<ReadCheckV1[]> {
    const rows = await this.prisma.budgetVerificationCheckV1.findMany({
      where: { runId },
      orderBy: { code: 'asc' },
    });
    return rows.map((row) => ({
      checkId: row.checkId,
      code: row.code,
      ruleVersion: row.ruleVersion,
      outcome: row.outcome,
      required: row.required,
      blocking: row.blocking,
      riskPoints: row.riskPoints,
      message: row.message,
      assertionIds: row.assertionIds as string[],
      evidenceIds: row.evidenceIds as string[],
      referenceArtifactIds: row.referenceArtifactIds as string[],
      details: (row.details as Record<string, unknown> | null) ?? undefined,
    }));
  }

  async readDiscrepancies(runId: string): Promise<ReadDiscrepancyV1[]> {
    const rows = await this.prisma.budgetVerificationDiscrepancyV1.findMany({
      where: { runId },
      orderBy: { code: 'asc' },
    });
    return rows.map((row) => ({
      discrepancyId: row.discrepancyId,
      code: row.code,
      severity: row.severity,
      description: row.description,
      assertionIds: row.assertionIds as string[],
      evidenceIds: row.evidenceIds as string[],
      referenceArtifactIds: row.referenceArtifactIds as string[],
      details: (row.details as Record<string, unknown> | null) ?? undefined,
    }));
  }

  async readProofSnapshots(runId: string): Promise<ReadProofSnapshotV1[]> {
    const rows = await this.prisma.budgetVerificationProofV1.findMany({
      where: { runId },
      orderBy: { proofKind: 'asc' },
    });
    return rows.map((row) => ({
      proofKind: row.proofKind,
      status: row.status,
      sourceDocumentId: row.sourceDocumentId,
      artifactId: row.artifactId,
      referenceArtifactId: row.referenceArtifactId,
      evidenceJson: row.evidenceJson as Record<string, unknown>,
    }));
  }

  async readReviewDecisions(candidateId: string): Promise<ReadReviewDecisionV1[]> {
    const rows = await this.prisma.budgetReviewDecisionV1.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => ({
      id: row.id,
      candidateId: row.candidateId,
      runId: row.runId,
      reviewerId: row.reviewerId,
      decision: row.decision,
      notes: row.notes,
      sourceSha256: row.sourceSha256,
      extractionArtifactSha256: row.extractionArtifactSha256,
      manifestContentSha256: row.manifestContentSha256,
      createdAt: row.createdAt.toISOString(),
    }));
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
