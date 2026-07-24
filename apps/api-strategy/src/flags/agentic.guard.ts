import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyFlagsService } from './strategy-flags.service.js';

/**
 * Gates the Phase-2 agentic endpoints on
 * (STRATEGY_AGENTS_ENABLED env AND per-tenant agenticMeri.enabled). Stack it
 * AFTER StrategyPlannerGuard — `@UseGuards(TenantGuard, StrategyPlannerGuard,
 * AgenticGuard)` — so a tenant must be on the module AND opted into agents.
 * 403 when off (fail-closed).
 */
@Injectable()
export class AgenticGuard implements CanActivate {
  constructor(private readonly flags: StrategyFlagsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: AuthTenantContext }>();
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('No tenant context');
    }
    const enabled = await this.flags.isAgenticEnabled(tenantId);
    if (!enabled) {
      throw new ForbiddenException('Agentic Meri is not enabled for this tenant');
    }
    return true;
  }
}
