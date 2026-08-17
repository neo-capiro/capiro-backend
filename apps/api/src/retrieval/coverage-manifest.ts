import type {
  CoverageManifest,
  RetrievalDomain,
  RetrievalSourceCoverage,
  RetrievalSourceResult,
} from './retrieval-v2.types.js';

const unavailableStatuses = new Set(['unavailable', 'unauthorized', 'unsupported', 'error']);

export function toSourceCoverage(result: RetrievalSourceResult): RetrievalSourceCoverage {
  return {
    domain: result.domain,
    sourceStatus: result.sourceStatus,
    total: result.total,
    returned: result.returned,
    recordsEvaluated: result.recordsEvaluated,
    requestedEntityCount: result.requestedEntityCount,
    searchedEntityCount: result.searchedEntityCount,
    pagesRead: result.pagesRead,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor,
    truncated: result.truncated,
    paginationComplete: result.paginationComplete,
    coverageComplete: result.coverageComplete,
    lastSyncAt: result.lastSyncAt,
    stopReason: result.stopReason,
  };
}

/**
 * Coverage is an explicit proof obligation. A source with zero returned rows is
 * complete only if its adapter says the authoritative search itself completed.
 * We never infer completeness from an empty array, a missing cursor, or a
 * successful HTTP/database call alone.
 */
export function buildCoverageManifest(
  requestedDomains: readonly RetrievalDomain[],
  results: readonly RetrievalSourceResult[],
): CoverageManifest {
  const requested = [...new Set(requestedDomains)];
  const byDomain = new Map(results.map((result) => [result.domain, result]));
  const sources = requested.map((domain) => {
    const result = byDomain.get(domain);
    if (result) return toSourceCoverage(result);
    return toSourceCoverage({
      domain,
      records: [],
      returned: 0,
      hasMore: false,
      truncated: false,
      sourceStatus: 'unavailable',
      recordsEvaluated: 0,
      requestedEntityCount: 0,
      searchedEntityCount: 0,
      pagesRead: 0,
      paginationComplete: false,
      coverageComplete: false,
      stopReason: 'requested_domain_missing_result',
    });
  });

  const unavailableSources = sources
    .filter((source) => unavailableStatuses.has(source.sourceStatus))
    .map((source) => source.domain);
  const searchedDomains = sources
    .filter((source) => source.pagesRead > 0 || source.recordsEvaluated > 0)
    .map((source) => source.domain);
  const paginationComplete = sources.every((source) => source.paginationComplete);
  const explicitEntityCoverageComplete = sources.every(
    (source) =>
      source.requestedEntityCount === 0 ||
      source.searchedEntityCount >= source.requestedEntityCount,
  );
  const complete =
    sources.length === requested.length &&
    explicitEntityCoverageComplete &&
    sources.every(
      (source) =>
        source.sourceStatus === 'healthy' &&
        source.coverageComplete &&
        source.paginationComplete &&
        !source.truncated &&
        !source.hasMore,
    );

  let stopReason = 'complete';
  if (!complete) {
    if (unavailableSources.length > 0) stopReason = 'source_unavailable_or_unsupported';
    else if (!explicitEntityCoverageComplete) stopReason = 'requested_entity_scope_incomplete';
    else if (!paginationComplete) stopReason = 'pagination_incomplete';
    else if (sources.some((source) => source.truncated || source.hasMore)) stopReason = 'truncated';
    else if (sources.some((source) => source.sourceStatus === 'degraded')) stopReason = 'source_degraded';
    else stopReason = 'coverage_not_proven';
  }

  return {
    requestedDomains: requested,
    searchedDomains,
    requestedEntityCount: sources.reduce((sum, source) => sum + source.requestedEntityCount, 0),
    searchedEntityCount: sources.reduce((sum, source) => sum + source.searchedEntityCount, 0),
    recordsEvaluated: sources.reduce((sum, source) => sum + source.recordsEvaluated, 0),
    recordsReturned: sources.reduce((sum, source) => sum + source.returned, 0),
    paginationComplete,
    unavailableSources,
    sources,
    complete,
    stopReason,
  };
}
