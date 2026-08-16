import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  KnowledgeEventRecord,
  KnowledgeJsonObject,
  KnowledgeRef,
  NormalizedKnowledgeEventInput,
} from '../knowledge.types.js';

interface KnowledgeEventRow {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  source_type: string;
  source_id: string;
  source_version: string | null;
  source_content_hash: string;
  event_type: string;
  occurred_at: Date;
  observed_at: Date;
  ingested_at: Date;
  actor_refs: unknown;
  entity_refs: unknown;
  client_refs: unknown;
  sensitivity: string;
  access_scope: unknown;
  evidence_locator: unknown;
  metadata: unknown;
  origin_trace_id: string | null;
  status: string;
  created_at: Date;
}


/**
 * Tenant-bound append-only persistence for KnowledgeEvent.
 *
 * The runtime database role can bypass PostgreSQL RLS, so every raw statement
 * repeats the tenant predicate explicitly. There are intentionally no update or
 * delete methods on this repository.
 */
@Injectable()
export class KnowledgeEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async append(
    tenantId: string,
    input: NormalizedKnowledgeEventInput,
  ): Promise<KnowledgeEventRecord> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const inserted = await tx.$queryRaw<KnowledgeEventRow[]>`
        INSERT INTO knowledge_events (
          tenant_id,
          idempotency_key,
          source_type,
          source_id,
          source_version,
          source_content_hash,
          event_type,
          occurred_at,
          observed_at,
          actor_refs,
          entity_refs,
          client_refs,
          sensitivity,
          access_scope,
          evidence_locator,
          metadata,
          origin_trace_id,
          status
        )
        VALUES (
          ${tenantId}::uuid,
          ${input.idempotencyKey},
          ${input.sourceType},
          ${input.sourceId},
          ${input.sourceVersion},
          ${input.sourceContentHash},
          ${input.eventType},
          ${input.occurredAt},
          ${input.observedAt},
          CAST(${JSON.stringify(input.actorRefs)} AS jsonb),
          CAST(${JSON.stringify(input.entityRefs)} AS jsonb),
          CAST(${JSON.stringify(input.clientRefs)} AS jsonb),
          ${input.sensitivity},
          CAST(${JSON.stringify(input.accessScope)} AS jsonb),
          CAST(${JSON.stringify(input.evidenceLocator)} AS jsonb),
          CAST(${JSON.stringify(input.metadata)} AS jsonb),
          ${input.originTraceId},
          ${input.status}
        )
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING
          id,
          tenant_id,
          idempotency_key,
          source_type,
          source_id,
          source_version,
          source_content_hash,
          event_type,
          occurred_at,
          observed_at,
          ingested_at,
          actor_refs,
          entity_refs,
          client_refs,
          sensitivity,
          access_scope,
          evidence_locator,
          metadata,
          origin_trace_id,
          status,
          created_at
      `;
      if (inserted[0]) return mapEvent(inserted[0]);

      // Use a second statement so READ COMMITTED takes a fresh snapshot after a
      // concurrent writer wins the unique-key race.
      const existing = await tx.$queryRaw<KnowledgeEventRow[]>`
        SELECT
          id,
          tenant_id,
          idempotency_key,
          source_type,
          source_id,
          source_version,
          source_content_hash,
          event_type,
          occurred_at,
          observed_at,
          ingested_at,
          actor_refs,
          entity_refs,
          client_refs,
          sensitivity,
          access_scope,
          evidence_locator,
          metadata,
          origin_trace_id,
          status,
          created_at
        FROM knowledge_events
        WHERE tenant_id = ${tenantId}::uuid
          AND idempotency_key = ${input.idempotencyKey}
        LIMIT 1
      `;
      if (!existing[0]) {
        throw new InternalServerErrorException('Knowledge event append did not return a row.');
      }
      return mapEvent(existing[0]);
    });
  }

  async findById(tenantId: string, eventId: string): Promise<KnowledgeEventRecord | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<KnowledgeEventRow[]>`
        SELECT
          id,
          tenant_id,
          idempotency_key,
          source_type,
          source_id,
          source_version,
          source_content_hash,
          event_type,
          occurred_at,
          observed_at,
          ingested_at,
          actor_refs,
          entity_refs,
          client_refs,
          sensitivity,
          access_scope,
          evidence_locator,
          metadata,
          origin_trace_id,
          status,
          created_at
        FROM knowledge_events
        WHERE tenant_id = ${tenantId}::uuid
          AND id = ${eventId}::uuid
        LIMIT 1
      `;
      return rows[0] ? mapEvent(rows[0]) : null;
    });
  }
}

function mapEvent(row: KnowledgeEventRow): KnowledgeEventRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    idempotencyKey: row.idempotency_key,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceVersion: row.source_version,
    sourceContentHash: row.source_content_hash,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    observedAt: row.observed_at,
    ingestedAt: row.ingested_at,
    actorRefs: row.actor_refs as KnowledgeRef[],
    entityRefs: row.entity_refs as KnowledgeRef[],
    clientRefs: row.client_refs as KnowledgeRef[],
    sensitivity: row.sensitivity,
    accessScope: row.access_scope as KnowledgeJsonObject,
    evidenceLocator: row.evidence_locator as KnowledgeJsonObject,
    metadata: row.metadata as KnowledgeJsonObject,
    originTraceId: row.origin_trace_id,
    status: row.status as KnowledgeEventRecord['status'],
    createdAt: row.created_at,
  };
}

