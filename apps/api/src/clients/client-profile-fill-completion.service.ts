import {
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { HttpAdapterHost } from '@nestjs/core';
import { IntelligenceService } from '../intelligence/intelligence.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientFacilitiesService } from './client-facilities.service.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';
import {
  ClientAdvocacyMatterService,
  type FederalRegisterCorrelationSuggestion,
} from './client-advocacy-matter.service.js';
import {
  ClientProfileFillWorkflowService,
  type StartClientProfileFillWorkflowInput,
} from './client-profile-fill-workflow.service.js';
import { asString } from './client-profile-fill.helpers.js';
import type {
  UpdateClientProfileFillScheduleInput,
  AdvocacyHistoryHealth,
  AdvocacySourceBackfillState,
} from './client-profile-fill-completion.exports.js';
import type {
  CompletionTaskRow,
  CompletionTaskStatus,
} from './client-profile-fill-completion-runtime.shared.js';
import type {
  AdvocacyHistoryTaskResult,
  DiscoveryFinding,
} from './client-profile-fill-advocacy-discovery.shared.js';
import type { AdvancedFindingRow } from './client-profile-fill-finding-review.shared.js';
import type { RegulatoryCommentDetail } from './client-profile-fill-regulatory-comment-source.js';
import type { CompletionFindingInput } from './client-profile-fill-completion-persistence.js';
import { createClientProfileFillCompletionOwners } from './client-profile-fill-completion.composition.js';

export * from './client-profile-fill-completion.exports.js';

/** Stable facade for the existing Core and completion capabilities. */
@Injectable()
export class ClientProfileFillCompletionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClientProfileFillCompletionService.name);
  private readonly workerId = process.env.HOSTNAME ?? `api-${process.pid}`;
  private readonly owners: ReturnType<typeof createClientProfileFillCompletionOwners>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: ClientProfileFillWorkflowService,
    private readonly fill: ClientProfileFillService,
    private readonly intelligence: IntelligenceService,
    private readonly facilities: ClientFacilitiesService,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly advocacyMatters: ClientAdvocacyMatterService,
  ) {
    this.owners = createClientProfileFillCompletionOwners(
      {
        prisma,
        workflow,
        fill,
        intelligence,
        facilities,
        httpAdapterHost,
        advocacyMatters,
        workerId: this.workerId,
      },
      {
        warn: (message) => this.logger.warn(message),
        log: (message) => this.logger.log(message),
        error: (message) => this.logger.error(message),
        safeError: (error) => this.safeError(error),
        assertClient: (ctx, clientId) => this.assertClient(ctx, clientId),
        getRun: (ctx, clientId, runId) => this.getRun(ctx, clientId, runId),
        startRun: (ctx, clientId, input) => this.startRun(ctx, clientId, input),
        getSchedule: (ctx, clientId) => this.getSchedule(ctx, clientId),
        loadCompletionTasks: (tenantId, clientId, runId) =>
          this.loadCompletionTasks(tenantId, clientId, runId),
        resolveClientName: (ctx, clientId) => this.resolveClientNameForDiscovery(ctx, clientId),
        confirmedMappingKeys: (ctx, clientId, source) =>
          this.getConfirmedIntelMappingKeys(ctx, clientId, source),
        emitFinding: (ctx, clientId, runId, input) =>
          this.emitDiscoveryFinding(ctx, clientId, runId, input),
        persistFinding: (tenantId, clientId, runId, input, task) =>
          this.addFinding(tenantId, clientId, runId, input, task),
        getCursor: (tenantId, clientId, source) =>
          this.owners.persistence.getCursor(tenantId, clientId, source),
        recordCursor: (tenantId, clientId, source, watermark) =>
          this.owners.persistence.recordCursor(tenantId, clientId, source, watermark),
        executeTask: (ctx, task) => this.executeTask(ctx, task),
        requestTaskSweep: () => this.requestTaskSweep(),
        requestScheduleSweep: () => this.owners.completionRuntime.requestScheduleSweep(),
        sweepOnce: () => this.sweepOnce(),
        sweepSchedulesOnce: () => this.sweepSchedulesOnce(),
      },
    );
  }

  onModuleInit(): void {
    this.owners.completionRuntime.onModuleInit();
  }

  onModuleDestroy(): void {
    this.owners.completionRuntime.onModuleDestroy();
  }

  async getSetup(ctx: TenantContext, clientId: string) {
    return this.owners.runReadModel.getSetup(ctx, clientId);
  }

  async startRun(ctx: TenantContext, clientId: string, input: StartClientProfileFillWorkflowInput) {
    const activeCompletionRun = await this.owners.runReadModel.latestActiveCompletionRun(
      ctx.tenantId,
      clientId,
    );
    if (activeCompletionRun) return this.getRun(ctx, clientId, activeCompletionRun.id);

    const core = (await this.workflow.startRun(ctx, clientId, input)) as unknown as Record<
      string,
      unknown
    >;
    const runId = asString(core.id);
    if (!runId) throw new Error('Fill with Meri did not return a run id');
    await this.ensureCompletionTasks(ctx, clientId, runId);
    this.requestTaskSweep();
    return this.getRun(ctx, clientId, runId);
  }

  async refreshNow(ctx: TenantContext, clientId: string) {
    return this.owners.refreshSchedule.refreshNow(ctx, clientId);
  }

  async getAdvocacyHistoryHealth(
    ctx: TenantContext,
    clientId: string,
  ): Promise<AdvocacyHistoryHealth> {
    return this.owners.runReadModel.getAdvocacyHistoryHealth(ctx, clientId);
  }

  async getLatest(ctx: TenantContext, clientId: string) {
    return this.owners.runReadModel.getLatest(ctx, clientId);
  }

  async getRun(ctx: TenantContext, clientId: string, runId: string) {
    return this.owners.runReadModel.getRun(ctx, clientId, runId);
  }

  async cancelRun(ctx: TenantContext, clientId: string, runId: string) {
    return this.owners.runLifecycle.cancelRun(ctx, clientId, runId);
  }

  async retryTask(ctx: TenantContext, clientId: string, runId: string, taskId: string) {
    return this.owners.runLifecycle.retryTask(ctx, clientId, runId, taskId);
  }

  async applyFindings(ctx: TenantContext, clientId: string, runId: string, findingIds: string[]) {
    return this.owners.findingReview.applyFindings(ctx, clientId, runId, findingIds);
  }

  rejectFinding(ctx: TenantContext, clientId: string, findingId: string, reason?: string) {
    return this.fill.rejectFinding(ctx, clientId, findingId, reason);
  }

  restoreFinding(ctx: TenantContext, clientId: string, findingId: string) {
    return this.fill.restoreFinding(ctx, clientId, findingId);
  }

  async getSchedule(ctx: TenantContext, clientId: string) {
    return this.owners.refreshSchedule.getSchedule(ctx, clientId);
  }

  async updateSchedule(
    ctx: TenantContext,
    clientId: string,
    input: UpdateClientProfileFillScheduleInput,
  ) {
    return this.owners.refreshSchedule.updateSchedule(ctx, clientId, input);
  }

  async sweepOnce(): Promise<void> {
    return this.owners.taskRuntime.sweepOnce();
  }

  async sweepSchedulesOnce(): Promise<void> {
    return this.owners.refreshSchedule.sweepSchedulesOnce();
  }

  private async ensureCompletionTasks(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<void> {
    return this.owners.runLifecycle.ensureCompletionTasks(ctx, clientId, runId);
  }

  private async mergeRun(ctx: TenantContext, clientId: string, core: Record<string, unknown>) {
    return this.owners.runReadModel.mergeRun(ctx, clientId, core);
  }

  private async loadCompletionTasks(tenantId: string, clientId: string, runId: string) {
    return this.owners.runReadModel.loadCompletionTasks(tenantId, clientId, runId);
  }

  private requestTaskSweep(): void {
    this.owners.completionRuntime.requestTaskSweep();
  }

  private async recoverStaleTasks(): Promise<void> {
    return this.owners.taskLedger.recoverStaleTasks();
  }

  private async claimTasks(): Promise<CompletionTaskRow[]> {
    return this.owners.taskLedger.claimTasks();
  }

  private async executeClaimedTask(task: CompletionTaskRow): Promise<void> {
    return this.owners.taskRuntime.executeClaimedTask(task);
  }

  private async executeTask(
    ctx: TenantContext,
    task: CompletionTaskRow,
  ): Promise<number | AdvocacyHistoryTaskResult> {
    await this.assertCoreDependencies(task);
    switch (task.taskType) {
      case 'federal_market':
        return this.owners.profileDiscovery.gatherFederalMarket(ctx, task.clientId, task.runId);
      case 'facility_resolution':
        return this.owners.profileDiscovery.gatherFacilityResolution(
          ctx,
          task.clientId,
          task.runId,
        );
      case 'district_nexus':
        return this.owners.profileDiscovery.gatherDistrictNexus(ctx, task.clientId, task.runId);
      case 'advocacy_history':
        return this.owners.advocacyHistory.gather(ctx, task.clientId, task.runId);
      case 'lifecycle_outcomes':
        return this.owners.lifecycleOutcomes.gather(ctx, task.clientId, task.runId);
      case 'reconciliation':
        return this.owners.reconciliation.reconcileFindings(ctx, task.clientId, task.runId);
      case 'completion_audit':
        return this.owners.completionAudit.runCompletionAudit(ctx, task.clientId, task.runId, task);
      default:
        throw new Error(`Unsupported completion task ${String(task.taskType)}`);
    }
  }

  private async assertCoreDependencies(task: CompletionTaskRow): Promise<void> {
    return this.owners.taskLedger.assertCoreDependencies(task);
  }

  private async resolveClientNameForDiscovery(
    ctx: TenantContext,
    clientId: string,
  ): Promise<string | null> {
    return this.owners.advocacyHistory.resolveClientNameForDiscovery(ctx, clientId);
  }

  private async getConfirmedIntelMappingKeys(
    ctx: TenantContext,
    clientId: string,
    source: string,
  ): Promise<Set<string>> {
    return this.owners.persistence.getConfirmedIntelMappingKeys(ctx, clientId, source);
  }

  private async emitDiscoveryFinding(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    input: DiscoveryFinding,
  ): Promise<boolean> {
    return this.owners.advocacyHistory.emitDiscoveryFinding(ctx, clientId, runId, input);
  }

  private async gatherFaraAdvocacyCandidates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
  ): Promise<{ count: number; backfill: AdvocacySourceBackfillState }> {
    return this.owners.advocacyHistory.fara.gather(ctx, clientId, runId, currentCount);
  }

  private async gatherRegulatoryCommentAdvocacyCandidates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    priorState: Record<string, unknown>,
  ): Promise<{ count: number; backfill: AdvocacySourceBackfillState }> {
    return this.owners.regulatoryCommentDiscovery.gather(
      ctx,
      clientId,
      runId,
      currentCount,
      priorState,
    );
  }

  private async fetchOrCacheRegulatoryCommentDetail(
    commentId: string,
    apiKey: string,
  ): Promise<RegulatoryCommentDetail | null> {
    return this.owners.regulatoryCommentSource.getDetail(commentId, apiKey);
  }

  private async emitRegulatoryOutcomeFindings(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    matterId: string,
    suggestions: FederalRegisterCorrelationSuggestion[],
  ): Promise<void> {
    return this.owners.advocacyHistory.federalRegister.emitRegulatoryOutcomeFindings(
      ctx,
      clientId,
      runId,
      matterId,
      suggestions,
    );
  }

  private async addFinding(
    tenantId: string,
    clientId: string,
    runId: string,
    input: CompletionFindingInput,
    task?: Pick<CompletionTaskRow, 'id' | 'workerId'>,
  ): Promise<boolean> {
    return this.owners.persistence.addFinding(tenantId, clientId, runId, input, task);
  }

  private async applyAdvocacyRecord(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
    matterTarget?:
      | { matterId: string }
      | { newMatter: { title: string; matterType?: string; summary?: string | null } },
  ): Promise<string | null> {
    return this.owners.findingReview.applyAdvocacyRecord(ctx, clientId, finding, matterTarget);
  }

  async applyAdvocacyFindingToMatter(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    findingId: string,
    target:
      | { matterId: string }
      | { newMatter: { title: string; matterType?: string; summary?: string | null } },
  ): Promise<{ findingId: string; matterId: string | null; alreadyApplied: boolean }> {
    return this.owners.findingReview.applyAdvocacyFindingToMatter(
      ctx,
      clientId,
      runId,
      findingId,
      target,
    );
  }

  private async finishTask(
    task: CompletionTaskRow,
    status: Extract<CompletionTaskStatus, 'completed' | 'skipped' | 'cancelled'>,
    summary: Record<string, unknown>,
  ) {
    return this.owners.taskLedger.finishTask(task, status, summary);
  }

  private async deferTask(task: CompletionTaskRow, reason: string) {
    return this.owners.taskLedger.deferTask(task, reason);
  }

  private async failTask(task: CompletionTaskRow, error: unknown) {
    return this.owners.taskLedger.failTask(task, error);
  }

  private async heartbeat(task: CompletionTaskRow) {
    return this.owners.taskLedger.heartbeat(task);
  }

  private async finalizeRuns(): Promise<void> {
    return this.owners.runLifecycle.finalizeRuns();
  }

  private async assertClient(ctx: TenantContext, clientId: string): Promise<void> {
    const client = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.client.findFirst({
        where: {
          id: clientId,
          tenantId: ctx.tenantId,
          status: { not: 'archived' },
          OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: ctx.userId } } }],
        },
        select: { id: true },
      }),
    );
    if (!client) throw new NotFoundException('Client not found');
  }

  private async withTaskTimeout<T>(promise: Promise<T>): Promise<T> {
    return this.owners.taskRuntime.withTaskTimeout(promise);
  }

  private safeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw
      .replace(/(api[_-]?key|authorization|bearer)\s*[:=]?\s*[^\s,;]+/gi, '$1=[redacted]')
      .slice(0, 800);
  }
}
