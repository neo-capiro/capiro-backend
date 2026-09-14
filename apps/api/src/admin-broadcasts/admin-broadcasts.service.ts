import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export const ADMIN_BROADCAST_AUDIENCES = ['all_users', 'selected_users'] as const;
export type AdminBroadcastAudienceInput = (typeof ADMIN_BROADCAST_AUDIENCES)[number];

export interface CreateBroadcastInput {
  tenantId: string;
  title: string;
  body: string;
  audience: AdminBroadcastAudienceInput;
  userIds?: string[];
}

/**
 * Memberships that receive a broadcast: current members plus invitees who have
 * not signed in yet (their first sign-in should still surface it). Removed
 * members never do.
 */
const RECIPIENT_STATUSES = ['active', 'invited'] as const;

const USER_SELECT = { id: true, email: true, firstName: true, lastName: true } as const;

type Tx = Prisma.TransactionClient;

type BroadcastWithRecipients = Prisma.AdminBroadcastGetPayload<{
  include: {
    createdBy: { select: typeof USER_SELECT };
    recipients: { include: { user: { select: typeof USER_SELECT } } };
  };
}>;

function displayName(u: { email: string; firstName: string | null; lastName: string | null }) {
  return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email;
}

/**
 * Capiro-staff broadcasts to a tenant's users. Staff paths run under
 * withSystem (cross-tenant, audit-logged); the end-user paths run under the
 * caller's own tenant scope so a user can only ever see or acknowledge rows
 * addressed to them.
 */
@Injectable()
export class AdminBroadcastsService {
  constructor(private readonly prisma: PrismaService) {}

  async listTenantMembers(tenantId: string) {
    return this.prisma.withSystem(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const memberships = await tx.tenantMembership.findMany({
        where: { tenantId, status: { in: [...RECIPIENT_STATUSES] } },
        include: { user: { select: USER_SELECT } },
      });
      return memberships
        .map((m) => ({
          userId: m.userId,
          email: m.user.email,
          firstName: m.user.firstName,
          lastName: m.user.lastName,
          role: m.role,
          status: m.status,
        }))
        .sort((a, b) => displayName(a).localeCompare(displayName(b)));
    });
  }

  async listBroadcasts(tenantId: string) {
    return this.prisma.withSystem(async (tx) => {
      await this.requireTenant(tx, tenantId);
      const [rows, acknowledged] = await Promise.all([
        tx.adminBroadcast.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'desc' },
          include: {
            createdBy: { select: USER_SELECT },
            _count: { select: { recipients: true } },
          },
        }),
        tx.adminBroadcastRecipient.groupBy({
          by: ['broadcastId'],
          where: { tenantId, acknowledgedAt: { not: null } },
          _count: { _all: true },
        }),
      ]);
      const acknowledgedBy = new Map(acknowledged.map((a) => [a.broadcastId, a._count._all]));
      return rows.map((b) => ({
        id: b.id,
        tenantId: b.tenantId,
        title: b.title,
        body: b.body,
        audience: b.audience,
        createdAt: b.createdAt,
        archivedAt: b.archivedAt,
        createdBy: b.createdBy,
        recipientCount: b._count.recipients,
        acknowledgedCount: acknowledgedBy.get(b.id) ?? 0,
      }));
    });
  }

  async getBroadcast(id: string) {
    return this.prisma.withSystem((tx) => this.loadDetail(tx, id));
  }

  async createBroadcast(actor: TenantContext, input: CreateBroadcastInput) {
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title) throw new BadRequestException('title is required');
    if (!body) throw new BadRequestException('body is required');

    return this.prisma.withSystem(async (tx) => {
      await this.requireTenant(tx, input.tenantId);
      const members = await tx.tenantMembership.findMany({
        where: { tenantId: input.tenantId, status: { in: [...RECIPIENT_STATUSES] } },
        select: { userId: true },
      });
      const memberIds = new Set(members.map((m) => m.userId));

      let recipientIds: string[];
      if (input.audience === 'all_users') {
        recipientIds = [...memberIds];
      } else {
        const requested = [...new Set(input.userIds ?? [])];
        if (requested.length === 0) {
          throw new BadRequestException('userIds is required when audience is selected_users');
        }
        const unknown = requested.filter((userId) => !memberIds.has(userId));
        if (unknown.length > 0) {
          throw new BadRequestException(
            `${unknown.length} selected user(s) are not current members of this tenant`,
          );
        }
        recipientIds = requested;
      }
      if (recipientIds.length === 0) {
        throw new BadRequestException('This tenant has no members to send to');
      }

      const created = await tx.adminBroadcast.create({
        data: {
          tenantId: input.tenantId,
          title,
          body,
          audience: input.audience,
          createdByUserId: actor.userId,
          recipients: {
            createMany: {
              data: recipientIds.map((userId) => ({ tenantId: input.tenantId, userId })),
            },
          },
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          tenantId: input.tenantId,
          actorUserId: actor.userId,
          actorRole: 'capiro_admin',
          action: 'broadcast.create',
          entityType: 'admin_broadcast',
          entityId: created.id,
          after: { title, audience: input.audience, recipientCount: recipientIds.length },
        },
      });
      return this.loadDetail(tx, created.id);
    });
  }

  async archiveBroadcast(actor: TenantContext, id: string) {
    return this.prisma.withSystem(async (tx) => {
      const existing = await tx.adminBroadcast.findUnique({
        where: { id },
        select: { id: true, tenantId: true, title: true, archivedAt: true },
      });
      if (!existing) throw new NotFoundException('Broadcast not found');
      if (!existing.archivedAt) {
        await tx.adminBroadcast.update({ where: { id }, data: { archivedAt: new Date() } });
        await tx.auditLog.create({
          data: {
            tenantId: existing.tenantId,
            actorUserId: actor.userId,
            actorRole: 'capiro_admin',
            action: 'broadcast.archive',
            entityType: 'admin_broadcast',
            entityId: id,
            before: { title: existing.title, archivedAt: null },
          },
        });
      }
      return this.loadDetail(tx, id);
    });
  }

  /** Unacknowledged, unarchived broadcasts addressed to the caller, oldest first. */
  async listPendingForUser(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.adminBroadcastRecipient.findMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          acknowledgedAt: null,
          broadcast: { archivedAt: null },
        },
        include: {
          broadcast: { select: { id: true, title: true, body: true, createdAt: true } },
        },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((r) => r.broadcast);
    });
  }

  /** Idempotent: acknowledging twice keeps the first timestamp. */
  async acknowledge(ctx: TenantContext, broadcastId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const recipient = await tx.adminBroadcastRecipient.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, broadcastId },
        select: { id: true, acknowledgedAt: true },
      });
      if (!recipient) throw new NotFoundException('Broadcast not found');
      if (recipient.acknowledgedAt) {
        return { ok: true as const, acknowledgedAt: recipient.acknowledgedAt };
      }
      const updated = await tx.adminBroadcastRecipient.update({
        where: { id: recipient.id },
        data: { acknowledgedAt: new Date() },
        select: { acknowledgedAt: true },
      });
      return { ok: true as const, acknowledgedAt: updated.acknowledgedAt };
    });
  }

  private async requireTenant(tx: Tx, tenantId: string) {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) throw new NotFoundException('Tenant not found');
  }

  private async loadDetail(tx: Tx, id: string) {
    const b = (await tx.adminBroadcast.findUnique({
      where: { id },
      include: {
        createdBy: { select: USER_SELECT },
        recipients: { include: { user: { select: USER_SELECT } }, orderBy: { createdAt: 'asc' } },
      },
    })) as BroadcastWithRecipients | null;
    if (!b) throw new NotFoundException('Broadcast not found');
    const recipients = b.recipients.map((r) => ({
      userId: r.userId,
      email: r.user.email,
      firstName: r.user.firstName,
      lastName: r.user.lastName,
      acknowledgedAt: r.acknowledgedAt,
    }));
    return {
      id: b.id,
      tenantId: b.tenantId,
      title: b.title,
      body: b.body,
      audience: b.audience,
      createdAt: b.createdAt,
      archivedAt: b.archivedAt,
      createdBy: b.createdBy,
      recipientCount: recipients.length,
      acknowledgedCount: recipients.filter((r) => r.acknowledgedAt !== null).length,
      recipients,
    };
  }
}
