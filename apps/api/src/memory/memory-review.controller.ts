import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MemoryCandidateReviewService } from './memory-candidate-review.service.js';

/**
 * Grant-aware candidate review surface.
 *
 * Route access is standard authenticated access; all scope, role, ethical-wall,
 * grant, expiration, revocation, and segregation-of-duties decisions are made by
 * the server-owned memory authorization path. Mutations delegate to the atomic
 * candidate transaction, which repeats the decision under the row lock.
 */
@Controller('memory/review')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MemoryReviewController {
  constructor(private readonly review: MemoryCandidateReviewService) {}

  @Get('candidates')
  listCandidates(@CurrentTenant() ctx: TenantContext) {
    return this.review.listReviewable(ctx);
  }

  @Post('candidates/:id/approve')
  async approveCandidate(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    const { memoryId } = await this.review.approve(ctx, id);
    return { ok: true, memoryId };
  }

  @Post('candidates/:id/reject')
  async rejectCandidate(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    await this.review.reject(ctx, id);
    return { ok: true };
  }
}
