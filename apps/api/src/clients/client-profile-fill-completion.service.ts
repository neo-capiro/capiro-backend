import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
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
import {
  CLIENT_PROFILE_FILL_SOURCES,
  asRecord,
  asString,
  stableJson,
  type ClientProfileFillSource,
} from './client-profile-fill.helpers.js';
import { ClientFacilitiesService } from './client-facilities.service.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';
import { buildFillRunSummary, requeueFillReviewChecks } from './client-profile-fill-retry.js';
import {
  ClientAdvocacyMatterService,
  type FederalRegisterCorrelationSuggestion,
} from './client-advocacy-matter.service.js';
import {
  ClientProfileFillWorkflowService,
  type StartClientProfileFillWorkflowInput,
} from './client-profile-fill-workflow.service.js';
import {
  buildAppropriationsOutcomeFinding,
  isCommunityFundingAdvocacyRecord,
  matchCommunityFundingAppropriationsDeterministically,
} from './community-funding-appropriations-outcome.js';
import { ClientProfileFillAdvocacyHistory } from './client-profile-fill-advocacy-history.js';
import { MAX_ADVOCACY_FINDINGS, type AdvocacyHistoryTaskResult } from './client-profile-fill-advocacy-discovery.shared.js';
import { ClientProfileFillFindingReview } from './client-profile-fill-finding-review.js';
import type { AdvancedFindingRow } from './client-profile-fill-finding-review.shared.js';
import { ClientProfileFillRegulatoryCommentDiscovery } from './client-profile-fill-regulatory-comment-discovery.js';
import { ClientProfileFillRegulatoryCommentSource } from './client-profile-fill-regulatory-comment-source.js';
import {
  buildClientProfileFillCompletionPlan,
  calculateProfileCompletion,
  mergeFillProgress,
  type ClientProfileFillCompletionTaskType,
} from './client-profile-fill-completion-projection.js';
import {
  buildAdvocacyHistoryHealth,
  type AdvocacyHistoryHealth,
  type AdvocacySourceBackfillState,
} from './client-profile-fill-advocacy-health.js';
import {
  matchAdvocacyOutcomeDeterministically,
  normalizePersistedAdvocacy,
  parseDate,
  sameActivityDay,
  scoreAdvocacyOutcome,
  titleOverlapRatio,
} from './client-profile-fill-advocacy-mapping.js';

export {
  CLIENT_PROFILE_FILL_COMPLETION_TASK_TYPES,
  buildClientProfileFillCompletionPlan,
  calculateProfileCompletion,
  mergeFillProgress,
  type ClientProfileFillCompletionTaskType,
  type ProfileCompletionInput,
  type ProfileCompletionResult,
} from './client-profile-fill-completion-projection.js';
export {
  ADVOCACY_SOURCE_NAMES,
  buildAdvocacyHistoryHealth,
  deriveAdvocacyBackfillOverallStatus,
  deriveAdvocacyFreshness,
  deriveAdvocacyOverallHealth,
  updateAdvocacySourceHealth,
  type AdvocacyBackfillOverallStatus,
  type AdvocacyBackfillStatus,
  type AdvocacyHistoryHealth,
  type AdvocacyOverallHealth,
  type AdvocacySourceAvailability,
  type AdvocacySourceBackfillState,
  type AdvocacySourceFreshness,
  type AdvocacySourceHealth,
} from './client-profile-fill-advocacy-health.js';
export {
  buildRegulatoryOutcomeFinding,
  deriveRegulatoryCommentSubmitterLabel,
  faraMatchConfidence,
  matchAdvocacyOutcomeDeterministically,
  planTestimonyScanBatch,
  resolveFaraMatchedRole,
  sameActivityDay,
  scoreAdvocacyOutcome,
  testimonyMatchConfidence,
  titleOverlapRatio,
} from './client-profile-fill-advocacy-mapping.js';

type CompletionTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

interface CompletionTaskRow {
  id: string;
  runId: string;
  tenantId: string;
  clientId: string;
  taskType: ClientProfileFillCompletionTaskType;
  taskKey: string;
  status: CompletionTaskStatus;
  dependsOn: string[];
  attempt: number;
  maxAttempts: number;
  input: Record<string, unknown>;
  outputSummary: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  workerId: string | null;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
  nextAttemptAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdByUserId?: string | null;
}

export interface RefreshScheduleRow {
  enabled: boolean;
  cadenceHours: number;
  sources: ClientProfileFillSource[];
  nextRunAt: Date | null;
  lastEnqueuedAt: Date | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpdateClientProfileFillScheduleInput {
  enabled: boolean;
  cadenceHours?: number;
  sources?: ClientProfileFillSource[];
}
const TERMINAL_TASK_STATUSES = new Set<string>(['completed', 'failed', 'skipped', 'cancelled']);
const TASK_SWEEP_MS = 1_500;
const TASK_STALE_MS = 5 * 60_000;
const TASK_TIMEOUT_MS = 5 * 60_000;
const SCHEDULE_SWEEP_MS = 60_000;
const TASK_CLAIM_BATCH = 4;

class TaskDeferredError extends Error {}

/**
 * Remaining Fill with Meri workflow after the durable Phase 1-3 specialists.
 *
 * The original task worker is intentionally left unchanged. This service owns a
 * second, equally durable ledger so the old worker cannot claim an unknown task
 * type. The facade merges both ledgers into one run for the UI.
 */
@Injectable()
export class ClientProfileFillCompletionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClientProfileFillCompletionService.name);
  private readonly workerId = process.env.HOSTNAME ?? `api-${process.pid}`;
  private taskTimer?: ReturnType<typeof setInterval>;
  private scheduleTimer?: ReturnType<typeof setInterval>;
  private taskSweepRunning = false;
  private scheduleSweepRunning = false;
  private readonly advocacyHistory: ClientProfileFillAdvocacyHistory;
  private readonly findingReview: ClientProfileFillFindingReview;
  private readonly regulatoryCommentSource: ClientProfileFillRegulatoryCommentSource;
  private readonly regulatoryCommentDiscovery: ClientProfileFillRegulatoryCommentDiscovery;

  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: ClientProfileFillWorkflowService,
    private readonly fill: ClientProfileFillService,
    private readonly intelligence: IntelligenceService,
    private readonly facilities: ClientFacilitiesService,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly advocacyMatters: ClientAdvocacyMatterService,
  ) {
    const reporter = {
      warn: (message: string) => this.logger.warn(message),
      safeError: (error: unknown) => this.safeError(error),
    };
    this.regulatoryCommentSource = new ClientProfileFillRegulatoryCommentSource(this.prisma, reporter);
    this.regulatoryCommentDiscovery = new ClientProfileFillRegulatoryCommentDiscovery(
      this.regulatoryCommentSource,
      {
        ...reporter,
        resolveClientName: (ctx, clientId) => this.resolveClientNameForDiscovery(ctx, clientId),
        confirmedMappingKeys: (ctx, clientId, source) =>
          this.getConfirmedIntelMappingKeys(ctx, clientId, source),
        emitFinding: (ctx, clientId, runId, input) =>
          this.emitDiscoveryFinding(ctx, clientId, runId, input),
      },
      MAX_ADVOCACY_FINDINGS,
    );
    this.advocacyHistory = new ClientProfileFillAdvocacyHistory(
      this.prisma,
      this.advocacyMatters,
      this.regulatoryCommentDiscovery,
      {
        ...reporter,
        resolveClientName: (ctx, clientId) => this.resolveClientNameForDiscovery(ctx, clientId),
        confirmedMappingKeys: (ctx, clientId, source) =>
          this.getConfirmedIntelMappingKeys(ctx, clientId, source),
        emitFinding: (ctx, clientId, runId, input) =>
          this.emitDiscoveryFinding(ctx, clientId, runId, input),
        persistFinding: (tenantId, clientId, runId, input) =>
          this.addFinding(tenantId, clientId, runId, input),
        readCursor: (tenantId, clientId, source) => this.getCursor(tenantId, clientId, source),
        recordCursor: (tenantId, clientId, source, watermark) =>
          this.recordCursor(tenantId, clientId, source, watermark),
        readSchedule: (ctx, clientId) => this.getSchedule(ctx, clientId),
      },
    );
    this.findingReview = new ClientProfileFillFindingReview(
      this.prisma,
      this.fill,
      this.advocacyMatters,
      {
        ...reporter,
        getRun: (ctx, clientId, runId) => this.getRun(ctx, clientId, runId),
        confirmedMappingKeys: (ctx, clientId, source) =>
          this.getConfirmedIntelMappingKeys(ctx, clientId, source),
      },
    );
  }

  onModuleInit(): void {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED === 'false' ||
      // `NestFactory.createApplicationContext(AppModule, ...)` (e.g. the
      // LegiWatch Phase 9 one-shot CLI bootstraps, and any future one-off
      // script that reuses the full AppModule) never registers an HTTP
      // adapter, so `httpAdapterHost.httpAdapter` stays unset there. Those
      // processes run their one job in ~1s and call `app.close()`, which
      // disconnects PrismaService — starting this sweep loop in that context
      // means its interval-scheduled `withSystem`/`withTenant` call races the
      // disconnect and throws "Transaction API error: Transaction not found
      // ... obtained before disconnecting" on every invocation. Only the real
      // long-running server (`apps/api/src/main.ts`, `NestFactory.create`)
      // has a populated httpAdapter. See ClientProfileFillWorkflowService's
      // identical guard for the same class of bug.
      !this.httpAdapterHost?.httpAdapter
    ) {
      return;
    }
    this.taskTimer = setInterval(() => this.requestTaskSweep(), TASK_SWEEP_MS);
    this.taskTimer.unref?.();
    this.scheduleTimer = setInterval(() => this.requestScheduleSweep(), SCHEDULE_SWEEP_MS);
    this.scheduleTimer.unref?.();
    queueMicrotask(() => {
      this.requestTaskSweep();
      this.requestScheduleSweep();
    });
    this.logger.log(`Fill with Meri completion worker started (${this.workerId})`);
  }

  onModuleDestroy(): void {
    if (this.taskTimer) clearInterval(this.taskTimer);
    if (this.scheduleTimer) clearInterval(this.scheduleTimer);
  }

  async getSetup(ctx: TenantContext, clientId: string) {
    const [setup, refreshSchedule] = await Promise.all([
      this.workflow.getSetup(ctx, clientId),
      this.getSchedule(ctx, clientId),
    ]);
    return {
      ...setup,
      taskPreview: [
        ...setup.taskPreview,
        'Federal Market',
        'Facilities',
        'District Nexus',
        'Advocacy History',
        'Lifecycle Outcomes',
        'Reconciliation',
        'Profile Completion',
      ],
      refreshSchedule,
    };
  }

  async startRun(ctx: TenantContext, clientId: string, input: StartClientProfileFillWorkflowInput) {
    const activeCompletionRun = await this.latestActiveCompletionRun(ctx.tenantId, clientId);
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
    const schedule = await this.getSchedule(ctx, clientId);
    return this.startRun(ctx, clientId, { sources: schedule.sources });
  }

  async getAdvocacyHistoryHealth(
    ctx: TenantContext,
    clientId: string,
  ): Promise<AdvocacyHistoryHealth> {
    await this.assertClient(ctx, clientId);
    const [cursor, schedule, counts] = await Promise.all([
      this.getCursor(ctx.tenantId, clientId, 'advocacy_history'),
      this.getSchedule(ctx, clientId),
      this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$queryRawUnsafe<Array<{ status: string; count: number }>>(
          `SELECT status, COUNT(*)::int AS count
             FROM client_profile_fill_finding
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid
              AND source = 'advocacy_history' AND kind = 'advocacy_record'
              AND status IN ('pending', 'accepted', 'rejected')
            GROUP BY status`,
          ctx.tenantId,
          clientId,
        ),
      ),
    ]);
    const byStatus = new Map(counts.map((row) => [row.status, Number(row.count)]));
    return buildAdvocacyHistoryHealth(cursor, schedule.cadenceHours, schedule.nextRunAt, {
      pending: byStatus.get('pending') ?? 0,
      accepted: byStatus.get('accepted') ?? 0,
      rejected: byStatus.get('rejected') ?? 0,
    });
  }

  async getLatest(ctx: TenantContext, clientId: string) {
    const core = (await this.workflow.getLatest(ctx, clientId)) as unknown as Record<
      string,
      unknown
    > | null;
    if (!core) return null;
    const runId = asString(core.id);
    if (!runId || !(await this.hasCompletionTasks(ctx.tenantId, runId))) return core;
    return this.mergeRun(ctx, clientId, core);
  }

  async getRun(ctx: TenantContext, clientId: string, runId: string) {
    const core = (await this.workflow.getRun(ctx, clientId, runId)) as unknown as Record<
      string,
      unknown
    >;
    if (!(await this.hasCompletionTasks(ctx.tenantId, runId))) return core;
    return this.mergeRun(ctx, clientId, core);
  }

  async cancelRun(ctx: TenantContext, clientId: string, runId: string) {
    await this.assertClient(ctx, clientId);
    const hasAdvanced = await this.hasCompletionTasks(ctx.tenantId, runId);
    if (!hasAdvanced) return this.workflow.cancelRun(ctx, clientId, runId);

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Use the same run-before-task lock order as retry and finalization.
      await tx.$queryRawUnsafe(
        `SELECT id FROM client_profile_fill_run
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid FOR UPDATE`,
        runId,
        ctx.tenantId,
        clientId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_extension_task
            SET status = 'cancelled', completed_at = now(), worker_id = NULL,
                heartbeat_at = NULL, updated_at = now()
          WHERE run_id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
            AND status IN ('queued', 'running')`,
        runId,
        ctx.tenantId,
        clientId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_task
            SET status = 'cancelled', completed_at = now(), worker_id = NULL,
                heartbeat_at = NULL, updated_at = now()
          WHERE run_id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
            AND status IN ('queued', 'running')`,
        runId,
        ctx.tenantId,
        clientId,
      );
      const changed = await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_run
            SET status = 'cancelled', stage = 'cancelled', cancelled_at = now(),
                completed_at = now(), error = NULL, last_progress_at = now(), updated_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
            AND status <> 'cancelled'`,
        runId,
        ctx.tenantId,
        clientId,
      );
      if (Number(changed) !== 1) throw new BadRequestException('This run cannot be cancelled');
    });
    return this.getRun(ctx, clientId, runId);
  }

  async retryTask(ctx: TenantContext, clientId: string, runId: string, taskId: string) {
    await this.assertClient(ctx, clientId);
    const changed = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const runs = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM client_profile_fill_run
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
            AND status <> 'cancelled' FOR UPDATE`,
        runId,
        ctx.tenantId,
        clientId,
      );
      if (!runs.length) throw new BadRequestException('This run cannot be retried');
      const count = await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_extension_task
            SET status = 'queued', next_attempt_at = now(), completed_at = NULL,
                error_code = NULL, error_message = NULL, claimed_at = NULL,
                heartbeat_at = NULL, worker_id = NULL,
                max_attempts = GREATEST(max_attempts, attempt + 3), updated_at = now()
          WHERE id = $1::uuid AND run_id = $2::uuid AND tenant_id = $3::uuid
            AND client_id = $4::uuid AND status = 'failed'`,
        taskId,
        runId,
        ctx.tenantId,
        clientId,
      );
      if (Number(count) === 1) {
        await requeueFillReviewChecks(tx, runId, ctx.tenantId);
        await tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_run
              SET status = 'running', stage = 'research', completed_at = NULL,
                  error = NULL, last_progress_at = now(), updated_at = now()
            WHERE id = $1::uuid AND tenant_id = $2::uuid`,
          runId,
          ctx.tenantId,
        );
      }
      return Number(count);
    });
    if (changed !== 1) await this.workflow.retryTask(ctx, clientId, runId, taskId);
    this.requestTaskSweep();
    return this.getRun(ctx, clientId, runId);
  }

  async applyFindings(ctx: TenantContext, clientId: string, runId: string, findingIds: string[]) {
    return this.findingReview.applyFindings(ctx, clientId, runId, findingIds);
  }

  rejectFinding(ctx: TenantContext, clientId: string, findingId: string, reason?: string) {
    return this.fill.rejectFinding(ctx, clientId, findingId, reason);
  }

  restoreFinding(ctx: TenantContext, clientId: string, findingId: string) {
    return this.fill.restoreFinding(ctx, clientId, findingId);
  }

  async getSchedule(ctx: TenantContext, clientId: string) {
    await this.assertClient(ctx, clientId);
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<RefreshScheduleRow[]>(
        `SELECT enabled,
                cadence_hours AS "cadenceHours",
                sources,
                next_run_at AS "nextRunAt",
                last_enqueued_at AS "lastEnqueuedAt",
                updated_by_user_id AS "updatedByUserId",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
           FROM client_profile_fill_schedule
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid`,
        ctx.tenantId,
        clientId,
      ),
    );
    return (
      rows[0] ?? {
        enabled: false,
        cadenceHours: 168,
        sources: [...CLIENT_PROFILE_FILL_SOURCES],
        nextRunAt: null,
        lastEnqueuedAt: null,
        updatedByUserId: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }
    );
  }

  async updateSchedule(
    ctx: TenantContext,
    clientId: string,
    input: UpdateClientProfileFillScheduleInput,
  ) {
    await this.assertClient(ctx, clientId);
    const cadenceHours = input.cadenceHours ?? 168;
    if (!Number.isInteger(cadenceHours) || cadenceHours < 6 || cadenceHours > 720) {
      throw new BadRequestException('Refresh cadence must be between 6 and 720 hours');
    }
    const allowed = new Set<ClientProfileFillSource>(CLIENT_PROFILE_FILL_SOURCES);
    const sources = [
      ...new Set(input.sources?.length ? input.sources : CLIENT_PROFILE_FILL_SOURCES),
    ].filter((source): source is ClientProfileFillSource => allowed.has(source));
    if (!sources.length) throw new BadRequestException('Choose at least one refresh source');

    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO client_profile_fill_schedule
           (tenant_id, client_id, enabled, cadence_hours, sources, next_run_at,
            updated_by_user_id, updated_at)
         VALUES (
           $1::uuid, $2::uuid, $3, $4,
           ARRAY(SELECT jsonb_array_elements_text($5::jsonb)),
           CASE WHEN $3 THEN now() + make_interval(hours => $4) ELSE NULL END,
           $6::uuid, now()
         )
         ON CONFLICT (tenant_id, client_id) DO UPDATE
           SET enabled = EXCLUDED.enabled,
               cadence_hours = EXCLUDED.cadence_hours,
               sources = EXCLUDED.sources,
               next_run_at = CASE
                 WHEN EXCLUDED.enabled THEN now() + make_interval(hours => EXCLUDED.cadence_hours)
                 ELSE NULL
               END,
               updated_by_user_id = EXCLUDED.updated_by_user_id,
               updated_at = now()`,
        ctx.tenantId,
        clientId,
        input.enabled,
        cadenceHours,
        JSON.stringify(sources),
        ctx.userId,
      ),
    );
    return this.getSchedule(ctx, clientId);
  }

  /** Public for focused tests and operational recovery. */
  async sweepOnce(): Promise<void> {
    if (this.taskSweepRunning) return;
    this.taskSweepRunning = true;
    try {
      await this.recoverStaleTasks();
      const tasks = await this.claimTasks();
      await Promise.all(tasks.map((task) => this.executeClaimedTask(task)));
      await this.finalizeRuns();
    } finally {
      this.taskSweepRunning = false;
    }
  }

  /** Public for focused tests and operational recovery. */
  async sweepSchedulesOnce(): Promise<void> {
    if (this.scheduleSweepRunning) return;
    this.scheduleSweepRunning = true;
    try {
      const due = await this.prisma.withSystem((tx) =>
        tx.$queryRawUnsafe<
          Array<{
            tenantId: string;
            clientId: string;
            userId: string | null;
            sources: ClientProfileFillSource[];
            cadenceHours: number;
          }>
        >(
          `WITH due AS (
             SELECT tenant_id, client_id
               FROM client_profile_fill_schedule
              WHERE enabled = true AND next_run_at <= now()
              ORDER BY next_run_at ASC
              LIMIT 5
              FOR UPDATE SKIP LOCKED
           )
           UPDATE client_profile_fill_schedule schedule
              SET next_run_at = now() + make_interval(hours => schedule.cadence_hours),
                  updated_at = now()
             FROM due
            WHERE schedule.tenant_id = due.tenant_id AND schedule.client_id = due.client_id
           RETURNING schedule.tenant_id AS "tenantId",
                     schedule.client_id AS "clientId",
                     schedule.updated_by_user_id AS "userId",
                     schedule.sources,
                     schedule.cadence_hours AS "cadenceHours"`,
        ),
      );
      for (const row of due) await this.runScheduledRefresh(row);
    } finally {
      this.scheduleSweepRunning = false;
    }
  }

  private async ensureCompletionTasks(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<void> {
    const plan = buildClientProfileFillCompletionPlan();
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const run = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM client_profile_fill_run
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
            AND workflow_version >= 2`,
        runId,
        ctx.tenantId,
        clientId,
      );
      if (!run.length) throw new NotFoundException('Agentic Fill with Meri run not found');
      for (const task of plan) {
        await tx.$executeRawUnsafe(
          `INSERT INTO client_profile_fill_extension_task
             (run_id, tenant_id, client_id, task_type, task_key, depends_on)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::text[])
           ON CONFLICT (run_id, task_key) DO NOTHING`,
          runId,
          ctx.tenantId,
          clientId,
          task.taskType,
          task.taskKey,
          task.dependsOn,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_run
            SET setup_jsonb = setup_jsonb || '{"completionWorkflowVersion":1}'::jsonb,
                updated_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid`,
        runId,
        ctx.tenantId,
        clientId,
      );
    });
  }

  private async hasCompletionTasks(tenantId: string, runId: string): Promise<boolean> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ present: boolean }>>(
        `SELECT EXISTS(
           SELECT 1 FROM client_profile_fill_extension_task
            WHERE tenant_id = $1::uuid AND run_id = $2::uuid
         ) AS present`,
        tenantId,
        runId,
      ),
    );
    return rows[0]?.present === true;
  }

  private async latestActiveCompletionRun(tenantId: string, clientId: string) {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT DISTINCT t.run_id AS id
           FROM client_profile_fill_extension_task t
           JOIN client_profile_fill_run r ON r.id = t.run_id
          WHERE t.tenant_id = $1::uuid AND t.client_id = $2::uuid
            AND t.status IN ('queued', 'running')
            AND r.status <> 'cancelled'
          ORDER BY id DESC
          LIMIT 1`,
        tenantId,
        clientId,
      ),
    );
    return rows[0] ?? null;
  }

  private async mergeRun(ctx: TenantContext, clientId: string, core: Record<string, unknown>) {
    const runId = asString(core.id);
    if (!runId) return core;
    const tasks = await this.loadCompletionTasks(ctx.tenantId, clientId, runId);
    const coreTasks = Array.isArray(core.tasks)
      ? (core.tasks as Array<Record<string, unknown>>)
      : [];
    const allTasks = [...coreTasks, ...tasks];
    const progress = mergeFillProgress(allTasks);
    const pending =
      core.status !== 'cancelled' &&
      allTasks.some((task) => task.status === 'queued' || task.status === 'running');
    const allTerminal =
      allTasks.length > 0 &&
      allTasks.every((task) => TERMINAL_TASK_STATUSES.has(String(task.status)));
    const anyFailed = allTasks.some((task) => task.status === 'failed');
    const anyCompleted = allTasks.some(
      (task) => task.status === 'completed' || task.status === 'skipped',
    );
    const status =
      core.status === 'cancelled'
        ? 'cancelled'
        : pending
          ? 'running'
          : allTerminal
            ? anyFailed
              ? anyCompleted
                ? 'partial'
                : 'failed'
              : 'completed'
            : core.status;
    const stage = pending
      ? tasks.some(
          (task) =>
            task.status === 'running' &&
            (task.taskType === 'reconciliation' || task.taskType === 'completion_audit'),
        )
        ? 'reconciliation'
        : 'research'
      : status === 'failed'
        ? 'failed'
        : status === 'cancelled'
          ? 'cancelled'
          : 'review_ready';
    const sourceStates = { ...asRecord(core.sourceStates) };
    for (const task of tasks) {
      sourceStates[task.taskType] = {
        status: task.status,
        count: Number(asRecord(task.outputSummary).count ?? 0),
        error: task.errorMessage,
      };
    }
    return {
      ...core,
      status,
      stage,
      completedAt: pending ? null : core.completedAt,
      sourceStates,
      progress,
      tasks: allTasks,
    };
  }

  private async loadCompletionTasks(tenantId: string, clientId: string, runId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<CompletionTaskRow[]>(
        `SELECT id,
                run_id AS "runId",
                tenant_id AS "tenantId",
                client_id AS "clientId",
                task_type AS "taskType",
                task_key AS "taskKey",
                status,
                depends_on AS "dependsOn",
                attempt,
                max_attempts AS "maxAttempts",
                input_jsonb AS input,
                output_summary_jsonb AS "outputSummary",
                error_code AS "errorCode",
                error_message AS "errorMessage",
                worker_id AS "workerId",
                claimed_at AS "claimedAt",
                heartbeat_at AS "heartbeatAt",
                next_attempt_at AS "nextAttemptAt",
                completed_at AS "completedAt",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
           FROM client_profile_fill_extension_task
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
          ORDER BY created_at ASC, task_key ASC`,
        tenantId,
        clientId,
        runId,
      ),
    );
  }

  private requestTaskSweep(): void {
    void this.sweepOnce().catch((error) =>
      this.logger.error(`Fill completion sweep failed: ${this.safeError(error)}`),
    );
  }

  private requestScheduleSweep(): void {
    void this.sweepSchedulesOnce().catch((error) =>
      this.logger.error(`Fill refresh schedule sweep failed: ${this.safeError(error)}`),
    );
  }

  private async recoverStaleTasks(): Promise<void> {
    const cutoff = new Date(Date.now() - TASK_STALE_MS);
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_extension_task
            SET status = CASE WHEN attempt + 1 >= max_attempts THEN 'failed' ELSE 'queued' END,
                attempt = attempt + 1,
                completed_at = CASE WHEN attempt + 1 >= max_attempts THEN now() ELSE NULL END,
                next_attempt_at = CASE
                  WHEN attempt + 1 >= max_attempts THEN next_attempt_at
                  ELSE now() + make_interval(secs => LEAST(120, 5 * (attempt + 1)))
                END,
                error_code = 'stale_worker',
                error_message = 'Worker heartbeat expired; task recovered from durable state',
                worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL, updated_at = now()
          WHERE status = 'running'
            AND COALESCE(heartbeat_at, claimed_at, updated_at) < $1`,
        cutoff,
      ),
    );
  }

  private async claimTasks(): Promise<CompletionTaskRow[]> {
    return this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<CompletionTaskRow[]>(
        `WITH candidates AS (
           SELECT t.id
             FROM client_profile_fill_extension_task t
             JOIN client_profile_fill_run r ON r.id = t.run_id
            WHERE t.status = 'queued'
              AND t.next_attempt_at <= now()
              AND r.status <> 'cancelled'
              AND NOT EXISTS (
                SELECT 1
                  FROM client_profile_fill_extension_task dependency
                 WHERE dependency.run_id = t.run_id
                   AND dependency.task_key = ANY(t.depends_on)
                   AND dependency.status IN ('queued', 'running')
              )
            ORDER BY t.created_at ASC, t.task_key ASC
            FOR UPDATE OF t SKIP LOCKED
            LIMIT $1
         )
         UPDATE client_profile_fill_extension_task t
            SET status = 'running', worker_id = $2, claimed_at = now(),
                heartbeat_at = now(), updated_at = now()
           FROM candidates c
          WHERE t.id = c.id
         RETURNING t.id,
                   t.run_id AS "runId",
                   t.tenant_id AS "tenantId",
                   t.client_id AS "clientId",
                   t.task_type AS "taskType",
                   t.task_key AS "taskKey",
                   t.status,
                   t.depends_on AS "dependsOn",
                   t.attempt,
                   t.max_attempts AS "maxAttempts",
                   t.input_jsonb AS input,
                   t.output_summary_jsonb AS "outputSummary",
                   t.error_code AS "errorCode",
                   t.error_message AS "errorMessage",
                   t.worker_id AS "workerId",
                   t.claimed_at AS "claimedAt",
                   t.heartbeat_at AS "heartbeatAt",
                   t.next_attempt_at AS "nextAttemptAt",
                   t.completed_at AS "completedAt",
                   t.created_at AS "createdAt",
                   t.updated_at AS "updatedAt"`,
        TASK_CLAIM_BATCH,
        // A fresh lease also fences callbacks after a deferred task is reclaimed.
        `${this.workerId}:${randomUUID()}`,
      ),
    );
  }

  private async executeClaimedTask(task: CompletionTaskRow): Promise<void> {
    const runRows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ createdByUserId: string | null; status: string }>>(
        `SELECT created_by_user_id AS "createdByUserId", status
           FROM client_profile_fill_run
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid`,
        task.runId,
        task.tenantId,
        task.clientId,
      ),
    );
    const run = runRows[0];
    if (!run || run.status === 'cancelled') {
      await this.finishTask(task, 'cancelled', { count: 0 });
      return;
    }
    if (!run.createdByUserId) {
      await this.failTask(task, new Error('Fill run has no actor for governed execution'));
      return;
    }
    const ctx: TenantContext = {
      tenantId: task.tenantId,
      tenantSlug: '',
      userId: run.createdByUserId,
      clerkUserId: '',
      role: 'standard_user',
    };
    const heartbeat = setInterval(() => {
      void this.heartbeat(task).catch(() => undefined);
    }, 15_000);
    heartbeat.unref?.();
    try {
      const result = await this.withTaskTimeout(this.executeTask(ctx, task));
      await this.finishTask(
        task,
        'completed',
        typeof result === 'number' ? { count: result } : result,
      );
    } catch (error) {
      if (error instanceof TaskDeferredError) {
        await this.deferTask(task, error.message);
      } else {
        await this.failTask(task, error);
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async executeTask(
    ctx: TenantContext,
    task: CompletionTaskRow,
  ): Promise<number | AdvocacyHistoryTaskResult> {
    await this.assertCoreDependencies(task);
    switch (task.taskType) {
      case 'federal_market':
        return this.gatherFederalMarket(ctx, task.clientId, task.runId);
      case 'facility_resolution':
        return this.gatherFacilityResolution(ctx, task.clientId, task.runId);
      case 'district_nexus':
        return this.gatherDistrictNexus(ctx, task.clientId, task.runId);
      case 'advocacy_history':
        return this.gatherAdvocacyHistory(ctx, task.clientId, task.runId);
      case 'lifecycle_outcomes':
        return this.gatherLifecycleOutcomes(ctx, task.clientId, task.runId);
      case 'reconciliation':
        return this.reconcileFindings(ctx, task.clientId, task.runId);
      case 'completion_audit':
        return this.runCompletionAudit(ctx, task.clientId, task.runId, task);
      default:
        throw new Error(`Unsupported completion task ${String(task.taskType)}`);
    }
  }

  private async assertCoreDependencies(task: CompletionTaskRow): Promise<void> {
    const requirements: Partial<Record<ClientProfileFillCompletionTaskType, string[]>> = {
      federal_market: ['sam_gov'],
      facility_resolution: ['public_web', 'sam_gov', 'client_document'],
      advocacy_history: ['synced_email', 'lda', 'program_elements', 'bill_tracker'],
      lifecycle_outcomes: ['program_elements', 'bill_tracker'],
    };
    const required = requirements[task.taskType] ?? [];
    const waitForAll = task.taskType === 'reconciliation' || task.taskType === 'completion_audit';
    if (!required.length && !waitForAll) return;
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ pending: number }>>(
        `SELECT COUNT(*)::int AS pending
           FROM client_profile_fill_task
          WHERE run_id = $1::uuid AND tenant_id = $2::uuid
            AND ($4::boolean OR task_type = ANY($3::text[]))
            AND status IN ('queued', 'running')`,
        task.runId,
        task.tenantId,
        required,
        waitForAll,
      ),
    );
    if (Number(rows[0]?.pending ?? 0) > 0) {
      throw new TaskDeferredError('Waiting for prerequisite Fill specialists');
    }
  }

  private async gatherFederalMarket(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const profile = asRecord(await this.intelligence.getClientProfile(clientId, ctx.tenantId));
    const contracting = asRecord(profile.contracting);
    await this.recordCursor(ctx.tenantId, clientId, 'federal_market', {
      refreshedAt: new Date().toISOString(),
      matched: contracting.matched === true,
    });
    if (contracting.matched !== true) return 0;
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { intakeData: true },
      }),
    );
    const proposedValue = {
      contractorName: contracting.contractorName ?? null,
      totalContracts: contracting.totalContracts ?? null,
      rankByContracts: contracting.rankByContracts ?? null,
      noBidTotal: contracting.noBidTotal ?? null,
      topAgencies: Array.isArray(contracting.topAgencies) ? contracting.topAgencies : [],
      yearlySpend: Array.isArray(contracting.yearlySpend) ? contracting.yearlySpend : [],
      refreshedAt: new Date().toISOString(),
    };
    const currentValue = asRecord(client?.intakeData).federalMarket ?? null;
    return (await this.addFinding(ctx.tenantId, clientId, runId, {
      kind: 'federal_footprint',
      targetKey: 'federalMarket',
      source: 'federal_market',
      factKind: 'fact',
      currentValue,
      proposedValue,
      confidence: 0.95,
      status: 'pending',
      evidence: [
        {
          label: 'Resolved federal contracting footprint',
          source: 'Capiro Federal Market / USAspending corpus',
          metadata: {
            contractorName: proposedValue.contractorName,
            totalContracts: proposedValue.totalContracts,
          },
        },
      ],
    }))
      ? 1
      : 0;
  }

  private async gatherFacilityResolution(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const [facilities, proposedFacilities] = await this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        const rows = await tx.clientFacility.findMany({
          where: { tenantId: ctx.tenantId, clientId },
          select: {
            id: true,
            name: true,
            addressLine: true,
            city: true,
            state: true,
            zip: true,
            geocodeStatus: true,
            updatedAt: true,
          },
          orderBy: { createdAt: 'asc' },
          take: 100,
        });
        const pending = await tx.$queryRawUnsafe<Array<{ proposedValue: unknown }>>(
          `SELECT proposed_value_jsonb AS "proposedValue"
             FROM client_profile_fill_finding
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
              AND kind = 'facility' AND status = 'pending'`,
          ctx.tenantId,
          clientId,
          runId,
        );
        return [rows, pending] as const;
      },
    );
    let count = 0;
    for (const facility of facilities) {
      const missing = missingAddressParts(facility);
      if (!missing.length) continue;
      const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
        kind: 'facility_resolution',
        targetKey: `facility-resolution:${facility.id}`,
        source: 'facility_resolution',
        factKind: 'fact',
        currentValue: facility,
        proposedValue: {
          facilityId: facility.id,
          facilityName: facility.name,
          status: 'insufficient_address',
          missing,
        },
        confidence: 1,
        status: 'informational',
        evidence: [
          {
            label: `Cannot resolve ${facility.name} until ${missing.join(', ')} is supplied`,
            source: 'Client facility record',
          },
        ],
      });
      if (inserted) count += 1;
    }
    for (const row of proposedFacilities) {
      const proposal = asRecord(row.proposedValue);
      const missing = missingAddressParts(proposal);
      if (!missing.length) continue;
      const key = createHash('sha256').update(stableJson(proposal)).digest('hex').slice(0, 20);
      const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
        kind: 'facility_resolution',
        targetKey: `proposed-facility-resolution:${key}`,
        source: 'facility_resolution',
        factKind: 'fact',
        currentValue: null,
        proposedValue: {
          facilityName: asString(proposal.name) ?? 'Proposed facility',
          status: 'insufficient_address',
          missing,
        },
        confidence: 1,
        status: 'informational',
        evidence: [
          {
            label: `The proposed facility needs ${missing.join(', ')} before District Nexus can resolve it`,
            source: 'Fill with Meri public-web finding',
          },
        ],
      });
      if (inserted) count += 1;
    }
    const latest = facilities
      .map((facility) => facility.updatedAt)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    await this.recordCursor(ctx.tenantId, clientId, 'facility_resolution', {
      latestFacilityUpdatedAt: latest?.toISOString() ?? null,
      facilityCount: facilities.length,
    });
    return count;
  }

  private async gatherDistrictNexus(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clientFacility.findMany({
        where: {
          tenantId: ctx.tenantId,
          clientId,
          addressLine: { not: null },
          city: { not: null },
          state: { not: null },
        },
        select: {
          id: true,
          name: true,
          addressLine: true,
          city: true,
          state: true,
          zip: true,
          congressionalDistrict: true,
          stateHouseDistrict: true,
          stateSenateDistrict: true,
          geocodeStatus: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 25,
      }),
    );
    let count = 0;
    for (const facility of rows) {
      try {
        const resolved = await this.facilities.resolveFacilityDistrict(ctx, clientId, facility.id);
        const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
          kind: 'district_nexus',
          targetKey: `district-nexus:${facility.id}`,
          source: 'district_nexus',
          factKind: 'fact',
          currentValue: {
            congressionalDistrict: facility.congressionalDistrict,
            stateHouseDistrict: facility.stateHouseDistrict,
            stateSenateDistrict: facility.stateSenateDistrict,
            geocodeStatus: facility.geocodeStatus,
          },
          proposedValue: {
            facilityId: facility.id,
            facilityName: facility.name,
            congressionalDistrict: resolved.congressionalDistrict,
            stateHouseDistrict: resolved.stateHouseDistrict,
            stateSenateDistrict: resolved.stateSenateDistrict,
            geocodeStatus: resolved.geocodeStatus,
            matchedAddress: resolved.geocodeMatchedAddress,
            districtSource: resolved.districtSource,
          },
          confidence: resolved.geocodeStatus === 'matched' ? 1 : 0.8,
          status: 'informational',
          evidence: [
            {
              label: `Resolved ${facility.name} through the Census-authoritative district pipeline`,
              source: 'U.S. Census Geocoder / TIGER geography',
              metadata: { geocodeStatus: resolved.geocodeStatus },
            },
          ],
        });
        if (inserted) count += 1;
      } catch (error) {
        const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
          kind: 'facility_resolution',
          targetKey: `district-resolution-failed:${facility.id}`,
          source: 'district_nexus',
          factKind: 'fact',
          currentValue: facility,
          proposedValue: {
            facilityId: facility.id,
            facilityName: facility.name,
            status: 'no_match',
          },
          confidence: 1,
          status: 'informational',
          evidence: [
            {
              label: `District resolution did not produce an authoritative match for ${facility.name}`,
              source: 'Capiro facility geocoder',
              metadata: { error: this.safeError(error) },
            },
          ],
        });
        if (inserted) count += 1;
      }
    }
    await this.recordCursor(ctx.tenantId, clientId, 'district_nexus', {
      resolvedAt: new Date().toISOString(),
      attemptedFacilities: rows.length,
    });
    return count;
  }

  private async gatherAdvocacyHistory(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<AdvocacyHistoryTaskResult> {
    return this.advocacyHistory.gather(ctx, clientId, runId);
  }

  private async resolveClientNameForDiscovery(
    ctx: TenantContext,
    clientId: string,
  ): Promise<string | null> {
    return this.advocacyHistory.resolveClientNameForDiscovery(ctx, clientId);
  }

  /**
   * Shared confirmed-`client_intel_mapping` lookup for a given discovery
   * source. Returns the set of confirmed `externalId` values (which each
   * adapter interprets in its own key shape — a bare registration number
   * for FARA, a `${hearingId}::${witnessText}` compound key for testimony).
   */
  private async getConfirmedIntelMappingKeys(
    ctx: TenantContext,
    clientId: string,
    source: string,
  ): Promise<Set<string>> {
    const confirmedMappings = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source, confirmed: true },
        select: { externalId: true },
      }),
    );
    return new Set(confirmedMappings.map((m) => m.externalId));
  }

  private async emitDiscoveryFinding(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    input: {
      externalKey: string;
      isConfirmed: boolean;
      confidence: number;
      proposedValue: unknown;
      evidence: unknown[];
    },
  ): Promise<boolean> {
    return this.advocacyHistory.emitDiscoveryFinding(ctx, clientId, runId, input);
  }

  private async gatherFaraAdvocacyCandidates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
  ): Promise<{ count: number; backfill: AdvocacySourceBackfillState }> {
    return this.advocacyHistory.fara.gather(ctx, clientId, runId, currentCount);
  }

  private async gatherTestimonyAdvocacyCandidates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    lastTestimonySyncedAt: string | null,
    lastTestimonyKey: string | null,
    priorState: Record<string, unknown>,
  ): Promise<{
    count: number;
    newestSyncedAt: string | null;
    newestKey: string | null;
    backfill: AdvocacySourceBackfillState;
  }> {
    return this.advocacyHistory.testimony.gather(ctx, clientId, runId, currentCount, lastTestimonySyncedAt, lastTestimonyKey, priorState);
  }

  private async gatherRegulatoryCommentAdvocacyCandidates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    priorState: Record<string, unknown>,
  ): Promise<{ count: number; backfill: AdvocacySourceBackfillState }> {
    return this.regulatoryCommentDiscovery.gather(ctx, clientId, runId, currentCount, priorState);
  }

  private async fetchOrCacheRegulatoryCommentDetail(
    commentId: string,
    apiKey: string,
  ): Promise<{
    commentId: string;
    docketId: string | null;
    agencyId: string | null;
    commentText: string | null;
    firstName: string | null;
    lastName: string | null;
    organization: string | null;
    city: string | null;
    stateProvince: string | null;
    country: string | null;
    postedDate: Date | null;
    sourceUrl: string | null;
  } | null> {
    return this.regulatoryCommentSource.getDetail(commentId, apiKey);
  }

  private async gatherCommunityFundingAdvocacyCandidates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    lastCreatedAt: string | null,
    lastKey: string | null,
    priorState: Record<string, unknown>,
  ): Promise<{
    count: number;
    newestCreatedAt: string | null;
    newestKey: string | null;
    backfill: AdvocacySourceBackfillState;
  }> {
    return this.advocacyHistory.communityFunding.gather(ctx, clientId, runId, currentCount, lastCreatedAt, lastKey, priorState);
  }

  private async gatherClientSubmissionAdvocacy(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    lastClientSubmissionAt: string | null,
    priorState: Record<string, unknown>,
  ): Promise<{
    count: number;
    newestCreatedAt: string | null;
    backfill: AdvocacySourceBackfillState;
  }> {
    return this.advocacyHistory.tenantHistory.gatherClientSubmissions(ctx, clientId, runId, currentCount, lastClientSubmissionAt, priorState);
  }

  private async gatherPrivateAdvocacyCandidates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
    lastRelationshipLinkAppliedAt: string | null,
    priorState: Record<string, unknown>,
  ): Promise<{
    count: number;
    newestAppliedAt: string | null;
    backfill: AdvocacySourceBackfillState;
  }> {
    return this.advocacyHistory.tenantHistory.gatherPrivateCandidates(ctx, clientId, runId, currentCount, lastRelationshipLinkAppliedAt, priorState);
  }

  private async gatherFederalRegisterBackfill(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    priorState: Record<string, unknown>,
  ): Promise<AdvocacySourceBackfillState> {
    return this.advocacyHistory.federalRegister.gather(ctx, clientId, runId, priorState);
  }

  private async emitRegulatoryOutcomeFindings(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    matterId: string,
    suggestions: FederalRegisterCorrelationSuggestion[],
  ): Promise<void> {
    return this.advocacyHistory.federalRegister.emitRegulatoryOutcomeFindings(ctx, clientId, runId, matterId, suggestions);
  }

  private async gatherLifecycleOutcomes(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const [findingRows, persistedRecords, outcomes, matterIdentifiers] =
      await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const findings = await tx.$queryRawUnsafe<Array<{ proposedValue: unknown }>>(
          `SELECT proposed_value_jsonb AS "proposedValue"
             FROM client_profile_fill_finding
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
              AND kind = 'advocacy_record' AND status IN ('pending', 'accepted')`,
          ctx.tenantId,
          clientId,
          runId,
        );
        const records = await tx.$queryRawUnsafe<Array<{ data: unknown }>>(
          `SELECT to_jsonb(a) AS data
             FROM client_advocacy_record a
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid
            ORDER BY activity_date DESC NULLS LAST
            LIMIT 250`,
          ctx.tenantId,
          clientId,
        );
        const events = await tx.outcomeEvent.findMany({
          where: { tenantId: ctx.tenantId, clientId },
          select: {
            id: true,
            kind: true,
            sourceType: true,
            sourceId: true,
            evidence: true,
            notes: true,
            observedAt: true,
          },
          orderBy: { observedAt: 'desc' },
          take: 250,
        });
        // §16 deterministic-identifier priority requires matching against
        // the record's own MATTER's primary_pe_code/primary_bill_id (what
        // the Matter is actually about), not anything on the individual
        // record itself -- client_advocacy_record carries no PE/bill field
        // of its own. One extra lookup, keyed by matter_id, rather than N
        // per-record round trips.
        const identifiers = await tx.$queryRawUnsafe<
          Array<{ id: string; primaryPeCode: string | null; primaryBillId: string | null }>
        >(
          `SELECT id, primary_pe_code AS "primaryPeCode", primary_bill_id AS "primaryBillId"
             FROM client_advocacy_matter
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid`,
          ctx.tenantId,
          clientId,
        );
        return [findings, records, events, identifiers] as const;
      });
    const matterIdentifierById = new Map(matterIdentifiers.map((m) => [m.id, m] as const));
    const advocacy = [
      ...findingRows.map((row) => asRecord(row.proposedValue)),
      ...persistedRecords.map((row) => normalizePersistedAdvocacy(asRecord(row.data))),
    ];
    let count = 0;
    const seen = new Set<string>();
    for (const record of advocacy) {
      const externalKey = asString(record.externalKey);
      if (!externalKey || seen.has(externalKey)) continue;
      seen.add(externalKey);
      const activityDate = parseDate(record.activityDate);
      const matterId = asString(record.matterId);
      const matterIdentifier = matterId ? matterIdentifierById.get(matterId) : undefined;
      for (const outcome of outcomes) {
        if (activityDate && outcome.observedAt < activityDate) continue;
        const evidence = asRecord(outcome.evidence);
        const metadata = asRecord(record.metadata);

        // CPF/CDS path: ONLY deterministic appropriations correlation. Never fall
        // back to title/temporal similarity — that would invent "secured funding"
        // from weak signals (handoff after #1345).
        if (
          isCommunityFundingAdvocacyRecord({
            externalKey,
            recordType: asString(record.recordType),
            sourceType: asString(record.sourceType),
            sourceId: asString(record.sourceId),
            communityFundingRequestId:
              asString(metadata.communityFundingRequestId) ?? asString(record.sourceId),
          })
        ) {
          const cpfMatch = matchCommunityFundingAppropriationsDeterministically(
            {
              externalKey,
              recordType: asString(record.recordType),
              sourceType: asString(record.sourceType),
              sourceId: asString(record.sourceId),
              communityFundingRequestId:
                asString(metadata.communityFundingRequestId) ?? asString(record.sourceId),
              appropriationsAccountRaw:
                asString(metadata.appropriationsAccountRaw) ??
                asString(metadata.appropriations_account_raw),
              appropriationsAccountNormalized: asString(metadata.appropriationsAccountNormalized),
              fiscalYear:
                typeof metadata.fiscalYear === 'number'
                  ? metadata.fiscalYear
                  : Number(asString(metadata.fiscalYear) ?? NaN) || null,
            },
            {
              communityFundingRequestId: asString(evidence.communityFundingRequestId),
              appropriationsAccountRaw:
                asString(evidence.appropriationsAccountRaw) ??
                asString(evidence.appropriations_account_raw) ??
                asString(evidence.account),
              appropriationsAccountNormalized: asString(evidence.appropriationsAccountNormalized),
              fiscalYear:
                typeof evidence.fiscalYear === 'number' || typeof evidence.fiscalYear === 'string'
                  ? evidence.fiscalYear
                  : typeof evidence.fy === 'number' || typeof evidence.fy === 'string'
                    ? evidence.fy
                    : (asString(evidence.fiscalYear) ?? asString(evidence.fy)),
              amountStage: asString(evidence.amountStage) ?? asString(evidence.stage),
              amountFrom:
                typeof evidence.amountFrom === 'number' || typeof evidence.amountFrom === 'string'
                  ? evidence.amountFrom
                  : asString(evidence.amountFrom),
              amountTo:
                typeof evidence.amountTo === 'number' || typeof evidence.amountTo === 'string'
                  ? evidence.amountTo
                  : asString(evidence.amountTo),
              notes: outcome.notes,
            },
            {
              attributableActivityDate: activityDate,
              outcomeObservedAt: outcome.observedAt,
            },
          );
          if (!cpfMatch) continue;
          const proposedValue = buildAppropriationsOutcomeFinding({
            matterId,
            advocacyExternalKey: externalKey,
            communityFundingRequestId: cpfMatch.communityFundingRequestId,
            outcome: {
              id: outcome.id,
              kind: outcome.kind,
              sourceType: outcome.sourceType,
              sourceId: outcome.sourceId,
              observedAt: outcome.observedAt.toISOString(),
              notes: outcome.notes,
              evidence: evidence as never,
            },
            match: cpfMatch,
          });
          const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
            kind: 'advocacy_outcome',
            targetKey: `advocacy-outcome:${externalKey}:${outcome.id}`,
            source: 'lifecycle_outcomes',
            factKind: 'recommendation',
            currentValue: null,
            proposedValue,
            confidence: cpfMatch.score,
            status: 'pending',
            evidence: [
              {
                label:
                  cpfMatch.matchedOn === 'community_funding_request_id'
                    ? `Later appropriations/funding evidence cites this exact canonical CPF/CDS request (identifier alignment only — not proof funding was secured)`
                    : `Later appropriations/funding evidence matches this CPF/CDS request on exact account + FY (identifier alignment only — not proof funding was secured)`,
                source: 'Capiro Outcome Event',
                metadata: {
                  outcomeEventId: outcome.id,
                  observedAt: outcome.observedAt.toISOString(),
                  causationClaimed: false,
                  matchedOn: cpfMatch.matchedOn,
                  communityFundingRequestId: cpfMatch.communityFundingRequestId,
                  appropriationsAccountKey: cpfMatch.accountKey,
                  fiscalYear: cpfMatch.fiscalYear,
                },
              },
            ],
          });
          if (inserted) count += 1;
          if (count >= 75) break;
          continue;
        }

        const deterministic = matchAdvocacyOutcomeDeterministically(matterIdentifier, evidence);
        const score = deterministic
          ? Math.max(0.9, deterministic.score)
          : scoreAdvocacyOutcome(record, {
              kind: outcome.kind,
              sourceType: outcome.sourceType,
              sourceId: outcome.sourceId,
              notes: outcome.notes,
              evidence: outcome.evidence,
            });
        if (!deterministic && score < 0.34) continue;
        // §17 causality contract vocabulary — never a fabricated label. A
        // deterministic PE/bill match is materially stronger evidence than
        // pure semantic overlap, but it is still NOT the same as an
        // explicit source relationship or a human confirmation (§16 steps
        // 5-6) — "strongly_aligned" is the honest word for it, not
        // "confirmed_relationship".
        const relationship: 'strongly_aligned' | 'related' | 'observed_after_advocacy' =
          deterministic ? 'strongly_aligned' : score >= 0.6 ? 'related' : 'observed_after_advocacy';
        const proposedValue = {
          advocacyExternalKey: externalKey,
          outcomeEventId: outcome.id,
          outcomeKind: outcome.kind,
          observedAt: outcome.observedAt.toISOString(),
          notes: outcome.notes,
          evidence: outcome.evidence,
          relationship,
          matchedOn: deterministic?.matchedOn ?? 'semantic_and_temporal',
          causationClaimed: false,
          score,
        };
        const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
          kind: 'advocacy_outcome',
          targetKey: `advocacy-outcome:${externalKey}:${outcome.id}`,
          source: 'lifecycle_outcomes',
          factKind: 'recommendation',
          currentValue: null,
          proposedValue,
          confidence: score,
          status: 'pending',
          evidence: [
            {
              label: deterministic
                ? `Observed outcome "${outcome.kind}" matches this Matter's ${deterministic.matchedOn === 'pe_code' ? 'Program Element' : 'bill'} exactly`
                : `Observed outcome "${outcome.kind}" followed a related advocacy record`,
              source: 'Capiro Outcome Event',
              metadata: {
                outcomeEventId: outcome.id,
                observedAt: outcome.observedAt.toISOString(),
                causationClaimed: false,
                matchedOn: deterministic?.matchedOn ?? 'semantic_and_temporal',
              },
            },
          ],
        });
        if (inserted) count += 1;
        if (count >= 75) break;
      }
      if (count >= 75) break;
    }
    await this.recordCursor(ctx.tenantId, clientId, 'lifecycle_outcomes', {
      refreshedAt: new Date().toISOString(),
      latestOutcomeAt: outcomes[0]?.observedAt.toISOString() ?? null,
    });
    return count;
  }

  private async reconcileFindings(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<AdvancedFindingRow[]>(
        `SELECT id,
                kind,
                target_key AS "targetKey",
                source,
                fact_kind AS "factKind",
                current_value_jsonb AS "currentValue",
                proposed_value_jsonb AS "proposedValue",
                evidence_jsonb AS evidence,
                confidence,
                status,
                content_hash AS "contentHash"
           FROM client_profile_fill_finding
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
            AND status = 'pending'
          ORDER BY confidence DESC, created_at ASC`,
        ctx.tenantId,
        clientId,
        runId,
      ),
    );
    const groups = new Map<string, AdvancedFindingRow[]>();
    for (const row of rows) {
      const key = `${row.kind}:${row.targetKey}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    let changed = 0;
    for (const [key, group] of groups) {
      if (group.length < 2) continue;
      const distinct = new Set(group.map((row) => stableJson(row.proposedValue)));
      if (distinct.size === 1) {
        for (const duplicate of group.slice(1)) {
          await this.prisma.withTenant(ctx.tenantId, (tx) =>
            tx.$executeRawUnsafe(
              `UPDATE client_profile_fill_finding
                  SET status = 'informational', updated_at = now()
                WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'pending'`,
              duplicate.id,
              ctx.tenantId,
            ),
          );
          changed += 1;
        }
        continue;
      }
      const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
        kind: 'profile_completion',
        targetKey: `conflict:${createHash('sha256').update(key).digest('hex').slice(0, 20)}`,
        source: 'reconciliation',
        factKind: 'recommendation',
        currentValue: null,
        proposedValue: {
          type: 'conflict',
          target: key,
          findingIds: group.map((row) => row.id),
          message:
            'Multiple sources proposed different values. Review them individually; none was auto-selected.',
        },
        confidence: 1,
        status: 'informational',
        evidence: group.map((row) => ({
          label: `${row.source} proposed a value for ${row.targetKey}`,
          source: row.source,
          metadata: { findingId: row.id, confidence: Number(row.confidence) },
        })),
      });
      if (inserted) changed += 1;
    }
    // Link this run's informational Program Element / bill findings into any
    // Matter that already carries the same PE code / bill id as its
    // `primary_pe_code` / `primary_bill_id` (set when a durable advocacy
    // record for that PE/bill was clustered — see
    // client-advocacy-matter.helpers.ts computeMatterClue). This is how a
    // Matter picks up "Program Elements" and "bills" per the product spec
    // even for findings that stay informational and never become their own
    // client_advocacy_record row.
    changed += await this.linkReconciledFindingsToMatters(ctx, clientId, runId);
    // §27 reconciliation: flag a possible cross-source duplicate advocacy
    // activity — the SAME real-world event discovered via two DIFFERENT
    // source rails (e.g. an LDA filing and a client submission describing
    // the same meeting), which the exact-targetKey grouping above can
    // never catch since each rail mints its own unrelated externalKey.
    // Deterministic-source-id duplicates are already handled elsewhere
    // (client_advocacy_record's ON CONFLICT (tenant_id, client_id,
    // external_key) upsert, and addFinding's content-hash dedup) — this
    // path exists ONLY for the case those can't cover: two DIFFERENT
    // external keys that plausibly describe the same activity. Never
    // auto-merges (§27: "Do not collapse two distinct events merely
    // because text is similar") — always a reviewable informational
    // finding a human confirms or dismisses.
    changed += await this.flagPossibleAdvocacyDuplicates(ctx, clientId, runId, rows);
    return changed;
  }

  /** §27: within this run, flags pending/informational advocacy_record
   *  findings that plausibly describe the same real-world activity but
   *  arrived via different source rails (different externalKey, so the
   *  exact-key grouping in reconcileFindings never sees them together).
   *  Deterministic signal first: same day AND >=60% title-token overlap.
   *  Never merges — surfaces an informational "possible duplicate" finding
   *  naming both candidates so a human decides. */
  private async flagPossibleAdvocacyDuplicates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    rows: AdvancedFindingRow[],
  ): Promise<number> {
    const advocacyRows = rows.filter(
      (row) => row.kind === 'advocacy_record' && row.status !== 'rejected',
    );
    let changed = 0;
    for (let i = 0; i < advocacyRows.length; i++) {
      for (let j = i + 1; j < advocacyRows.length; j++) {
        const a = advocacyRows[i]!;
        const b = advocacyRows[j]!;
        if (a.targetKey === b.targetKey) continue; // already the same key — handled by exact-key grouping above
        const proposedA = asRecord(a.proposedValue);
        const proposedB = asRecord(b.proposedValue);
        if (!sameActivityDay(proposedA.activityDate, proposedB.activityDate)) continue;
        if (titleOverlapRatio(asString(proposedA.title), asString(proposedB.title)) < 0.6) continue;
        const pairKey = [a.targetKey, b.targetKey].sort().join('|');
        const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
          kind: 'advocacy_duplicate_candidate',
          targetKey: `advocacy-duplicate:${createHash('sha256').update(pairKey).digest('hex').slice(0, 20)}`,
          source: 'reconciliation',
          factKind: 'recommendation',
          currentValue: null,
          proposedValue: {
            type: 'possible_duplicate',
            findingIds: [a.id, b.id],
            message:
              'Two different sources may describe the same advocacy activity on the same day. Review before accepting both.',
          },
          confidence: 0.6,
          status: 'informational',
          evidence: [
            {
              label: `${a.source}: ${asString(proposedA.title) ?? a.targetKey}`,
              source: a.source,
              metadata: { findingId: a.id },
            },
            {
              label: `${b.source}: ${asString(proposedB.title) ?? b.targetKey}`,
              source: b.source,
              metadata: { findingId: b.id },
            },
          ],
        });
        if (inserted) changed += 1;
      }
    }
    return changed;
  }

  private async linkReconciledFindingsToMatters(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): Promise<number> {
    const findings = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string; kind: string; proposedValue: unknown }>>(
        `SELECT id, kind, proposed_value_jsonb AS "proposedValue"
           FROM client_profile_fill_finding
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
            AND kind IN ('program_element', 'bill_recommendation')`,
        ctx.tenantId,
        clientId,
        runId,
      ),
    );
    let linked = 0;
    for (const finding of findings) {
      const proposed = asRecord(finding.proposedValue);
      const isPe = finding.kind === 'program_element';
      const matterColumn = isPe ? 'primary_pe_code' : 'primary_bill_id';
      const matterValue = isPe ? asString(proposed.peCode) : asString(proposed.billId);
      if (!matterValue) continue;
      const matterRows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM client_advocacy_matter
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND ${matterColumn} = $3
            LIMIT 1`,
          ctx.tenantId,
          clientId,
          matterValue,
        ),
      );
      const matterId = matterRows[0]?.id;
      if (!matterId) continue;
      try {
        await this.advocacyMatters.linkToMatter(ctx, matterId, {
          linkType: isPe ? 'program_element' : 'bill',
          linkKey: matterValue,
          label: asString(proposed.title) ?? matterValue,
          metadata: { findingId: finding.id },
        });
        linked += 1;
      } catch (error) {
        this.logger.warn(
          `Advocacy matter finding link failed for ${clientId}/${matterId}: ${this.safeError(error)}`,
        );
      }
    }
    return linked;
  }

  private async runCompletionAudit(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    task: CompletionTaskRow,
  ): Promise<number> {
    const snapshot = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: {
          website: true,
          description: true,
          uei: true,
          cageCode: true,
          ldaClientIds: true,
          intakeData: true,
          _count: {
            select: {
              capabilities: true,
              people: true,
              facilities: true,
              meetings: true,
              mailThreads: true,
            },
          },
        },
      });
      if (!client) throw new NotFoundException('Client not found');
      const [resolvedFacilities, advocacyRecords, findingCounts] = await Promise.all([
        tx.clientFacility.count({
          where: {
            tenantId: ctx.tenantId,
            clientId,
            congressionalDistrict: { not: null },
          },
        }),
        tx.$queryRawUnsafe<Array<{ count: number }>>(
          `SELECT COUNT(*)::int AS count
             FROM client_advocacy_record
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid`,
          ctx.tenantId,
          clientId,
        ),
        tx.$queryRawUnsafe<Array<{ kind: string; count: number }>>(
          `SELECT kind, COUNT(*)::int AS count
             FROM client_profile_fill_finding
            WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
            GROUP BY kind`,
          ctx.tenantId,
          clientId,
          runId,
        ),
      ]);
      return { client, resolvedFacilities, advocacyRecords, findingCounts };
    });
    const counts = Object.fromEntries(
      snapshot.findingCounts.map((row) => [row.kind, Number(row.count)]),
    );
    const federalMarket = asRecord(snapshot.client.intakeData).federalMarket;
    const completion = calculateProfileCompletion({
      federalIdentity: snapshot.client.ldaClientIds.length > 0,
      website: Boolean(snapshot.client.website?.trim()),
      overview: Boolean(snapshot.client.description?.trim()),
      governmentIdentity: Boolean(snapshot.client.uei || snapshot.client.cageCode),
      capabilities: snapshot.client._count.capabilities > 0 || Number(counts.capability ?? 0) > 0,
      relationships:
        snapshot.client._count.people > 0 &&
        snapshot.client._count.meetings + snapshot.client._count.mailThreads > 0,
      facilities: snapshot.client._count.facilities > 0 || Number(counts.facility ?? 0) > 0,
      districtNexus: snapshot.resolvedFacilities > 0,
      federalMarket: Boolean(federalMarket) || Number(counts.federal_footprint ?? 0) > 0,
      lobbyingHistory: Number(counts.lda_history ?? 0) > 0,
      advocacyHistory:
        Number(snapshot.advocacyRecords[0]?.count ?? 0) > 0 ||
        Number(counts.advocacy_record ?? 0) > 0,
      programElements: Number(counts.program_element ?? 0) > 0,
      bills: Number(counts.bill_recommendation ?? 0) > 0,
    });
    const failedTasks = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ taskType: string; errorMessage: string | null }>>(
        `SELECT task_type AS "taskType", error_message AS "errorMessage"
           FROM client_profile_fill_extension_task
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
            AND status = 'failed'`,
        ctx.tenantId,
        clientId,
        runId,
      ),
    );
    const inserted = await this.addFinding(
      ctx.tenantId,
      clientId,
      runId,
      {
        kind: 'profile_completion',
        targetKey: 'profile-completion',
        source: 'completion_audit',
        factKind: 'fact',
        currentValue: null,
        proposedValue: {
          ...completion,
          warnings: failedTasks.map((task) => ({
            task: task.taskType,
            message: task.errorMessage ?? 'Source unavailable',
          })),
          calculatedAt: new Date().toISOString(),
        },
        confidence: 1,
        status: 'informational',
        evidence: [
          {
            label: `${completion.score}% of the defined client profile domains are complete`,
            source: 'Capiro deterministic completion audit',
            metadata: { completed: completion.completed, missing: completion.missing },
          },
        ],
      },
      task,
    );
    return inserted ? 1 : 0;
  }

  private async addFinding(
    tenantId: string,
    clientId: string,
    runId: string,
    input: {
      kind: string;
      targetKey: string;
      source: string;
      factKind: 'fact' | 'recommendation';
      currentValue: unknown;
      proposedValue: unknown;
      confidence: number;
      evidence: unknown[];
      status: 'pending' | 'informational';
    },
    task?: Pick<CompletionTaskRow, 'id' | 'workerId'>,
  ): Promise<boolean> {
    const contentHash = createHash('sha256')
      .update(
        stableJson({
          kind: input.kind,
          targetKey: input.targetKey,
          source: input.source,
          proposedValue: input.proposedValue,
        }),
      )
      .digest('hex');
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (task) {
        // Serialize the audit write with retry/cancel so an invalidated audit
        // cannot append a stale score after its replacement has finished.
        const lease = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM client_profile_fill_extension_task
            WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
              AND run_id = $4::uuid AND status = 'running' AND worker_id = $5
            FOR UPDATE`,
          task.id,
          tenantId,
          clientId,
          runId,
          task.workerId,
        );
        if (!lease.length) return false;
      }
      const terminal = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id
           FROM client_profile_fill_finding
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND content_hash = $3
            AND status IN ('accepted', 'rejected')
          LIMIT 1`,
        tenantId,
        clientId,
        contentHash,
      );
      if (terminal.length) return false;
      await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_finding
            SET status = 'informational', updated_at = now()
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND content_hash = $3
            AND run_id <> $4::uuid AND status = 'pending'`,
        tenantId,
        clientId,
        contentHash,
        runId,
      );
      const inserted = await tx.$executeRawUnsafe(
        `INSERT INTO client_profile_fill_finding
           (run_id, tenant_id, client_id, kind, target_key, source, fact_kind,
            current_value_jsonb, proposed_value_jsonb, evidence_jsonb, confidence,
            status, content_hash)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
                 $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13)
         ON CONFLICT (run_id, content_hash) DO NOTHING`,
        runId,
        tenantId,
        clientId,
        input.kind,
        input.targetKey,
        input.source,
        input.factKind,
        JSON.stringify(input.currentValue ?? null),
        JSON.stringify(input.proposedValue),
        JSON.stringify(input.evidence),
        Math.max(0, Math.min(1, input.confidence)),
        input.status,
        contentHash,
      );
      return Number(inserted) > 0;
    });
  }

  private async applyAdvocacyRecord(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
    matterTarget?:
      | { matterId: string }
      | { newMatter: { title: string; matterType?: string; summary?: string | null } },
  ): Promise<string | null> {
    return this.findingReview.applyAdvocacyRecord(ctx, clientId, finding, matterTarget);
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
    return this.findingReview.applyAdvocacyFindingToMatter(ctx, clientId, runId, findingId, target);
  }

  private async getCursor(tenantId: string, clientId: string, source: string) {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ watermark: unknown }>>(
        `SELECT watermark_jsonb AS watermark
           FROM client_profile_fill_source_cursor
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND source = $3`,
        tenantId,
        clientId,
        source,
      ),
    );
    return asRecord(rows[0]?.watermark);
  }

  private async recordCursor(
    tenantId: string,
    clientId: string,
    source: string,
    watermark: Record<string, unknown>,
  ) {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO client_profile_fill_source_cursor
           (tenant_id, client_id, source, watermark_jsonb, last_successful_at,
            last_attempt_at, last_error, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, now(), now(), NULL, now())
         ON CONFLICT (tenant_id, client_id, source) DO UPDATE
           SET watermark_jsonb = client_profile_fill_source_cursor.watermark_jsonb || EXCLUDED.watermark_jsonb,
               last_successful_at = now(), last_attempt_at = now(), last_error = NULL,
               updated_at = now()`,
        tenantId,
        clientId,
        source,
        JSON.stringify(watermark),
      ),
    );
  }

  private async finishTask(
    task: CompletionTaskRow,
    status: Extract<CompletionTaskStatus, 'completed' | 'skipped' | 'cancelled'>,
    summary: Record<string, unknown>,
  ) {
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_extension_task
            SET status = $4, output_summary_jsonb = $5::jsonb,
                completed_at = now(), heartbeat_at = NULL, worker_id = NULL,
                error_code = NULL, error_message = NULL, updated_at = now()
          WHERE id = $1::uuid AND run_id = $2::uuid AND tenant_id = $3::uuid
            AND status = 'running' AND worker_id = $6`,
        task.id,
        task.runId,
        task.tenantId,
        status,
        JSON.stringify(summary),
        task.workerId,
      ),
    );
  }

  private async deferTask(task: CompletionTaskRow, reason: string) {
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_extension_task
            SET status = 'queued', next_attempt_at = now() + interval '2 seconds',
                claimed_at = NULL, heartbeat_at = NULL, worker_id = NULL,
                error_code = 'waiting_for_dependency', error_message = $4, updated_at = now()
          WHERE id = $1::uuid AND run_id = $2::uuid AND tenant_id = $3::uuid
            AND status = 'running' AND worker_id = $5`,
        task.id,
        task.runId,
        task.tenantId,
        reason,
        task.workerId,
      ),
    );
  }

  private async failTask(task: CompletionTaskRow, error: unknown) {
    const nextAttempt = task.attempt + 1;
    const terminal = nextAttempt >= task.maxAttempts;
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_extension_task
            SET status = $4,
                attempt = attempt + 1,
                completed_at = CASE WHEN $4 = 'failed' THEN now() ELSE NULL END,
                next_attempt_at = CASE
                  WHEN $4 = 'failed' THEN next_attempt_at
                  ELSE now() + make_interval(secs => LEAST(120, 5 * (attempt + 1)))
                END,
                error_code = 'task_error', error_message = $5,
                claimed_at = NULL, heartbeat_at = NULL, worker_id = NULL,
                updated_at = now()
          WHERE id = $1::uuid AND run_id = $2::uuid AND tenant_id = $3::uuid
            AND status = 'running' AND worker_id = $6`,
        task.id,
        task.runId,
        task.tenantId,
        terminal ? 'failed' : 'queued',
        this.safeError(error),
        task.workerId,
      ),
    );
  }

  private async heartbeat(task: CompletionTaskRow) {
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_extension_task
            SET heartbeat_at = now(), updated_at = now()
          WHERE id = $1::uuid AND status = 'running' AND worker_id = $2`,
        task.id,
        task.workerId,
      ),
    );
  }

  private async finalizeRuns(): Promise<void> {
    const runs = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ runId: string; tenantId: string }>>(
        `SELECT r.id AS "runId", r.tenant_id AS "tenantId"
           FROM client_profile_fill_run r
          WHERE r.status <> 'cancelled'
            AND EXISTS (SELECT 1 FROM client_profile_fill_extension_task extension
                         WHERE extension.run_id = r.id AND extension.tenant_id = r.tenant_id
                           AND (r.completed_at IS NULL OR extension.updated_at > r.completed_at))
            AND NOT EXISTS (
              SELECT 1 FROM client_profile_fill_extension_task pending
               WHERE pending.run_id = r.id AND pending.tenant_id = r.tenant_id
                 AND pending.status IN ('queued', 'running')
            )
            AND NOT EXISTS (
              SELECT 1 FROM client_profile_fill_task pending
               WHERE pending.run_id = r.id AND pending.tenant_id = r.tenant_id
                 AND pending.status IN ('queued', 'running')
            )
          ORDER BY r.updated_at ASC
          LIMIT 20`,
      ),
    );
    for (const run of runs) {
      await this.prisma.withSystem(async (tx) => {
        // Serialize with retry, then re-read BOTH task groups under the lock.
        const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM client_profile_fill_run WHERE id = $1::uuid
            AND tenant_id = $2::uuid AND status <> 'cancelled' FOR UPDATE`,
          run.runId,
          run.tenantId,
        );
        if (!locked.length) return;
        const statuses = await tx.$queryRawUnsafe<Array<{ status: string }>>(
          `SELECT status FROM client_profile_fill_task
            WHERE run_id = $1::uuid AND tenant_id = $2::uuid
           UNION ALL
           SELECT status FROM client_profile_fill_extension_task
            WHERE run_id = $1::uuid AND tenant_id = $2::uuid`,
          run.runId,
          run.tenantId,
        );
        if (statuses.some((row) => !TERMINAL_TASK_STATUSES.has(row.status))) return;
        const failed = statuses.filter((row) => row.status === 'failed').length;
        const completed = statuses.filter(
          (row) => row.status === 'completed' || row.status === 'skipped',
        ).length;
        const status = failed > 0 ? (completed > 0 ? 'partial' : 'failed') : 'completed';
        const summary = await buildFillRunSummary(tx, run.runId, run.tenantId);
        await tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_run
              SET status = $3,
                  stage = CASE WHEN $3 = 'failed' THEN 'failed' ELSE 'review_ready' END,
                  summary_jsonb = $4::jsonb,
                  completed_at = now(),
                  last_progress_at = now(), updated_at = now(),
                  error = CASE WHEN $3 = 'failed' THEN 'All Fill with Meri tasks failed' ELSE NULL END
            WHERE id = $1::uuid AND tenant_id = $2::uuid AND status <> 'cancelled'`,
          run.runId,
          run.tenantId,
          status,
          JSON.stringify(summary),
        );
      });
    }
  }

  private async runScheduledRefresh(row: {
    tenantId: string;
    clientId: string;
    userId: string | null;
    sources: ClientProfileFillSource[];
    cadenceHours: number;
  }) {
    if (!row.userId) {
      await this.bumpSchedule(row.tenantId, row.clientId, row.cadenceHours, false);
      return;
    }
    const ctx: TenantContext = {
      tenantId: row.tenantId,
      tenantSlug: '',
      userId: row.userId,
      clerkUserId: '',
      role: 'standard_user',
    };
    try {
      await this.startRun(ctx, row.clientId, { sources: row.sources });
      await this.bumpSchedule(row.tenantId, row.clientId, row.cadenceHours, true);
    } catch (error) {
      this.logger.warn(
        `Scheduled Fill with Meri refresh failed for ${row.clientId}: ${this.safeError(error)}`,
      );
      await this.bumpSchedule(row.tenantId, row.clientId, Math.min(24, row.cadenceHours), false);
    }
  }

  private async bumpSchedule(
    tenantId: string,
    clientId: string,
    cadenceHours: number,
    enqueued: boolean,
  ) {
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_schedule
            SET next_run_at = now() + make_interval(hours => $3),
                last_enqueued_at = CASE WHEN $4 THEN now() ELSE last_enqueued_at END,
                updated_at = now()
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND enabled = true`,
        tenantId,
        clientId,
        cadenceHours,
        enqueued,
      ),
    );
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Fill completion specialist exceeded its task budget')),
            TASK_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private safeError(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return raw
      .replace(/(api[_-]?key|authorization|bearer)\s*[:=]?\s*[^\s,;]+/gi, '$1=[redacted]')
      .slice(0, 800);
  }
}





function missingAddressParts(
  value:
    | Record<string, unknown>
    | {
        addressLine?: string | null;
        city?: string | null;
        state?: string | null;
      },
) {
  const row = value as Record<string, unknown>;
  const missing: string[] = [];
  if (!asString(row.addressLine)) missing.push('street address');
  if (!asString(row.city)) missing.push('city');
  if (!asString(row.state)) missing.push('state');
  return missing;
}
