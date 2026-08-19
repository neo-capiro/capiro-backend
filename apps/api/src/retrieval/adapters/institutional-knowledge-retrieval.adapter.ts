import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../../embeddings/embedding-provider.js';
import { TemporalKnowledgeGraphService } from '../../knowledge/graph/temporal-knowledge-graph.service.js';
import type { TemporalKnowledgeGraphEdge } from '../../knowledge/graph/temporal-knowledge-graph.types.js';
import type { KnowledgeJsonObject } from '../../knowledge/knowledge.types.js';
import {
  governedRecallSuppressionEnabled,
  TERMINAL_GOVERNED_STATUSES,
} from '../../memory/memory-recall-suppression.helpers.js';
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RetrievalSourceAdapter } from '../retrieval-source.adapter.js';
import type {
  RetrievalRecord,
  RetrievalRequest,
  RetrievalSourceResult,
  SemanticDatasetDescriptor,
} from '../retrieval-v2.types.js';

const MAX_GRAPH_ROWS_PER_CALL = 500;
const MAX_MEMORY_ROWS_PER_CALL = 500;
const DEFAULT_MEMORY_PAGE_SIZE = 50;
const MEMORY_QUERY_CLASSES = new Set(['lookup', 'semantic_recall']);

interface GovernedMemoryRow {
  id: string;
  key: string;
  value: string;
  scope: string;
  clientId: string | null;
  updatedAt: Date;
}

function edgePayload(edge: TemporalKnowledgeGraphEdge): KnowledgeJsonObject {
  return {
    depth: edge.depth,
    srcCanonicalEntityId: edge.srcCanonicalEntityId,
    dstCanonicalEntityId: edge.dstCanonicalEntityId,
    edgeType: edge.edgeType,
    confidence: edge.confidence,
    observedAt: edge.observedAt.toISOString(),
    validFrom: edge.validFrom.toISOString(),
    validUntil: edge.validUntil?.toISOString() ?? null,
    assertionId: edge.assertionId,
    eventId: edge.eventId,
    evidence: {
      id: edge.evidence.id,
      sourceType: edge.evidence.sourceType,
      sourceId: edge.evidence.sourceId,
      contentHash: edge.evidence.contentHash,
      startOffset: edge.evidence.startOffset,
      endOffset: edge.evidence.endOffset,
    },
    sensitivity: edge.sensitivity,
    clientRefKeys: edge.clientRefKeys,
  };
}

@Injectable()
export class InstitutionalKnowledgeRetrievalAdapter implements RetrievalSourceAdapter {
  readonly key = 'knowledge-plane-temporal-graph';
  readonly domains = ['institutional_knowledge'] as const;

  constructor(
    private readonly graph: TemporalKnowledgeGraphService,
    private readonly prisma: PrismaService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddingProvider: EmbeddingProvider,
  ) {}

  async retrieve(
    dataset: SemanticDatasetDescriptor,
    request: RetrievalRequest,
    cursor?: string,
  ): Promise<RetrievalSourceResult> {
    // Phase 19: durable Meri recall is no longer allowed to bypass Retrieval V2.
    // `clio_memory` remains the write-side store during the migration, but reads
    // enter the shared plane through the existing institutional_knowledge domain.
    // Graph/history classes continue down the original temporal-graph path.
    if (MEMORY_QUERY_CLASSES.has(request.queryClass)) {
      return this.retrieveGovernedMemory(dataset, request, cursor);
    }
    return this.retrieveTemporalGraph(dataset, request);
  }

  private async retrieveGovernedMemory(
    dataset: SemanticDatasetDescriptor,
    request: RetrievalRequest,
    cursor?: string,
  ): Promise<RetrievalSourceResult> {
    const requestedClientIds = uniqueStrings(request.caller.clientIds ?? []);
    const authorizationWasSpecified = request.caller.authorizedClientIds !== undefined;
    const authorizedClientIds = uniqueStrings(request.caller.authorizedClientIds ?? []);
    const requestedOutsideEnvelope =
      authorizationWasSpecified &&
      requestedClientIds.some((clientId) => !authorizedClientIds.includes(clientId));
    const requestedEntityCount = requestedClientIds.length;

    if (requestedOutsideEnvelope) {
      return this.memoryUnauthorized(dataset, requestedEntityCount, 'requested_client_scope_not_authorized');
    }

    const offset = parseMemoryCursor(cursor);
    if (offset === null) {
      return this.unsupported(dataset, requestedEntityCount, 'invalid_memory_cursor');
    }
    const pageSize = Math.min(
      Math.max(request.pageSize ?? DEFAULT_MEMORY_PAGE_SIZE, 1),
      MAX_MEMORY_ROWS_PER_CALL,
    );

    return this.prisma.withTenantUser(
      request.caller.tenantId,
      request.caller.userId,
      async (tx) => {
        const allowedClientIds: string[] = [];
        for (const clientId of requestedClientIds) {
          if (await clientMemoryAllowed(tx, request.caller.tenantId, request.caller.userId, clientId)) {
            allowedClientIds.push(clientId);
          }
        }
        if (allowedClientIds.length !== requestedClientIds.length) {
          return this.memoryUnauthorized(
            dataset,
            requestedEntityCount,
            'requested_client_scope_failed_ethical_wall',
          );
        }

        const rows = await tx.clioMemory.findMany({
          where: {
            tenantId: request.caller.tenantId,
            AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
            OR: [
              { scope: 'firm' },
              { scope: 'user_private', ownerUserId: request.caller.userId },
              ...(allowedClientIds.length
                ? [{ scope: 'client', clientId: { in: allowedClientIds } }]
                : []),
            ],
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          take: MAX_MEMORY_ROWS_PER_CALL + 1,
          select: {
            id: true,
            key: true,
            value: true,
            scope: true,
            clientId: true,
            updatedAt: true,
          },
        });

        const hardTruncated = rows.length > MAX_MEMORY_ROWS_PER_CALL;
        let eligible = rows.slice(0, MAX_MEMORY_ROWS_PER_CALL) as GovernedMemoryRow[];
        if (governedRecallSuppressionEnabled() && eligible.length > 0) {
          const slugs = eligible.map((row) => `clio:${row.id}`);
          const suppressed = await tx.$queryRaw<Array<{ slug: string }>>`
            SELECT slug FROM memory_items
            WHERE tenant_id = ${request.caller.tenantId}::uuid
              AND type = 'note'
              AND slug = ANY(${slugs}::text[])
              AND governed_status = ANY(${[...TERMINAL_GOVERNED_STATUSES]}::text[])
          `;
          const blocked = new Set(suppressed.map((row) => row.slug));
          eligible = eligible.filter((row) => !blocked.has(`clio:${row.id}`));
        }

        const ranked = await this.rankMemories(tx, request, eligible);
        const pageRows = ranked.slice(offset, offset + pageSize);
        const hasMore = offset + pageSize < ranked.length;
        const nextCursor = hasMore ? `memory:${offset + pageSize}` : undefined;
        const semanticDegraded =
          request.queryClass === 'semantic_recall' && ranked.some((entry) => entry.semanticMissing);
        const sourceDegraded = hardTruncated || semanticDegraded;
        const paginationComplete = !hasMore && !hardTruncated;
        const records = pageRows.map(({ row, semanticScore }) => memoryRecord(row, semanticScore));
        const lastSyncAt = eligible.reduce<Date | undefined>(
          (latest, row) => (!latest || row.updatedAt > latest ? row.updatedAt : latest),
          undefined,
        );

        return {
          domain: dataset.domain,
          records,
          total: eligible.length,
          returned: records.length,
          hasMore,
          nextCursor,
          truncated: hardTruncated,
          sourceStatus: sourceDegraded ? 'degraded' : 'healthy',
          lastSyncAt,
          recordsEvaluated: eligible.length,
          requestedEntityCount,
          searchedEntityCount: allowedClientIds.length,
          pagesRead: 1,
          paginationComplete,
          coverageComplete: paginationComplete && !sourceDegraded,
          stopReason: hardTruncated
            ? 'governed_memory_safety_cap_reached'
            : semanticDegraded
              ? 'governed_memory_semantic_projection_incomplete'
              : hasMore
                ? 'governed_memory_page_boundary_reached'
                : 'governed_memory_scan_complete',
        };
      },
    );
  }

  private async rankMemories(
    tx: Prisma.TransactionClient,
    request: RetrievalRequest,
    rows: GovernedMemoryRow[],
  ): Promise<Array<{ row: GovernedMemoryRow; semanticScore: number | null; semanticMissing: boolean }>> {
    const lexical = lexicalScores(rows, request.query ?? '');
    if (request.queryClass !== 'semantic_recall' || !(request.query ?? '').trim() || rows.length === 0) {
      return rows
        .map((row) => ({ row, semanticScore: null, semanticMissing: false }))
        .sort((a, b) => compareMemoryRank(a.row, b.row, lexical));
    }

    let vector: number[] | null = null;
    try {
      vector = await this.embeddingProvider.embed((request.query ?? '').trim());
    } catch {
      vector = null;
    }
    if (!vector || vector.some((value) => !Number.isFinite(value))) {
      return rows
        .map((row) => ({ row, semanticScore: null, semanticMissing: true }))
        .sort((a, b) => compareMemoryRank(a.row, b.row, lexical));
    }

    const slugs = rows.map((row) => `clio:${row.id}`);
    const literal = `[${vector.join(',')}]`;
    let scores: Array<{ slug: string; score: number }> = [];
    try {
      scores = await tx.$queryRaw<Array<{ slug: string; score: number }>>`
        SELECT mi.slug,
               1 - (ce.embedding <=> ${literal}::vector) AS score
        FROM memory_items mi
        JOIN context_embeddings ce
          ON ce.source_type = 'memory_item'
         AND ce.source_id = mi.id::text
         AND ce.tenant_id = mi.tenant_id
        WHERE mi.tenant_id = ${request.caller.tenantId}::uuid
          AND mi.type = 'note'
          AND mi.slug = ANY(${slugs}::text[])
      `;
    } catch {
      scores = [];
    }
    const scoreBySlug = new Map(scores.map((entry) => [entry.slug, Number(entry.score)] as const));
    return rows
      .map((row) => {
        const score = scoreBySlug.get(`clio:${row.id}`);
        return {
          row,
          semanticScore: Number.isFinite(score) ? (score as number) : null,
          semanticMissing: !Number.isFinite(score),
        };
      })
      .sort((a, b) => {
        const aSemantic = a.semanticScore ?? -1;
        const bSemantic = b.semanticScore ?? -1;
        if (aSemantic !== bSemantic) return bSemantic - aSemantic;
        return compareMemoryRank(a.row, b.row, lexical);
      });
  }

  private async retrieveTemporalGraph(
    dataset: SemanticDatasetDescriptor,
    request: RetrievalRequest,
  ): Promise<RetrievalSourceResult> {
    const canonicalEntityIds = [...new Set(request.canonicalEntityIds ?? [])];
    const partitions = request.caller.graphPartitions ?? [];
    const requestedEntityCount = canonicalEntityIds.length;

    if (canonicalEntityIds.length === 0) {
      return this.unsupported(dataset, requestedEntityCount, 'canonical_entity_ids_required');
    }
    if (partitions.length === 0) {
      return {
        ...this.unsupported(dataset, requestedEntityCount, 'authorized_graph_partition_required'),
        sourceStatus: 'unauthorized',
      };
    }

    const rowBudget = Math.min(Math.max(request.pageSize ?? 100, 1), MAX_GRAPH_ROWS_PER_CALL);
    const records: RetrievalRecord[] = [];
    let rowBudgetReached = false;
    let boundedWalkUsed = false;
    let searchedEntityCount = 0;

    for (const canonicalEntityId of canonicalEntityIds) {
      for (const partition of partitions) {
        let edges: TemporalKnowledgeGraphEdge[];
        if (
          request.queryClass === 'entity_history' ||
          request.queryClass === 'relationship_history' ||
          request.queryClass === 'change_detection'
        ) {
          if (!request.windowStart || !request.windowEnd || !request.observedThrough) {
            return this.unsupported(
              dataset,
              requestedEntityCount,
              'history_window_and_observed_through_required',
            );
          }
          edges = await this.graph.relationHistory({
            tenantId: request.caller.tenantId,
            canonicalEntityId,
            partition,
            windowStart: request.windowStart,
            windowEnd: request.windowEnd,
            observedThrough: request.observedThrough,
            edgeTypes: request.edgeTypes,
            rowBudget,
            direction: 'both',
          });
        } else if (request.queryClass === 'temporal_state') {
          if (!request.asOf) {
            return this.unsupported(dataset, requestedEntityCount, 'as_of_required');
          }
          boundedWalkUsed = true;
          edges = await this.graph.walkAsOf({
            tenantId: request.caller.tenantId,
            canonicalEntityId,
            partition,
            asOf: request.asOf,
            edgeTypes: request.edgeTypes,
            maxDepth: 2,
            fanout: Math.min(rowBudget, 100),
            rowBudget,
            direction: 'both',
          });
        } else {
          return this.unsupported(dataset, requestedEntityCount, 'query_class_not_supported_by_graph');
        }

        searchedEntityCount += 1;
        if (edges.length >= rowBudget) rowBudgetReached = true;
        for (const edge of edges) {
          records.push({
            domain: 'institutional_knowledge',
            recordId: `${edge.assertionId}:${edge.srcCanonicalEntityId}:${edge.dstCanonicalEntityId}`,
            canonicalEntityIds: [edge.srcCanonicalEntityId, edge.dstCanonicalEntityId],
            occurredAt: edge.validFrom,
            updatedAt: edge.observedAt,
            payload: edgePayload(edge),
            provenance: {
              assertionId: edge.assertionId,
              eventId: edge.eventId,
              evidenceId: edge.evidence.id,
              contentHash: edge.evidence.contentHash,
              startOffset: edge.evidence.startOffset,
              endOffset: edge.evidence.endOffset,
            },
          });
        }
      }
    }

    // Phase 8 walkAsOf is intentionally bounded by depth, fanout, and row
    // budget and does not return a total/cursor. Therefore even a short result
    // cannot prove that fanout omitted nothing. History queries can prove
    // completeness when they return fewer than their row budget; bounded walks
    // must remain explicit partial coverage until a future exhaustive graph API
    // provides a proof signal.
    const coverageComplete = !boundedWalkUsed && !rowBudgetReached;
    const truncated = boundedWalkUsed || rowBudgetReached;
    const stopReason = rowBudgetReached
      ? 'bounded_graph_row_budget_reached'
      : boundedWalkUsed
        ? 'bounded_graph_walk_no_exhaustive_proof'
        : 'graph_history_queries_complete';

    return {
      domain: dataset.domain,
      records,
      returned: records.length,
      hasMore: rowBudgetReached,
      truncated,
      sourceStatus: coverageComplete ? 'healthy' : 'degraded',
      recordsEvaluated: records.length,
      requestedEntityCount,
      searchedEntityCount,
      pagesRead: canonicalEntityIds.length * partitions.length,
      paginationComplete: coverageComplete,
      coverageComplete,
      stopReason,
    };
  }

  private memoryUnauthorized(
    dataset: SemanticDatasetDescriptor,
    requestedEntityCount: number,
    stopReason: string,
  ): RetrievalSourceResult {
    return {
      ...this.unsupported(dataset, requestedEntityCount, stopReason),
      sourceStatus: 'unauthorized',
    };
  }

  private unsupported(
    dataset: SemanticDatasetDescriptor,
    requestedEntityCount: number,
    stopReason: string,
  ): RetrievalSourceResult {
    return {
      domain: dataset.domain,
      records: [],
      returned: 0,
      hasMore: false,
      truncated: false,
      sourceStatus: 'unsupported',
      recordsEvaluated: 0,
      requestedEntityCount,
      searchedEntityCount: 0,
      pagesRead: 0,
      paginationComplete: false,
      coverageComplete: false,
      stopReason,
    };
  }
}

function memoryRecord(row: GovernedMemoryRow, semanticScore: number | null): RetrievalRecord {
  return {
    domain: 'institutional_knowledge',
    recordId: row.id,
    ...(row.clientId ? { entityRef: { type: 'client', id: row.clientId } } : {}),
    updatedAt: row.updatedAt,
    payload: {
      sourceKind: 'governed_memory',
      key: row.key,
      value: row.value,
      scope: row.scope,
      clientId: row.clientId,
    },
    provenance: {
      source: 'clio_memory',
      recordId: row.id,
    },
    retrievalSignals: {
      ...(semanticScore !== null ? { semanticSimilarity: semanticScore } : {}),
    },
  };
}

function parseMemoryCursor(cursor?: string): number | null {
  if (!cursor) return 0;
  const match = /^memory:(\d+)$/.exec(cursor);
  if (!match) return null;
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null;
}

function lexicalScores(rows: GovernedMemoryRow[], query: string): Map<string, number> {
  const tokens = uniqueStrings(
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  );
  const scores = new Map<string, number>();
  for (const row of rows) {
    const key = row.key.toLowerCase();
    const value = row.value.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (key.includes(token)) score += 4;
      if (value.includes(token)) score += 1;
    }
    scores.set(row.id, score);
  }
  return scores;
}

function compareMemoryRank(
  a: GovernedMemoryRow,
  b: GovernedMemoryRow,
  lexical: Map<string, number>,
): number {
  const scoreDelta = (lexical.get(b.id) ?? 0) - (lexical.get(a.id) ?? 0);
  if (scoreDelta !== 0) return scoreDelta;
  const updatedDelta = b.updatedAt.getTime() - a.updatedAt.getTime();
  if (updatedDelta !== 0) return updatedDelta;
  return a.id.localeCompare(b.id);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

const STOP_WORDS = new Set([
  'about',
  'and',
  'are',
  'can',
  'did',
  'does',
  'for',
  'from',
  'have',
  'how',
  'know',
  'memory',
  'remember',
  'that',
  'the',
  'this',
  'was',
  'what',
  'when',
  'where',
  'who',
  'why',
  'with',
  'you',
  'your',
]);
