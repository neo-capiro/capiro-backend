/** Canonical Outreach job state. SDK execution is owned by Meri; send compatibility remains. */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  HttpException,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  EngagementService,
  type OutreachRecipientInput,
  type SendBatchEmailInput,
} from './engagement.service.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';

export type OutreachJobKind = 'generate' | 'send';

export interface SubmitOutreachJobInput {
  requestKey: string;
  kind: OutreachJobKind;
  /** GenerateBatchEmailInput minus recipients (generate), or send params. */
  params: Record<string, unknown>;
  /** One entry per recipient; each becomes an outreach_job_item. */
  recipients: Array<Record<string, unknown>>;
  outreachRecordId?: string | null;
}

/**
 * Terminal + in-flight item statuses.
 *
 * 'held' is TERMINAL (Phase 0 §3.c3): a draft the grounding auditor held is
 * finished as far as the worker is concerned — it needs a reviewer or a new
 * edited version, and re-running generation would neither clear the finding nor
 * make the draft safe to auto-send.
 */
const TERMINAL_ITEM = new Set(['done', 'sent', 'failed', 'skipped', 'held', 'unknown']);

interface RollupInput {
  status: string;
}

/**
 * Pure job rollup: derive the job status + totals from its items. Exported for
 * unit tests (the state machine is the part most worth pinning).
 *
 * `held` counts separately from both success and failure: nothing went wrong,
 * but nothing is sendable either, so a job with held items never rolls up to
 * 'complete'.
 */
export function computeJobRollup(items: RollupInput[]): {
  status: 'queued' | 'running' | 'partial' | 'complete' | 'failed';
  totals: {
    queued: number;
    succeeded: number;
    failed: number;
    skipped: number;
    held: number;
    total: number;
  };
} {
  const total = items.length;
  let queued = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let held = 0;
  for (const it of items) {
    if (
      it.status === 'pending' || it.status.startsWith('sdk_') ||
      it.status === 'claimed' ||
      it.status === 'generating' ||
      it.status === 'sending'
    )
      queued++;
    else if (it.status === 'done' || it.status === 'sent') succeeded++;
    else if (it.status === 'failed' || it.status === 'unknown') failed++;
    else if (it.status === 'skipped') skipped++;
    else if (it.status === 'held') held++;
  }
  const totals = { queued, succeeded, failed, skipped, held, total };
  const allTerminal = items.every((it) => TERMINAL_ITEM.has(it.status));
  let status: 'queued' | 'running' | 'partial' | 'complete' | 'failed';
  if (!allTerminal) {
    status = succeeded > 0 || failed > 0 || held > 0 ? 'running' : 'queued';
  } else if (failed === 0 && held === 0) {
    status = 'complete';
  } else if (succeeded === 0 && skipped === 0 && held === 0) {
    status = 'failed';
  } else {
    // Some drafts exist but at least one is held or failed — a human must act.
    status = 'partial';
  }
  return { status, totals };
}

/**
 * Map ONE generation result onto its job-item status.
 *
 * Understands both shapes: the Phase 0 versioned result (authoritative audit and
 * approval lifecycle fields) and the pre-Phase-0 `status` string, so the worker
 * is correct with ENGAGEMENT_VERSIONED_OUTREACH either way.
 *
 * Fails CLOSED: a missing result, an unrecognized shape, or any non-sendable
 * audit state resolves to failed/held — never 'done'. Exported for unit tests.
 */
export function classifyGenerationItem(result: unknown): 'done' | 'held' | 'failed' {
  if (!result || typeof result !== 'object') return 'failed';
  const r = result as Record<string, unknown>;

  // Phase 0 versioned shape — the lifecycle fields are authoritative.
  if (typeof r.versionId === 'string' || typeof r.auditStatus === 'string') {
    if (r.generationStatus === 'generation_failed') return 'failed';
    const audit = String(r.auditStatus ?? '');
    const approval = String(r.approvalStatus ?? '');
    if (audit === 'held' || audit === 'pending' || audit === 'unavailable') return 'held';
    if (approval === 'pending' || approval === 'rejected') return 'held';
    if (audit === 'not_required' || audit === 'passed' || audit === 'warning') return 'done';
    return 'failed';
  }

  // Pre-Phase-0 shape.
  if (r.status === 'ready') return 'done';
  if (r.status === 'held') return 'held';
  return 'failed';
}

/** Fields safe to persist in outreach_job_items.result_jsonb. */
const ITEM_RESULT_FIELDS = [
  'versionId',
  'artifactId',
  'version',
  'generationKey',
  'generationStatus',
  'auditStatus',
  'approvalStatus',
  'reviewRequestId',
  'contextNote',
  // Phase 1 §3.k4 / §5.5 — an async result must keep its packet, policy and
  // provider identity, or the Context Used panel goes blank for exactly the
  // large campaigns that most need provenance. The manifest is summaries only
  // (ids, titles, counts, dates) — it carries no restricted email or document
  // content, so it is safe in this column.
  'manifest',
  // Phase e §e4 — a regeneration the server persisted as a non-current
  // candidate (isCandidate/baseVersion) must keep that status once stored as
  // a job item, or the wizard cannot tell it apart from a normal generation
  // and would overwrite the user's manually-authored draft.
  'isCandidate',
  'baseVersion',
] as const;

/**
 * Project a generation result into the job item's stored result.
 *
 * Keeps the REAL subject/body (a held draft must stay readable) plus the version
 * metadata the wizard needs to look the version up, and deliberately drops
 * `error` and anything else not on the allowlist so no auditor internals or
 * provider stack reaches the client through this column. Exported for tests.
 */
export function buildItemResult(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  const out: Record<string, unknown> = {
    subject: typeof r.subject === 'string' ? r.subject : '',
    body: typeof r.body === 'string' ? r.body : '',
  };
  for (const key of ITEM_RESULT_FIELDS) {
    const value = r[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out;
}

/** Stable recipient key mirroring the frontend/generateBatchEmails id chain. */
export function outreachRecipientKey(recipient: Record<string, unknown>, index: number): string {
  return (
    (recipient.id as string | undefined) ||
    (recipient.directoryContactId as string | undefined) ||
    (recipient.email as string | undefined) ||
    (recipient.name as string | undefined) ||
    `idx-${index}`
  );
}



@Injectable()
export class OutreachJobService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutreachJobService.name);
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private readonly asyncSend: boolean;
  private readonly sweepMs: number;
  private readonly sdkConcurrency: number;
  private readonly versionedOutreach: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
    config: ConfigService<AppConfig, true>,
    private readonly runtimePolicy: EngagementRuntimePolicyService,
  ) {
    this.asyncSend = config.get('OUTREACH_ASYNC_SEND', { infer: true });
    this.sweepMs = config.get('OUTREACH_JOB_SWEEP_MS', { infer: true });
    this.sdkConcurrency = config.get('OUTREACH_V3_GENERATION_CONCURRENCY', { infer: true });
    this.versionedOutreach = config.get('ENGAGEMENT_VERSIONED_OUTREACH', { infer: true });
  }

  /** Whether the async path is enabled for a given kind (controller gate). */
  asyncEnabled(kind: OutreachJobKind): boolean {
    return kind === 'send' ? this.asyncSend : false;
  }

  onModuleInit(): void {
    // Engagement API Phase 1 — fail-closed runtime policy check.
    if (!this.runtimePolicy.backgroundWorkersEnabled()) {
      this.logger.log(
        'outreach-job-worker disabled by runtime policy ' +
          `(service=${this.runtimePolicy.snapshot().serviceName} ` +
          `owner=${this.runtimePolicy.snapshot().backgroundOwner})`,
      );
      return;
    }
    // Only spin the worker when at least one async path is enabled.
    if (!this.asyncSend) return;
    this.timer = setInterval(() => {
      if (this.sweeping) return; // overlap-skip: a slow job must not stack ticks
      this.sweeping = true;
      this.tick()
        .catch((err) => this.logger.error(`outreach job sweep failed: ${(err as Error).message}`))
        .finally(() => {
          this.sweeping = false;
        });
    }, this.sweepMs);
    this.timer.unref?.();
    this.logger.log(
      `outreach job worker started (send=${this.asyncSend} every ${this.sweepMs}ms)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── Submit / read / cancel (request-path API) ────────────────────────────

  /**
   * Idempotent submit: insert the job + one item per recipient in ONE tx. A
   * duplicate (tenant, requestKey) returns the EXISTING job and inserts nothing
   * (the unique index + ON CONFLICT), so a retried POST never double-fans-out.
   */
  async submit(
    ctx: TenantContext,
    input: SubmitOutreachJobInput,
  ): Promise<{ jobId: string; deduped: boolean }> {
    // Engagement API Phase 1 — assert external action before creating a job.
    if (input.kind === 'generate') {
      this.runtimePolicy.assertExternalAction('outreach_generate');
    } else {
      this.runtimePolicy.assertExternalAction('outreach_send');
    }
    this.assertSendJobAllowed(input.kind);
    if (!input.recipients.length) {
      return this.submitEmpty(ctx, input);
    }

    if (input.kind === 'generate' && input.params.executionOwner !== 'claude-agent-sdk') throw new BadRequestException('Use the saved Outreach campaign workflow');

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (input.kind === 'generate') {
        if (!input.outreachRecordId) throw new BadRequestException('Saved campaign is required');
        await tx.$queryRaw`SELECT id FROM outreach_records WHERE id=${input.outreachRecordId}::uuid AND tenant_id=${ctx.tenantId}::uuid FOR UPDATE`;
        const campaign = await tx.outreachRecord.findFirst({ where: { id: input.outreachRecordId, tenantId: ctx.tenantId, createdByUserId: ctx.userId, deletedAt: null, status: 'draft' }, select: { metadata: true } });
        const revision = ((campaign?.metadata as Record<string, unknown> | null)?.workflow as { revision?: number } | undefined)?.revision;
        if (revision !== input.params.revision) throw new ConflictException('Campaign changed before generation was requested');
      }
      // Phase 0 §3.c3: idempotency is per (tenant, USER, requestKey). Scoping it
      // to the tenant alone meant two users who minted the same client-side key
      // resolved to each other's job — a cross-user read of drafts and
      // recipients through a guessable token.
      const existing = await tx.outreachJob.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, requestKey: input.requestKey },
        select: { id: true, kind: true, outreachRecordId: true, params: true },
      });
      if (existing) {
        if (input.kind === 'generate' && (existing.kind !== input.kind || existing.outreachRecordId !== input.outreachRecordId || !isDeepStrictEqual(existing.params, input.params)))
          throw new ConflictException('Generation request key is already bound to another saved request');
        return { jobId: existing.id, deduped: true };
      }

      const job = await tx.outreachJob.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          kind: input.kind,
          outreachRecordId: input.outreachRecordId ?? null,
          // Phase 1 §3.k2 — the pinned identity rides in params, resolved ONCE
          // before the job was created (see submitGenerate). Every claimed chunk
          // reads it back out, so a 200-recipient campaign spread over many sweeps
          // cannot drift onto a second provider or model.
          params: {
            ...(input.params as object),
          } as object,
          status: 'queued',
          totals: {
            queued: input.recipients.length,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            total: input.recipients.length,
          },
          requestKey: input.requestKey,
        },
        select: { id: true },
      });

      // Deduplicate recipientKeys within the job (the unique index would reject a
      // dup anyway; collapsing keeps one item per recipient — keep-first).
      const seen = new Set<string>();
      const rows: Array<{
        tenantId: string;
        jobId: string;
        recipientKey: string;
        payload: object;
        status?: string;
      }> = [];
      input.recipients.forEach((r, i) => {
        const key = outreachRecipientKey(r, i);
        if (seen.has(key)) return;
        seen.add(key);
        // Pin payload.id = key so generateBatchEmails' id-first chain round-trips
        // to the same recipientKey when the worker maps results back.
        rows.push({
          tenantId: ctx.tenantId,
          jobId: job.id,
          recipientKey: key,
          payload: { ...r, id: key },
          ...(input.params.executionOwner === 'claude-agent-sdk' ? { status: 'sdk_pending' } : {}),
        });
      });
      await tx.outreachJobItem.createMany({ data: rows });
      return { jobId: job.id, deduped: false };
    });
  }

  private async submitEmpty(
    ctx: TenantContext,
    input: SubmitOutreachJobInput,
  ): Promise<{ jobId: string; deduped: boolean }> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.outreachJob.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, requestKey: input.requestKey },
        select: { id: true },
      });
      if (existing) return { jobId: existing.id, deduped: true };
      const job = await tx.outreachJob.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          kind: input.kind,
          params: input.params as object,
          status: 'complete',
          totals: { queued: 0, succeeded: 0, failed: 0, skipped: 0, total: 0 },
          requestKey: input.requestKey,
          finishedAt: new Date(),
        },
        select: { id: true },
      });
      return { jobId: job.id, deduped: false };
    });
  }

  /**
   * Read one job the CALLER owns. Owner-scoped as well as tenant-scoped (§3.c3):
   * `submit()` has always stored userId, but reads only checked the tenant, so
   * any colleague's job id exposed their recipients and drafts.
   *
   * Held items keep their version metadata in `result` but their `error` column
   * is never surfaced raw — a hold is not an error and must not leak auditor
   * internals to the wizard.
   */
  async getJob(ctx: TenantContext, jobId: string) {
    const result = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const job = await tx.outreachJob.findFirst({
        where: { id: jobId, tenantId: ctx.tenantId, userId: ctx.userId },
      });
      if (!job) return null;
      const params = job.params as Record<string, unknown>;
      const savedClient = (params.state as { clientId?: string | null } | undefined)?.clientId;
      if (params.executionOwner === 'claude-agent-sdk' && savedClient) {
        const client = await tx.client.findFirst({ where: { id: savedClient, tenantId: ctx.tenantId, status: { not: 'archived' } }, select: { id: true } });
        if (!client || !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, savedClient))) throw new NotFoundException('Outreach job not found');
      }
      const items = await tx.outreachJobItem.findMany({
        where: { jobId, tenantId: ctx.tenantId },
        orderBy: { createdAt: 'asc' },
        // `id` is exposed so the wizard can address a single failed item for retry.
        select: {
          id: true,
          recipientKey: true,
          status: true,
          result: true,
          error: true,
          attempt: true,
        },
      });
      return {
        job,
        items: items.map((it) => (it.status === 'held' ? { ...it, error: null } : it)),
      };
    });
    if (result?.job.outreachRecordId && (result.job.params as Record<string, unknown>).executionOwner === 'claude-agent-sdk') await this.engagement.getOutreachRecord(ctx, result.job.outreachRecordId);
    return result;
  }

  /** Existing job/items own SDK progress; the classic sweep never claims sdk_* items. */
  async getSdkUnit(ctx: TenantContext, jobId: string, itemId: string) {
    const unit = await this.prisma.withTenant(ctx.tenantId, async tx => {
      const job = await tx.outreachJob.findFirst({ where: { id: jobId, tenantId: ctx.tenantId, userId: ctx.userId, kind: 'generate' } });
      const item = job && await tx.outreachJobItem.findFirst({ where: { id: itemId, jobId, tenantId: ctx.tenantId } });
      return job && item ? { job, item } : null;
    });
    if (!unit || (unit.job.params as Record<string, unknown>).executionOwner !== 'claude-agent-sdk') throw new NotFoundException('Outreach unit not found');
    if (unit.job.status === 'canceled') throw new ConflictException('Outreach generation was canceled');
    return unit;
  }

  async bindSdkUnit(ctx: TenantContext, jobId: string, itemId: string, binding: Record<string, unknown>) {
    await this.getSdkUnit(ctx, jobId, itemId);
    return this.prisma.withTenant(ctx.tenantId, async tx => {
      await tx.$queryRaw`SELECT id FROM tenants WHERE id=${ctx.tenantId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM outreach_jobs WHERE id=${jobId}::uuid AND tenant_id=${ctx.tenantId}::uuid FOR UPDATE`;
      const job = await tx.outreachJob.findFirstOrThrow({ where: { id: jobId, tenantId: ctx.tenantId, userId: ctx.userId } });
      if (job.status === 'canceled') throw new ConflictException('Outreach generation was canceled');
      await tx.$queryRaw`SELECT id FROM outreach_job_items WHERE id=${itemId}::uuid AND tenant_id=${ctx.tenantId}::uuid FOR UPDATE`;
      const item = await tx.outreachJobItem.findFirstOrThrow({ where: { id: itemId, jobId, tenantId: ctx.tenantId } });
      const payload = item.payload as Record<string, unknown>;
      if (TERMINAL_ITEM.has(item.status)) throw new ConflictException('Outreach unit is terminal');
      if (payload.sdk) return payload.sdk as Record<string, unknown>;
      const active = await tx.outreachJobItem.count({ where: { tenantId: ctx.tenantId, status: { in: ['sdk_running', 'sdk_completing'] }, job: { status: { not: 'canceled' } } } });
      if (active >= this.sdkConcurrency) throw new HttpException('Outreach generation capacity is busy. Wait for active units to finish.', 429);
      if (item.status !== 'sdk_pending') throw new ConflictException('Outreach unit is already terminal');
      await tx.outreachJobItem.update({ where: { id: itemId }, data: { status: 'sdk_running', claimedAt: new Date(),
        attempt: { increment: 1 }, payload: { ...payload, sdk: binding } as object } });
      await tx.outreachJob.updateMany({ where: { id: jobId, tenantId: ctx.tenantId, userId: ctx.userId, status: { not: 'canceled' } }, data: { status: 'running', startedAt: new Date() } });
      return binding;
    });
  }

  async beginSdkCompletion(ctx: TenantContext, jobId: string, itemId: string): Promise<boolean> {
    await this.getSdkUnit(ctx, jobId, itemId);
    return this.prisma.withTenant(ctx.tenantId, async tx => {
      const changed = await tx.outreachJobItem.updateMany({ where: { id: itemId, jobId, tenantId: ctx.tenantId, status: 'sdk_running' }, data: { status: 'sdk_completing' } });
      return changed.count === 1;
    });
  }

  async finishSdkUnit(ctx: TenantContext, jobId: string, itemId: string, status: 'done' | 'held' | 'failed' | 'unknown', result: object | null, error: string | null) {
    await this.getSdkUnit(ctx, jobId, itemId);
    await this.prisma.withTenant(ctx.tenantId, tx => tx.outreachJobItem.updateMany({
      where: { id: itemId, jobId, tenantId: ctx.tenantId, status: { in: ['sdk_pending', 'sdk_running', 'sdk_completing'] } },
      data: { status, result: result ?? undefined, error },
    }));
    await this.finalizeJob(jobId);
  }

  /** Cancel: unclaimed (pending) items → skipped; job → canceled if not terminal. */
  async cancelJob(ctx: TenantContext, jobId: string): Promise<{ canceled: boolean }> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM outreach_jobs WHERE id=${jobId}::uuid AND tenant_id=${ctx.tenantId}::uuid FOR UPDATE`;
      const job = await tx.outreachJob.findFirst({
        where: { id: jobId, tenantId: ctx.tenantId, userId: ctx.userId },
        select: { id: true, status: true },
      });
      if (!job) return { canceled: false };
      if (['complete', 'failed', 'canceled'].includes(job.status)) return { canceled: false };
      await tx.outreachJobItem.updateMany({
        where: { jobId, tenantId: ctx.tenantId, status: { in: ['pending', 'sdk_pending'] } },
        data: { status: 'skipped' },
      });
      await tx.outreachJob.update({
        where: { id: jobId },
        data: { status: 'canceled', finishedAt: new Date() },
      });
      return { canceled: true };
    });
  }

  // ── Worker ───────────────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    this.runtimePolicy.assertBackgroundOwner('outreach-job-worker');
    const jobId = await this.findRunnableJobId();
    if (jobId) await this.processJob(jobId);
  }

  /** Oldest job that still has pending items in an async-enabled kind. */
  private async findRunnableJobId(): Promise<string | null> {
    const kinds: OutreachJobKind[] = [];
    if (this.asyncSend) kinds.push('send');
    if (!kinds.length) return null;
    return this.prisma.withSystem(async (tx) => {
      const job = await tx.outreachJob.findFirst({
        where: {
          status: { in: ['queued', 'running'] },
          kind: { in: kinds },
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
        where: { id: jobId },
        select: { id: true, tenantId: true, userId: true, kind: true, params: true, status: true },
      }),
    );
    if (!job) return;

    if (job.status === 'queued') {
      await this.prisma.withSystem((tx) =>
        tx.outreachJob.updateMany({
          where: { id: jobId, status: 'queued' },
          data: { status: 'running', startedAt: new Date() },
        }),
      );
    }

    const ctx = this.workerContext(job.tenantId, job.userId);
    if (job.kind === 'send') {
      await this.processSendItems(jobId, ctx, job.params as Record<string, unknown>);
    }
    await this.finalizeJob(jobId);
  }

  /**
   * Send job: strict AT-MOST-ONCE. Each item is flipped pending → 'sending'
   * BEFORE the Graph call (a conditional update that exactly one worker wins);
   * on success → 'sent', on failure → 'failed'. Items left in 'sending' after a
   * crash are NEVER auto-reclaimed (reclaimStale skips send) — getJob surfaces
   * them as "unknown, verify in Sent Items" so the human confirms rather than
   * risking a duplicate send. Sends run sequentially with light pacing.
   */
  private async processSendItems(
    jobId: string,
    ctx: TenantContext,
    params: Record<string, unknown>,
  ): Promise<void> {
    for (;;) {
      // Fetch the next pending item id (read then conditional claim — the claim
      // is the atomic gate, so two workers reading the same id is safe).
      const next = await this.prisma.withSystem((tx) =>
        tx.outreachJobItem.findFirst({
          where: { jobId, status: 'pending' },
          orderBy: { createdAt: 'asc' },
          select: { id: true, recipientKey: true, payload: true },
        }),
      );
      if (!next) break;

      // Flip pending → sending; if we didn't win the row, another worker has it.
      const claimed = await this.prisma.withSystem((tx) =>
        tx.outreachJobItem.updateMany({
          where: { id: next.id, status: 'pending' },
          data: { status: 'sending', claimedAt: new Date(), attempt: { increment: 1 } },
        }),
      );
      if (claimed.count === 0) continue;

      const payload = (next.payload ?? {}) as Record<string, unknown>;
      try {
        const input = this.buildSendInput(params, next.recipientKey, payload);
        const res = await this.engagement.sendBatchEmails(ctx, input);
        const ok = (res.sent ?? 0) >= 1 && (res.errors?.length ?? 0) === 0;
        await this.setItem(
          next.id,
          ok ? 'sent' : 'failed',
          ok ? { sentAt: new Date().toISOString() } : null,
          ok ? null : (res.errors?.[0]?.message ?? 'send failed'),
        );
      } catch (err) {
        await this.setItem(next.id, 'failed', null, (err as Error).message ?? 'send failed');
      }
      // Gentle pacing (~1.5/sec) to stay well under Graph limits.
      await this.sleep(650);
    }
  }

  private buildSendInput(
    params: Record<string, unknown>,
    recipientKey: string,
    payload: Record<string, unknown>,
  ): SendBatchEmailInput {
    const { subject, body, ...recipient } = payload as {
      subject?: string;
      body?: string;
    } & Record<string, unknown>;
    return {
      ...(params as Partial<SendBatchEmailInput>),
      recipients: [recipient as unknown as OutreachRecipientInput],
      drafts: [{ recipientId: recipientKey, subject: subject ?? '', body: body ?? '' }],
      testMode: false,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async setItem(
    itemId: string,
    status: string,
    result: object | null,
    error: string | null,
  ): Promise<void> {
    await this.prisma.withSystem((tx) =>
      tx.outreachJobItem.update({
        where: { id: itemId },
        data: { status, result: result ?? undefined, error: error ?? null },
      }),
    );
  }

  /**
   * Roll the job up from its items.
   *
   * CANCEL IS TERMINAL (§3.c3): the update is guarded on `status != 'canceled'`
   * via updateMany, so a sweep that was mid-flight when the user cancelled can
   * never resurrect the job as complete/partial. Before this guard, a cancel
   * raced by an in-progress batch silently lost.
   */
  private async finalizeJob(jobId: string): Promise<void> {
    await this.prisma.withSystem(async (tx) => {
      const items = await tx.outreachJobItem.findMany({
        where: { jobId },
        select: { status: true },
      });
      const { status, totals } = computeJobRollup(items);
      const done = status === 'complete' || status === 'partial' || status === 'failed';
      await tx.outreachJob.updateMany({
        where: { id: jobId, status: { not: 'canceled' } },
        data: { status, totals, ...(done ? { finishedAt: new Date() } : {}) },
      });
    });
  }

  /**
   * Legacy async SEND jobs are refused once versioned outreach is on (§3.c3):
   * they carry raw caller subject/body in the item payload, which is exactly the
   * bypass durable send intents exist to close. Generation jobs are unaffected.
   */
  private assertSendJobAllowed(kind: OutreachJobKind): void {
    if (kind === 'send' && this.versionedOutreach) {
      throw new BadRequestException('Legacy async send is disabled; use send intents');
    }
  }

  private workerContext(tenantId: string, userId: string | null): TenantContext {
    // Minimal context for the tenant-scoped work the generator does (RLS +
    // own-user scoping). slug/clerkId aren't used on this path.
    return {
      tenantId,
      tenantSlug: '',
      userId: userId ?? '',
      clerkUserId: '',
      role: 'standard_user',
    } as TenantContext;
  }
}
