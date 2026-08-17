import { Injectable } from '@nestjs/common';
import { TemporalKnowledgeGraphService } from '../../knowledge/graph/temporal-knowledge-graph.service.js';
import type { TemporalKnowledgeGraphEdge } from '../../knowledge/graph/temporal-knowledge-graph.types.js';
import type { KnowledgeJsonObject } from '../../knowledge/knowledge.types.js';
import type { RetrievalSourceAdapter } from '../retrieval-source.adapter.js';
import type {
  RetrievalRecord,
  RetrievalRequest,
  RetrievalSourceResult,
  SemanticDatasetDescriptor,
} from '../retrieval-v2.types.js';

const MAX_GRAPH_ROWS_PER_CALL = 500;

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

  constructor(private readonly graph: TemporalKnowledgeGraphService) {}

  async retrieve(
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
