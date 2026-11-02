import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { isUUID } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { requireOwnerActor } from '../../clients/client-ordered-owner.access.js';
import {
  LINK_REVIEW_ACTION,
  linkReviewHash,
  linkReviewInput,
  linkReviewKind,
  type LinkReviewInput,
  type LinkReviewReceipt,
  type LinkReviewStatus,
} from './analyst-link-review.types.js';
import {
  listLinkReviews,
  lockLinkReviewCandidate,
  readLinkReviewCandidate,
} from './analyst-link-review.store.js';

@Injectable()
export class AnalystLinkReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authority: TenantContextMiddleware,
  ) {}
  private async current<T>(
    ctx: TenantContext,
    req: Request,
    write: boolean,
    run: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    if (
      ctx.role !== 'capiro_admin' ||
      req.header('x-capiro-impersonate-tenant') !== undefined ||
      req.header('x-capiro-impersonation-session') !== undefined
    )
      throw new ForbiddenException('Use your own HQ reviewer session');
    const proof = await this.authority.readApplicationAuthoritySession(req, ctx);
    return this.prisma.withSystem(
      async (tx) => {
        await requireOwnerActor(tx, ctx, write, write);
        await proof.readCurrent(tx);
        const result = await run(tx);
        await proof.readCurrent(tx);
        return result;
      },
      { timeoutMs: 15000, ...(write ? {} : { isolationLevel: 'RepeatableRead', readOnly: true }) },
    );
  }
  list(
    ctx: TenantContext,
    req: Request,
    rawKind: string,
    query: { status?: string; page?: number; limit?: number },
  ) {
    const kind = linkReviewKind(rawKind),
      status = query.status ?? 'candidate',
      page = query.page ?? 1,
      limit = query.limit ?? 25;
    const allowed =
      kind === 'provision'
        ? ['candidate', 'accepted', 'rejected']
        : ['candidate', 'quarantined', 'accepted', 'rejected'];
    if (
      !allowed.includes(status) ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new BadRequestException('Invalid review page');
    return this.current(ctx, req, false, (tx) =>
      listLinkReviews(tx, kind, status as LinkReviewStatus, page, limit),
    );
  }
  detail(ctx: TenantContext, req: Request, rawKind: string, id: string) {
    const kind = linkReviewKind(rawKind);
    if (!isUUID(id)) throw new BadRequestException('Invalid candidate');
    id = id.toLowerCase();
    return this.current(ctx, req, false, async (tx) => {
      const candidate = await readLinkReviewCandidate(tx, kind, id);
      const last = await tx.auditLog.findFirst({
        where: {
          action: LINK_REVIEW_ACTION,
          OR: [
            { after: { path: ['receipt', 'status'], equals: 'accepted' } },
            { after: { path: ['receipt', 'status'], equals: 'rejected' } },
          ],
          entityType: kind === 'provision' ? 'provision_pe_link' : 'sam_opportunity_match',
          entityId: id,
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        select: { after: true },
      });
      return {
        schemaVersion: 1 as const,
        candidate,
        lastReview: last ? this.readReceipt(last.after) : null,
        observedAt: new Date().toISOString(),
      };
    });
  }
  receipt(ctx: TenantContext, req: Request, requestId: string) {
    if (!isUUID(requestId)) throw new BadRequestException('Invalid request');
    return this.current(ctx, req, false, async (tx) => {
      const row = await tx.auditLog.findFirst({
        where: {
          id: requestId,
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          action: LINK_REVIEW_ACTION,
        },
      });
      if (!row) throw new NotFoundException('Review receipt unavailable');
      return { schemaVersion: 1 as const, replayed: true, receipt: this.readReceipt(row.after) };
    });
  }
  decide(ctx: TenantContext, req: Request, rawKind: string, id: string, raw: LinkReviewInput) {
    const kind = linkReviewKind(rawKind),
      input = linkReviewInput(raw);
    if (!isUUID(id)) throw new BadRequestException('Invalid candidate');
    id = id.toLowerCase();
    const fingerprint = linkReviewHash({ kind, id, input });
    return this.current(ctx, req, true, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`analyst-link-review:${input.requestId}`},0))`;
      const previous = await tx.auditLog.findUnique({ where: { id: input.requestId } });
      if (previous) {
        const stored = previous.after as { fingerprint?: unknown } | null;
        if (
          previous.tenantId !== ctx.tenantId ||
          previous.actorUserId !== ctx.userId ||
          previous.action !== LINK_REVIEW_ACTION ||
          stored?.fingerprint !== fingerprint
        )
          throw new ConflictException('REVIEW_REQUEST_CONFLICT');
        return {
          schemaVersion: 1 as const,
          replayed: true,
          receipt: this.readReceipt(previous.after),
        };
      }
      const candidate = await lockLinkReviewCandidate(tx, kind, id);
      const stale =
        candidate.version !== input.expectedVersion ||
        !['candidate', 'quarantined'].includes(candidate.reviewStatus);
      const targetUnavailable =
        input.decision === 'accept' &&
        ((!candidate.peCode && !candidate.programId) ||
          (candidate.peCode && (!candidate.programElement || candidate.programElement.retiredAt)) ||
          (candidate.programId && (!candidate.program || candidate.program.status !== 'active')));
      const refusal = stale
        ? 'REVIEW_SOURCE_STALE'
        : targetUnavailable
          ? 'REVIEW_TARGET_UNAVAILABLE'
          : null;
      const status = refusal
        ? ('refused' as const)
        : input.decision === 'accept'
          ? ('accepted' as const)
          : ('rejected' as const);
      if (status !== 'refused') {
        if (kind === 'provision')
          await tx.provisionPeLink.update({ where: { id }, data: { reviewStatus: status } });
        else await tx.samOpportunityMatch.update({ where: { id }, data: { reviewStatus: status } });
      }
      const resulting = await readLinkReviewCandidate(tx, kind, id);
      const receipt: LinkReviewReceipt = {
        schemaVersion: 1,
        requestId: input.requestId,
        kind,
        candidateId: id,
        expectedVersion: input.expectedVersion,
        resultingVersion: resulting.version,
        decision: input.decision,
        status,
        refusal,
        reason: input.reason,
        reviewerId: ctx.userId,
        decidedAt: new Date().toISOString(),
      };
      await tx.auditLog.create({
        data: {
          id: input.requestId,
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: LINK_REVIEW_ACTION,
          entityType: kind === 'provision' ? 'provision_pe_link' : 'sam_opportunity_match',
          entityId: id,
          requestId: input.requestId,
          before: { version: candidate.version, reviewStatus: candidate.reviewStatus },
          after: { fingerprint, receipt } as unknown as Prisma.InputJsonValue,
        },
      });
      return { schemaVersion: 1 as const, replayed: false, receipt };
    });
  }
  private readReceipt(value: Prisma.JsonValue | null): LinkReviewReceipt {
    const receipt = (value as { receipt?: LinkReviewReceipt } | null)?.receipt;
    if (
      !receipt ||
      receipt.schemaVersion !== 1 ||
      !isUUID(receipt.requestId) ||
      !isUUID(receipt.candidateId)
    )
      throw new ConflictException('REVIEW_RECEIPT_UNAVAILABLE');
    return receipt;
  }
}
