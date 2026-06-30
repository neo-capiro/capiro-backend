import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { TenantRole } from '@capiro/shared';
import type { MeriContext } from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import type { OrchestratorTenantContext } from '../auth/tenant-context.js';

/**
 * Builds a full `MeriContext` from the guard's verified `OrchestratorTenantContext`.
 *
 * The Capiro `userId` is resolved from the globally-unique `clerk_user_id`
 * (the `User` table is global; the PER-TENANT membership check is enforced by
 * apps/api on the delegated call, so this lookup is identity resolution, not an
 * authorization decision). Throws 401 if the verified Clerk user has no Capiro
 * User row — fail closed, never synthesize an id.
 */
@Injectable()
export class MeriContextResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(tc: OrchestratorTenantContext): Promise<MeriContext> {
    const user = await this.prisma.user.findUnique({
      where: { clerkUserId: tc.clerkUserId },
      select: { id: true },
    });
    if (!user) {
      throw new UnauthorizedException('No Capiro user for the authenticated identity');
    }
    return {
      tenantId: tc.tenantId,
      userId: user.id,
      clerkUserId: tc.clerkUserId,
      role: mapRole(tc.role),
    };
  }
}

/**
 * Map the Clerk org role carried on the guard context to a `TenantRole`. The
 * CANONICAL mapping is owned by apps/api (mapClerkRoleToCapiro) and the
 * delegated api call is the authority on per-user permissions, so this is
 * informational for Phase 0. Map conservatively (admin → user_admin, otherwise
 * the least-privileged standard_user) so a wrong guess can only ever DENY, not
 * escalate.
 */
function mapRole(role: string | null): TenantRole {
  if (role && /admin/i.test(role)) return 'user_admin';
  return 'standard_user';
}
