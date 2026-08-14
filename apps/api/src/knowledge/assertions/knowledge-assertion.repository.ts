import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  KnowledgeAssertionRecord,
  KnowledgeJsonObject,
  KnowledgeJsonValue,
  NormalizedKnowledgeAssertionInput,
} from '../knowledge.types.js';

interface KnowledgeAssertionRow {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  origin_event_id: string;
  subject_type: string;
  subject_id: string;
  predicate: string;
  object_type: string;
  object_id: string | null;
  object_value: unknown;
  assertion_class: string;
  confidence: unknown;
  authority: string;
  observed_at: Date;
  valid_from: Date;
  valid_until: Date | null;
  status: string;
  conflict_status: string;
  conflict_group_id: string | null;
  supersedes_assertion_id: string | null;
  contradicts_assertion_id: string | null;
  sensitivity: string;
  access_scope: unknown;
  created_by: string | null;
  created_at: Date;
}

/**
 * Tenant-bound append-only persistence for atomic KnowledgeAssertions.
 * All raw SQL repeats tenant_id because the application role can bypass RLS.
 */
@Injectable()
export class KnowledgeAssertionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async append(
    tenantId: string,
    input: NormalizedKnowledgeAssertionInput,
  ): Promise<KnowledgeAssertionRecord> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const inserted = await tx.$queryRaw<KnowledgeAssertionRow[]>`
        INSERT INTO knowledge_assertions (
          tenant_id,
          idempotency_key,
          origin_event_id,
          subject_type,
          subject_id,
          predicate,
          object_type,
          object_id,
          object_value,
          assertion_class,
          confidence,
          authority,
          observed_at,
          valid_from,
          valid_until,
          status,
          conflict_status,
          conflict_group_id,
          supersedes_assertion_id,
          contradicts_assertion_id,
          sensitivity,
          access_scope,
          created_by
        )
        VALUES (
          ${tenantId}::uuid,
          ${input.idempotencyKey},
          ${input.originEventId}::uuid,
          ${input.subjectType},
          ${input.subjectId},
          ${input.predicate},
          ${input.objectType},
          ${input.objectId},
          CAST(${input.objectValue === null ? null : JSON.stringify(input.objectValue)} AS jsonb),
          ${input.assertionClass},
          ${input.confidence},
          ${input.authority},
          ${input.observedAt},
          ${input.validFrom},
          ${input.validUntil},
          ${input.status},
          ${input.conflictStatus},
          ${input.conflictGroupId}::uuid,
          ${input.supersedesAssertionId}::uuid,
          ${input.contradictsAssertionId}::uuid,
          ${input.sensitivity},
          CAST(${JSON.stringify(input.accessScope)} AS jsonb),
          ${input.createdBy}::uuid
        )
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING
          id,
          tenant_id,
          idempotency_key,
          origin_event_id,
          subject_type,
          subject_id,
          predicate,
          object_type,
          object_id,
          object_value,
          assertion_class,
          confidence,
          authority,
          observed_at,
          valid_from,
          valid_until,
          status,
          conflict_status,
          conflict_group_id,
          supersedes_assertion_id,
          contradicts_assertion_id,
          sensitivity,
          access_scope,
          created_by,
          created_at
      `;
      if (inserted[0]) return mapAssertion(inserted[0]);

      const existing = await tx.$queryRaw<KnowledgeAssertionRow[]>`
        SELECT
          id,
          tenant_id,
          idempotency_key,
          origin_event_id,
          subject_type,
          subject_id,
          predicate,
          object_type,
          object_id,
          object_value,
          assertion_class,
          confidence,
          authority,
          observed_at,
          valid_from,
          valid_until,
          status,
          conflict_status,
          conflict_group_id,
          supersedes_assertion_id,
          contradicts_assertion_id,
          sensitivity,
          access_scope,
          created_by,
          created_at
        FROM knowledge_assertions
        WHERE tenant_id = ${tenantId}::uuid
          AND idempotency_key = ${input.idempotencyKey}
        LIMIT 1
      `;
      if (!existing[0]) {
        throw new InternalServerErrorException(
          'Knowledge assertion append did not return a row.',
        );
      }
      return mapAssertion(existing[0]);
    });
  }

  async findById(
    tenantId: string,
    assertionId: string,
  ): Promise<KnowledgeAssertionRecord | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<KnowledgeAssertionRow[]>`
        SELECT
          id,
          tenant_id,
          idempotency_key,
          origin_event_id,
          subject_type,
          subject_id,
          predicate,
          object_type,
          object_id,
          object_value,
          assertion_class,
          confidence,
          authority,
          observed_at,
          valid_from,
          valid_until,
          status,
          conflict_status,
          conflict_group_id,
          supersedes_assertion_id,
          contradicts_assertion_id,
          sensitivity,
          access_scope,
          created_by,
          created_at
        FROM knowledge_assertions
        WHERE tenant_id = ${tenantId}::uuid
          AND id = ${assertionId}::uuid
        LIMIT 1
      `;
      return rows[0] ? mapAssertion(rows[0]) : null;
    });
  }
}

function mapAssertion(row: KnowledgeAssertionRow): KnowledgeAssertionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    idempotencyKey: row.idempotency_key,
    originEventId: row.origin_event_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    predicate: row.predicate,
    objectType: row.object_type,
    objectId: row.object_id,
    objectValue: row.object_value as KnowledgeJsonValue | null,
    assertionClass: row.assertion_class as KnowledgeAssertionRecord['assertionClass'],
    confidence: Number(row.confidence),
    authority: row.authority as KnowledgeAssertionRecord['authority'],
    observedAt: row.observed_at,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    status: row.status as KnowledgeAssertionRecord['status'],
    conflictStatus: row.conflict_status as KnowledgeAssertionRecord['conflictStatus'],
    conflictGroupId: row.conflict_group_id,
    supersedesAssertionId: row.supersedes_assertion_id,
    contradictsAssertionId: row.contradicts_assertion_id,
    sensitivity: row.sensitivity,
    accessScope: row.access_scope as KnowledgeJsonObject,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
