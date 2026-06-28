import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export type WsNotificationKind = 'collab_invite' | 'collab_accepted' | 'collab_declined';
type WsRoleValue = 'editor' | 'reviewer' | 'viewer' | 'commenter';

export interface CreateNotificationInput {
  tenantId: string;
  recipientId: string;
  kind: WsNotificationKind;
  message: string;
  draftId?: string | null;
  collaboratorId?: string | null;
  actorName?: string | null;
  draftTitle?: string | null;
  role?: WsRoleValue | null;
  actionable?: boolean;
}

/**
 * In-app notifications (E-19). Targets a Clerk user id (recipientId); the bell
 * lists a member's notifications across all drafts in the tenant. The engine
 * doesn't own the user table, so display fields are denormalized on write.
 * Every read/write is tenant + recipient scoped (a member only ever sees their
 * own notifications).
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** A member's recent notifications (newest first) + the unread count. */
  async list(tenantId: string, recipientId: string) {
    const [items, unread] = await Promise.all([
      this.prisma.wsNotification.findMany({
        where: { tenantId, recipientId },
        orderBy: { createdAt: 'desc' },
        take: 30,
      }),
      this.prisma.wsNotification.count({ where: { tenantId, recipientId, read: false } }),
    ]);
    return { items, unread };
  }

  async markRead(tenantId: string, recipientId: string, id: string) {
    const n = await this.prisma.wsNotification.findFirst({ where: { id, tenantId, recipientId } });
    if (!n) throw new NotFoundException('Notification not found');
    return this.prisma.wsNotification.update({ where: { id }, data: { read: true } });
  }

  async markAllRead(tenantId: string, recipientId: string): Promise<{ updated: number }> {
    const res = await this.prisma.wsNotification.updateMany({
      where: { tenantId, recipientId, read: false },
      data: { read: true },
    });
    return { updated: res.count };
  }

  /** Create a notification (used by CollaboratorsService on invite/accept/decline). */
  async create(input: CreateNotificationInput) {
    return this.prisma.wsNotification.create({
      data: {
        tenantId: input.tenantId,
        recipientId: input.recipientId,
        kind: input.kind,
        message: input.message,
        draftId: input.draftId ?? null,
        collaboratorId: input.collaboratorId ?? null,
        actorName: input.actorName ?? null,
        draftTitle: input.draftTitle ?? null,
        role: input.role ?? null,
        actionable: input.actionable ?? false,
      },
    });
  }

  /** Stop showing accept/decline once an invite is resolved (accepted/declined/removed). */
  async resolveInvite(collaboratorId: string): Promise<void> {
    await this.prisma.wsNotification.updateMany({
      where: { collaboratorId, kind: 'collab_invite', actionable: true },
      data: { actionable: false },
    });
  }
}
