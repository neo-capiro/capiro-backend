import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { ChecksService } from './checks.service.js';

/**
 * Pre-submission checks (Phase 6b). Rule-based evaluation of a draft; no new
 * table. Tenant-scoped via TenantGuard + @CurrentTenant.
 */
@Controller('drafts/:draftId/checks')
@UseGuards(TenantGuard)
export class ChecksController {
  constructor(private readonly checks: ChecksService) {}

  @Get()
  evaluate(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.checks.evaluate(ctx.tenantId, draftId);
  }
}
