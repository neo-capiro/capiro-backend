import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { GovernedMemoryRecord } from '@capiro/meriv2-core';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import { TemporalKnowledgeGraphService } from '../../knowledge/graph/temporal-knowledge-graph.service.js';
import type { TemporalKnowledgeGraphEdge } from '../../knowledge/graph/temporal-knowledge-graph.types.js';
import type { KnowledgeJsonObject } from '../../knowledge/knowledge.types.js';
import {
  canonicalMemoryEligibilitySql,
  includeCanonicalGovernedMemoryRow,
} from './governed-memory-eligibility.helpers.js';
import { describeMemoryRecallContent } from '../../memory/memory-recall-content.helpers.js';
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
const MEMORY_CANDIDATE_LOOKAHEAD = MAX_MEMORY_ROWS_PER_CALL + 1;
const MEMORY_VECTOR_DIMENSIONS = 1024;
const MEMORY_RECALL_PROJECTION_VERSION = 'canonical-body-rrf-v3';
const DEFAULT_MEMORY_PAGE_SIZE = 50;
const MEMORY_EMBEDDING_BUDGET_MS = 2_000;
// The governed read is one statement plus the per-client wall checks; on
// capiro-internal it takes about 0.1 s. Prisma's 5 s default is set explicitly
// with headroom so a slow database is not silently turned into a lexical rerun.
const MEMORY_READ_TRANSACTION_MS = 10_000;
const MEMORY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEMORY_QUERY_CLASSES = new Set(['lookup', 'semantic_recall']);

interface GovernedMemoryRow extends GovernedMemoryRecord {
  key: string;
  value: string;
  type: string;
  slug: string;
  sections: Array<{ key: string; heading: string; body: string }>;
  visibility: string;
  legacyStatus: string;
  clientId: string | null;
  createdAt?: Date;
  updatedAt: Date;
  lexicalScore?: number;
  lexicalRank?: number;
  semanticScore?: number | null;
  semanticRank?: number | null;
  embeddingContentHash?: string | null;
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
  private readonly logger = new Logger(InstitutionalKnowledgeRetrievalAdapter.name);

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
    // Canonical approved content is read directly from memory_items. The Clio
    // projection is never a recall fallback: an outbox lag must not restore a
    // revoked fact or hide a newly approved correction.
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
      return this.memoryUnauthorized(
        dataset,
        requestedEntityCount,
        'requested_client_scope_not_authorized',
      );
    }

    const parsedCursor = parseMemoryCursor(cursor);
    if (parsedCursor === null) {
      return this.unsupported(dataset, requestedEntityCount, 'invalid_memory_cursor');
    }
    if (request.memoryItemId && !MEMORY_UUID.test(request.memoryItemId)) {
      return this.unsupported(dataset, requestedEntityCount, 'invalid_memory_item_id');
    }
    const offset = parsedCursor.offset;
    const pageSize = Math.min(
      Math.max(request.pageSize ?? DEFAULT_MEMORY_PAGE_SIZE, 1),
      MAX_MEMORY_ROWS_PER_CALL,
    );

    // The provider must never consume the interactive DB transaction timeout.
    // Only the user's query is sent; canonical facts and access checks are read
    // freshly after this bounded attempt, including on every continuation.
    const vector = await this.queryEmbedding(request);
    const readStartedAt = Date.now();
    try {
      return await this.prisma.withTenantUser(
        request.caller.tenantId,
        request.caller.userId,
        async (tx) => {
          const allowedClientIds: string[] = [];
          for (const clientId of requestedClientIds) {
            if (
              await clientMemoryAllowed(
                tx,
                request.caller.tenantId,
                request.caller.userId,
                clientId,
              )
            ) {
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

          const rows = await tx.$queryRaw<GovernedMemoryRow[]>(Prisma.sql`
          WITH eligible_base AS NOT MATERIALIZED (
            SELECT mi.*,
                   COALESCE(body_projection.body, '') AS recall_body
            FROM memory_items mi
            LEFT JOIN LATERAL (
              SELECT STRING_AGG(section.value ->> 'body', E'\n\n' ORDER BY section.ordinality) AS body
              FROM JSONB_ARRAY_ELEMENTS(
                CASE
                  WHEN JSONB_TYPEOF(mi.sections_jsonb) = 'array' THEN mi.sections_jsonb
                  ELSE '[]'::jsonb
                END
              ) WITH ORDINALITY AS section(value, ordinality)
              WHERE JSONB_TYPEOF(section.value) = 'object'
                AND JSONB_TYPEOF(section.value -> 'body') = 'string'
            ) body_projection ON TRUE
            WHERE ${canonicalMemoryEligibilitySql({
              tenantId: request.caller.tenantId,
              userId: request.caller.userId,
              allowedClientIds,
              memoryItemId: request.memoryItemId,
            })}
          ), eligible AS NOT MATERIALIZED (
            SELECT mi.*, ${memoryLexicalScoreSql(request.query ?? '', 'mi')} AS recall_lexical_score
            FROM eligible_base mi
          ), lexical_candidates AS (
            SELECT mi.id,
                   ROW_NUMBER() OVER (
                     ORDER BY mi.recall_lexical_score DESC, mi.updated_at DESC, mi.id ASC
                   ) AS lexical_rank
            FROM eligible mi
            ORDER BY mi.recall_lexical_score DESC, mi.updated_at DESC, mi.id ASC
            LIMIT ${MEMORY_CANDIDATE_LOOKAHEAD}
          ),
          ${memorySemanticCandidatesSql(vector, embeddingModel(this.embeddingProvider))},
          candidate_ids AS (
            SELECT id FROM lexical_candidates
            UNION
            SELECT id FROM semantic_candidates
          )
          SELECT mi.id::text AS id, mi.tenant_id::text AS "tenantId",
                 mi.client_id::text AS "clientId", mi.owner_user_id::text AS "ownerUserId",
                 mi.title AS key, mi.type, mi.slug, mi.sections_jsonb AS sections,
                 mi.visibility, mi.status AS "legacyStatus", mi.created_at AS "createdAt", mi.updated_at AS "updatedAt",
                 mi.memory_class AS "memoryClass", mi.memory_authority AS authority,
                 mi.memory_scope AS scope, mi.governed_status AS status,
                 mi.conflict_status AS "conflictStatus", mi.controlling_item_id::text AS "controllingItemId",
                 mi.sensitivity, mi.source_type AS "sourceType", mi.source_id AS "sourceId",
                 mi.source_ref AS "sourceRef", mi.source_excerpt AS "sourceExcerpt",
                 mi.source_content_hash AS "sourceContentHash", mi.source_version AS "sourceVersion",
                 mi.asserted_by_user_id::text AS "assertedByUserId",
                 mi.approved_by_user_id::text AS "approvedByUserId", mi.approved_at AS "approvedAt",
                 mi.second_approved_by_user_id::text AS "secondApprovedByUserId",
                 mi.second_approved_at AS "secondApprovedAt", mi.as_of AS "asOf",
                 mi.effective_from AS "effectiveFrom", mi.valid_until AS "validUntil",
                 mi.expires_at AS "expiresAt", mi.last_confirmed_at AS "lastConfirmedAt",
                 mi.review_due_at AS "reviewDueAt", mi.review_cadence_days AS "reviewCadenceDays",
                 mi.instructions_allowed AS "instructionsAllowed",
                 mi.recall_lexical_score AS "lexicalScore",
                 lexical_candidates.lexical_rank AS "lexicalRank",
                 semantic_candidates.semantic_score AS "semanticScore",
                 semantic_candidates.semantic_rank AS "semanticRank",
                 semantic_candidates.embedding_content_hash AS "embeddingContentHash"
          FROM eligible mi
          JOIN candidate_ids ON candidate_ids.id = mi.id
          LEFT JOIN lexical_candidates ON lexical_candidates.id = mi.id
          LEFT JOIN semantic_candidates ON semantic_candidates.id = mi.id
        `);

          const hardTruncated =
            rows.length > MAX_MEMORY_ROWS_PER_CALL ||
            rows.some((row) => {
              const lexicalRank = finiteMemoryNumber(row.lexicalRank);
              const semanticRank = finiteMemoryNumber(row.semanticRank);
              return (
                (lexicalRank !== null && lexicalRank > MAX_MEMORY_ROWS_PER_CALL) ||
                (semanticRank !== null && semanticRank > MAX_MEMORY_ROWS_PER_CALL)
              );
            });
          const eligible = rows
            .filter((row) =>
              includeCanonicalGovernedMemoryRow(row, {
                tenantId: request.caller.tenantId,
                userId: request.caller.userId,
                allowedClientIds,
              }),
            )
            .map((row) => ({
              ...row,
              sections: memorySections(row.sections),
              value: memorySections(row.sections)
                .map((section) => section.body)
                .join('\n\n'),
            }));

          const rankedCandidates = this.rankMemories(request, eligible, vector);
          const ranked = rankedCandidates.slice(0, MAX_MEMORY_ROWS_PER_CALL);
          const snapshot = memorySnapshot(
            request,
            allowedClientIds,
            embeddingProjection(this.embeddingProvider),
            ranked,
          );
          if (parsedCursor.snapshot && parsedCursor.snapshot !== snapshot) {
            return {
              ...this.unsupported(
                dataset,
                requestedEntityCount,
                'governed_memory_changed_restart_search',
              ),
              sourceStatus: 'degraded' as const,
            };
          }
          const pageRows = ranked.slice(offset, offset + pageSize);
          const hasMore = offset + pageSize < ranked.length;
          const nextCursor = hasMore ? `memory:v3:${offset + pageSize}:${snapshot}` : undefined;
          // Degraded means the SEMANTIC PROJECTION itself could not run (the
          // embedding provider returned no usable vector), not that a sparse
          // subset of rows lacks an embedding. A single un-embedded approved row
          // must not poison coverage for the whole scan — it falls back to
          // lexical ranking and stays available (see rankMemories).
          const semanticDegraded =
            request.metadata?.memorySemanticFallback === true ||
            (request.queryClass === 'semantic_recall' &&
              ranked.some((entry) => entry.semanticUnavailable));
          const sourceDegraded = hardTruncated || semanticDegraded;
          const paginationComplete = !hasMore && !hardTruncated;
          const records = pageRows.map(({ row, semanticScore }) =>
            memoryRecord(row, semanticScore),
          );
          const lastSyncAt = eligible.reduce<Date | undefined>(
            (latest, row) => (!latest || row.updatedAt > latest ? row.updatedAt : latest),
            undefined,
          );

          return {
            domain: dataset.domain,
            records,
            total: hardTruncated ? undefined : eligible.length,
            returned: records.length,
            hasMore,
            nextCursor,
            truncated: hardTruncated,
            sourceStatus: sourceDegraded ? 'degraded' : 'healthy',
            lastSyncAt,
            recordsEvaluated: eligible.length,
            evaluatedRecordSetId: `memory:${snapshot}`,
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
        { timeoutMs: MEMORY_READ_TRANSACTION_MS },
      );
    } catch (error) {
      // An SQL projection error can abort a PostgreSQL transaction even when
      // caught inside its callback. Read canonical evidence again without the
      // optional semantic query; do not turn that into an empty healthy scan.
      // The log line keeps the cause visible: until 2026-10-06 every semantic
      // read on capiro-internal expired its transaction here without a trace.
      this.logger.warn(
        JSON.stringify({
          event: 'governed_memory.read_failed',
          fallback: vector ? 'lexical_rerun' : 'none',
          reason: memoryReadFailureReason(error),
          errorName: error instanceof Error ? error.name : typeof error,
          errorCode: memoryReadErrorCode(error),
          elapsedMs: Date.now() - readStartedAt,
          queryClass: request.queryClass,
          tenantId: request.caller.tenantId,
        }),
      );
      if (vector) {
        return this.retrieveGovernedMemory(
          dataset,
          {
            ...request,
            queryClass: 'lookup',
            metadata: { ...request.metadata, memorySemanticFallback: true },
          },
          cursor,
        );
      }
      return {
        ...this.unsupported(dataset, requestedEntityCount, 'governed_memory_canonical_read_failed'),
        sourceStatus: 'error',
      };
    }
  }

  private async queryEmbedding(request: RetrievalRequest): Promise<number[] | null> {
    if (request.queryClass !== 'semantic_recall' || !request.query?.trim()) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    const unavailable = (reason: string, error?: unknown): null => {
      this.logger.warn(
        JSON.stringify({
          event: 'governed_memory.embedding_unavailable',
          reason,
          ...(error === undefined
            ? {}
            : { errorName: error instanceof Error ? error.name : typeof error }),
          elapsedMs: Date.now() - startedAt,
          budgetMs: MEMORY_EMBEDDING_BUDGET_MS,
          tenantId: request.caller.tenantId,
        }),
      );
      return null;
    };
    try {
      const budgetExceeded = Symbol('budget_exceeded');
      const vector = await Promise.race([
        this.embeddingProvider.embed(request.query.trim()),
        new Promise<typeof budgetExceeded>((resolve) => {
          timer = setTimeout(() => resolve(budgetExceeded), MEMORY_EMBEDDING_BUDGET_MS);
        }),
      ]);
      if (vector === budgetExceeded) return unavailable('budget_exceeded');
      return vector?.length === MEMORY_VECTOR_DIMENSIONS &&
        embeddingProjection(this.embeddingProvider).dimensions === MEMORY_VECTOR_DIMENSIONS &&
        vector.every(Number.isFinite)
        ? vector
        : unavailable('invalid_vector');
    } catch (error) {
      return unavailable('provider_error', error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private rankMemories(
    request: RetrievalRequest,
    rows: GovernedMemoryRow[],
    vector: number[] | null,
  ): Array<{
    row: GovernedMemoryRow;
    semanticScore: number | null;
    semanticMissing: boolean;
    semanticUnavailable: boolean;
  }> {
    const lexical = lexicalScores(rows, request.query ?? '');
    if (
      request.queryClass !== 'semantic_recall' ||
      !(request.query ?? '').trim() ||
      rows.length === 0
    ) {
      return rows
        .map((row) => ({
          row,
          semanticScore: null,
          semanticMissing: false,
          semanticUnavailable: false,
        }))
        .sort((a, b) => compareMemoryRank(a.row, b.row, lexical));
    }

    if (
      vector?.length !== MEMORY_VECTOR_DIMENSIONS ||
      vector.some((value) => !Number.isFinite(value))
    ) {
      // The semantic projection itself could not run — this IS a coverage
      // degradation (the caller treats the source as degraded).
      return rows
        .map((row) => ({
          row,
          semanticScore: null,
          semanticMissing: true,
          semanticUnavailable: true,
        }))
        .sort((a, b) => compareMemoryRank(a.row, b.row, lexical));
    }

    return rows
      .map((row) => {
        const semanticScore = finiteMemoryNumber(row.semanticScore);
        // A row with no embedding match is a SPARSE projection gap, not a
        // degraded source: it falls back to lexical ranking and stays
        // available. semanticMissing is informational; only
        // semanticUnavailable (provider down, above) degrades the source.
        return {
          row,
          semanticScore,
          semanticMissing: semanticScore === null,
          semanticUnavailable: false,
          lexicalScore: finiteMemoryNumber(row.lexicalScore) ?? lexical.get(row.id) ?? 0,
          // Candidate ranks are authoritative stream-membership signals from
          // SQL. Missing or malformed ranks must not be reconstructed from the
          // union because that turns an absent stream into a synthetic rank.
          lexicalRank: finiteMemoryNumber(row.lexicalRank) ?? Number.POSITIVE_INFINITY,
          semanticRank: finiteMemoryNumber(row.semanticRank) ?? Number.POSITIVE_INFINITY,
        };
      })
      .sort((a, b) => {
        // Stable two-stream fusion: positive canonical-body lexical matches and
        // current-model semantic matches each retain their independent rank.
        // Zero-score lexical lookahead remains a bounded fallback, but cannot
        // crowd a relevant old lexical fact merely by also being recent.
        const aFusion = Math.min(
          a.lexicalScore > 0 ? a.lexicalRank : Number.POSITIVE_INFINITY,
          a.semanticRank,
        );
        const bFusion = Math.min(
          b.lexicalScore > 0 ? b.lexicalRank : Number.POSITIVE_INFINITY,
          b.semanticRank,
        );
        if (aFusion !== bFusion) return aFusion - bFusion;
        if (a.lexicalScore !== b.lexicalScore) return b.lexicalScore - a.lexicalScore;
        const aSemantic = a.semanticScore ?? -1;
        const bSemantic = b.semanticScore ?? -1;
        if (aSemantic !== bSemantic) return bSemantic - aSemantic;
        return compareMemoryRank(a.row, b.row, lexical);
      })
      .map(
        ({
          lexicalScore: _lexicalScore,
          lexicalRank: _lexicalRank,
          semanticRank: _semanticRank,
          ...entry
        }) => entry,
      );
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
          return this.unsupported(
            dataset,
            requestedEntityCount,
            'query_class_not_supported_by_graph',
          );
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
  const content = describeMemoryRecallContent({
    title: row.key,
    value: row.value,
    sourceType: row.sourceType,
  });
  const reviewBase = row.lastConfirmedAt ?? row.createdAt;
  const reviewDueAt =
    row.reviewDueAt ??
    (reviewBase && row.reviewCadenceDays && row.reviewCadenceDays > 0
      ? new Date(new Date(reviewBase).getTime() + row.reviewCadenceDays * 86_400_000)
      : null);
  return {
    domain: 'institutional_knowledge',
    recordId: row.id,
    ...(row.clientId ? { entityRef: { type: 'client', id: row.clientId } } : {}),
    updatedAt: row.updatedAt,
    payload: {
      sourceKind: 'governed_memory',
      key: row.key,
      scope: row.scope,
      clientId: row.clientId,
      memoryItemId: row.id,
      title: content.title,
      contentStatus: content.contentStatus,
      contentLimitation: content.contentLimitation,
      type: row.type,
      slug: row.slug,
      sectionCount: row.sections.length,
      contentRead: {
        tool: 'search_memory',
        arguments: {
          query: 'Read this approved memory',
          memoryItemId: row.id,
          ...(row.clientId ? { clientId: row.clientId } : {}),
        },
      },
      governance: {
        memoryClass: row.memoryClass,
        authority: row.authority,
        status: row.status,
        conflictStatus: row.conflictStatus ?? null,
        controllingItemId: row.controllingItemId ?? null,
        approvedByUserId: row.approvedByUserId ?? null,
        approvedAt: isoDate(row.approvedAt),
        asOf: isoDate(row.asOf),
        effectiveFrom: isoDate(row.effectiveFrom),
        validUntil: isoDate(row.validUntil),
        expiresAt: isoDate(row.expiresAt),
        lastConfirmedAt: isoDate(row.lastConfirmedAt),
        reviewDueAt: isoDate(reviewDueAt),
        stale:
          row.status === 'stale' ||
          (!!reviewDueAt && new Date(reviewDueAt).getTime() <= Date.now()),
        instructionsAllowed: row.instructionsAllowed ?? false,
      },
      value: row.value,
      sections: row.sections.map((section) => ({
        key: section.key,
        heading: section.heading,
        characters: section.body.length,
      })),
    },
    provenance: {
      source: 'memory_items',
      recordId: row.id,
      canonicalTenantId: row.tenantId,
      sourceType: row.sourceType,
      sourceId: row.sourceId ?? null,
      sourceRef: row.sourceRef ?? null,
      sourceExcerpt: row.sourceExcerpt ?? null,
      contentHash: row.sourceContentHash ?? null,
      sourceVersion: row.sourceVersion ?? null,
    },
    retrievalSignals: {
      ...(semanticScore !== null ? { semanticSimilarity: semanticScore } : {}),
    },
  };
}

function parseMemoryCursor(cursor?: string): { offset: number; snapshot?: string } | null {
  if (!cursor) return { offset: 0 };
  const match = /^memory:v3:(\d+):([a-f0-9]{64})$/.exec(cursor);
  if (!match) return null;
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) && offset >= 0 ? { offset, snapshot: match[2] } : null;
}

function memorySnapshot(
  request: RetrievalRequest,
  allowedClientIds: readonly string[],
  projection: ReturnType<typeof embeddingProjection>,
  ranked: ReadonlyArray<{
    row: GovernedMemoryRow;
    semanticScore: number | null;
    semanticMissing: boolean;
    semanticUnavailable: boolean;
  }>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        MEMORY_RECALL_PROJECTION_VERSION,
        request.caller.tenantId,
        request.caller.userId,
        [...(request.caller.clientIds ?? [])].sort(),
        [...(request.caller.authorizedClientIds ?? [])].sort(),
        [...allowedClientIds].sort(),
        request.queryClass,
        request.query ?? '',
        request.memoryItemId ?? null,
        projection,
        ranked.map(({ row, semanticScore }) => [
          row.id,
          isoDate(row.updatedAt),
          row.status,
          row.memoryClass,
          row.authority,
          row.scope,
          row.clientId,
          row.ownerUserId,
          row.sensitivity,
          row.sourceContentHash ?? null,
          row.embeddingContentHash ?? null,
          semanticScore,
          row.key,
          row.value,
        ]),
      ]),
    )
    .digest('hex');
}

function lexicalScores(rows: GovernedMemoryRow[], query: string): Map<string, number> {
  const tokens = memoryQueryTokens(query);
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

function finiteMemoryNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'bigint') return null;
  const converted = Number(value);
  return Number.isSafeInteger(converted) ? converted : null;
}

/** A bounded cause for the read-failure log; the raw message is never logged. */
function memoryReadFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/Transaction already closed|expired transaction|Transaction API error/i.test(message)) {
    return 'transaction_expired';
  }
  if (/statement timeout|canceling statement/i.test(message)) return 'statement_timeout';
  return 'query_failed';
}

function memoryReadErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,16}$/i.test(code) ? code : null;
}

function memoryLexicalScoreSql(query: string, alias: string): Prisma.Sql {
  const tokens = memoryQueryTokens(query);
  if (!tokens.length) return Prisma.sql`0`;
  const row = Prisma.raw(alias);
  return Prisma.sql`(${Prisma.join(
    tokens.map(
      (token) => Prisma.sql`(
        CASE WHEN STRPOS(LOWER(${row}.title), ${token}::text) > 0 THEN 4 ELSE 0 END
        + CASE WHEN STRPOS(LOWER(${row}.recall_body), ${token}::text) > 0 THEN 1 ELSE 0 END
      )`,
    ),
    ' + ',
  )})`;
}

/**
 * The semantic stream is independently bounded after the exact same governed
 * eligibility relation as lexical recall. It uses only the active provider's
 * model, whose physical uniqueness key makes one deterministic projection per
 * memory item. The selected score and projection hash flow directly into final
 * fusion/cursor continuity; there is no second, order-dependent duplicate map.
 *
 * The join compares `ce.source_id` with an id cast to text BEFORE the join, in
 * a MATERIALIZED CTE. context_embeddings has FORCE ROW LEVEL SECURITY, and
 * PostgreSQL pushes a join clause below the policy only when every function in
 * it is leakproof. `texteq` is; the uuid-to-text cast (`uuid_out`) is not. With
 * `ce.source_id = mi.id::text` the clause could never use
 * `context_embeddings_unique`, so the planner (estimating one eligible row)
 * rescanned every tenant memory embedding once per eligible row: 17 to 19 s for
 * 404 rows on capiro-internal (EXPLAIN ANALYZE, 2026-10-06). Comparing two text
 * columns makes it one index probe per row (about 70 ms, identical ranks).
 * MATERIALIZED keeps the planner from inlining the cast back into the clause.
 */
function memorySemanticCandidatesSql(vector: number[] | null, model: string): Prisma.Sql {
  if (vector?.length !== MEMORY_VECTOR_DIMENSIONS || !model) {
    return Prisma.sql`semantic_candidates AS (
      SELECT NULL::uuid AS id,
             NULL::bigint AS semantic_rank,
             NULL::double precision AS semantic_score,
             NULL::text AS embedding_content_hash
      WHERE FALSE
    )`;
  }
  const literal = `[${vector.join(',')}]`;
  return Prisma.sql`eligible_semantic AS MATERIALIZED (
    SELECT mi.id, mi.tenant_id, mi.updated_at, mi.id::text AS source_id
    FROM eligible mi
  ),
  semantic_candidates AS (
    SELECT mi.id,
           ROW_NUMBER() OVER (
             ORDER BY ce.embedding <=> ${literal}::vector, mi.updated_at DESC, mi.id ASC
           ) AS semantic_rank,
           1 - (ce.embedding <=> ${literal}::vector) AS semantic_score,
           ce.content_hash AS embedding_content_hash
    FROM eligible_semantic mi
    JOIN context_embeddings ce
      ON ce.source_type = 'memory_item'
     AND ce.source_id = mi.source_id
     AND ce.tenant_id = mi.tenant_id
     AND ce.model = ${model}
    ORDER BY ce.embedding <=> ${literal}::vector, mi.updated_at DESC, mi.id ASC
    LIMIT ${MEMORY_CANDIDATE_LOOKAHEAD}
  )`;
}

function embeddingProjection(provider: EmbeddingProvider | undefined): {
  provider: string | null;
  model: string | null;
  modelVersion: string | null;
  dimensions: number | null;
} {
  const metadata = provider?.metadata;
  const dimensions = metadata?.dimensions;
  return {
    provider: metadata?.provider ?? null,
    model: metadata?.model ?? null,
    modelVersion: metadata?.modelVersion ?? null,
    dimensions: Number.isSafeInteger(dimensions) ? (dimensions as number) : null,
  };
}

function embeddingModel(provider: EmbeddingProvider | undefined): string {
  return embeddingProjection(provider).model ?? '';
}

function memoryQueryTokens(query: string): string[] {
  return uniqueStrings(
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  );
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

function isoDate(value: string | Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function memorySections(value: unknown): Array<{ key: string; heading: string; body: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((section) => section && typeof section === 'object' && typeof section.body === 'string')
    .map((section) => ({
      key: String(section.key ?? ''),
      heading: String(section.heading ?? ''),
      body: section.body,
    }));
}
