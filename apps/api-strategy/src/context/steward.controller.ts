import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { AgenticGuard } from '../flags/agentic.guard.js';
import { ContextStewardGuard } from '../flags/context-steward.guard.js';
import { StewardService } from './steward.service.js';
import { ResolveConflictDto } from './dto/steward.dto.js';

/** Bearer token TenantGuard verified but did not stash — forwarded to the orchestrator. */
function bearerFrom(req: Request): string | undefined {
  const h = req.headers?.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m?.[1];
}

/**
 * /strategy-api/context — Stage E Context Steward surface (facts / conflicts /
 * health + extraction). Class guard stack matches the Stage D context surface:
 * TenantGuard -> StrategyPlannerGuard -> AgenticGuard (review/read actions need
 * only the agentic umbrella). The EXTRACTION route additionally stacks
 * ContextStewardGuard at method level — LLM spend is gated on the
 * contextSteward.enabled flag specifically.
 */
@Controller('context')
@UseGuards(TenantGuard, StrategyPlannerGuard, AgenticGuard)
export class StewardController {
  constructor(private readonly steward: StewardService) {}

  @Post('documents/:id/extract')
  @UseGuards(ContextStewardGuard)
  extract(
    @CurrentTenant() tc: AuthTenantContext,
    @Req() req: Request,
    @Param('id') id: string,
  ) {
    return this.steward.extract(
      tc.tenantId,
      { clerkUserId: tc.clerkUserId, role: tc.role },
      id,
      bearerFrom(req),
    );
  }

  @Get('facts')
  listFacts(
    @CurrentTenant() tc: AuthTenantContext,
    @Query('clientId') clientId?: string,
    @Query('documentId') documentId?: string,
    @Query('state') state?: string,
  ) {
    return this.steward.listFacts(tc.tenantId, {
      clientId: clientId || undefined,
      documentId: documentId || undefined,
      state: state || undefined,
    });
  }

  @Post('facts/:id/reject')
  rejectFact(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.steward.rejectFact(
      tc.tenantId,
      { clerkUserId: tc.clerkUserId, role: tc.role },
      id,
    );
  }

  @Get('conflicts')
  listConflicts(
    @CurrentTenant() tc: AuthTenantContext,
    @Query('clientId') clientId?: string,
    @Query('state') state?: string,
  ) {
    return this.steward.listConflicts(tc.tenantId, {
      clientId: clientId || undefined,
      state: state || undefined,
    });
  }

  @Post('conflicts/:id/resolve')
  resolveConflict(
    @CurrentTenant() tc: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: ResolveConflictDto,
  ) {
    return this.steward.resolveConflict(
      tc.tenantId,
      { clerkUserId: tc.clerkUserId, role: tc.role },
      id,
      { note: dto.note, controllingFactId: dto.controllingFactId },
    );
  }

  @Post('conflicts/:id/dismiss')
  dismissConflict(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.steward.dismissConflict(
      tc.tenantId,
      { clerkUserId: tc.clerkUserId, role: tc.role },
      id,
    );
  }

  /** Fact-level grounding health; clientId omitted = firm-wide scope. */
  @Get('health')
  health(@CurrentTenant() tc: AuthTenantContext, @Query('clientId') clientId?: string) {
    return this.steward.health(tc.tenantId, clientId || null);
  }
}
