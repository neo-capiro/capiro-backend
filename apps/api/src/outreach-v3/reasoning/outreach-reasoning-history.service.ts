import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OutreachReasoningRepository } from './outreach-reasoning.repository.js';

@Injectable()
export class OutreachReasoningHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: OutreachReasoningRepository,
  ) {}

  async listTurns(ctx: TenantContext, conversationId: string, limit = 50) {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 100);
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const conversation = await this.repository.getOwnedConversation(
        tx,
        ctx,
        conversationId,
      );
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
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
          status: string;
          failureCode: string | null;
          createdAt: Date;
        }>
      >`
        SELECT
          id,
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
        FROM outreach_reasoning_turns
        WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND conversation_id = CAST(${conversation.id} AS uuid)
          AND session_id = CAST(${conversation.sessionId} AS uuid)
        ORDER BY created_at DESC, id DESC
        LIMIT ${boundedLimit}
      `;

      return rows.reverse().map((row) => ({
        id: row.id,
        stateVersion: row.stateVersion,
        userMessage: row.userMessageText,
        assistantMessage: row.assistantMessageText,
        userMessageHash: row.userMessageHash,
        assistantMessageHash: row.assistantMessageHash,
        providerResponseRef:
          conversation.stateMode === 'provider_state' ? row.providerResponseId : null,
        toolResultRefs: row.toolResultRefsJsonb,
        proposalIds: row.proposalIdsJsonb,
        openQuestions: row.openQuestionsJsonb,
        usage: row.usageJsonb,
        latencyMs: row.latencyMs,
        status: row.status,
        failureCode: row.failureCode,
        createdAt: row.createdAt,
      }));
    });
  }
}
