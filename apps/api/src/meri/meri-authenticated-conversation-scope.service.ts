import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';

/**
 * Authenticated conversation scope only. This is not a tool-eligibility
 * snapshot: it intentionally contains no candidate IDs or schema fingerprint.
 */
export interface MeriAuthenticatedConversationScope {
  contractVersion: 'meri.authenticated-conversation-scope.v1';
  eligibility: 'unresolved';
  unresolvedVersions: readonly ['capability-catalog', 'final-tool-schema'];
  tenantId: string;
  userId: string;
  surface: 'full_chat';
  conversationId: string;
  clientId: string | null;
  checkedAt: string;
}

@Injectable()
export class MeriAuthenticatedConversationScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    ctx: TenantContext,
    conversationId: string,
    assertedClientId?: string,
  ): Promise<MeriAuthenticatedConversationScope> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const conversation = await tx.clioConversation.findFirst({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          archivedAt: null,
        },
        select: { id: true, clientId: true },
      });
      if (!conversation) throw new NotFoundException('Meri conversation not found');

      // A caller-supplied client can only confirm the persisted scope, never
      // create or widen it. Treat stale focus as a hard mismatch.
      if (assertedClientId !== undefined && assertedClientId !== conversation.clientId) {
        throw new ConflictException('Requested client does not match conversation scope');
      }

      if (conversation.clientId !== null) {
        const client = await tx.client.findFirst({
          where: {
            id: conversation.clientId,
            tenantId: ctx.tenantId,
            status: { not: 'archived' },
          },
          select: { id: true },
        });
        if (!client) throw new NotFoundException('Meri conversation client not found');
        if (!(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, client.id))) {
          throw new ForbiddenException('Conversation client scope is restricted');
        }
      }

      return Object.freeze({
        contractVersion: 'meri.authenticated-conversation-scope.v1',
        eligibility: 'unresolved',
        unresolvedVersions: Object.freeze(['capability-catalog', 'final-tool-schema'] as const),
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        surface: 'full_chat',
        conversationId: conversation.id,
        clientId: conversation.clientId,
        checkedAt: new Date().toISOString(),
      });
    });
  }
}
