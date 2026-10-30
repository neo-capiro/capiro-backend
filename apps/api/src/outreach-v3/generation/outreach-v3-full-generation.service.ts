import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  parseOutreachV3FullGenerationJob,
  type OutreachV3FullGenerationJobDescriptor,
} from './outreach-v3-full-generation-job.js';

export const OUTREACH_V3_FULL_GENERATION_JOB_KIND = 'generate_v3' as const;
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

/** Historical V3 job reads/cancellation only. New generation uses Outreach SDK units. */
@Injectable()
export class OutreachV3FullGenerationService {
  constructor(private readonly prisma: PrismaService) {}

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
        livePreview: null,
      })),
    };
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
}

export function readDescriptor(value: unknown): OutreachV3FullGenerationJobDescriptor | null {
  return parseOutreachV3FullGenerationJob(asRecord(value).v3FullGeneration);
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
