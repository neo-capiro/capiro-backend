import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  OutreachReasoningError,
  type OutreachReasoningEffort,
  type OutreachReasoningStateMode,
} from './outreach-reasoning.contract.js';

export interface OutreachReasoningConversationRow {
  id: string;
  tenantId: string;
  sessionId: string;
  createdByUserId: string;
  provider: 'openai';
  stateMode: OutreachReasoningStateMode;
  model: string;
  reasoningEffort: OutreachReasoningEffort;
  lastResponseId: string | null;
  status: 'active' | 'archived';
  createdAt: Date;
  lastUsedAt: Date;
  archivedAt: Date | null;
}

@Injectable()
export class OutreachReasoningRepository {
  async getOwnedConversation(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    conversationId: string,
  ): Promise<OutreachReasoningConversationRow> {
    const rows = await tx.$queryRaw<OutreachReasoningConversationRow[]>`
      SELECT
        c.id,
        c.tenant_id AS "tenantId",
        c.session_id AS "sessionId",
        c.created_by_user_id AS "createdByUserId",
        c.provider,
        c.state_mode AS "stateMode",
        c.model,
        c.reasoning_effort AS "reasoningEffort",
        c.last_response_id AS "lastResponseId",
        c.status,
        c.created_at AS "createdAt",
        c.last_used_at AS "lastUsedAt",
        c.archived_at AS "archivedAt"
      FROM outreach_reasoning_conversations c
      INNER JOIN outreach_sessions s ON s.id = c.session_id
      WHERE c.id = CAST(${conversationId} AS uuid)
        AND c.tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND c.created_by_user_id = CAST(${ctx.userId} AS uuid)
        AND s.tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND s.created_by_user_id = CAST(${ctx.userId} AS uuid)
      LIMIT 1
    `;
    const conversation = rows[0];
    if (!conversation) throw reasoningNotFound();
    return conversation;
  }

  async archiveConversation(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    conversationId: string,
  ): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE outreach_reasoning_conversations
      SET status = 'archived', archived_at = NOW(), last_used_at = NOW()
      WHERE id = CAST(${conversationId} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND created_by_user_id = CAST(${ctx.userId} AS uuid)
        AND status = 'active'
    `;
    if (changed !== 1) throw reasoningNotFound();
  }
}

function reasoningNotFound() {
  return new OutreachReasoningError(
    'OUTREACH_REASONING_NOT_FOUND',
    'The requested Outreach reasoning conversation was not found.',
    404,
  );
}
