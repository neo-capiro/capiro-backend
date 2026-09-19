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
