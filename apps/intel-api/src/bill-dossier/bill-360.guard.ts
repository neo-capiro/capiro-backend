import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { BILL_360_FEATURE, FeatureFlagService } from '../feature-flags/feature-flag.service.js';

/**
 * Gates the Bill 360 dossier routes to tenants that have the `bill_360` feature
 * enabled (Capiro internal is always-on during R1 QA). Returns 404 (not 403) for
 * disabled tenants so the dark surface is invisible — a client tenant cannot even
 * tell it exists. MUST run AFTER TenantGuard (which populates req.tenantContext).
 * Mirrors HearingWatchFeatureGuard / TrackerV2Guard.
 */
@Injectable()
export class Bill360FeatureGuard implements CanActivate {
  constructor(private readonly flags: FeatureFlagService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: WorkspaceTenantContext }>();
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) throw new NotFoundException();
    if (!(await this.flags.isEnabled(BILL_360_FEATURE, tenantId))) throw new NotFoundException();
    return true;
  }
}
