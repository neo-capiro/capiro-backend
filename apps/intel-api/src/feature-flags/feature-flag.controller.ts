import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { FeatureFlagService } from './feature-flag.service.js';

/**
 * Exposes the current tenant's enabled features so apps/web can hide/show nav
 * (cosmetic). The authoritative gate is the per-route HearingWatchFeatureGuard.
 */
@Controller('feature-flags')
@UseGuards(TenantGuard)
export class FeatureFlagController {
  constructor(private readonly flags: FeatureFlagService) {}

  @Get()
  list(@CurrentTenant() ctx: WorkspaceTenantContext) {
    return this.flags.enabledFor(ctx.tenantId);
  }
}
