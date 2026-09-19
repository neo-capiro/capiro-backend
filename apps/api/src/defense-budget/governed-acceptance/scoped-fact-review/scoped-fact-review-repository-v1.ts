/**
 * scoped-fact-review-repository-v1 -- Phase 10B-35.
 *
 * Persistence contract for `budget_scoped_fact_review_v1` plus the Prisma
 * implementation. The table is append-only except for the single permitted
 * transition active -> revoked | superseded (enforced by DB trigger); this
 * module never issues any other UPDATE and never DELETEs.
 *
 * Supersession invariant (also enforced by the DB partial unique index
 * `budget_scoped_fact_review_v1_one_active_approval_per_scope`): recording a
 * new active APPROVAL for a scope key first marks every other active approval
 * for that scope key -- on any candidate -- as `superseded`, pointing at the
 * new row, inside the same transaction. Serving can therefore never observe two
 * live values for one (component, PE, FY, funding field).
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
  type JsonValue,
} from '../../contracts/canonical-json.js';
import type {
  ReadCheckV1,
  ReadDiscrepancyV1,
  ReadProofSnapshotV1,
  ReadRunV1,
} from '../../verification/persistence/verification-repository.js';
import type {
  ScopedFactReviewIndependenceV1,
  ScopedFactReviewProjectionV1,
  ScopedFactReviewScopeKindV1,
  ScopedFactReviewScopeV1,
} from './scoped-fact-review-policy-v1.js';

export interface ScopedFactReviewRowV1 {
  id: string;
  candidateId: string;
  runId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  extractionArtifactId: string;
  extractionArtifactSha256: string;
  manifestContentSha256: string;
  policyId: string;
  policyVersion: string;
  policySha256: string;
  scopeKind: ScopedFactReviewScopeKindV1;
  scopeKey: string;
  scope: ScopedFactReviewScopeV1;
  assertionIds: string[];
  evidenceIds: string[];
  projection: ScopedFactReviewProjectionV1;
  independence: ScopedFactReviewIndependenceV1;
  limitations: string[];
  decision: 'approve' | 'reject';
  reviewerId: string;
  rationale: string;
  decisionHash: string;
  /** Database-owned monotonic generation; use this, never revokedAt, to
   * decide which revoked review is the latest reviewer generation. */
  reviewGeneration: string;
  eligibilityStateVersion: string | null;
  eligibilityStateSha256: string | null;
  status: 'active' | 'revoked' | 'superseded';
  revokedAt: string | null;
  revokedBy: string | null;
  revocationReason: string | null;
  supersededById: string | null;
  /** Exact revoked decision acknowledged for an intentional reapproval. */
  acknowledgedRevokedReviewId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsertScopedFactReviewInputV1 {
  candidateId: string;
  runId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  extractionArtifactId: string;
  extractionArtifactSha256: string;
  manifestContentSha256: string;
  policyId: string;
  policyVersion: string;
  policySha256: string;
  scopeKind: ScopedFactReviewScopeKindV1;
  scopeKey: string;
  scope: ScopedFactReviewScopeV1;
  assertionIds: string[];
  evidenceIds: string[];
  projection: ScopedFactReviewProjectionV1 | null;
  independence: ScopedFactReviewIndependenceV1 | null;
  limitations: string[];
  decision: 'approve' | 'reject';
  reviewerId: string;
  rationale: string;
  decisionHash: string;
  /** Versioned canonical snapshot of the run and every verification child row evaluated by the
   * service. The repository recomputes it after fencing the run row, at the
   * authoritative write boundary, so a late check/discrepancy/proof cannot
   * silently commit under an earlier eligibility decision. */
  eligibilityStateVersion: typeof SCOPED_FACT_REVIEW_ELIGIBILITY_STATE_VERSION_V1;
  eligibilityStateSha256: string;
  /** Exact latest revoked review deliberately acknowledged by this new
   * approval. NULL means this is an initial approval and is also an
   * authoritative precondition that no revoked generation exists. */
  acknowledgedRevokedReviewId?: string | null;
  /** ISO timestamp used for the supersession stamp on rows this decision replaces. */
  now: string;
}

export interface InsertScopedFactReviewResultV1 {
  row: ScopedFactReviewRowV1;
  supersededIds: string[];
}

export type ScopedFactReviewWriteConflictCodeV1 =
  | 'revocation_precondition_changed'
  | 'active_decision_changed'
  | 'candidate_binding_changed'
  | 'eligibility_state_changed'
  | 'candidate_corrected_away';

export const SCOPED_FACT_REVIEW_ELIGIBILITY_STATE_VERSION_V1 =
  'scoped_fact_review_eligibility_state_v1' as const;

/**
 * Stable digest of the complete run + verification-child state used by
 * scoped eligibility. Database-only child ids/timestamps are intentionally
 * excluded; every list and nested id list is sorted so query ordering cannot
 * change the digest.
 */
export function computeScopedFactReviewVerificationStateHashV1(input: {
  run: ReadRunV1;
  checks: ReadCheckV1[];
  discrepancies: ReadDiscrepancyV1[];
  proofSnapshots: ReadProofSnapshotV1[];
}): string {
  const byCanonicalJson = (a: unknown, b: unknown): number => {
    const left = canonicalJsonStringify(a as JsonValue);
    const right = canonicalJsonStringify(b as JsonValue);
    return left < right ? -1 : left > right ? 1 : 0;
  };
  const checks = input.checks
    .map((row) => ({
      checkId: row.checkId,
      code: row.code,
      ruleVersion: row.ruleVersion,
      outcome: row.outcome,
      required: row.required,
      blocking: row.blocking,
      riskPoints: row.riskPoints,
      message: row.message,
      assertionIds: [...row.assertionIds].sort(),
      evidenceIds: [...row.evidenceIds].sort(),
      referenceArtifactIds: [...row.referenceArtifactIds].sort(),
      details: row.details ?? null,
    }))
    .sort(byCanonicalJson);
  const discrepancies = input.discrepancies
    .map((row) => ({
      discrepancyId: row.discrepancyId,
      code: row.code,
      severity: row.severity,
      description: row.description,
      assertionIds: [...row.assertionIds].sort(),
      evidenceIds: [...row.evidenceIds].sort(),
      referenceArtifactIds: [...row.referenceArtifactIds].sort(),
      details: row.details ?? null,
    }))
    .sort(byCanonicalJson);
  const proofSnapshots = input.proofSnapshots
    .map((row) => ({
      proofKind: row.proofKind,
      status: row.status,
      sourceDocumentId: row.sourceDocumentId,
      artifactId: row.artifactId,
      referenceArtifactId: row.referenceArtifactId,
      evidenceJson: row.evidenceJson,
    }))
    .sort(byCanonicalJson);
  return sha256CanonicalJson({
    schemaVersion: SCOPED_FACT_REVIEW_ELIGIBILITY_STATE_VERSION_V1,
    run: input.run,
    checks,
    discrepancies,
    proofSnapshots,
  } as unknown as JsonValue);
}

/** A named, expected concurrency/precondition refusal. It is deliberately
 * distinct from arbitrary Prisma/database failures, which must propagate. */
export class ScopedFactReviewWriteConflictV1 extends Error {
  constructor(
    public readonly code: ScopedFactReviewWriteConflictCodeV1,
    message: string,
    public readonly observedLatestRevokedReviewId: string | null = null,
  ) {
    super(message);
    this.name = 'ScopedFactReviewWriteConflictV1';
  }
}

const CANDIDATE_CORRECTED_AWAY_TRIGGER_MARKER = '[scoped_fact_review_candidate_corrected_away]';

/**
 * Match only the database backstop for a corrected-away candidate. Prisma
 * exposes trigger RAISE failures as UnknownRequestError, so the bracketed
 * migration-owned marker is the stable discriminator; ordinary errors that
 * happen to repeat the text must never be relabeled as a write conflict.
 */
export function isScopedFactReviewCandidateCorrectedAwayTriggerConflictV1(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientUnknownRequestError &&
    error.message.includes(CANDIDATE_CORRECTED_AWAY_TRIGGER_MARKER)
  );
}

export interface ScopedFactReviewReconciliationExpectationV1 {
  reviewId: string;
  candidateId: string;
  runId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  extractionArtifactId: string;
  extractionArtifactSha256: string;
  manifestContentSha256: string;
  scopeKind: ScopedFactReviewScopeKindV1;
  scopeKey: string;
  scope: ScopedFactReviewScopeV1;
  policyId: string;
  policyVersion: string;
  policySha256: string;
  reviewerId: string;
  rationale: string;
  decisionHash: string;
  eligibilityStateVersion: string | null;
  eligibilityStateSha256: string | null;
  acknowledgedRevokedReviewId: string | null;
  assertionIds: string[];
  evidenceIds: string[];
  expectedTotalMillions: string;
  expectedPhysicalPage: number;
}

export interface ScopedFactReviewReconciliationObservationV1 {
  reviewId: string;
  actualId: string | null;
  candidateId: string | null;
  runId: string | null;
  sourceDocumentId: string | null;
  sourceSha256: string | null;
  extractionArtifactId: string | null;
  extractionArtifactSha256: string | null;
  manifestContentSha256: string | null;
  scopeKind: string | null;
  scopeKey: string | null;
  scope: ScopedFactReviewScopeV1 | null;
  policyId: string | null;
  policyVersion: string | null;
  policySha256: string | null;
  reviewerId: string | null;
  rationale: string | null;
  decisionHash: string | null;
  eligibilityStateVersion: string | null;
  eligibilityStateSha256: string | null;
  decision: string | null;
  status: string | null;
  assertionIds: string[] | null;
  evidenceIds: string[] | null;
  projection: ScopedFactReviewProjectionV1 | null;
  candidateCurrentRunId: string | null;
  candidateStatus: string | null;
  candidateSourceDocumentId: string | null;
  candidateSourceSha256: string | null;
  candidateExtractionArtifactId: string | null;
  candidateExtractionArtifactSha256: string | null;
  candidateManifestContentSha256: string | null;
  correctionLinkId: string | null;
  acknowledgedRevokedReviewId: string | null;
}

export interface ScopedFactReviewReconciliationSnapshotV1 {
  /** Database statement timestamp shared by every row in this one set query. */
  observedAt: string;
  observations: ScopedFactReviewReconciliationObservationV1[];
}

export interface ScopedFactReviewRepositoryV1 {
  /** All rows for a candidate, newest first. */
  listByCandidate(candidateId: string): Promise<ScopedFactReviewRowV1[]>;
  /** Active rows (approve or reject) for a scope key, any candidate. */
  listActiveByScopeKey(
    scopeKind: ScopedFactReviewScopeKindV1,
    scopeKey: string,
  ): Promise<ScopedFactReviewRowV1[]>;
  /** Insert a new active decision; for an approval, supersede other active approvals of the same scope key atomically. */
  insertDecision(input: InsertScopedFactReviewInputV1): Promise<InsertScopedFactReviewResultV1>;
  /** active -> revoked. Returns null when the row is not active (or missing). */
  revoke(input: {
    id: string;
    actor: string;
    reason: string;
    now: string;
  }): Promise<ScopedFactReviewRowV1 | null>;
  /** Mark every active row of a candidate superseded (used when a candidate is superseded by a corrected re-extraction). */
  supersedeAllForCandidate(input: {
    candidateId: string;
    actor: string;
    reason: string;
    now: string;
  }): Promise<string[]>;
  readById(id: string): Promise<ScopedFactReviewRowV1 | null>;
  /** One set-based authoritative observation of every approval a manifest is
   * about to count complete (newly committed AND already active on resume). */
  reconcileActiveApprovals(
    expectations: ScopedFactReviewReconciliationExpectationV1[],
  ): Promise<ScopedFactReviewReconciliationSnapshotV1>;
}

type PrismaRow = {
  id: string;
  candidateId: string;
  runId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  extractionArtifactId: string;
  extractionArtifactSha256: string;
  manifestContentSha256: string;
  policyId: string;
  policyVersion: string;
  policySha256: string;
  scopeKind: string;
  scopeKey: string;
  scope: unknown;
  assertionIds: unknown;
  evidenceIds: unknown;
  projection: unknown;
  independence: unknown;
  limitations: unknown;
  decision: string;
  reviewerId: string;
  rationale: string;
  decisionHash: string;
  reviewGeneration: bigint;
  eligibilityStateVersion: string | null;
  eligibilityStateSha256: string | null;
  status: string;
  revokedAt: Date | null;
  revokedBy: string | null;
  revocationReason: string | null;
  supersededById: string | null;
  acknowledgedRevokedReviewId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRow(r: PrismaRow): ScopedFactReviewRowV1 {
  return {
    id: r.id,
    candidateId: r.candidateId,
    runId: r.runId,
    sourceDocumentId: r.sourceDocumentId,
    sourceSha256: r.sourceSha256,
    extractionArtifactId: r.extractionArtifactId,
    extractionArtifactSha256: r.extractionArtifactSha256,
    manifestContentSha256: r.manifestContentSha256,
    policyId: r.policyId,
    policyVersion: r.policyVersion,
    policySha256: r.policySha256,
    scopeKind: r.scopeKind as ScopedFactReviewScopeKindV1,
    scopeKey: r.scopeKey,
    scope: r.scope as ScopedFactReviewScopeV1,
    assertionIds: (r.assertionIds as string[]) ?? [],
    evidenceIds: (r.evidenceIds as string[]) ?? [],
    projection: r.projection as ScopedFactReviewProjectionV1,
    independence: r.independence as ScopedFactReviewIndependenceV1,
    limitations: (r.limitations as string[]) ?? [],
    decision: r.decision as 'approve' | 'reject',
    reviewerId: r.reviewerId,
    rationale: r.rationale,
    decisionHash: r.decisionHash,
    reviewGeneration: r.reviewGeneration.toString(),
    eligibilityStateVersion: r.eligibilityStateVersion,
    eligibilityStateSha256: r.eligibilityStateSha256,
    status: r.status as ScopedFactReviewRowV1['status'],
    revokedAt: r.revokedAt?.toISOString() ?? null,
    revokedBy: r.revokedBy,
    revocationReason: r.revocationReason,
    supersededById: r.supersededById,
    acknowledgedRevokedReviewId: r.acknowledgedRevokedReviewId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The minimal Prisma surface this repository touches (for fakes in tests). */
export type ScopedFactReviewPrismaLikeV1 = Pick<
  PrismaClient,
  | 'budgetScopedFactReviewV1'
  | 'budgetCandidateCorrectionV1'
  | 'budgetVerificationCheckV1'
  | 'budgetVerificationDiscrepancyV1'
  | 'budgetVerificationProofV1'
  | '$transaction'
  | '$queryRaw'
>;

export class PrismaScopedFactReviewRepositoryV1 implements ScopedFactReviewRepositoryV1 {
  constructor(private readonly prisma: ScopedFactReviewPrismaLikeV1) {}

  async listByCandidate(candidateId: string): Promise<ScopedFactReviewRowV1[]> {
    const rows = await this.prisma.budgetScopedFactReviewV1.findMany({
      where: { candidateId },
      orderBy: { reviewGeneration: 'desc' },
    });
    return rows.map((r) => toRow(r as unknown as PrismaRow));
  }

  async listActiveByScopeKey(
    scopeKind: ScopedFactReviewScopeKindV1,
    scopeKey: string,
  ): Promise<ScopedFactReviewRowV1[]> {
    const rows = await this.prisma.budgetScopedFactReviewV1.findMany({
      where: { scopeKind, scopeKey, status: 'active' },
      orderBy: { reviewGeneration: 'desc' },
    });
    return rows.map((r) => toRow(r as unknown as PrismaRow));
  }

  async readById(id: string): Promise<ScopedFactReviewRowV1 | null> {
    const row = await this.prisma.budgetScopedFactReviewV1.findUnique({ where: { id } });
    return row ? toRow(row as unknown as PrismaRow) : null;
  }

  async insertDecision(
    input: InsertScopedFactReviewInputV1,
  ): Promise<InsertScopedFactReviewResultV1> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Canonical lock order for a scoped write: SCOPE advisory -> candidate
          // FOR SHARE -> revocation/active checks -> INSERT. `revoke()` takes the
          // same SCOPE lock before its row lock; candidate correction takes a
          // conflicting candidate fence, so neither a new revocation nor a
          // corrected-away candidate can slip through this commit boundary.
          await acquireScopedFactReviewScopeLockV1(tx, input.scopeKind, input.scopeKey);

          const candidates = await tx.$queryRaw<
            Array<{
              id: string;
              status: string;
              currentRunId: string | null;
              sourceDocumentId: string;
              sourceSha256: string;
              extractionArtifactId: string;
              extractionArtifactSha256: string;
              manifestContentSha256: string;
            }>
          >(Prisma.sql`
          SELECT c."id",
                 c."status",
                 c."current_run_id" AS "currentRunId",
                 c."source_document_id" AS "sourceDocumentId",
                 c."source_sha256" AS "sourceSha256",
                 c."extraction_artifact_id" AS "extractionArtifactId",
                 c."extraction_artifact_sha256" AS "extractionArtifactSha256",
                 c."manifest_content_sha256" AS "manifestContentSha256"
            FROM "budget_extraction_candidate_v1" c
           WHERE c."id" = ${input.candidateId}::uuid
           FOR SHARE OF c
        `);
          const candidate = candidates[0];
          if (
            candidate == null ||
            candidate.currentRunId !== input.runId ||
            candidate.sourceDocumentId !== input.sourceDocumentId ||
            candidate.sourceSha256 !== input.sourceSha256 ||
            candidate.extractionArtifactId !== input.extractionArtifactId ||
            candidate.extractionArtifactSha256 !== input.extractionArtifactSha256 ||
            candidate.manifestContentSha256 !== input.manifestContentSha256 ||
            (input.decision === 'approve' &&
              candidate.status !== 'NEEDS_REVIEW' &&
              candidate.status !== 'REVIEW_ACCEPTED')
          ) {
            throw new ScopedFactReviewWriteConflictV1(
              'candidate_binding_changed',
              `candidate/run/binding state changed before scoped review ${input.scopeKey} could commit`,
            );
          }

          // This must be a separate READ COMMITTED statement after the
          // candidate lock. If the lock waited for correction-first, an EXISTS
          // folded into the SELECT above would retain that statement's stale
          // snapshot and miss the newly committed link.
          const correctedAway = await tx.budgetCandidateCorrectionV1.findUnique({
            where: { oldCandidateId: input.candidateId },
            select: { id: true },
          });
          if (correctedAway != null) {
            throw new ScopedFactReviewWriteConflictV1(
              'candidate_corrected_away',
              `candidate ${input.candidateId} was corrected away before scoped review ${input.scopeKey} could commit`,
            );
          }

          // Fence the run before re-reading every eligibility child. FK inserts
          // take a KEY SHARE lock on this row: a child writer already in flight
          // commits before this lock and is observed below; a later writer waits
          // until this review commits. Separate READ COMMITTED statements after
          // the lock see the newest committed rows after any wait.
          await tx.$queryRaw(Prisma.sql`
          SELECT 1 AS "locked"
            FROM (
              SELECT pg_advisory_xact_lock(
                hashtextextended('budget_verification_evidence_v1:' || ${input.runId}, 0)
              )
            ) AS acquired
        `);
          const lockedRun = await tx.$queryRaw<
            Array<{
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
              resultSnapshot: unknown;
              createdAt: Date;
            }>
          >(Prisma.sql`
          SELECT "id",
                 "candidate_id" AS "candidateId",
                 "verifier_version" AS "verifierVersion",
                 "policy_version" AS "policyVersion",
                 "policy_sha256" AS "policySha256",
                 "decision", "status", "route", "risk_score" AS "riskScore",
                 "started_at" AS "startedAt", "completed_at" AS "completedAt",
                 "manifest_content_sha256" AS "manifestContentSha256",
                 "extraction_artifact_sha256" AS "extractionArtifactSha256",
                 "source_sha256" AS "sourceSha256",
                 "result_snapshot_jsonb" AS "resultSnapshot",
                 "created_at" AS "createdAt"
            FROM "budget_verification_run_v1"
           WHERE "id" = ${input.runId}::uuid
             AND "candidate_id" = ${input.candidateId}::uuid
           FOR UPDATE
        `);
          if (lockedRun.length !== 1) {
            throw new ScopedFactReviewWriteConflictV1(
              'candidate_binding_changed',
              `verification run ${input.runId} no longer belongs to candidate ${input.candidateId}`,
            );
          }
          const [checkRows, discrepancyRows, proofRows] = await Promise.all([
            tx.budgetVerificationCheckV1.findMany({ where: { runId: input.runId } }),
            tx.budgetVerificationDiscrepancyV1.findMany({ where: { runId: input.runId } }),
            tx.budgetVerificationProofV1.findMany({ where: { runId: input.runId } }),
          ]);
          const authoritativeVerificationStateSha256 =
            computeScopedFactReviewVerificationStateHashV1({
              run: {
                ...lockedRun[0]!,
                startedAt: lockedRun[0]!.startedAt.toISOString(),
                completedAt: lockedRun[0]!.completedAt.toISOString(),
                createdAt: lockedRun[0]!.createdAt.toISOString(),
              },
              checks: checkRows.map((row) => ({
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
              })),
              discrepancies: discrepancyRows.map((row) => ({
                discrepancyId: row.discrepancyId,
                code: row.code,
                severity: row.severity,
                description: row.description,
                assertionIds: row.assertionIds as string[],
                evidenceIds: row.evidenceIds as string[],
                referenceArtifactIds: row.referenceArtifactIds as string[],
                details: (row.details as Record<string, unknown> | null) ?? undefined,
              })),
              proofSnapshots: proofRows.map((row) => ({
                proofKind: row.proofKind,
                status: row.status,
                sourceDocumentId: row.sourceDocumentId,
                artifactId: row.artifactId,
                referenceArtifactId: row.referenceArtifactId,
                evidenceJson: row.evidenceJson as Record<string, unknown>,
              })),
            });
          if (
            input.eligibilityStateVersion !== SCOPED_FACT_REVIEW_ELIGIBILITY_STATE_VERSION_V1 ||
            authoritativeVerificationStateSha256 !== input.eligibilityStateSha256
          ) {
            throw new ScopedFactReviewWriteConflictV1(
              'eligibility_state_changed',
              `verification checks/discrepancies/proofs changed before scoped review ${input.scopeKey} could commit`,
            );
          }

          const latestRevoked = await tx.budgetScopedFactReviewV1.findFirst({
            where: {
              candidateId: input.candidateId,
              scopeKind: input.scopeKind,
              scopeKey: input.scopeKey,
              status: 'revoked',
            },
            orderBy: [{ reviewGeneration: 'desc' }],
          });
          const expectedLatestRevokedReviewId = input.acknowledgedRevokedReviewId ?? null;
          const observedLatestRevokedReviewId = latestRevoked?.id ?? null;
          if (observedLatestRevokedReviewId !== expectedLatestRevokedReviewId) {
            throw new ScopedFactReviewWriteConflictV1(
              'revocation_precondition_changed',
              `latest revoked review for ${input.candidateId}/${input.scopeKey} is ${observedLatestRevokedReviewId ?? 'none'}, ` +
                `but this decision acknowledged ${expectedLatestRevokedReviewId ?? 'none'}`,
              observedLatestRevokedReviewId,
            );
          }
          if (latestRevoked != null && latestRevoked.rationale.trim() === input.rationale.trim()) {
            throw new ScopedFactReviewWriteConflictV1(
              'revocation_precondition_changed',
              `intentional reapproval for ${input.scopeKey} requires a fresh rationale distinct from revoked review ${latestRevoked.id}`,
              latestRevoked.id,
            );
          }

          // Re-check AFTER acquiring the scope lock. Two callers may both have
          // previewed "none"; the loser receives this named conflict rather than
          // a raw P2002 or silently superseding the winner.
          const active = await tx.budgetScopedFactReviewV1.findMany({
            where: {
              scopeKind: input.scopeKind,
              scopeKey: input.scopeKey,
              status: 'active',
              OR:
                input.decision === 'approve'
                  ? [{ candidateId: input.candidateId }, { decision: 'approve' }]
                  : [{ candidateId: input.candidateId }],
            },
            select: { id: true, candidateId: true, decision: true },
            orderBy: { id: 'asc' },
          });
          if (active.length > 0) {
            throw new ScopedFactReviewWriteConflictV1(
              'active_decision_changed',
              `scope ${input.scopeKey} gained active decision(s) after preview: ${active
                .map((row) => `${row.id}:${row.candidateId}:${row.decision}`)
                .join(', ')}`,
              observedLatestRevokedReviewId,
            );
          }

          // The insert trigger accepts a new sealed decision only from the
          // repository transaction that just performed the authoritative locked
          // re-read above. This transaction-local attestation deliberately makes
          // old-version/direct Prisma creates fail closed after migration.
          await tx.$queryRaw(Prisma.sql`
        SELECT set_config(
          'capiro.scoped_fact_review_writer_v1',
          ${input.eligibilityStateSha256},
          true
        ) AS "eligibilityStateSha256"
      `);

          const data: Prisma.BudgetScopedFactReviewV1UncheckedCreateInput = {
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
            acknowledgedRevokedReviewId: expectedLatestRevokedReviewId,
            status: 'active',
          };
          const inserted = await tx.budgetScopedFactReviewV1.create({ data });
          return { row: toRow(inserted as unknown as PrismaRow), supersededIds: [] };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    } catch (error) {
      if (isScopedFactReviewCandidateCorrectedAwayTriggerConflictV1(error)) {
        throw new ScopedFactReviewWriteConflictV1(
          'candidate_corrected_away',
          `candidate ${input.candidateId} was corrected away before scoped review ${input.scopeKey} could commit`,
        );
      }
      throw error;
    }
  }

  async revoke(input: {
    id: string;
    actor: string;
    reason: string;
    now: string;
  }): Promise<ScopedFactReviewRowV1 | null> {
    // Immutable id/scope lookup only; status is re-read under the canonical
    // SCOPE -> row lock order inside the transaction.
    const identity = await this.prisma.budgetScopedFactReviewV1.findUnique({
      where: { id: input.id },
      select: { scopeKind: true, scopeKey: true },
    });
    if (identity == null) return null;
    return this.prisma.$transaction(
      async (tx) => {
        await acquireScopedFactReviewScopeLockV1(
          tx,
          identity.scopeKind as ScopedFactReviewScopeKindV1,
          identity.scopeKey,
        );
        const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
        SELECT "id", "status"
          FROM "budget_scoped_fact_review_v1"
         WHERE "id" = ${input.id}::uuid
         FOR UPDATE
      `);
        if (locked[0]?.status !== 'active') return null;
        const updated = await tx.budgetScopedFactReviewV1.update({
          where: { id: input.id },
          data: {
            status: 'revoked',
            revokedAt: new Date(input.now),
            revokedBy: input.actor,
            revocationReason: input.reason,
          },
        });
        return toRow(updated as unknown as PrismaRow);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async supersedeAllForCandidate(input: {
    candidateId: string;
    actor: string;
    reason: string;
    now: string;
  }): Promise<string[]> {
    return supersedeAllForCandidateWithClientV1(this.prisma, input);
  }

  async reconcileActiveApprovals(
    expectations: ScopedFactReviewReconciliationExpectationV1[],
  ): Promise<ScopedFactReviewReconciliationSnapshotV1> {
    if (expectations.length === 0) {
      const stamp = await this.prisma.$queryRaw<Array<{ observedAt: Date }>>(Prisma.sql`
        SELECT statement_timestamp() AS "observedAt"
      `);
      return { observedAt: stamp[0]!.observedAt.toISOString(), observations: [] };
    }
    const payload = JSON.stringify(
      expectations.map((expected) => ({
        review_id: expected.reviewId,
      })),
    );
    const rows = await this.prisma.$queryRaw<
      Array<{
        observedAt: Date;
        reviewId: string;
        actualId: string | null;
        candidateId: string | null;
        runId: string | null;
        sourceDocumentId: string | null;
        sourceSha256: string | null;
        extractionArtifactId: string | null;
        extractionArtifactSha256: string | null;
        manifestContentSha256: string | null;
        scopeKind: string | null;
        scopeKey: string | null;
        scope: ScopedFactReviewScopeV1 | null;
        policyId: string | null;
        policyVersion: string | null;
        policySha256: string | null;
        reviewerId: string | null;
        rationale: string | null;
        decisionHash: string | null;
        eligibilityStateVersion: string | null;
        eligibilityStateSha256: string | null;
        decision: string | null;
        status: string | null;
        assertionIds: string[] | null;
        evidenceIds: string[] | null;
        projection: ScopedFactReviewProjectionV1 | null;
        candidateCurrentRunId: string | null;
        candidateStatus: string | null;
        candidateSourceDocumentId: string | null;
        candidateSourceSha256: string | null;
        candidateExtractionArtifactId: string | null;
        candidateExtractionArtifactSha256: string | null;
        candidateManifestContentSha256: string | null;
        correctionLinkId: string | null;
        acknowledgedRevokedReviewId: string | null;
      }>
    >(Prisma.sql`
      WITH expected AS (
        SELECT review_id
          FROM jsonb_to_recordset(${payload}::jsonb) AS e(review_id text)
      )
      SELECT statement_timestamp() AS "observedAt",
             e.review_id AS "reviewId",
             r."id" AS "actualId",
             r."candidate_id" AS "candidateId",
             r."run_id" AS "runId",
             r."source_document_id" AS "sourceDocumentId",
             r."source_sha256" AS "sourceSha256",
             r."extraction_artifact_id" AS "extractionArtifactId",
             r."extraction_artifact_sha256" AS "extractionArtifactSha256",
             r."manifest_content_sha256" AS "manifestContentSha256",
             r."scope_kind" AS "scopeKind",
             r."scope_key" AS "scopeKey",
             r."scope_jsonb" AS "scope",
             r."policy_id" AS "policyId",
             r."policy_version" AS "policyVersion",
             r."policy_sha256" AS "policySha256",
             r."reviewer_id" AS "reviewerId",
             r."rationale",
             r."decision_hash" AS "decisionHash",
             r."eligibility_state_version" AS "eligibilityStateVersion",
             r."eligibility_state_sha256" AS "eligibilityStateSha256",
             r."decision",
             r."status",
             r."assertion_ids_jsonb" AS "assertionIds",
             r."evidence_ids_jsonb" AS "evidenceIds",
             r."projection_jsonb" AS "projection",
             c."current_run_id" AS "candidateCurrentRunId",
             c."status" AS "candidateStatus",
             c."source_document_id" AS "candidateSourceDocumentId",
             c."source_sha256" AS "candidateSourceSha256",
             c."extraction_artifact_id" AS "candidateExtractionArtifactId",
             c."extraction_artifact_sha256" AS "candidateExtractionArtifactSha256",
             c."manifest_content_sha256" AS "candidateManifestContentSha256",
             cc."id" AS "correctionLinkId",
             r."acknowledged_revoked_review_id" AS "acknowledgedRevokedReviewId"
        FROM expected e
        LEFT JOIN "budget_scoped_fact_review_v1" r ON r."id" = e.review_id::uuid
        LEFT JOIN "budget_extraction_candidate_v1" c ON c."id" = r."candidate_id"
        LEFT JOIN "budget_candidate_correction_v1" cc ON cc."old_candidate_id" = r."candidate_id"
       ORDER BY e.review_id
    `);
    return {
      observedAt: rows[0]!.observedAt.toISOString(),
      observations: rows.map(({ observedAt: _observedAt, ...row }) => row),
    };
  }
}

/** Transaction-scoped advisory lock shared by inserts and revocations for a
 * fact scope. Hash collisions only over-serialize; they cannot weaken safety. */
async function acquireScopedFactReviewScopeLockV1(
  client: Pick<PrismaClient, '$queryRaw'>,
  scopeKind: ScopedFactReviewScopeKindV1,
  scopeKey: string,
): Promise<void> {
  const lockKey = `budget_scoped_fact_review_v1:${scopeKind}:${scopeKey}`;
  await client.$queryRaw(Prisma.sql`
    SELECT 1 AS "locked"
      FROM (SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))) AS acquired
  `);
}

/** The minimal Prisma surface `supersedeAllForCandidateWithClientV1` touches --
 * deliberately narrower than `ScopedFactReviewPrismaLikeV1` so it accepts
 * either a top-level `PrismaClient` or a `$transaction` callback's `tx`
 * client, letting a caller in another module (e.g. the candidate-correction
 * repository) run this exact logic inside ITS OWN transaction rather than
 * duplicating it. */
export type ScopedFactReviewSupersedeClientV1 = Pick<PrismaClient, 'budgetScopedFactReviewV1'>;

/** Extracted from `PrismaScopedFactReviewRepositoryV1.supersedeAllForCandidate`
 * so it can be composed into a larger atomic transaction by another
 * repository (see `commitCandidateCorrectionAtomicallyV1`) without either
 * duplicating this logic or requiring cross-repository transaction plumbing. */
export async function supersedeAllForCandidateWithClientV1(
  client: ScopedFactReviewSupersedeClientV1,
  input: { candidateId: string; actor: string; reason: string; now: string },
): Promise<string[]> {
  const rows = await client.budgetScopedFactReviewV1.findMany({
    where: { candidateId: input.candidateId, status: 'active' },
    select: { id: true },
  });
  for (const r of rows) {
    await client.budgetScopedFactReviewV1.update({
      where: { id: r.id },
      data: {
        status: 'superseded',
        revokedAt: new Date(input.now),
        revokedBy: input.actor,
        revocationReason: input.reason,
      },
    });
  }
  return rows.map((r) => r.id);
}
