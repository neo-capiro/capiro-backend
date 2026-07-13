import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { TenantRole } from '@capiro/shared';
import { renderedBody, type MeriContext } from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import { OrchestratorContextCompilerService } from './context-compiler.service.js';
import type { OrchestratorTenantContext } from '../auth/tenant-context.js';

/**
 * Builds a full `MeriContext` from the guard's verified `OrchestratorTenantContext`.
 *
 * The Capiro `userId` is resolved from the globally-unique `clerk_user_id`
 * (the `User` table is global; the PER-TENANT membership check is enforced by
 * apps/api on the delegated call, so this lookup is identity resolution, not an
 * authorization decision). Throws 401 if the verified Clerk user has no Capiro
 * User row — fail closed, never synthesize an id.
 *
 * Firm identity + user voice load through the shared Context Compiler (G1-b)
 * — the same contract, owner-aware tenancy discipline (withTenantUser; the 1C
 * RLS policy hides private user-voice rows otherwise — the exact per-surface
 * drift that silently broke GA-chat voice on 2026-07-12) and packet trace as
 * every other Meri surface. Best-effort: a compile failure must never block a
 * chat turn, so the context simply arrives without firm/voice blocks.
 */
@Injectable()
export class MeriContextResolver {
  private readonly logger = new Logger(MeriContextResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contextCompiler: OrchestratorContextCompilerService,
  ) {}

  async resolve(tc: OrchestratorTenantContext): Promise<MeriContext> {
    const user = await this.prisma.user.findUnique({
      where: { clerkUserId: tc.clerkUserId },
      select: { id: true },
    });
    if (!user) {
      throw new UnauthorizedException('No Capiro user for the authenticated identity');
    }

    let firmMemory: MeriContext['firmMemory'] | undefined;
    let userVoice: string | undefined;
    try {
      const packet = await this.contextCompiler.compile({
        tenantId: tc.tenantId,
        userId: user.id,
        surface: 'ga-chat',
        layers: ['firm-identity', 'user-voice'],
      });
      const soul = renderedBody(packet, 'firm-soul');
      const compass = renderedBody(packet, 'firm-compass');
      firmMemory =
        soul || compass
          ? { ...(soul ? { soul } : {}), ...(compass ? { compass } : {}) }
          : undefined;
      userVoice = renderedBody(packet, 'user-voice') || undefined;
    } catch (e) {
      this.logger.warn(`context compile failed (non-fatal): ${(e as Error).message}`);
    }

    return {
      tenantId: tc.tenantId,
      userId: user.id,
      clerkUserId: tc.clerkUserId,
      role: mapRole(tc.role),
      ...(firmMemory ? { firmMemory } : {}),
      ...(userVoice ? { userVoice } : {}),
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
