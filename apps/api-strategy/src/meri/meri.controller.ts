import { BadRequestException, Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { StrategyMeriGuard } from '../flags/strategy-meri.guard.js';
import { MeriService } from './meri.service.js';
import { DraftStrategyDto, AssistantDto, ReferenceAssistDto } from './dto/meri.dto.js';

/** Bearer token TenantGuard verified but did not stash — needed to forward to the orchestrator. */
function bearerFrom(req: Request): string | undefined {
  const h = req.headers?.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m?.[1];
}

/**
 * Meri endpoints (G5) — draft-from-goal, rail assistant, reference assist. All
 * behind TenantGuard → StrategyPlannerGuard → StrategyMeriGuard (module on AND
 * Meri opt-in AND env kill-switch). No global prefix here; main.ts adds
 * /strategy-api, so these are /strategy-api/strategies/draft etc.
 */
@Controller()
@UseGuards(TenantGuard, StrategyPlannerGuard, StrategyMeriGuard)
export class MeriController {
  constructor(private readonly meri: MeriService) {}

  @Post('strategies/draft')
  draft(@CurrentTenant() ctx: AuthTenantContext, @Req() req: Request, @Body() dto: DraftStrategyDto) {
    return this.meri.draft(ctx.tenantId, ctx.clerkUserId, bearerFrom(req), dto);
  }

  @Post('strategies/:id/assistant')
  assistant(
    @CurrentTenant() ctx: AuthTenantContext,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: AssistantDto,
  ) {
    return this.meri.assistant(ctx.tenantId, ctx.clerkUserId, bearerFrom(req), id, dto);
  }

  @Post('reference-calendars/:kind/assist')
  refAssist(
    @CurrentTenant() ctx: AuthTenantContext,
    @Req() req: Request,
    @Param('kind') kind: string,
    @Body() dto: ReferenceAssistDto,
  ) {
    if (kind !== 'congress' && kind !== 'ppbe') {
      throw new BadRequestException(`Unknown reference kind "${kind}"`);
    }
    return this.meri.referenceAssist(ctx.tenantId, bearerFrom(req), kind, dto);
  }
}
