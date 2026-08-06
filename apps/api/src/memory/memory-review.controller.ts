import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MemoryCandidateReviewService } from './memory-candidate-review.service.js';
import type { MemoryReviewRevisionInput } from './memory-review-revision.helpers.js';
import { MemoryReviewRevisionService } from './memory-review-revision.service.js';

/**
 * Grant-aware candidate review surface.
 *
 * Route access is standard authenticated access; all scope, role, ethical-wall,
 * grant, expiration, revocation, assignment, revision lineage, and segregation-
 * of-duties decisions are made from server-owned state.
 */
@Controller('memory/review')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MemoryReviewController {
  constructor(
    private readonly review: MemoryCandidateReviewService,
    private readonly revisions: MemoryReviewRevisionService,
  ) {}

  @Get('candidates')
  listCandidates(@CurrentTenant() ctx: TenantContext) {
    return this.review.listReviewable(ctx);
  }

  @Post('candidates/:id/request-changes')
  async requestChanges(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { reason?: unknown },
  ) {
    return {
      ok: true,
      candidateId: id,
      workflow: await this.review.requestChanges(ctx, id, body?.reason),
    };
  }

  @Post('candidates/:id/revise')
  async reviseCandidate(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: MemoryReviewRevisionInput,
  ) {
    return { ok: true, ...(await this.revisions.revise(ctx, id, body ?? {})) };
  }

  @Post('candidates/:id/assign')
  async assignReviewer(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { reviewerUserId?: string; reason?: unknown },
  ) {
    if (!body?.reviewerUserId) {
      throw new BadRequestException('reviewerUserId is required.');
    }
    return {
      ok: true,
      candidateId: id,
      workflow: await this.review.assignReviewer(ctx, id, body.reviewerUserId, body.reason),
    };
  }

  @Post('candidates/:id/approve')
  async approveCandidate(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return { ok: true, ...(await this.review.approve(ctx, id)) };
  }

  @Post('candidates/:id/reject')
  async rejectCandidate(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return { ok: true, ...(await this.review.reject(ctx, id, body?.reason ?? '')) };
  }
}
