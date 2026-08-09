import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OutreachReasoningError } from './outreach-reasoning.contract.js';

const TURN_LEASE_MINUTES = 3;

@Injectable()
export class OutreachReasoningTurnClaimService {
  constructor(private readonly prisma: PrismaService) {}

  async claim(ctx: TenantContext, conversationId: string, turnId: string): Promise<void> {
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const changed = await tx.$executeRaw`
        UPDATE outreach_reasoning_conversations
        SET in_flight_turn_id = CAST(${turnId} AS uuid),
            in_flight_started_at = NOW(),
            last_used_at = NOW()
        WHERE id = CAST(${conversationId} AS uuid)
          AND tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND created_by_user_id = CAST(${ctx.userId} AS uuid)
          AND status = 'active'
          AND (
            in_flight_turn_id IS NULL
            OR in_flight_started_at < NOW() - (${TURN_LEASE_MINUTES} * INTERVAL '1 minute')
          )
      `;
      if (changed === 1) return;

      const owned = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM outreach_reasoning_conversations
        WHERE id = CAST(${conversationId} AS uuid)
          AND tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND created_by_user_id = CAST(${ctx.userId} AS uuid)
        LIMIT 1
      `;
      if (!owned[0]) {
        throw new OutreachReasoningError(
          'OUTREACH_REASONING_NOT_FOUND',
          'The requested Outreach reasoning conversation was not found.',
          404,
        );
      }
      throw new OutreachReasoningError(
        'OUTREACH_REASONING_LIMIT_EXCEEDED',
        'Another reasoning turn is already running for this conversation.',
        409,
        true,
      );
    });
  }

  async release(ctx: TenantContext, conversationId: string, turnId: string): Promise<void> {
    await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await tx.$executeRaw`
        UPDATE outreach_reasoning_conversations
        SET in_flight_turn_id = NULL,
            in_flight_started_at = NULL,
            last_used_at = NOW()
        WHERE id = CAST(${conversationId} AS uuid)
          AND tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND created_by_user_id = CAST(${ctx.userId} AS uuid)
          AND in_flight_turn_id = CAST(${turnId} AS uuid)
      `;
    });
  }
}
