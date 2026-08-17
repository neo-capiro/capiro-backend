import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  RERANKING_PROVIDER,
  RerankingProviderError,
  type RerankingProvider,
} from '../reranking/reranking-provider.js';
import type {
  RetrievalRecord,
  RetrievalRequest,
  RetrievalRerankingObservability,
} from './retrieval-v2.types.js';

const MAX_RERANK_PASSAGE_CHARS = 12_000;
const DEFAULT_MAX_RERANK_CANDIDATES = 128;

export interface RetrievalRerankResult {
  records: RetrievalRecord[];
  observability: RetrievalRerankingObservability;
}

/**
 * Shared Retrieval V2 relevance-only reranking stage.
 *
 * Input records have already passed source authorization/ethical-wall checks.
 * This service may only return a permutation of those same record objects. It
 * never edits payload/provenance, source authority, coverage or completeness.
 */
@Injectable()
export class RetrievalRerankerService {
  private readonly logger = new Logger(RetrievalRerankerService.name);

  constructor(
    @Optional()
    @Inject(RERANKING_PROVIDER)
    private readonly provider?: RerankingProvider | null,
  ) {}

  async rerank(
    request: RetrievalRequest,
    records: readonly RetrievalRecord[],
  ): Promise<RetrievalRerankResult> {
    const original = [...records];
    const provider = this.provider ?? null;
    const base = {
      provider: provider?.metadata.provider ?? null,
      model: provider?.metadata.model ?? null,
      candidateCount: original.length,
      rerankedCount: 0,
      durationMs: 0,
      scores: [],
    } satisfies Omit<RetrievalRerankingObservability, 'status'>;

    if (!this.enabled()) {
      return {
        records: original,
        observability: { status: 'disabled', fallbackReason: 'reranking_disabled', ...base },
      };
    }

    const query = this.queryText(request);
    if (!query) {
      return {
        records: original,
        observability: { status: 'skipped', fallbackReason: 'query_text_unavailable', ...base },
      };
    }
    if (original.length < 2) {
      return {
        records: original,
        observability: { status: 'skipped', fallbackReason: 'insufficient_candidates', ...base },
      };
    }
    if (!provider) {
      return {
        records: original,
        observability: { status: 'fallback', fallbackReason: 'provider_not_configured', ...base },
      };
    }

    const maxCandidates = this.maxCandidates();
    if (original.length > maxCandidates) {
      // Never partially rerank an arbitrary prefix: that would give candidates
      // outside the cap no chance to move upward. Preserve the complete baseline
      // order instead and make the fallback explicit.
      return {
        records: original,
        observability: {
          status: 'fallback',
          fallbackReason: 'candidate_safety_cap_exceeded',
          ...base,
        },
      };
    }

    const passages = original.map(recordToRerankPassage);
    const startedAt = Date.now();
    try {
      const result = await provider.rerank({ query, passages });
      const durationMs = Date.now() - startedAt;
      if (result.rankings.length !== original.length) {
        throw new RerankingProviderError(
          'invalid_provider_response',
          'Reranking provider returned an incomplete candidate permutation',
          provider.metadata,
          false,
        );
      }

      const seen = new Set<number>();
      for (const item of result.rankings) {
        if (
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          item.index >= original.length ||
          seen.has(item.index) ||
          !Number.isFinite(item.score)
        ) {
          throw new RerankingProviderError(
            'invalid_provider_response',
            'Reranking provider returned an invalid candidate permutation',
            provider.metadata,
            false,
          );
        }
        seen.add(item.index);
      }

      const reranked = result.rankings.map((item) => original[item.index]!);
      const finalRankByOriginalIndex = new Map<number, number>();
      result.rankings.forEach((item, finalIndex) => finalRankByOriginalIndex.set(item.index, finalIndex));
      const scoreByOriginalIndex = new Map(result.rankings.map((item) => [item.index, item.score]));

      return {
        records: reranked,
        observability: {
          status: 'applied',
          provider: provider.metadata.provider,
          model: provider.metadata.model,
          candidateCount: original.length,
          rerankedCount: original.length,
          durationMs,
          scores: original.map((record, originalIndex) => ({
            domain: record.domain,
            recordId: record.recordId,
            originalRank: originalIndex + 1,
            finalRank: finalRankByOriginalIndex.get(originalIndex)! + 1,
            score: scoreByOriginalIndex.get(originalIndex)!,
          })),
          ...(result.usage ? { usage: result.usage } : {}),
        },
      };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const fallbackReason =
        error instanceof RerankingProviderError ? error.code : 'reranker_execution_failed';
      this.logger.warn(
        `Retrieval reranking fallback provider=${provider.metadata.provider} model=${provider.metadata.model} reason=${fallbackReason}`,
      );
      return {
        records: original,
        observability: {
          status: 'fallback',
          provider: provider.metadata.provider,
          model: provider.metadata.model,
          candidateCount: original.length,
          rerankedCount: 0,
          durationMs,
          scores: [],
          fallbackReason,
        },
      };
    }
  }

  private enabled(): boolean {
    return ['1', 'true', 'yes', 'on'].includes(
      (process.env.RETRIEVAL_RERANK_ENABLED ?? '').trim().toLowerCase(),
    );
  }

  private maxCandidates(): number {
    const parsed = Number(process.env.RETRIEVAL_RERANK_MAX_CANDIDATES ?? DEFAULT_MAX_RERANK_CANDIDATES);
    if (!Number.isFinite(parsed)) return DEFAULT_MAX_RERANK_CANDIDATES;
    return Math.min(512, Math.max(2, Math.floor(parsed)));
  }

  private queryText(request: RetrievalRequest): string {
    return (request.query?.trim() || request.exactLexical?.value.trim() || '').slice(0, 8_000);
  }
}

/**
 * Provider passage projection. Provenance and internal record ids are excluded:
 * relevance ranking needs only source-domain context plus the authorized payload.
 */
export function recordToRerankPassage(record: RetrievalRecord): string {
  const payload = JSON.stringify(record.payload);
  return `${record.domain}\n${payload}`.slice(0, MAX_RERANK_PASSAGE_CHARS);
}
