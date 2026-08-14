import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  KnowledgeEvidenceRecord,
  NormalizedKnowledgeEvidenceInput,
} from '../knowledge.types.js';

interface KnowledgeEvidenceRow {
  id: string;
  tenant_id: string;
  assertion_id: string;
  event_id: string;
  source_type: string;
  source_id: string;
  excerpt: string;
  start_offset: number;
  end_offset: number;
  content_hash: string;
  created_at: Date;
}

/** Tenant-bound, append-only persistence for excerpt-level assertion proof. */
@Injectable()
export class KnowledgeEvidenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Called only from KnowledgeAssertionRepository's tenant transaction so the
   * assertion and all of its proof either commit together or not at all.
   */
  async appendManyInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    assertionId: string,
    inputs: readonly NormalizedKnowledgeEvidenceInput[],
  ): Promise<KnowledgeEvidenceRecord[]> {
    if (inputs.length === 0) {
      throw new InternalServerErrorException('Knowledge assertion evidence is required.');
    }

    const records: KnowledgeEvidenceRecord[] = [];
    for (const input of inputs) {
      const inserted = await tx.$queryRaw<KnowledgeEvidenceRow[]>`
        INSERT INTO knowledge_evidence (
          tenant_id,
          assertion_id,
          event_id,
          source_type,
          source_id,
          excerpt,
          start_offset,
          end_offset,
          content_hash
        )
        VALUES (
          ${tenantId}::uuid,
          ${assertionId}::uuid,
          ${input.eventId}::uuid,
          ${input.sourceType},
          ${input.sourceId},
          ${input.excerpt},
          ${input.startOffset},
          ${input.endOffset},
          ${input.contentHash}
        )
        ON CONFLICT (
          tenant_id,
          assertion_id,
          event_id,
          content_hash,
          start_offset,
          end_offset
        ) DO NOTHING
        RETURNING
          id,
          tenant_id,
          assertion_id,
          event_id,
          source_type,
          source_id,
          excerpt,
          start_offset,
          end_offset,
          content_hash,
          created_at
      `;
      if (inserted[0]) {
        records.push(mapEvidence(inserted[0]));
        continue;
      }

      const existing = await tx.$queryRaw<KnowledgeEvidenceRow[]>`
        SELECT
          id,
          tenant_id,
          assertion_id,
          event_id,
          source_type,
          source_id,
          excerpt,
          start_offset,
          end_offset,
          content_hash,
          created_at
        FROM knowledge_evidence
        WHERE tenant_id = ${tenantId}::uuid
          AND assertion_id = ${assertionId}::uuid
          AND event_id = ${input.eventId}::uuid
          AND content_hash = ${input.contentHash}
          AND start_offset = ${input.startOffset}
          AND end_offset = ${input.endOffset}
        LIMIT 1
      `;
      if (!existing[0]) {
        throw new InternalServerErrorException(
          'Knowledge evidence append did not return a row.',
        );
      }
      records.push(mapEvidence(existing[0]));
    }
    return records;
  }

  async findByAssertionId(
    tenantId: string,
    assertionId: string,
  ): Promise<KnowledgeEvidenceRecord[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<KnowledgeEvidenceRow[]>`
        SELECT
          id,
          tenant_id,
          assertion_id,
          event_id,
          source_type,
          source_id,
          excerpt,
          start_offset,
          end_offset,
          content_hash,
          created_at
        FROM knowledge_evidence
        WHERE tenant_id = ${tenantId}::uuid
          AND assertion_id = ${assertionId}::uuid
        ORDER BY created_at ASC, id ASC
      `;
      return rows.map(mapEvidence);
    });
  }

  async findByEventId(
    tenantId: string,
    eventId: string,
  ): Promise<KnowledgeEvidenceRecord[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<KnowledgeEvidenceRow[]>`
        SELECT
          id,
          tenant_id,
          assertion_id,
          event_id,
          source_type,
          source_id,
          excerpt,
          start_offset,
          end_offset,
          content_hash,
          created_at
        FROM knowledge_evidence
        WHERE tenant_id = ${tenantId}::uuid
          AND event_id = ${eventId}::uuid
        ORDER BY created_at ASC, id ASC
      `;
      return rows.map(mapEvidence);
    });
  }

  async findBySource(
    tenantId: string,
    sourceType: string,
    sourceId: string,
  ): Promise<KnowledgeEvidenceRecord[]> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<KnowledgeEvidenceRow[]>`
        SELECT
          id,
          tenant_id,
          assertion_id,
          event_id,
          source_type,
          source_id,
          excerpt,
          start_offset,
          end_offset,
          content_hash,
          created_at
        FROM knowledge_evidence
        WHERE tenant_id = ${tenantId}::uuid
          AND source_type = ${sourceType}
          AND source_id = ${sourceId}
        ORDER BY created_at ASC, id ASC
      `;
      return rows.map(mapEvidence);
    });
  }
}

function mapEvidence(row: KnowledgeEvidenceRow): KnowledgeEvidenceRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    assertionId: row.assertion_id,
    eventId: row.event_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    excerpt: row.excerpt,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}
