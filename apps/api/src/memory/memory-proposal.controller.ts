import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { GovernedMemoryCandidateService } from './governed-memory-candidate.service.js';

/**
 * Proposer-owned candidate surface. It grants no review authority: listing is
 * restricted to proposed_by=current user, and withdrawal rechecks ownership
 * while holding the pending candidate row lock.
 */
@Controller('memory/proposals')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MemoryProposalController {
  constructor(private readonly candidates: GovernedMemoryCandidateService) {}

  @Get()
  listOwnProposals(@CurrentTenant() ctx: TenantContext) {
    return this.candidates.listOwnProposals(ctx);
  }

  @Post(':id/withdraw')
  async withdraw(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    await this.candidates.withdraw(ctx, id);
    return { ok: true, status: 'withdrawn' as const };
  }
}
