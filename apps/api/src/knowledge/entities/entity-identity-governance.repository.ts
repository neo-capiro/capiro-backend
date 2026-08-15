import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  EntityIdentityGovernanceEventRecord,
  GovernEntityLinkInput,
  RejectResolutionGovernanceInput,
  RejectedEntityResolutionResult,
} from './entity-identity-governance.types.js';

interface ResolutionIdentityRow {
  id: string;
}

interface GovernanceEventIdRow {
  event_id: string;
}

interface GovernanceEventRow {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  action_type: EntityIdentityGovernanceEventRecord['actionType'];
  subject_type: EntityIdentityGovernanceEventRecord['subjectType'];
  subject_id: string;
  entity_id: string | null;
  actor_user_id: string;
  reason_code: string;
  reason: string | null;
  metadata: unknown;
  created_at: Date;
}

/**
 * Tenant-bound persistence for reviewed canonical identity actions.
 *
 * EntityResolution and governance events are append-only. Tenant-private alias
 * and identifier mutations are available only through the audited database
 * functions introduced by the Phase 5 governance migration.
 */
@Injectable()
export class EntityIdentityGovernanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async recordResolutionConfirmation(
    tenantId: string,
    originalResolutionId: string,
    correctedResolutionId: string,
    selectedEntityId: string,
    actorUserId: string,
    reason: string | null,
    idempotencyKey: string,
  ): Promise<string> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const inserted = await tx.$queryRaw<GovernanceEventIdRow[]>`
        INSERT INTO entity_identity_governance_events (
          tenant_id,
          idempotency_key,
          action_type,
          subject_type,
          subject_id,
          entity_id,
          actor_user_id,
          reason_code,
          reason,
          metadata
        )
        VALUES (
          ${tenantId}::uuid,
          ${idempotencyKey},
          'resolution_confirmed',
          'resolution',
          ${originalResolutionId}::uuid,
          ${selectedEntityId}::uuid,
          ${actorUserId}::uuid,
          'user_confirmed',
          ${reason?.trim() || null},
          jsonb_build_object('correctedResolutionId', ${correctedResolutionId})
        )
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING id AS event_id
      `;

      const eventId =
        inserted[0]?.event_id ??
        (
          await tx.$queryRaw<GovernanceEventIdRow[]>`
            SELECT id AS event_id
            FROM entity_identity_governance_events
            WHERE tenant_id = ${tenantId}::uuid
              AND idempotency_key = ${idempotencyKey}
            LIMIT 1
          `
        )[0]?.event_id;
      if (!eventId) {
        throw new InternalServerErrorException(
          'Resolution confirmation event did not return a row.',
        );
      }
      return eventId;
    });
  }

  async rejectResolution(
    tenantId: string,
    input: RejectResolutionGovernanceInput,
    idempotencyKey: string,
    reasonCode: string,
  ): Promise<RejectedEntityResolutionResult> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const previous = await tx.$queryRaw<ResolutionIdentityRow[]>`
        SELECT id
        FROM entity_resolutions
        WHERE tenant_id = ${tenantId}::uuid
          AND id = ${input.resolutionId}::uuid
        LIMIT 1
      `;
      if (!previous[0]) throw new NotFoundException('Entity resolution not found.');

      const rejected = await tx.$queryRaw<ResolutionIdentityRow[]>`
        INSERT INTO entity_resolutions (
          tenant_id,
          idempotency_key,
          actor_user_id,
          raw_input,
          normalized_input,
          entity_type_hint,
          candidate_entity_ids,
          selected_entity_id,
          status,
          confidence,
          resolution_method,
          provenance,
          correction_of_resolution_id
        )
        SELECT
          previous.tenant_id,
          ${idempotencyKey},
          ${input.actorUserId}::uuid,
          previous.raw_input,
          previous.normalized_input,
          previous.entity_type_hint,
          previous.candidate_entity_ids,
          NULL,
          'rejected',
          0.0000,
          'user_rejected',
          previous.provenance || jsonb_build_array(
            jsonb_strip_nulls(jsonb_build_object(
              'sourceType', 'user_rejection',
              'sourceId', ${input.actorUserId},
              'matchValue', ${input.reason?.trim() || null},
              'reasonCode', ${reasonCode}
            ))
          ),
          NULL
        FROM entity_resolutions AS previous
        WHERE previous.tenant_id = ${tenantId}::uuid
          AND previous.id = ${input.resolutionId}::uuid
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING id
      `;

      const rejectedResolutionId =
        rejected[0]?.id ??
        (
          await tx.$queryRaw<ResolutionIdentityRow[]>`
            SELECT id
            FROM entity_resolutions
            WHERE tenant_id = ${tenantId}::uuid
              AND idempotency_key = ${idempotencyKey}
            LIMIT 1
          `
        )[0]?.id;
      if (!rejectedResolutionId) {
        throw new InternalServerErrorException(
          'Rejected entity resolution append did not return a row.',
        );
      }

      const insertedEvent = await tx.$queryRaw<GovernanceEventIdRow[]>`
        INSERT INTO entity_identity_governance_events (
          tenant_id,
          idempotency_key,
          action_type,
          subject_type,
          subject_id,
          entity_id,
          actor_user_id,
          reason_code,
          reason,
          metadata
        )
        VALUES (
          ${tenantId}::uuid,
          ${idempotencyKey},
          'resolution_rejected',
          'resolution',
          ${input.resolutionId}::uuid,
          NULL,
          ${input.actorUserId}::uuid,
          ${reasonCode},
          ${input.reason?.trim() || null},
          jsonb_build_object('rejectedResolutionId', ${rejectedResolutionId})
        )
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING id AS event_id
      `;

      const governanceEventId =
        insertedEvent[0]?.event_id ??
        (
          await tx.$queryRaw<GovernanceEventIdRow[]>`
            SELECT id AS event_id
            FROM entity_identity_governance_events
            WHERE tenant_id = ${tenantId}::uuid
              AND idempotency_key = ${idempotencyKey}
            LIMIT 1
          `
        )[0]?.event_id;
      if (!governanceEventId) {
        throw new InternalServerErrorException(
          'Entity governance event append did not return a row.',
        );
      }

      return {
        resolutionId: rejectedResolutionId,
        status: 'rejected',
        governanceEventId,
      };
    });
  }

  async governAlias(
    tenantId: string,
    action: 'confirm' | 'withdraw',
    input: GovernEntityLinkInput,
    idempotencyKey: string,
    reasonCode: string,
  ): Promise<string> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<GovernanceEventIdRow[]>`
        SELECT govern_entity_alias(
          ${tenantId}::uuid,
          ${input.linkId}::uuid,
          ${action},
          ${input.actorUserId}::uuid,
          ${reasonCode},
          ${input.reason?.trim() || null},
          ${idempotencyKey}
        ) AS event_id
      `;
      if (!rows[0]?.event_id) {
        throw new InternalServerErrorException(
          'Alias governance action did not return an event.',
        );
      }
      return rows[0].event_id;
    });
  }

  async governIdentifier(
    tenantId: string,
    action: 'confirm' | 'withdraw',
    input: GovernEntityLinkInput,
    idempotencyKey: string,
    reasonCode: string,
  ): Promise<string> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<GovernanceEventIdRow[]>`
        SELECT govern_entity_identifier(
          ${tenantId}::uuid,
          ${input.linkId}::uuid,
          ${action},
          ${input.actorUserId}::uuid,
          ${reasonCode},
          ${input.reason?.trim() || null},
          ${idempotencyKey}
        ) AS event_id
      `;
      if (!rows[0]?.event_id) {
        throw new InternalServerErrorException(
          'Identifier governance action did not return an event.',
        );
      }
      return rows[0].event_id;
    });
  }

  async listSubjectEvents(
    tenantId: string,
    subjectType: EntityIdentityGovernanceEventRecord['subjectType'],
    subjectId: string,
    limit = 50,
  ): Promise<EntityIdentityGovernanceEventRecord[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<GovernanceEventRow[]>`
        SELECT
          id,
          tenant_id,
          idempotency_key,
          action_type,
          subject_type,
          subject_id,
          entity_id,
          actor_user_id,
          reason_code,
          reason,
          metadata,
          created_at
        FROM entity_identity_governance_events
        WHERE tenant_id = ${tenantId}::uuid
          AND subject_type = ${subjectType}
          AND subject_id = ${subjectId}::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT ${boundedLimit}
      `;
      return rows.map(mapGovernanceEvent);
    });
  }
}

function mapGovernanceEvent(
  row: GovernanceEventRow,
): EntityIdentityGovernanceEventRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    idempotencyKey: row.idempotency_key,
    actionType: row.action_type,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    entityId: row.entity_id,
    actorUserId: row.actor_user_id,
    reasonCode: row.reason_code,
    reason: row.reason,
    metadata:
      row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
    createdAt: row.created_at,
  };
}
