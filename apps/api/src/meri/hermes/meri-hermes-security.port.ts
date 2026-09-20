/**
 * Server-only security envelope for a Hermes run: the client ids and mailbox
 * connections the actor may read. Model/browser input never supplies this.
 *
 * Production binds the token to `MeriContextPlaneService.securityEnvelope`
 * (the same resolver the Context Plane uses). The Phase 0 harness binds the
 * `DirectSecurityEnvelopePort` below — the identical Prisma predicate without
 * loading the Context Plane module — and labels itself as such.
 */
import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';

export const MERI_HERMES_SECURITY_ENVELOPE = Symbol('MERI_HERMES_SECURITY_ENVELOPE');

export interface MeriHermesSecurityEnvelope {
  authorizedClientIds: string[];
  authorizedMailboxConnectionIds: string[];
}

export interface MeriHermesSecurityEnvelopePort {
  securityEnvelope(ctx: TenantContext): Promise<MeriHermesSecurityEnvelope>;
}

const MAILBOX_PROVIDERS = ['microsoft_365', 'google_workspace', 'imap_caldav'] as const;

/**
 * GRANT LIFECYCLE — read this before "fixing" the `memoryAccessGrants`
 * predicate below (closeout finding A1).
 *
 * `Client.memoryAccessGrants` is the `ClientMemoryAccess[]` relation
 * (`client_memory_access`): id, tenant_id, client_id, user_id, granted_by,
 * created_at, and nothing else — migration 20260719220000_client_memory_walls.
 * There is no `status`, `expiresAt` or `revokedAt` to test; the generated
 * `ClientMemoryAccessWhereInput` has no such fields, so the filter A1 asks
 * for does not type-check. Revocation of an ethical-wall grant is a hard
 * DELETE (`ClientsService.setMemoryAccess()` replace-set), which this
 * `some: { userId }` therefore honours immediately.
 *
 * The model that DOES carry `status` / `expiresAt` / `revokedAt` is
 * `MemoryAccessGrant` (`memory_access_grant`), reached from Client as
 * `governedMemoryGrants`. It carries governed-memory permissions, not wall
 * membership, and is enforced separately in `MemoryAuthorizationService`.
 * Adding it to the OR below would WIDEN `authorizedClientIds`, not tighten
 * it.
 *
 * This predicate is intentionally byte-identical to
 * `MeriContextPlaneService.securityEnvelope()` — the production binding this
 * port stands in for. Any change to one must be made to both.
 */

@Injectable()
export class DirectSecurityEnvelopePort implements MeriHermesSecurityEnvelopePort {
  constructor(private readonly prisma: PrismaService) {}

  async securityEnvelope(ctx: TenantContext): Promise<MeriHermesSecurityEnvelope> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const [clients, mailboxes] = await Promise.all([
        tx.client.findMany({
          where: {
            tenantId: ctx.tenantId,
            OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: ctx.userId } } }],
          },
          select: { id: true },
          orderBy: { id: 'asc' },
        }),
        tx.integrationConnection.findMany({
          where: {
            tenantId: ctx.tenantId,
            createdByUserId: ctx.userId,
            provider: { in: [...MAILBOX_PROVIDERS] },
          },
          select: { id: true },
          orderBy: { id: 'asc' },
        }),
      ]);
      return {
        authorizedClientIds: clients.map((c) => c.id),
        authorizedMailboxConnectionIds: mailboxes.map((m) => m.id),
      };
    });
  }
}
