import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { AGENTIC_FLAGS, StrategyFlagsService } from './strategy-flags.service.js';

/**
 * Gates the Strategy Watcher routes (Stage F: run-check + the F2
 * scheduler-admin surface) on (STRATEGY_AGENTS_ENABLED env AND per-tenant
 * strategyWatcher.enabled). Applied at METHOD level on top of the class stack —
 * `@UseGuards(TenantGuard, StrategyPlannerGuard, AgenticGuard)` — so a watcher
 * route requires the umbrella agentic opt-in AND the watcher-specific flag,
 * while the generic mission/run/change-set routes need only the umbrella.
 * 403 when off (fail-closed). Mirrors ContextStewardGuard; the scheduler path
 * (no HTTP guard) is covered by WatcherService re-checking the same flag.
 */
@Injectable()
export class StrategyWatcherGuard implements CanActivate {
  constructor(private readonly flags: StrategyFlagsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: AuthTenantContext }>();
    const tenantId = req.tenantContext?.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('No tenant context');
    }
    const enabled = await this.flags.isAgenticFlagEnabled(tenantId, AGENTIC_FLAGS.strategyWatcher);
    if (!enabled) {
      throw new ForbiddenException('The Strategy Watcher is not enabled for this tenant');
    }
    return true;
  }
}
