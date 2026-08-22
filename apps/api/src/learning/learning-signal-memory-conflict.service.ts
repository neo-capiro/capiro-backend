import { Injectable, Logger } from '@nestjs/common';
import {
  classifyMemoryConflictMatch,
  normalizeFactText,
  governedRecallSuppressionSql,
  MEMORY_CONFLICT_SIMILARITY_THRESHOLDS,
  type MemoryConflictMatchKind,
} from '@capiro/meriv2-core';
import { embedText, normalize, vectorLiteral } from '../embeddings/embedder.js';
import type { EmbeddingProvider } from '../embeddings/embedding-provider.js';
import { getDefaultEmbeddingProvider } from '../embeddings/embedding-provider.factory.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fetchDeniedClientIds, wallExclusionSql } from '../memory/memory-wall.helpers.js';
import { governedRecallSuppressionEnabled } from '../memory/memory-recall-suppression.helpers.js';

export interface MemoryConflictScope {
  readonly tenantId: string;
  /** Set for a client-scoped candidate; null for a personal (user_private) one. */
  readonly clientId: string | null;
  /** The signal's actorUserId — used to scope a personal candidate's search
   *  to that user's own memory, same predicate `search_memory` uses. */
  readonly actorUserId: string;
}

export interface MemoryConflictMatch {
  readonly kind: MemoryConflictMatchKind;
  readonly score: number;
  readonly memoryItemId: string;
  readonly slug: string;
  readonly title: string;
}

interface CandidateMemoryRow {
  id: string;
  slug: string;
  title: string;
  content_text: string;
  score: number;
}

/**
 * Phase 27C — the missing "search existing ACTIVE memory for something this
 * new candidate might duplicate or contradict" step every prior phase
 * explicitly deferred (27B's own disclosed gap; memory-staleness.helpers.ts's
 * "fuzzy/LLM-territory... NOT a safe additive win" note on the correction
 * flow). Read-only: never writes `memory_items`, never calls
 * `ImmutableMemoryVersionService`/`MemoryConflictService` — this only
 * DETECTS a relationship and reports it; `LearningSignalCandidateService`
 * decides what to do with the answer (populate `contradictsMemoryItemId`/
 * `conflictStatus` on the pending CANDIDATE it is about to create — never on
 * the active item). Executing a supersession (flipping the active item's own
 * status) is a human governance decision, 27D's job.
 *
 * Reuses the exact embedding + cosine-search pattern already proven by
 * `MeriToolsService.searchMemory` / `MeriService.projectionRecall`
 * (`context_embeddings` ⋈ `memory_items`, Titan via `embedText`) rather than
 * building a second one — this is that pattern, extracted, not a new stack.
 */
@Injectable()
export class LearningSignalMemoryConflictService {
  private readonly logger = new Logger(LearningSignalMemoryConflictService.name);

  /** `provider` defaults to the process-wide Titan singleton like `embedText`
   *  itself does; tests inject a fake one so this never makes a real Bedrock
   *  call. Not a NestJS-injected dependency — same non-DI-default pattern
   *  `embedText`/`embedAndUpsert` already use. */
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: EmbeddingProvider = getDefaultEmbeddingProvider(),
  ) {}

  /**
   * `factText` is used ONLY to compute an embedding for this one query and
   * for the exact-text-equality check inside `classifyMemoryConflictMatch`
   * — it is never persisted by this service. Returns null if nothing
   * scores at/above `REVIEW_MIN`, or if embedding fails (fails open to "no
   * match found" — a search outage must never block candidate generation,
   * same non-blocking posture as everything else in this pipeline).
   */
  async findBestActiveMemoryMatch(
    scope: MemoryConflictScope,
    factText: string,
  ): Promise<MemoryConflictMatch | null> {
    const normalizedQuery = normalize(factText);
    if (normalizedQuery.length < 10) return null;

    let vector: number[];
    try {
      vector = await embedText(normalizedQuery, this.provider);
    } catch (error) {
      this.logger.warn(
        `Conflict-detection embed failed, proceeding without a match: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    const literal = vectorLiteral(vector);

    let rows: CandidateMemoryRow[];
    try {
      rows = await this.prisma.withTenant(scope.tenantId, async (tx) => {
        const denied = await fetchDeniedClientIds(tx, scope.tenantId, scope.actorUserId);
        const clientPredicate = scope.clientId
          ? `AND (mi.client_id IS NULL OR mi.client_id = $3::uuid)`
          : `AND (mi.owner_user_id IS NULL OR mi.owner_user_id = $2::uuid)`;
        return tx.$queryRawUnsafe<CandidateMemoryRow[]>(
          `SELECT mi.id, mi.slug, mi.title, ce.content_text,
                  1 - (ce.embedding <=> '${literal}'::vector) AS score
             FROM context_embeddings ce
             JOIN memory_items mi ON mi.id::text = ce.source_id
            WHERE ce.source_type = 'memory_item'
              AND ce.tenant_id = $1::uuid
              AND mi.tenant_id = $1::uuid
              AND mi.status = 'active'
              AND (mi.expires_at IS NULL OR mi.expires_at > now())
              ${clientPredicate}${wallExclusionSql(denied, 'mi.client_id')}${governedRecallSuppressionSql(governedRecallSuppressionEnabled(), 'mi')}
            ORDER BY ce.embedding <=> '${literal}'::vector
            LIMIT 5`,
          scope.tenantId,
          scope.actorUserId,
          scope.clientId,
        );
      });
    } catch (error) {
      // Same fail-open posture as the embed call above — a query/wall-check
      // outage must never block candidate generation.
      this.logger.warn(
        `Conflict-detection query failed, proceeding without a match: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }

    const best = rows[0];
    if (!best || best.score < MEMORY_CONFLICT_SIMILARITY_THRESHOLDS.REVIEW_MIN) return null;

    const textsEqual = normalizeFactText(best.content_text) === normalizeFactText(normalizedQuery);
    const kind = classifyMemoryConflictMatch({ score: best.score, textsEqual });
    if (kind === 'unrelated') return null;

    return { kind, score: best.score, memoryItemId: best.id, slug: best.slug, title: best.title };
  }
}
