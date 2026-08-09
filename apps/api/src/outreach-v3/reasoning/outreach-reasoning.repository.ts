import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { OutreachReasoningError, type OutreachReasoningEffort, type OutreachReasoningStateMode } from './outreach-reasoning.contract.js';

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

export interface OutreachReasoningTurnRow {
  id: string;
  conversationId: string;
  sessionId: string;
  stateVersion: number;
  userMessageText: string | null;
  assistantMessageText: string | null;
  userMessageHash: string;
  assistantMessageHash: string | null;
  providerResponseId: string | null;
  toolResultRefsJsonb: unknown;
  proposalIdsJsonb: unknown;
  openQuestionsJsonb: unknown;
  usageJsonb: unknown;
  latencyMs: number;
  status: 'succeeded' | 'failed';
  failureCode: string | null;
  createdAt: Date;
}

@Injectable()
export class OutreachReasoningRepository {
  async createConversation(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    input: {
      sessionId: string;
      stateMode: OutreachReasoningStateMode;
      model: string;
      reasoningEffort: OutreachReasoningEffort;
    },
  ): Promise<OutreachReasoningConversationRow> {
    const rows = await tx.$queryRaw<OutreachReasoningConversationRow[]>`
      INSERT INTO outreach_reasoning_conversations (
        tenant_id, session_id, created_by_user_id, provider, state_mode,
        model, reasoning_effort, last_response_id, status
      )
      SELECT
        CAST(${ctx.tenantId} AS uuid), s.id, CAST(${ctx.userId} AS uuid), 'openai',
        ${input.stateMode}, ${input.model}, ${input.reasoningEffort}, NULL, 'active'
      FROM outreach_sessions s
      WHERE s.id = CAST(${input.sessionId} AS uuid)
        AND s.tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND s.created_by_user_id = CAST(${ctx.userId} AS uuid)
        AND s.status = 'active'
      RETURNING
        id,
        tenant_id AS "tenantId",
        session_id AS "sessionId",
        created_by_user_id AS "createdByUserId",
        provider,
        state_mode AS "stateMode",
        model,
        reasoning_effort AS "reasoningEffort",
        last_response_id AS "lastResponseId",
        status,
        created_at AS "createdAt",
        last_used_at AS "lastUsedAt",
        archived_at AS "archivedAt"
    `;
    const conversation = rows[0];
    if (!conversation) {
      throw new OutreachReasoningError(
        'OUTREACH_REASONING_NOT_FOUND',
        'The requested Outreach session was not found or is not active.',
        404,
      );
    }
    return conversation;
  }

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

  async lockOwnedConversation(
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
      FOR UPDATE OF c
    `;
    const conversation = rows[0];
    if (!conversation) throw reasoningNotFound();
    return conversation;
  }

  async recentTranscript(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    conversationId: string,
    limit: number,
  ): Promise<Array<{ role: 'user' | 'assistant'; text: string }>> {
    await this.getOwnedConversation(tx, ctx, conversationId);
    const rows = await tx.$queryRaw<
      Array<{ userMessageText: string | null; assistantMessageText: string | null }>
    >`
      SELECT
        user_message_text AS "userMessageText",
        assistant_message_text AS "assistantMessageText"
      FROM outreach_reasoning_turns
      WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND conversation_id = CAST(${conversationId} AS uuid)
        AND status = 'succeeded'
        AND user_message_text IS NOT NULL
        AND assistant_message_text IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `;

    return rows.reverse().flatMap((row) => [
      { role: 'user' as const, text: row.userMessageText! },
      { role: 'assistant' as const, text: row.assistantMessageText! },
    ]);
  }

  async appendSucceededTurn(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    conversation: OutreachReasoningConversationRow,
    input: {
      stateVersion: number;
      userMessageText: string | null;
      assistantMessageText: string | null;
      userMessageHash: string;
      assistantMessageHash: string;
      providerResponseId: string | null;
      toolResultRefs: unknown;
      proposalIds: string[];
      openQuestions: unknown;
      usage: unknown;
      latencyMs: number;
    },
  ): Promise<OutreachReasoningTurnRow> {
    const toolRefs = JSON.stringify(input.toolResultRefs);
    const proposalIds = JSON.stringify(input.proposalIds);
    const openQuestions = JSON.stringify(input.openQuestions);
    const usage = JSON.stringify(input.usage);
    const rows = await tx.$queryRaw<OutreachReasoningTurnRow[]>`
      INSERT INTO outreach_reasoning_turns (
        tenant_id, conversation_id, session_id, actor_user_id, state_version,
        user_message_text, assistant_message_text, user_message_hash,
        assistant_message_hash, provider_response_id, tool_result_refs_jsonb,
        proposal_ids_jsonb, open_questions_jsonb, usage_jsonb, latency_ms,
        status, failure_code
      ) VALUES (
        CAST(${ctx.tenantId} AS uuid), CAST(${conversation.id} AS uuid),
        CAST(${conversation.sessionId} AS uuid), CAST(${ctx.userId} AS uuid),
        ${input.stateVersion}, ${input.userMessageText}, ${input.assistantMessageText},
        ${input.userMessageHash}, ${input.assistantMessageHash}, ${input.providerResponseId},
        CAST(${toolRefs} AS jsonb), CAST(${proposalIds} AS jsonb),
        CAST(${openQuestions} AS jsonb), CAST(${usage} AS jsonb), ${input.latencyMs},
        'succeeded', NULL
      )
      RETURNING
        id,
        conversation_id AS "conversationId",
        session_id AS "sessionId",
        state_version AS "stateVersion",
        user_message_text AS "userMessageText",
        assistant_message_text AS "assistantMessageText",
        user_message_hash AS "userMessageHash",
        assistant_message_hash AS "assistantMessageHash",
        provider_response_id AS "providerResponseId",
        tool_result_refs_jsonb AS "toolResultRefsJsonb",
        proposal_ids_jsonb AS "proposalIdsJsonb",
        open_questions_jsonb AS "openQuestionsJsonb",
        usage_jsonb AS "usageJsonb",
        latency_ms AS "latencyMs",
        status,
        failure_code AS "failureCode",
        created_at AS "createdAt"
    `;
    const turn = rows[0];
    if (!turn) throw new Error('OUTREACH_REASONING_TURN_CREATE_FAILED');
    return turn;
  }

  async appendFailedTurn(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    conversation: OutreachReasoningConversationRow,
    input: {
      stateVersion: number;
      userMessageText: string | null;
      userMessageHash: string;
      failureCode: string;
      latencyMs: number;
    },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO outreach_reasoning_turns (
        tenant_id, conversation_id, session_id, actor_user_id, state_version,
        user_message_text, assistant_message_text, user_message_hash,
        assistant_message_hash, provider_response_id, tool_result_refs_jsonb,
        proposal_ids_jsonb, open_questions_jsonb, usage_jsonb, latency_ms,
        status, failure_code
      ) VALUES (
        CAST(${ctx.tenantId} AS uuid), CAST(${conversation.id} AS uuid),
        CAST(${conversation.sessionId} AS uuid), CAST(${ctx.userId} AS uuid),
        ${input.stateVersion}, ${input.userMessageText}, NULL, ${input.userMessageHash},
        NULL, NULL, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        ${input.latencyMs}, 'failed', ${input.failureCode}
      )
    `;
  }

  async updateAfterTurn(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    conversationId: string,
    providerResponseId: string | null,
  ): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE outreach_reasoning_conversations
      SET last_response_id = ${providerResponseId}, last_used_at = NOW()
      WHERE id = CAST(${conversationId} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND created_by_user_id = CAST(${ctx.userId} AS uuid)
        AND status = 'active'
    `;
    if (changed !== 1) throw reasoningNotFound();
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
