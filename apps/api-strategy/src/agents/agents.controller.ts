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
import { WatchReviewService } from './watch-review.service.js';
import { ExecutionService } from './execution.service.js';
import { RunReconcilerService } from './run-reconciler.service.js';
import {
  AcceptAllDto,
  ApproveChangeSetDto,
  CreateChangeSetDto,
  CreateMissionDto,
  CreateRunDto,
  ApproveExactDraftDto,
  ExecutionPlanDto,
  MarkRunFailedDto,
  RejectApprovalDto,
  ResolveReservationDto,
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
    private readonly watchReview: WatchReviewService,
    private readonly execution: ExecutionService,
    private readonly reconciler: RunReconcilerService,
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
  listExecutionRuns(
    @CurrentTenant() tc: AuthTenantContext,
    @Query('strategyId') strategyId?: string,
  ) {
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

  // ---- P0-2 run recovery ----
  //
  // The audit's missing controls. Before P0-2 there was NO cancel route (
  // ExecutionService.cancel existed but was dead code with no caller), no retry
  // (the idempotency key made a second attempt impossible), and no repair path —
  // a run that died between the artifact hop and its back-link write stayed stuck
  // forever. None of these routes create or send anything.

  /** Cancel a run. */
  @Post('execution/runs/:id/cancel')
  @UseGuards(ExecutionAgentGuard)
  cancelRun(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.execution.cancel(tc.tenantId, tc.clerkUserId, id);
  }

  /**
   * Retry: mints a NEW attempt (`<baseKey>#<n>`) and supersedes the prior one when
   * it was still open. Returns the new run, which then follows the normal
   * plan/execute path — no approval or staged result is inherited.
   */
  @Post('execution/runs/:id/retry')
  @UseGuards(ExecutionAgentGuard)
  retryRun(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.runs.retry(tc.tenantId, tc.clerkUserId, id);
  }

  /** Mark a recoverable-failed run as terminally failed. */
  @Post('execution/runs/:id/mark-failed')
  @UseGuards(ExecutionAgentGuard)
  markRunFailed(
    @CurrentTenant() tc: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: MarkRunFailedDto,
  ) {
    return this.runs.markFailed(tc.tenantId, tc.clerkUserId, id, dto.reason);
  }

  /**
   * Reconcile ONE run: detect what actually happened and apply at most one repair.
   * Always available (unlike the dark-by-default sweep) — this is the "Reconcile"
   * control in the review UI.
   */
  @Post('execution/runs/:id/reconcile')
  @UseGuards(ExecutionAgentGuard)
  reconcileRun(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.reconciler.reconcileRun(tc.tenantId, tc.clerkUserId, id);
  }

  /**
   * The state's allowed-next-actions + plain-words reason + retry lineage. The UI
   * renders its recovery controls from this, so on-screen buttons cannot drift
   * from what the server will actually accept.
   */
  @Get('execution/runs/:id/policy')
  @UseGuards(ExecutionAgentGuard)
  runPolicy(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.runs.policyFor(tc.tenantId, id);
  }

  /** Every attempt in this run's family, oldest first (compare attempts). */
  @Get('execution/runs/:id/attempts')
  @UseGuards(ExecutionAgentGuard)
  runAttempts(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.runs.listAttempts(tc.tenantId, id);
  }

  /**
   * Resolve a surviving staging reservation. HUMAN-authorised on purpose: the
   * create-only artifact client cannot ask upstream whether the artifact exists,
   * and both branches are unrecoverable if wrong.
   */
  @Post('execution/runs/:id/resolve-reservation')
  @UseGuards(ExecutionAgentGuard)
  resolveReservation(
    @CurrentTenant() tc: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: ResolveReservationDto,
  ) {
    return this.reconciler.resolveReservation(tc.tenantId, tc.clerkUserId, id, {
      action: dto.action,
      artifactRef: dto.artifactRef,
    });
  }

  // ---- P0-3 approval binding ----
  //
  // An approval binds to the EXACT payload (strategy+version, step, run,
  // recipients, channel, subject, full body, attachments, template version,
  // context-pack fingerprint, grounding status, model and the send-enabled policy
  // in force) and is invalidated by any material change. None of these routes
  // send anything: the external send stays hard-disabled behind
  // STRATEGY_EXECUTION_SEND_ENABLED.

  /**
   * The approval screen's data: what is staged now, its content hash, any
   * recorded approval, whether it still holds, and the required disclosures
   * (fallback content, grounding, conflicts, version drift, changed-since-review,
   * and whether approving stages or sends).
   */
  @Get('execution/runs/:id/approval')
  @UseGuards(ExecutionAgentGuard)
  approvalStatus(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.execution.approvalStatus(tc.tenantId, id);
  }

  /** Approve the exact draft. 409s if the payload moved since it was rendered. */
  @Post('execution/runs/:id/approve')
  @UseGuards(ExecutionAgentGuard)
  approveRun(
    @CurrentTenant() tc: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: ApproveExactDraftDto,
  ) {
    return this.execution.approve(tc.tenantId, tc.clerkUserId, id, {
      contentHash: dto.contentHash,
    });
  }

  /** Reject / withdraw an approval, recording who and why. */
  @Post('execution/runs/:id/reject-approval')
  @UseGuards(ExecutionAgentGuard)
  rejectRunApproval(
    @CurrentTenant() tc: AuthTenantContext,
    @Param('id') id: string,
    @Body() dto: RejectApprovalDto,
  ) {
    return this.execution.rejectApproval(tc.tenantId, tc.clerkUserId, id, dto.reason);
  }

  /** Report-only: one upstream artifact linked from more than one node. */
  @Get('execution/duplicate-artifacts')
  @UseGuards(ExecutionAgentGuard)
  duplicateArtifacts(
    @CurrentTenant() tc: AuthTenantContext,
    @Query('strategyId') strategyId?: string,
  ) {
    return this.reconciler.listDuplicateArtifactRefs(tc.tenantId, strategyId || undefined);
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

  // ---- Watch review (Phase 3) ----
  //
  // Method-level StrategyWatcherGuard on top of the class stack, matching
  // missions/:id/run-check — the Watch surface needs strategyWatcher.enabled
  // in ADDITION to the umbrella agentic opt-in. These routes are additive:
  // the generic change-set endpoints above are untouched and still serve
  // person-authored / firm-level proposals exactly as before.

  /**
   * Phase 4 §6: per-strategy pending counts for the library's weekly nudge —
   * one aggregate query, not one getState() per row. Declared as a literal
   * segment so it can never be shadowed by `watch/strategies/:strategyId`.
   */
  @Get('watch/pending-counts')
  @UseGuards(StrategyWatcherGuard)
  getWatchPendingCounts(@CurrentTenant() tc: AuthTenantContext) {
    return this.watchReview.getPendingCounts(tc.tenantId);
  }

  /** The panel's read state: current-head Watch proposals only, sorted, with
   *  dismissed and deleted-target findings already excluded. */
  @Get('watch/strategies/:strategyId')
  @UseGuards(StrategyWatcherGuard)
  getWatchState(@CurrentTenant() tc: AuthTenantContext, @Param('strategyId') strategyId: string) {
    return this.watchReview.getState(tc.tenantId, strategyId);
  }

  /** Panel-open (or manual "Check now") revalidation: fast no-op when
   *  nothing moved, otherwise a fresh check + unchanged/updated/dropped
   *  reconciliation against the current head. */
  @Post('watch/strategies/:strategyId/revalidate')
  @UseGuards(StrategyWatcherGuard)
  revalidateWatch(@CurrentTenant() tc: AuthTenantContext, @Param('strategyId') strategyId: string) {
    return this.watchReview.revalidate(tc.tenantId, tc.clerkUserId, strategyId, 'panel-open');
  }

  /** Accept ONE proposal: this call IS the approval, applies it, cuts one
   *  version, and immediately revalidates against the new head. */
  @Post('watch/proposals/:id/accept')
  @UseGuards(StrategyWatcherGuard)
  acceptWatchProposal(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.watchReview.acceptOne(tc.tenantId, tc.clerkUserId, id);
  }

  /** Permanently dismiss a Watch finding — the SAME finding never reappears,
   *  unlike a plain reject. */
  @Post('watch/proposals/:id/dismiss')
  @UseGuards(StrategyWatcherGuard)
  dismissWatchProposal(@CurrentTenant() tc: AuthTenantContext, @Param('id') id: string) {
    return this.watchReview.dismiss(tc.tenantId, tc.clerkUserId, id);
  }

  /** Accept a batch atomically: one dependency-ordered edit-set, one version,
   *  one visible History event. */
  @Post('watch/strategies/:strategyId/accept-all')
  @UseGuards(StrategyWatcherGuard)
  acceptAllWatchProposals(
    @CurrentTenant() tc: AuthTenantContext,
    @Param('strategyId') strategyId: string,
    @Body() dto: AcceptAllDto,
  ) {
    return this.watchReview.acceptAll(
      tc.tenantId,
      tc.clerkUserId,
      strategyId,
      dto.expectedVersionId,
      dto.proposalIds,
    );
  }
}
