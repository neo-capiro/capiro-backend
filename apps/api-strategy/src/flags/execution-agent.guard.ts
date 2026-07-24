import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { AGENTIC_FLAGS, StrategyFlagsService } from './strategy-flags.service.js';

/**
 * Gates the Stage G Execution-Agent routes (plan / execute / resume) on
 * (STRATEGY_AGENTS_ENABLED env AND (executionAgentWorkspace.enabled OR
 * executionAgentOutreach.enabled)). Applied at METHOD level on top of the class
 * stack — `@UseGuards(TenantGuard, StrategyPlannerGuard, AgenticGuard)` — so a
 * route requires the umbrella agentic opt-in AND at least one execution kind
 * being enabled. It is a COARSE door: the PRECISE per-kind gate
 * (executionAgentWorkspace for workspace, executionAgentOutreach for outreach)
 * is re-checked fail-closed IN ExecutionService, which also covers the scheduler
 * path that has no HTTP guard. 403 when off (fail-closed). Mirrors
 * StrategyWatcherGuard / ContextStewardGuard.
 */
@Injectable()
export class ExecutionAgentGuard implements CanActivate {
  constructor(private readonly flags: StrategyFlagsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: AuthTenantContext }>();
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('No tenant context');
    }
    const [workspace, outreach] = await Promise.all([
      this.flags.isAgenticFlagEnabled(tenantId, AGENTIC_FLAGS.executionAgentWorkspace),
      this.flags.isAgenticFlagEnabled(tenantId, AGENTIC_FLAGS.executionAgentOutreach),
    ]);
    if (!workspace && !outreach) {
      throw new ForbiddenException('The Execution Agent is not enabled for this tenant');
    }
    return true;
  }
}
