import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { ResolvedRole } from './role-policy.js';
import { canManageCollaborators } from './role-policy.js';
import type { InviteCollaboratorDto, UpdateCollaboratorDto } from './dto/collaborator.dto.js';

/**
 * Collaborators on a work product (the WsDraft). Grain decision: collaboration
 * is on the draft (surfaced in the UI as "this document"); the draft owner
 * (WsDraft.ownerId) is the implicit Owner and is synthesized — never stored.
 *
 * This service also owns role RESOLUTION + the central enforcement helper
 * (assertCan) that the other engine services call before a guarded mutation.
 * Tenant-scoped: every read filters by tenantId and verifies the draft belongs
 * to the tenant before any write.
 *
 * Invite resolution (Q-COL-invite):
 *  - INTERNAL teammate — the web app resolved a tenant member (GET
 *    /api/tenant-members, which the engine cannot reach) to a Clerk user id and
 *    passes `subjectId`. The row is `active` immediately.
 *  - EXTERNAL client SME — a raw `email`. The row is `pending` and tagged for
 *    the client portal. The Clerk org-invite for externals is a later phase; see
 *    the TODO in `invite()`.
 */
@Injectable()
export class CollaboratorsService {
  private readonly logger = new Logger(CollaboratorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private async assertDraft(tenantId: string, draftId: string) {
    const draft = await this.prisma.wsDraft.findFirst({ where: { id: draftId, tenantId } });
    if (!draft) throw new NotFoundException('Draft not found');
    return draft;
  }

  /**
   * Resolve an actor's role on a draft:
   *   'owner'    — the actor is the draft owner (WsDraft.ownerId);
   *   <WsRole>   — an active collaborator row for this subject;
   *   null       — no access (no owner match, no row).
   * Pending external invites carry no subjectId, so they never resolve a role
   * for a signed-in actor here (they gain access once accepted → active + subjectId).
   */
  async resolveRole(tenantId: string, draftId: string, clerkUserId: string): Promise<ResolvedRole> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      select: { ownerId: true },
    });
    if (!draft) return null;
    if (draft.ownerId === clerkUserId) return 'owner';
    const row = await this.prisma.wsCollaborator.findFirst({
      where: { tenantId, draftId, subjectId: clerkUserId, status: 'active' },
      select: { role: true },
    });
    return row?.role ?? null;
  }

  /**
   * Central enforcement gate. Services call this before a guarded mutation with
   * one of the role-policy predicates. The draft owner always passes the
   * predicates that include 'owner'. Throws 403 on violation.
   */
  async assertCan(
    tenantId: string,
    draftId: string,
    clerkUserId: string,
    predicate: (role: ResolvedRole) => boolean,
    message = 'You do not have permission to perform this action on this document',
  ): Promise<ResolvedRole> {
    const role = await this.resolveRole(tenantId, draftId, clerkUserId);
    if (!predicate(role)) throw new ForbiddenException(message);
    return role;
  }

  /** List collaborators (active + pending) plus the synthetic Owner first. */
  async list(tenantId: string, draftId: string) {
    const draft = await this.assertDraft(tenantId, draftId);
    const rows = await this.prisma.wsCollaborator.findMany({
      where: { tenantId, draftId },
      orderBy: { createdAt: 'asc' },
    });
    const owner = {
      id: `owner:${draft.id}`,
      subjectId: draft.ownerId,
      email: null as string | null,
      name: null as string | null,
      role: 'owner' as const,
      status: 'active' as const,
      isOwner: true,
    };
    const collaborators = rows.map((r) => ({
      id: r.id,
      subjectId: r.subjectId,
      email: r.email,
      name: r.name,
      role: r.role,
      status: r.status,
      isOwner: false,
    }));
    return { collaborators: [owner, ...collaborators] };
  }

  /** Invite a collaborator. Internal (subjectId) → active; external (email) → pending. */
  async invite(tenantId: string, draftId: string, inviterId: string, dto: InviteCollaboratorDto) {
    const draft = await this.assertDraft(tenantId, draftId);

    const subjectId = dto.subjectId?.trim() || null;
    const email = dto.email?.trim().toLowerCase() || null;
    if (!subjectId && !email) {
      throw new BadRequestException('Provide a teammate (subjectId) or an email to invite');
    }

    if (subjectId) {
      // Internal teammate — active now. Cannot invite the owner as a collaborator.
      if (subjectId === draft.ownerId) {
        throw new BadRequestException('This person is the document owner');
      }
      const existing = await this.prisma.wsCollaborator.findFirst({
        where: { tenantId, draftId, subjectId },
      });
      if (existing) {
        throw new BadRequestException('This teammate already has access or a pending invite');
      }
      // E-19: invites are PENDING until the invitee accepts (access is granted on
      // accept). An in-app notification lets them accept/decline from the bell.
      const row = await this.prisma.wsCollaborator.create({
        data: {
          tenantId,
          draftId,
          subjectId,
          name: dto.name?.trim() || null,
          role: dto.role,
          status: 'pending',
          invitedById: inviterId,
        },
      });
      await this.notifications.create({
        tenantId,
        recipientId: subjectId,
        kind: 'collab_invite',
        message: `${dto.inviterName?.trim() || 'A teammate'} invited you to collaborate on “${draft.docTitle}” as ${dto.role}.`,
        draftId,
        collaboratorId: row.id,
        actorName: dto.inviterName?.trim() || null,
        draftTitle: draft.docTitle,
        role: dto.role,
        actionable: true,
      });
      return row;
    }

    // External client SME — pending row tagged for the client portal. The Clerk
    // org-invite for externals is deferred; the pending row carries the intended
    // role until accepted.
    const existing = await this.prisma.wsCollaborator.findFirst({
      where: { tenantId, draftId, email },
    });
    if (existing) {
      throw new BadRequestException('This email already has access or a pending invite');
    }
    const row = await this.prisma.wsCollaborator.create({
      data: {
        tenantId,
        draftId,
        email,
        name: dto.name?.trim() || null,
        role: dto.role,
        status: 'pending',
        invitedById: inviterId,
      },
    });
    // TODO(phase): trigger Clerk org invite for external client SMEs (the main
    // api owns the tenant→clerkOrgId mapping + createOrganizationInvitation; the
    // engine cannot reach that DB, so the pending row stands in until accepted).
    this.logger.log(`Pending external collaborator invited to draft ${draftId}: ${email}`);
    return row;
  }

  /** Change a collaborator's role. Owner-only (enforced in the controller). */
  async updateRole(
    tenantId: string,
    draftId: string,
    collaboratorId: string,
    dto: UpdateCollaboratorDto,
  ) {
    await this.assertDraft(tenantId, draftId);
    const existing = await this.prisma.wsCollaborator.findFirst({
      where: { id: collaboratorId, tenantId, draftId },
    });
    if (!existing) throw new NotFoundException('Collaborator not found');
    return this.prisma.wsCollaborator.update({
      where: { id: collaboratorId },
      data: { role: dto.role },
    });
  }

  /** Remove a collaborator. Owner-only (enforced in the controller). The Owner
   *  is synthetic (no row) so it can never be removed here. */
  async remove(
    tenantId: string,
    draftId: string,
    collaboratorId: string,
  ): Promise<{ deleted: boolean }> {
    await this.assertDraft(tenantId, draftId);
    const existing = await this.prisma.wsCollaborator.findFirst({
      where: { id: collaboratorId, tenantId, draftId },
    });
    if (!existing) throw new NotFoundException('Collaborator not found');
    await this.notifications.resolveInvite(collaboratorId);
    await this.prisma.wsCollaborator.delete({ where: { id: collaboratorId } });
    return { deleted: true };
  }

  /**
   * Invitee ACCEPTS their pending invite (E-19). Grants access (status → active,
   * which is what resolveRole/list gate on), clears the actionable invite
   * notification, and notifies the inviter. Only the invited subject may accept.
   */
  async accept(tenantId: string, draftId: string, collaboratorId: string, actorId: string) {
    const row = await this.prisma.wsCollaborator.findFirst({
      where: { id: collaboratorId, tenantId, draftId },
    });
    if (!row) throw new NotFoundException('Invitation not found');
    if (row.subjectId !== actorId) {
      throw new ForbiddenException('This invitation is not addressed to you');
    }
    await this.notifications.resolveInvite(collaboratorId);
    if (row.status === 'active') return row; // idempotent
    const updated = await this.prisma.wsCollaborator.update({
      where: { id: collaboratorId },
      data: { status: 'active' },
    });
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      select: { docTitle: true },
    });
    if (row.invitedById) {
      await this.notifications.create({
        tenantId,
        recipientId: row.invitedById,
        kind: 'collab_accepted',
        message: `${row.name?.trim() || 'A teammate'} accepted your invitation to “${draft?.docTitle ?? 'a document'}”.`,
        draftId,
        collaboratorId,
        draftTitle: draft?.docTitle ?? null,
        role: row.role,
      });
    }
    return updated;
  }

  /**
   * Invitee DECLINES (E-19): removes the pending invite (no access granted),
   * clears the actionable notification, and notifies the inviter. Only the
   * invited subject may decline.
   */
  async decline(
    tenantId: string,
    draftId: string,
    collaboratorId: string,
    actorId: string,
  ): Promise<{ declined: boolean }> {
    const row = await this.prisma.wsCollaborator.findFirst({
      where: { id: collaboratorId, tenantId, draftId },
    });
    if (!row) throw new NotFoundException('Invitation not found');
    if (row.subjectId !== actorId) {
      throw new ForbiddenException('This invitation is not addressed to you');
    }
    await this.notifications.resolveInvite(collaboratorId);
    await this.prisma.wsCollaborator.delete({ where: { id: collaboratorId } });
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      select: { docTitle: true },
    });
    if (row.invitedById) {
      await this.notifications.create({
        tenantId,
        recipientId: row.invitedById,
        kind: 'collab_declined',
        message: `${row.name?.trim() || 'A teammate'} declined your invitation to “${draft?.docTitle ?? 'a document'}”.`,
        draftId,
        draftTitle: draft?.docTitle ?? null,
      });
    }
    return { declined: true };
  }
}
