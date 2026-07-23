import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyFlagsService } from './strategy-flags.service.js';

/**
 * Gates the Meri draft/assistant/ref-assist endpoints on
 * (STRATEGY_MERI_ENABLED env AND per-tenant strategyPlannerMeri.enabled). Stack
 * it AFTER StrategyPlannerGuard — `@UseGuards(TenantGuard, StrategyPlannerGuard,
 * StrategyMeriGuard)` — so a tenant must be on the module AND opted into Meri.
 * 403 when off (fail-closed).
 */
@Injectable()
export class StrategyMeriGuard implements CanActivate {
  constructor(private readonly flags: StrategyFlagsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: AuthTenantContext }>();
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('No tenant context');
    }
    const enabled = await this.flags.isMeriEnabled(tenantId);
    if (!enabled) {
      throw new ForbiddenException('Strategy Planner Meri is not enabled for this tenant');
    }
    return true;
  }
}
