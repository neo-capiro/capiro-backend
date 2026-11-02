import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import type { ImpersonationSession, Prisma } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { requireOwnerActor } from '../clients/client-ordered-owner.access.js';

type Session = ImpersonationSession & { tenant: { slug: string; name: string; status: string } };
export type StartImpersonation = { requestId: string; tenantId: string; reason: string };
const include = { tenant: { select: { slug: true, name: true, status: true } } } as const;

export function projectImpersonation(session: Session, now: Date) {
  return {
    sessionId: session.id,
    tenantId: session.tenantId,
    tenantSlug: session.tenant.slug,
    tenantName: session.tenant.name,
    reason: session.reason,
    startedAt: session.startedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    endedAt: session.endedAt?.toISOString() ?? null,
    endedReason: session.endedReason,
    status: session.endedAt
      ? ('ended' as const)
      : session.expiresAt <= now
        ? ('expired' as const)
        : session.tenant.status !== 'active'
          ? ('unavailable' as const)
          : ('active' as const),
  };
}

/** Existing session and audit rows own command identity and recovery. No second
 * session store: the request UUID is the original session's immutable identity. */
@Injectable()
export class ImpersonationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authority: TenantContextMiddleware,
  ) {}

  private async current<T>(
    ctx: TenantContext,
    req: Request,
    work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
  ) {
    if (
      ctx.role !== 'capiro_admin' ||
      !isUUID(ctx.userId) ||
      !isUUID(ctx.tenantId) ||
      req.header('x-capiro-impersonate-tenant') !== undefined ||
      req.header('x-capiro-impersonation-session') !== undefined
    )
      throw new ForbiddenException('Use your own HQ session to manage impersonation');
    const proof = await this.authority.readApplicationAuthoritySession(req, ctx);
    return this.prisma.withSystem(async (tx) => {
      // Serialize replacement and exit for one actor before taking membership
      // share locks; concurrent starts cannot both survive as active sessions.
      const actor = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE id=${ctx.userId}::uuid AND clerk_user_id=${ctx.clerkUserId} FOR UPDATE`;
      if (!actor.length) throw new ForbiddenException('HQ access unavailable');
      await requireOwnerActor(tx, ctx, true, true);
      await proof.readCurrent(tx);
      const result = await work(tx, new Date());
      await proof.readCurrent(tx);
      return result;
    });
  }

  start(ctx: TenantContext, req: Request, input: StartImpersonation) {
    const reason = input.reason?.trim();
    if (
      !isUUID(input.requestId) ||
      !isUUID(input.tenantId) ||
      !reason ||
      reason.length < 10 ||
      reason.length > 500
    )
      throw new BadRequestException(
        'A request identity, target tenant and reason of 10–500 characters are required',
      );
    const requestId = input.requestId.toLowerCase(),
      tenantId = input.tenantId.toLowerCase();
    return this.current(ctx, req, async (tx, now) => {
      const existing = await tx.impersonationSession.findUnique({
        where: { id: requestId },
        include,
      });
      if (existing) {
        if (
          existing.actorUserId !== ctx.userId ||
          existing.tenantId !== tenantId ||
          existing.reason !== reason
        )
          throw new ConflictException('Impersonation request identity was already used');
        return { ...projectImpersonation(existing, now), replayed: true };
      }
      const target = await tx.tenant.findFirst({
        where: { id: tenantId, status: 'active' },
        select: { id: true },
      });
      if (!target) throw new NotFoundException('Active tenant not found');
      const prior = await tx.impersonationSession.findMany({
        where: { actorUserId: ctx.userId, endedAt: null },
      });
      for (const session of prior)
        await this.close(tx, ctx, session, now, session.expiresAt <= now ? 'expired' : 'replaced');
      const session = await tx.impersonationSession.create({
        data: {
          id: requestId,
          actorUserId: ctx.userId,
          tenantId,
          reason,
          expiresAt: new Date(now.getTime() + 3600000),
        },
        include,
      });
      await tx.auditLog.create({
        data: {
          tenantId: session.tenantId,
          actorUserId: ctx.userId,
          actorRole: 'capiro_admin',
          action: 'impersonation.start',
          entityType: 'impersonation_session',
          entityId: session.id,
          after: { reason, expiresAt: session.expiresAt.toISOString() },
        },
      });
      return { ...projectImpersonation(session, now), replayed: false };
    }).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
        throw new ConflictException('Impersonation request identity was already used');
      throw error;
    });
  }

  read(ctx: TenantContext, req: Request, sessionId: string) {
    return this.current(ctx, req, async (tx, now) =>
      projectImpersonation(await this.owned(tx, ctx, sessionId), now),
    );
  }

  active(ctx: TenantContext, req: Request) {
    return this.current(ctx, req, async (tx, now) => {
      const rows = await tx.impersonationSession.findMany({
        where: { actorUserId: ctx.userId, endedAt: null },
        include,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      });
      let selected: Session | undefined;
      for (const row of rows) {
        if (row.expiresAt <= now) await this.close(tx, ctx, row, now, 'expired');
        else if (!selected) selected = row;
        else await this.close(tx, ctx, row, now, 'replaced');
      }
      return { session: selected ? projectImpersonation(selected, now) : null };
    });
  }

  workspace(ctx: TenantContext, req: Request, sessionId: string, after?: string) {
    if (after !== undefined && !isUUID(after))
      throw new BadRequestException('Invalid client cursor');
    return this.current(ctx, req, async (tx) => {
      const session = await this.owned(tx, ctx, sessionId);
      // The actor lock in current() serializes this read with replacement/exit.
      // Stabilize target availability too. Tenant headers never select this scope.
      await tx.$queryRaw`SELECT id FROM tenants WHERE id=${session.tenantId}::uuid FOR SHARE`;
      const active = async () => {
        const current = await this.owned(tx, ctx, sessionId);
        if (projectImpersonation(current, new Date()).status !== 'active')
          throw new ForbiddenException('Impersonation session is no longer active');
        return current;
      };
      await active();
      const rows = await tx.client.findMany({
        where: {
          tenantId: session.tenantId,
          status: { not: 'archived' },
          ...(after ? { id: { gt: after } } : {}),
          OR: [
            { memoryWall: false },
            { memoryAccessGrants: { some: { tenantId: session.tenantId, userId: ctx.userId } } },
          ],
        },
        select: { id: true, name: true, status: true, website: true, updatedAt: true },
        orderBy: { id: 'asc' },
        take: 51,
      });
      const clients = rows.slice(0, 50);
      await tx.auditLog.create({
        data: {
          tenantId: session.tenantId,
          actorUserId: ctx.userId,
          actorRole: 'capiro_admin',
          action: 'impersonation.workspace.read',
          entityType: 'impersonation_session',
          entityId: session.id,
          after: { returnedCount: clients.length, hasMore: rows.length > 50 },
        },
      });
      return {
        session: projectImpersonation(await active(), new Date()),
        readOnly: true as const,
        clients,
        nextCursor: rows.length > 50 ? clients.at(-1)!.id : null,
      };
    });
  }

  end(ctx: TenantContext, req: Request, sessionId: string) {
    return this.current(ctx, req, async (tx, now) => {
      const session = await this.owned(tx, ctx, sessionId);
      if (session.endedAt) return { ...projectImpersonation(session, now), replayed: true };
      const ended = await this.close(
        tx,
        ctx,
        session,
        now,
        session.expiresAt <= now ? 'expired' : 'manual',
      );
      return { ...projectImpersonation({ ...session, ...ended }, now), replayed: false };
    });
  }

  private async owned(tx: Prisma.TransactionClient, ctx: TenantContext, id: string) {
    if (!isUUID(id)) throw new NotFoundException('Impersonation session not found');
    const session = await tx.impersonationSession.findFirst({
      where: { id, actorUserId: ctx.userId },
      include,
    });
    if (!session) throw new NotFoundException('Impersonation session not found');
    return session;
  }

  private async close(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    session: ImpersonationSession,
    now: Date,
    reason: string,
  ) {
    const ended = await tx.impersonationSession.update({
      where: { id: session.id },
      data: { endedAt: now, endedReason: reason },
    });
    await tx.auditLog.create({
      data: {
        tenantId: session.tenantId,
        actorUserId: ctx.userId,
        actorRole: 'capiro_admin',
        action: 'impersonation.end',
        entityType: 'impersonation_session',
        entityId: session.id,
        after: { endedReason: reason, endedAt: now.toISOString() },
      },
    });
    return ended;
  }
}
