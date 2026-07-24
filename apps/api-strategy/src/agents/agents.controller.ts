import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { AgenticGuard } from '../flags/agentic.guard.js';
import { StrategyWatcherGuard } from '../flags/strategy-watcher.guard.js';
import { ExecutionAgentGuard } from '../flags/execution-agent.guard.js';
import { MissionsService } from './missions.service.js';
import { RunsService } from './runs.service.js';
import { ChangeSetsService } from './change-sets.service.js';
import { WatcherService } from './watcher.service.js';
import { ExecutionService } from './execution.service.js';
import {
  ApproveChangeSetDto,
  CreateChangeSetDto,
  CreateMissionDto,
  CreateRunDto,
  ExecutionPlanDto,
  RunCheckDto,
  TransitionRunDto,
  UpdateMissionDto,
} from './dto/agents.dto.js';

/** Bearer TenantGuard verified but did not stash — the Execution Agent forwards
 *  it to the artifact-staging hop (parity with MeriController.bearerFrom). */
function bearerFrom(req: Request): string | undefined {
  const h = req.headers?.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m?.[1];
}

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
    private readonly watcher: WatcherService,
    private readonly execution: ExecutionService,
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

  /**
   * Stage F1: run a Watcher check NOW (manual, suggest-only). Method-level
   * StrategyWatcherGuard on top of the class stack — the watcher surface needs
   * the strategyWatcher.enabled flag in ADDITION to the umbrella agentic
   * opt-in (mirrors the Steward's extract route gating).
   */
  @Post('missions/:id/run-check')
  @UseGuards(StrategyWatcherGuard)
  runCheck(
    @CurrentTenant() tc: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: RunCheckDto,
  ) {
    return this.watcher.runCheckNow(tc.tenantId, tc.clerkUserId, id, {
      idempotencyKey: dto.idempotencyKey,
    });
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

  /**
   * Firm-level review surface: ready_for_review runs with no strategy (the F2
   * firm-calendar placeholder parks findings on the run WITHOUT a change-set,
   * so the change-set queue alone never surfaces them). Declared BEFORE
   * 'runs/:id' so the literal segment wins the route match.
   */
  @Get('runs/firm-review')
  listFirmReviewRuns(@CurrentTenant() tc: AuthTenantContext) {
    return this.runs.listFirmReview(tc.tenantId);
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

  // ---- execution agent (Stage G) ----
  //
  // Method-level ExecutionAgentGuard on top of the class stack — the execution
  // surface needs executionAgentWorkspace OR executionAgentOutreach in ADDITION
  // to the umbrella agentic opt-in (mirrors the Watcher/Steward gating). The
  // PRECISE per-kind gate lives in ExecutionService (fail-closed), which also
  // covers the guard-less scheduler path. The caller bearer is forwarded so the
  // artifact-staging hop rides the authorising identity; a bearerless execute
  // parks the run (never a bearerless external hop).

  @Get('execution/runs')
  @UseGuards(ExecutionAgentGuard)
  listExecutionRuns(@CurrentTenant() tc: AuthTenantContext, @Query('strategyId') strategyId?: string) {
    return this.execution.listRuns(tc.tenantId, { strategyId });
  }

  @Post('execution/plan')
  @UseGuards(ExecutionAgentGuard)
  planExecution(
    @CurrentTenant() tc: AuthTenantContext,
    @Req() req: Request,
    @Body() dto: ExecutionPlanDto,
  ) {
    return this.execution.plan(tc.tenantId, tc.clerkUserId, bearerFrom(req), dto);
  }

  @Post('execution/runs/:id/execute')
  @UseGuards(ExecutionAgentGuard)
  executeRun(@CurrentTenant() tc: AuthTenantContext, @Req() req: Request, @Param('id') id: string) {
    return this.execution.execute(tc.tenantId, tc.clerkUserId, bearerFrom(req), id);
  }

  @Post('execution/runs/:id/resume')
  @UseGuards(ExecutionAgentGuard)
  resumeRun(@CurrentTenant() tc: AuthTenantContext, @Req() req: Request, @Param('id') id: string) {
    return this.execution.resume(tc.tenantId, tc.clerkUserId, bearerFrom(req), id);
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
