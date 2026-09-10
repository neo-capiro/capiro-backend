import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from '../engagement/engagement.service.js';
import { ClientPrepopulationService } from '../intelligence/client-prepopulation.service.js';
import { IntelligenceService } from '../intelligence/intelligence.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CLIENT_PROFILE_FILL_SOURCES,
  normalizeWebsite,
  type ClientProfileFillSource,
} from './client-profile-fill.helpers.js';
import {
  ClientProfileFillContextPlaneService,
  type ClientProfileFillGovernedContext,
} from './client-profile-fill-context-plane.service.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';
import { buildFillRunSummary, requeueFillReviewChecks } from './client-profile-fill-retry.js';
import { runWithGovernedCrmFillBundle } from './governed-client-profile-fill.factory.js';

export const CLIENT_PROFILE_FILL_TASK_TYPES = [
  'public_web',
  'synced_email',
  'sam_gov',
  'lda',
  'program_elements',
  'bill_tracker',
  'client_document',
] as const;

export type ClientProfileFillTaskType = (typeof CLIENT_PROFILE_FILL_TASK_TYPES)[number];
export type ClientProfileFillTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface ClientProfileFillTaskPlanSpec {
  taskType: ClientProfileFillTaskType;
  taskKey: string;
  dependsOnKeys: string[];
  input: Record<string, unknown>;
}

export interface StartClientProfileFillWorkflowInput {
  sources?: ClientProfileFillSource[];
  attachmentIds?: string[];
  ldaClientIds?: number[];
  website?: string | null;
}

export interface ClientProfileFillIdentityOption {
  id: number;
  name: string;
  state: string | null;
  filingCount: number;
  latestFilingYear: number | null;
  confidence: number;
  selected: boolean;
  origin: 'imported' | 'suggested';
}

interface FillEngineInternals {
  gatherPublicWeb(ctx: TenantContext, clientId: string, runId: string): Promise<number>;
  gatherSyncedEmail(ctx: TenantContext, clientId: string, runId: string): Promise<number>;
  gatherSam(ctx: TenantContext, clientId: string, runId: string): Promise<number>;
  gatherLda(ctx: TenantContext, clientId: string, runId: string): Promise<number>;
  gatherProgramElements(ctx: TenantContext, clientId: string, runId: string): Promise<number>;
  gatherBillRecommendations(ctx: TenantContext, clientId: string, runId: string): Promise<number>;
  gatherCapabilityDocument(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    attachmentId: string,
    documentText: string,
  ): Promise<number>;
  maybeSeedWebsite(ctx: TenantContext, clientId: string, seedWebsite?: string | null): Promise<void>;
}

interface WorkflowRunRow {
  id: string;
  clientId: string;
  status: string;
  requestedSources: string[];
  sourceStates: Record<string, unknown>;
  summary: Record<string, unknown>;
  error: string | null;
  workflowVersion: number;
  stage: string;
  setup: Record<string, unknown>;
  selectedLdaIds: number[];
  attachmentIds: string[];
  lastProgressAt: Date | null;
  cancelledAt: Date | null;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowTaskRow {
  id: string;
  runId: string;
  tenantId: string;
  clientId: string;
  taskType: ClientProfileFillTaskType;
  taskKey: string;
  status: ClientProfileFillTaskStatus;
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

interface FindingRow {
  id: string;
  runId: string;
  clientId: string;
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
  reviewedBy: string | null;
  reviewedAt: Date | null;
  rejectionReason: string | null;
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface IdentityRow {
  id: number;
  name: string;
  state: string | null;
  filingCount: number;
  latestFilingYear: number | null;
  similarity?: number | string | null;
}

const TERMINAL_TASK_STATUSES = new Set<ClientProfileFillTaskStatus>([
  'completed',
  'failed',
  'skipped',
  'cancelled',
]);
const TASK_CLAIM_BATCH = 4;
const TASK_SWEEP_MS = 1_500;
const TASK_HEARTBEAT_MS = 15_000;
const TASK_STALE_MS = 5 * 60_000;
const TASK_TIMEOUT_MS = 5 * 60_000;
const MAX_ATTACHMENTS = 10;
const MAX_LDA_IDENTITIES = 20;

/**
 * Build the durable specialist graph. Early evidence rails fan out in parallel;
 * Program Elements waits for capability-producing rails, and Bill Tracker waits
 * for the evidence rails it uses to explain a recommendation.
 */
export function buildClientProfileFillTaskPlan(input: {
  sources: readonly ClientProfileFillSource[];
  attachmentIds: readonly string[];
}): ClientProfileFillTaskPlanSpec[] {
  const sources = [...new Set(input.sources)].filter((source) =>
    CLIENT_PROFILE_FILL_SOURCES.includes(source),
  );
  const attachmentIds = [...new Set(input.attachmentIds)];
  const plan: ClientProfileFillTaskPlanSpec[] = [];

  for (const source of sources) {
    if (source === 'program_elements' || source === 'bill_tracker') continue;
    plan.push({ taskType: source, taskKey: source, dependsOnKeys: [], input: {} });
  }

  for (const attachmentId of attachmentIds) {
    plan.push({
      taskType: 'client_document',
      taskKey: `client_document:${attachmentId}`,
      dependsOnKeys: [],
      input: { attachmentId },
    });
  }

  const capabilityDependencies = plan
    .filter((task) => task.taskType === 'public_web' || task.taskType === 'client_document')
    .map((task) => task.taskKey);

  if (sources.includes('program_elements')) {
    plan.push({
      taskType: 'program_elements',
      taskKey: 'program_elements',
      dependsOnKeys: capabilityDependencies,
      input: {},
    });
  }

  if (sources.includes('bill_tracker')) {
    const billDependencies = plan
      .filter((task) =>
        ['public_web', 'client_document', 'lda', 'program_elements'].includes(task.taskType),
      )
      .map((task) => task.taskKey);
    plan.push({
      taskType: 'bill_tracker',
      taskKey: 'bill_tracker',
      dependsOnKeys: billDependencies,
      input: {},
    });
  }

  return plan;
}

export function deriveClientProfileFillRunStatus(
  statuses: readonly ClientProfileFillTaskStatus[],
): 'completed' | 'partial' | 'failed' {
  const failed = statuses.filter((status) => status === 'failed').length;
  const completed = statuses.filter((status) => status === 'completed' || status === 'skipped').length;
  if (failed > 0 && completed === 0) return 'failed';
  if (failed > 0) return 'partial';
  return 'completed';
}

@Injectable()
export class ClientProfileFillWorkflowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClientProfileFillWorkflowService.name);
  private readonly engine: FillEngineInternals;
  private readonly workerId = process.env.HOSTNAME ?? `api-${process.pid}`;
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fill: ClientProfileFillService,
    private readonly contextPlane: ClientProfileFillContextPlaneService,
    private readonly attachments: EngagementService,
    private readonly intelligence: IntelligenceService,
    private readonly prepopulation: ClientPrepopulationService,
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {
    this.engine = this.fill as unknown as FillEngineInternals;
  }

  onModuleInit(): void {
    if (
      process.env.NODE_ENV === 'test' ||
      process.env.CLIENT_PROFILE_FILL_WORKER_ENABLED === 'false' ||
      // `NestFactory.createApplicationContext(AppModule, ...)` (the LegiWatch
      // Phase 9 `run-legiwatch-phase9-job.ts` / `run-legiwatch-phase9-operator.ts`
      // one-shot CLI bootstraps, and any future one-off script that reuses the
      // full AppModule) never registers an HTTP adapter, so `httpAdapterHost`
      // stays unset. Those processes run their one job in ~1s and call
      // `app.close()`, which disconnects PrismaService. Starting this sweep
      // loop there means its queued/interval-scheduled `withSystem`/`withTenant`
      // call races the disconnect and throws "Transaction API error:
      // Transaction not found ... obtained before disconnecting" on every
      // invocation. Only the real long-running server (`apps/api/src/main.ts`,
      // `NestFactory.create(AppModule, ...)`) has a populated httpAdapter.
      !this.httpAdapterHost?.httpAdapter
    ) {
      return;
    }
    this.timer = setInterval(() => this.requestSweep(), TASK_SWEEP_MS);
    this.timer.unref?.();
    queueMicrotask(() => this.requestSweep());
    this.logger.log(`Fill with Meri task worker started (${this.workerId})`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async getSetup(ctx: TenantContext, clientId: string) {
    const { client, mappings } = await this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        const client = await tx.client.findFirst({
          where: {
            id: clientId,
            tenantId: ctx.tenantId,
            status: { not: 'archived' },
            OR: [
              { memoryWall: false },
              { memoryAccessGrants: { some: { userId: ctx.userId } } },
            ],
          },
          select: { id: true, name: true, website: true, ldaClientIds: true },
        });
        if (!client) throw new NotFoundException('Client not found');
        const mappings = await tx.clientIntelMapping.findMany({
          where: { clientId, tenantId: ctx.tenantId, source: 'lda', confirmed: true },
          select: { externalId: true, externalName: true },
          orderBy: { confidence: 'desc' },
        });
        return { client, mappings };
      },
    );

    const mappingNameById = new Map<number, string>();
    for (const mapping of mappings) {
      const id = Number(mapping.externalId);
      if (Number.isInteger(id) && id > 0) mappingNameById.set(id, mapping.externalName);
    }
    const selectedIds = [...new Set([...client.ldaClientIds, ...mappingNameById.keys()])].sort(
      (a, b) => a - b,
    );
    const selectedRows = selectedIds.length
      ? await this.prisma.$queryRawUnsafe<IdentityRow[]>(
          `SELECT c.id,
                  c.name,
                  c.state,
                  COALESCE(c.total_filings, 0)::int AS "filingCount",
                  MAX(f.filing_year)::int AS "latestFilingYear"
             FROM lda_client c
             LEFT JOIN lda_filing f ON f.client_id = c.id
            WHERE c.id = ANY($1::int[])
            GROUP BY c.id, c.name, c.state, c.total_filings
            ORDER BY COALESCE(c.total_filings, 0) DESC, c.name ASC`,
          selectedIds,
        )
      : [];
    const selectedById = new Map(selectedRows.map((row) => [row.id, row]));
    const selectedIdentities: ClientProfileFillIdentityOption[] = selectedIds.map((id) => {
      const row = selectedById.get(id);
      return {
        id,
        name: row?.name ?? mappingNameById.get(id) ?? `LDA client ${id}`,
        state: row?.state ?? null,
        filingCount: Number(row?.filingCount ?? 0),
        latestFilingYear: row?.latestFilingYear ?? null,
        confidence: 1,
        selected: true,
        origin: 'imported',
      };
    });

    const anchorName = selectedIdentities[0]?.name ?? client.name;
    const suggestionRows = await this.prisma.$queryRawUnsafe<IdentityRow[]>(
      `SELECT c.id,
              c.name,
              c.state,
              COALESCE(c.total_filings, 0)::int AS "filingCount",
              MAX(f.filing_year)::int AS "latestFilingYear",
              GREATEST(
                similarity(c.name, $2),
                similarity(c.name, $3),
                word_similarity($2, c.name),
                word_similarity($3, c.name)
              )::float AS similarity
         FROM lda_client c
         LEFT JOIN lda_filing f ON f.client_id = c.id
        WHERE (cardinality($1::int[]) = 0 OR c.id <> ALL($1::int[]))
          AND GREATEST(
                similarity(c.name, $2),
                similarity(c.name, $3),
                word_similarity($2, c.name),
                word_similarity($3, c.name)
              ) >= 0.42
        GROUP BY c.id, c.name, c.state, c.total_filings
        ORDER BY similarity DESC, COALESCE(c.total_filings, 0) DESC
        LIMIT 8`,
      selectedIds,
      anchorName,
      client.name,
    );
    const suggestedIdentities: ClientProfileFillIdentityOption[] = suggestionRows.map((row) => {
      const similarity = Number(row.similarity ?? 0);
      return {
        id: row.id,
        name: row.name,
        state: row.state,
        filingCount: Number(row.filingCount ?? 0),
        latestFilingYear: row.latestFilingYear,
        confidence: Number(Math.min(0.99, Math.max(0.5, 0.5 + similarity * 0.48)).toFixed(3)),
        selected: false,
        origin: 'suggested',
      };
    });

    return {
      clientId: client.id,
      clientName: client.name,
      website: client.website,
      selectedIdentities,
      suggestedIdentities,
      taskPreview: [
        'Public web',
        'Synced email',
        'SAM.gov',
        'LDA',
        'Capability documents',
        'Program Elements',
        'Bill Tracker',
      ],
    };
  }

  async startRun(ctx: TenantContext, clientId: string, input: StartClientProfileFillWorkflowInput) {
    const active = await this.latestActiveRun(ctx.tenantId, clientId);
    if (active) return this.getRun(ctx, clientId, active.id);

    const setup = await this.getSetup(ctx, clientId);
    const sources = this.normalizeSources(input.sources);
    const attachmentIds = this.normalizeAttachmentIds(input.attachmentIds);
    const requestedLdaIds = this.normalizeLdaIds(input.ldaClientIds);
    const allowedIdentities = new Map(
      [...setup.selectedIdentities, ...setup.suggestedIdentities].map((identity) => [
        identity.id,
        identity,
      ]),
    );
    for (const id of requestedLdaIds) {
      if (!allowedIdentities.has(id)) {
        throw new BadRequestException(`LDA identity ${id} was not offered for this client`);
      }
    }
    const selectedLdaIds = [
      ...new Set([...setup.selectedIdentities.map((identity) => identity.id), ...requestedLdaIds]),
    ].sort((a, b) => a - b);
    const attachmentRows = await this.validateAttachments(ctx, clientId, attachmentIds);

    const rawWebsite = input.website?.trim() ?? '';
    const website = rawWebsite ? normalizeWebsite(rawWebsite) : null;
    if (rawWebsite && !website) throw new BadRequestException('Enter a valid http(s) company website');
    if (website) await this.engine.maybeSeedWebsite(ctx, clientId, website);

    const currentLdaIds = new Set(setup.selectedIdentities.map((identity) => identity.id));
    const appendedLdaIds = selectedLdaIds.filter((id) => !currentLdaIds.has(id));
    for (const id of appendedLdaIds) {
      const identity = allowedIdentities.get(id)!;
      await this.intelligence.createManualMapping(clientId, ctx.tenantId, {
        source: 'lda',
        externalId: String(id),
        externalName: identity.name,
        actorUserId: ctx.userId,
      });
    }
    if (appendedLdaIds.length) {
      await this.prepopulation.prepopulate(ctx.tenantId, clientId).catch((error) =>
        this.logger.warn(
          `Prepopulation after appending LDA identities failed for ${clientId}: ${this.safeError(error)}`,
        ),
      );
    }

    const bundle = await this.contextPlane.resolve(ctx, {
      clientId,
      requestedSources: sources,
      attachmentId: attachmentIds[0] ?? null,
    });
    const plan = buildClientProfileFillTaskPlan({ sources, attachmentIds });
    if (!plan.length) throw new BadRequestException('No Fill with Meri tasks were selected');
    const idByKey = new Map(plan.map((task) => [task.taskKey, randomUUID()]));
    const sourceStates: Record<string, unknown> = Object.fromEntries(
      sources.map((source) => [source, { status: 'queued', count: 0 }]),
    );
    if (attachmentRows.length) {
      sourceStates.client_document = {
        status: 'queued',
        count: 0,
        totalTasks: attachmentRows.length,
        attachments: attachmentRows,
      };
    }
    const setupSnapshot = {
      website,
      selectedLdaIds,
      appendedLdaIds,
      attachmentIds,
      attachments: attachmentRows,
      sources,
    };

    const runId = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO client_profile_fill_run
           (tenant_id, client_id, created_by_user_id, status, requested_sources,
            source_states_jsonb, workflow_version, stage, setup_jsonb,
            selected_lda_ids, attachment_ids, last_progress_at)
         VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'running',
           ARRAY(SELECT jsonb_array_elements_text($4::jsonb)), $5::jsonb,
           2, 'preparing', $6::jsonb,
           ARRAY(SELECT jsonb_array_elements_text($7::jsonb)::int),
           ARRAY(SELECT jsonb_array_elements_text($8::jsonb)::uuid), now()
         )
         RETURNING id`,
        ctx.tenantId,
        clientId,
        ctx.userId,
        JSON.stringify(sources),
        JSON.stringify(sourceStates),
        JSON.stringify(setupSnapshot),
        JSON.stringify(selectedLdaIds),
        JSON.stringify(attachmentIds),
      );
      const id = rows[0]?.id;
      if (!id) throw new Error('Failed to create agentic Fill with Meri run');
      for (const task of plan) {
        const taskId = idByKey.get(task.taskKey)!;
        const dependsOn = task.dependsOnKeys.map((key) => idByKey.get(key)!).filter(Boolean);
        await tx.$executeRawUnsafe(
          `INSERT INTO client_profile_fill_task
             (id, run_id, tenant_id, client_id, task_type, task_key, status,
              depends_on, input_jsonb, max_attempts)
           VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'queued',
             ARRAY(SELECT jsonb_array_elements_text($7::jsonb)::uuid), $8::jsonb, 3
           )`,
          taskId,
          id,
          ctx.tenantId,
          clientId,
          task.taskType,
          task.taskKey,
          JSON.stringify(dependsOn),
          JSON.stringify(task.input),
        );
      }
      return id;
    });

    try {
      await this.contextPlane.recordRunContext(ctx, runId, bundle);
      await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_run
              SET stage = 'research', last_progress_at = now(), updated_at = now()
            WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
              AND status = 'running'`,
          runId,
          ctx.tenantId,
          clientId,
        ),
      );
    } catch (error) {
      await this.contextPlane.failRun(ctx, clientId, runId, error);
      await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_run
              SET stage = 'failed', last_progress_at = now(), updated_at = now()
            WHERE id = $1::uuid AND tenant_id = $2::uuid`,
          runId,
          ctx.tenantId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_task
              SET status = 'cancelled', completed_at = now(), updated_at = now()
            WHERE run_id = $1::uuid AND tenant_id = $2::uuid
              AND status IN ('queued', 'running')`,
          runId,
          ctx.tenantId,
        );
      });
      throw error;
    }

    queueMicrotask(() => this.requestSweep());
    return this.getRun(ctx, clientId, runId);
  }

  async getLatest(ctx: TenantContext, clientId: string) {
    await this.assertClient(ctx, clientId);
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id
           FROM client_profile_fill_run
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid
          ORDER BY created_at DESC
          LIMIT 1`,
        ctx.tenantId,
        clientId,
      ),
    );
    return rows[0] ? this.getRun(ctx, clientId, rows[0].id) : null;
  }

  async getRun(ctx: TenantContext, clientId: string, runId: string) {
    await this.assertClient(ctx, clientId);
    const runRows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<WorkflowRunRow[]>(
        `SELECT id,
                client_id AS "clientId",
                status,
                requested_sources AS "requestedSources",
                source_states_jsonb AS "sourceStates",
                summary_jsonb AS "summary",
                error,
                workflow_version AS "workflowVersion",
                stage,
                setup_jsonb AS setup,
                selected_lda_ids AS "selectedLdaIds",
                attachment_ids AS "attachmentIds",
                last_progress_at AS "lastProgressAt",
                cancelled_at AS "cancelledAt",
                started_at AS "startedAt",
                completed_at AS "completedAt",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
           FROM client_profile_fill_run
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid`,
        runId,
        ctx.tenantId,
        clientId,
      ),
    );
    const run = runRows[0];
    if (!run) throw new NotFoundException('Enrichment run not found');
    if (Number(run.workflowVersion ?? 1) < 2) {
      return this.fill.getRun(ctx, clientId, runId);
    }

    const [findings, tasks] = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const findings = await tx.$queryRawUnsafe<FindingRow[]>(
        `SELECT id,
                run_id AS "runId",
                client_id AS "clientId",
                kind,
                target_key AS "targetKey",
                source,
                fact_kind AS "factKind",
                current_value_jsonb AS "currentValue",
                proposed_value_jsonb AS "proposedValue",
                evidence_jsonb AS evidence,
                confidence,
                status,
                content_hash AS "contentHash",
                reviewed_by AS "reviewedBy",
                reviewed_at AS "reviewedAt",
                rejection_reason AS "rejectionReason",
                applied_at AS "appliedAt",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
           FROM client_profile_fill_finding
          WHERE run_id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
          ORDER BY created_at ASC, id ASC`,
        runId,
        ctx.tenantId,
        clientId,
      );
      const tasks = await tx.$queryRawUnsafe<WorkflowTaskRow[]>(
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
           FROM client_profile_fill_task
          WHERE run_id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
          ORDER BY created_at ASC, task_key ASC`,
        runId,
        ctx.tenantId,
        clientId,
      );
      return [findings, tasks] as const;
    });
    const progress = this.progress(tasks);
    return {
      ...run,
      progress,
      tasks,
      findings: findings.map((finding) => ({
        ...finding,
        confidence: Number(finding.confidence),
        evidence: Array.isArray(finding.evidence) ? finding.evidence : [],
      })),
    };
  }

  async cancelRun(ctx: TenantContext, clientId: string, runId: string) {
    await this.assertClient(ctx, clientId);
    const changed = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const count = await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_run
            SET status = 'cancelled', stage = 'cancelled', cancelled_at = now(),
                completed_at = now(), last_progress_at = now(), updated_at = now(), error = NULL
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
            AND workflow_version >= 2 AND status = 'running'`,
        runId,
        ctx.tenantId,
        clientId,
      );
      if (Number(count) === 1) {
        await tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_task
              SET status = 'cancelled', completed_at = now(), heartbeat_at = NULL,
                  worker_id = NULL, updated_at = now()
            WHERE run_id = $1::uuid AND tenant_id = $2::uuid
              AND status IN ('queued', 'running')`,
          runId,
          ctx.tenantId,
        );
      }
      return Number(count);
    });
    if (changed !== 1) throw new BadRequestException('This Fill with Meri run cannot be cancelled');
    return this.getRun(ctx, clientId, runId);
  }

  async retryTask(ctx: TenantContext, clientId: string, runId: string, taskId: string) {
    await this.assertClient(ctx, clientId);
    const changed = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Finalization takes the same run lock before reading task states.
      const runs = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM client_profile_fill_run
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
            AND workflow_version >= 2 AND status <> 'cancelled' FOR UPDATE`,
        runId, ctx.tenantId, clientId,
      );
      if (!runs.length) throw new BadRequestException('This run cannot be retried');
      const count = await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_task
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
        await tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_run
              SET status = 'running', stage = 'research', completed_at = NULL,
                  error = NULL, last_progress_at = now(), updated_at = now()
            WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
              AND workflow_version >= 2 AND status <> 'cancelled'`,
          runId,
          ctx.tenantId,
          clientId,
        );
        await requeueFillReviewChecks(tx, runId, ctx.tenantId);
      }
      return Number(count);
    });
    if (changed !== 1) throw new BadRequestException('Only failed tasks can be retried');
    queueMicrotask(() => this.requestSweep());
    return this.getRun(ctx, clientId, runId);
  }

  /** Exposed for focused worker tests and one-off operational recovery. */
  async sweepOnce(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.recoverPreparingRuns();
      await this.recoverStaleTasks();
      await this.recoverInterruptedRetries();
      const tasks = await this.claimTasks();
      await Promise.all(tasks.map((task) => this.executeClaimedTask(task)));
      await this.finalizeReadyRuns();
    } finally {
      this.sweeping = false;
    }
  }

  private requestSweep(): void {
    void this.sweepOnce().catch((error) =>
      this.logger.error(`Fill with Meri task sweep failed: ${this.safeError(error)}`),
    );
  }

  /** Repair runs closed by an older finalizer while a core retry was pending. */
  private async recoverInterruptedRetries(): Promise<void> {
    await this.prisma.withSystem(async (tx) => {
      const runs = await tx.$queryRawUnsafe<Array<{ id: string; tenantId: string }>>(
        `SELECT r.id, r.tenant_id AS "tenantId" FROM client_profile_fill_run r
          WHERE r.workflow_version >= 2 AND r.status IN ('partial', 'failed', 'completed')
            AND EXISTS (SELECT 1 FROM client_profile_fill_task t
                         WHERE t.run_id = r.id AND t.tenant_id = r.tenant_id
                           AND t.status IN ('queued', 'running'))
          ORDER BY r.updated_at ASC LIMIT 20 FOR UPDATE OF r SKIP LOCKED`,
      );
      for (const run of runs) {
        await tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_run SET status = 'running', stage = 'research',
                  completed_at = NULL, error = NULL, last_progress_at = now(), updated_at = now()
            WHERE id = $1::uuid AND tenant_id = $2::uuid`,
          run.id, run.tenantId,
        );
        await requeueFillReviewChecks(tx, run.id, run.tenantId);
      }
    });
  }

  private async recoverPreparingRuns(): Promise<void> {
    const cutoff = new Date(Date.now() - 15_000);
    const runs = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<
        Array<{
          id: string;
          tenantId: string;
          clientId: string;
          createdByUserId: string;
          requestedSources: ClientProfileFillSource[];
          attachmentIds: string[];
        }>
      >(
        `SELECT id,
                tenant_id AS "tenantId",
                client_id AS "clientId",
                created_by_user_id AS "createdByUserId",
                requested_sources AS "requestedSources",
                attachment_ids AS "attachmentIds"
           FROM client_profile_fill_run
          WHERE workflow_version >= 2
            AND status = 'running'
            AND stage = 'preparing'
            AND created_by_user_id IS NOT NULL
            AND updated_at < $1
          ORDER BY updated_at ASC
          LIMIT 5`,
        cutoff,
      ),
    );
    for (const run of runs) {
      const ctx: TenantContext = {
        tenantId: run.tenantId,
        tenantSlug: '',
        userId: run.createdByUserId,
        clerkUserId: '',
        role: 'standard_user',
      };
      try {
        const bundle = await this.contextPlane.resolve(ctx, {
          clientId: run.clientId,
          requestedSources: run.requestedSources,
          attachmentId: run.attachmentIds[0] ?? null,
        });
        await this.contextPlane.recordRunContext(ctx, run.id, bundle);
        await this.prisma.withSystem((tx) =>
          tx.$executeRawUnsafe(
            `UPDATE client_profile_fill_run
                SET stage = 'research', last_progress_at = now(), updated_at = now()
              WHERE id = $1::uuid AND tenant_id = $2::uuid
                AND status = 'running' AND stage = 'preparing'`,
            run.id,
            run.tenantId,
          ),
        );
      } catch (error) {
        await this.contextPlane.failRun(ctx, run.clientId, run.id, error);
        await this.prisma.withSystem(async (tx) => {
          await tx.$executeRawUnsafe(
            `UPDATE client_profile_fill_run
                SET stage = 'failed', last_progress_at = now(), updated_at = now()
              WHERE id = $1::uuid AND tenant_id = $2::uuid`,
            run.id,
            run.tenantId,
          );
          await tx.$executeRawUnsafe(
            `UPDATE client_profile_fill_task
                SET status = 'cancelled', completed_at = now(), updated_at = now()
              WHERE run_id = $1::uuid AND tenant_id = $2::uuid
                AND status IN ('queued', 'running')`,
            run.id,
            run.tenantId,
          );
        });
      }
    }
  }

  private async recoverStaleTasks(): Promise<void> {
    const cutoff = new Date(Date.now() - TASK_STALE_MS);
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ runId: string; tenantId: string; taskType: ClientProfileFillTaskType }>>(
        `UPDATE client_profile_fill_task
            SET status = CASE WHEN attempt >= max_attempts THEN 'failed' ELSE 'queued' END,
                next_attempt_at = CASE
                  WHEN attempt >= max_attempts THEN next_attempt_at
                  ELSE now()
                END,
                error_code = 'worker_stale',
                error_message = 'Worker heartbeat expired before task completion',
                completed_at = CASE WHEN attempt >= max_attempts THEN now() ELSE NULL END,
                claimed_at = NULL,
                heartbeat_at = NULL,
                worker_id = NULL,
                updated_at = now()
          WHERE status = 'running'
            AND COALESCE(heartbeat_at, claimed_at, updated_at) < $1
          RETURNING run_id AS "runId", tenant_id AS "tenantId", task_type AS "taskType"`,
        cutoff,
      ),
    );
    for (const row of rows) await this.syncSourceState(row.tenantId, row.runId, row.taskType);
  }

  private async claimTasks(): Promise<WorkflowTaskRow[]> {
    return this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<WorkflowTaskRow[]>(
        `WITH candidates AS (
           SELECT t.id
             FROM client_profile_fill_task t
             JOIN client_profile_fill_run r
               ON r.id = t.run_id AND r.tenant_id = t.tenant_id AND r.client_id = t.client_id
            WHERE t.status = 'queued'
              AND t.next_attempt_at <= now()
              AND r.status = 'running'
              AND r.stage = 'research'
              AND NOT EXISTS (
                SELECT 1
                  FROM unnest(t.depends_on) AS dependency_id(id)
                  JOIN client_profile_fill_task dependency ON dependency.id = dependency_id.id
                 WHERE dependency.status NOT IN ('completed', 'failed', 'skipped', 'cancelled')
              )
            ORDER BY t.created_at ASC, t.task_key ASC
            FOR UPDATE OF t SKIP LOCKED
            LIMIT $1
         )
         UPDATE client_profile_fill_task t
            SET status = 'running', attempt = attempt + 1,
                claimed_at = now(), heartbeat_at = now(), worker_id = $2,
                error_code = NULL, error_message = NULL, updated_at = now()
           FROM candidates c, client_profile_fill_run r
          WHERE t.id = c.id
            AND r.id = t.run_id AND r.tenant_id = t.tenant_id AND r.client_id = t.client_id
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
                   t.updated_at AS "updatedAt",
                   r.created_by_user_id AS "createdByUserId"`,
        TASK_CLAIM_BATCH,
        // A fresh lease distinguishes successive claims by the same worker.
        `${this.workerId}:${randomUUID()}`,
      ),
    );
  }

  private async executeClaimedTask(task: WorkflowTaskRow): Promise<void> {
    await this.syncSourceState(task.tenantId, task.runId, task.taskType);
    const userId = task.createdByUserId;
    if (!userId) {
      await this.failTask(task, 'missing_actor', 'The run has no actor user id', false);
      return;
    }
    const ctx: TenantContext = {
      tenantId: task.tenantId,
      tenantSlug: '',
      userId,
      clerkUserId: '',
      role: 'standard_user',
    };
    const attachmentId = this.stringValue(task.input.attachmentId);
    const heartbeat = setInterval(() => {
      void this.heartbeat(task).catch((error) =>
        this.logger.warn(`Fill task heartbeat failed for ${task.id}: ${this.safeError(error)}`),
      );
    }, TASK_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      const source = task.taskType === 'client_document' ? undefined : task.taskType;
      const count = await this.withTaskTimeout<number>(async (signal) => {
        const bundle = await this.contextPlane.resolve(ctx, {
          clientId: task.clientId,
          requestedSources: source ? [source] : undefined,
          attachmentId,
        });
        signal.throwIfAborted();
        await this.contextPlane.recordRunContext(ctx, task.runId, bundle);
        signal.throwIfAborted();
        return runWithGovernedCrmFillBundle(bundle, () => this.executeTask(ctx, task, bundle));
      });
      await this.completeTask(task, count);
    } catch (error) {
      await this.failTask(task, 'task_failed', this.safeError(error), task.attempt < task.maxAttempts);
    } finally {
      clearInterval(heartbeat);
      await this.syncSourceState(task.tenantId, task.runId, task.taskType);
      queueMicrotask(() => this.requestSweep());
    }
  }

  private async executeTask(
    ctx: TenantContext,
    task: WorkflowTaskRow,
    _bundle: ClientProfileFillGovernedContext,
  ): Promise<number> {
    switch (task.taskType) {
      case 'public_web':
        return this.engine.gatherPublicWeb(ctx, task.clientId, task.runId);
      case 'synced_email':
        return this.engine.gatherSyncedEmail(ctx, task.clientId, task.runId);
      case 'sam_gov':
        return this.engine.gatherSam(ctx, task.clientId, task.runId);
      case 'lda':
        return this.engine.gatherLda(ctx, task.clientId, task.runId);
      case 'program_elements':
        return this.engine.gatherProgramElements(ctx, task.clientId, task.runId);
      case 'bill_tracker':
        return this.engine.gatherBillRecommendations(ctx, task.clientId, task.runId);
      case 'client_document': {
        const attachmentId = this.stringValue(task.input.attachmentId);
        if (!attachmentId) throw new BadRequestException('Capability document task is missing attachmentId');
        const attachment = await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.engagementAttachment.findFirst({
            where: { id: attachmentId, tenantId: ctx.tenantId, clientId: task.clientId },
            select: { id: true, clientId: true },
          }),
        );
        if (!attachment || attachment.clientId !== task.clientId) {
          throw new NotFoundException('Capability document not found for this client');
        }
        const text = await this.attachments.extractAttachmentText(ctx, attachment.id);
        return this.engine.gatherCapabilityDocument(
          ctx,
          task.clientId,
          task.runId,
          attachment.id,
          text.text,
        );
      }
    }
    throw new BadRequestException(`Unsupported Fill with Meri task: ${String(task.taskType)}`);
  }

  private async heartbeat(task: WorkflowTaskRow): Promise<void> {
    await this.prisma.withSystem(async (tx) => {
      const changed = await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_task
            SET heartbeat_at = now(), updated_at = now()
          WHERE id = $1::uuid AND status = 'running' AND worker_id = $2`,
        task.id,
        task.workerId,
      );
      if (Number(changed) !== 1) return;
      await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_run
            SET last_progress_at = now(), updated_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'running'`,
        task.runId,
        task.tenantId,
      );
    });
  }

  private async completeTask(task: WorkflowTaskRow, count: number): Promise<void> {
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_task t
            SET status = 'completed', output_summary_jsonb = $2::jsonb,
                completed_at = now(), claimed_at = NULL, heartbeat_at = NULL, worker_id = NULL,
                updated_at = now()
          WHERE t.id = $1::uuid AND t.status = 'running' AND t.worker_id = $3
            AND EXISTS (
              SELECT 1 FROM client_profile_fill_run r
               WHERE r.id = t.run_id AND r.tenant_id = t.tenant_id
                 AND r.status = 'running'
            )`,
        task.id,
        JSON.stringify({ count }),
        task.workerId,
      ),
    );
  }

  private async failTask(
    task: WorkflowTaskRow,
    code: string,
    message: string,
    retry: boolean,
  ): Promise<void> {
    const delayMs = Math.min(60_000, 2_000 * 2 ** Math.max(0, task.attempt - 1));
    const nextAttemptAt = new Date(Date.now() + delayMs);
    const changed = await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_task t
            SET status = $2,
                next_attempt_at = CASE WHEN $2 = 'queued' THEN $3 ELSE next_attempt_at END,
                error_code = $4, error_message = $5,
                completed_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END,
                claimed_at = NULL, heartbeat_at = NULL, worker_id = NULL,
                updated_at = now()
          WHERE t.id = $1::uuid AND t.status = 'running' AND t.worker_id = $6
            AND EXISTS (
              SELECT 1 FROM client_profile_fill_run r
               WHERE r.id = t.run_id AND r.tenant_id = t.tenant_id
                 AND r.status = 'running'
            )`,
        task.id,
        retry ? 'queued' : 'failed',
        nextAttemptAt,
        code,
        message.slice(0, 2_000),
        task.workerId,
      ),
    );
    if (Number(changed) !== 1) return;
    this.logger.warn(
      `Fill with Meri ${task.taskKey} ${retry ? 'will retry' : 'failed'} for ${task.clientId}: ${message}`,
    );
  }

  private async syncSourceState(
    tenantId: string,
    runId: string,
    taskType: ClientProfileFillTaskType,
  ): Promise<void> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<
        Array<{
          status: ClientProfileFillTaskStatus;
          count: number;
          errorMessage: string | null;
        }>
      >(
        `SELECT status,
                COALESCE((output_summary_jsonb->>'count')::int, 0) AS count,
                error_message AS "errorMessage"
           FROM client_profile_fill_task
          WHERE run_id = $1::uuid AND tenant_id = $2::uuid AND task_type = $3
          ORDER BY created_at ASC`,
        runId,
        tenantId,
        taskType,
      ),
    );
    if (!rows.length) return;
    const statuses = rows.map((row) => row.status);
    const totalCount = rows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
    const completedTasks = statuses.filter((status) => status === 'completed').length;
    const failedTasks = statuses.filter((status) => status === 'failed').length;
    let status = 'queued';
    if (statuses.some((value) => value === 'running')) status = 'running';
    else if (statuses.some((value) => value === 'queued')) status = failedTasks ? 'retrying' : 'queued';
    else if (failedTasks === rows.length) status = 'failed';
    else if (failedTasks > 0) status = 'partial';
    else if (statuses.every((value) => value === 'cancelled')) status = 'cancelled';
    else status = 'completed';
    const state = {
      status,
      count: totalCount,
      totalTasks: rows.length,
      completedTasks,
      failedTasks,
      ...(rows.find((row) => row.errorMessage)?.errorMessage
        ? { error: rows.find((row) => row.errorMessage)!.errorMessage }
        : {}),
    };
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_run
            SET source_states_jsonb = jsonb_set(
                  COALESCE(source_states_jsonb, '{}'::jsonb),
                  ARRAY[$3]::text[], $4::jsonb, true
                ),
                last_progress_at = now(), updated_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'running'`,
        runId,
        tenantId,
        taskType,
        JSON.stringify(state),
      ),
    );
  }

  private async finalizeReadyRuns(): Promise<void> {
    const runs = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string; tenantId: string }>>(
        `SELECT r.id, r.tenant_id AS "tenantId"
           FROM client_profile_fill_run r
          WHERE r.workflow_version >= 2
            AND r.status = 'running'
            AND r.stage = 'research'
            AND NOT EXISTS (
              SELECT 1 FROM client_profile_fill_extension_task extension
               WHERE extension.run_id = r.id AND extension.tenant_id = r.tenant_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM client_profile_fill_task t
               WHERE t.run_id = r.id AND t.tenant_id = r.tenant_id
                 AND t.status IN ('queued', 'running')
            )
          ORDER BY r.updated_at ASC
          LIMIT 20`,
      ),
    );
    for (const run of runs) {
      await this.prisma.withSystem(async (tx) => {
        const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM client_profile_fill_run WHERE id = $1::uuid
            AND tenant_id = $2::uuid AND status = 'running' FOR UPDATE`,
          run.id, run.tenantId,
        );
        if (!locked.length) return;
        const taskRows = await tx.$queryRawUnsafe<Array<{ status: ClientProfileFillTaskStatus }>>(
          `SELECT status FROM client_profile_fill_task
            WHERE run_id = $1::uuid AND tenant_id = $2::uuid`,
          run.id,
          run.tenantId,
        );
        if (taskRows.some((task) => task.status === 'queued' || task.status === 'running')) return;
        const status = deriveClientProfileFillRunStatus(taskRows.map((row) => row.status));
        const summary = await buildFillRunSummary(tx, run.id, run.tenantId);
        await tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_run
              SET status = $3,
                  stage = CASE WHEN $3 = 'failed' THEN 'failed' ELSE 'review_ready' END,
                  summary_jsonb = $4::jsonb,
                  completed_at = now(), last_progress_at = now(), updated_at = now(),
                  error = CASE WHEN $3 = 'failed' THEN 'All selected enrichment tasks failed' ELSE NULL END
            WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'running'`,
          run.id,
          run.tenantId,
          status,
          JSON.stringify(summary),
        );
      });
    }
  }

  private async latestActiveRun(tenantId: string, clientId: string) {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM client_profile_fill_run
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid
            AND workflow_version >= 2 AND status = 'running'
          ORDER BY created_at DESC LIMIT 1`,
        tenantId,
        clientId,
      ),
    );
    return rows[0] ?? null;
  }

  private async validateAttachments(ctx: TenantContext, clientId: string, attachmentIds: string[]) {
    if (!attachmentIds.length) return [];
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementAttachment.findMany({
        where: { id: { in: attachmentIds }, tenantId: ctx.tenantId, clientId },
        select: { id: true, fileName: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    if (rows.length !== attachmentIds.length) {
      throw new BadRequestException('One or more capability documents do not belong to this client');
    }
    return rows;
  }

  private async assertClient(ctx: TenantContext, clientId: string): Promise<void> {
    const client = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.client.findFirst({
        where: {
          id: clientId,
          tenantId: ctx.tenantId,
          status: { not: 'archived' },
          OR: [
            { memoryWall: false },
            { memoryAccessGrants: { some: { userId: ctx.userId } } },
          ],
        },
        select: { id: true },
      }),
    );
    if (!client) throw new NotFoundException('Client not found');
  }

  private normalizeSources(requested?: ClientProfileFillSource[]): ClientProfileFillSource[] {
    if (!requested?.length) return [...CLIENT_PROFILE_FILL_SOURCES];
    const allowed = new Set<ClientProfileFillSource>(CLIENT_PROFILE_FILL_SOURCES);
    const sources = [...new Set(requested)].filter((source) => allowed.has(source));
    if (!sources.length) throw new BadRequestException('No valid enrichment sources selected');
    return sources;
  }

  private normalizeAttachmentIds(values?: string[]): string[] {
    const ids = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
    if (ids.length > MAX_ATTACHMENTS) {
      throw new BadRequestException(`Choose no more than ${MAX_ATTACHMENTS} capability documents`);
    }
    return ids;
  }

  private normalizeLdaIds(values?: number[]): number[] {
    const ids = [...new Set((values ?? []).filter((value) => Number.isInteger(value) && value > 0))];
    if (ids.length > MAX_LDA_IDENTITIES) {
      throw new BadRequestException(`Choose no more than ${MAX_LDA_IDENTITIES} LDA identities`);
    }
    return ids;
  }

  private progress(tasks: WorkflowTaskRow[]) {
    return {
      total: tasks.length,
      queued: tasks.filter((task) => task.status === 'queued').length,
      running: tasks.filter((task) => task.status === 'running').length,
      completed: tasks.filter((task) => task.status === 'completed').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
      cancelled: tasks.filter((task) => task.status === 'cancelled').length,
    };
  }

  private async withTaskTimeout<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error('Fill specialist exceeded its task budget. Retry this check.');
            controller.abort(error);
            reject(error);
          }, TASK_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private stringValue(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private safeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
