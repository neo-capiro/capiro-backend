import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { FeatureFlagService, TRACKER_V2_FEATURE } from '../feature-flags/feature-flag.service.js';

/**
 * Gates the unified tracker v2 read surfaces (the combined feed, §9.7) to tenants
 * with `tracker_v2` enabled. Returns 404 (not 403) when disabled — the surface is
 * invisible to non-v2 tenants. ALWAYS-on for CAPIRO_INTERNAL_TENANT_ID (via
 * FeatureFlagService). During shadow this is OFF for real tenants, so the feed is
 * reachable only internally until the Phase-7 rollout. MUST run AFTER TenantGuard.
 */
@Injectable()
export class TrackerV2Guard implements CanActivate {
  constructor(private readonly flags: FeatureFlagService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: WorkspaceTenantContext }>();
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) throw new NotFoundException();
    if (!(await this.flags.isEnabled(TRACKER_V2_FEATURE, tenantId))) throw new NotFoundException();
    return true;
  }
}
