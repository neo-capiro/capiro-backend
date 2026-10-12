import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { OrganizationInvitation, OrganizationMembership } from '@clerk/backend';
import { ClerkService } from '../auth/clerk.service.js';
import { TenantAdminService } from '../tenant-admin/tenant-admin.service.js';

/** Approved by Neo on October 7: newsletter account invitations only.
 * Installed @clerk/backend 1.34.0 performs one fetch per organization call.
 * No provider mutations are retried here. The durable receipt owns attempts.
 * The SDK exposes no per-call AbortSignal; a caller deadline therefore means
 * an unknown outcome, and later reads reconcile it without repeating a POST. */
@Injectable()
export class NewsletterAccountProvider {
  constructor(
    private readonly clerk: ClerkService,
    private readonly team: TenantAdminService,
  ) {}
  actor(
    organizationId: string,
    userId: string,
  ): Promise<{ data: OrganizationMembership[]; totalCount: number }> {
    return this.clerk.backend.organizations.getOrganizationMembershipList({
      organizationId,
      userId: [userId],
      limit: 1,
    });
  }
  pending(
    organizationId: string,
    offset: number,
  ): Promise<{ data: OrganizationInvitation[]; totalCount: number }> {
    return this.clerk.backend.organizations.getOrganizationInvitationList({
      organizationId,
      status: ['pending'],
      limit: 100,
      offset,
    });
  }
  get(organizationId: string, invitationId: string): Promise<OrganizationInvitation> {
    return this.clerk.backend.organizations.getOrganizationInvitation({
      organizationId,
      invitationId,
    });
  }
  create(
    organizationId: string,
    authorId: string,
    email: string,
    role: 'org:member' | 'org:admin',
    redirectUrl: string,
    tenantId: string,
    requestId: string,
  ): Promise<OrganizationInvitation> {
    return this.clerk.backend.organizations.createOrganizationInvitation({
      organizationId,
      inviterUserId: authorId,
      emailAddress: email,
      role,
      redirectUrl,
      publicMetadata: { capiro_tenant_id: tenantId, capiro_newsletter_invitation_id: requestId },
    });
  }
  promote(ctx: TenantContext, userId: string) {
    return this.team.updateMemberRole(ctx, userId, 'user_admin');
  }
}
