import { ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { fetchAccessibleClientRevisionsForClerkActor } from '../memory/memory-wall.helpers.js';
import { applicationAuthorityIdentityReceipt, type ApplicationAuthorityIdentityEvidence } from './application-authority.js';
import {
  APPLICATION_MEMBERSHIP_MAX_CLIENTS, applicationMembershipRevision,
  type ApplicationMembershipControl, type ApplicationMembershipReceipt, type ApplicationMembershipSnapshot,
} from './application-membership.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_REVISION = /^[0-9a-f]{32}$/;
const denied = () => new ForbiddenException('Current membership unavailable');
const unavailable = () => new ServiceUnavailableException('Current membership unavailable');
const changed = () => new ConflictException('Current membership changed; reload');

@Injectable()
export class ApplicationMembershipService {
  constructor(private readonly prisma: PrismaService, private readonly tenant: TenantContextMiddleware) {}

  async read(req: Request, ctx: TenantContext, control: ApplicationMembershipControl): Promise<ApplicationMembershipReceipt> {
    control.assertActive();
    if (!UUID.test(ctx.tenantId) || !UUID.test(ctx.userId) || !ctx.clerkUserId) throw denied();
    const initial = await this.tenant.readApplicationAuthority(req, ctx);
    control.assertActive();
    this.assertIdentity(initial, ctx);
    const first = await this.snapshot(ctx, control);
    const current = await this.tenant.readApplicationAuthority(req, ctx);
    control.assertActive();
    this.assertIdentity(current, ctx);
    if (initial.identityRevision !== current.identityRevision) throw changed();
    const second = await this.snapshot(ctx, control);
    this.assertSame(first, second);
    const finalIdentity = await current.recheckCurrent();
    control.assertActive();
    this.assertIdentity(finalIdentity, ctx);
    if (current.identityRevision !== finalIdentity.identityRevision) throw changed();
    const latest = await this.snapshot(ctx, control);
    this.assertSame(second, latest);
    control.assertActive();
    const identity = applicationAuthorityIdentityReceipt({
      ...finalIdentity,
      expiresAtMs: Math.min(initial.expiresAtMs, current.expiresAtMs, finalIdentity.expiresAtMs),
    });
    return {
      tenantId: ctx.tenantId, actorId: ctx.userId, status: 'active', role: latest.role,
      permissions: [], clientIds: latest.clients.map(({ id }) => id),
      membershipRevision: applicationMembershipRevision(latest),
      checkedAtMs: identity.checkedAtMs, expiresAtMs: identity.expiresAtMs,
    };
  }

  private assertIdentity(identity: ApplicationAuthorityIdentityEvidence, ctx: TenantContext): void {
    applicationAuthorityIdentityReceipt(identity);
    if (identity.principal.tenantId !== ctx.tenantId || identity.principal.actorId !== ctx.userId) throw denied();
  }

  private assertSame(before: ApplicationMembershipSnapshot, after: ApplicationMembershipSnapshot): void {
    if (applicationMembershipRevision(before) !== applicationMembershipRevision(after)) throw changed();
  }

  private async snapshot(ctx: TenantContext, control: ApplicationMembershipControl): Promise<ApplicationMembershipSnapshot> {
    control.assertActive();
    try {
      return await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const before = await this.member(tx, ctx);
        control.assertActive();
        const rows = await fetchAccessibleClientRevisionsForClerkActor(
          tx, ctx.tenantId, ctx.clerkUserId, APPLICATION_MEMBERSHIP_MAX_CLIENTS + 1,
        );
        control.assertActive();
        if (!Array.isArray(rows) || rows.length > APPLICATION_MEMBERSHIP_MAX_CLIENTS) throw unavailable();
        const clients = rows.map(({ id, revision }) => {
          if (typeof id !== 'string' || !UUID.test(id) || typeof revision !== 'string' || !CLIENT_REVISION.test(revision)) throw unavailable();
          return { id, revision };
        }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        if (clients.some((row, index) => index > 0 && row.id === clients[index - 1]!.id)) throw unavailable();
        const after = await this.member(tx, ctx);
        control.assertActive();
        this.assertSame({ ...before, clients: [] }, { ...after, clients: [] });
        return { ...after, clients };
      }, { timeoutMs: Math.max(1, Math.min(5000, control.deadlineMs - Date.now())) });
    } catch (error) {
      control.assertActive();
      if (error instanceof HttpException) throw error;
      throw unavailable();
    }
  }

  private async member(tx: Prisma.TransactionClient, ctx: TenantContext): Promise<Omit<ApplicationMembershipSnapshot, 'clients'>> {
    const row = await tx.tenantMembership.findFirst({
      where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
      select: { id: true, tenantId: true, userId: true, status: true, role: true, updatedAt: true,
        tenant: { select: { id: true, status: true, clerkOrgId: true } } },
    });
    if (!row || row.tenantId !== ctx.tenantId || row.userId !== ctx.userId || row.status !== 'active' ||
        row.tenant.id !== ctx.tenantId || row.tenant.status !== 'active' ||
        !Object.hasOwn(ROLE_RANK, row.role) || ROLE_RANK[row.role as TenantRole] < ROLE_RANK.standard_user) throw denied();
    const updatedAtMs = row.updatedAt instanceof Date ? row.updatedAt.getTime() : NaN;
    if (typeof row.id !== 'string' || row.id.length === 0 || row.id.length > 256 ||
        !Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0 ||
        (row.tenant.clerkOrgId !== null && (typeof row.tenant.clerkOrgId !== 'string' || row.tenant.clerkOrgId.length > 256))) throw unavailable();
    return { tenantId: row.tenantId, actorId: row.userId, membershipId: row.id,
      role: row.role as TenantRole, updatedAtMs, clerkOrgId: row.tenant.clerkOrgId };
  }
}
