import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { AgenticGuard } from '../flags/agentic.guard.js';
import { MissionsService } from './missions.service.js';
import { RunsService } from './runs.service.js';
import { ChangeSetsService } from './change-sets.service.js';
import {
  ApproveChangeSetDto,
  CreateChangeSetDto,
  CreateMissionDto,
  CreateRunDto,
  TransitionRunDto,
  UpdateMissionDto,
} from './dto/agents.dto.js';

/**
 * /strategy-api/agents — Stage C agent runtime (missions / runs / change-sets).
 * TenantGuard first (populates req.tenantContext), then the module flag
 * (StrategyPlannerGuard) AND the agentic opt-in (AgenticGuard) — a tenant must
 * be on the Strategy Planner and opted into agents to reach any route here.
 */
@Controller('agents')
@UseGuards(TenantGuard, StrategyPlannerGuard, AgenticGuard)
export class AgentsController {
  constructor(
    private readonly missions: MissionsService,
    private readonly runs: RunsService,
    private readonly changeSets: ChangeSetsService,
  ) {}

  // ---- missions ----
  @Post('missions')
  createMission(@CurrentTenant() tc: AuthTenantContext, @Body() dto: CreateMissionDto) {
    return this.missions.create(tc.tenantId, tc.clerkUserId, dto);
  }

  @Get('missions')
  listMissions(@CurrentTenant() tc: AuthTenantContext, @Query('strategyId') strategyId?: string) {
    return this.missions.list(tc.tenantId, { strategyId: strategyId || undefined });
  }

  @Get('missions/:id')
  getMission(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.missions.get(tc.tenantId, id);
  }

  @Patch('missions/:id')
  updateMission(
    @CurrentTenant() tc: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateMissionDto,
  ) {
    return this.missions.update(tc.tenantId, tc.clerkUserId, id, dto);
  }

  // ---- runs ----
  @Post('missions/:id/runs')
  createRun(
    @CurrentTenant() tc: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: CreateRunDto,
  ) {
    return this.runs.createRun(tc.tenantId, tc.clerkUserId, id, dto);
  }

  @Get('missions/:id/runs')
  listRuns(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.runs.listForMission(tc.tenantId, id);
  }

  @Get('runs/:id')
  getRun(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.runs.get(tc.tenantId, id);
  }

  @Post('runs/:id/transition')
  transitionRun(
    @CurrentTenant() tc: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: TransitionRunDto,
  ) {
    return this.runs.transition(tc.tenantId, tc.clerkUserId, id, dto);
  }

  // ---- change-sets ----
  @Post('change-sets')
  createChangeSet(@CurrentTenant() tc: AuthTenantContext, @Body() dto: CreateChangeSetDto) {
    return this.changeSets.create(tc.tenantId, tc.clerkUserId, dto);
  }

  @Get('change-sets')
  listChangeSets(
    @CurrentTenant() tc: AuthTenantContext,
    @Query('strategyId') strategyId?: string,
    @Query('status') status?: string,
  ) {
    return this.changeSets.list(tc.tenantId, {
      strategyId: strategyId || undefined,
      status: status || undefined,
    });
  }

  @Get('change-sets/:id')
  getChangeSet(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.changeSets.get(tc.tenantId, id);
  }

  @Post('change-sets/:id/approve')
  approveChangeSet(
    @CurrentTenant() tc: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: ApproveChangeSetDto,
  ) {
    return this.changeSets.approve(tc.tenantId, tc.clerkUserId, id, dto);
  }

  @Post('change-sets/:id/reject')
  rejectChangeSet(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.changeSets.reject(tc.tenantId, tc.clerkUserId, id);
  }

  @Post('change-sets/:id/apply')
  applyChangeSet(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.changeSets.apply(tc.tenantId, tc.clerkUserId, id);
  }

  @Post('change-sets/:id/undo')
  undoChangeSet(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.changeSets.undo(tc.tenantId, tc.clerkUserId, id);
  }
}
