import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isTenantAdmin, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { OutreachDraftService } from '../engagement/outreach-draft.service.js';
import { OUTREACH_DRAFT_VERSION_SUBJECT_TYPE } from '../engagement/outreach-draft.types.js';

export type OutreachReviewDecision = 'approved' | 'rejected';

export interface ExactOutreachReviewIdentity {
  surface: string;
  subjectType?: string | null;
  subjectId?: string | null;
}

export function isExactOutreachVersionReview(
  row: ExactOutreachReviewIdentity,
): row is ExactOutreachReviewIdentity & { subjectId: string } {
  return (
    row.surface === 'outreach' &&
    row.subjectType === OUTREACH_DRAFT_VERSION_SUBJECT_TYPE &&
    typeof row.subjectId === 'string' &&
    row.subjectId.length > 0
  );
}

/**
 * Neutral exact-version review transaction shared by current Reviews and later
 * Outreach V3. Review identity, reviewer authorization, immutable version
 * decision, and review stamping are all rechecked inside one transaction.
 */
@Injectable()
export class OutreachReviewTransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly drafts: OutreachDraftService,
  ) {}

  async decide(ctx: TenantContext, reviewRequestId: string, decision: OutreachReviewDecision) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const review = await tx.reviewRequest.findFirst({
        where: {
          id: reviewRequestId,
          tenantId: ctx.tenantId,
          status: 'pending',
        },
        select: {
          id: true,
          surface: true,
          subjectType: true,
          subjectId: true,
          assignedTo: true,
        },
      });
      if (!review) {
        throw new NotFoundException('No pending review with that id for this tenant.');
      }
      if (!isExactOutreachVersionReview(review)) {
        throw new ForbiddenException('This review does not govern an immutable Outreach draft version.');
      }
      if (!isTenantAdmin(ctx.role) && review.assignedTo !== ctx.userId) {
        throw new ForbiddenException('Only an admin or the assigned reviewer may decide this review.');
      }

      const version = await this.drafts.decideWithinTx(
        tx,
        ctx.tenantId,
        review.subjectId,
        review.id,
        decision,
      );

      await tx.reviewRequest.updateMany({
        where: {
          id: review.id,
          tenantId: ctx.tenantId,
          status: 'pending',
        },
        data: {
          status: decision,
          decidedBy: ctx.userId,
          decidedAt: new Date(),
        },
      });
      return version;
    });
  }

  getVersionForReviewerUnchecked(tenantId: string, versionId: string) {
    return this.drafts.getVersionForReviewerUnchecked(tenantId, versionId);
  }
}
