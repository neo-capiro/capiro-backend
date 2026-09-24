/**
 * phase10b41-hardening.integration.spec -- Phase 10B-41 continuation:
 * disposable-Postgres, no-mocks proof of two of the three PR #1680 hardening
 * fixes that live in this module (the third, the orchestrator's
 * reconciliation + revoked-scope guard, is proven in
 * `../../../../scripts/replace-defense-budget-candidate-approvals-v1.integration.spec.ts`
 * since it is that script's own logic):
 *
 *   1. DUPLICATE-INVOCATION / CONCURRENT-RACE CRASH: before this fix, when
 *      two `commitCandidateCorrectionAtomicallyV1` invocations raced to
 *      correct the SAME old candidate AND that old candidate had at least
 *      one currently-active scoped-fact-review row, the LOSING invocation's
 *      own supersede-all UPDATE could lose the underlying Postgres row-lock
 *      race (not the insert-level unique-index race, which was already
 *      handled) and raise `guard_budget_scoped_fact_review_v1_update()`'s
 *      trigger -- a raw, uncaught `PrismaClientUnknownRequestError`, not the
 *      same clean `CandidateCorrectionError` the ordinary insert-conflict
 *      race already produced. This file reproduces that EXACT interleaving
 *      deterministically (not by hoping `Promise.all` schedules it that way
 *      -- see `raceCommitAgainstHeldLock` below) and proves the fixed
 *      function resolves it identically to the already-handled case.
 *   2. DESTRUCTIVE REVERSE-CORRECTION: before this fix, nothing refused
 *      recording a correction link whose `newCandidateId` already stood as
 *      the `oldCandidateId` of an EXISTING link -- i.e. resurrecting an
 *      already-superseded candidate as if it were an authoritative
 *      correction again. This file proves the refusal fires BEFORE any
 *      write (a dry-run preview already reports `eligible: false`, and a
 *      `commit: true` attempt performs zero writes).
 *
 * No MinIO/S3 needed: `CandidateCorrectionV1Service` never touches the
 * extraction artifact, only candidate identity/status via
 * `BudgetVerificationRepositoryV1.readCandidate` -- gated on `DATABASE_URL`
 * alone, exactly like this module's own `candidate-correction-repository-v1.spec.ts`
 * fake-Prisma suite, but here against a REAL disposable Postgres with the
 * REAL migration's real triggers and real unique indexes.
 *
 * Run with (self-provisions and tears down its own disposable Postgres):
 *   DATABASE_URL=postgresql://... pnpm --filter @capiro/api test -- phase10b41-hardening
 */
import { randomUUID, createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { createPrismaBudgetVerificationRepository } from '../../verification/persistence/prisma-budget-verification.repository.js';
import {
  CandidateCorrectionV1Service,
  CandidateCorrectionError,
} from './candidate-correction-v1.service.js';
import {
  PrismaCandidateCorrectionRepositoryV1,
  buildCandidateCorrectionReviewedIntentV1,
  commitCandidateCorrectionAtomicallyV1,
  isScopedFactReviewImmutabilityGuardConflict,
} from './candidate-correction-repository-v1.js';
import {
  computeScopedFactReviewVerificationStateHashV1,
  PrismaScopedFactReviewRepositoryV1,
  SCOPED_FACT_REVIEW_ELIGIBILITY_STATE_VERSION_V1,
  type ScopedFactReviewReconciliationExpectationV1,
  ScopedFactReviewWriteConflictV1,
} from '../scoped-fact-review/scoped-fact-review-repository-v1.js';
import {
  SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
  scopedFactReviewScopeKeyV1,
} from '../scoped-fact-review/scoped-fact-review-policy-v1.js';
import { reconcileCommittedApprovalsV1 } from '../../../../scripts/replace-defense-budget-candidate-approvals-v1.js';

const DATABASE_URL = process.env.DATABASE_URL?.trim();
const HELD_TRANSACTION_OPTIONS = {
  maxWait: 30_000,
  timeout: 60_000,
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
};

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

const describeE2E = isLocalUrl(DATABASE_URL) ? describe : describe.skip;

function fakeHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

describeE2E(
  'Phase 10B-41 hardening -- candidate-correction (real disposable Postgres, no mocks)',
  () => {
    jest.setTimeout(60_000);

    let prisma: PrismaClient;

    beforeAll(async () => {
      // These tests deliberately need a blocker, two correction writers, and a
      // lock-state observer alive at once. Pin the local test pool explicitly so
      // an observer can never be starved by the interleaving it must prove.
      const databaseUrl = new URL(DATABASE_URL!);
      databaseUrl.searchParams.set('connection_limit', '8');
      databaseUrl.searchParams.set('pool_timeout', '30');
      prisma = new PrismaClient({
        datasources: { db: { url: databaseUrl.toString() } },
        transactionOptions: HELD_TRANSACTION_OPTIONS,
      });
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    async function directSourceDocument(): Promise<{ id: string; sourceSha256: string }> {
      const id = randomUUID();
      const sourceSha256 = fakeHash(`source:${id}`);
      await prisma.sourceDocument.create({
        data: {
          id,
          sourceKey: `phase10b41-hardening-${id}`,
          fiscalYear: 2024,
          budgetCycle: 'pb',
          component: 'ARMY',
          documentType: 'r2',
          title: 'phase10b41 hardening fixture (no real archive)',
          sourceUrl: 'https://example.invalid/phase10b41-hardening.pdf',
          sha256: sourceSha256,
          extractionMethod: 'deterministic_pdf',
        },
      });
      return { id, sourceSha256 };
    }

    async function directCandidate(input: {
      sourceDocumentId: string;
      sourceSha256: string;
      status: string;
    }): Promise<string> {
      const id = randomUUID();
      const seed = `${id}:${input.sourceDocumentId}`;
      await prisma.budgetExtractionCandidateV1.create({
        data: {
          id,
          cycleId: `fy2024:${randomUUID()}`,
          manifestContentSha256: fakeHash(`manifest:${seed}`),
          manifestDocumentKey: `manifest-key:${seed}`,
          extractionArtifactId: `artifact:${seed}`,
          extractionArtifactSha256: fakeHash(`artifact-sha:${seed}`),
          sourceDocumentId: input.sourceDocumentId,
          sourceSha256: input.sourceSha256,
          verifierVersion: 'phase10b41-hardening-v1',
          policyVersion: '1.0.0',
          policySha256: fakeHash(`policy:${seed}`),
          status: input.status,
        },
      });
      return id;
    }

    async function directRun(
      candidateId: string,
      candidate: {
        sourceSha256: string;
        extractionArtifactSha256: string;
        manifestContentSha256: string;
      },
      setCurrent = true,
    ): Promise<string> {
      const id = randomUUID();
      await prisma.budgetVerificationRunV1.create({
        data: {
          id,
          candidateId,
          verifierVersion: 'phase10b41-hardening-v1',
          policyVersion: '1.0.0',
          policySha256: fakeHash(`run-policy:${id}`),
          decision: 'REVIEW',
          status: 'NEEDS_REVIEW',
          route: 'human_review',
          riskScore: 0,
          startedAt: new Date(),
          completedAt: new Date(),
          manifestContentSha256: candidate.manifestContentSha256,
          extractionArtifactSha256: candidate.extractionArtifactSha256,
          sourceSha256: candidate.sourceSha256,
          resultSnapshot: {},
        },
      });
      if (setCurrent) {
        await prisma.budgetExtractionCandidateV1.update({
          where: { id: candidateId },
          data: { currentRunId: id },
        });
      }
      return id;
    }

    function correctionCommitBindings(
      oldCandidate: {
        currentRunId: string | null;
        extractionArtifactId: string;
        extractionArtifactSha256: string;
        manifestContentSha256: string;
      },
      newCandidate: {
        currentRunId: string | null;
        extractionArtifactId: string;
        extractionArtifactSha256: string;
        manifestContentSha256: string;
      },
    ) {
      return {
        oldCandidateCurrentRunId: oldCandidate.currentRunId,
        oldCandidateExtractionArtifactId: oldCandidate.extractionArtifactId,
        oldCandidateExtractionArtifactSha256: oldCandidate.extractionArtifactSha256,
        oldCandidateManifestContentSha256: oldCandidate.manifestContentSha256,
        newCandidateCurrentRunId: newCandidate.currentRunId,
        newCandidateExtractionArtifactId: newCandidate.extractionArtifactId,
        newCandidateExtractionArtifactSha256: newCandidate.extractionArtifactSha256,
        newCandidateManifestContentSha256: newCandidate.manifestContentSha256,
      };
    }

    type CorrectionCandidateFixtureV1 = {
      id: string;
      status: string;
      currentRunId: string | null;
      sourceDocumentId: string;
      sourceSha256: string;
      extractionArtifactId: string;
      extractionArtifactSha256: string;
      manifestContentSha256: string;
    };

    function rawCorrectionCreateData(
      oldCandidate: CorrectionCandidateFixtureV1,
      newCandidate: CorrectionCandidateFixtureV1,
      actor: string,
      selectedScopes: Parameters<
        typeof buildCandidateCorrectionReviewedIntentV1
      >[0]['selectedScopes'] = [],
    ): Prisma.BudgetCandidateCorrectionV1UncheckedCreateInput {
      const reviewedIntent = buildCandidateCorrectionReviewedIntentV1({
        oldCandidateId: oldCandidate.id,
        newCandidateId: newCandidate.id,
        oldCandidateCurrentRunId: oldCandidate.currentRunId,
        oldCandidateSourceDocumentId: oldCandidate.sourceDocumentId,
        oldCandidateSourceSha256: oldCandidate.sourceSha256,
        oldCandidateExtractionArtifactId: oldCandidate.extractionArtifactId,
        oldCandidateExtractionArtifactSha256: oldCandidate.extractionArtifactSha256,
        oldCandidateManifestContentSha256: oldCandidate.manifestContentSha256,
        newCandidateCurrentRunId: newCandidate.currentRunId,
        newCandidateSourceDocumentId: newCandidate.sourceDocumentId,
        newCandidateSourceSha256: newCandidate.sourceSha256,
        newCandidateExtractionArtifactId: newCandidate.extractionArtifactId,
        newCandidateExtractionArtifactSha256: newCandidate.extractionArtifactSha256,
        newCandidateManifestContentSha256: newCandidate.manifestContentSha256,
        selectedScopes,
      });
      return {
        id: randomUUID(),
        oldCandidateId: oldCandidate.id,
        newCandidateId: newCandidate.id,
        oldCandidateStatusAtCorrection: oldCandidate.status,
        oldCandidateSourceDocumentId: oldCandidate.sourceDocumentId,
        oldCandidateSourceSha256: oldCandidate.sourceSha256,
        newCandidateSourceDocumentId: newCandidate.sourceDocumentId,
        newCandidateSourceSha256: newCandidate.sourceSha256,
        reviewedIntentVersion: 1,
        reviewedIntent: reviewedIntent as unknown as Prisma.InputJsonValue,
        supersededScopedFactReviewIds: [],
        actor,
        reason: `${actor}: raw trigger boundary proof`,
      };
    }

    async function directActiveScopedApproval(input: {
      candidateId: string;
      runId: string;
      sourceDocumentId: string;
      sourceSha256: string;
      extractionArtifactId: string;
      extractionArtifactSha256: string;
      manifestContentSha256: string;
      peCode: string;
    }): Promise<string> {
      const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
      const scope = {
        scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
        peCode: input.peCode,
        fiscalYear: 2024,
        fundingField: 'request' as const,
        component: 'ARMY',
      };
      const result = await reviews.insertDecision({
        candidateId: input.candidateId,
        runId: input.runId,
        sourceDocumentId: input.sourceDocumentId,
        sourceSha256: input.sourceSha256,
        extractionArtifactId: input.extractionArtifactId,
        extractionArtifactSha256: input.extractionArtifactSha256,
        manifestContentSha256: input.manifestContentSha256,
        policyId: 'phase10b41-hardening-policy-v1',
        policyVersion: '1',
        policySha256: fakeHash(`review-policy:${input.candidateId}`),
        scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
        scopeKey: scopedFactReviewScopeKeyV1(scope),
        scope,
        assertionIds: [],
        evidenceIds: [],
        projection: null,
        independence: null,
        limitations: [],
        decision: 'approve',
        reviewerId: 'phase10b41-hardening-reviewer',
        rationale:
          'phase10b41 hardening: seeded active approval to exercise the supersede-all race',
        decisionHash: fakeHash(`decision:${input.candidateId}:${input.peCode}`),
        eligibilityStateVersion: SCOPED_FACT_REVIEW_ELIGIBILITY_STATE_VERSION_V1,
        eligibilityStateSha256: await eligibilityStateHashForRun(input.runId),
        now: new Date().toISOString(),
      });
      return result.row.id;
    }

    async function eligibilityStateHashForRun(runId: string): Promise<string> {
      const verification = createPrismaBudgetVerificationRepository(prisma);
      const [run, checks, discrepancies, proofSnapshots] = await Promise.all([
        verification.readRun(runId),
        verification.readChecks(runId),
        verification.readDiscrepancies(runId),
        verification.readProofSnapshots(runId),
      ]);
      if (run == null) throw new Error(`test run ${runId} not found`);
      return computeScopedFactReviewVerificationStateHashV1({
        run,
        checks,
        discrepancies,
        proofSnapshots,
      });
    }

    async function scopedDecisionInput(input: {
      candidate: {
        id: string;
        sourceDocumentId: string;
        sourceSha256: string;
        extractionArtifactId: string;
        extractionArtifactSha256: string;
        manifestContentSha256: string;
      };
      runId: string;
      peCode: string;
      rationale: string;
      acknowledgedRevokedReviewId?: string | null;
    }): Promise<Parameters<PrismaScopedFactReviewRepositoryV1['insertDecision']>[0]> {
      const scope = {
        scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
        peCode: input.peCode,
        fiscalYear: 2024,
        fundingField: 'request' as const,
        component: 'ARMY',
      };
      return {
        candidateId: input.candidate.id,
        runId: input.runId,
        sourceDocumentId: input.candidate.sourceDocumentId,
        sourceSha256: input.candidate.sourceSha256,
        extractionArtifactId: input.candidate.extractionArtifactId,
        extractionArtifactSha256: input.candidate.extractionArtifactSha256,
        manifestContentSha256: input.candidate.manifestContentSha256,
        policyId: 'phase10b41-scoped-boundary-policy',
        policyVersion: '1',
        policySha256: fakeHash(`scope-policy:${input.candidate.id}:${input.peCode}`),
        scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
        scopeKey: scopedFactReviewScopeKeyV1(scope),
        scope,
        assertionIds: [`assertion:${input.peCode}`],
        evidenceIds: [`evidence:${input.peCode}`],
        projection: null,
        independence: null,
        limitations: [],
        decision: 'approve',
        reviewerId: 'phase10b41-boundary-reviewer',
        rationale: input.rationale,
        decisionHash: fakeHash(`decision:${input.candidate.id}:${input.peCode}:${input.rationale}`),
        eligibilityStateVersion: SCOPED_FACT_REVIEW_ELIGIBILITY_STATE_VERSION_V1,
        eligibilityStateSha256: await eligibilityStateHashForRun(input.runId),
        acknowledgedRevokedReviewId: input.acknowledgedRevokedReviewId ?? null,
        now: new Date().toISOString(),
      };
    }

    function scopedDecisionCreateData(
      input: Parameters<PrismaScopedFactReviewRepositoryV1['insertDecision']>[0],
      id = randomUUID(),
    ): Prisma.BudgetScopedFactReviewV1UncheckedCreateInput {
      return {
        id,
        candidateId: input.candidateId,
        runId: input.runId,
        sourceDocumentId: input.sourceDocumentId,
        sourceSha256: input.sourceSha256,
        extractionArtifactId: input.extractionArtifactId,
        extractionArtifactSha256: input.extractionArtifactSha256,
        manifestContentSha256: input.manifestContentSha256,
        policyId: input.policyId,
        policyVersion: input.policyVersion,
        policySha256: input.policySha256,
        scopeKind: input.scopeKind,
        scopeKey: input.scopeKey,
        scope: input.scope as unknown as Prisma.InputJsonValue,
        assertionIds: input.assertionIds as unknown as Prisma.InputJsonValue,
        evidenceIds: input.evidenceIds as unknown as Prisma.InputJsonValue,
        projection: (input.projection ?? {}) as unknown as Prisma.InputJsonValue,
        independence: (input.independence ?? {}) as unknown as Prisma.InputJsonValue,
        limitations: input.limitations as unknown as Prisma.InputJsonValue,
        decision: input.decision,
        reviewerId: input.reviewerId,
        rationale: input.rationale,
        decisionHash: input.decisionHash,
        eligibilityStateVersion: input.eligibilityStateVersion,
        eligibilityStateSha256: input.eligibilityStateSha256,
        acknowledgedRevokedReviewId: input.acknowledgedRevokedReviewId ?? null,
        status: 'active',
      };
    }

    async function waitForLockWaiters(minimum: bigint, detail: string): Promise<void> {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT count(*)::bigint AS count
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
      `);
        if ((waiting[0]?.count ?? 0n) >= minimum) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(detail);
    }

    describe('Fix 1: concurrent-race P0001 crash on the supersede-all UPDATE', () => {
      /**
       * Deterministically reproduces the exact interleaving the defect
       * required, using Prisma's own interactive-transaction API to hold a
       * real, uncommitted UPDATE lock on the target row open until the
       * function under test's own UPDATE has genuinely blocked behind it:
       *
       *   1. Session "interferer" opens a real transaction, UPDATEs the
       *      target scoped-review row (still uncommitted -- holds the row
       *      lock), and signals it has done so.
       *   2. Only once signaled do we invoke the REAL
       *      `commitCandidateCorrectionAtomicallyV1` under test. Its own
       *      `supersedeAllForCandidateWithClientV1` SELECT still sees the row
       *      as `active` (interferer hasn't committed -- Postgres MVCC), so it
       *      attempts the same row's UPDATE, which genuinely blocks on
       *      interferer's real row lock (proven below by timing, not assumed).
       *   3. We then let the interferer commit, unblocking the function under
       *      test's UPDATE; Postgres re-evaluates the trigger's `OLD` against
       *      the now-committed (non-`active`) row and raises -- this is the
       *      REAL defect's exact trigger condition, not a simulation of it.
       */
      async function raceCommitAgainstHeldLock(
        reviewId: string,
        fn: () => Promise<unknown>,
      ): Promise<{ result: unknown; interfererCommitted: boolean }> {
        let signalInterfererHasLocked: () => void;
        const interfererHasLocked = new Promise<void>((resolve) => {
          signalInterfererHasLocked = resolve;
        });
        let releaseInterferer: () => void;
        const interfererCanCommit = new Promise<void>((resolve) => {
          releaseInterferer = resolve;
        });

        const interfererTx = prisma.$transaction(async (tx) => {
          await tx.budgetScopedFactReviewV1.update({
            where: { id: reviewId },
            data: {
              status: 'revoked',
              revokedAt: new Date(),
              revokedBy: 'interferer',
              revocationReason: 'phase10b41 hardening: real concurrent interferer',
            },
          });
          signalInterfererHasLocked();
          await interfererCanCommit; // holds the transaction (and the row lock) open on purpose
        }, HELD_TRANSACTION_OPTIONS);

        await interfererHasLocked;
        const underTestPromise = fn();
        let observedLockWait = false;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT count(*)::bigint AS count
            FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'
        `);
          if ((waiting[0]?.count ?? 0n) > 0n) {
            observedLockWait = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (!observedLockWait) {
          releaseInterferer!();
          await Promise.allSettled([underTestPromise, interfererTx]);
          throw new Error('function under test never entered a PostgreSQL lock wait');
        }
        releaseInterferer!();

        const [result] = await Promise.all([underTestPromise, interfererTx]);
        return { result, interfererCommitted: true };
      }

      it('a concurrent human revocation wins its row lock; correction resumes as an inserted link without claiming a correction winner revoked it', async () => {
        const src = await directSourceDocument();
        const oldId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const newId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const oldRow = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: oldId },
        });
        const runId = await directRun(oldId, oldRow);
        const [oldRowWithRun, newRow] = await Promise.all([
          prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: oldId } }),
          prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: newId } }),
        ]);
        const reviewId = await directActiveScopedApproval({
          candidateId: oldId,
          runId,
          sourceDocumentId: oldRow.sourceDocumentId,
          sourceSha256: oldRow.sourceSha256,
          extractionArtifactId: oldRow.extractionArtifactId,
          extractionArtifactSha256: oldRow.extractionArtifactSha256,
          manifestContentSha256: oldRow.manifestContentSha256,
          peCode: '0611001A',
        });

        const now = new Date().toISOString();
        const { result } = await raceCommitAgainstHeldLock(reviewId, () =>
          commitCandidateCorrectionAtomicallyV1(prisma as never, {
            oldCandidateId: oldId,
            newCandidateId: newId,
            oldCandidateStatusAtCorrection: oldRow.status,
            ...correctionCommitBindings(oldRowWithRun, newRow),
            oldCandidateSourceDocumentId: oldRow.sourceDocumentId,
            oldCandidateSourceSha256: oldRow.sourceSha256,
            newCandidateSourceDocumentId: src.id,
            newCandidateSourceSha256: src.sourceSha256,
            actor: 'phase10b41-under-test',
            reason: 'phase10b41 hardening: function under test',
            supersessionReason: 'phase10b41 hardening: function under test supersession',
            now,
          }),
        );

        // READ COMMITTED rechecks the status predicate after the held row lock
        // is released. The human-revoked row drops out of the correction's
        // active set; the correction itself can still be recorded, with an
        // honest empty supersession ledger rather than a fake "winner".
        expect(result).toMatchObject({ outcome: 'inserted', supersededScopedFactReviewIds: [] });

        // The review row is exactly what the human interferer left, and the
        // link does not falsely list it as superseded by the correction.
        const links = await prisma.budgetCandidateCorrectionV1.findMany({
          where: { oldCandidateId: oldId },
        });
        expect(links).toHaveLength(1);
        expect(links[0]!.supersededScopedFactReviewIds).toEqual([]);
        const reviewRow = await prisma.budgetScopedFactReviewV1.findUniqueOrThrow({
          where: { id: reviewId },
        });
        expect(reviewRow.status).toBe('revoked');
        expect(reviewRow.revokedBy).toBe('interferer');
      });

      it('two correction invocations queue behind the graph lock with an active old approval: one inserts, one cleanly loses, no orphaned supersession', async () => {
        const src = await directSourceDocument();
        const oldId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const candA = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const candB = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const oldRow = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: oldId },
        });
        const runId = await directRun(oldId, oldRow);
        const [oldRowWithRun, candARow, candBRow] = await Promise.all([
          prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: oldId } }),
          prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: candA } }),
          prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: candB } }),
        ]);
        const reviewId = await directActiveScopedApproval({
          candidateId: oldId,
          runId,
          sourceDocumentId: oldRow.sourceDocumentId,
          sourceSha256: oldRow.sourceSha256,
          extractionArtifactId: oldRow.extractionArtifactId,
          extractionArtifactSha256: oldRow.extractionArtifactSha256,
          manifestContentSha256: oldRow.manifestContentSha256,
          peCode: '0611002A',
        });
        const now = new Date().toISOString();

        const commit = (newCandidate: typeof candARow) =>
          commitCandidateCorrectionAtomicallyV1(prisma as never, {
            oldCandidateId: oldId,
            newCandidateId: newCandidate.id,
            oldCandidateStatusAtCorrection: oldRow.status,
            ...correctionCommitBindings(oldRowWithRun, newCandidate),
            oldCandidateSourceDocumentId: oldRow.sourceDocumentId,
            oldCandidateSourceSha256: oldRow.sourceSha256,
            newCandidateSourceDocumentId: src.id,
            newCandidateSourceSha256: src.sourceSha256,
            actor: 'regression',
            reason: 'regression race',
            supersessionReason: 'regression supersession',
            now,
          });

        let signalGraphHeld!: () => void;
        const graphHeld = new Promise<void>((resolve) => {
          signalGraphHeld = resolve;
        });
        let releaseGraph!: () => void;
        const graphMayCommit = new Promise<void>((resolve) => {
          releaseGraph = resolve;
        });
        const blocker = prisma.$transaction(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended('budget_candidate_correction_v1:graph', 0))) AS acquired`,
          );
          signalGraphHeld();
          await graphMayCommit;
        }, HELD_TRANSACTION_OPTIONS);
        await graphHeld;

        const aPromise = commit(candARow);
        const bPromise = commit(candBRow);
        let queued = false;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT count(*)::bigint AS count
            FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'
        `);
          if ((waiting[0]?.count ?? 0n) >= 2n) {
            queued = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (!queued) {
          releaseGraph();
          await Promise.allSettled([aPromise, bPromise, blocker]);
          throw new Error('both correction invocations did not queue behind the held graph lock');
        }
        releaseGraph();
        const [a, b] = await Promise.all([aPromise, bPromise, blocker]);
        const outcomes = [a.outcome, b.outcome].sort();
        expect(outcomes).toEqual(['conflict', 'inserted']);
        const conflict = a.outcome === 'conflict' ? a : b;
        expect(conflict).toMatchObject({ outcome: 'conflict', conflictOn: 'old_candidate' });
        const links = await prisma.budgetCandidateCorrectionV1.findMany({
          where: { oldCandidateId: oldId },
        });
        expect(links).toHaveLength(1);
        expect(links[0]!.supersededScopedFactReviewIds).toEqual([reviewId]);
        const review = await prisma.budgetScopedFactReviewV1.findUniqueOrThrow({
          where: { id: reviewId },
        });
        expect(review.status).toBe('superseded');
      });

      it('isScopedFactReviewImmutabilityGuardConflict does not misfire on an unrelated error', () => {
        expect(isScopedFactReviewImmutabilityGuardConflict(new Error('connection reset'))).toBe(
          false,
        );
        expect(
          isScopedFactReviewImmutabilityGuardConflict(
            new Error('code: "P0001" -- some unrelated trigger elsewhere'),
          ),
        ).toBe(false);
        expect(isScopedFactReviewImmutabilityGuardConflict(null)).toBe(false);
        expect(isScopedFactReviewImmutabilityGuardConflict('not an error')).toBe(false);
      });

      it("matches the real already-revoked trigger error but not the same trigger's decision-column programmer error", async () => {
        const src = await directSourceDocument();
        const candidateId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const candidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: candidateId },
        });
        const runId = await directRun(candidateId, candidate);
        const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);

        const revokedInput = await scopedDecisionInput({
          candidate,
          runId,
          peCode: '0611008A',
          rationale: 'real trigger matcher positive fixture',
        });
        const revoked = await reviews.insertDecision(revokedInput);
        await reviews.revoke({
          id: revoked.row.id,
          actor: 'trigger-matcher-test',
          reason: 'make the row immutable before a stale update',
          now: new Date().toISOString(),
        });
        let staleStatusError: unknown;
        try {
          await prisma.budgetScopedFactReviewV1.update({
            where: { id: revoked.row.id },
            data: { status: 'superseded' },
          });
        } catch (error) {
          staleStatusError = error;
        }
        expect(staleStatusError).toBeDefined();
        expect(isScopedFactReviewImmutabilityGuardConflict(staleStatusError)).toBe(true);

        const activeInput = await scopedDecisionInput({
          candidate,
          runId,
          peCode: '0611009A',
          rationale: 'real trigger matcher negative fixture',
        });
        const active = await reviews.insertDecision(activeInput);
        let decisionMutationError: unknown;
        try {
          await prisma.budgetScopedFactReviewV1.update({
            where: { id: active.row.id },
            data: { status: 'revoked', rationale: 'illegal decision-column mutation' },
          });
        } catch (error) {
          decisionMutationError = error;
        }
        expect(decisionMutationError).toBeDefined();
        expect(String(decisionMutationError)).toContain('decision columns are immutable');
        expect(isScopedFactReviewImmutabilityGuardConflict(decisionMutationError)).toBe(false);
        expect(
          (
            await prisma.budgetScopedFactReviewV1.findUniqueOrThrow({
              where: { id: active.row.id },
            })
          ).status,
        ).toBe('active');
      });
    });

    describe('reviewed correction intent trigger backstop', () => {
      it.each([
        'selectedScopes',
        'scope',
        'expectedPhysicalPage',
        'expectedAssertionIds',
        'expectedEvidenceIds',
      ] as const)(
        'raw INSERT refuses reviewed intent missing required %s',
        async (missingField) => {
          const src = await directSourceDocument();
          const oldId = await directCandidate({
            sourceDocumentId: src.id,
            sourceSha256: src.sourceSha256,
            status: 'NEEDS_REVIEW',
          });
          const newId = await directCandidate({
            sourceDocumentId: src.id,
            sourceSha256: src.sourceSha256,
            status: 'NEEDS_REVIEW',
          });
          const oldBeforeRun = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
            where: { id: oldId },
          });
          const newBeforeRun = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
            where: { id: newId },
          });
          await directRun(oldId, oldBeforeRun);
          await directRun(newId, newBeforeRun);
          const oldCandidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
            where: { id: oldId },
          });
          const newCandidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
            where: { id: newId },
          });
          const scope = {
            scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
            peCode: '0611099A',
            fiscalYear: 2024,
            fundingField: 'request' as const,
            component: 'ARMY',
          };
          const reviewedIntent = buildCandidateCorrectionReviewedIntentV1({
            oldCandidateId: oldId,
            newCandidateId: newId,
            oldCandidateCurrentRunId: oldCandidate.currentRunId,
            oldCandidateSourceDocumentId: oldCandidate.sourceDocumentId,
            oldCandidateSourceSha256: oldCandidate.sourceSha256,
            oldCandidateExtractionArtifactId: oldCandidate.extractionArtifactId,
            oldCandidateExtractionArtifactSha256: oldCandidate.extractionArtifactSha256,
            oldCandidateManifestContentSha256: oldCandidate.manifestContentSha256,
            newCandidateCurrentRunId: newCandidate.currentRunId,
            newCandidateSourceDocumentId: newCandidate.sourceDocumentId,
            newCandidateSourceSha256: newCandidate.sourceSha256,
            newCandidateExtractionArtifactId: newCandidate.extractionArtifactId,
            newCandidateExtractionArtifactSha256: newCandidate.extractionArtifactSha256,
            newCandidateManifestContentSha256: newCandidate.manifestContentSha256,
            selectedScopes: [
              {
                scopeKind: scope.scopeKind,
                scopeKey: scopedFactReviewScopeKeyV1(scope),
                scope,
                expectedTotalMillions: '10.5',
                expectedPhysicalPage: 101,
                expectedAssertionIds: ['assertion-a'],
                expectedEvidenceIds: ['evidence-a'],
              },
            ],
          }) as unknown as Record<string, unknown>;
          const malformedIntent = structuredClone(reviewedIntent) as Record<string, unknown>;
          if (missingField === 'selectedScopes') {
            delete malformedIntent.selectedScopes;
          } else {
            const selectedScopes = malformedIntent.selectedScopes as Array<Record<string, unknown>>;
            delete selectedScopes[0]![missingField];
          }

          await expect(
            prisma.budgetCandidateCorrectionV1.create({
              data: {
                oldCandidateId: oldId,
                newCandidateId: newId,
                oldCandidateStatusAtCorrection: oldCandidate.status,
                oldCandidateSourceDocumentId: oldCandidate.sourceDocumentId,
                oldCandidateSourceSha256: oldCandidate.sourceSha256,
                newCandidateSourceDocumentId: newCandidate.sourceDocumentId,
                newCandidateSourceSha256: newCandidate.sourceSha256,
                reviewedIntentVersion: 1,
                reviewedIntent: malformedIntent as Prisma.InputJsonValue,
                supersededScopedFactReviewIds: [],
                actor: 'raw-intent-negative',
                reason: `missing ${missingField} must fail closed`,
              },
            }),
          ).rejects.toThrow('[candidate_correction_reviewed_intent]');
          expect(
            await prisma.budgetCandidateCorrectionV1.count({ where: { oldCandidateId: oldId } }),
          ).toBe(0);
        },
      );

      it.each(['oldCandidate', 'newCandidate'] as const)(
        'raw INSERT refuses a no-run reviewed intent that omits %s.currentRunId instead of recording an incomplete null snapshot',
        async (side) => {
          const src = await directSourceDocument();
          const oldId = await directCandidate({
            sourceDocumentId: src.id,
            sourceSha256: src.sourceSha256,
            status: 'NEEDS_REVIEW',
          });
          const newId = await directCandidate({
            sourceDocumentId: src.id,
            sourceSha256: src.sourceSha256,
            status: 'NEEDS_REVIEW',
          });
          const oldCandidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
            where: { id: oldId },
          });
          const newCandidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
            where: { id: newId },
          });
          expect(oldCandidate.currentRunId).toBeNull();
          expect(newCandidate.currentRunId).toBeNull();
          const data = rawCorrectionCreateData(oldCandidate, newCandidate, `raw-no-run-${side}`);
          const malformedIntent = structuredClone(data.reviewedIntent) as unknown as Record<
            string,
            unknown
          >;
          delete (malformedIntent[side] as Record<string, unknown>).currentRunId;
          data.reviewedIntent = malformedIntent as Prisma.InputJsonValue;

          await expect(prisma.budgetCandidateCorrectionV1.create({ data })).rejects.toThrow(
            '[candidate_correction_reviewed_intent]',
          );
          expect(
            await prisma.budgetCandidateCorrectionV1.count({ where: { oldCandidateId: oldId } }),
          ).toBe(0);
        },
      );

      const malformedScopeCases: Array<[string, (intent: Record<string, unknown>) => void]> = [
        [
          'scopeKey disagrees with the nested scope',
          (intent) => {
            (intent.selectedScopes as Array<Record<string, unknown>>)[0]!.scopeKey =
              'not-the-canonical-key';
          },
        ],
        [
          'scope has an extra key',
          (intent) => {
            const item = (intent.selectedScopes as Array<Record<string, unknown>>)[0]!;
            (item.scope as Record<string, unknown>).extra = 'not-v1';
          },
        ],
        [
          'scope omits peCode',
          (intent) => {
            const item = (intent.selectedScopes as Array<Record<string, unknown>>)[0]!;
            delete (item.scope as Record<string, unknown>).peCode;
          },
        ],
        [
          'scope uses a fractional fiscalYear',
          (intent) => {
            const item = (intent.selectedScopes as Array<Record<string, unknown>>)[0]!;
            (item.scope as Record<string, unknown>).fiscalYear = 2024.5;
          },
        ],
        [
          'scope uses a non-request fundingField',
          (intent) => {
            const item = (intent.selectedScopes as Array<Record<string, unknown>>)[0]!;
            (item.scope as Record<string, unknown>).fundingField = 'actual';
          },
        ],
        [
          'scope has an empty component',
          (intent) => {
            const item = (intent.selectedScopes as Array<Record<string, unknown>>)[0]!;
            (item.scope as Record<string, unknown>).component = '';
          },
        ],
        [
          'expected total is not numeric',
          (intent) => {
            (intent.selectedScopes as Array<Record<string, unknown>>)[0]!.expectedTotalMillions =
              'NaN';
          },
        ],
        [
          'physical page is not a positive integer',
          (intent) => {
            (intent.selectedScopes as Array<Record<string, unknown>>)[0]!.expectedPhysicalPage = 0;
          },
        ],
        [
          'assertion ids are empty',
          (intent) => {
            (intent.selectedScopes as Array<Record<string, unknown>>)[0]!.expectedAssertionIds = [];
          },
        ],
        [
          'assertion ids contain a non-string',
          (intent) => {
            (intent.selectedScopes as Array<Record<string, unknown>>)[0]!.expectedAssertionIds = [
              'assertion-a',
              { invalid: true },
            ];
          },
        ],
        [
          'assertion ids contain duplicates',
          (intent) => {
            (intent.selectedScopes as Array<Record<string, unknown>>)[0]!.expectedAssertionIds = [
              'assertion-a',
              'assertion-a',
            ];
          },
        ],
        [
          'evidence ids contain a non-string',
          (intent) => {
            (intent.selectedScopes as Array<Record<string, unknown>>)[0]!.expectedEvidenceIds = [
              'evidence-a',
              null,
            ];
          },
        ],
        [
          'evidence ids contain duplicates',
          (intent) => {
            (intent.selectedScopes as Array<Record<string, unknown>>)[0]!.expectedEvidenceIds = [
              'evidence-a',
              'evidence-a',
            ];
          },
        ],
        [
          'selectedScopes repeats a scopeKey',
          (intent) => {
            const scopes = intent.selectedScopes as Array<Record<string, unknown>>;
            scopes.push(structuredClone(scopes[0]!));
          },
        ],
      ];

      it.each(malformedScopeCases)(
        'raw INSERT refuses malformed selected scope: %s',
        async (_caseName, mutate) => {
          const src = await directSourceDocument();
          const oldId = await directCandidate({
            sourceDocumentId: src.id,
            sourceSha256: src.sourceSha256,
            status: 'NEEDS_REVIEW',
          });
          const newId = await directCandidate({
            sourceDocumentId: src.id,
            sourceSha256: src.sourceSha256,
            status: 'NEEDS_REVIEW',
          });
          const oldCandidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
            where: { id: oldId },
          });
          const newCandidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
            where: { id: newId },
          });
          const scope = {
            scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
            peCode: '0611094A',
            fiscalYear: 2024,
            fundingField: 'request' as const,
            component: 'ARMY',
          };
          const data = rawCorrectionCreateData(oldCandidate, newCandidate, 'raw-malformed-scope', [
            {
              scopeKind: scope.scopeKind,
              scopeKey: scopedFactReviewScopeKeyV1(scope),
              scope,
              expectedTotalMillions: '10.5',
              expectedPhysicalPage: 101,
              expectedAssertionIds: ['assertion-a'],
              expectedEvidenceIds: ['evidence-a'],
            },
          ]);
          const malformedIntent = structuredClone(data.reviewedIntent) as unknown as Record<
            string,
            unknown
          >;
          mutate(malformedIntent);
          data.reviewedIntent = malformedIntent as Prisma.InputJsonValue;

          await expect(prisma.budgetCandidateCorrectionV1.create({ data })).rejects.toThrow(
            '[candidate_correction_reviewed_intent]',
          );
          expect(
            await prisma.budgetCandidateCorrectionV1.count({ where: { oldCandidateId: oldId } }),
          ).toBe(0);
        },
      );
    });

    describe('direct-writer trigger isolation contract', () => {
      it('fails raw scoped-review, verification-evidence, and correction inserts closed at REPEATABLE READ', async () => {
        const src = await directSourceDocument();
        const oldId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const newId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const oldBeforeRun = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: oldId },
        });
        const newBeforeRun = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: newId },
        });
        const [runId] = await Promise.all([
          directRun(oldId, oldBeforeRun),
          directRun(newId, newBeforeRun),
        ]);
        const oldCandidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: oldId },
        });
        const newCandidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: newId },
        });
        const reviewInput = await scopedDecisionInput({
          candidate: oldCandidate,
          runId,
          peCode: '0611095A',
          rationale: 'raw isolation-level refusal fixture',
        });
        const repeatableRead = {
          ...HELD_TRANSACTION_OPTIONS,
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        };

        // A valid-looking raw insert at the safe isolation still cannot invent
        // the repository's transaction-local eligibility attestation.
        await expect(
          prisma.budgetScopedFactReviewV1.create({
            data: scopedDecisionCreateData(reviewInput),
          }),
        ).rejects.toThrow('[scoped_fact_review_unsanctioned_writer]');

        await expect(
          prisma.$transaction(async (tx) => {
            await tx.$queryRaw(
              Prisma.sql`SELECT set_config('capiro.scoped_fact_review_writer_v1', ${reviewInput.eligibilityStateSha256}, true)`,
            );
            return tx.budgetScopedFactReviewV1.create({
              data: scopedDecisionCreateData(reviewInput),
            });
          }, repeatableRead),
        ).rejects.toThrow('[scoped_fact_review_requires_read_committed]');

        await expect(
          prisma.$transaction(
            (tx) =>
              tx.budgetVerificationCheckV1.create({
                data: {
                  runId,
                  checkId: `repeatable-read-${randomUUID()}`,
                  code: 'repeatable_read_must_fail_closed',
                  ruleVersion: '1',
                  outcome: 'PASS',
                  required: true,
                  blocking: true,
                  riskPoints: 0,
                  message: 'raw verification evidence must use READ COMMITTED',
                  assertionIds: [],
                  evidenceIds: [],
                  referenceArtifactIds: [],
                  passed: true,
                },
              }),
            repeatableRead,
          ),
        ).rejects.toThrow('[budget_verification_evidence_requires_read_committed]');

        await expect(
          prisma.$transaction(
            (tx) =>
              tx.budgetCandidateCorrectionV1.create({
                data: rawCorrectionCreateData(
                  oldCandidate,
                  newCandidate,
                  'repeatable-read-correction',
                ),
              }),
            repeatableRead,
          ),
        ).rejects.toThrow('[candidate_correction_requires_read_committed]');

        expect(await prisma.budgetScopedFactReviewV1.count({ where: { candidateId: oldId } })).toBe(
          0,
        );
        expect(await prisma.budgetVerificationCheckV1.count({ where: { runId } })).toBe(0);
        expect(
          await prisma.budgetCandidateCorrectionV1.count({
            where: { OR: [{ oldCandidateId: oldId }, { oldCandidateId: newId }] },
          }),
        ).toBe(0);
      });

      it('raw opposite correction INSERTs at READ COMMITTED serialize in their trigger: one link commits and the waiter sees it', async () => {
        const src = await directSourceDocument();
        const aId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const bId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const [aBeforeRun, bBeforeRun] = await Promise.all([
          prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: aId } }),
          prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: bId } }),
        ]);
        await Promise.all([directRun(aId, aBeforeRun), directRun(bId, bBeforeRun)]);
        const [aCandidate, bCandidate] = await Promise.all([
          prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: aId } }),
          prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: bId } }),
        ]);
        const abData = rawCorrectionCreateData(aCandidate, bCandidate, 'raw-read-committed-ab');
        const baData = rawCorrectionCreateData(bCandidate, aCandidate, 'raw-read-committed-ba');

        let signalGraphHeld!: () => void;
        const graphHeld = new Promise<void>((resolve) => {
          signalGraphHeld = resolve;
        });
        let releaseGraph!: () => void;
        const graphMayCommit = new Promise<void>((resolve) => {
          releaseGraph = resolve;
        });
        const blocker = prisma.$transaction(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended('budget_candidate_correction_v1:graph', 0))) AS acquired`,
          );
          signalGraphHeld();
          await graphMayCommit;
        }, HELD_TRANSACTION_OPTIONS);
        await graphHeld;

        const rawInsert = (data: Prisma.BudgetCandidateCorrectionV1UncheckedCreateInput) =>
          prisma
            .$transaction(
              (tx) => tx.budgetCandidateCorrectionV1.create({ data }),
              HELD_TRANSACTION_OPTIONS,
            )
            .then(
              (row) => ({ ok: true as const, row }),
              (error: unknown) => ({ ok: false as const, error }),
            );
        const abAttempt = rawInsert(abData);
        const baAttempt = rawInsert(baData);
        try {
          await waitForLockWaiters(
            2n,
            'raw opposite correction inserts never queued behind the graph trigger lock',
          );
        } catch (error) {
          releaseGraph();
          await Promise.allSettled([abAttempt, baAttempt, blocker]);
          throw error;
        }
        releaseGraph();
        const [ab, ba] = await Promise.all([abAttempt, baAttempt, blocker]);
        const attempts = [ab, ba];
        expect(attempts.filter((attempt) => attempt.ok)).toHaveLength(1);
        const loser = attempts.find((attempt) => !attempt.ok);
        expect(loser).toBeDefined();
        if (loser?.ok !== false) throw new Error('raw opposite correction loser was not observed');
        expect(String(loser.error)).toContain('[candidate_correction_reverse_or_cycle]');
        expect(
          await prisma.budgetCandidateCorrectionV1.count({
            where: { OR: [{ oldCandidateId: aId }, { oldCandidateId: bId }] },
          }),
        ).toBe(1);
      });
    });

    describe('authoritative scoped-review commit boundaries', () => {
      it('one-snapshot reconciliation names live candidate status and identity drift that would invalidate exit 0', async () => {
        const src = await directSourceDocument();
        const candidateId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const candidateBeforeRun = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: candidateId },
        });
        const runId = await directRun(candidateId, candidateBeforeRun);
        const candidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: candidateId },
        });
        const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
        const input = await scopedDecisionInput({
          candidate,
          runId,
          peCode: '0611093A',
          rationale: 'live candidate reconciliation boundary fixture',
        });
        input.projection = {
          peCode: input.scope.peCode,
          peTitle: 'Phase 10B41 reconciliation fixture',
          component: input.scope.component,
          fiscalYear: input.scope.fiscalYear,
          stage: 'request',
          stageLabel: 'Request',
          positionCycle: 'FY2024',
          baseMillions: null,
          ocoMillions: null,
          totalMillions: '10.5',
          units: 'USD millions',
          source: {
            sourceDocumentId: input.sourceDocumentId,
            sourceSha256: input.sourceSha256,
            sourceUrl: null,
            documentType: 'RDT&E justification book',
            exhibit: 'R-2',
            physicalPage: 101,
            artifactId: input.extractionArtifactId,
            artifactContentSha256: input.extractionArtifactSha256,
            identityAssertionId: input.assertionIds[0]!,
            totalAssertionId: input.assertionIds[0]!,
            baseAssertionId: null,
            ocoAssertionId: null,
            evidenceIds: input.evidenceIds,
            sourceFactPaths: [],
            evidenceGranularity: [],
          },
        };
        const inserted = await reviews.insertDecision(input);
        const expectation: ScopedFactReviewReconciliationExpectationV1 = {
          reviewId: inserted.row.id,
          candidateId,
          runId,
          sourceDocumentId: input.sourceDocumentId,
          sourceSha256: input.sourceSha256,
          extractionArtifactId: input.extractionArtifactId,
          extractionArtifactSha256: input.extractionArtifactSha256,
          manifestContentSha256: input.manifestContentSha256,
          scopeKind: input.scopeKind,
          scopeKey: input.scopeKey,
          scope: input.scope,
          policyId: input.policyId,
          policyVersion: input.policyVersion,
          policySha256: input.policySha256,
          reviewerId: input.reviewerId,
          rationale: input.rationale,
          decisionHash: input.decisionHash,
          eligibilityStateVersion: input.eligibilityStateVersion,
          eligibilityStateSha256: input.eligibilityStateSha256,
          acknowledgedRevokedReviewId: null,
          assertionIds: input.assertionIds,
          evidenceIds: input.evidenceIds,
          expectedTotalMillions: '10.5',
          expectedPhysicalPage: 101,
        };
        await expect(reconcileCommittedApprovalsV1(reviews, [expectation])).resolves.toMatchObject({
          conflicts: [],
        });

        await prisma.budgetExtractionCandidateV1.update({
          where: { id: candidateId },
          data: { status: 'REJECTED' },
        });
        const statusConflict = await reconcileCommittedApprovalsV1(reviews, [expectation]);
        expect(statusConflict.conflicts).toHaveLength(1);
        expect(statusConflict.conflicts[0]!.detail).toContain('candidateStatus=REJECTED');

        const driftedArtifactSha256 = fakeHash(`post-approval-artifact-drift:${candidateId}`);
        await prisma.budgetExtractionCandidateV1.update({
          where: { id: candidateId },
          data: {
            status: 'NEEDS_REVIEW',
            extractionArtifactSha256: driftedArtifactSha256,
          },
        });
        const identityConflict = await reconcileCommittedApprovalsV1(reviews, [expectation]);
        expect(identityConflict.conflicts).toHaveLength(1);
        expect(identityConflict.conflicts[0]!.detail).toContain(
          `candidateExtractionArtifactSha256=${driftedArtifactSha256}`,
        );
      });

      it.each(['current run', 'source document/bytes', 'artifact/manifest'] as const)(
        'candidate %s drift held between preview and correction commit wakes to a typed stale refusal with zero writes',
        async (driftKind) => {
          const src = await directSourceDocument();
          const oldId = await directCandidate({
            sourceDocumentId: src.id,
            sourceSha256: src.sourceSha256,
            status: 'NEEDS_REVIEW',
          });
          const newId = await directCandidate({
            sourceDocumentId: src.id,
            sourceSha256: src.sourceSha256,
            status: 'NEEDS_REVIEW',
          });
          const oldBeforeRun = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
            where: { id: oldId },
          });
          const oldRunId = await directRun(oldId, oldBeforeRun);
          const [oldCandidate, newCandidate] = await Promise.all([
            prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: oldId } }),
            prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: newId } }),
          ]);
          const reviewId = await directActiveScopedApproval({
            candidateId: oldId,
            runId: oldRunId,
            sourceDocumentId: oldCandidate.sourceDocumentId,
            sourceSha256: oldCandidate.sourceSha256,
            extractionArtifactId: oldCandidate.extractionArtifactId,
            extractionArtifactSha256: oldCandidate.extractionArtifactSha256,
            manifestContentSha256: oldCandidate.manifestContentSha256,
            peCode: `061102${driftKind === 'current run' ? '0' : driftKind === 'source document/bytes' ? '1' : '2'}A`,
          });

          let updateData: Prisma.BudgetExtractionCandidateV1UncheckedUpdateInput;
          if (driftKind === 'current run') {
            const nextRunId = await directRun(newId, newCandidate, false);
            updateData = { currentRunId: nextRunId };
          } else if (driftKind === 'source document/bytes') {
            const changedSource = await directSourceDocument();
            updateData = {
              sourceDocumentId: changedSource.id,
              sourceSha256: changedSource.sourceSha256,
            };
          } else {
            updateData = {
              extractionArtifactId: `artifact-drift-${randomUUID()}`,
              extractionArtifactSha256: fakeHash(`artifact-drift:${newId}`),
              manifestContentSha256: fakeHash(`manifest-drift:${newId}`),
            };
          }

          let signalDriftHeld!: () => void;
          const driftHeld = new Promise<void>((resolve) => {
            signalDriftHeld = resolve;
          });
          let releaseDrift!: () => void;
          const driftMayCommit = new Promise<void>((resolve) => {
            releaseDrift = resolve;
          });
          const holder = prisma.$transaction(async (tx) => {
            await tx.budgetExtractionCandidateV1.update({ where: { id: newId }, data: updateData });
            signalDriftHeld();
            await driftMayCommit;
          }, HELD_TRANSACTION_OPTIONS);
          await driftHeld;

          const attempt = commitCandidateCorrectionAtomicallyV1(prisma as never, {
            oldCandidateId: oldId,
            newCandidateId: newId,
            oldCandidateStatusAtCorrection: oldCandidate.status,
            ...correctionCommitBindings(oldCandidate, newCandidate),
            oldCandidateSourceDocumentId: oldCandidate.sourceDocumentId,
            oldCandidateSourceSha256: oldCandidate.sourceSha256,
            newCandidateSourceDocumentId: newCandidate.sourceDocumentId,
            newCandidateSourceSha256: newCandidate.sourceSha256,
            actor: 'stale-intent-proof',
            reason: `stale ${driftKind} intent must refuse`,
            supersessionReason: 'must never persist for stale intent',
            now: new Date().toISOString(),
          });
          try {
            await waitForLockWaiters(1n, `correction never waited on held ${driftKind} drift`);
          } catch (error) {
            releaseDrift();
            await Promise.allSettled([attempt, holder]);
            throw error;
          }
          releaseDrift();
          const [result] = await Promise.all([attempt, holder]);
          expect(result).toMatchObject({ outcome: 'stale_eligibility' });
          expect(
            await prisma.budgetCandidateCorrectionV1.count({ where: { oldCandidateId: oldId } }),
          ).toBe(0);
          expect(
            await prisma.budgetScopedFactReviewV1.findUniqueOrThrow({ where: { id: reviewId } }),
          ).toMatchObject({
            status: 'active',
            revokedAt: null,
            revokedBy: null,
          });
        },
      );

      it('a candidate current-run update held across review commit makes the stale run wait, wake, and refuse with zero review rows', async () => {
        const src = await directSourceDocument();
        const candidateId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const candidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: candidateId },
        });
        const run1 = await directRun(candidateId, candidate);
        const run2 = await directRun(candidateId, candidate, false);
        const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
        const input = await scopedDecisionInput({
          candidate,
          runId: run1,
          peCode: '0611010A',
          rationale: 'reviewed intent bound to run 1 before a concurrent run switch',
        });

        let signalWriterLocked!: () => void;
        const writerLocked = new Promise<void>((resolve) => {
          signalWriterLocked = resolve;
        });
        let releaseWriter!: () => void;
        const writerMayCommit = new Promise<void>((resolve) => {
          releaseWriter = resolve;
        });
        const writer = prisma.$transaction(async (tx) => {
          await tx.budgetExtractionCandidateV1.update({
            where: { id: candidateId },
            data: { currentRunId: run2 },
          });
          signalWriterLocked();
          await writerMayCommit;
        }, HELD_TRANSACTION_OPTIONS);
        await writerLocked;

        const reviewAttempt = reviews.insertDecision(input).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        let blocked = false;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT count(*)::bigint AS count
            FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'
        `);
          if ((waiting[0]?.count ?? 0n) > 0n) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (!blocked) {
          releaseWriter();
          await Promise.allSettled([reviewAttempt, writer]);
          throw new Error('stale-run review never blocked on the candidate fence');
        }
        releaseWriter();
        const [attempt] = await Promise.all([reviewAttempt, writer]);
        expect(attempt.ok).toBe(false);
        if (attempt.ok) throw new Error('stale-run review unexpectedly committed');
        expect(attempt.error).toBeInstanceOf(ScopedFactReviewWriteConflictV1);
        expect(attempt.error).toMatchObject({ code: 'candidate_binding_changed' });
        expect(
          await prisma.budgetScopedFactReviewV1.count({
            where: { candidateId, scopeKey: input.scopeKey },
          }),
        ).toBe(0);
        expect(
          (
            await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
              where: { id: candidateId },
            })
          ).currentRunId,
        ).toBe(run2);
      });

      it('a blocking verification child committed after evaluation while review waits makes commit wake and refuse the changed eligibility state', async () => {
        const src = await directSourceDocument();
        const candidateId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const candidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: candidateId },
        });
        const runId = await directRun(candidateId, candidate);
        const input = await scopedDecisionInput({
          candidate,
          runId,
          peCode: '0611014A',
          rationale: 'eligibility was evaluated before a concurrent blocking check appeared',
        });
        const scopeLockKey = `budget_scoped_fact_review_v1:${input.scopeKind}:${input.scopeKey}`;

        let signalScopeHeld!: () => void;
        const scopeHeld = new Promise<void>((resolve) => {
          signalScopeHeld = resolve;
        });
        let releaseScope!: () => void;
        const scopeMayCommit = new Promise<void>((resolve) => {
          releaseScope = resolve;
        });
        const holder = prisma.$transaction(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${scopeLockKey}, 0))) AS acquired`,
          );
          signalScopeHeld();
          await scopeMayCommit;
        }, HELD_TRANSACTION_OPTIONS);
        await scopeHeld;

        const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
        const reviewAttempt = reviews.insertDecision(input).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          await waitForLockWaiters(
            1n,
            'scoped review never waited after its eligibility snapshot was evaluated',
          );
          await prisma.budgetVerificationCheckV1.create({
            data: {
              runId,
              checkId: `late-blocking-${randomUUID()}`,
              code: 'late_blocking_check',
              ruleVersion: '1',
              outcome: 'FAIL',
              required: true,
              blocking: true,
              riskPoints: 100,
              message: 'committed while the already-evaluated review waited on its scope',
              assertionIds: [],
              evidenceIds: [],
              referenceArtifactIds: [],
              details: { deterministicRace: true },
              passed: false,
            },
          });
        } catch (error) {
          releaseScope();
          await Promise.allSettled([reviewAttempt, holder]);
          throw error;
        }
        releaseScope();
        const [attempt] = await Promise.all([reviewAttempt, holder]);
        expect(attempt.ok).toBe(false);
        if (attempt.ok)
          throw new Error('review unexpectedly committed after eligibility evidence changed');
        expect(attempt.error).toBeInstanceOf(ScopedFactReviewWriteConflictV1);
        expect(attempt.error).toMatchObject({ code: 'eligibility_state_changed' });
        expect(
          await prisma.budgetScopedFactReviewV1.count({
            where: { candidateId, scopeKey: input.scopeKey },
          }),
        ).toBe(0);
        expect(
          await prisma.budgetVerificationCheckV1.count({
            where: { runId, code: 'late_blocking_check' },
          }),
        ).toBe(1);
      });

      it('review-first run sealing makes a late verification child wait, then fail closed after the review commits', async () => {
        const src = await directSourceDocument();
        const candidateId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const candidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: candidateId },
        });
        const runId = await directRun(candidateId, candidate);
        const input = await scopedDecisionInput({
          candidate,
          runId,
          peCode: '0611015A',
          rationale: 'review-first evidence sealing proof',
        });
        const reviewId = randomUUID();
        const scopeLockKey = `budget_scoped_fact_review_v1:${input.scopeKind}:${input.scopeKey}`;
        const evidenceLockKey = `budget_verification_evidence_v1:${runId}`;

        let signalReviewHeld!: () => void;
        const reviewHeld = new Promise<void>((resolve) => {
          signalReviewHeld = resolve;
        });
        let releaseReview!: () => void;
        const reviewMayCommit = new Promise<void>((resolve) => {
          releaseReview = resolve;
        });
        const holder = prisma.$transaction(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${scopeLockKey}, 0))) AS acquired`,
          );
          await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "budget_extraction_candidate_v1" WHERE "id" = ${candidateId}::uuid FOR SHARE
        `);
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${evidenceLockKey}, 0))) AS acquired`,
          );
          await tx.$queryRaw(Prisma.sql`
          SELECT "id" FROM "budget_verification_run_v1" WHERE "id" = ${runId}::uuid FOR UPDATE
        `);
          await tx.$queryRaw(
            Prisma.sql`SELECT set_config('capiro.scoped_fact_review_writer_v1', ${input.eligibilityStateSha256}, true)`,
          );
          await tx.budgetScopedFactReviewV1.create({
            data: scopedDecisionCreateData(input, reviewId),
          });
          signalReviewHeld();
          await reviewMayCommit;
        }, HELD_TRANSACTION_OPTIONS);
        await reviewHeld;

        const childAttempt = prisma.budgetVerificationCheckV1
          .create({
            data: {
              runId,
              checkId: `post-review-${randomUUID()}`,
              code: 'post_review_append',
              ruleVersion: '1',
              outcome: 'FAIL',
              required: true,
              blocking: true,
              riskPoints: 100,
              message: 'must never append after review history exists',
              assertionIds: [],
              evidenceIds: [],
              referenceArtifactIds: [],
              passed: false,
            },
          })
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        try {
          await waitForLockWaiters(
            1n,
            'late evidence append never waited on the review-held run seal',
          );
        } catch (error) {
          releaseReview();
          await Promise.allSettled([childAttempt, holder]);
          throw error;
        }
        releaseReview();
        const [child] = await Promise.all([childAttempt, holder]);
        expect(child.ok).toBe(false);
        if (child.ok)
          throw new Error('late verification child unexpectedly appended after review history');
        expect(String(child.error)).toContain('[budget_verification_evidence_sealed]');
        expect(await prisma.budgetScopedFactReviewV1.count({ where: { id: reviewId } })).toBe(1);
        expect(
          await prisma.budgetVerificationCheckV1.count({
            where: { runId, code: 'post_review_append' },
          }),
        ).toBe(0);
      });

      it('an exact revoked-review acknowledgement cannot cover a newer revocation committed while the caller waits on the scope lock', async () => {
        const src = await directSourceDocument();
        const candidateId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const candidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: candidateId },
        });
        const runId = await directRun(candidateId, candidate);
        const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
        const firstInput = await scopedDecisionInput({
          candidate,
          runId,
          peCode: '0611011A',
          rationale: 'generation one reviewer action',
        });
        const first = await reviews.insertDecision(firstInput);
        await reviews.revoke({
          id: first.row.id,
          actor: 'human-one',
          reason: 'generation one revoked',
          // Deliberately later than generation two's timestamp below. Client
          // clock skew must never make this older review look latest.
          now: '2099-01-01T00:00:00.000Z',
        });

        let signalNewerRevocationHeld!: () => void;
        const newerRevocationHeld = new Promise<void>((resolve) => {
          signalNewerRevocationHeld = resolve;
        });
        let releaseNewerRevocation!: () => void;
        const newerRevocationMayCommit = new Promise<void>((resolve) => {
          releaseNewerRevocation = resolve;
        });
        const secondId = randomUUID();
        const holder = prisma.$transaction(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${'budget_scoped_fact_review_v1:' + firstInput.scopeKind + ':' + firstInput.scopeKey}, 0))) AS acquired`,
          );
          await tx.$queryRaw(
            Prisma.sql`SELECT set_config('capiro.scoped_fact_review_writer_v1', ${firstInput.eligibilityStateSha256}, true)`,
          );
          await tx.budgetScopedFactReviewV1.create({
            data: {
              id: secondId,
              candidateId,
              runId,
              sourceDocumentId: candidate.sourceDocumentId,
              sourceSha256: candidate.sourceSha256,
              extractionArtifactId: candidate.extractionArtifactId,
              extractionArtifactSha256: candidate.extractionArtifactSha256,
              manifestContentSha256: candidate.manifestContentSha256,
              policyId: firstInput.policyId,
              policyVersion: firstInput.policyVersion,
              policySha256: firstInput.policySha256,
              scopeKind: firstInput.scopeKind,
              scopeKey: firstInput.scopeKey,
              scope: firstInput.scope as unknown as Prisma.InputJsonValue,
              assertionIds: firstInput.assertionIds,
              evidenceIds: firstInput.evidenceIds,
              projection: {},
              independence: {},
              limitations: [],
              decision: 'approve',
              reviewerId: 'human-two',
              rationale: 'generation two fresh reviewer action',
              decisionHash: fakeHash(`second:${secondId}`),
              eligibilityStateVersion: firstInput.eligibilityStateVersion,
              eligibilityStateSha256: firstInput.eligibilityStateSha256,
              acknowledgedRevokedReviewId: first.row.id,
              status: 'active',
            },
          });
          await tx.budgetScopedFactReviewV1.update({
            where: { id: secondId },
            data: {
              status: 'revoked',
              revokedAt: new Date('2000-01-01T00:00:00.000Z'),
              revokedBy: 'human-two',
              revocationReason: 'generation two revoked before stale caller committed',
            },
          });
          signalNewerRevocationHeld();
          await newerRevocationMayCommit;
        }, HELD_TRANSACTION_OPTIONS);
        await newerRevocationHeld;

        const staleInput = await scopedDecisionInput({
          candidate,
          runId,
          peCode: '0611011A',
          rationale: 'stale caller only reviewed generation one revocation',
          acknowledgedRevokedReviewId: first.row.id,
        });
        const staleAttempt = reviews.insertDecision(staleInput).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        let blocked = false;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT count(*)::bigint AS count
            FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'
        `);
          if ((waiting[0]?.count ?? 0n) > 0n) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (!blocked) {
          releaseNewerRevocation();
          await Promise.allSettled([staleAttempt, holder]);
          throw new Error('stale acknowledgement caller never blocked on the scope lock');
        }
        releaseNewerRevocation();
        const [attempt] = await Promise.all([staleAttempt, holder]);
        expect(attempt.ok).toBe(false);
        if (attempt.ok) throw new Error('stale acknowledgement unexpectedly committed');
        expect(attempt.error).toBeInstanceOf(ScopedFactReviewWriteConflictV1);
        expect(attempt.error).toMatchObject({
          code: 'revocation_precondition_changed',
          observedLatestRevokedReviewId: secondId,
        });

        // Bypass the repository precheck to prove the trigger independently
        // uses the database-owned generation rather than revokedAt.
        await expect(
          prisma.$transaction(async (tx) => {
            await tx.$queryRaw(
              Prisma.sql`SELECT set_config('capiro.scoped_fact_review_writer_v1', ${firstInput.eligibilityStateSha256}, true)`,
            );
            await tx.budgetScopedFactReviewV1.create({
              data: {
                candidateId,
                runId,
                sourceDocumentId: candidate.sourceDocumentId,
                sourceSha256: candidate.sourceSha256,
                extractionArtifactId: candidate.extractionArtifactId,
                extractionArtifactSha256: candidate.extractionArtifactSha256,
                manifestContentSha256: candidate.manifestContentSha256,
                policyId: firstInput.policyId,
                policyVersion: firstInput.policyVersion,
                policySha256: firstInput.policySha256,
                scopeKind: firstInput.scopeKind,
                scopeKey: firstInput.scopeKey,
                scope: firstInput.scope as unknown as Prisma.InputJsonValue,
                assertionIds: firstInput.assertionIds,
                evidenceIds: firstInput.evidenceIds,
                projection: {},
                independence: {},
                limitations: [],
                decision: 'approve',
                reviewerId: 'raw-stale-ack',
                rationale: 'raw writer only reviewed generation one',
                decisionHash: fakeHash('raw-stale-generation-one-ack'),
                eligibilityStateVersion: firstInput.eligibilityStateVersion,
                eligibilityStateSha256: firstInput.eligibilityStateSha256,
                acknowledgedRevokedReviewId: first.row.id,
                status: 'active',
              },
            });
          }),
        ).rejects.toThrow(secondId);
        const rows = await prisma.budgetScopedFactReviewV1.findMany({
          where: { candidateId, scopeKey: firstInput.scopeKey },
          orderBy: { createdAt: 'asc' },
        });
        expect(rows).toHaveLength(2);
        expect(rows.every((row) => row.status === 'revoked')).toBe(true);
        expect(rows.find((row) => row.id === secondId)!.acknowledgedRevokedReviewId).toBe(
          first.row.id,
        );
      });

      it('review-first candidate fencing makes correction wait, then include and supersede the committed review in its link ledger', async () => {
        const src = await directSourceDocument();
        const oldId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const newId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const oldCandidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: oldId },
        });
        const newCandidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: newId },
        });
        const runId = await directRun(oldId, oldCandidate);
        const oldCandidateWithRun = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: oldId },
        });
        const reviewInput = await scopedDecisionInput({
          candidate: oldCandidate,
          runId,
          peCode: '0611012A',
          rationale: 'review commits first and must be represented in correction history',
        });
        const reviewId = randomUUID();

        let signalReviewHeld!: () => void;
        const reviewHeld = new Promise<void>((resolve) => {
          signalReviewHeld = resolve;
        });
        let releaseReview!: () => void;
        const reviewMayCommit = new Promise<void>((resolve) => {
          releaseReview = resolve;
        });
        const holder = prisma.$transaction(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${'budget_scoped_fact_review_v1:' + reviewInput.scopeKind + ':' + reviewInput.scopeKey}, 0))) AS acquired`,
          );
          await tx.$queryRaw(
            Prisma.sql`SELECT set_config('capiro.scoped_fact_review_writer_v1', ${reviewInput.eligibilityStateSha256}, true)`,
          );
          await tx.budgetScopedFactReviewV1.create({
            data: scopedDecisionCreateData(reviewInput, reviewId),
          });
          signalReviewHeld();
          await reviewMayCommit;
        }, HELD_TRANSACTION_OPTIONS);
        await reviewHeld;

        const correctionAttempt = commitCandidateCorrectionAtomicallyV1(prisma as never, {
          oldCandidateId: oldId,
          newCandidateId: newId,
          oldCandidateStatusAtCorrection: oldCandidate.status,
          ...correctionCommitBindings(oldCandidateWithRun, newCandidate),
          oldCandidateSourceDocumentId: oldCandidate.sourceDocumentId,
          oldCandidateSourceSha256: oldCandidate.sourceSha256,
          newCandidateSourceDocumentId: newCandidate.sourceDocumentId,
          newCandidateSourceSha256: newCandidate.sourceSha256,
          actor: 'review-first-correction',
          reason: 'review-first candidate fence proof',
          supersessionReason: 'review-first candidate fence proof supersession',
          now: new Date().toISOString(),
        });
        try {
          await waitForLockWaiters(
            1n,
            'correction never waited on the review-first candidate fence',
          );
        } catch (error) {
          releaseReview();
          await Promise.allSettled([correctionAttempt, holder]);
          throw error;
        }
        releaseReview();
        const [result] = await Promise.all([correctionAttempt, holder]);
        expect(result).toMatchObject({
          outcome: 'inserted',
          supersededScopedFactReviewIds: [reviewId],
        });
        const review = await prisma.budgetScopedFactReviewV1.findUniqueOrThrow({
          where: { id: reviewId },
        });
        expect(review.status).toBe('superseded');
        const link = await prisma.budgetCandidateCorrectionV1.findUniqueOrThrow({
          where: { oldCandidateId: oldId },
        });
        expect(link.supersededScopedFactReviewIds).toEqual([reviewId]);
      });

      it('correction-first candidate fencing makes a scoped approval wait, then refuse the corrected-away candidate with zero review rows', async () => {
        const src = await directSourceDocument();
        const oldId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const newId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const oldCandidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: oldId },
        });
        const newCandidate = await prisma.budgetExtractionCandidateV1.findUniqueOrThrow({
          where: { id: newId },
        });
        const runId = await directRun(oldId, oldCandidate);
        const reviewInput = await scopedDecisionInput({
          candidate: oldCandidate,
          runId,
          peCode: '0611013A',
          rationale: 'stale approval attempt after correction began',
        });

        let signalCorrectionHeld!: () => void;
        const correctionHeld = new Promise<void>((resolve) => {
          signalCorrectionHeld = resolve;
        });
        let releaseCorrection!: () => void;
        const correctionMayCommit = new Promise<void>((resolve) => {
          releaseCorrection = resolve;
        });
        const linkId = randomUUID();
        const directCorrectionIntent = buildCandidateCorrectionReviewedIntentV1({
          oldCandidateId: oldId,
          newCandidateId: newId,
          oldCandidateCurrentRunId: runId,
          oldCandidateSourceDocumentId: oldCandidate.sourceDocumentId,
          oldCandidateSourceSha256: oldCandidate.sourceSha256,
          oldCandidateExtractionArtifactId: oldCandidate.extractionArtifactId,
          oldCandidateExtractionArtifactSha256: oldCandidate.extractionArtifactSha256,
          oldCandidateManifestContentSha256: oldCandidate.manifestContentSha256,
          newCandidateCurrentRunId: newCandidate.currentRunId,
          newCandidateSourceDocumentId: newCandidate.sourceDocumentId,
          newCandidateSourceSha256: newCandidate.sourceSha256,
          newCandidateExtractionArtifactId: newCandidate.extractionArtifactId,
          newCandidateExtractionArtifactSha256: newCandidate.extractionArtifactSha256,
          newCandidateManifestContentSha256: newCandidate.manifestContentSha256,
          selectedScopes: [],
        });
        const holder = prisma.$transaction(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended('budget_candidate_correction_v1:graph', 0))) AS acquired`,
          );
          await tx.$queryRaw(Prisma.sql`
          SELECT "id"
            FROM "budget_extraction_candidate_v1"
           WHERE "id" IN (${oldId}::uuid, ${newId}::uuid)
           ORDER BY "id"
           FOR NO KEY UPDATE
        `);
          await tx.budgetCandidateCorrectionV1.create({
            data: {
              id: linkId,
              oldCandidateId: oldId,
              newCandidateId: newId,
              oldCandidateStatusAtCorrection: oldCandidate.status,
              oldCandidateSourceDocumentId: oldCandidate.sourceDocumentId,
              oldCandidateSourceSha256: oldCandidate.sourceSha256,
              newCandidateSourceDocumentId: newCandidate.sourceDocumentId,
              newCandidateSourceSha256: newCandidate.sourceSha256,
              reviewedIntentVersion: 1,
              reviewedIntent: directCorrectionIntent as unknown as Prisma.InputJsonValue,
              supersededScopedFactReviewIds: [],
              actor: 'correction-first-holder',
              reason: 'correction-first candidate fence proof',
            },
          });
          signalCorrectionHeld();
          await correctionMayCommit;
        }, HELD_TRANSACTION_OPTIONS);
        await correctionHeld;

        const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
        const reviewAttempt = reviews.insertDecision(reviewInput).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          await waitForLockWaiters(
            1n,
            'review never waited on the correction-first candidate fence',
          );
        } catch (error) {
          releaseCorrection();
          await Promise.allSettled([reviewAttempt, holder]);
          throw error;
        }
        releaseCorrection();
        const [attempt] = await Promise.all([reviewAttempt, holder]);
        expect(attempt.ok).toBe(false);
        if (attempt.ok) throw new Error('corrected-away review unexpectedly committed');
        expect(attempt.error).toBeInstanceOf(ScopedFactReviewWriteConflictV1);
        expect(attempt.error).toMatchObject({ code: 'candidate_corrected_away' });
        expect(
          await prisma.budgetScopedFactReviewV1.count({
            where: { candidateId: oldId, scopeKey: reviewInput.scopeKey },
          }),
        ).toBe(0);
        expect(
          (await prisma.budgetCandidateCorrectionV1.findUniqueOrThrow({ where: { id: linkId } }))
            .id,
        ).toBe(linkId);
      });
    });

    describe('Fix 3: destructive reverse-correction refused BEFORE any write', () => {
      it('concurrent A->B and B->A attempts serialize at the graph boundary: one forward link, one named cycle refusal, zero losing writes', async () => {
        const src = await directSourceDocument();
        const aId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const bId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const [aBeforeRun, bBeforeRun] = await Promise.all([
          prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: aId } }),
          prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: bId } }),
        ]);
        const [aRunId, bRunId] = await Promise.all([
          directRun(aId, aBeforeRun),
          directRun(bId, bBeforeRun),
        ]);
        const [aRow, bRow] = await Promise.all([
          prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: aId } }),
          prisma.budgetExtractionCandidateV1.findUniqueOrThrow({ where: { id: bId } }),
        ]);
        const [aReviewId, bReviewId] = await Promise.all([
          directActiveScopedApproval({
            candidateId: aId,
            runId: aRunId,
            sourceDocumentId: aRow.sourceDocumentId,
            sourceSha256: aRow.sourceSha256,
            extractionArtifactId: aRow.extractionArtifactId,
            extractionArtifactSha256: aRow.extractionArtifactSha256,
            manifestContentSha256: aRow.manifestContentSha256,
            peCode: '0611097A',
          }),
          directActiveScopedApproval({
            candidateId: bId,
            runId: bRunId,
            sourceDocumentId: bRow.sourceDocumentId,
            sourceSha256: bRow.sourceSha256,
            extractionArtifactId: bRow.extractionArtifactId,
            extractionArtifactSha256: bRow.extractionArtifactSha256,
            manifestContentSha256: bRow.manifestContentSha256,
            peCode: '0611098A',
          }),
        ]);
        const commit = (oldRow: typeof aRow, newRow: typeof aRow) =>
          commitCandidateCorrectionAtomicallyV1(prisma as never, {
            oldCandidateId: oldRow.id,
            newCandidateId: newRow.id,
            oldCandidateStatusAtCorrection: oldRow.status,
            ...correctionCommitBindings(oldRow, newRow),
            oldCandidateSourceDocumentId: oldRow.sourceDocumentId,
            oldCandidateSourceSha256: oldRow.sourceSha256,
            newCandidateSourceDocumentId: newRow.sourceDocumentId,
            newCandidateSourceSha256: newRow.sourceSha256,
            actor: 'concurrent-cycle-proof',
            reason: 'deterministic concurrent cycle proof',
            supersessionReason: 'deterministic concurrent cycle proof supersession',
            now: new Date().toISOString(),
          });

        let signalGraphHeld!: () => void;
        const graphHeld = new Promise<void>((resolve) => {
          signalGraphHeld = resolve;
        });
        let releaseGraph!: () => void;
        const graphMayCommit = new Promise<void>((resolve) => {
          releaseGraph = resolve;
        });
        const blocker = prisma.$transaction(async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended('budget_candidate_correction_v1:graph', 0))) AS acquired`,
          );
          signalGraphHeld();
          await graphMayCommit;
        }, HELD_TRANSACTION_OPTIONS);
        await graphHeld;
        const abPromise = commit(aRow, bRow);
        const baPromise = commit(bRow, aRow);
        let queued = false;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const waiting = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
          SELECT count(*)::bigint AS count
            FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'
        `);
          if ((waiting[0]?.count ?? 0n) >= 2n) {
            queued = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (!queued) {
          releaseGraph();
          await Promise.allSettled([abPromise, baPromise, blocker]);
          throw new Error(
            'both opposite correction attempts did not queue behind the held graph lock',
          );
        }
        releaseGraph();
        const [ab, ba] = await Promise.all([abPromise, baPromise, blocker]);
        expect([ab.outcome, ba.outcome].sort()).toEqual(['inserted', 'reverse_or_cycle_conflict']);
        const links = await prisma.budgetCandidateCorrectionV1.findMany({
          where: { OR: [{ oldCandidateId: aId }, { oldCandidateId: bId }] },
        });
        expect(links).toHaveLength(1);
        const winnerOldId = links[0]!.oldCandidateId;
        const loserOldId = winnerOldId === aId ? bId : aId;
        const winnerReviewId = winnerOldId === aId ? aReviewId : bReviewId;
        const loserReviewId = winnerOldId === aId ? bReviewId : aReviewId;
        expect(links[0]!.supersededScopedFactReviewIds).toEqual([winnerReviewId]);
        await expect(
          prisma.budgetScopedFactReviewV1.findUniqueOrThrow({ where: { id: winnerReviewId } }),
        ).resolves.toMatchObject({
          status: 'superseded',
          revokedBy: 'concurrent-cycle-proof',
        });
        await expect(
          prisma.budgetScopedFactReviewV1.findUniqueOrThrow({ where: { id: loserReviewId } }),
        ).resolves.toMatchObject({
          candidateId: loserOldId,
          status: 'active',
          revokedAt: null,
          revokedBy: null,
        });
        expect(
          await prisma.budgetCandidateCorrectionV1.findUnique({
            where: { oldCandidateId: loserOldId },
          }),
        ).toBeNull();
      });

      it('refuses to record a correction naming an already-superseded (already-"old") candidate as the new side; zero writes', async () => {
        const src = await directSourceDocument();
        const verification = createPrismaBudgetVerificationRepository(prisma);
        const service = new CandidateCorrectionV1Service(
          verification,
          new PrismaCandidateCorrectionRepositoryV1(prisma as never),
        );

        // Establish a REAL existing link: oldX -> newY.
        const oldX = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const newY = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const firstLink = await service.correct(
          {
            oldCandidateId: oldX,
            newCandidateId: newY,
            actor: 'neo@capiro.ai',
            reason: 'establish real link oldX->newY',
          },
          { commit: true },
        );
        expect(firstLink.mode).toBe('committed');

        // Now attempt the destructive reverse shape: correct SOME OTHER
        // candidate Z, naming oldX (already the OLD/superseded side of the
        // link above) as the "new" (corrected) side -- this would resurrect
        // oldX as authoritative again.
        const z = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });

        const preview = await service.correct(
          {
            oldCandidateId: z,
            newCandidateId: oldX,
            actor: 'neo@capiro.ai',
            reason: 'attempted reverse correction',
          },
          { commit: false },
        );
        expect(preview.eligibility.eligible).toBe(false);
        expect(preview.eligibility.refusalReasons.map((r) => r.code)).toContain(
          'reverse_correction_of_already_corrected_candidate',
        );

        await expect(
          service.correct(
            {
              oldCandidateId: z,
              newCandidateId: oldX,
              actor: 'neo@capiro.ai',
              reason: 'attempted reverse correction',
            },
            { commit: true },
          ),
        ).rejects.toMatchObject({ code: 'ineligible' });

        // Zero writes from the attempted reverse correction: Z has no link at
        // all, and the original oldX->newY link is completely untouched.
        const zLinks = await prisma.budgetCandidateCorrectionV1.findMany({
          where: { oldCandidateId: z },
        });
        expect(zLinks).toHaveLength(0);
        const originalLink = await prisma.budgetCandidateCorrectionV1.findUniqueOrThrow({
          where: { oldCandidateId: oldX },
        });
        expect(originalLink.id).toBe(firstLink.persisted!.id);
        expect(originalLink.newCandidateId).toBe(newY);
      });

      it('regression: an ordinary FORWARD correction (new candidate has no existing link at all) is still eligible, unaffected by the new guard', async () => {
        const src = await directSourceDocument();
        const verification = createPrismaBudgetVerificationRepository(prisma);
        const service = new CandidateCorrectionV1Service(
          verification,
          new PrismaCandidateCorrectionRepositoryV1(prisma as never),
        );
        const oldId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const newId = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });

        const result = await service.correct(
          {
            oldCandidateId: oldId,
            newCandidateId: newId,
            actor: 'neo@capiro.ai',
            reason: 'ordinary forward correction',
          },
          { commit: true },
        );
        expect(result.mode).toBe('committed');
        expect(result.eligibility.eligible).toBe(true);
        expect(result.eligibility.refusalReasons).toEqual([]);
        const persistedDigest = await prisma.$queryRaw<
          Array<{ persisted: string; expected: string }>
        >(Prisma.sql`
        SELECT btrim("reviewed_intent_sha256") AS persisted,
               encode(digest(convert_to("reviewed_intent_jsonb"::text, 'UTF8'), 'sha256'), 'hex') AS expected
          FROM "budget_candidate_correction_v1"
         WHERE "id" = ${result.persisted!.id}::uuid
      `);
        expect(persistedDigest).toHaveLength(1);
        expect(persistedDigest[0]!.persisted).toBe(persistedDigest[0]!.expected);
        expect(result.persisted!.reviewedIntentSha256).toBe(persistedDigest[0]!.expected);
      });

      it('a FURTHER forward correction of the NEW candidate (the documented supported remedy) is still eligible -- only naming an already-superseded candidate as "new" is refused', async () => {
        const src = await directSourceDocument();
        const verification = createPrismaBudgetVerificationRepository(prisma);
        const service = new CandidateCorrectionV1Service(
          verification,
          new PrismaCandidateCorrectionRepositoryV1(prisma as never),
        );

        const oldX = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const newY = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        await service.correct(
          {
            oldCandidateId: oldX,
            newCandidateId: newY,
            actor: 'neo@capiro.ai',
            reason: 'first link oldX->newY',
          },
          { commit: true },
        );

        // The supported remedy: correct newY FORWARD into a third candidate,
        // never reverse oldX itself back onto newY.
        const newZ = await directCandidate({
          sourceDocumentId: src.id,
          sourceSha256: src.sourceSha256,
          status: 'NEEDS_REVIEW',
        });
        const second = await service.correct(
          {
            oldCandidateId: newY,
            newCandidateId: newZ,
            actor: 'neo@capiro.ai',
            reason: 'forward correction of newY -> newZ',
          },
          { commit: true },
        );
        expect(second.mode).toBe('committed');
        expect(second.eligibility.eligible).toBe(true);
      });
    });
  },
);
