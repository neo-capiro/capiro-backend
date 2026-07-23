import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyFlagsService } from './strategy-flags.service.js';

/**
 * Gates every /strategy-api feature endpoint on the per-tenant
 * `strategyPlanner.enabled` flag. Runs AFTER TenantGuard (which populates
 * req.tenantContext), so apply as `@UseGuards(TenantGuard, StrategyPlannerGuard)`
 * — TenantGuard first. 403 (ForbiddenException) when the flag is off, matching
 * the intel-api feature-guard pattern (which 404s; we 403 so the client can
 * distinguish "not entitled" from "not found"). Health is not guarded.
 */
@Injectable()
export class StrategyPlannerGuard implements CanActivate {
  constructor(private readonly flags: StrategyFlagsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: AuthTenantContext }>();
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('No tenant context');
    }
    const enabled = await this.flags.isEnabled(tenantId);
    if (!enabled) {
      throw new ForbiddenException('Strategy Planner is not enabled for this tenant');
    }
    return true;
  }
}
