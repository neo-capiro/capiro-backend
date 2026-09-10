import { Inject, Injectable, Optional } from '@nestjs/common';
import { buildCoverageManifest } from './coverage-manifest.js';
import { ExactLexicalRetrievalService } from './exact-lexical-retrieval.service.js';
import { RetrievalPlannerV2Service } from './retrieval-planner-v2.service.js';
import { RetrievalRerankerService } from './retrieval-reranker.service.js';
import { RetrievalScoringService } from './retrieval-scoring.service.js';
import {
  RETRIEVAL_SOURCE_ADAPTERS,
  type RetrievalSourceAdapter,
} from './retrieval-source.adapter.js';
import type {
  RetrievalDomain,
  RetrievalObservability,
  RetrievalRequest,
  RetrievalResponse,
  RetrievalRerankingObservability,
  RetrievalScoringObservability,
  RetrievalSourceResult,
  RetrievalSourceStatus,
  SemanticDatasetDescriptor,
} from './retrieval-v2.types.js';

const MAX_EXHAUSTIVE_PAGES_PER_SOURCE = 100;

const statusRank: Record<RetrievalSourceStatus, number> = {
  healthy: 0,
  degraded: 1,
  unavailable: 2,
  unauthorized: 3,
  unsupported: 4,
  error: 5,
};

@Injectable()
export class RetrievalV2Service {
  private readonly adaptersByKey: ReadonlyMap<string, RetrievalSourceAdapter>;

  constructor(
    private readonly planner: RetrievalPlannerV2Service,
    @Inject(RETRIEVAL_SOURCE_ADAPTERS)
    adapters: readonly RetrievalSourceAdapter[],
    @Optional() private readonly exactLexical?: ExactLexicalRetrievalService,
    @Optional() private readonly reranker?: RetrievalRerankerService,
    @Optional() private readonly scoring?: RetrievalScoringService,
  ) {
    const byKey = new Map<string, RetrievalSourceAdapter>();
    for (const adapter of adapters) {
      if (byKey.has(adapter.key))
        throw new Error(`Duplicate Retrieval V2 adapter key: ${adapter.key}`);
      byKey.set(adapter.key, adapter);
    }
    this.adaptersByKey = byKey;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResponse> {
    const plan = this.planner.plan(request);
    if (request.exactLexical) {
      return this.retrieveExact(request, plan.entries);
    }

    const results = await Promise.all(
      plan.entries.map(async (entry) => {
        if (!entry.supported) {
          return this.unavailableResult(
            entry.dataset,
            request,
            'unsupported',
            entry.reason ?? 'query_class_unsupported',
          );
        }
        const adapter = this.adaptersByKey.get(entry.dataset.adapterKey);
        if (!adapter || !adapter.domains.includes(entry.dataset.domain)) {
          return this.unavailableResult(
            entry.dataset,
            request,
            'unavailable',
            `adapter_not_registered:${entry.dataset.adapterKey}`,
          );
        }
        return this.retrieveFromSource(adapter, entry.dataset, request);
      }),
    );

    return this.response(request, plan.requestedDomains, results);
  }

  private async retrieveExact(
    request: RetrievalRequest,
    entries: ReturnType<RetrievalPlannerV2Service['plan']>['entries'],
  ): Promise<RetrievalResponse> {
    const supportedDomains = entries
      .filter((entry) => entry.supported)
      .map((entry) => entry.dataset.domain);
    const exactResults = this.exactLexical
      ? await this.exactLexical.retrieve({ ...request, requestedDomains: supportedDomains })
      : [];
    const byDomain = new Map(exactResults.map((result) => [result.domain, result]));

    const results = entries.map((entry) => {
      if (!entry.supported) {
        return this.unavailableResult(
          entry.dataset,
          request,
          'unsupported',
          entry.reason ?? 'exact_filtering_unsupported',
        );
      }
      return (
        byDomain.get(entry.dataset.domain) ??
        this.unavailableResult(
          entry.dataset,
          request,
          'unavailable',
          this.exactLexical
            ? 'exact_lexical_domain_missing_result'
            : 'exact_lexical_service_not_registered',
        )
      );
    });

    return this.response(
      request,
      entries.map((entry) => entry.dataset.domain),
      results,
    );
  }

  private async response(
    request: RetrievalRequest,
    requestedDomains: readonly RetrievalDomain[],
    results: readonly RetrievalSourceResult[],
  ): Promise<RetrievalResponse> {
    // Coverage is proved from authoritative source results BEFORE relevance
    // ordering. Phase 14 RRF fuses candidates first; Phase 13 NVIDIA reranking
    // remains the final learned relevance stage. Neither can alter coverage.
    const coverage = buildCoverageManifest(requestedDomains, results);
    const baselineRecords = results.flatMap((result) => result.records);
    const scored = this.scoring
      ? this.scoring.score(request, baselineRecords)
      : { records: baselineRecords, observability: undefined };
    const reranked = this.reranker
      ? await this.reranker.rerank(request, scored.records)
      : { records: scored.records, observability: undefined };
    const observability = this.buildObservability(
      request,
      results,
      coverage.complete,
      coverage.stopReason,
      reranked.observability,
      scored.observability,
    );
    return {
      records: reranked.records,
      coverage,
      observability,
    };
  }

  private async retrieveFromSource(
    adapter: RetrievalSourceAdapter,
    dataset: SemanticDatasetDescriptor,
    request: RetrievalRequest,
  ): Promise<RetrievalSourceResult> {
    const mustDrain =
      request.requireComplete === true || request.queryClass === 'exhaustive_search';
    let cursor = request.cursors?.[dataset.domain];
    const pages: RetrievalSourceResult[] = [];

    for (let pageIndex = 0; pageIndex < MAX_EXHAUSTIVE_PAGES_PER_SOURCE; pageIndex += 1) {
      let page: RetrievalSourceResult;
      try {
        page = await adapter.retrieve(dataset, request, cursor);
      } catch {
        page = this.unavailableResult(dataset, request, 'error', 'adapter_execution_failed');
      }
      pages.push(page);

      if (!mustDrain || !page.hasMore) break;
      if (!page.nextCursor) {
        return this.mergePages(dataset.domain, pages, {
          truncated: true,
          paginationComplete: false,
          coverageComplete: false,
          stopReason: 'source_has_more_without_cursor',
        });
      }
      cursor = page.nextCursor;
    }

    const last = pages.at(-1);
    if (mustDrain && last?.hasMore) {
      return this.mergePages(dataset.domain, pages, {
        truncated: true,
        paginationComplete: false,
        coverageComplete: false,
        stopReason: 'exhaustive_page_safety_cap_reached',
      });
    }
    return this.mergePages(dataset.domain, pages);
  }

  private mergePages(
    domain: RetrievalDomain,
    pages: readonly RetrievalSourceResult[],
    override?: Partial<
      Pick<
        RetrievalSourceResult,
        'truncated' | 'paginationComplete' | 'coverageComplete' | 'stopReason'
      >
    >,
  ): RetrievalSourceResult {
    if (pages.length === 0) {
      throw new Error(`Retrieval V2 source ${domain} returned no page result`);
    }
    const last = pages[pages.length - 1]!;
    const worstStatus = pages.reduce<RetrievalSourceStatus>(
      (worst, page) =>
        statusRank[page.sourceStatus] > statusRank[worst] ? page.sourceStatus : worst,
      'healthy',
    );
    // A domain may page across independently synced source families. A fresh
    // page must not conceal a stale sibling; unknown stays unknown.
    const syncDates = pages.map((page) => page.lastSyncAt);
    const lastSyncAt = syncDates.every((date) => date && Number.isFinite(date.getTime()))
      ? new Date(Math.min(...syncDates.map((date) => date!.getTime())))
      : undefined;
    const unpagedTruncation = pages.some((page) => page.truncated && !page.nextCursor);
    const evaluatedSets = new Map<string, number>();
    let ungroupedEvaluated = 0;
    for (const page of pages) {
      if (page.evaluatedRecordSetId) {
        evaluatedSets.set(
          page.evaluatedRecordSetId,
          Math.max(evaluatedSets.get(page.evaluatedRecordSetId) ?? 0, page.recordsEvaluated),
        );
      } else ungroupedEvaluated += page.recordsEvaluated;
    }
    const sourceCoverageComplete =
      last.coverageComplete &&
      !last.hasMore &&
      !unpagedTruncation &&
      pages.every((page) => page.sourceStatus === 'healthy');

    return {
      domain,
      records: pages.flatMap((page) => page.records),
      total: pages.find((page) => page.total !== undefined)?.total,
      returned: pages.reduce((sum, page) => sum + page.returned, 0),
      hasMore: last.hasMore,
      nextCursor: last.nextCursor,
      truncated: override?.truncated ?? unpagedTruncation,
      sourceStatus: worstStatus,
      lastSyncAt,
      recordsEvaluated:
        ungroupedEvaluated + [...evaluatedSets.values()].reduce((sum, count) => sum + count, 0),
      requestedEntityCount: Math.max(...pages.map((page) => page.requestedEntityCount)),
      searchedEntityCount: Math.max(...pages.map((page) => page.searchedEntityCount)),
      pagesRead: pages.reduce((sum, page) => sum + page.pagesRead, 0),
      paginationComplete:
        override?.paginationComplete ??
        (!last.hasMore && !unpagedTruncation && last.paginationComplete),
      coverageComplete: override?.coverageComplete ?? sourceCoverageComplete,
      stopReason: override?.stopReason ?? last.stopReason,
    };
  }

  private unavailableResult(
    dataset: SemanticDatasetDescriptor,
    request: RetrievalRequest,
    sourceStatus: Extract<
      RetrievalSourceStatus,
      'unavailable' | 'unauthorized' | 'unsupported' | 'error'
    >,
    stopReason: string,
  ): RetrievalSourceResult {
    return {
      domain: dataset.domain,
      records: [],
      returned: 0,
      hasMore: false,
      truncated: false,
      sourceStatus,
      recordsEvaluated: 0,
      requestedEntityCount:
        request.canonicalEntityIds?.length ?? request.caller.clientIds?.length ?? 0,
      searchedEntityCount: 0,
      pagesRead: 0,
      paginationComplete: false,
      coverageComplete: false,
      stopReason,
    };
  }

  private buildObservability(
    request: RetrievalRequest,
    results: readonly RetrievalSourceResult[],
    coverageComplete: boolean,
    stopReason: string,
    reranking?: RetrievalRerankingObservability,
    scoring?: RetrievalScoringObservability,
  ): RetrievalObservability {
    return {
      queryClass: request.queryClass,
      requestedDomains: [...new Set(request.requestedDomains)],
      queriedDatasets: results
        .filter((result) => result.pagesRead > 0 || result.recordsEvaluated > 0)
        .map((result) => result.domain),
      requestedEntityCount: results.reduce((sum, result) => sum + result.requestedEntityCount, 0),
      queriedEntityCount: results.reduce((sum, result) => sum + result.searchedEntityCount, 0),
      pagesByDomain: Object.fromEntries(results.map((result) => [result.domain, result.pagesRead])),
      sourceHealth: Object.fromEntries(
        results.map((result) => [result.domain, result.sourceStatus]),
      ),
      freshnessByDomain: Object.fromEntries(
        results.map((result) => [result.domain, result.lastSyncAt ?? null]),
      ),
      coverageComplete,
      stopReason,
      ...(reranking ? { reranking } : {}),
      ...(scoring ? { scoring } : {}),
    };
  }
}
