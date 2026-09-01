import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { GenerationGatewayService } from '../../engagement/generation/generation-gateway.service.js';
import { OutreachDraftService } from '../../engagement/outreach-draft.service.js';
import { OutreachV3ArtifactRootService } from '../drafts/outreach-v3-artifact-root.service.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachV3ApproachApprovalService } from './outreach-v3-approach-approval.service.js';
import {
  buildOutreachV3FullGenerationJob,
  isOutreachV3FullGenerationJobCurrent,
  parseOutreachV3FullGenerationJob,
  type OutreachV3FullGenerationJobDescriptor,
} from './outreach-v3-full-generation-job.js';
import {
  buildOutreachV3GenerationPlan,
  type OutreachV3GenerationPlan,
} from './outreach-v3-generation-plan.js';
import { OutreachV3GenerationPreparationService } from './outreach-v3-generation-preparation.service.js';
import { buildOutreachV3GatewayUnit } from './outreach-v3-generation-request.js';
import { OutreachV3LivePreviewService } from '../../engagement/generation/outreach-v3-live-preview.service.js';

export const OUTREACH_V3_FULL_GENERATION_JOB_KIND = 'generate_v3' as const;
const MAX_JOB_ITEMS = 500;
// Mirrors the frontend's own ITEM_TERMINAL set (outreach-generation-status.ts)
// — a live preview is only meaningful before an item reaches one of these.
const ITEM_TERMINAL_STATUSES = new Set(['done', 'failed', 'skipped', 'sent']);

const JOB_SELECT = {
  id: true,
  status: true,
  totals: true,
  requestKey: true,
  params: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
} as const;

export interface OutreachV3FullGenerationSubmitResult {
  jobId: string | null;
  deduped: boolean;
  complete: boolean;
  remaining: number;
  jobKey: string | null;
}

@Injectable()
export class OutreachV3FullGenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: OutreachSessionService,
    private readonly approvals: OutreachV3ApproachApprovalService,
    private readonly drafts: OutreachDraftService,
    private readonly preparation: OutreachV3GenerationPreparationService,
    private readonly gateway: GenerationGatewayService,
    private readonly roots: OutreachV3ArtifactRootService,
    // Optional so every existing direct construction of this service (its
    // specs build it with `new OutreachV3FullGenerationService(...)`, no Nest
    // module) keeps working unchanged. When absent, `livePreview` on each
    // returned item is simply always null.
    @Optional() private readonly livePreview?: OutreachV3LivePreviewService,
  ) {}

  async submit(
    ctx: TenantContext,
    sessionId: string,
    requestKeyRaw: string,
  ): Promise<OutreachV3FullGenerationSubmitResult> {
    const requestKey = requestKeyRaw.trim();
    if (requestKey.length < 8 || requestKey.length > 128) {
      throw new BadRequestException('requestKey must be 8–128 characters.');
    }
    if (!this.gateway.enabled) {
      throw new ServiceUnavailableException('Governed generation is not enabled for this runtime.');
    }

    const current = await this.sessions.getSession(ctx, sessionId);
    if (current.session.status !== 'active') {
      throw new OutreachCommandError(
        'OUTREACH_SESSION_ARCHIVED',
        'Archived outreach sessions cannot start full generation.',
        409,
      );
    }
    // The guided review-packet flow can reach full generation without ever
    // calling generateSamples, which is otherwise the only caller that creates
    // this compatibility parent. Ensure it exists before any draft read/write
    // below (completedGenerationKeysForPlan, and the queued job's draft
    // writes) can hit assertRecordOwned's "Outreach draft record not found".
    await this.roots.ensureRoot(ctx, sessionId);
    const plan = buildOutreachV3GenerationPlan({
      sessionId,
      stateVersion: current.currentStateVersion,
      specHash: current.specHash,
      spec: current.spec,
      readiness: current.readiness,
      pendingProposalCount: current.pendingProposalCount,
    });
    if (!plan.eligible) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'The campaign is not ready for full generation.',
        409,
        { reason: 'generation_plan_not_eligible' },
      );
    }

    const approval = await this.approvals.getCurrent(ctx, sessionId, plan);
    if (!approval) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'Approve the current representative sample approach before generating the remaining audience.',
        409,
        { reason: 'approach_approval_required' },
      );
    }

    // Idempotent retry is anchored to the ORIGINAL queued plan + approval, not
    // to the number of items still unfinished now. Progress must not change the
    // meaning of the same requestKey.
    const prior = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachJob.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, requestKey },
        select: { id: true, kind: true, outreachRecordId: true, params: true, status: true },
      }),
    );
    if (prior) {
      const descriptor = readDescriptor(prior.params);
      if (
        prior.kind !== OUTREACH_V3_FULL_GENERATION_JOB_KIND ||
        prior.outreachRecordId !== sessionId ||
        !descriptor ||
        descriptor.planHash !== plan.planHash ||
        descriptor.approachApprovalHash !== approval.approvalHash
      ) {
        throw requestKeyConflict();
      }
      return {
        jobId: prior.id,
        deduped: true,
        complete: prior.status === 'complete',
        remaining: descriptor.items.length,
        jobKey: descriptor.jobKey,
      };
    }

    const completedGenerationKeys = await this.completedGenerationKeysForPlan(ctx, sessionId, plan);
    const remainingSlots = plan.slots.filter(
      (slot) => !completedGenerationKeys.includes(slot.generationKey),
    );
    if (remainingSlots.length === 0) {
      return { jobId: null, deduped: true, complete: true, remaining: 0, jobKey: null };
    }
    if (remainingSlots.length > MAX_JOB_ITEMS) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BATCH_TOO_LARGE',
        `Full generation supports at most ${MAX_JOB_ITEMS} unfinished slots per campaign.`,
        422,
        { remaining: remainingSlots.length },
      );
    }

    const firstPrepared = await this.preparation.prepareSlot(ctx, current.spec, remainingSlots[0]!);
    const firstUnit = buildOutreachV3GatewayUnit({
      plan,
      spec: current.spec,
      prepared: firstPrepared,
    });
    let policy;
    try {
      policy = this.gateway.resolvePolicy(firstUnit.request);
    } catch {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'The audience policy could not be resolved for full generation.',
        409,
        { reason: 'audience_policy_required' },
      );
    }
    const identity = await this.gateway.resolvePinnedIdentity(ctx, {
      policy,
      runtimeAction: firstUnit.request.runtimeAction,
    });
    if (!identity) {
      throw new ServiceUnavailableException('Drafting is not configured for this workspace.');
    }

    const descriptor = buildOutreachV3FullGenerationJob({
      plan,
      approachApproval: approval,
      completedGenerationKeys,
      pinned: identity.pinned,
    });
    if (descriptor.items.length === 0) {
      return {
        jobId: null,
        deduped: true,
        complete: true,
        remaining: 0,
        jobKey: descriptor.jobKey,
      };
    }

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Close the race with another identical submit that landed after the
      // preflight lookup above.
      const existing = await tx.outreachJob.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, requestKey },
        select: { id: true, kind: true, outreachRecordId: true, params: true, status: true },
      });
      if (existing) {
        const stored = readDescriptor(existing.params);
        if (
          existing.kind !== OUTREACH_V3_FULL_GENERATION_JOB_KIND ||
          existing.outreachRecordId !== sessionId ||
          !stored ||
          stored.planHash !== plan.planHash ||
          stored.approachApprovalHash !== approval.approvalHash
        ) {
          throw requestKeyConflict();
        }
        return {
          jobId: existing.id,
          deduped: true,
          complete: existing.status === 'complete',
          remaining: stored.items.length,
          jobKey: stored.jobKey,
        };
      }

      const job = await tx.outreachJob.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          kind: OUTREACH_V3_FULL_GENERATION_JOB_KIND,
          outreachRecordId: sessionId,
          params: { v3FullGeneration: descriptor } as unknown as Prisma.InputJsonValue,
          status: 'queued',
          totals: {
            queued: descriptor.items.length,
            succeeded: 0,
            failed: 0,
            skipped: 0,
            held: 0,
            total: descriptor.items.length,
          } as Prisma.InputJsonValue,
          requestKey,
        },
        select: { id: true },
      });
      await tx.outreachJobItem.createMany({
        data: descriptor.items.map((item) => ({
          tenantId: ctx.tenantId,
          jobId: job.id,
          recipientKey: item.generationKey,
          // Durable payload intentionally contains ONLY the slot identity.
          payload: { generationKey: item.generationKey } as Prisma.InputJsonValue,
        })),
      });
      return {
        jobId: job.id,
        deduped: false,
        complete: false,
        remaining: descriptor.items.length,
        jobKey: descriptor.jobKey,
      };
    });
  }

  async getJob(ctx: TenantContext, sessionId: string, jobId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const job = await tx.outreachJob.findFirst({
        where: {
          id: jobId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          kind: OUTREACH_V3_FULL_GENERATION_JOB_KIND,
          outreachRecordId: sessionId,
        },
        select: JOB_SELECT,
      });
      if (!job) throw new NotFoundException('Full generation job not found');
      return this.formatJob(tx, ctx.tenantId, sessionId, job);
    });
  }

  /**
   * Server-truth recovery (Workstream H): the most recent full-generation job
   * for this session, regardless of status. Returns null when no job has
   * ever been created — a legitimate, distinct state from "the job you asked
   * about doesn't exist" (404). Callers use this at Drafts/session mount so
   * recovery never depends on `sessionStorage` surviving a refresh, browser
   * navigation, or a lost tab.
   */
  async getLatestJob(ctx: TenantContext, sessionId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const job = await tx.outreachJob.findFirst({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          kind: OUTREACH_V3_FULL_GENERATION_JOB_KIND,
          outreachRecordId: sessionId,
        },
        orderBy: { createdAt: 'desc' },
        select: JOB_SELECT,
      });
      if (!job) return null;
      return this.formatJob(tx, ctx.tenantId, sessionId, job);
    });
  }

  /**
   * Formats a job row for API responses using the CALLER's already-open
   * transaction handle. This must never open its own `withTenant`/
   * `withSystem` transaction — doing so while the caller's transaction is
   * still open holds two interactive-transaction slots for one logical
   * request and, under load, can leave the outer transaction idle past
   * Prisma's interactive-transaction timeout, producing a
   * "Transaction API error: Transaction not found" failure on the outer
   * `tx` once the inner one commits/recycles the connection. Always pass the
   * existing `tx` through instead of re-deriving one from `ctx.tenantId`.
   */
  private async formatJob(
    tx: Prisma.TransactionClient,
    tenantId: string,
    sessionId: string,
    job: {
      id: string;
      status: string;
      totals: unknown;
      requestKey: string;
      params: unknown;
      startedAt: Date | null;
      finishedAt: Date | null;
      createdAt: Date;
    },
  ) {
    const items = await tx.outreachJobItem.findMany({
      where: { tenantId, jobId: job.id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        recipientKey: true,
        status: true,
        result: true,
        error: true,
        attempt: true,
      },
    });
    const descriptor = readDescriptor(job.params);
    return {
      id: job.id,
      sessionId,
      status: job.status,
      totals: job.totals,
      requestKey: job.requestKey,
      planHash: descriptor?.planHash ?? null,
      approachApprovalHash: descriptor?.approachApprovalHash ?? null,
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      items: items.map((item) => ({
        id: item.id,
        generationKey: item.recipientKey,
        status: item.status,
        result: safeResult(item.result),
        error: item.status === 'held' ? null : safeError(item.error),
        attempt: item.attempt,
        // Only while still in flight — once an item is terminal, the real
        // draft version (already persisted by then) is the answer, not a
        // cosmetic preview. Absent when streaming is off/unavailable, same as
        // every item having none.
        livePreview: ITEM_TERMINAL_STATUSES.has(item.status)
          ? null
          : (this.livePreview?.get(item.recipientKey) ?? null),
      })),
    };
  }

  async retryItem(ctx: TenantContext, sessionId: string, jobId: string, itemId: string) {
    const current = await this.sessions.getSession(ctx, sessionId);
    const plan = buildOutreachV3GenerationPlan({
      sessionId,
      stateVersion: current.currentStateVersion,
      specHash: current.specHash,
      spec: current.spec,
      readiness: current.readiness,
      pendingProposalCount: current.pendingProposalCount,
    });
    const approval = await this.approvals.getCurrent(ctx, sessionId, plan);

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const job = await tx.outreachJob.findFirst({
        where: {
          id: jobId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          kind: OUTREACH_V3_FULL_GENERATION_JOB_KIND,
          outreachRecordId: sessionId,
        },
        select: { id: true, status: true, params: true },
      });
      if (!job) throw new NotFoundException('Full generation job not found');
      const descriptor = readDescriptor(job.params);
      if (!descriptor || !isOutreachV3FullGenerationJobCurrent(descriptor, plan, approval)) {
        throw new ConflictException(
          'This generation job is stale. Start a new full-generation job.',
        );
      }
      const item = await tx.outreachJobItem.findFirst({
        where: { id: itemId, jobId, tenantId: ctx.tenantId },
        select: { id: true, status: true },
      });
      if (!item) throw new NotFoundException('Generation item not found');
      if (item.status === 'held') {
        return { retried: false, reason: 'held drafts require review or an explicit new version' };
      }
      if (item.status !== 'failed') {
        return { retried: false, reason: `item is ${item.status}, not failed` };
      }
      await tx.outreachJobItem.update({
        where: { id: item.id },
        data: { status: 'pending', error: null, claimedAt: null },
      });
      if (['complete', 'partial', 'failed'].includes(job.status)) {
        await tx.outreachJob.update({
          where: { id: job.id },
          data: { status: 'running', finishedAt: null },
        });
      }
      return { retried: true };
    });
  }

  async cancel(ctx: TenantContext, sessionId: string, jobId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const job = await tx.outreachJob.findFirst({
        where: {
          id: jobId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          kind: OUTREACH_V3_FULL_GENERATION_JOB_KIND,
          outreachRecordId: sessionId,
        },
        select: { id: true, status: true },
      });
      if (!job) throw new NotFoundException('Full generation job not found');
      if (['complete', 'failed', 'canceled'].includes(job.status)) return { canceled: false };
      const skipped = await tx.outreachJobItem.updateMany({
        where: { tenantId: ctx.tenantId, jobId, status: 'pending' },
        data: { status: 'skipped' },
      });
      await tx.outreachJob.update({
        where: { id: jobId },
        data: { status: 'canceled', finishedAt: new Date() },
      });
      return { canceled: true, skipped: skipped.count };
    });
  }

  private async completedGenerationKeysForPlan(
    ctx: TenantContext,
    sessionId: string,
    plan: OutreachV3GenerationPlan,
  ): Promise<string[]> {
    const artifacts = await this.drafts.listForOutreach(ctx, sessionId);
    const currentVersions = artifacts
      .filter((artifact) => artifact.current !== null)
      .map((artifact) => ({
        generationKey: artifact.generationKey,
        versionId: artifact.current!.id,
      }));
    if (!currentVersions.length) return [];

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.outreachDraftVersion.findMany({
        where: {
          tenantId: ctx.tenantId,
          id: { in: currentVersions.map((entry) => entry.versionId) },
        },
        select: { id: true, contextPacketId: true },
      });
      const packetIds = rows
        .map((row) => row.contextPacketId)
        .filter((value): value is string => Boolean(value));
      const packets = packetIds.length
        ? await tx.contextPacket.findMany({
            where: { tenantId: ctx.tenantId, id: { in: packetIds } },
            select: { id: true, ref: true },
          })
        : [];
      const packetById = new Map(
        packets.map((packet) => [packet.id, asRecord(packet.ref)] as const),
      );
      const packetIdByVersion = new Map(rows.map((row) => [row.id, row.contextPacketId] as const));
      return currentVersions
        .filter((entry) => {
          const packetId = packetIdByVersion.get(entry.versionId);
          const ref = packetId ? packetById.get(packetId) : null;
          return Boolean(
            ref &&
            ref.outreachV3SessionId === sessionId &&
            ref.outreachV3PlanHash === plan.planHash &&
            ref.outreachV3SpecHash === plan.specHash &&
            Number(ref.outreachV3StateVersion ?? NaN) === plan.stateVersion,
          );
        })
        .map((entry) => entry.generationKey);
    });
  }
}

export function readDescriptor(value: unknown): OutreachV3FullGenerationJobDescriptor | null {
  return parseOutreachV3FullGenerationJob(asRecord(value).v3FullGeneration);
}

function requestKeyConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'OUTREACH_REQUEST_KEY_REUSED',
    message: 'This request key was already used for a different generation request.',
  });
}

function safeResult(value: unknown): Record<string, unknown> | null {
  const result = asRecord(value);
  if (!Object.keys(result).length) return null;
  const allow = [
    'generationKey',
    'artifactId',
    'versionId',
    'version',
    'generationStatus',
    'auditStatus',
    'approvalStatus',
    'contextNote',
    'manifest',
  ];
  return Object.fromEntries(allow.filter((key) => key in result).map((key) => [key, result[key]]));
}

function safeError(value: unknown): string | null {
  return typeof value === 'string' ? value.slice(0, 500) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
