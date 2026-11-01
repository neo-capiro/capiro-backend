import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  OutreachReasoningRepository,
  type OutreachReasoningConversationRow,
} from './outreach-reasoning.repository.js';

/** Historical reasoning records remain readable; the SDK owns new Outreach sessions. */
@Injectable()
export class OutreachReasoningService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: OutreachReasoningRepository,
  ) {}

  async getConversation(ctx: TenantContext, conversationId: string) {
    const conversation = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.repository.getOwnedConversation(tx, ctx, conversationId),
    );
    return publicConversation(conversation);
  }

  async archiveConversation(ctx: TenantContext, conversationId: string) {
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.repository.archiveConversation(tx, ctx, conversationId),
    );
    return { id: conversationId, status: 'archived' as const };
  }
}

function publicConversation(conversation: OutreachReasoningConversationRow) {
  return {
    id: conversation.id,
    sessionId: conversation.sessionId,
    provider: conversation.provider,
    stateMode: conversation.stateMode,
    model: conversation.model,
    reasoningEffort: conversation.reasoningEffort,
    status: conversation.status,
    createdAt: conversation.createdAt,
    lastUsedAt: conversation.lastUsedAt,
  };
}
