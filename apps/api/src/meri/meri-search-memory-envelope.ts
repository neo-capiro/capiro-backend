import {
  createMeriResultEnvelope,
  type MeriResultEnvelope,
  type MeriResultOutcome,
  type MeriResultSourceObservation,
} from '@capiro/shared';

type SearchMemoryPayload = Record<string, unknown>;
type CoverageSource = Record<string, unknown>;

const knownSourceStatuses = new Set([
  'healthy', 'degraded', 'unavailable', 'unauthorized', 'unsupported', 'error',
]);
const approvedStopReasons = new Set([
  'governed_memory_safety_cap_reached',
  'governed_memory_semantic_projection_incomplete',
  'governed_memory_page_boundary_reached',
  'governed_memory_scan_complete',
  'retrieval_deadline_reached',
  'source_has_more_without_cursor',
  'source_cursor_cycle',
  'exhaustive_page_safety_cap_reached',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function freshness(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function sourceObservation(
  source: CoverageSource,
  request: Record<string, unknown>,
  resultCount: number | null,
): MeriResultSourceObservation {
  const status = source.sourceStatus;
  const returnedCount = nonNegativeInteger(source.returned);
  const matchedCount = nonNegativeInteger(source.total);
  const hasMore = source.hasMore === true;
  const nextCursor = typeof source.nextCursor === 'string' ? source.nextCursor : null;
  const sourceComplete = status === 'healthy' && source.coverageComplete === true &&
    source.paginationComplete === true && source.truncated === false && !hasMore;
  // An empty payload with no explicit zero match count is not evidence of
  // absence, even if another coverage bit claims the scan finished.
  const countsConsistent = returnedCount !== undefined && matchedCount !== undefined &&
    matchedCount >= returnedCount && resultCount === returnedCount &&
    (returnedCount > 0 || matchedCount === 0);
  const complete = sourceComplete && countsConsistent;
  const knownStatus = typeof status === 'string' && knownSourceStatuses.has(status);
  const available = status === 'healthy' || status === 'degraded';
  const blocked = status === 'unauthorized';
  const unknown = !knownStatus;
  const continuation = { hasMore, ...(nextCursor !== null ? { cursor: nextCursor } : {}) };
  const scope: Record<string, string | number | boolean | null> = {
    domain: 'institutional_knowledge',
  };
  if (typeof request.clientId === 'string') scope.clientId = request.clientId;
  if (typeof request.memoryItemId === 'string') scope.memoryItemId = request.memoryItemId;
  if (typeof request.cursor === 'string') scope.continuationRequested = true;

  return {
    family: 'memory',
    sourceId: 'institutional_knowledge',
    availability: blocked ? 'blocked' : available ? 'available' : unknown ? 'unknown' : 'unavailable',
    scope,
    observedAt: freshness(source.lastSyncAt),
    coverage: {
      completeness: complete ? 'complete' : available ? 'partial' : 'unknown',
      continuation,
      ...(returnedCount !== undefined ? { returnedCount } : {}),
      matchedCount: matchedCount ?? null,
    },
    provenance: [],
    ...(!available && !unknown
      ? { failure: { code: blocked ? 'authorization_unavailable' : 'source_unavailable' } }
      : {}),
  };
}

/** Wraps the legacy search_memory result without changing its payload or throwing behavior. */
export function envelopeSearchMemoryResult<T extends SearchMemoryPayload>(
  legacyPayload: T,
  request: Record<string, unknown>,
): MeriResultEnvelope<T> {
  const coverage = asRecord(legacyPayload.coverage);
  const sources = Array.isArray(coverage?.sources)
    ? coverage.sources.map(asRecord).filter((source): source is CoverageSource => source !== null)
    : [];
  const memorySource = sources.find((source) => source.domain === 'institutional_knowledge');
  const resultCount = Array.isArray(legacyPayload.results) ? legacyPayload.results.length : null;

  let outcome: MeriResultOutcome = 'partial';
  let observations: MeriResultSourceObservation[] = [];
  if (memorySource) {
    const observation = sourceObservation(memorySource, request, resultCount);
    observations = [observation];
    if (observation.availability === 'blocked') outcome = 'blocked';
    else if (observation.availability === 'unavailable') outcome = 'unavailable';
    else if (observation.coverage.completeness === 'complete') {
      outcome = observation.coverage.returnedCount === 0 && observation.coverage.matchedCount === 0
        ? 'not_found_within_scope'
        : typeof observation.coverage.returnedCount === 'number' && observation.coverage.returnedCount > 0
          ? 'succeeded'
          : 'partial';
    }
  } else {
    observations = [{
      family: 'memory',
      sourceId: 'institutional_knowledge',
      availability: 'not_queried',
      scope: { domain: 'institutional_knowledge' },
      observedAt: null,
      coverage: { completeness: 'unknown' },
      provenance: [],
    }];
  }

  const source = observations[0];
  return createMeriResultEnvelope({
    outcome,
    legacyPayload,
    sources: observations,
    truncation: {
      truncated: source?.coverage.completeness !== 'complete' && source?.availability === 'available',
      ...(source?.coverage.completeness !== 'complete' &&
        typeof memorySource?.stopReason === 'string' && approvedStopReasons.has(memorySource.stopReason)
        ? { reason: memorySource.stopReason }
        : {}),
    },
    errors: source?.failure ? [source.failure] : [],
  });
}
