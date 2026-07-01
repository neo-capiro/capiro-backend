import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { FeatureFlagService, HEARING_WATCH_FEATURE } from './feature-flag.service.js';

/**
 * Gates Hearing Watch routes to tenants that have the `hearing_watch` feature
 * enabled (Capiro internal by default). Returns 404 (not 403) for disabled
 * tenants so the feature is invisible — a client tenant cannot even tell it
 * exists. MUST run AFTER TenantGuard (which populates req.tenantContext).
 */
@Injectable()
export class HearingWatchFeatureGuard implements CanActivate {
  constructor(private readonly flags: FeatureFlagService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: WorkspaceTenantContext }>();
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) throw new NotFoundException();
    const enabled = await this.flags.isEnabled(HEARING_WATCH_FEATURE, tenantId);
    if (!enabled) throw new NotFoundException();
    return true;
  }
}
