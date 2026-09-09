import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  filterGovernedMemory,
  MEMORY_CLASSES,
  type GovernedMemoryRecord,
} from '@capiro/meriv2-core';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import { TemporalKnowledgeGraphService } from '../../knowledge/graph/temporal-knowledge-graph.service.js';
import type { TemporalKnowledgeGraphEdge } from '../../knowledge/graph/temporal-knowledge-graph.types.js';
import type { KnowledgeJsonObject } from '../../knowledge/knowledge.types.js';
import { governedRecallEligibilitySql } from '../../memory/memory-recall-suppression.helpers.js';
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
const DEFAULT_MEMORY_PAGE_SIZE = 50;
const MEMORY_EMBEDDING_BUDGET_MS = 2_000;
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
    let canonicalRows: GovernedMemoryRow[] = [];
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
                 mi.instructions_allowed AS "instructionsAllowed"
          FROM memory_items mi
          WHERE mi.tenant_id = ${request.caller.tenantId}::uuid
            AND (mi.visibility = 'tenant' OR mi.owner_user_id = ${request.caller.userId}::uuid)
            AND mi.status = 'active'
            ${request.memoryItemId ? Prisma.sql`AND mi.id = ${request.memoryItemId}::uuid` : Prisma.empty}
            AND mi.memory_class IN ('institutional_authoritative', 'client_steering', 'user_preference', 'episodic_working')
            AND (mi.expires_at IS NULL OR mi.expires_at > now())
            AND (mi.valid_until IS NULL OR mi.valid_until > now())
            AND (mi.effective_from IS NULL OR mi.effective_from <= now())
            AND (mi.client_id IS NULL OR mi.client_id = ANY(${allowedClientIds}::uuid[]))
            AND ${Prisma.raw(governedRecallEligibilitySql('mi'))}
          ORDER BY mi.updated_at DESC, mi.id ASC
          LIMIT ${MAX_MEMORY_ROWS_PER_CALL + 1}
        `);

          const hardTruncated = rows.length > MAX_MEMORY_ROWS_PER_CALL;
          const eligible = rows
            .slice(0, MAX_MEMORY_ROWS_PER_CALL)
            .filter(
              (row) =>
                MEMORY_CLASSES.includes(row.memoryClass) &&
                row.legacyStatus === 'active' &&
                (row.visibility === 'tenant' || row.ownerUserId === request.caller.userId) &&
                (!row.clientId || allowedClientIds.includes(row.clientId)) &&
                (!row.effectiveFrom || new Date(row.effectiveFrom).getTime() <= Date.now()) &&
                filterGovernedMemory(row, {
                  tenantId: request.caller.tenantId,
                  userId: request.caller.userId,
                  clientId: row.clientId,
                  ethicalWallAllowed: !!row.clientId && allowedClientIds.includes(row.clientId),
                }).include,
            )
            .map((row) => ({
              ...row,
              sections: memorySections(row.sections),
              value: memorySections(row.sections)
                .map((section) => section.body)
                .join('\n\n'),
            }));

          canonicalRows = eligible;
          const ranked = await this.rankMemories(tx, request, eligible, vector);
          const snapshot = memorySnapshot(
            request,
            ranked.map(({ row }) => row),
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
          const nextCursor = hasMore ? `memory:v2:${offset + pageSize}:${snapshot}` : undefined;
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
      );
    } catch {
      // An SQL projection error can abort a PostgreSQL transaction even when
      // caught inside its callback. Read canonical evidence again without the
      // optional semantic query; do not turn that into an empty healthy scan.
      if (canonicalRows.length && vector) {
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
    try {
      const vector = await Promise.race([
        this.embeddingProvider.embed(request.query.trim()),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), MEMORY_EMBEDDING_BUDGET_MS);
        }),
      ]);
      return vector?.length && vector.every(Number.isFinite) ? vector : null;
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async rankMemories(
    tx: Prisma.TransactionClient,
    request: RetrievalRequest,
    rows: GovernedMemoryRow[],
    vector: number[] | null,
  ): Promise<
    Array<{
      row: GovernedMemoryRow;
      semanticScore: number | null;
      semanticMissing: boolean;
      semanticUnavailable: boolean;
    }>
  > {
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

    if (!vector?.length || vector.some((value) => !Number.isFinite(value))) {
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

    const ids = rows.map((row) => row.id);
    const literal = `[${vector.join(',')}]`;
    let scores: Array<{ id: string; score: number }> = [];
    let semanticQueryUnavailable = false;
    try {
      scores = await tx.$queryRaw<Array<{ id: string; score: number }>>`
        SELECT mi.id::text AS id,
               1 - (ce.embedding <=> ${literal}::vector) AS score
        FROM memory_items mi
        JOIN context_embeddings ce
          ON ce.source_type = 'memory_item'
         AND ce.source_id = mi.id::text
         AND ce.tenant_id = mi.tenant_id
        WHERE mi.tenant_id = ${request.caller.tenantId}::uuid
          AND mi.id = ANY(${ids}::uuid[])
      `;
    } catch {
      scores = [];
      semanticQueryUnavailable = true;
    }
    const scoreById = new Map(scores.map((entry) => [entry.id, Number(entry.score)] as const));
    return rows
      .map((row) => {
        const score = scoreById.get(row.id);
        // A row with no embedding match is a SPARSE projection gap, not a
        // degraded source: it falls back to lexical ranking and stays
        // available. semanticMissing is informational; only
        // semanticUnavailable (provider down, above) degrades the source.
        return {
          row,
          semanticScore: Number.isFinite(score) ? (score as number) : null,
          semanticMissing: !Number.isFinite(score),
          semanticUnavailable: semanticQueryUnavailable,
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
  const match = /^memory:v2:(\d+):([a-f0-9]{64})$/.exec(cursor);
  if (!match) return null;
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) && offset >= 0 ? { offset, snapshot: match[2] } : null;
}

function memorySnapshot(request: RetrievalRequest, rows: GovernedMemoryRow[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        request.caller.tenantId,
        request.caller.userId,
        [...(request.caller.clientIds ?? [])].sort(),
        request.query ?? '',
        request.memoryItemId ?? null,
        rows.map((row) => [row.id, isoDate(row.updatedAt), row.status, row.value]),
      ]),
    )
    .digest('hex');
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
