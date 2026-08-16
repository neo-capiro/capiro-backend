import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  OutreachStateRepository,
  type OutreachEventRow,
} from '../persistence/outreach-state.repository.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';

export const OUTREACH_USER_DECISION_EVENT_TYPES = [
  'approach_approved',
  'draft_version_approved',
  'send_settings_updated',
  'held_recipients_acknowledged',
  'learning_proposal_approved',
  'learning_proposal_skipped',
] as const;
export type OutreachUserDecisionEventType = (typeof OUTREACH_USER_DECISION_EVENT_TYPES)[number];

@Injectable()
export class OutreachUserDecisionEventService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: OutreachStateRepository,
  ) {}

  /**
   * Append one bounded human decision without changing Campaign Spec state.
   * Exact-state expectation prevents approving a decision after upstream state
   * moved. Same event type + payload hash is idempotent.
   */
  async append(
    ctx: TenantContext,
    sessionId: string,
    input: {
      eventType: OutreachUserDecisionEventType;
      expectedStateVersion: number;
      payloadHash: string;
      safeMetadata: Record<string, unknown>;
    },
  ): Promise<{ event: OutreachEventRow; idempotent: boolean }> {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const session = await this.state.lockOwnedSession(tx, ctx, sessionId);
      if (session.status !== 'active') {
        throw new OutreachCommandError(
          'OUTREACH_SESSION_ARCHIVED',
          'Archived outreach sessions cannot accept new approval decisions.',
          409,
        );
      }
      if (session.currentStateVersion !== input.expectedStateVersion) {
        throw new OutreachCommandError(
          'OUTREACH_STATE_CONFLICT',
          'The outreach campaign changed before the approval decision could be committed.',
          409,
          { currentStateVersion: session.currentStateVersion },
        );
      }

      const existing = await tx.$queryRaw<OutreachEventRow[]>`
        SELECT
          id,
          sequence,
          event_type AS "eventType",
          actor_user_id AS "actorUserId",
          source,
          state_version_before AS "stateVersionBefore",
          state_version_after AS "stateVersionAfter",
          command_batch_id AS "commandBatchId",
          command_type AS "commandType",
          payload_hash AS "payloadHash",
          safe_metadata_jsonb AS "safeMetadataJsonb",
          created_at AS "createdAt"
        FROM outreach_events
        WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND session_id = CAST(${sessionId} AS uuid)
          AND event_type = ${input.eventType}
          AND payload_hash = ${input.payloadHash}
        ORDER BY sequence DESC
        LIMIT 1
      `;
      if (existing[0]) return { event: existing[0], idempotent: true };

      const event = await this.state.appendEvent(tx, ctx, session, {
        eventType: input.eventType,
        source: 'user_control',
        stateVersionBefore: session.currentStateVersion,
        stateVersionAfter: session.currentStateVersion,
        payloadHash: input.payloadHash,
        safeMetadata: input.safeMetadata,
      });
      return { event, idempotent: false };
    });
  }

  async latest(
    ctx: TenantContext,
    sessionId: string,
    eventType: OutreachUserDecisionEventType,
  ): Promise<OutreachEventRow | null> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.state.getOwnedSession(tx, ctx, sessionId);
      const rows = await tx.$queryRaw<OutreachEventRow[]>`
        SELECT
          id,
          sequence,
          event_type AS "eventType",
          actor_user_id AS "actorUserId",
          source,
          state_version_before AS "stateVersionBefore",
          state_version_after AS "stateVersionAfter",
          command_batch_id AS "commandBatchId",
          command_type AS "commandType",
          payload_hash AS "payloadHash",
          safe_metadata_jsonb AS "safeMetadataJsonb",
          created_at AS "createdAt"
        FROM outreach_events
        WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND session_id = CAST(${sessionId} AS uuid)
          AND event_type = ${eventType}
        ORDER BY sequence DESC
        LIMIT 1
      `;
      return rows[0] ?? null;
    });
  }
}
