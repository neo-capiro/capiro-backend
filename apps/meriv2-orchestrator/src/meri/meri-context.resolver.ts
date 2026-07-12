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
    const [firmMemory, userVoice] = await Promise.all([
      this.loadFirmMemory(tc.tenantId),
      this.loadUserVoice(tc.tenantId, user.id),
    ]);
    return {
      tenantId: tc.tenantId,
      userId: user.id,
      clerkUserId: tc.clerkUserId,
      role: mapRole(tc.role),
      ...(firmMemory ? { firmMemory } : {}),
      ...(userVoice ? { userVoice } : {}),
    };
  }

  /**
   * Firm Soul + Firm Compass (memory_items type='firm-soul'/'firm-compass',
   * slug='firm', visibility='tenant') — unconditional, every tool call carries
   * firm identity. Mirrors apps/api meri.service.ts's loadUserVoiceContext.
   * Best-effort: a query failure must never block a tool invocation.
   */
  private async loadFirmMemory(tenantId: string): Promise<MeriContext['firmMemory'] | undefined> {
    try {
      const rows = await this.prisma.withTenant(
        tenantId,
        (tx) =>
          tx.$queryRaw<Array<{ type: string; sections: unknown }>>`
          SELECT type, sections_jsonb AS sections
          FROM memory_items
          WHERE tenant_id = ${tenantId}::uuid
            AND type IN ('firm-soul', 'firm-compass')
            AND slug = 'firm'
        `,
      );
      const bodyFor = (t: string): string | undefined => {
        const row = rows.find((r) => r.type === t);
        return row ? renderHumanSections(row.sections) : undefined;
      };
      const soul = bodyFor('firm-soul');
      const compass = bodyFor('firm-compass');
      if (!soul && !compass) return undefined;
      return { ...(soul ? { soul } : {}), ...(compass ? { compass } : {}) };
    } catch {
      return undefined;
    }
  }

  /**
   * The caller's "My Writing Style" file (memory_items type='user-voice',
   * owner_user_id=userId). Best-effort, same failure contract as loadFirmMemory.
   *
   * MUST use withTenantUser, not withTenant: this row is `visibility='user'`
   * (private), and the Phase 1 owner-aware RLS policy hides it unless
   * `app.current_user` is set to the caller's own id (see PrismaService's doc
   * comment). Using plain withTenant here silently returned zero rows for
   * every GA-chat turn from the moment the 1C policy went live — fixed
   * 2026-07-12 (Phase 2 audit).
   */
  private async loadUserVoice(tenantId: string, userId: string): Promise<string | undefined> {
    try {
      const rows = await this.prisma.withTenantUser(
        tenantId,
        userId,
        (tx) =>
          tx.$queryRaw<Array<{ sections: unknown }>>`
          SELECT sections_jsonb AS sections
          FROM memory_items
          WHERE tenant_id = ${tenantId}::uuid
            AND type = 'user-voice'
            AND owner_user_id = ${userId}::uuid
          LIMIT 1
        `,
      );
      const body = rows[0] ? renderHumanSections(rows[0].sections) : undefined;
      return body || undefined;
    } catch {
      return undefined;
    }
  }
}

/** Render only human-authored sections as "Heading: body" lines. Pure. */
function renderHumanSections(sections: unknown): string | undefined {
  if (!Array.isArray(sections)) return undefined;
  const body = sections
    .filter((s) => s && typeof s === 'object' && (s as { owner?: string }).owner === 'human')
    .map((s) => {
      const sec = s as { heading?: string; body?: string };
      return sec.body?.trim() ? `${sec.heading}: ${sec.body.trim()}` : '';
    })
    .filter(Boolean)
    .join('\n');
  return body || undefined;
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
