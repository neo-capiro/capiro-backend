import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  NormalizedTemporalKnowledgeGraphHistoryInput,
  NormalizedTemporalKnowledgeGraphWalkInput,
  TemporalKnowledgeGraphEdge,
} from './temporal-knowledge-graph.types.js';

interface TemporalGraphRow {
  depth?: number | null;
  src_canonical_entity_id: string;
  dst_canonical_entity_id: string;
  edge_type: string;
  confidence: unknown;
  observed_at: Date;
  valid_from: Date;
  valid_until: Date | null;
  assertion_id: string;
  event_id: string;
  evidence_id: string;
  evidence_source_type: string;
  evidence_source_id: string;
  evidence_content_hash: string;
  evidence_start_offset: number;
  evidence_end_offset: number;
  sensitivity: string;
  client_ref_keys: string[];
}

/**
 * Phase 8 read boundary. Raw SQL always repeats tenantId even though the call is
 * also wrapped in withTenant: capiro_app can bypass RLS in current deployments,
 * so the SECURITY DEFINER function's mandatory tenant/security parameters are
 * the binding isolation layer, not an implicit session assumption.
 */
@Injectable()
export class TemporalKnowledgeGraphRepository {
  constructor(private readonly prisma: PrismaService) {}

  async walkAsOf(
    input: NormalizedTemporalKnowledgeGraphWalkInput,
  ): Promise<TemporalKnowledgeGraphEdge[]> {
    return this.prisma.withTenant(input.tenantId, async (tx) => {
      // A function-level statement_timeout cannot re-arm the already-running
      // invoking statement. Match the hardened Track B graph path: SET LOCAL in
      // the caller transaction is the real pooled-connection starvation guard.
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '3s'`);
      const rows = await tx.$queryRaw<TemporalGraphRow[]>(Prisma.sql`
        SELECT *
        FROM kg_temporal_walk_bounded(
          ${input.tenantId}::uuid,
          ${input.sensitivity},
          CAST(${JSON.stringify(input.accessScope)} AS jsonb),
          ${textArray(input.clientRefKeys)},
          ${input.canonicalEntityId}::uuid,
          ${input.asOf},
          ${input.maxDepth},
          ${nullableTextArray(input.edgeTypes)},
          ${input.fanout},
          ${input.rowBudget},
          ${input.direction}
        )
      `);
      return rows.map((row) => mapEdge(row, row.depth ?? null));
    });
  }

  async relationHistory(
    input: NormalizedTemporalKnowledgeGraphHistoryInput,
  ): Promise<TemporalKnowledgeGraphEdge[]> {
    return this.prisma.withTenant(input.tenantId, async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '3s'`);
      const rows = await tx.$queryRaw<TemporalGraphRow[]>(Prisma.sql`
        SELECT *
        FROM kg_temporal_relation_history(
          ${input.tenantId}::uuid,
          ${input.sensitivity},
          CAST(${JSON.stringify(input.accessScope)} AS jsonb),
          ${textArray(input.clientRefKeys)},
          ${input.canonicalEntityId}::uuid,
          ${input.windowStart},
          ${input.windowEnd},
          ${input.observedThrough},
          ${nullableTextArray(input.edgeTypes)},
          ${input.rowBudget},
          ${input.direction}
        )
      `);
      return rows.map((row) => mapEdge(row, null));
    });
  }
}

function textArray(values: readonly string[]): Prisma.Sql {
  return values.length === 0
    ? Prisma.sql`ARRAY[]::text[]`
    : Prisma.sql`ARRAY[${Prisma.join([...values])}]::text[]`;
}

function nullableTextArray(values: readonly string[] | null): Prisma.Sql {
  return values === null ? Prisma.sql`NULL::text[]` : textArray(values);
}

function mapEdge(row: TemporalGraphRow, depth: number | null): TemporalKnowledgeGraphEdge {
  return {
    depth,
    srcCanonicalEntityId: row.src_canonical_entity_id,
    dstCanonicalEntityId: row.dst_canonical_entity_id,
    edgeType: row.edge_type,
    confidence: Number(row.confidence),
    observedAt: row.observed_at,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    assertionId: row.assertion_id,
    eventId: row.event_id,
    evidence: {
      id: row.evidence_id,
      sourceType: row.evidence_source_type,
      sourceId: row.evidence_source_id,
      contentHash: row.evidence_content_hash,
      startOffset: row.evidence_start_offset,
      endOffset: row.evidence_end_offset,
    },
    sensitivity: row.sensitivity,
    clientRefKeys: [...row.client_ref_keys],
  };
}
