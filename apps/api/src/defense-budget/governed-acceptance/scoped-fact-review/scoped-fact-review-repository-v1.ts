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
import type { Prisma, PrismaClient } from '@prisma/client';
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
  status: 'active' | 'revoked' | 'superseded';
  revokedAt: string | null;
  revokedBy: string | null;
  revocationReason: string | null;
  supersededById: string | null;
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
  /** ISO timestamp used for the supersession stamp on rows this decision replaces. */
  now: string;
}

export interface InsertScopedFactReviewResultV1 {
  row: ScopedFactReviewRowV1;
  supersededIds: string[];
}

export interface ScopedFactReviewRepositoryV1 {
  /** All rows for a candidate, newest first. */
  listByCandidate(candidateId: string): Promise<ScopedFactReviewRowV1[]>;
  /** Active rows (approve or reject) for a scope key, any candidate. */
  listActiveByScopeKey(scopeKind: ScopedFactReviewScopeKindV1, scopeKey: string): Promise<ScopedFactReviewRowV1[]>;
  /** Insert a new active decision; for an approval, supersede other active approvals of the same scope key atomically. */
  insertDecision(input: InsertScopedFactReviewInputV1): Promise<InsertScopedFactReviewResultV1>;
  /** active -> revoked. Returns null when the row is not active (or missing). */
  revoke(input: { id: string; actor: string; reason: string; now: string }): Promise<ScopedFactReviewRowV1 | null>;
  /** Mark every active row of a candidate superseded (used when a candidate is superseded by a corrected re-extraction). */
  supersedeAllForCandidate(input: { candidateId: string; actor: string; reason: string; now: string }): Promise<string[]>;
  readById(id: string): Promise<ScopedFactReviewRowV1 | null>;
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
  status: string;
  revokedAt: Date | null;
  revokedBy: string | null;
  revocationReason: string | null;
  supersededById: string | null;
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
    status: r.status as ScopedFactReviewRowV1['status'],
    revokedAt: r.revokedAt?.toISOString() ?? null,
    revokedBy: r.revokedBy,
    revocationReason: r.revocationReason,
    supersededById: r.supersededById,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The minimal Prisma surface this repository touches (for fakes in tests). */
export type ScopedFactReviewPrismaLikeV1 = Pick<PrismaClient, 'budgetScopedFactReviewV1' | '$transaction'>;

export class PrismaScopedFactReviewRepositoryV1 implements ScopedFactReviewRepositoryV1 {
  constructor(private readonly prisma: ScopedFactReviewPrismaLikeV1) {}

  async listByCandidate(candidateId: string): Promise<ScopedFactReviewRowV1[]> {
    const rows = await this.prisma.budgetScopedFactReviewV1.findMany({
      where: { candidateId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => toRow(r as unknown as PrismaRow));
  }

  async listActiveByScopeKey(scopeKind: ScopedFactReviewScopeKindV1, scopeKey: string): Promise<ScopedFactReviewRowV1[]> {
    const rows = await this.prisma.budgetScopedFactReviewV1.findMany({
      where: { scopeKind, scopeKey, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => toRow(r as unknown as PrismaRow));
  }

  async readById(id: string): Promise<ScopedFactReviewRowV1 | null> {
    const row = await this.prisma.budgetScopedFactReviewV1.findUnique({ where: { id } });
    return row ? toRow(row as unknown as PrismaRow) : null;
  }

  async insertDecision(input: InsertScopedFactReviewInputV1): Promise<InsertScopedFactReviewResultV1> {
    return this.prisma.$transaction(async (tx) => {
      const supersededIds: string[] = [];
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
        status: 'active',
      };
      const inserted = await tx.budgetScopedFactReviewV1.create({ data });
      if (input.decision === 'approve') {
        const others = await tx.budgetScopedFactReviewV1.findMany({
          where: {
            scopeKind: input.scopeKind,
            scopeKey: input.scopeKey,
            status: 'active',
            decision: 'approve',
            id: { not: inserted.id },
          },
          select: { id: true },
        });
        for (const other of others) {
          await tx.budgetScopedFactReviewV1.update({
            where: { id: other.id },
            data: {
              status: 'superseded',
              revokedAt: new Date(input.now),
              revokedBy: input.reviewerId,
              revocationReason: `superseded by scoped approval ${inserted.id} for scope ${input.scopeKey}`,
              supersededById: inserted.id,
            },
          });
          supersededIds.push(other.id);
        }
      }
      return { row: toRow(inserted as unknown as PrismaRow), supersededIds };
    });
  }

  async revoke(input: { id: string; actor: string; reason: string; now: string }): Promise<ScopedFactReviewRowV1 | null> {
    const updated = await this.prisma.budgetScopedFactReviewV1.updateMany({
      where: { id: input.id, status: 'active' },
      data: {
        status: 'revoked',
        revokedAt: new Date(input.now),
        revokedBy: input.actor,
        revocationReason: input.reason,
      },
    });
    if (updated.count !== 1) return null;
    return this.readById(input.id);
  }

  async supersedeAllForCandidate(input: { candidateId: string; actor: string; reason: string; now: string }): Promise<string[]> {
    const rows = await this.prisma.budgetScopedFactReviewV1.findMany({
      where: { candidateId: input.candidateId, status: 'active' },
      select: { id: true },
    });
    for (const r of rows) {
      await this.prisma.budgetScopedFactReviewV1.update({
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
}
