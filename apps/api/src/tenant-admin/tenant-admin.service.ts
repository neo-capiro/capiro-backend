import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { ConfigService } from '@nestjs/config';
import type { OrganizationMembershipRole } from '@clerk/backend';
import { ClerkProvisioningService } from '../auth/clerk-provisioning.service.js';
import { ClerkService } from '../auth/clerk.service.js';
import { IdentityOutboxService } from '../auth/identity-outbox.service.js';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '@prisma/client';

interface InviteTeamMemberInput {
  email: string;
  role: 'user_admin' | 'standard_user';
  firstName?: string;
  lastName?: string;
  redirectUrl?: string;
}

interface UpdateBrandingInput {
  name?: string;
  // Logo upload itself is a separate presigned-URL flow - this only updates
  // the row metadata once the client has finished uploading.
  logoS3Key?: string;
  logoContentType?: string;
}

export interface ContactInfoInput {
  name?: string;
  phone?: string;
  email?: string;
  mailingStreet1?: string;
  mailingStreet2?: string;
  mailingCity?: string;
  mailingStateZip?: string;
  permanentStreet1?: string;
  permanentStreet2?: string;
  permanentCity?: string;
  permanentStateZip?: string;
}

export interface TenantAuditLogQuery {
  action?: string;
  entityType?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

/** Customer-safe audit fields — excludes internal detail (actorUserId is a
 *  Capiro-internal staff UUID; ip/userAgent/requestId are request metadata;
 *  before/after JSON can carry internal snapshots). */
const TENANT_AUDIT_SELECT = {
  id: true,
  action: true,
  actorRole: true,
  entityType: true,
  entityId: true,
  occurredAt: true,
} as const;

/**
 * Per-tenant admin operations. Caller must be `user_admin` (own tenant) or
 * `capiro_admin` (any tenant). Methods receive the TenantContext so RLS
 * scopes everything to the right tenant.
 */
@Injectable()
export class TenantAdminService {
  private readonly logger = new Logger(TenantAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clerk: ClerkService,
    private readonly provisioning: ClerkProvisioningService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly outbox: IdentityOutboxService,
  ) {}

  /**
   * Customer-facing audit trail — blocker #3(d). A tenant's own user_admin reads
   * its audit_logs, INCLUDING the privileged Capiro-staff actions now routed to
   * this tenant (impersonation start/end, user removal — see CapiroAdminService).
   * RLS-scoped via withTenant AND an explicit where.tenantId (defense-in-depth,
   * matches listTeam), and returns a redacted projection — never the raw row
   * (which carries the Capiro-internal actorUserId, request metadata, and
   * before/after JSON). Read-only; the append-only trigger only gates writes.
   */
  async listAuditLogs(ctx: TenantContext, query: TenantAuditLogQuery) {
    const { page, limit } = this.normalizePage(query.page, query.limit);
    const where: Prisma.AuditLogWhereInput = { tenantId: ctx.tenantId };
    if (query.action) where.action = query.action;
    if (query.entityType) where.entityType = query.entityType;
    const occurredAt = this.dateRange(query.from, query.to);
    if (occurredAt) where.occurredAt = occurredAt;
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [data, total] = await Promise.all([
        tx.auditLog.findMany({
          where,
          select: TENANT_AUDIT_SELECT,
          orderBy: { occurredAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        tx.auditLog.count({ where }),
      ]);
      return { data, total, page, limit };
    });
  }

  private normalizePage(page?: number, limit?: number): { page: number; limit: number } {
    const safePage = Number.isFinite(page) && (page ?? 0) >= 1 ? Math.floor(page!) : 1;
    const requested = Number.isFinite(limit) && (limit ?? 0) >= 1 ? Math.floor(limit!) : 50;
    return { page: safePage, limit: Math.min(requested, 100) };
  }

  private dateRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
    const filter: Prisma.DateTimeFilter = {};
    if (from) filter.gte = new Date(from);
    if (to) filter.lte = new Date(to);
    return Object.keys(filter).length ? filter : undefined;
  }

  async listTeam(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const memberships = await tx.tenantMembership.findMany({
        where: { tenantId: ctx.tenantId },
        include: {
          user: {
            select: { id: true, email: true, firstName: true, lastName: true, lastSeenAt: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      });
      return memberships.map((m) => ({
        membershipId: m.id,
        userId: m.user.id,
        email: m.user.email,
        firstName: m.user.firstName,
        lastName: m.user.lastName,
        role: m.role,
        status: m.status,
        billingAdmin: m.billingAdmin,
        joinedAt: m.joinedAt,
        lastSeenAt: m.user.lastSeenAt,
      }));
    });
  }

  /**
   * Grant/revoke the billing permission (onboarding v1 "Super Admin" bit).
   * Grantable by capiro_admin or a member who already holds it (Ninja
   * decision Q6 — no minimum count is enforced; if a tenant removes its last
   * billing admin, capiro_admin can re-grant). Only user_admins can hold it.
   */
  async setBillingAdmin(ctx: TenantContext, userId: string, billingAdmin: boolean) {
    if (ctx.role !== 'capiro_admin') {
      const caller = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.tenantMembership.findUnique({
          where: { tenantId_userId: { tenantId: ctx.tenantId, userId: ctx.userId } },
          select: { billingAdmin: true, status: true },
        }),
      );
      if (caller?.status !== 'active' || !caller.billingAdmin) {
        throw new ForbiddenException('Only a billing admin can change billing permissions');
      }
    }

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
        select: { role: true, status: true },
      });
      if (!membership) throw new NotFoundException('Membership not found');
      if (membership.status !== 'active') {
        throw new BadRequestException('Only active members can hold the billing permission');
      }
      if (billingAdmin && membership.role !== 'user_admin') {
        throw new BadRequestException('Only admins (user_admin) can be granted billing access');
      }
      await tx.tenantMembership.update({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
        data: { billingAdmin },
      });
      this.logger.log(
        `billing_admin ${billingAdmin ? 'granted to' : 'revoked from'} user ${userId} in tenant ${ctx.tenantId} by ${ctx.userId}`,
      );
      return { userId, billingAdmin };
    });
  }

  async listPendingInvitations(ctx: TenantContext) {
    const tenant = await this.prisma.withSystem(async (tx) =>
      tx.tenant.findUnique({ where: { id: ctx.tenantId } }),
    );
    if (!tenant?.clerkOrgId) return [];
    const pending = await this.clerk.backend.organizations.getOrganizationInvitationList({
      organizationId: tenant.clerkOrgId,
      status: ['pending'],
    });
    return pending.data.map((inv) => ({
      id: inv.id,
      email: inv.emailAddress,
      role: inv.role.toLowerCase().includes('admin') ? 'user_admin' : 'standard_user',
      createdAt: new Date(inv.createdAt).toISOString(),
      expiresAt: inv.expiresAt ? new Date(inv.expiresAt).toISOString() : null,
    }));
  }

  async inviteTeamMember(ctx: TenantContext, input: InviteTeamMemberInput) {
    const email = normalizeEmail(input.email);
    const firstName = input.firstName?.trim() || null;
    const lastName = input.lastName?.trim() || null;
    const tenant = await this.prisma.withSystem(async (tx) =>
      tx.tenant.findUnique({ where: { id: ctx.tenantId } }),
    );
    if (!tenant?.clerkOrgId) {
      throw new BadRequestException('Tenant has no Clerk organization linked');
    }

    const existingMember = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.tenantMembership.findFirst({
        where: {
          tenantId: ctx.tenantId,
          user: { email },
          status: 'active',
        },
        select: { id: true },
      }),
    );
    if (existingMember) {
      throw new BadRequestException('This person is already an active team member');
    }

    await this.revokePendingInvitationForEmail(tenant.clerkOrgId, email, ctx.clerkUserId);
    const invitation = await this.clerk.backend.organizations.createOrganizationInvitation({
      organizationId: tenant.clerkOrgId,
      emailAddress: email,
      role: toClerkOrganizationRole(input.role),
      // Carry the invitee's name through to sign-up; Clerk pre-fills the form
      // and the webhook persists firstName/lastName on user.created. We do NOT
      // pre-create a local users row here: the canonical user row is created
      // with the invitee's REAL clerkUserId on accept (webhook) or on first
      // authenticated request (tenant-context middleware self-heal). Pre-creating
      // a placeholder row keyed on a fake `pending:<id>` clerkUserId caused a
      // unique-email collision that 500'd every request after the user signed in.
      publicMetadata: {
        capiro_tenant_id: tenant.id,
        ...(firstName ? { first_name: firstName } : {}),
        ...(lastName ? { last_name: lastName } : {}),
      },
      redirectUrl: input.redirectUrl ?? this.defaultInvitationRedirectUrl(),
    });

    return {
      status: 'invited',
      invitation: {
        id: invitation.id,
        email: invitation.emailAddress,
        role: input.role,
        firstName,
        lastName,
        createdAt: new Date(invitation.createdAt).toISOString(),
        expiresAt: invitation.expiresAt ? new Date(invitation.expiresAt).toISOString() : null,
      },
    };
  }

  async resendInvitation(ctx: TenantContext, invitationId: string) {
    const tenant = await this.prisma.withSystem(async (tx) =>
      tx.tenant.findUnique({ where: { id: ctx.tenantId } }),
    );
    if (!tenant?.clerkOrgId) throw new BadRequestException('Tenant has no Clerk organization');
    const list = await this.clerk.backend.organizations.getOrganizationInvitationList({
      organizationId: tenant.clerkOrgId,
      status: ['pending'],
    });
    const found = list.data.find((inv) => inv.id === invitationId);
    if (!found) throw new NotFoundException('Invitation not found in this tenant');
    await this.clerk.backend.organizations.revokeOrganizationInvitation({
      organizationId: tenant.clerkOrgId,
      invitationId: found.id,
      requestingUserId: ctx.clerkUserId,
    });
    const fresh = await this.clerk.backend.organizations.createOrganizationInvitation({
      organizationId: tenant.clerkOrgId,
      emailAddress: found.emailAddress,
      role: found.role,
      redirectUrl: this.defaultInvitationRedirectUrl(),
    });
    return { invitationId: fresh.id };
  }

  async removeMember(ctx: TenantContext, userId: string) {
    if (userId === ctx.userId) {
      throw new BadRequestException('Cannot remove yourself');
    }

    // The local removal and the outbox job commit together; the Clerk call
    // happens AFTER the transaction closes.
    //
    // Previously the Clerk delete ran inside this transaction with its failure
    // swallowed, which meant (a) a fast Clerk error returned 200 {ok:true} while
    // the user kept their Clerk org membership and its tokens, and (b) a Clerk
    // call slower than the 5s interactive-transaction budget aborted the whole
    // transaction with P2028 — rolling back the removal and returning a 500
    // having changed nothing — while holding a pool connection across an
    // external HTTPS call.
    const { jobId } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
        include: { user: true, tenant: true },
      });
      if (!membership) throw new NotFoundException('Membership not found');
      await tx.tenantMembership.update({
        where: { id: membership.id },
        data: { status: 'removed' },
      });

      let queued: string | null = null;
      if (membership.tenant.clerkOrgId) {
        queued = await this.outbox.enqueueClerkMembershipDelete(tx, {
          tenantId: ctx.tenantId,
          clerkOrgId: membership.tenant.clerkOrgId,
          clerkUserId: membership.user.clerkUserId,
          membershipId: membership.id,
        });
      }
      return { jobId: queued };
    });

    // Best effort, outside the transaction. On failure the job stays pending and
    // the out-of-band drain retries it with backoff; local access is already
    // revoked either way because apps/api checks the local membership.
    if (jobId) await this.outbox.attemptNow(jobId);

    return { ok: true };
  }

  async updateMemberRole(ctx: TenantContext, userId: string, role: 'user_admin' | 'standard_user') {
    if (userId === ctx.userId) {
      throw new BadRequestException('Cannot change your own role');
    }

    const membership = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
        include: { user: true, tenant: true },
      }),
    );

    if (!membership) throw new NotFoundException('Membership not found');
    if (membership.status !== 'active') {
      throw new BadRequestException('Only active members can have their role changed');
    }
    if (membership.role === 'capiro_admin') {
      throw new ForbiddenException('Capiro admin roles are managed separately');
    }
    if (!membership.tenant.clerkOrgId) {
      throw new BadRequestException('Tenant has no Clerk organization linked');
    }

    const member = await this.provisioning.provisionOrganizationMember({
      tenantId: ctx.tenantId,
      organizationId: membership.tenant.clerkOrgId,
      email: membership.user.email,
      role,
      actorUserId: ctx.userId,
      actorClerkUserId: ctx.clerkUserId,
    });

    return { member, role };
  }

  async updateBranding(ctx: TenantContext, input: UpdateBrandingInput) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.logoS3Key !== undefined) {
        data.logoS3Key = input.logoS3Key;
        data.logoContentType = input.logoContentType ?? null;
        data.logoUploadedAt = new Date();
      }
      const updated = await tx.tenant.update({
        where: { id: ctx.tenantId },
        data,
      });
      // Mirror display name to Clerk (best-effort).
      if (input.name && updated.clerkOrgId) {
        await this.clerk.backend.organizations
          .updateOrganization(updated.clerkOrgId, { name: input.name })
          .catch(() => undefined);
      }
      return updated;
    });
  }

  async getContactInfo(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { settings: true },
      });
      const settings = (tenant?.settings ?? {}) as Record<string, unknown>;
      return (settings.contactInfo ?? {}) as Record<string, unknown>;
    });
  }

  async updateContactInfo(ctx: TenantContext, input: ContactInfoInput) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: { settings: true },
      });
      const currentSettings = (tenant?.settings ?? {}) as Record<string, unknown>;
      const updated = await tx.tenant.update({
        where: { id: ctx.tenantId },
        data: {
          settings: { ...currentSettings, contactInfo: input } as unknown as Prisma.InputJsonValue,
        },
        select: { settings: true },
      });
      const settings = updated.settings as Record<string, unknown>;
      return (settings.contactInfo ?? {}) as Record<string, unknown>;
    });
  }

  async getBilling(ctx: TenantContext) {
    // Billing surface is a stub until Stripe / Metronome lands. Returning a
    // structured placeholder so the UI can render a meaningful "coming soon"
    // card rather than a generic 404.
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({ where: { id: ctx.tenantId } });
      return {
        placeholder: true,
        message: 'Billing will be wired through Clerk + Stripe in a future release.',
        plan: tenant?.plan ?? 'unspecified',
      };
    });
  }

  private async revokePendingInvitationForEmail(
    organizationId: string,
    email: string,
    requestingUserId: string,
  ) {
    const pending = await this.clerk.backend.organizations.getOrganizationInvitationList({
      organizationId,
      status: ['pending'],
      limit: 100,
    });
    const existing = pending.data.find(
      (invitation) => invitation.emailAddress.toLowerCase() === email,
    );
    if (!existing) return;
    await this.clerk.backend.organizations.revokeOrganizationInvitation({
      organizationId,
      invitationId: existing.id,
      requestingUserId,
    });
  }

  private defaultInvitationRedirectUrl() {
    // WEB_ORIGIN is a *comma-separated list* of allowed origins, used by the
    // CORS check at the API edge, it must NOT be embedded whole into the
    // Clerk invitation redirect URL, or the link in the email looks like
    //   https://app-dev.capiro.ai,https://app.capiro.ai/sign-in
    // (which is what was being sent before this fix, producing broken
    // email links). Split, pick the first non-empty entry. Operators can
    // override with INVITATION_REDIRECT_URL when they want the invitation
    // link to go to a non-primary host.
    const override = this.config.get('INVITATION_REDIRECT_URL', { infer: true }) as
      | string
      | undefined;
    if (override) return override;
    const rawOrigin = this.config.get('WEB_ORIGIN', { infer: true }) as string | undefined;
    const firstOrigin = rawOrigin?.split(',')[0]?.trim();
    const origin =
      firstOrigin && /^https?:\/\//.test(firstOrigin) ? firstOrigin : 'https://app.capiro.ai';
    return `${origin.replace(/\/$/, '')}/sign-up`;
  }
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new BadRequestException('Email is required');
  return normalized;
}

function toClerkOrganizationRole(role: 'user_admin' | 'standard_user'): OrganizationMembershipRole {
  return (role === 'standard_user' ? 'org:member' : 'org:admin') as OrganizationMembershipRole;
}
