import { matchesAdvocacyOrganization, matchesTestimonyOrganization } from '@capiro/shared';
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
import type { Prisma } from '@prisma/client';
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
  COMMUNITY_FUNDING_INTEL_MAPPING_SOURCE,
  communityFundingFindingSummary,
  communityFundingFindingTitle,
  filterAmbiguousCommunityFundingMatches,
  resolveCommunityFundingRecipientMatch,
  type CommunityFundingMatchDecision,
} from './community-funding-advocacy-match.js';
import {
  buildAppropriationsOutcomeFinding,
  isCommunityFundingAdvocacyRecord,
  matchCommunityFundingAppropriationsDeterministically,
} from './community-funding-appropriations-outcome.js';
import { ClientProfileFillRegulatoryCommentDiscovery } from './client-profile-fill-regulatory-comment-discovery.js';
import { ClientProfileFillRegulatoryCommentSource } from './client-profile-fill-regulatory-comment-source.js';
import {
  buildClientProfileFillCompletionPlan,
  calculateProfileCompletion,
  mergeFillProgress,
  type ClientProfileFillCompletionTaskType,
} from './client-profile-fill-completion-projection.js';
import {
  ADVOCACY_SOURCE_NAMES,
  buildAdvocacyHistoryHealth,
  deriveAdvocacyBackfillOverallStatus,
  deriveAdvocacyOverallHealth,
  updateAdvocacySourceHealth,
  type AdvocacyBackfillOverallStatus,
  type AdvocacyBackfillStatus,
  type AdvocacyHistoryHealth,
  type AdvocacySourceBackfillState,
} from './client-profile-fill-advocacy-health.js';
import {
  buildRegulatoryOutcomeFinding,
  containsAdvocacyTerm,
  faraMatchConfidence,
  matchAdvocacyOutcomeDeterministically,
  normalizeEvidenceClass,
  normalizePersistedAdvocacy,
  parseDate,
  planTestimonyScanBatch,
  recordsFromUnknown,
  resolveFaraMatchedRole,
  sameActivityDay,
  scoreAdvocacyOutcome,
  summarizeLdaActivity,
  testimonyMatchConfidence,
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

interface AdvancedFindingRow {
  id: string;
  kind: string;
  targetKey: string;
  source: string;
  factKind: string;
  currentValue: unknown;
  proposedValue: unknown;
  evidence: unknown;
  confidence: number | string;
  status: string;
  contentHash: string;
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

interface AdvocacyHistoryTaskResult {
  [key: string]: unknown;
  count: number;
  overallStatus: AdvocacyBackfillOverallStatus;
  sources: Record<string, AdvocacySourceBackfillState>;
}

interface LdaBackfillRow {
  filingUuid: string;
  clientId: number;
  clientName: string;
  filingType: string;
  filingYear: number;
  filingPeriod: string | null;
  dtPosted: Date | null;
  scanAt: Date;
  registrantName: string;
  clientDescription: string | null;
  income: unknown;
  expenses: unknown;
  issueCodes: string[];
  governmentEntities: unknown;
  lobbyingActivities: unknown;
  filingDocumentUrl: string | null;
}

export interface UpdateClientProfileFillScheduleInput {
  enabled: boolean;
  cadenceHours?: number;
  sources?: ClientProfileFillSource[];
}

const ADVANCED_FINDING_KINDS = new Set([
  'federal_footprint',
  'facility_resolution',
  'district_nexus',
  'advocacy_record',
  'advocacy_outcome',
  'regulatory_outcome',
  'profile_completion',
]);
const NON_APPLYABLE_ADVANCED_KINDS = new Set([
  'facility_resolution',
  'district_nexus',
  'profile_completion',
]);
const TERMINAL_TASK_STATUSES = new Set<string>(['completed', 'failed', 'skipped', 'cancelled']);
const TASK_SWEEP_MS = 1_500;
const TASK_STALE_MS = 5 * 60_000;
const TASK_TIMEOUT_MS = 5 * 60_000;
const SCHEDULE_SWEEP_MS = 60_000;
const TASK_CLAIM_BATCH = 4;
const MAX_ADVOCACY_FINDINGS = 200;
const LDA_BACKFILL_BATCH_SIZE = 250;
// Same trigram-similarity floor client-profile-fill-workflow.service.ts uses
// for LDA identity suggestion (0.42), lightly raised because FARA registrant
// names are matched against a client's own registered legal name (a tighter
// domain) rather than against a broad free-text website/company-name blob.
const FARA_AUTO_MATCH_THRESHOLD = 0.5;
// client_intel_mapping.source value for FARA client-match confirmations.
// Named constant (not an inline 'fara' string literal) so this Prisma filter
// text never collides with client-profile-fill-finding-source-check.contract.spec.ts's
// blunt `source:\s*'([a-z_]+)'` regex, which scans this file for EVERY
// `source: '...'` literal to validate against addFinding's allowed values —
// it cannot distinguish an addFinding() call's `source` from an unrelated
// Prisma where-clause field of the same name.
const FARA_INTEL_MAPPING_SOURCE = 'fara';
// Congressional testimony auto-discovery: `committee_hearing.witnesses` is a
// bare text[] of "name, position, organization" strings (see formatWitnesses
// in hearing-discovery/adapters/congress-gov-parse.ts) — no separate witness
// identity table. Org-name similarity against that free-text blob is noisier
// than FARA's clean registrant_name column, hence a slightly higher floor.
const TESTIMONY_AUTO_MATCH_THRESHOLD = 0.55;
// client_intel_mapping.source value for testimony client-match confirmations.
// Same named-constant reasoning as FARA_INTEL_MAPPING_SOURCE above.
const TESTIMONY_INTEL_MAPPING_SOURCE = 'testimony';
// Bounded page size for the testimony KEYSET SCAN (distinct from
// MAX_ADVOCACY_FINDINGS, which caps FINDINGS emitted across the whole
// gatherAdvocacyHistory call, not rows examined). Unlike FARA's small/
// rarely-mutating table, `committee_hearing` grows continuously, so the scan
// must be a real bounded, resumable page — never "however many rows a
// similarity filter happens to leave after ORDER BY date DESC LIMIT 50",
// which silently drops any eligible row past the first 50 and never
// advances at all when a page contains zero matches. See
// `planTestimonyScanBatch` for the pagination/cursor-advancement contract.
const TESTIMONY_SCAN_BATCH_SIZE = 500;
// Bounded page for the CPF/CDS canonical-request KEYSET SCAN. Distinct from
// MAX_ADVOCACY_FINDINGS (which caps FINDINGS emitted). community_funding_request
// is global and can hold thousands of rows per FY; the scan must be a real
// bounded, resumable page that advances even when a page yields zero matches.
const COMMUNITY_FUNDING_SCAN_BATCH_SIZE = 500;

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
    const findings = await this.loadFindings(ctx.tenantId, clientId, runId, findingIds);
    if (findings.length !== new Set(findingIds).size) {
      throw new BadRequestException('One or more findings are no longer available');
    }
    const advanced = findings.filter((finding) => ADVANCED_FINDING_KINDS.has(finding.kind));
    const coreIds = findings
      .filter((finding) => !ADVANCED_FINDING_KINDS.has(finding.kind))
      .map((finding) => finding.id);

    if (coreIds.length) await this.fill.applyFindings(ctx, clientId, runId, coreIds);
    advanced.sort((a, b) => {
      if (a.kind === 'advocacy_record' && b.kind === 'advocacy_outcome') return -1;
      if (a.kind === 'advocacy_outcome' && b.kind === 'advocacy_record') return 1;
      return 0;
    });
    for (const finding of advanced) {
      if (finding.status !== 'pending') {
        throw new BadRequestException('Only pending findings can be applied');
      }
      if (NON_APPLYABLE_ADVANCED_KINDS.has(finding.kind)) {
        throw new BadRequestException(
          'This item is informational and is not applied to the client record',
        );
      }
      await this.applyAdvancedFinding(ctx, clientId, finding);
      await this.markAccepted(ctx, clientId, finding.id);
    }
    return this.getRun(ctx, clientId, runId);
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
    const runRows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ selectedLdaIds: number[] }>>(
        `SELECT selected_lda_ids AS "selectedLdaIds"
           FROM client_profile_fill_run
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid`,
        runId,
        ctx.tenantId,
        clientId,
      ),
    );
    const ldaIds = runRows[0]?.selectedLdaIds ?? [];
    const cursor = await this.getCursor(ctx.tenantId, clientId, 'advocacy_history');
    const priorBackfill = asRecord(cursor.backfill);
    const priorSources = asRecord(priorBackfill.sources);
    const invocationStartedAt = new Date().toISOString();
    const sourceStates: Record<string, AdvocacySourceBackfillState> = {};
    const lastDtPosted = asString(cursor.lastLdaPostedAt);
    const priorLda = asRecord(priorSources.lda);
    const priorLdaCheckpoint = asRecord(priorLda.checkpoint);
    const ldaBackfillWasComplete = asString(priorLda.status) === 'complete';
    const ldaCheckpointAt = ldaBackfillWasComplete
      ? lastDtPosted
      : asString(priorLdaCheckpoint.scanAt);
    const ldaCheckpointKey = ldaBackfillWasComplete
      ? (asString(cursor.lastLdaKey) ?? '')
      : (asString(priorLdaCheckpoint.key) ?? '');
    const ldaCheckpointActivity = ldaBackfillWasComplete
      ? Number(cursor.lastLdaActivityIndex ?? -1)
      : Number(priorLdaCheckpoint.activityIndex ?? -1);
    let filings: LdaBackfillRow[] = [];
    let ldaError: string | null = null;
    try {
      filings = ldaIds.length
        ? await this.prisma.$queryRawUnsafe<LdaBackfillRow[]>(
            `SELECT filing_uuid AS "filingUuid",
                  client_id AS "clientId",
                  client_name AS "clientName",
                  filing_type AS "filingType",
                  filing_year AS "filingYear",
                  filing_period AS "filingPeriod",
                  dt_posted AS "dtPosted",
                  COALESCE(dt_posted, make_date(filing_year, 1, 1)::timestamptz) AS "scanAt",
                  registrant_name AS "registrantName",
                  client_description AS "clientDescription",
                  income,
                  expenses,
                  issue_codes AS "issueCodes",
                  government_entities AS "governmentEntities",
                  lobbying_activities AS "lobbyingActivities",
                  filing_document_url AS "filingDocumentUrl"
             FROM lda_filing
            WHERE client_id = ANY($1::int[])
              AND (($2::timestamptz IS NULL)
                OR (COALESCE(dt_posted, make_date(filing_year, 1, 1)::timestamptz) > $2::timestamptz)
                OR (COALESCE(dt_posted, make_date(filing_year, 1, 1)::timestamptz) = $2::timestamptz
                    AND filing_uuid >= $3::text))
            ORDER BY COALESCE(dt_posted, make_date(filing_year, 1, 1)::timestamptz) ASC,
                     filing_uuid ASC
            LIMIT $4`,
            ldaIds,
            ldaCheckpointAt,
            ldaCheckpointKey,
            LDA_BACKFILL_BATCH_SIZE,
          )
        : [];
    } catch (error) {
      ldaError = this.safeError(error);
      this.logger.warn(`LDA historical backfill unavailable: ${ldaError}`);
    }
    let count = 0;
    let ldaExamined = 0;
    let ldaCheckpoint: Record<string, unknown> | null = Object.keys(priorLdaCheckpoint).length
      ? priorLdaCheckpoint
      : null;
    let ldaStoppedAtCap = false;
    for (const filing of filings) {
      const activities = recordsFromUnknown(filing.lobbyingActivities);
      const records = activities.length ? activities : [{}];
      const resumesSameFiling =
        ldaCheckpointAt === filing.scanAt.toISOString() && ldaCheckpointKey === filing.filingUuid;
      for (
        let index = resumesSameFiling ? ldaCheckpointActivity + 1 : 0;
        index < records.length;
        index += 1
      ) {
        if (count >= MAX_ADVOCACY_FINDINGS) {
          ldaStoppedAtCap = true;
          break;
        }
        const activity = records[index]!;
        const summary = summarizeLdaActivity(activity, filing.clientDescription);
        const issueCode =
          asString(activity.general_issue_code) ??
          asString(activity.issue_code) ??
          filing.issueCodes?.[0] ??
          null;
        const externalKey = `lda:${filing.filingUuid}:${index}`;
        const proposedValue = {
          externalKey,
          recordType: 'federal_lobbying',
          title: `${filing.filingYear}${filing.filingPeriod ? ` ${filing.filingPeriod}` : ''}${
            issueCode ? ` — ${issueCode}` : ''
          }`,
          summary,
          activityDate: filing.dtPosted?.toISOString() ?? null,
          status: filing.filingType,
          outcome: null,
          sourceType: 'lda',
          sourceId: filing.filingUuid,
          sourceUrl: filing.filingDocumentUrl,
          evidenceClass: 'PUBLIC_VERIFIED',
          confidence: 1,
          metadata: {
            ldaClientId: filing.clientId,
            ldaClientName: filing.clientName,
            registrantName: filing.registrantName,
            filingYear: filing.filingYear,
            filingPeriod: filing.filingPeriod,
            income: filing.income == null ? null : Number(filing.income),
            expenses: filing.expenses == null ? null : Number(filing.expenses),
            issueCodes: filing.issueCodes ?? [],
            governmentEntities: filing.governmentEntities,
            activity,
          },
        };
        const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
          kind: 'advocacy_record',
          targetKey: `advocacy:${externalKey}`,
          source: 'advocacy_history',
          factKind: 'fact',
          currentValue: null,
          proposedValue,
          confidence: 1,
          status: 'pending',
          evidence: [
            {
              label: proposedValue.title,
              url: filing.filingDocumentUrl,
              source: 'Senate Lobbying Disclosure Act filing',
              metadata: { filingUuid: filing.filingUuid, activityIndex: index },
            },
          ],
        });
        if (inserted) count += 1;
        ldaExamined += 1;
        ldaCheckpoint = {
          scanAt: filing.scanAt.toISOString(),
          key: filing.filingUuid,
          activityIndex: index,
        };
      }
      if (ldaStoppedAtCap) break;
    }

    const ldaComplete =
      ldaBackfillWasComplete ||
      (!ldaError && !ldaStoppedAtCap && filings.length < LDA_BACKFILL_BATCH_SIZE);
    const ldaStartedAt = asString(priorLda.startedAt) ?? invocationStartedAt;
    sourceStates.lda = {
      status: ldaError ? 'partial' : ldaComplete ? 'complete' : 'in_progress',
      startedAt: ldaStartedAt,
      completedAt: ldaComplete ? invocationStartedAt : undefined,
      checkpoint: ldaBackfillWasComplete ? priorLdaCheckpoint : ldaCheckpoint,
      historyStart: asString(priorLda.historyStart) ?? filings[0]?.scanAt.toISOString() ?? null,
      examined: Number(priorLda.examined ?? 0) + ldaExamined,
      candidates: Number(priorLda.candidates ?? 0) + count,
      lastError: ldaError,
    };

    const submissionResult = await this.gatherClientSubmissionAdvocacy(
      ctx,
      clientId,
      runId,
      count,
      asString(cursor.lastClientSubmissionAt),
      asRecord(priorSources.client_submission),
    );
    count += submissionResult.count;
    sourceStates.client_submission = submissionResult.backfill;
    const privateResult = await this.gatherPrivateAdvocacyCandidates(
      ctx,
      clientId,
      runId,
      count,
      asString(cursor.lastRelationshipLinkAppliedAt),
      asRecord(priorSources.private_evidence),
    );
    count += privateResult.count;
    sourceStates.private_evidence = privateResult.backfill;
    const faraResult = await this.gatherFaraAdvocacyCandidates(ctx, clientId, runId, count);
    count += faraResult.count;
    sourceStates.fara = faraResult.backfill;
    const testimonyResult = await this.gatherTestimonyAdvocacyCandidates(
      ctx,
      clientId,
      runId,
      count,
      asString(cursor.lastTestimonySyncedAt),
      asString(cursor.lastTestimonyKey),
      asRecord(priorSources.testimony),
    );
    count += testimonyResult.count;
    sourceStates.testimony = testimonyResult.backfill;
    const regulatoryCommentResult = await this.gatherRegulatoryCommentAdvocacyCandidates(
      ctx,
      clientId,
      runId,
      count,
      asRecord(priorSources.regulations_gov),
    );
    count += regulatoryCommentResult.count;
    sourceStates.regulations_gov = regulatoryCommentResult.backfill;
    sourceStates.federal_register = await this.gatherFederalRegisterBackfill(
      ctx,
      clientId,
      runId,
      asRecord(priorSources.federal_register),
    );
    const communityFundingResult = await this.gatherCommunityFundingAdvocacyCandidates(
      ctx,
      clientId,
      runId,
      count,
      asString(cursor.lastCommunityFundingCreatedAt),
      asString(cursor.lastCommunityFundingKey),
      asRecord(priorSources.community_funding),
    );
    count += communityFundingResult.count;
    sourceStates.community_funding = communityFundingResult.backfill;

    const refreshSchedule = await this.getSchedule(ctx, clientId);
    for (const source of ADVOCACY_SOURCE_NAMES) {
      sourceStates[source] = updateAdvocacySourceHealth(
        source,
        asRecord(priorSources[source]),
        sourceStates[source]!,
        invocationStartedAt,
        refreshSchedule.cadenceHours,
        refreshSchedule.nextRunAt,
      );
    }

    const overallStatus = deriveAdvocacyBackfillOverallStatus(sourceStates);
    await this.recordCursor(ctx.tenantId, clientId, 'advocacy_history', {
      lastLdaPostedAt:
        sourceStates.lda.status === 'complete'
          ? (asString(ldaCheckpoint?.scanAt) ?? lastDtPosted ?? null)
          : (lastDtPosted ?? null),
      lastLdaKey:
        sourceStates.lda.status === 'complete'
          ? (asString(ldaCheckpoint?.key) ?? cursor.lastLdaKey ?? null)
          : (cursor.lastLdaKey ?? null),
      lastLdaActivityIndex:
        sourceStates.lda.status === 'complete'
          ? Number(ldaCheckpoint?.activityIndex ?? cursor.lastLdaActivityIndex ?? -1)
          : (cursor.lastLdaActivityIndex ?? null),
      lastClientSubmissionAt:
        submissionResult.newestCreatedAt ?? cursor.lastClientSubmissionAt ?? null,
      lastRelationshipLinkAppliedAt:
        privateResult.newestAppliedAt ?? cursor.lastRelationshipLinkAppliedAt ?? null,
      lastTestimonySyncedAt: testimonyResult.newestSyncedAt ?? cursor.lastTestimonySyncedAt ?? null,
      lastTestimonyKey: testimonyResult.newestKey ?? cursor.lastTestimonyKey ?? null,
      lastCommunityFundingCreatedAt:
        communityFundingResult.newestCreatedAt ?? cursor.lastCommunityFundingCreatedAt ?? null,
      lastCommunityFundingKey:
        communityFundingResult.newestKey ?? cursor.lastCommunityFundingKey ?? null,
      backfill: {
        status: overallStatus,
        sources: sourceStates,
        updatedAt: invocationStartedAt,
      },
      refreshedAt: new Date().toISOString(),
    });
    return {
      count,
      overallStatus,
      overallHealth: deriveAdvocacyOverallHealth(sourceStates),
      sources: sourceStates,
    };
  }

  /**
   * Public-source auto-discovery, source 1 of N (FARA). Chosen first because
   * `fara_registration` is already synced (no new ingestion), global/no-RLS
   * (read directly via the Prisma delegate, never wrapped in withTenant —
   * see the capiro-advocacy-history skill's "these four source tables are
   * GLOBAL" note), and the client-match approach directly reuses the exact
   * pg_trgm similarity pattern `client-profile-fill-workflow.service.ts`
   * already proves out for LDA identity suggestion.
   *
   * Deterministic-match-or-manual-rationale gate, applied here the same way
   * `linkHearing` applies it for committee/bill matches: a CONFIRMED
   * `client_intel_mapping` (source='fara', confirmed=true) always searches
   * regardless of live similarity score (a human already decided this
   * registration belongs to the client). Absent a confirmed mapping, only
   * registrations at/above FARA_AUTO_MATCH_THRESHOLD are surfaced, and each
   * finding carries its own match confidence/method in metadata.clientMatch
   * for the reviewer — never silently promoted to a false "PUBLIC_VERIFIED"
   * certainty the match itself doesn't support.
   *
   * No new watermark column: FARA registrations mutate rarely and the table
   * is small enough that a full re-scan per Fill run is cheap; `addFinding`'s
   * own content-hash/accepted-or-rejected guard is what keeps re-runs
   * idempotent, exactly like every other rail in this method.
   */
  /**
   * Shared client-resolution step for every public-source auto-discovery
   * adapter (FARA, testimony, and future ones). Every adapter needs the
   * client's own name as the pg_trgm match anchor; this is the one piece
   * of genuinely duplicated glue between FARA and testimony worth
   * extracting — deliberately NOT extracting the per-source SQL, matching
   * threshold, confidence formula, or pagination shape, which differ
   * enough per source (see `references/public-source-discovery-adapter-plan.md`)
   * that a shared abstraction over them would hide real differences rather
   * than remove real duplication.
   */
  private async resolveClientNameForDiscovery(
    ctx: TenantContext,
    clientId: string,
  ): Promise<string | null> {
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true, name: true } }),
    );
    return client?.name ?? null;
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

  /**
   * Shared FillFinding assembly for a public-source auto-discovery
   * candidate. Every adapter converges on the exact same envelope shape
   * (`kind: 'advocacy_record'`, `source: 'advocacy_history'`,
   * `factKind` gated on confirmed-vs-similarity, `status: 'pending'`) —
   * this is the second piece of real, non-superficial duplication between
   * FARA and testimony (and every future adapter), so it's the one
   * extracted as a shared call. Per-source fields (title, summary,
   * metadata shape, evidence source label) stay adapter-owned, passed in
   * as `proposedValue`/`evidence` built by the caller — this function only
   * owns the envelope, never the source-specific content.
   */
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
    return this.addFinding(ctx.tenantId, clientId, runId, {
      kind: 'advocacy_record',
      targetKey: `advocacy:${input.externalKey}`,
      source: 'advocacy_history',
      factKind: input.isConfirmed ? 'fact' : 'recommendation',
      currentValue: null,
      proposedValue: input.proposedValue,
      confidence: input.confidence,
      status: 'pending',
      evidence: input.evidence,
    });
  }

  /**
   * Public-source auto-discovery, source 1 of N (FARA). Chosen first because
   * `fara_registration` is already synced (no new ingestion), global/no-RLS
   * (read directly via the Prisma delegate, never wrapped in withTenant —
   * see the capiro-advocacy-history skill's "these four source tables are
   * GLOBAL" note), and the client-match approach directly reuses the exact
   * pg_trgm similarity pattern `client-profile-fill-workflow.service.ts`
   * already proves out for LDA identity suggestion.
   *
   * Deterministic-match-or-manual-rationale gate, applied here the same way
   * `linkHearing` applies it for committee/bill matches: a CONFIRMED
   * `client_intel_mapping` (source='fara', confirmed=true) always searches
   * regardless of live similarity score (a human already decided this
   * registration belongs to the client). Absent a confirmed mapping, only
   * registrations at/above FARA_AUTO_MATCH_THRESHOLD are surfaced, and each
   * finding carries its own match confidence/method in metadata.clientMatch
   * for the reviewer — never silently promoted to a false "PUBLIC_VERIFIED"
   * certainty the match itself doesn't support.
   *
   * ROLE-AWARE RESOLUTION (extended after #1300's first pass). #1300 only
   * matched the client against `registrant_name` — the client could be
   * FOUND only if it was the lobbying/registering firm itself, never if it
   * was the entity being represented. That's a real product gap: a Capiro
   * client is far more likely to appear as a foreign principal (the entity
   * a registrant represents) than as a registrant (a law/lobbying firm)
   * itself. This now ALSO matches against `foreign_principal`, split on the
   * "; " delimiter `groupEnrichments` (fara-enrichment.ts) uses to join
   * multiple principals into that single flat column — matching the whole
   * joined blob would systematically under-score a client that's only one
   * of several principals a registrant lists. `matchedRole` on every
   * finding tells the reviewer which column matched — a match on the
   * registrant name and a match on a foreign principal name mean very
   * different things about the client's relationship to this filing, and
   * collapsing them into one undifferentiated "FARA match" would hide that.
   *
   * Honest schema-audited limitation: the roadmap's third role, "client as
   * represented entity," does NOT exist as a separate concept in this
   * schema. `fara_registration` has exactly two identity columns
   * (`registrant_name`, `foreign_principal`), and in FARA's own domain
   * model the foreign principal already IS the represented entity — a
   * registrant represents a foreign principal, full stop. There is no
   * third, distinct "represented entity" field to resolve against; this
   * adapter resolves exactly the two roles the schema actually has
   * (`registrant`, `foreign_principal`) and reports `foreign_principal` as
   * also covering "represented entity," rather than pretending a third
   * role was built against data that doesn't exist.
   *
   * No new watermark column: FARA registrations mutate rarely and the table
   * is small enough that a full re-scan per Fill run is cheap; `addFinding`'s
   * own content-hash/accepted-or-rejected guard is what keeps re-runs
   * idempotent, exactly like every other rail in this method.
   */
  private async gatherFaraAdvocacyCandidates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
  ): Promise<{ count: number; backfill: AdvocacySourceBackfillState }> {
    const startedAt = new Date().toISOString();
    const state = (
      status: AdvocacyBackfillStatus,
      examined = 0,
      candidates = 0,
      lastError: string | null = null,
    ) => ({
      status,
      startedAt,
      completedAt: status === 'complete' ? new Date().toISOString() : undefined,
      checkpoint: null,
      historyStart: null,
      examined,
      candidates,
      lastError,
    });
    if (currentCount >= MAX_ADVOCACY_FINDINGS) return { count: 0, backfill: state('in_progress') };

    const clientName = await this.resolveClientNameForDiscovery(ctx, clientId);
    if (!clientName) return { count: 0, backfill: state('complete') };

    const confirmedRegistrationNumbers = await this.getConfirmedIntelMappingKeys(
      ctx,
      clientId,
      FARA_INTEL_MAPPING_SOURCE,
    );

    let candidates: Array<{
      id: string;
      registrationNumber: string;
      registrantName: string;
      foreignPrincipal: string;
      country: string | null;
      status: string | null;
      registrationDate: Date | null;
      description: string | null;
      registrantSimilarity: number;
      principalSimilarity: number;
    }>;
    try {
      // ROLE-AWARE: registrantSimilarity matches the client as the REGISTRANT
      // (the lobbying/law firm doing the filing); principalSimilarity matches
      // the client as a FOREIGN_PRINCIPAL (the entity being represented —
      // this schema's only stand-in for "represented entity", see the class
      // doc above). foreign_principal is a single column that can hold
      // several principals joined with "; " (fara-enrichment.ts's
      // groupEnrichments), so it's split and scored PER SEGMENT via a
      // LATERAL join, taking the best-scoring segment — scoring the whole
      // joined blob would under-score a client that is only one of several
      // principals a registrant lists.
      candidates = await this.prisma.$queryRawUnsafe(
        `WITH scored AS (
           SELECT fr.id, fr.registration_number AS "registrationNumber",
                  fr.registrant_name AS "registrantName",
                  fr.foreign_principal AS "foreignPrincipal",
                  fr.country, fr.status, fr.registration_date AS "registrationDate",
                  fr.description,
                  GREATEST(similarity(fr.registrant_name, $1), word_similarity($1, fr.registrant_name))::float
                    AS "registrantSimilarity",
                  COALESCE(fp.principal_similarity, 0)::float AS "principalSimilarity"
             FROM fara_registration fr
             LEFT JOIN LATERAL (
               SELECT MAX(GREATEST(similarity(p.principal, $1), word_similarity($1, p.principal)))
                        AS principal_similarity
                 FROM unnest(string_to_array(fr.foreign_principal, '; ')) AS p(principal)
             ) fp ON true
         )
         SELECT * FROM scored
          WHERE "registrationNumber" = ANY($2::text[])
             OR "registrantSimilarity" >= $3::float
             OR "principalSimilarity" >= $3::float
          ORDER BY GREATEST("registrantSimilarity", "principalSimilarity") DESC
          LIMIT 50`,
        clientName,
        [...confirmedRegistrationNumbers],
        FARA_AUTO_MATCH_THRESHOLD,
      );
    } catch (error) {
      const lastError = this.safeError(error);
      this.logger.warn(`FARA discovery rail unavailable: ${lastError}`);
      return { count: 0, backfill: state('partial', 0, 0, lastError) };
    }

    let count = 0;
    for (const row of candidates) {
      if (currentCount + count >= MAX_ADVOCACY_FINDINGS) break;
      const isConfirmed = confirmedRegistrationNumbers.has(row.registrationNumber);
      const registrantMatches = matchesAdvocacyOrganization(clientName, row.registrantName);
      const principalMatches = row.foreignPrincipal
        .split(';')
        .some((name) => matchesAdvocacyOrganization(clientName, name));
      if (!isConfirmed && !registrantMatches && !principalMatches) continue;
      const roleMatch = isConfirmed
        ? resolveFaraMatchedRole(row.registrantSimilarity, row.principalSimilarity)
        : {
            role: principalMatches ? ('foreign_principal' as const) : ('registrant' as const),
            similarity: 1,
          };
      const confidence = faraMatchConfidence(isConfirmed, roleMatch.similarity);
      const externalKey = `fara:${row.registrationNumber}`;
      const proposedValue = {
        externalKey,
        recordType: 'fara_registration',
        title: `FARA registration — ${row.registrantName} for ${row.foreignPrincipal}`,
        summary: row.description,
        activityDate: row.registrationDate?.toISOString() ?? null,
        status: row.status,
        outcome: null,
        sourceType: 'fara',
        sourceId: row.registrationNumber,
        sourceUrl: null,
        evidenceClass: isConfirmed ? 'PUBLIC_VERIFIED' : 'INFERRED',
        confidence,
        metadata: {
          registrationNumber: row.registrationNumber,
          registrantName: row.registrantName,
          foreignPrincipal: row.foreignPrincipal,
          country: row.country,
          clientMatch: {
            method: isConfirmed ? 'confirmed_client_intel_mapping' : 'organization_name',
            confidence,
            similarity: isConfirmed ? null : roleMatch.similarity,
            // Which FARA identity field matched the client. 'foreign_principal'
            // also covers the roadmap's "represented entity" role — this
            // schema has no separate column for that concept (see class doc).
            // Absent for a confirmed mapping with no live similarity signal
            // on either side (score 0/0) — a human already decided the
            // match; there is nothing informative to report about role.
            matchedRole: isConfirmed && roleMatch.similarity === 0 ? null : roleMatch.role,
          },
        },
      };
      const inserted = await this.emitDiscoveryFinding(ctx, clientId, runId, {
        externalKey,
        isConfirmed,
        confidence,
        proposedValue,
        evidence: [
          {
            label: proposedValue.title,
            source: 'FARA (Foreign Agents Registration Act) registration',
            metadata: { registrationNumber: row.registrationNumber, matchedRole: roleMatch.role },
          },
        ],
      });
      if (inserted) count += 1;
    }
    return { count, backfill: state('complete', candidates.length, count) };
  }

  /**
   * Public-source auto-discovery, source 2 of N (congressional testimony).
   * `committee_hearing.witnesses` is a bare `text[]` of "name, position,
   * organization" strings (see `formatWitnesses` in
   * hearing-discovery/adapters/congress-gov-parse.ts) — there is no separate
   * witness-identity table, so matching happens directly against that
   * free-text blob via `unnest`. `word_similarity` matters more here than it
   * did for FARA: a client's organization name is one fragment INSIDE a
   * longer "name, title, organization" string, not the whole field, so a
   * plain `similarity()` against the full string would systematically
   * under-score even an exact organization match.
   *
   * TWO INDEPENDENT queries, deliberately not one:
   *
   * 1. Confirmed-mapping bypass — a direct lookup of every CONFIRMED
   *    `client_intel_mapping` (source='testimony') compound key, with NO
   *    cursor/timestamp filter at all. This is what actually satisfies "a
   *    confirmed mapping always surfaces regardless of similarity" — an
   *    incremental scan filter applied ahead of the confirmed-mapping check
   *    would let a user confirm an OLD hearing's mapping after the scan
   *    cursor has already passed it, and that mapping would then never
   *    surface again. Confirmed mappings are naturally bounded (per-client,
   *    human-curated, small), so no pagination is needed here.
   *
   * 2. A bounded, resumable KEYSET-PAGINATED scan over
   *    (committee_hearing.synced_at ASC, compound key ASC) — NOT an
   *    `ORDER BY date DESC LIMIT 50` similarity filter. `committee_hearing`
   *    is continuously synced (including witness-list backfills onto
   *    existing rows), so:
   *      - Ordering by a value the filter itself doesn't bound (hearing
   *        date, or "which 50 rows happened to score highest") and then
   *        advancing the cursor to the max syncedAt among matches SEEN can
   *        permanently skip an eligible row outside that top-50 slice.
   *      - A batch with zero similarity matches must still move the cursor
   *        forward, or every future run rescans the exact same source rows
   *        forever. The cursor represents "how far the SOURCE has been
   *        scanned," not "the timestamp of the newest successful match."
   *    See `planTestimonyScanBatch` for the pure cursor-advancement
   *    contract this query's results are run through, including the rule
   *    that hitting MAX_ADVOCACY_FINDINGS mid-batch must stop the cursor at
   *    the last row actually examined, never past an unexamined one.
   */
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
    const startedAt = asString(priorState.startedAt) ?? new Date().toISOString();
    const noAdvance = {
      count: 0,
      newestSyncedAt: lastTestimonySyncedAt,
      newestKey: lastTestimonyKey,
      backfill: {
        status: 'in_progress' as const,
        startedAt,
        checkpoint: lastTestimonySyncedAt
          ? { syncedAt: lastTestimonySyncedAt, key: lastTestimonyKey }
          : null,
        historyStart: asString(priorState.historyStart) ?? null,
        examined: Number(priorState.examined ?? 0),
        candidates: Number(priorState.candidates ?? 0),
        lastError: null,
      },
    };
    if (currentCount >= MAX_ADVOCACY_FINDINGS) return noAdvance;

    const clientName = await this.resolveClientNameForDiscovery(ctx, clientId);
    if (!clientName) return noAdvance;

    const confirmedKeys = await this.getConfirmedIntelMappingKeys(
      ctx,
      clientId,
      TESTIMONY_INTEL_MAPPING_SOURCE,
    );

    let count = 0;

    // ── Query 1: confirmed-mapping bypass, NO cursor filter ──────────────
    if (confirmedKeys.size && currentCount + count < MAX_ADVOCACY_FINDINGS) {
      let confirmedRows: Array<{
        hearingId: string;
        title: string;
        committeeName: string;
        chamber: string;
        date: Date;
        url: string | null;
        witnessText: string;
      }>;
      try {
        confirmedRows = await this.prisma.$queryRawUnsafe(
          `SELECT ch.id AS "hearingId", ch.title, ch.committee_name AS "committeeName",
                  ch.chamber, ch.date, ch.url, w AS "witnessText"
             FROM federal_committee_hearing ch, unnest(ch.witnesses) AS w
            WHERE (ch.id || '::' || w) = ANY($1::text[])`,
          [...confirmedKeys],
        );
      } catch (error) {
        this.logger.warn(
          `Testimony discovery confirmed-mapping lookup unavailable: ${this.safeError(error)}`,
        );
        confirmedRows = [];
      }
      for (const row of confirmedRows) {
        if (currentCount + count >= MAX_ADVOCACY_FINDINGS) break;
        const inserted = await this.addTestimonyFinding(ctx, clientId, runId, row, true, 1);
        if (inserted) count += 1;
      }
    }

    // ── Query 2: bounded keyset-paginated source scan ────────────────────
    let scanRows: Array<{
      hearingId: string;
      title: string;
      committeeName: string;
      chamber: string;
      date: Date;
      url: string | null;
      syncedAt: Date;
      witnessText: string;
      similarity: number;
    }> = [];
    if (currentCount + count < MAX_ADVOCACY_FINDINGS) {
      try {
        scanRows = await this.prisma.$queryRawUnsafe(
          `SELECT ch.id AS "hearingId", ch.title, ch.committee_name AS "committeeName",
                  ch.chamber, ch.date, ch.url, ch.synced_at AS "syncedAt", w AS "witnessText",
                  GREATEST(similarity(w, $3), word_similarity($3, w))::float AS similarity
             FROM federal_committee_hearing ch, unnest(ch.witnesses) AS w
            WHERE ($1::timestamptz IS NULL)
               OR (ch.synced_at > $1::timestamptz)
               OR (ch.synced_at = $1::timestamptz AND (ch.id || '::' || w) > $2::text)
            ORDER BY ch.synced_at ASC, (ch.id || '::' || w) ASC
            LIMIT $4`,
          lastTestimonySyncedAt,
          lastTestimonyKey ?? '',
          clientName,
          TESTIMONY_SCAN_BATCH_SIZE,
        );
      } catch (error) {
        this.logger.warn(`Testimony discovery scan rail unavailable: ${this.safeError(error)}`);
        const lastError = this.safeError(error);
        return {
          count,
          newestSyncedAt: lastTestimonySyncedAt,
          newestKey: lastTestimonyKey,
          backfill: { ...noAdvance.backfill, status: 'partial', candidates: count, lastError },
        };
      }
    }
    // Rows already covered by the confirmed-mapping bypass are excluded from
    // EMISSION here (Query 1 already handled them, or a future run's bypass
    // query will) — but they still count as SCANNED for cursor purposes.
    // The plan function receives the FULL batch, not a pre-filtered one, so
    // a batch consisting entirely of already-confirmed rows still advances
    // the cursor past them instead of stalling forever on a spurious
    // "zero rows to examine" edge case.
    const remainingBudget = MAX_ADVOCACY_FINDINGS - (currentCount + count);
    const plan = planTestimonyScanBatch(
      scanRows,
      confirmedKeys,
      TESTIMONY_AUTO_MATCH_THRESHOLD,
      remainingBudget,
    );
    for (const row of plan.toEmit) {
      if (!matchesTestimonyOrganization(clientName, row.witnessText)) continue;
      const inserted = await this.addTestimonyFinding(
        ctx,
        clientId,
        runId,
        row,
        false,
        row.similarity,
      );
      if (inserted) count += 1;
    }
    // The scan cursor only ever advances through rows the SCAN itself
    // examined (plan.cursor, derived from unconfirmedScanRows) — confirmed
    // rows never move it, by construction, since they're looked up by a
    // completely separate, cursor-independent query.
    const scanComplete =
      scanRows.length < TESTIMONY_SCAN_BATCH_SIZE &&
      (scanRows.length === 0 ||
        plan.cursor?.key === `${scanRows.at(-1)!.hearingId}::${scanRows.at(-1)!.witnessText}`);
    return {
      count,
      newestSyncedAt: plan.cursor?.syncedAt ?? lastTestimonySyncedAt,
      newestKey: plan.cursor?.key ?? lastTestimonyKey,
      backfill: {
        status: scanComplete ? 'complete' : 'in_progress',
        startedAt,
        completedAt: scanComplete ? new Date().toISOString() : undefined,
        checkpoint:
          plan.cursor ??
          (lastTestimonySyncedAt
            ? { syncedAt: lastTestimonySyncedAt, key: lastTestimonyKey }
            : null),
        historyStart: null,
        examined:
          Number(priorState.examined ?? 0) +
          (plan.cursor
            ? scanRows.findIndex(
                (row) => `${row.hearingId}::${row.witnessText}` === plan.cursor!.key,
              ) + 1
            : 0),
        candidates: Number(priorState.candidates ?? 0) + count,
        lastError: null,
      },
    };
  }

  private async addTestimonyFinding(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    row: {
      hearingId: string;
      title: string;
      committeeName: string;
      chamber: string;
      date: Date;
      url: string | null;
      witnessText: string;
    },
    isConfirmed: boolean,
    similarity: number,
  ): Promise<boolean> {
    const confidence = testimonyMatchConfidence(isConfirmed, similarity);
    const compoundKey = `${row.hearingId}::${row.witnessText}`;
    const externalKey = `testimony:${compoundKey}`;
    const proposedValue = {
      externalKey,
      recordType: 'congressional_testimony',
      title: `Congressional testimony — ${row.witnessText} at ${row.title}`,
      summary: `${row.chamber} ${row.committeeName}`,
      activityDate: row.date.toISOString(),
      status: null,
      outcome: null,
      sourceType: 'testimony',
      sourceId: row.hearingId,
      sourceUrl: row.url,
      // HONEST COVERAGE GAP (matches linkTestimony's own comment): no
      // canonical testimony document/organization row exists in this
      // repo. This finding's evidence is the witness string as recorded
      // on the hearing itself — never fabricated beyond that.
      evidenceClass: isConfirmed ? 'PUBLIC_VERIFIED' : 'INFERRED',
      confidence,
      metadata: {
        hearingId: row.hearingId,
        witness: row.witnessText,
        committeeName: row.committeeName,
        chamber: row.chamber,
        clientMatch: {
          method: isConfirmed ? 'confirmed_client_intel_mapping' : 'organization_name',
          confidence,
          similarity: isConfirmed ? null : similarity,
        },
      },
    };
    return this.emitDiscoveryFinding(ctx, clientId, runId, {
      externalKey,
      isConfirmed,
      confidence,
      proposedValue,
      evidence: [
        {
          label: proposedValue.title,
          source: 'Congressional committee hearing witness list',
          metadata: { hearingId: row.hearingId, witness: row.witnessText },
        },
      ],
    });
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

  /**
   * Public-source auto-discovery: House CPF / Senate CDS via canonical
   * `community_funding_request` rows (PR #1328). Primary identity is the
   * funding RECIPIENT, never the Member/Senator requester (brief §16).
   *
   * Flow is review-gated only — this rail emits pending Fill findings; it
   * never writes client_advocacy_record rows directly. One logical request
   * → one finding, even when multiple provenance source documents exist
   * (brief §19); provenance is attached as evidence metadata.
   *
   * TWO independent queries (same shape as testimony):
   *  1. Confirmed-mapping bypass — every confirmed client_intel_mapping
   *     (source=community_funding) externalId = request UUID, no cursor.
   *  2. Bounded keyset scan over (created_at ASC, id ASC) joining recipient
   *     similarity + client facility geography for fuzzy corroboration.
   *
   * Matching hierarchy is pure (community-funding-advocacy-match.ts):
   * confirmed → exact recipient → exact alias → fuzzy+geography → skip.
   */
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
    const startedAt = asString(priorState.startedAt) ?? new Date().toISOString();
    const priorCheckpoint = asRecord(priorState.checkpoint);
    const priorWasComplete = asString(priorState.status) === 'complete';
    const state = (
      status: AdvocacyBackfillStatus,
      examined = 0,
      candidates = 0,
      lastError: string | null = null,
      checkpoint: Record<string, unknown> | null = null,
      limitation: string | null = null,
    ): AdvocacySourceBackfillState => ({
      status,
      startedAt,
      completedAt: status === 'complete' ? new Date().toISOString() : undefined,
      checkpoint,
      historyStart: asString(priorState.historyStart) ?? null,
      examined: Number(priorState.examined ?? 0) + examined,
      candidates: Number(priorState.candidates ?? 0) + candidates,
      lastError,
      limitation: limitation ?? asString(priorState.limitation) ?? null,
    });

    if (currentCount >= MAX_ADVOCACY_FINDINGS) {
      return {
        count: 0,
        newestCreatedAt: lastCreatedAt,
        newestKey: lastKey,
        backfill: state('in_progress', 0, 0, null, priorCheckpoint),
      };
    }

    const clientName = await this.resolveClientNameForDiscovery(ctx, clientId);
    if (!clientName) {
      return {
        count: 0,
        newestCreatedAt: lastCreatedAt,
        newestKey: lastKey,
        backfill: state('complete', 0, 0, null, priorCheckpoint),
      };
    }

    const confirmedRequestIds = await this.getConfirmedIntelMappingKeys(
      ctx,
      clientId,
      COMMUNITY_FUNDING_INTEL_MAPPING_SOURCE,
    );

    // Facility states for geography corroboration of fuzzy matches.
    let clientStates = new Set<string>();
    try {
      const facilities = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clientFacility.findMany({
          where: { clientId },
          select: { state: true },
        }),
      );
      clientStates = new Set(
        facilities.map((f) => (f.state ?? '').trim().toUpperCase()).filter((s) => s.length === 2),
      );
    } catch (error) {
      this.logger.warn(
        `Community funding facility geography unavailable: ${this.safeError(error)}`,
      );
    }

    type FundingRow = {
      id: string;
      chamber: string;
      requestType: string;
      fiscalYear: number;
      requesterName: string;
      recipientName: string;
      recipientNormalized: string;
      state: string | null;
      city: string | null;
      projectTitle: string;
      projectDescription: string | null;
      requestedAmountUsd: string;
      finalAmountUsd: string | null;
      amountStageRaw: string;
      appropriationsAccountRaw: string | null;
      subcommittee: string | null;
      createdAt: Date;
      recipientSimilarity: number;
      provenanceCount: number;
      provenanceDocs: Array<{
        sourceDocumentId: string;
        sourcePage: number | null;
        sourceRow: number;
        sourceUrl: string | null;
        title: string | null;
      }> | null;
    };

    const loadProvenance = async (requestIds: string[]) => {
      if (!requestIds.length) return new Map<string, FundingRow['provenanceDocs']>();
      try {
        const rows = await this.prisma.$queryRawUnsafe<
          Array<{
            requestId: string;
            sourceDocumentId: string;
            sourcePage: number | null;
            sourceRow: number;
            sourceUrl: string | null;
            title: string | null;
          }>
        >(
          `SELECT s.request_id AS "requestId",
                  s.source_document_id AS "sourceDocumentId",
                  s.source_page AS "sourcePage",
                  s.source_row AS "sourceRow",
                  sd.source_url AS "sourceUrl",
                  sd.title AS title
             FROM community_funding_request_source s
             LEFT JOIN source_document sd ON sd.id = s.source_document_id
            WHERE s.request_id = ANY($1::uuid[])
            ORDER BY s.request_id, s.source_page NULLS FIRST, s.source_row`,
          requestIds,
        );
        const map = new Map<string, NonNullable<FundingRow['provenanceDocs']>>();
        for (const r of rows) {
          const list = map.get(r.requestId) ?? [];
          list.push({
            sourceDocumentId: r.sourceDocumentId,
            sourcePage: r.sourcePage,
            sourceRow: r.sourceRow,
            sourceUrl: r.sourceUrl,
            title: r.title,
          });
          map.set(r.requestId, list);
        }
        return map;
      } catch {
        return new Map();
      }
    };

    const emitForRow = async (
      row: FundingRow,
      decision: Extract<CommunityFundingMatchDecision, { matched: true }>,
    ): Promise<boolean> => {
      const isConfirmed = decision.method === 'confirmed_client_intel_mapping';
      const externalKey = `community_funding:${row.id}`;
      const title = communityFundingFindingTitle({
        chamber: row.chamber,
        requestType: row.requestType,
        fiscalYear: row.fiscalYear,
        recipientName: row.recipientName,
      });
      const summary = communityFundingFindingSummary({
        chamber: row.chamber,
        requestType: row.requestType,
        fiscalYear: row.fiscalYear,
        requesterName: row.requesterName,
        recipientName: row.recipientName,
        projectTitle: row.projectTitle,
        requestedAmountUsd: row.requestedAmountUsd,
        finalAmountUsd: row.finalAmountUsd,
        amountStageRaw: row.amountStageRaw,
        appropriationsAccountRaw: row.appropriationsAccountRaw,
        subcommittee: row.subcommittee,
      });
      const provenance = row.provenanceDocs ?? [];
      const primaryUrl = provenance.find((p) => p.sourceUrl)?.sourceUrl ?? null;
      const proposedValue = {
        externalKey,
        recordType: row.requestType === 'cds' ? 'cds_request' : 'cpf_request',
        title,
        summary,
        activityDate: null,
        status: row.amountStageRaw,
        outcome: null,
        sourceType: 'community_funding',
        sourceId: row.id,
        sourceUrl: primaryUrl,
        evidenceClass: 'PUBLIC_VERIFIED',
        confidence: decision.confidence,
        metadata: {
          communityFundingRequestId: row.id,
          chamber: row.chamber,
          requestType: row.requestType,
          fiscalYear: row.fiscalYear,
          requesterName: row.requesterName,
          recipientName: row.recipientName,
          recipientNormalized: row.recipientNormalized,
          projectTitle: row.projectTitle,
          projectDescription: row.projectDescription,
          requestedAmountUsd: row.requestedAmountUsd,
          finalAmountUsd: row.finalAmountUsd,
          amountStageRaw: row.amountStageRaw,
          appropriationsAccountRaw: row.appropriationsAccountRaw,
          subcommittee: row.subcommittee,
          state: row.state,
          city: row.city,
          // One finding per canonical request — provenance is attached, never multiplied.
          provenanceCount: provenance.length || row.provenanceCount || 0,
          provenance: provenance.map((p) => ({
            sourceDocumentId: p.sourceDocumentId,
            sourcePage: p.sourcePage,
            sourceRow: p.sourceRow,
            sourceUrl: p.sourceUrl,
            title: p.title,
          })),
          clientMatch: {
            method: decision.method,
            confidence: decision.confidence,
            similarity: decision.similarity,
            geographyCorroborated: decision.geographyCorroborated,
            matchedRole: 'recipient',
          },
        },
      };
      return this.emitDiscoveryFinding(ctx, clientId, runId, {
        externalKey,
        isConfirmed,
        confidence: decision.confidence,
        proposedValue,
        evidence: [
          {
            label: title,
            url: primaryUrl,
            source:
              row.requestType === 'cds'
                ? 'Senate Congressionally Directed Spending (canonical)'
                : 'House Community Project Funding (canonical)',
            metadata: {
              communityFundingRequestId: row.id,
              provenanceCount: provenance.length || row.provenanceCount || 0,
              matchMethod: decision.method,
            },
          },
          ...provenance
            .filter((p) => p.sourceUrl)
            .slice(0, 5)
            .map((p) => ({
              label: p.title ?? `Source row ${p.sourceRow}`,
              url: p.sourceUrl,
              // Evidence-item prose label — must NOT be a snake_case `source: '...'`
              // literal that the finding-source-check contract regex would treat as
              // an addFinding() source value (see FARA_INTEL_MAPPING_SOURCE note).
              source: 'CPF/CDS canonical provenance row',
              metadata: {
                sourceDocumentId: p.sourceDocumentId,
                sourcePage: p.sourcePage,
                sourceRow: p.sourceRow,
              },
            })),
        ],
      });
    };

    let count = 0;
    let examined = 0;
    let scanError: string | null = null;

    // 1) Confirmed-mapping bypass — no cursor filter.
    if (confirmedRequestIds.size && currentCount + count < MAX_ADVOCACY_FINDINGS) {
      try {
        const confirmedRows = await this.prisma.$queryRawUnsafe<FundingRow[]>(
          `SELECT r.id, r.chamber, r.request_type AS "requestType", r.fiscal_year AS "fiscalYear",
                  r.requester_name AS "requesterName", r.recipient_name AS "recipientName",
                  r.recipient_normalized AS "recipientNormalized", r.state, r.city,
                  r.project_title AS "projectTitle", r.project_description AS "projectDescription",
                  r.requested_amount_usd::text AS "requestedAmountUsd",
                  r.final_amount_usd::text AS "finalAmountUsd",
                  r.amount_stage_raw AS "amountStageRaw",
                  r.appropriations_account_raw AS "appropriationsAccountRaw",
                  r.subcommittee, r.created_at AS "createdAt",
                  1::float AS "recipientSimilarity",
                  (SELECT COUNT(*)::int FROM community_funding_request_source s WHERE s.request_id = r.id) AS "provenanceCount"
             FROM community_funding_request r
            WHERE r.id = ANY($1::uuid[])
            ORDER BY r.created_at ASC, r.id ASC
            LIMIT 200`,
          [...confirmedRequestIds],
        );
        const prov = await loadProvenance(confirmedRows.map((r) => r.id));
        for (const row of confirmedRows) {
          if (currentCount + count >= MAX_ADVOCACY_FINDINGS) break;
          row.provenanceDocs = prov.get(row.id) ?? null;
          const decision = resolveCommunityFundingRecipientMatch({
            requestId: row.id,
            recipientName: row.recipientName,
            recipientNormalized: row.recipientNormalized,
            state: row.state,
            confirmedRequestIds,
            clientName,
            clientStates,
            recipientSimilarity: 1,
          });
          if (!decision.matched) continue;
          examined += 1;
          if (await emitForRow(row, decision)) count += 1;
        }
      } catch (error) {
        scanError = this.safeError(error);
        this.logger.warn(`Community funding confirmed-mapping rail unavailable: ${scanError}`);
      }
    }

    // 2) Keyset scan for exact/fuzzy matches.
    const checkpointAt = priorWasComplete
      ? lastCreatedAt
      : (asString(priorCheckpoint.createdAt) ?? lastCreatedAt);
    const checkpointKey = priorWasComplete ? lastKey : (asString(priorCheckpoint.key) ?? lastKey);

    let scanRows: FundingRow[] = [];
    try {
      scanRows = await this.prisma.$queryRawUnsafe<FundingRow[]>(
        `SELECT r.id, r.chamber, r.request_type AS "requestType", r.fiscal_year AS "fiscalYear",
                r.requester_name AS "requesterName", r.recipient_name AS "recipientName",
                r.recipient_normalized AS "recipientNormalized", r.state, r.city,
                r.project_title AS "projectTitle", r.project_description AS "projectDescription",
                r.requested_amount_usd::text AS "requestedAmountUsd",
                r.final_amount_usd::text AS "finalAmountUsd",
                r.amount_stage_raw AS "amountStageRaw",
                r.appropriations_account_raw AS "appropriationsAccountRaw",
                r.subcommittee, r.created_at AS "createdAt",
                GREATEST(
                  similarity(r.recipient_normalized, $1),
                  word_similarity($1, r.recipient_normalized),
                  similarity(r.recipient_name, $1),
                  word_similarity($1, r.recipient_name)
                )::float AS "recipientSimilarity",
                (SELECT COUNT(*)::int FROM community_funding_request_source s WHERE s.request_id = r.id) AS "provenanceCount"
           FROM community_funding_request r
          WHERE (($2::timestamptz IS NULL)
             OR (r.created_at > $2::timestamptz)
             OR (r.created_at = $2::timestamptz AND r.id > $3::uuid))
          ORDER BY r.created_at ASC, r.id ASC
          LIMIT $4`,
        clientName,
        checkpointAt,
        checkpointKey || '00000000-0000-0000-0000-000000000000',
        COMMUNITY_FUNDING_SCAN_BATCH_SIZE,
      );
    } catch (error) {
      const err = this.safeError(error);
      this.logger.warn(`Community funding scan rail unavailable: ${err}`);
      scanError = scanError ?? err;
      return {
        count,
        newestCreatedAt: lastCreatedAt,
        newestKey: lastKey,
        backfill: state(
          'partial',
          examined,
          count,
          scanError,
          priorCheckpoint,
          'Canonical CPF/CDS table unavailable or not yet migrated',
        ),
      };
    }

    // Cursor advances across the full batch even when zero matches — same
    // contract as testimony (scan frontier, not match frontier).
    let newestCreatedAt: string | null = lastCreatedAt;
    let newestKey: string | null = lastKey;
    if (scanRows.length) {
      const last = scanRows[scanRows.length - 1]!;
      newestCreatedAt = last.createdAt.toISOString();
      newestKey = last.id;
    }

    const resolved: Array<{
      row: FundingRow;
      decision: CommunityFundingMatchDecision;
      requestId: string;
    }> = [];
    for (const row of scanRows) {
      // Confirmed rows already handled above; still "examined" for cursor.
      if (confirmedRequestIds.has(row.id)) {
        examined += 1;
        continue;
      }
      const decision = resolveCommunityFundingRecipientMatch({
        requestId: row.id,
        recipientName: row.recipientName,
        recipientNormalized: row.recipientNormalized,
        state: row.state,
        confirmedRequestIds,
        clientName,
        clientStates,
        recipientSimilarity: row.recipientSimilarity,
      });
      examined += 1;
      if (decision.matched) {
        resolved.push({ row, decision, requestId: row.id });
      }
    }

    const accepted = filterAmbiguousCommunityFundingMatches(resolved);
    const prov = await loadProvenance(accepted.map((a) => a.row.id));
    for (const item of accepted) {
      if (currentCount + count >= MAX_ADVOCACY_FINDINGS) break;
      if (!item.decision.matched) continue;
      item.row.provenanceDocs = prov.get(item.row.id) ?? null;
      if (await emitForRow(item.row, item.decision)) count += 1;
    }

    // Coverage honesty: surface FY/chamber counts when available.
    let limitation: string | null = asString(priorState.limitation);
    try {
      const coverage = await this.prisma.$queryRawUnsafe<
        Array<{ chamber: string; fiscalYear: number; n: number }>
      >(
        `SELECT chamber, fiscal_year AS "fiscalYear", COUNT(*)::int AS n
           FROM community_funding_request
          GROUP BY chamber, fiscal_year
          ORDER BY fiscal_year DESC, chamber
          LIMIT 20`,
      );
      if (coverage.length) {
        const bits = coverage.map((c) => `${c.chamber} FY${c.fiscalYear}:${c.n}`);
        limitation = `Canonical coverage present for ${bits.join(', ')}. Match is recipient-primary; requester is never treated as the client.`;
      } else {
        limitation =
          'Canonical community_funding_request table is empty — run CPF/CDS ingestion before expecting matches.';
      }
    } catch {
      // leave prior limitation
    }

    const batchExhausted = scanRows.length < COMMUNITY_FUNDING_SCAN_BATCH_SIZE;
    const complete = priorWasComplete || (!scanError && batchExhausted);
    const checkpoint = {
      createdAt: newestCreatedAt,
      key: newestKey,
    };

    return {
      count,
      newestCreatedAt: complete ? newestCreatedAt : lastCreatedAt,
      newestKey: complete ? newestKey : lastKey,
      backfill: state(
        scanError ? 'partial' : complete ? 'complete' : 'in_progress',
        examined,
        count,
        scanError,
        complete || scanRows.length ? checkpoint : priorCheckpoint,
        limitation,
      ),
    };
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
    const startedAt = asString(priorState.startedAt) ?? new Date().toISOString();
    const priorCheckpoint = asRecord(priorState.checkpoint);
    const checkpointAt = asString(priorCheckpoint.createdAt);
    const checkpointKey = asString(priorCheckpoint.key) ?? '';
    const state = (
      status: AdvocacyBackfillStatus,
      examined: number,
      candidates: number,
      checkpoint: Record<string, unknown> | null,
      lastError: string | null = null,
    ): AdvocacySourceBackfillState => ({
      status,
      startedAt,
      completedAt: status === 'complete' ? new Date().toISOString() : undefined,
      checkpoint,
      historyStart: asString(priorState.historyStart) ?? null,
      examined: Number(priorState.examined ?? 0) + examined,
      candidates: Number(priorState.candidates ?? 0) + candidates,
      lastError,
    });
    if (currentCount >= MAX_ADVOCACY_FINDINGS)
      return {
        count: 0,
        newestCreatedAt: lastClientSubmissionAt,
        backfill: state('in_progress', 0, 0, priorCheckpoint),
      };
    let rows: Array<{ id: string; data: unknown; capabilityName: string | null; createdAt: Date }> =
      [];
    try {
      rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$queryRawUnsafe<
          Array<{ id: string; data: unknown; capabilityName: string | null; createdAt: Date }>
        >(
          `SELECT s.id::text AS id, to_jsonb(s) AS data, c.name AS "capabilityName", s.created_at AS "createdAt"
             FROM client_submission_history s
             JOIN client_capabilities c ON c.id = s.capability_id
            WHERE c.tenant_id = $1::uuid AND c.client_id = $2::uuid
              AND (($3::timestamptz IS NULL) OR s.created_at > $3::timestamptz
                OR (s.created_at = $3::timestamptz AND s.id::text > $4::text))
            ORDER BY s.created_at ASC, s.id::text ASC
            LIMIT 100`,
          ctx.tenantId,
          clientId,
          checkpointAt,
          checkpointKey,
        ),
      );
    } catch (error) {
      this.logger.warn(`Client submission advocacy rail unavailable: ${this.safeError(error)}`);
      return {
        count: 0,
        newestCreatedAt: lastClientSubmissionAt,
        backfill: state('partial', 0, 0, priorCheckpoint, this.safeError(error)),
      };
    }
    let count = 0;
    let lastSubmissionExamined: (typeof rows)[number] | undefined;
    let submissionsExamined = 0;
    for (const row of rows) {
      if (currentCount + count >= MAX_ADVOCACY_FINDINGS) break;
      lastSubmissionExamined = row;
      submissionsExamined += 1;
      const data = asRecord(row.data);
      const id = asString(data.id);
      if (!id) continue;
      const title = asString(data.title) ?? `${row.capabilityName ?? 'Client'} submission`;
      const proposedValue = {
        externalKey: `client-submission:${id}`,
        recordType: 'client_submission',
        title,
        summary: asString(data.detail) ?? asString(data.description) ?? null,
        activityDate:
          asString(data.submitted_at) ??
          asString(data.created_at) ??
          asString(data.updated_at) ??
          null,
        status: asString(data.status),
        outcome: asString(data.outcome),
        sourceType: 'client_submission',
        sourceId: id,
        sourceUrl: null,
        evidenceClass: 'CLIENT_VERIFIED',
        confidence: 1,
        metadata: { ...data, capabilityName: row.capabilityName },
      };
      const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
        kind: 'advocacy_record',
        targetKey: `advocacy:client-submission:${id}`,
        source: 'advocacy_history',
        factKind: 'fact',
        currentValue: null,
        proposedValue,
        confidence: 1,
        status: 'pending',
        evidence: [
          {
            label: 'Existing client submission history',
            source: 'Capiro client record',
            metadata: { submissionId: id, capabilityName: row.capabilityName },
          },
        ],
      });
      if (inserted) count += 1;
    }
    // rows are ORDER BY created_at DESC — the first row (if any) is always
    // the newest regardless of how many were skipped by the MAX_ADVOCACY_
    // FINDINGS cap, so the watermark still advances correctly even on a
    // capped run.
    const lastExamined = lastSubmissionExamined;
    const complete = rows.length < 100 && submissionsExamined === rows.length;
    const nextCheckpoint = lastExamined
      ? { createdAt: lastExamined.createdAt.toISOString(), key: lastExamined.id }
      : priorCheckpoint;
    const backfill = state(
      complete ? 'complete' : 'in_progress',
      submissionsExamined,
      count,
      nextCheckpoint,
    );
    backfill.historyStart =
      asString(priorState.historyStart) ?? rows[0]?.createdAt.toISOString() ?? null;
    return {
      count,
      newestCreatedAt: complete
        ? (lastExamined?.createdAt.toISOString() ?? lastClientSubmissionAt)
        : lastClientSubmissionAt,
      backfill,
    };
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
    const startedAt = asString(priorState.startedAt) ?? new Date().toISOString();
    const priorCheckpoint = asRecord(priorState.checkpoint);
    const checkpointAt = asString(priorCheckpoint.appliedAt);
    const checkpointKey = asString(priorCheckpoint.key) ?? '';
    const state = (
      status: AdvocacyBackfillStatus,
      examined: number,
      candidates: number,
      checkpoint: Record<string, unknown> | null,
    ): AdvocacySourceBackfillState => ({
      status,
      startedAt,
      completedAt: status === 'complete' ? new Date().toISOString() : undefined,
      checkpoint,
      historyStart: asString(priorState.historyStart) ?? null,
      examined: Number(priorState.examined ?? 0) + examined,
      candidates: Number(priorState.candidates ?? 0) + candidates,
      lastError: null,
    });
    if (currentCount >= MAX_ADVOCACY_FINDINGS) {
      return {
        count: 0,
        newestAppliedAt: lastRelationshipLinkAppliedAt,
        backfill: state('in_progress', 0, 0, priorCheckpoint),
      };
    }
    let rows: Array<{
      id: string;
      proposedValue: unknown;
      evidence: unknown;
      appliedAt: Date | null;
    }> = [];
    try {
      rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$queryRawUnsafe<
          Array<{ id: string; proposedValue: unknown; evidence: unknown; appliedAt: Date | null }>
        >(
          `SELECT id,
                proposed_value_jsonb AS "proposedValue",
                evidence_jsonb AS evidence,
                applied_at AS "appliedAt"
           FROM client_profile_fill_finding
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid
            AND kind = 'relationship_link' AND status = 'accepted'
            AND applied_at IS NOT NULL
            AND (($3::timestamptz IS NULL) OR applied_at > $3::timestamptz
              OR (applied_at = $3::timestamptz AND id::text > $4::text))
          ORDER BY applied_at ASC, id::text ASC
          LIMIT 250`,
          ctx.tenantId,
          clientId,
          checkpointAt,
          checkpointKey,
        ),
      );
    } catch (error) {
      const lastError = this.safeError(error);
      this.logger.warn(`Private advocacy rail unavailable: ${lastError}`);
      return {
        count: 0,
        newestAppliedAt: lastRelationshipLinkAppliedAt,
        backfill: { ...state('partial', 0, 0, priorCheckpoint), lastError },
      };
    }
    let count = 0;
    let lastPrivateExamined: (typeof rows)[number] | undefined;
    let privateExamined = 0;
    for (const row of rows) {
      if (currentCount + count >= MAX_ADVOCACY_FINDINGS) break;
      lastPrivateExamined = row;
      privateExamined += 1;
      const proposal = asRecord(row.proposedValue);
      const title = asString(proposal.title) ?? '';
      if (!containsAdvocacyTerm(title)) continue;
      const entityType = asString(proposal.entityType);
      const entityId = asString(proposal.entityId);
      if (!entityType || !entityId) continue;
      const externalKey = `relationship:${entityType}:${entityId}`;
      const proposedValue = {
        externalKey,
        recordType: entityType === 'meeting' ? 'advocacy_meeting' : 'advocacy_correspondence',
        title,
        summary:
          'The interaction subject appears advocacy-related. The source record remains authoritative; review before classifying it as advocacy.',
        activityDate: asString(proposal.occurredAt),
        status: 'activity_observed',
        outcome: null,
        sourceType: entityType,
        sourceId: entityId,
        sourceUrl: null,
        evidenceClass: 'PRIVATE_ACTIVITY',
        confidence: 0.72,
        metadata: {
          relationshipFindingId: row.id,
          matchReason: proposal.matchReason,
          matchedDomains: proposal.matchedDomains,
        },
      };
      const inserted = await this.addFinding(ctx.tenantId, clientId, runId, {
        kind: 'advocacy_record',
        targetKey: `advocacy:${externalKey}`,
        source: 'advocacy_history',
        factKind: 'recommendation',
        currentValue: null,
        proposedValue,
        confidence: 0.72,
        status: 'pending',
        evidence: Array.isArray(row.evidence) ? row.evidence : [],
      });
      if (inserted) count += 1;
    }
    // ORDER BY applied_at DESC NULLS LAST — the first row with a non-null
    // appliedAt is the newest watermark candidate; a fully-NULL result set
    // (or zero rows) leaves the watermark exactly where it was rather than
    // advancing it on nothing, which would silently make the query above
    // WIDER on some later run if a NULL applied_at ever got backfilled.
    const lastExamined = lastPrivateExamined;
    const complete = rows.length < 250 && privateExamined === rows.length;
    const nextCheckpoint = lastExamined?.appliedAt
      ? { appliedAt: lastExamined.appliedAt.toISOString(), key: lastExamined.id }
      : priorCheckpoint;
    const backfill = state(
      complete ? 'complete' : 'in_progress',
      privateExamined,
      count,
      nextCheckpoint,
    );
    backfill.historyStart =
      asString(priorState.historyStart) ?? rows[0]?.appliedAt?.toISOString() ?? null;
    return {
      count,
      newestAppliedAt: complete
        ? (lastExamined?.appliedAt?.toISOString() ?? lastRelationshipLinkAppliedAt)
        : lastRelationshipLinkAppliedAt,
      backfill,
    };
  }

  /**
   * Federal Register history is enrichment-only. The bounded unit is one
   * client Matter (at most 50 deterministic docket matches are returned by
   * the existing service); no client-name corpus search or advocacy finding
   * is created here. A keyset checkpoint makes eligible-Matter coverage
   * resumable while preserving the existing review-only, causation=false
   * correlation contract.
   */
  private async gatherFederalRegisterBackfill(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    priorState: Record<string, unknown>,
  ): Promise<AdvocacySourceBackfillState> {
    const startedAt = asString(priorState.startedAt) ?? new Date().toISOString();
    const checkpointId = asString(asRecord(priorState.checkpoint).matterId);
    const backfillComplete = asString(priorState.status) === 'complete';
    const lastSuccessAt = asString(priorState.lastSuccessAt);
    try {
      const matters = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT m.id
             FROM client_advocacy_matter m
            WHERE m.tenant_id = $1::uuid AND m.client_id = $2::uuid
              AND EXISTS (
                SELECT 1 FROM client_advocacy_matter_link l
                 WHERE l.tenant_id = m.tenant_id AND l.matter_id = m.id
                   AND l.link_type IN ('regulatory_docket', 'regulatory_document')
              )
              AND (NOT $3::boolean
                OR m.updated_at > $4::timestamptz
                OR EXISTS (
                  SELECT 1 FROM client_advocacy_matter_link changed
                   WHERE changed.tenant_id = m.tenant_id AND changed.matter_id = m.id
                     AND changed.link_type IN ('regulatory_docket', 'regulatory_document')
                     AND changed.created_at > $4::timestamptz
                ))
              AND ($3::boolean OR $5::uuid IS NULL OR m.id > $5::uuid)
            ORDER BY CASE WHEN $3::boolean THEN m.updated_at END ASC NULLS FIRST, m.id ASC
            ${backfillComplete ? '' : 'LIMIT 50'}`,
          ctx.tenantId,
          clientId,
          backfillComplete,
          lastSuccessAt ?? '1970-01-01T00:00:00.000Z',
          checkpointId,
        ),
      );
      let candidates = 0;
      const suggestions: unknown[] = [];
      for (const matter of matters) {
        const matterSuggestions = await this.advocacyMatters.suggestFederalRegisterCorrelations(
          ctx,
          clientId,
          matter.id,
        );
        candidates += matterSuggestions.length;
        suggestions.push(
          ...matterSuggestions.map((suggestion) => ({ matterId: matter.id, ...suggestion })),
        );
        await this.emitRegulatoryOutcomeFindings(
          ctx,
          clientId,
          runId,
          matter.id,
          matterSuggestions,
        );
      }
      const complete = backfillComplete || matters.length < 50;
      return {
        status: complete ? 'complete' : 'in_progress',
        startedAt,
        completedAt: complete ? new Date().toISOString() : undefined,
        checkpoint: backfillComplete
          ? Object.keys(asRecord(priorState.checkpoint)).length
            ? asRecord(priorState.checkpoint)
            : null
          : matters.at(-1)
            ? { matterId: matters.at(-1)!.id }
            : null,
        historyStart: null,
        examined: Number(priorState.examined ?? 0) + matters.length,
        candidates: Number(priorState.candidates ?? 0) + candidates,
        lastError: null,
        suggestions,
      };
    } catch (error) {
      const lastError = this.safeError(error);
      this.logger.warn(`Federal Register correlation backfill unavailable: ${lastError}`);
      return {
        status: 'partial',
        startedAt,
        checkpoint: null,
        historyStart: null,
        examined: 0,
        candidates: 0,
        lastError,
      };
    }
  }

  /**
   * Completes the "Government Movement -> Outcome" step
   * `suggestFederalRegisterCorrelations` (PR #1310) deliberately left as
   * separately-confirmed follow-on work. For each exact-docket-id-matched
   * Federal Register document on this Matter, checks whether it was
   * published AFTER the client's earliest attributable Regulations.gov
   * submission on the SAME Matter (`client_advocacy_record.source_type =
   * 'regulatory_comment'`, matter-scoped so a client with multiple Matters
   * never has one Matter's advocacy date gate another's) and, if so, emits
   * a `regulatory_outcome` finding via the exact same `addFinding`
   * content-hash/terminal-status machinery every other advocacy-history
   * finding uses — so rerun idempotency and accepted/rejected review-state
   * preservation come from that unchanged, already-proven mechanism, not
   * from new bookkeeping here. Never auto-applies: like every other
   * advanced finding, a human must accept it (`applyRegulatoryOutcome`)
   * before an OutcomeEvent is ever created.
   *
   * One query per Matter, only when there is at least one deterministic
   * candidate to gate — a Matter with zero exact-docket matches this run
   * never touches `client_advocacy_record` at all.
   */
  private async emitRegulatoryOutcomeFindings(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    matterId: string,
    suggestions: FederalRegisterCorrelationSuggestion[],
  ): Promise<void> {
    const deterministic = suggestions.filter(
      (suggestion) => suggestion.matchedDocketIds.length > 0,
    );
    if (deterministic.length === 0) return;
    const earliest = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ earliestActivityDate: Date | null }>>(
        `SELECT MIN(activity_date) AS "earliestActivityDate"
           FROM client_advocacy_record
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND matter_id = $3::uuid
            AND source_type = 'regulatory_comment'`,
        ctx.tenantId,
        clientId,
        matterId,
      ),
    );
    const attributableActivityDate = earliest[0]?.earliestActivityDate ?? null;
    for (const suggestion of deterministic) {
      const proposedValue = buildRegulatoryOutcomeFinding(
        matterId,
        suggestion,
        attributableActivityDate,
      );
      if (!proposedValue) continue;
      const docketId = proposedValue.docketId as string;
      await this.addFinding(ctx.tenantId, clientId, runId, {
        kind: 'regulatory_outcome',
        targetKey: `regulatory-outcome:${matterId}:${suggestion.documentNumber}`,
        source: 'federal_register',
        factKind: 'recommendation',
        currentValue: null,
        proposedValue,
        confidence: 0.95,
        status: 'pending',
        evidence: [
          {
            label: `${suggestion.documentType} published on docket ${docketId}, after the client's Regulations.gov submission`,
            url: suggestion.sourceUrl,
            source: 'Federal Register government-movement correlation',
            metadata: {
              documentNumber: suggestion.documentNumber,
              docketId,
              causationClaimed: false,
              matchedOn: 'docket_id',
            },
          },
        ],
      });
    }
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

  private async applyAdvancedFinding(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
  ): Promise<void> {
    switch (finding.kind) {
      case 'federal_footprint':
        await this.applyFederalFootprint(ctx, clientId, finding);
        return;
      case 'advocacy_record':
        await this.applyAdvocacyRecord(ctx, clientId, finding);
        return;
      case 'advocacy_outcome':
        await this.applyAdvocacyOutcome(ctx, clientId, finding);
        return;
      case 'regulatory_outcome':
        await this.applyRegulatoryOutcome(ctx, clientId, finding);
        return;
      default:
        throw new BadRequestException(`Unsupported completion finding: ${finding.kind}`);
    }
  }

  private async applyFederalFootprint(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
  ) {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const before = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { intakeData: true },
      });
      if (!before) throw new NotFoundException('Client not found');
      await tx.$executeRawUnsafe(
        `UPDATE clients
            SET intake_data_jsonb = jsonb_set(
                  COALESCE(intake_data_jsonb, '{}'::jsonb),
                  '{federalMarket}',
                  $4::jsonb,
                  true
                ),
                updated_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        clientId,
        ctx.tenantId,
        finding.id,
        JSON.stringify(finding.proposedValue),
      );
      await this.auditAdvanced(
        tx,
        ctx,
        clientId,
        finding,
        asRecord(before.intakeData).federalMarket,
        finding.proposedValue,
      );
    });
  }

  /**
   * Applies an advocacy_record finding's proposed value as an upsert into
   * `client_advocacy_record`.
   *
   * `matterTarget` distinguishes two callers:
   *  - Omitted (the generic bulk `applyFindings` path): Matter assignment
   *    runs via `assignMatterForRecord` in its OWN transaction, AFTER the
   *    record commit, best-effort — a clustering failure is logged but
   *    never blocks the accept. This is existing, unchanged behavior.
   *  - Provided (a human explicitly picked "Attach to Matter X" / "Create
   *    new Matter" on this pending finding — see
   *    `applyAdvocacyFindingToMatter`): the record upsert AND the Matter
   *    assign+lock run inside the SAME transaction. The human's choice is
   *    the review decision; if the Matter side fails, the whole write
   *    rolls back rather than silently accepting an unassigned record, and
   *    the caller never proceeds to `markAccepted` — the finding stays
   *    pending; the record upsert's own idempotency (ON CONFLICT) plus
   *    `assignSpecificMatterForRecord`'s already-locked check make a retry
   *    safe.
   *
   * Returns the resolved Matter id when `matterTarget` was provided;
   * `null` for the untargeted path (nothing new callers need there today).
   */
  private async applyAdvocacyRecord(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
    matterTarget?:
      | { matterId: string }
      | { newMatter: { title: string; matterType?: string; summary?: string | null } },
  ): Promise<string | null> {
    const proposed = asRecord(finding.proposedValue);
    const externalKey = requiredString(proposed.externalKey, 'Advocacy external key');
    const title = requiredString(proposed.title, 'Advocacy title');
    const recordType = requiredString(proposed.recordType, 'Advocacy record type');
    const sourceType = requiredString(proposed.sourceType, 'Advocacy source type');
    // Revalidate old pending suggestions as well as new ones. Similarity scores
    // (and a corrected matter assignment) are not proof of client attribution.
    if (sourceType === 'fara' || sourceType === 'testimony') {
      const metadata = asRecord(proposed.metadata);
      const sourceKey =
        sourceType === 'fara'
          ? asString(metadata.registrationNumber)
          : `${asString(metadata.hearingId) ?? ''}::${asString(metadata.witness) ?? ''}`;
      const confirmed = await this.getConfirmedIntelMappingKeys(ctx, clientId, sourceType);
      if (!sourceKey || !confirmed.has(sourceKey)) {
        throw new BadRequestException(
          'Verify this record’s organization-to-client mapping before accepting it as advocacy. A name match alone is insufficient.',
        );
      }
      proposed.metadata = {
        ...metadata,
        clientMatch: {
          ...asRecord(metadata.clientMatch),
          method: 'confirmed_client_intel_mapping',
          verifiedAt: new Date().toISOString(),
        },
      };
    }
    const evidenceClass = normalizeEvidenceClass(proposed.evidenceClass);
    const activityDate = asString(proposed.activityDate);
    let targetedMatterId: string | null = null;
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO client_advocacy_record
           (tenant_id, client_id, record_type, title, summary, activity_date,
            status, outcome, source_type, source_id, source_url, evidence_class,
            confidence, external_key, metadata_jsonb, created_by_user_id)
         VALUES (
           $1::uuid, $2::uuid, $3, $4, $5,
           CASE WHEN $6 = '' THEN NULL ELSE $6::timestamptz::date END,
           $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16::uuid
         )
         ON CONFLICT (tenant_id, client_id, external_key) DO UPDATE
           SET record_type = EXCLUDED.record_type,
               title = EXCLUDED.title,
               summary = EXCLUDED.summary,
               activity_date = EXCLUDED.activity_date,
               status = EXCLUDED.status,
               outcome = COALESCE(EXCLUDED.outcome, client_advocacy_record.outcome),
               source_type = EXCLUDED.source_type,
               source_id = EXCLUDED.source_id,
               source_url = EXCLUDED.source_url,
               evidence_class = EXCLUDED.evidence_class,
               confidence = EXCLUDED.confidence,
               metadata_jsonb = client_advocacy_record.metadata_jsonb || EXCLUDED.metadata_jsonb,
               updated_at = now()`,
        ctx.tenantId,
        clientId,
        recordType,
        title,
        asString(proposed.summary),
        activityDate ?? '',
        asString(proposed.status),
        asString(proposed.outcome),
        sourceType,
        asString(proposed.sourceId),
        asString(proposed.sourceUrl),
        evidenceClass,
        Math.max(0, Math.min(1, Number(proposed.confidence ?? finding.confidence))),
        externalKey,
        JSON.stringify(asRecord(proposed.metadata)),
        ctx.userId,
      );
      await this.auditAdvanced(tx, ctx, clientId, finding, null, proposed);
      if (matterTarget) {
        // Same transaction as the upsert above — a human-directed Matter
        // choice must commit atomically with the record it applies to.
        targetedMatterId = await this.advocacyMatters.assignSpecificMatterForRecord(
          tx,
          ctx,
          clientId,
          externalKey,
          matterTarget,
          activityDate,
        );
      }
    });
    if (matterTarget) return targetedMatterId;
    // Assigns/creates the Advocacy Matter this record belongs to. Runs as
    // its own transaction (not nested in the upsert above — Prisma does not
    // support nesting interactive transactions on one client) immediately
    // after the record commit, so a failure here never blocks the record
    // apply itself; it is logged and surfaced on the next reconciliation
    // pass rather than rolling back a successful accept.
    try {
      await this.advocacyMatters.assignMatterForRecord(ctx, clientId, externalKey, {
        recordType,
        title,
        metadata: asRecord(proposed.metadata),
        activityDate,
      });
    } catch (error) {
      this.logger.warn(
        `Advocacy matter assignment failed for ${clientId}/${externalKey}: ${this.safeError(error)}`,
      );
    }
    return null;
  }

  /**
   * §22/23 follow-up: a reviewer picks "Attach to Matter X" / "Create new
   * Matter" directly on a still-pending advocacy_record finding. That
   * choice IS the review/approval decision — there is no separate staging
   * queue, no "save for later" state, and no second apply workflow. This
   * commits immediately: record upsert + Matter assign/lock (atomic, see
   * `applyAdvocacyRecord`) then `markAccepted` through the SAME
   * accept/audit path every other applied finding uses.
   *
   * Idempotent: if the finding is already `accepted` (a duplicate
   * invocation — e.g. a double-click, or a client retry after a response
   * was lost in transit), this makes NO writes at all and simply returns
   * the Matter the record already resolved to, read fresh. It does not
   * matter whether the retry's `target` matches the original choice —
   * once a finding is accepted, this method's job is done; further
   * correction goes through the existing reassign/detach/merge paths, not
   * a second application of this action.
   */
  async applyAdvocacyFindingToMatter(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    findingId: string,
    target:
      | { matterId: string }
      | { newMatter: { title: string; matterType?: string; summary?: string | null } },
  ): Promise<{ findingId: string; matterId: string | null; alreadyApplied: boolean }> {
    if ('matterId' in target === 'newMatter' in target) {
      throw new BadRequestException('Provide exactly one of matterId or newMatter');
    }
    const findings = await this.loadFindings(ctx.tenantId, clientId, runId, [findingId]);
    const finding = findings[0];
    if (!finding) throw new BadRequestException('Finding is no longer available');
    if (finding.kind !== 'advocacy_record') {
      throw new BadRequestException('Only advocacy findings support direct Matter assignment');
    }

    if (finding.status === 'accepted') {
      const currentMatterId = await this.lookupAppliedAdvocacyMatterId(ctx, clientId, finding);
      return { findingId, matterId: currentMatterId, alreadyApplied: true };
    }
    if (finding.status !== 'pending') {
      throw new BadRequestException('Only pending findings can be applied');
    }

    const matterId = await this.applyAdvocacyRecord(ctx, clientId, finding, target);
    await this.markAccepted(ctx, clientId, finding.id);
    return { findingId, matterId, alreadyApplied: false };
  }

  /** Read-only lookup used by the idempotent-replay branch of
   *  `applyAdvocacyFindingToMatter` — never writes anything. */
  private async lookupAppliedAdvocacyMatterId(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
  ): Promise<string | null> {
    const proposed = asRecord(finding.proposedValue);
    const externalKey = asString(proposed.externalKey);
    if (!externalKey) return null;
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ matterId: string | null }>>(
        `SELECT matter_id AS "matterId" FROM client_advocacy_record
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND external_key = $3`,
        ctx.tenantId,
        clientId,
        externalKey,
      ),
    );
    return rows[0]?.matterId ?? null;
  }

  private async applyAdvocacyOutcome(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
  ) {
    const proposed = asRecord(finding.proposedValue);
    const externalKey = requiredString(proposed.advocacyExternalKey, 'Advocacy record');
    const outcomeKind = requiredString(proposed.outcomeKind, 'Outcome kind');
    const outcomeEventId = asString(proposed.outcomeEventId);
    const matterId = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const changed = await tx.$executeRawUnsafe(
        `UPDATE client_advocacy_record
            SET outcome = $4,
                status = 'outcome_observed',
                metadata_jsonb = metadata_jsonb || jsonb_build_object(
                  'linkedOutcome', $5::jsonb,
                  'causationClaimed', false
                ),
                updated_at = now()
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND external_key = $3`,
        ctx.tenantId,
        clientId,
        externalKey,
        outcomeKind,
        JSON.stringify(proposed),
      );
      if (Number(changed) !== 1) {
        throw new BadRequestException(
          'Apply the related advocacy record before linking its outcome',
        );
      }
      await this.auditAdvanced(tx, ctx, clientId, finding, null, proposed);
      const matterRows = await tx.$queryRawUnsafe<Array<{ matterId: string | null }>>(
        `SELECT matter_id AS "matterId" FROM client_advocacy_record
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND external_key = $3`,
        ctx.tenantId,
        clientId,
        externalKey,
      );
      return matterRows[0]?.matterId ?? null;
    });
    // Outcome events are institutional-history objects in their own right
    // (product spec: "Matter groups ... government actions [and] outcomes")
    // even though they never become their own client_advocacy_record row.
    // Link the outcome event into the same Matter as the advocacy record it
    // was matched against, so the Matter's timeline shows what happened
    // after the ask without claiming causation (causationClaimed stays
    // false on the record itself, set above).
    if (matterId && outcomeEventId) {
      try {
        await this.advocacyMatters.linkToMatter(ctx, matterId, {
          linkType: 'outcome_event',
          linkKey: outcomeEventId,
          label: `Observed outcome: ${outcomeKind}`,
          metadata: { causationClaimed: false, outcomeKind },
        });
      } catch (error) {
        this.logger.warn(
          `Advocacy matter outcome link failed for ${clientId}/${matterId}: ${this.safeError(error)}`,
        );
      }
    }
  }

  /**
   * Applies a `regulatory_outcome` finding (built by
   * `emitRegulatoryOutcomeFindings`/`buildRegulatoryOutcomeFinding`): a
   * human accepting the finding IS the separately-confirmed step
   * `suggestFederalRegisterCorrelations` deferred. Creates the OutcomeEvent
   * directly here (unlike `applyAdvocacyOutcome`, which links a
   * pre-existing one) since nothing else in the system ever creates an
   * outcome_event for a Federal Register document — this finding's accept
   * IS that creation. `evidence` carries the docket/document identifiers
   * `OutcomeEvent` has no dedicated columns for (§ gap: the smallest
   * necessary addition is these evidence keys, not new columns, matching
   * every other outcome kind's snapshot-into-evidence convention).
   *
   * `recordedBy` is the accepting user (the record() convention every other
   * apply* method already uses via `ctx.userId` for its own writes) — the
   * human review IS the attribution, not a system mirror.
   */
  private async applyRegulatoryOutcome(
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
  ): Promise<void> {
    const proposed = asRecord(finding.proposedValue);
    const matterId = requiredString(proposed.matterId, 'Advocacy matter');
    const documentNumber = requiredString(
      proposed.documentNumber,
      'Federal Register document number',
    );
    const docketId = requiredString(proposed.docketId, 'Docket id');
    const publicationDate = asString(proposed.publicationDate);
    const evidence = {
      docketId,
      documentNumber,
      documentType: asString(proposed.documentType),
      agencyNames: Array.isArray(proposed.agencyNames) ? proposed.agencyNames : [],
      publicationDate,
      matchedOn: 'docket_id',
      causationClaimed: false,
    };
    const outcomeEvent = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const created = await tx.outcomeEvent.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          kind: 'regulatory_action_published',
          sourceType: 'regulatory_document',
          sourceId: documentNumber,
          evidence: evidence as Prisma.InputJsonValue,
          notes: `Government movement observed on docket ${docketId} after the client's attributable Regulations.gov advocacy — causation not claimed.`,
          recordedBy: ctx.userId,
          ...(publicationDate ? { observedAt: new Date(publicationDate) } : {}),
        },
      });
      await this.auditAdvanced(tx, ctx, clientId, finding, null, proposed);
      return created;
    });
    // Same looseness as applyAdvocacyOutcome's own Matter link: the
    // OutcomeEvent is already durably recorded above; a Matter-link failure
    // is logged, never rolled back into losing that record.
    try {
      await this.advocacyMatters.linkToMatter(ctx, matterId, {
        linkType: 'outcome_event',
        linkKey: outcomeEvent.id,
        label: `Observed government movement: ${evidence.documentType ?? 'Federal Register document'} on docket ${docketId}`,
        metadata: {
          causationClaimed: false,
          matchedOn: 'docket_id',
          relationship: 'strongly_aligned',
          documentNumber,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Regulatory matter outcome link failed for ${clientId}/${matterId}: ${this.safeError(error)}`,
      );
    }
  }

  private async markAccepted(ctx: TenantContext, clientId: string, findingId: string) {
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_finding
            SET status = 'accepted', reviewed_by = $4::uuid, reviewed_at = now(),
                applied_at = now(), rejection_reason = NULL, updated_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
            AND status = 'pending'`,
        findingId,
        ctx.tenantId,
        clientId,
        ctx.userId,
      ),
    );
  }

  private async auditAdvanced(
    tx: any,
    ctx: TenantContext,
    clientId: string,
    finding: AdvancedFindingRow,
    before: unknown,
    after: unknown,
  ) {
    await tx.auditLog.create({
      data: {
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        actorRole: (ctx as unknown as { role?: string }).role ?? null,
        action: 'client_profile_fill.apply',
        entityType: `client_profile_fill:${finding.kind}`,
        entityId: clientId,
        before: { findingId: finding.id, value: jsonSafe(before) } as any,
        after: {
          findingId: finding.id,
          targetKey: finding.targetKey,
          source: finding.source,
          value: jsonSafe(after),
        } as any,
      },
    });
  }

  private async loadFindings(
    tenantId: string,
    clientId: string,
    runId: string,
    findingIds: string[],
  ) {
    return this.prisma.withTenant(tenantId, (tx) =>
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
            AND id = ANY($4::uuid[])`,
        tenantId,
        clientId,
        runId,
        [...new Set(findingIds)],
      ),
    );
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

function requiredString(value: unknown, label: string): string {
  const text = asString(value);
  if (!text) throw new BadRequestException(`${label} is required`);
  return text;
}

function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
