/**
 * scoped-fact-review-prisma-locator-reader-v1 -- Phase 10B-35.
 *
 * `BudgetVerificationRepositoryV1.readCandidate` deliberately does not expose
 * `extraction_artifact_locator` (it is a storage detail, not part of the
 * candidate's identity contract). `ScopedFactReviewV1Service` needs it to
 * reload the artifact bytes, so this is a minimal, separate, read-only query
 * against the same table -- never a second source of candidate identity.
 */
import type { PrismaClient } from '@prisma/client';
import type { ScopedFactReviewCandidateLocatorReaderV1 } from './scoped-fact-review-v1.service.js';

export class PrismaScopedFactReviewCandidateLocatorReaderV1 implements ScopedFactReviewCandidateLocatorReaderV1 {
  constructor(private readonly prisma: Pick<PrismaClient, 'budgetExtractionCandidateV1'>) {}

  async readExtractionArtifactLocator(candidateId: string): Promise<string | null> {
    const row = await this.prisma.budgetExtractionCandidateV1.findFirst({
      where: { id: candidateId },
      select: { extractionArtifactLocator: true },
    });
    return row?.extractionArtifactLocator ?? null;
  }
}
