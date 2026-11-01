import { draftClientSourceAccess } from '../drafts/draft-client-access.js';
import { withProspectDraft, prospectDraftSourceAccess, withProspectInvitation, requireProspectInvitee } from '../prospect-resources/prospect-draft-access.js';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { WorkspaceReadBudget } from '../prisma/workspace-read-budget.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type { ResolvedRole } from './role-policy.js';
import { canManageCollaborators, canRead } from './role-policy.js';
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
 *    passes `subjectId`. The row stays pending until the invitee accepts.
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
  async resolveRole(
    tenantId: string,
    draftId: string,
    clerkUserId: string,
    signal?: AbortSignal,
    requireCompleteSource = false,
    budget?: WorkspaceReadBudget,
  ): Promise<ResolvedRole> {
    const readDraft = (db: Pick<PrismaService, 'wsDraft'>) => db.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      select: { ownerId: true },
    });
    const draft = await (budget ? budget.transaction(this.prisma, readDraft) : readDraft(this.prisma));
    if (!draft) return null;
    if (!(await this.sourceAccess(tenantId, draftId, clerkUserId, signal, requireCompleteSource, budget))) return null;
    if (draft.ownerId === clerkUserId) return 'owner';
    const readCollaborator = (db: Pick<PrismaService, 'wsCollaborator'>) => db.wsCollaborator.findFirst({
      where: { tenantId, draftId, subjectId: clerkUserId, status: 'active' },
      select: { role: true },
    });
    const row = await (budget ? budget.transaction(this.prisma, readCollaborator) : readCollaborator(this.prisma));
    return row?.role ?? null;
  }

  /** Admit a descendant through the same draft authority, without exposing its existence. */
  async assertReadable(
    tenantId: string,
    draftId: string,
    actorId?: string,
    signal?: AbortSignal,
  ): Promise<ResolvedRole> {
    if (!actorId) throw new NotFoundException('Draft not found');
    const role = await this.resolveRole(tenantId, draftId, actorId, signal);
    if (!canRead(role)) throw new NotFoundException('Draft not found');
    return role;
  }

  /** Immutable origin receipts remain authoritative even after a draft is edited.
   * Research stays private to its author and rechecks the current Intel folder/client wall. */
  async sourceAccess(
    tenantId: string,
    draftId: string,
    clerkUserId: string,
    signal?: AbortSignal,
    requireCompleteSource = false,
    budget?: WorkspaceReadBudget,
  ): Promise<boolean> {
    const readOrigin = (db: Pick<PrismaService, 'wsDraft'>) => db.wsDraft.findFirst({
      where: { tenantId, id: draftId },
      select: { id: true, tenantId: true, ownerId: true, prospectId: true, clientId: true, client: true, config: true },
    });
    const origin = await (budget ? budget.transaction(this.prisma, readOrigin) : readOrigin(this.prisma));
    if (!origin || !(await draftClientSourceAccess(this.prisma, origin, clerkUserId, budget)) || !(await prospectDraftSourceAccess(this.prisma, origin, clerkUserId, budget)))
      return false;
    const readSource = (db: Pick<PrismaService, '$queryRaw'>) => db.$queryRaw<
      Array<{ source_key: string; owner_id: string; source_type: string }>
    >`SELECT source_key,owner_id,source_type FROM ws_source_action WHERE tenant_id=${tenantId}::uuid AND draft_id=${draftId}::uuid AND source_type IN ('legiwatch_research','legiwatch_editorial')`;
    const rows = await (budget ? budget.transaction(this.prisma, readSource) : readSource(this.prisma));
    if (!rows.length) return true;
    const source = rows[0]!;
    if (source.owner_id !== clerkUserId) return false;
    const base = process.env.INTEL_API_BASE_URL,
      secret = process.env.INTERNAL_SERVICE_SECRET;
    const unavailable = () => {
      if (requireCompleteSource) throw new ServiceUnavailableException({ code: 'WORKSPACE_SAVED_WORK_UNAVAILABLE' });
      return false;
    };
    if (!base || !secret) return unavailable();
    try {
      const query = new URLSearchParams({ tenantId, ownerId: clerkUserId });
      const response = await fetch(
        `${base.replace(/\/+$/, '')}/intel-api/internal/legiwatch/${source.source_type === 'legiwatch_editorial' ? 'editorial' : 'research'}-source/${encodeURIComponent(source.source_key)}/access?${query}`,
        {
          headers: { 'x-internal-service-secret': secret },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
            : AbortSignal.timeout(10000),
          redirect: 'error',
        },
      );
      if (!response.ok) return [403, 404].includes(response.status) ? false : unavailable();
      const result = (await response.json()) as { allowed?: boolean; selectionId?: string };
      if (requireCompleteSource && (!result || typeof result.allowed !== 'boolean' || result.selectionId !== source.source_key))
        return unavailable();
      return result.allowed === true && result.selectionId === source.source_key;
    } catch {
      return unavailable();
    }
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

  /** Mail is a separate explicit action. API owns its delivery receipt; this
   * owner supplies current invitation data and canonical source policy. A
   * pending invitation is not a document-read grant. */
  async emailContext(tenantId: string, draftId: string, invitationId: string, actorId: string) {
    if ((await this.resolveRole(tenantId, draftId, actorId)) !== 'owner')
      throw new NotFoundException('Invitation not found');
    const draft = await this.assertDraft(tenantId, draftId);
    const invitation = await withProspectDraft(this.prisma, draft, actorId, canManageCollaborators, 'read',
      db => db.wsCollaborator.findFirst({ where: { id: invitationId, tenantId, draftId } }));
    const identity = { tenantId, draftId, invitationId, actorId };
    const unavailable = (reason: string) => ({ ...identity, invitation: null, reason });
    // Status remains readable by the current authorized owner after removal;
    // the API receipt has no cascading invitation foreign key.
    if (!invitation) return unavailable('InvitationUnavailable');
    if (!invitation.subjectId) return unavailable('ExternalRecipientUnsupported');
    if (invitation.status !== 'pending' || invitation.invitedById !== actorId || draft.ownerId !== actorId)
      return unavailable('InvitationNotPending');
    if (!(await this.sourceAccess(tenantId, draftId, invitation.subjectId)))
      return unavailable('RecipientAccessUnavailable');
    const members = await this.prisma.withSystem(tx => tx.$queryRaw<Array<{
      subjectId: string; email: string; name: string;
    }>>`
      SELECT u.clerk_user_id AS "subjectId", u.email::text AS email,
        COALESCE(NULLIF(trim(concat_ws(' ',u.first_name,u.last_name)),''),'A teammate') AS name
      FROM users u JOIN tenant_memberships m ON m.user_id=u.id
      JOIN tenants t ON t.id=m.tenant_id
      WHERE m.tenant_id=${tenantId}::uuid AND m.status::text='active' AND t.status::text='active'
        AND m.role::text IN ('standard_user','user_admin','capiro_admin')
        AND u.clerk_user_id IN (${actorId},${invitation.subjectId})`);
    const recipient = members.find(member => member.subjectId === invitation.subjectId);
    const author = members.find(member => member.subjectId === actorId);
    if (!author || !recipient || recipient.subjectId === actorId ||
        !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(recipient.email) || recipient.email.length > 320)
      return unavailable('RecipientAccessUnavailable');
    return { ...identity, reason: null, invitation: {
      recipientId: recipient.subjectId, email: recipient.email, recipientName: recipient.name,
      authorName: author.name, title: draft.docTitle, role: invitation.role,
      updatedAt: invitation.updatedAt.toISOString(), clientId: draft.clientId, prospectId: draft.prospectId,
    } };
  }

  /** List collaborators (active + pending) plus the synthetic Owner first. */
  async list(tenantId: string, draftId: string, actorId?: string) {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(this.prisma, draft, actorId, canRead, 'read', async (db) => {
      const rows = await db.wsCollaborator.findMany({
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
    });
  }

  /** Both internal and external invitations start pending. */
  async invite(tenantId: string, draftId: string, inviterId: string, dto: InviteCollaboratorDto) {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(
      this.prisma,
      draft,
      inviterId,
      canManageCollaborators,
      'write',
      async (db) => {
        const subjectId = dto.subjectId?.trim() || null;
        const email = dto.email?.trim().toLowerCase() || null;
        await requireProspectInvitee(db, draft, subjectId);
        if (!subjectId && !email) {
          throw new BadRequestException('Provide a teammate (subjectId) or an email to invite');
        }

        if (subjectId) {
          // Internal teammate. Cannot invite the owner as a collaborator.
          if (subjectId === draft.ownerId) {
            throw new BadRequestException('This person is the document owner');
          }
          const existing = await db.wsCollaborator.findFirst({
            where: { tenantId, draftId, subjectId },
          });
          if (existing) {
            throw new BadRequestException('This teammate already has access or a pending invite');
          }
          // E-19: invites are PENDING until the invitee accepts (access is granted on
          // accept). An in-app notification lets them accept/decline from the bell.
          const row = await db.wsCollaborator.create({
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
        const existing = await db.wsCollaborator.findFirst({
          where: { tenantId, draftId, email },
        });
        if (existing) {
          throw new BadRequestException('This email already has access or a pending invite');
        }
        const row = await db.wsCollaborator.create({
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
      },
    );
  }

  /** Change a collaborator's role. Owner-only (enforced in the controller). */
  async updateRole(
    tenantId: string,
    draftId: string,
    collaboratorId: string,
    dto: UpdateCollaboratorDto,
    actorId?: string,
  ) {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(
      this.prisma,
      draft,
      actorId,
      canManageCollaborators,
      'write',
      async (db) => {
        const existing = await db.wsCollaborator.findFirst({
          where: { id: collaboratorId, tenantId, draftId },
        });
        if (!existing) throw new NotFoundException('Collaborator not found');
        return db.wsCollaborator.update({
          where: { id: collaboratorId },
          data: { role: dto.role },
        });
      },
    );
  }

  /** Remove a collaborator. Owner-only (enforced in the controller). The Owner
   *  is synthetic (no row) so it can never be removed here. */
  async remove(
    tenantId: string,
    draftId: string,
    collaboratorId: string,
    actorId?: string,
  ): Promise<{ deleted: boolean }> {
    const draft = await this.assertDraft(tenantId, draftId);
    return withProspectDraft(
      this.prisma,
      draft,
      actorId,
      canManageCollaborators,
      'read',
      async (db) => {
        const existing = await db.wsCollaborator.findFirst({
          where: { id: collaboratorId, tenantId, draftId },
        });
        if (!existing) throw new NotFoundException('Collaborator not found');
        await this.notifications.resolveInvite(collaboratorId);
        await db.wsCollaborator.delete({ where: { id: collaboratorId } });
        return { deleted: true };
      },
    );
  }

  /**
   * Invitee ACCEPTS their pending invite (E-19). Grants access (status → active,
   * which is what resolveRole/list gate on), clears the actionable invite
   * notification, and notifies the inviter. Only the invited subject may accept.
   */
  async accept(tenantId: string, draftId: string, collaboratorId: string, actorId: string) {
    const origin = await this.assertDraft(tenantId, draftId);
    return withProspectInvitation(this.prisma, origin, actorId, collaboratorId, async (db) => {
      const row = await db.wsCollaborator.findFirst({
        where: { id: collaboratorId, tenantId, draftId },
      });
      if (!row) throw new NotFoundException('Invitation not found');
      if (row.subjectId !== actorId) {
        throw new ForbiddenException('This invitation is not addressed to you');
      }
      await this.notifications.resolveInvite(collaboratorId);
      if (row.status === 'active') return row; // idempotent
      const updated = await db.wsCollaborator.update({
        where: { id: collaboratorId },
        data: { status: 'active' },
      });
      const draft = await db.wsDraft.findFirst({
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
    });
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
    const origin = await this.assertDraft(tenantId, draftId);
    return withProspectInvitation(this.prisma, origin, actorId, collaboratorId, async (db) => {
      const row = await db.wsCollaborator.findFirst({
        where: { id: collaboratorId, tenantId, draftId },
      });
      if (!row) throw new NotFoundException('Invitation not found');
      if (row.subjectId !== actorId) {
        throw new ForbiddenException('This invitation is not addressed to you');
      }
      await this.notifications.resolveInvite(collaboratorId);
      await db.wsCollaborator.delete({ where: { id: collaboratorId } });
      const draft = await db.wsDraft.findFirst({
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
    });
  }
}
