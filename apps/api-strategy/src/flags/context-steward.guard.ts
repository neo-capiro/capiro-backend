import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { AGENTIC_FLAGS, StrategyFlagsService } from './strategy-flags.service.js';

/**
 * Gates the Context Steward's LLM-spend route (Stage E fact extraction) on
 * (STRATEGY_AGENTS_ENABLED env AND per-tenant contextSteward.enabled). Applied
 * at METHOD level on top of the class stack — `@UseGuards(TenantGuard,
 * StrategyPlannerGuard, AgenticGuard)` — so extraction requires the umbrella
 * agentic opt-in AND the steward-specific flag, while the review/read routes
 * (facts, conflicts, health) need only the umbrella. 403 when off (fail-closed).
 */
@Injectable()
export class ContextStewardGuard implements CanActivate {
  constructor(private readonly flags: StrategyFlagsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: AuthTenantContext }>();
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('No tenant context');
    }
    const enabled = await this.flags.isAgenticFlagEnabled(tenantId, AGENTIC_FLAGS.contextSteward);
    if (!enabled) {
      throw new ForbiddenException('The Context Steward is not enabled for this tenant');
    }
    return true;
  }
}
