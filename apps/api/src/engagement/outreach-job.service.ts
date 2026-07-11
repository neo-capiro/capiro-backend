/**
 * OutreachJobService — async outreach pipeline worker + API (plan W4 / §3.3).
 *
 * The wizard POSTs a job (generate or send); this service persists it + one item
 * per recipient and returns in ms. A claim-sweep worker (setInterval, notetaker
 * shape) then drives jobs to completion OFF the request path — past the ~175s ALB
 * idle ceiling that made large synchronous campaigns time out.
 *
 * Coordination is ITEM-LEVEL atomic claims (`FOR UPDATE SKIP LOCKED`), not a
 * job-level lock: that is pool-safe (advisory locks don't survive across pooled
 * transactions) AND multi-replica-correct — each item is claimed by exactly one
 * worker regardless of how many replicas pick the same job. Generation is
 * at-least-once (regenerating a draft is harmless); a stuck-claimed generation
 * item is reclaimed after OUTREACH_JOB_STALE_MS. (Send's at-most-once handling
 * lands in W4.3.)
 */
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  EngagementService,
  type GenerateBatchEmailInput,
  type OutreachRecipientInput,
  type SendBatchEmailInput,
} from './engagement.service.js';

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

/** Terminal + in-flight item statuses. */
const TERMINAL_ITEM = new Set(['done', 'sent', 'failed', 'skipped']);

interface RollupInput {
  status: string;
}

/**
 * Pure job rollup: derive the job status + totals from its items. Exported for
 * unit tests (the state machine is the part most worth pinning).
 */
export function computeJobRollup(items: RollupInput[]): {
  status: 'queued' | 'running' | 'partial' | 'complete' | 'failed';
  totals: { queued: number; succeeded: number; failed: number; skipped: number; total: number };
} {
  const total = items.length;
  let queued = 0;
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const it of items) {
    if (
      it.status === 'pending' ||
      it.status === 'claimed' ||
      it.status === 'generating' ||
      it.status === 'sending'
    )
      queued++;
    else if (it.status === 'done' || it.status === 'sent') succeeded++;
    else if (it.status === 'failed') failed++;
    else if (it.status === 'skipped') skipped++;
  }
  const totals = { queued, succeeded, failed, skipped, total };
  const allTerminal = items.every((it) => TERMINAL_ITEM.has(it.status));
  let status: 'queued' | 'running' | 'partial' | 'complete' | 'failed';
  if (!allTerminal) {
    status = succeeded > 0 || failed > 0 ? 'running' : 'queued';
  } else if (failed === 0) {
    status = 'complete';
  } else if (succeeded === 0 && skipped === 0) {
    status = 'failed';
  } else {
    status = 'partial';
  }
  return { status, totals };
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

const GEN_CLAIM_BATCH = 25;

@Injectable()
export class OutreachJobService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutreachJobService.name);
  private timer?: ReturnType<typeof setInterval>;
  private sweeping = false;
  private readonly asyncGen: boolean;
  private readonly asyncSend: boolean;
  private readonly sweepMs: number;
  private readonly staleMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly engagement: EngagementService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.asyncGen = config.get('OUTREACH_ASYNC_GEN', { infer: true });
    this.asyncSend = config.get('OUTREACH_ASYNC_SEND', { infer: true });
    this.sweepMs = config.get('OUTREACH_JOB_SWEEP_MS', { infer: true });
    this.staleMs = config.get('OUTREACH_JOB_STALE_MS', { infer: true });
  }

  /** Whether the async path is enabled for a given kind (controller gate). */
  asyncEnabled(kind: OutreachJobKind): boolean {
    return kind === 'send' ? this.asyncSend : this.asyncGen;
  }

  onModuleInit(): void {
    // Only spin the worker when at least one async path is enabled.
    if (!this.asyncGen && !this.asyncSend) return;
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
      `outreach job worker started (gen=${this.asyncGen} send=${this.asyncSend} every ${this.sweepMs}ms)`,
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
    if (!input.recipients.length) {
      return this.submitEmpty(ctx, input);
    }
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.outreachJob.findFirst({
        where: { tenantId: ctx.tenantId, requestKey: input.requestKey },
        select: { id: true },
      });
      if (existing) return { jobId: existing.id, deduped: true };

      const job = await tx.outreachJob.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          kind: input.kind,
          outreachRecordId: input.outreachRecordId ?? null,
          params: input.params as object,
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
        where: { tenantId: ctx.tenantId, requestKey: input.requestKey },
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

  async getJob(ctx: TenantContext, jobId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const job = await tx.outreachJob.findFirst({ where: { id: jobId, tenantId: ctx.tenantId } });
      if (!job) return null;
      const items = await tx.outreachJobItem.findMany({
        where: { jobId, tenantId: ctx.tenantId },
        orderBy: { createdAt: 'asc' },
        select: { recipientKey: true, status: true, result: true, error: true, attempt: true },
      });
      return { job, items };
    });
  }

  /** Cancel: unclaimed (pending) items → skipped; job → canceled if not terminal. */
  async cancelJob(ctx: TenantContext, jobId: string): Promise<{ canceled: boolean }> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const job = await tx.outreachJob.findFirst({
        where: { id: jobId, tenantId: ctx.tenantId },
        select: { id: true, status: true },
      });
      if (!job) return { canceled: false };
      if (['complete', 'failed', 'canceled'].includes(job.status)) return { canceled: false };
      await tx.outreachJobItem.updateMany({
        where: { jobId, tenantId: ctx.tenantId, status: 'pending' },
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
    await this.reclaimStale();
    const jobId = await this.findRunnableJobId();
    if (jobId) await this.processJob(jobId);
  }

  /** Oldest job that still has pending items in an async-enabled kind. */
  private async findRunnableJobId(): Promise<string | null> {
    const kinds: OutreachJobKind[] = [];
    if (this.asyncGen) kinds.push('generate');
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
    } else {
      // Generation: process pending items in claimed batches until none remain
      // (or a claim yields nothing — another replica took them).
      for (;;) {
        const batch = await this.claimGenerationBatch(jobId, GEN_CLAIM_BATCH);
        if (!batch.length) break;
        await this.runGenerationBatch(ctx, job.params as Record<string, unknown>, batch);
      }
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

  /** Atomically claim a batch of pending generation items (pool + replica safe). */
  private async claimGenerationBatch(
    jobId: string,
    limit: number,
  ): Promise<Array<{ id: string; recipientKey: string; payload: Record<string, unknown> }>> {
    return this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRawUnsafe<
        Array<{ id: string; recipient_key: string; payload_jsonb: Record<string, unknown> }>
      >(
        `UPDATE outreach_job_items SET status='claimed', claimed_at=NOW(), attempt=attempt+1, updated_at=NOW()
         WHERE id IN (
           SELECT id FROM outreach_job_items
           WHERE job_id=$1 AND status='pending'
           ORDER BY created_at LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         RETURNING id, recipient_key, payload_jsonb`,
        jobId,
        limit,
      );
      return rows.map((r) => ({
        id: r.id,
        recipientKey: r.recipient_key,
        payload: r.payload_jsonb,
      }));
    });
  }

  private async runGenerationBatch(
    ctx: TenantContext,
    params: Record<string, unknown>,
    batch: Array<{ id: string; recipientKey: string; payload: Record<string, unknown> }>,
  ): Promise<void> {
    const input: GenerateBatchEmailInput = {
      ...(params as unknown as GenerateBatchEmailInput),
      recipients: batch.map((b) => b.payload as unknown as OutreachRecipientInput),
    };
    try {
      const { results } = await this.engagement.generateBatchEmails(ctx, input);
      const byKey = new Map(results.map((r) => [r.recipientId, r]));
      for (const item of batch) {
        const r = byKey.get(item.recipientKey);
        const ok = Boolean(r && (r.subject?.trim() || r.body?.trim()));
        await this.setItem(
          item.id,
          ok ? 'done' : 'failed',
          ok ? { subject: r!.subject, body: r!.body } : null,
          ok ? null : 'generation returned an empty draft',
        );
      }
    } catch (err) {
      // Whole-batch failure (e.g. budget hard-stop, provider outage): fail the
      // claimed items with the reason; finalize will roll the job to partial.
      const message = (err as Error).message ?? 'generation failed';
      for (const item of batch) await this.setItem(item.id, 'failed', null, message);
    }
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

  private async finalizeJob(jobId: string): Promise<void> {
    await this.prisma.withSystem(async (tx) => {
      const items = await tx.outreachJobItem.findMany({
        where: { jobId },
        select: { status: true },
      });
      const { status, totals } = computeJobRollup(items);
      const done = status === 'complete' || status === 'partial' || status === 'failed';
      await tx.outreachJob.update({
        where: { id: jobId },
        data: { status, totals, ...(done ? { finishedAt: new Date() } : {}) },
      });
    });
  }

  /**
   * Return generation items stuck 'claimed'/'generating' past the stale cutoff to
   * 'pending' (a crashed worker). Safe because generation is at-least-once. Send
   * items are intentionally left alone (W4.3 surfaces stuck sends for the user).
   */
  private async reclaimStale(): Promise<void> {
    const cutoff = new Date(Date.now() - this.staleMs);
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE outreach_job_items i SET status='pending', updated_at=NOW()
         FROM outreach_jobs j
         WHERE i.job_id=j.id AND j.kind='generate'
           AND i.status IN ('claimed','generating') AND i.claimed_at < $1`,
        cutoff,
      ),
    );
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
