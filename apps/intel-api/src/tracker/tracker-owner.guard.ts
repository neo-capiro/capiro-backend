import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { FeatureFlagService, TRACKER_OWNER_FEATURE } from '../feature-flags/feature-flag.service.js';

/**
 * Gates the unified tracker CRUD to tenants that own the tracker data path in
 * intel-api (`tracker_owner_intel`). Returns 404 (not 403) when disabled — the
 * surface is invisible to non-owned tenants. During shadow (D6) this is OFF for
 * all real tenants (ALWAYS-on only for CAPIRO_INTERNAL_TENANT_ID), so the legacy
 * apps/api tracker stays the sole source of truth. MUST run AFTER TenantGuard.
 */
@Injectable()
export class TrackerOwnerGuard implements CanActivate {
  constructor(private readonly flags: FeatureFlagService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: WorkspaceTenantContext }>();
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) throw new NotFoundException();
    if (!(await this.flags.isEnabled(TRACKER_OWNER_FEATURE, tenantId))) throw new NotFoundException();
    return true;
  }
}
