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

  async resolve(tc: OrchestratorTenantContext, clientId?: string | null): Promise<MeriContext> {
    const user = await this.prisma.user.findUnique({
      where: { clerkUserId: tc.clerkUserId },
      select: { id: true },
    });
    if (!user) {
      throw new UnauthorizedException('No Capiro user for the authenticated identity');
    }

    let firmMemory: MeriContext['firmMemory'] | undefined;
    let userVoice: string | undefined;
    let clientSteering: MeriContext['clientSteering'] | undefined;
    try {
      // Client-steering/people layers ride the SAME compiler, requested only when
      // the turn is scoped to a client (the adapter gates them on clientId).
      const layers = clientId
        ? (['firm-identity', 'user-voice', 'client-steering', 'client-people'] as const)
        : (['firm-identity', 'user-voice'] as const);
      const packet = await this.contextCompiler.compile({
        tenantId: tc.tenantId,
        userId: user.id,
        surface: 'ga-chat',
        layers: [...layers],
        ...(clientId ? { clientId } : {}),
      });
      const soul = renderedBody(packet, 'firm-soul');
      const compass = renderedBody(packet, 'firm-compass');
      firmMemory =
        soul || compass
          ? { ...(soul ? { soul } : {}), ...(compass ? { compass } : {}) }
          : undefined;
      userVoice = renderedBody(packet, 'user-voice') || undefined;
      if (clientId) {
        const cSoul = renderedBody(packet, 'client-soul');
        const cCompass = renderedBody(packet, 'client-compass');
        const cPeople = renderedBody(packet, 'client-people');
        clientSteering =
          cSoul || cCompass || cPeople
            ? {
                ...(cSoul ? { soul: cSoul } : {}),
                ...(cCompass ? { compass: cCompass } : {}),
                ...(cPeople ? { people: cPeople } : {}),
              }
            : undefined;
      }
    } catch (e) {
      this.logger.warn(`context compile failed (non-fatal): ${(e as Error).message}`);
    }

    // AUTHORITATIVE client roster (1B.1): the system of record for "who are my
    // clients" is the `client` table, NOT clio_memory. Load it tenant-scoped
    // (RLS via withTenant) so the chat prompt can answer roster questions from
    // real data and refuse to enumerate clients from memory. Best-effort: a
    // load failure must never block a turn (the block is simply omitted).
    let clientRoster: MeriContext['clientRoster'] | undefined;
    try {
      const rows = await this.prisma.withTenant(tc.tenantId, (tx) =>
        tx.client.findMany({
          where: { tenantId: tc.tenantId },
          select: { name: true, status: true },
          orderBy: { name: 'asc' },
          take: 500,
        }),
      );
      if (rows.length) clientRoster = rows.map((r) => ({ name: r.name, status: r.status }));
    } catch (e) {
      this.logger.warn(`client roster load failed (non-fatal): ${(e as Error).message}`);
    }

    return {
      tenantId: tc.tenantId,
      userId: user.id,
      clerkUserId: tc.clerkUserId,
      role: mapRole(tc.role),
      ...(firmMemory ? { firmMemory } : {}),
      ...(userVoice ? { userVoice } : {}),
      ...(clientRoster ? { clientRoster } : {}),
      ...(clientSteering ? { clientSteering } : {}),
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
