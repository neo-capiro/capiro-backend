import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { GenerationGatewayService } from '../engagement/generation/generation-gateway.service.js';
import type { GenerationResult } from '../engagement/generation/generation-gateway.types.js';
import { OutreachDraftService } from '../engagement/outreach-draft.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';
import { assertOutreachContextSponsorIsolation } from '../outreach-v3/context/outreach-context-sponsor-policy.js';
import {
  isOutreachV3ApproachApprovalCurrent,
  type OutreachV3ApproachApprovalSnapshot,
} from '../outreach-v3/generation/outreach-v3-generation-approach.js';
import {
  isOutreachV3FullGenerationJobCurrent,
  parseOutreachV3FullGenerationJob,
  type OutreachV3FullGenerationJobDescriptor,
} from '../outreach-v3/generation/outreach-v3-full-generation-job.js';
import {
  buildOutreachV3GenerationPlan,
  type OutreachV3GenerationPlan,
} from '../outreach-v3/generation/outreach-v3-generation-plan.js';
import { OutreachV3GenerationPreparationService } from '../outreach-v3/generation/outreach-v3-generation-preparation.service.js';
import { buildOutreachV3GatewayUnit } from '../outreach-v3/generation/outreach-v3-generation-request.js';
import {
  hashCampaignSpecV1,
  parseCampaignSpecV1,
  type OutreachCampaignSpecV1,
} from '../outreach-v3/state/outreach-campaign-spec.v1.js';
import {
  deriveOutreachReadiness,
  PHASE5_OUTREACH_FEATURE_AVAILABILITY,
} from '../outreach-v3/state/outreach-readiness.contract.js';
import { OUTREACH_V3_FULL_GENERATION_JOB_KIND } from '../outreach-v3/generation/outreach-v3-full-generation.service.js';

const DEFAULT_SWEEP_MS = 5_000;
const DEFAULT_STALE_MS = 5 * 60_000;

export function parseOutreachV3FullGenerationWorkerEnabled(value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const lower = value.toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(lower)) return true;
  if (['false', '0', 'off', 'no'].includes(lower)) return false;
  throw new Error('Invalid OUTREACH_V3_FULL_GENERATION_ENABLED value');
}

interface CurrentCampaign {
  spec: OutreachCampaignSpecV1;
  plan: OutreachV3GenerationPlan;
}

@Injectable()
export class OutreachV3FullGenerationWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutreachV3FullGenerationWorkerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly enabled = parseOutreachV3FullGenerationWorkerEnabled(
    process.env.OUTREACH_V3_FULL_GENERATION_ENABLED,
  );
  private readonly sweepMs = boundedPositiveInt(
    process.env.OUTREACH_V3_FULL_GENERATION_SWEEP_MS,
    DEFAULT_SWEEP_MS,
    1_000,
    60_000,
  );
  private readonly staleMs = boundedPositiveInt(
    process.env.OUTREACH_V3_FULL_GENERATION_STALE_MS,
    DEFAULT_STALE_MS,
    60_000,
    60 * 60_000,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: GenerationGatewayService,
    private readonly drafts: OutreachDraftService,
    private readonly preparation: OutreachV3GenerationPreparationService,
    private readonly runtime: EngagementRuntimePolicyService,
  ) {}

  onModuleInit(): void {
    if (this.timer || !this.enabled || !this.runtime.outreachV3FullGenerationWorkerEnabled())
      return;
    this.timer = setInterval(() => void this.tick(), this.sweepMs);
    this.timer.unref?.();
    this.logger.log(`Outreach V3 full-generation worker started (every ${this.sweepMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runWorkerTick(): Promise<void> {
    this.runtime.assertOutreachV3FullGenerationWorker();
    await this.reclaimStaleClaims();
    const jobId = await this.findRunnableJobId();
    if (jobId) await this.processJob(jobId);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runWorkerTick();
    } catch (error) {
      this.logger.error(`Outreach V3 full-generation sweep failed: ${safeError(error)}`);
    } finally {
      this.running = false;
    }
  }

  private async findRunnableJobId(): Promise<string | null> {
    return this.prisma.withSystem(async (tx) => {
      const job = await tx.outreachJob.findFirst({
        where: {
          kind: OUTREACH_V3_FULL_GENERATION_JOB_KIND,
          status: { in: ['queued', 'running'] },
          items: { some: { status: 'pending' } },
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      return job?.id ?? null;
    });
  }

  private async processJob(jobId: string): Promise<void> {
    const job = await this.prisma.withSystem((tx) =>
      tx.outreachJob.findFirst({
        where: { id: jobId, kind: OUTREACH_V3_FULL_GENERATION_JOB_KIND },
        select: {
          id: true,
          tenantId: true,
          userId: true,
          outreachRecordId: true,
          params: true,
          status: true,
        },
      }),
    );
    if (!job || !job.userId || !job.outreachRecordId || job.status === 'canceled') return;

    const descriptor = parseOutreachV3FullGenerationJob(asRecord(job.params).v3FullGeneration);
    if (!descriptor || descriptor.sessionId !== job.outreachRecordId) {
      await this.failWholeJob(job.id, 'FULL_GENERATION_JOB_CORRUPT');
      return;
    }

    const ctx = workerContext(job.tenantId, job.userId);
    const current = await this.loadCurrentCampaign(ctx, descriptor.sessionId).catch(() => null);
    const approval = current
      ? await this.loadCurrentApproval(ctx, descriptor.sessionId, current.plan).catch(() => null)
      : null;
    if (!current || !isOutreachV3FullGenerationJobCurrent(descriptor, current.plan, approval)) {
      await this.failWholeJob(job.id, 'FULL_GENERATION_JOB_STALE');
      return;
    }

    if (job.status === 'queued') {
      await this.prisma.withSystem((tx) =>
        tx.outreachJob.updateMany({
          where: { id: job.id, status: 'queued' },
          data: { status: 'running', startedAt: new Date() },
        }),
      );
    }

    for (;;) {
      const batch = await this.claimBatch(job.id, descriptor.batchSize);
      if (!batch.length) break;
      for (const item of batch) {
        await this.processItem(ctx, job.id, descriptor, item).catch(async (error) => {
          await this.finishItem(item.id, 'failed', null, safeError(error));
        });
      }
      const live = await this.prisma.withSystem((tx) =>
        tx.outreachJob.findFirst({ where: { id: job.id }, select: { status: true } }),
      );
      if (!live || live.status === 'canceled') break;
    }
    await this.finalizeJob(job.id);
  }

  private async processItem(
    ctx: TenantContext,
    jobId: string,
    descriptor: OutreachV3FullGenerationJobDescriptor,
    item: { id: string; generationKey: string },
  ): Promise<void> {
    const stillActive = await this.prisma.withSystem((tx) =>
      tx.outreachJob.findFirst({
        where: { id: jobId, status: { in: ['queued', 'running'] } },
        select: { id: true },
      }),
    );
    if (!stillActive) {
      await this.finishItem(item.id, 'skipped', null, null);
      return;
    }

    await this.prisma.withSystem((tx) =>
      tx.outreachJobItem.updateMany({
        where: { id: item.id, status: 'claimed' },
        data: { status: 'generating' },
      }),
    );

    const current = await this.loadCurrentCampaign(ctx, descriptor.sessionId);
    const approval = await this.loadCurrentApproval(ctx, descriptor.sessionId, current.plan);
    if (!isOutreachV3FullGenerationJobCurrent(descriptor, current.plan, approval)) {
      await this.finishItem(item.id, 'failed', null, 'FULL_GENERATION_JOB_STALE');
      return;
    }

    const existing = await this.existingVersionForPlan(ctx, descriptor, item.generationKey);
    if (existing) {
      await this.finishItem(
        item.id,
        existing.status,
        existing.result,
        existing.status === 'failed' ? 'EXISTING_VERSION_UNUSABLE' : null,
      );
      return;
    }

    const slot = current.plan.slots.find(
      (candidate) => candidate.generationKey === item.generationKey,
    );
    if (
      !slot ||
      !descriptor.items.some((candidate) => candidate.generationKey === item.generationKey)
    ) {
      await this.finishItem(item.id, 'failed', null, 'GENERATION_SLOT_NOT_IN_JOB');
      return;
    }

    const prepared = await this.preparation.prepareSlot(ctx, current.spec, slot);
    const unit = buildOutreachV3GatewayUnit({
      plan: current.plan,
      spec: current.spec,
      prepared,
      outreachRecordId: descriptor.sessionId,
    });
    let policy;
    try {
      policy = this.gateway.resolvePolicy(unit.request);
    } catch {
      await this.finishItem(item.id, 'failed', null, 'AUDIENCE_POLICY_REQUIRED');
      return;
    }
    const credentials = await this.gateway.resolvePinnedIdentity(ctx, {
      policy,
      runtimeAction: unit.request.runtimeAction,
    });
    if (
      !credentials ||
      !credentials.creds.some((cred) => cred.provider === descriptor.pinned.provider)
    ) {
      await this.finishItem(item.id, 'failed', null, 'PINNED_PROVIDER_UNAVAILABLE');
      return;
    }

    unit.request.pinned = descriptor.pinned;
    const generated = await this.gateway.generate(
      ctx,
      unit.request,
      {
        channels: unit.enrichments,
        clientBrief: null,
        clientName: null,
        topicTerms: topicTerms(current.spec),
        auditLedger: unit.auditLedger,
        includeRelevantEmail: false,
      },
      credentials.creds,
    );

    const after = await this.loadCurrentCampaign(ctx, descriptor.sessionId).catch(() => null);
    const afterApproval = after
      ? await this.loadCurrentApproval(ctx, descriptor.sessionId, after.plan).catch(() => null)
      : null;
    if (!after || !isOutreachV3FullGenerationJobCurrent(descriptor, after.plan, afterApproval)) {
      await this.finishItem(
        item.id,
        'failed',
        safeGenerationResult(generated),
        'STATE_CHANGED_AFTER_GENERATION',
      );
      return;
    }

    const status = classifyGenerated(generated);
    await this.finishItem(
      item.id,
      status,
      safeGenerationResult(generated),
      status === 'failed' ? (generated.error ?? 'GENERATION_DID_NOT_PERSIST') : null,
    );
  }

  private async loadCurrentCampaign(
    ctx: TenantContext,
    sessionId: string,
  ): Promise<CurrentCampaign> {
    const row = await this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          status: string;
          currentStateVersion: number;
          specJsonb: unknown;
          specHash: string;
        }>
      >`
        SELECT
          s.status,
          s.current_state_version AS "currentStateVersion",
          v.spec_jsonb AS "specJsonb",
          v.spec_hash AS "specHash"
        FROM outreach_sessions s
        INNER JOIN outreach_state_versions v
          ON v.session_id = s.id AND v.version = s.current_state_version
        WHERE s.id = CAST(${sessionId} AS uuid)
          AND s.tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND s.created_by_user_id = CAST(${ctx.userId} AS uuid)
        LIMIT 1
      `;
      const pending = await tx.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM outreach_command_proposals
        WHERE session_id = CAST(${sessionId} AS uuid)
          AND tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND status = 'pending'
      `;
      return { session: rows[0] ?? null, pending: Number(pending[0]?.count ?? 0n) };
    });
    if (!row.session || row.session.status !== 'active')
      throw new Error('OUTREACH_SESSION_NOT_ACTIVE');

    const spec = parseCampaignSpecV1(row.session.specJsonb);
    assertOutreachContextSponsorIsolation(spec);
    if (hashCampaignSpecV1(spec) !== row.session.specHash)
      throw new Error('OUTREACH_STATE_HASH_MISMATCH');
    const readiness = deriveOutreachReadiness(spec, PHASE5_OUTREACH_FEATURE_AVAILABILITY);
    const plan = buildOutreachV3GenerationPlan({
      sessionId,
      stateVersion: row.session.currentStateVersion,
      specHash: row.session.specHash,
      spec,
      readiness,
      pendingProposalCount: row.pending,
    });
    return { spec, plan };
  }

  private async loadCurrentApproval(
    ctx: TenantContext,
    sessionId: string,
    plan: OutreachV3GenerationPlan,
  ): Promise<OutreachV3ApproachApprovalSnapshot | null> {
    const event = await this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ safeMetadataJsonb: unknown }>>`
        SELECT safe_metadata_jsonb AS "safeMetadataJsonb"
        FROM outreach_events
        WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND session_id = CAST(${sessionId} AS uuid)
          AND event_type = 'approach_approved'
        ORDER BY sequence DESC
        LIMIT 1
      `;
      return rows[0] ?? null;
    });
    if (!event) return null;
    const approval = asRecord(
      asRecord(event.safeMetadataJsonb).approval,
    ) as unknown as OutreachV3ApproachApprovalSnapshot;
    if (!isOutreachV3ApproachApprovalCurrent(plan, approval)) return null;

    const artifacts = await this.drafts.listForOutreach(ctx, sessionId);
    const currentByArtifact = new Map(
      artifacts.map((artifact) => [artifact.id, artifact.current] as const),
    );
    const samplesStillCurrent = approval.sampleVersions.every((sample) => {
      const current = currentByArtifact.get(sample.artifactId);
      return Boolean(
        current &&
        current.id === sample.versionId &&
        current.contentHash === sample.contentHash &&
        current.generationKey === sample.generationKey,
      );
    });
    return samplesStillCurrent ? approval : null;
  }

  private async existingVersionForPlan(
    ctx: TenantContext,
    descriptor: OutreachV3FullGenerationJobDescriptor,
    generationKey: string,
  ): Promise<{ status: 'done' | 'held' | 'failed'; result: Record<string, unknown> } | null> {
    const artifacts = await this.drafts.listForOutreach(ctx, descriptor.sessionId);
    const current = artifacts.find((artifact) => artifact.generationKey === generationKey)?.current;
    if (!current) return null;

    const pointer = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachDraftVersion.findFirst({
        where: { id: current.id, tenantId: ctx.tenantId },
        select: {
          contextPacketId: true,
          artifact: { select: { createdByUserId: true } },
        },
      }),
    );
    if (!pointer || pointer.artifact.createdByUserId !== ctx.userId || !pointer.contextPacketId)
      return null;

    const packet = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.contextPacket.findFirst({
        where: { id: pointer.contextPacketId!, tenantId: ctx.tenantId },
        select: { ref: true },
      }),
    );
    const ref = asRecord(packet?.ref);
    if (
      ref.outreachV3SessionId !== descriptor.sessionId ||
      ref.outreachV3PlanHash !== descriptor.planHash ||
      ref.outreachV3SpecHash !== descriptor.specHash ||
      Number(ref.outreachV3StateVersion ?? NaN) !== descriptor.stateVersion
    ) {
      return null;
    }
    const result = {
      generationKey: current.generationKey,
      artifactId: current.artifactId,
      versionId: current.id,
      version: current.version,
      generationStatus: current.generationStatus,
      auditStatus: current.auditStatus,
      approvalStatus: current.approvalStatus,
      contextNote: current.contextNote ?? null,
    };
    if (current.generationStatus === 'generation_failed') return { status: 'failed', result };
    if (['held', 'pending', 'unavailable'].includes(current.auditStatus))
      return { status: 'held', result };
    return { status: 'done', result };
  }

  private async claimBatch(
    jobId: string,
    limit: number,
  ): Promise<Array<{ id: string; generationKey: string }>> {
    return this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; generation_key: string }>>`
        UPDATE outreach_job_items SET
          status = 'claimed',
          claimed_at = NOW(),
          attempt = attempt + 1,
          updated_at = NOW()
        WHERE id IN (
          SELECT i.id
          FROM outreach_job_items i
          INNER JOIN outreach_jobs j ON j.id = i.job_id
          WHERE i.job_id = CAST(${jobId} AS uuid)
            AND i.status = 'pending'
            AND j.status IN ('queued', 'running')
            AND j.kind = ${OUTREACH_V3_FULL_GENERATION_JOB_KIND}
          ORDER BY i.created_at
          LIMIT ${limit}
          FOR UPDATE OF i SKIP LOCKED
        )
        RETURNING id, recipient_key AS generation_key
      `;
      return rows.map((row) => ({ id: row.id, generationKey: row.generation_key }));
    });
  }

  private async finishItem(
    itemId: string,
    status: 'done' | 'held' | 'failed' | 'skipped',
    result: Record<string, unknown> | null,
    error: string | null,
  ): Promise<void> {
    await this.prisma.withSystem((tx) =>
      tx.outreachJobItem.updateMany({
        where: { id: itemId, status: { in: ['claimed', 'generating'] } },
        data: {
          status,
          result: result ? (result as Prisma.InputJsonValue) : undefined,
          error: error ? error.slice(0, 500) : null,
        },
      }),
    );
  }

  private async failWholeJob(jobId: string, error: string): Promise<void> {
    await this.prisma.withSystem(async (tx) => {
      await tx.outreachJobItem.updateMany({
        where: { jobId, status: { in: ['pending', 'claimed', 'generating'] } },
        data: { status: 'failed', error },
      });
      await tx.outreachJob.updateMany({
        where: { id: jobId, status: { not: 'canceled' } },
        data: { status: 'failed', finishedAt: new Date() },
      });
    });
  }

  private async finalizeJob(jobId: string): Promise<void> {
    await this.prisma.withSystem(async (tx) => {
      const job = await tx.outreachJob.findFirst({
        where: { id: jobId },
        select: { status: true },
      });
      if (!job || job.status === 'canceled') return;
      const items = await tx.outreachJobItem.findMany({
        where: { jobId },
        select: { status: true },
      });
      const totals = rollup(items.map((item) => item.status));
      const terminal = totals.queued === 0;
      const status = !terminal
        ? 'running'
        : totals.failed === 0 && totals.held === 0
          ? 'complete'
          : totals.succeeded === 0 && totals.held === 0
            ? 'failed'
            : 'partial';
      await tx.outreachJob.updateMany({
        where: { id: jobId, status: { not: 'canceled' } },
        data: {
          status,
          totals: totals as Prisma.InputJsonValue,
          ...(terminal ? { finishedAt: new Date() } : {}),
        },
      });
    });
  }

  private async reclaimStaleClaims(): Promise<void> {
    const cutoff = new Date(Date.now() - this.staleMs);
    const reclaimed = await this.prisma.withSystem((tx) =>
      tx.outreachJobItem.updateMany({
        where: {
          status: { in: ['claimed', 'generating'] },
          claimedAt: { lt: cutoff },
          job: {
            kind: OUTREACH_V3_FULL_GENERATION_JOB_KIND,
            status: { in: ['queued', 'running'] },
          },
        },
        data: { status: 'pending', claimedAt: null, error: null },
      }),
    );
    if (reclaimed.count > 0) {
      this.logger.warn(`Reclaimed ${reclaimed.count} stale V3 full-generation item(s)`);
    }
  }
}

function classifyGenerated(result: GenerationResult): 'done' | 'held' | 'failed' {
  if (!result.versionId || !result.artifactId) return 'failed';
  if (result.generationStatus === 'generation_failed') return 'failed';
  if (['held', 'pending', 'unavailable'].includes(String(result.auditStatus ?? ''))) return 'held';
  return 'done';
}

function safeGenerationResult(result: GenerationResult): Record<string, unknown> {
  return {
    generationKey: result.generationKey,
    ...(result.artifactId ? { artifactId: result.artifactId } : {}),
    ...(result.versionId ? { versionId: result.versionId } : {}),
    ...(result.version != null ? { version: result.version } : {}),
    ...(result.generationStatus ? { generationStatus: result.generationStatus } : {}),
    ...(result.auditStatus ? { auditStatus: result.auditStatus } : {}),
    ...(result.approvalStatus ? { approvalStatus: result.approvalStatus } : {}),
    ...(result.contextNote ? { contextNote: result.contextNote } : {}),
    manifest: result.manifest,
  };
}

function rollup(statuses: readonly string[]) {
  let queued = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let held = 0;
  for (const status of statuses) {
    if (['pending', 'claimed', 'generating'].includes(status)) queued++;
    else if (status === 'done') succeeded++;
    else if (status === 'failed') failed++;
    else if (status === 'skipped') skipped++;
    else if (status === 'held') held++;
  }
  return { queued, succeeded, failed, skipped, held, total: statuses.length };
}

function workerContext(tenantId: string, userId: string): TenantContext {
  return {
    tenantId,
    tenantSlug: '',
    userId,
    clerkUserId: '',
    role: 'standard_user',
  };
}

function topicTerms(spec: OutreachCampaignSpecV1): string[] {
  return [
    ...new Set(
      [spec.goal.topic, spec.goal.goal, spec.goal.objective, spec.goal.ask.text]
        .filter((value): value is string => Boolean(value?.trim()))
        .flatMap((value) => value.split(/[^A-Za-z0-9_.-]+/gu))
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length >= 3),
    ),
  ]
    .sort()
    .slice(0, 32);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function boundedPositiveInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid bounded integer value: ${raw}`);
  }
  return parsed;
}
