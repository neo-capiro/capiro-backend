import { createHash } from 'node:crypto';
import type { CompiledContextPacketV2, ContextPacketHealth } from './contract';

export type ContextPacketRetrievalCompleteness = 'not_requested' | 'complete' | 'incomplete';

export type ContextPacketSourceStatus =
  'healthy' | 'degraded' | 'unavailable' | 'unauthorized' | 'unsupported' | 'error';

export interface ContextPacketResolvedEntity {
  status: 'resolved' | 'ambiguous' | 'unresolved' | 'error';
  canonicalEntityId: string | null;
  canonicalName: string | null;
  entityType: string | null;
  confidence: number;
  resolutionMethod: string;
  publicLookupRan: boolean;
  stopReason: string;
}

export interface ContextPacketSubjectScope {
  kind: 'client' | 'portfolio' | 'external_entity' | 'general';
  source: 'explicit' | 'explicit_subject_input' | 'default_general';
  clientIds: string[];
}

export interface ContextPacketSourceCoverage {
  domain: string;
  sourceStatus: ContextPacketSourceStatus;
  total: number | null;
  returned: number;
  recordsEvaluated: number;
  requestedEntityCount: number;
  searchedEntityCount: number;
  pagesRead: number;
  hasMore: boolean;
  nextCursor: string | null;
  truncated: boolean;
  paginationComplete: boolean;
  coverageComplete: boolean;
  lastSyncAt: string | null;
  stopReason: string;
}

export interface ContextPacketCoverageManifest {
  requestedDomains: string[];
  searchedDomains: string[];
  requestedEntityCount: number;
  searchedEntityCount: number;
  recordsEvaluated: number;
  recordsReturned: number;
  paginationComplete: boolean;
  unavailableSources: string[];
  sources: ContextPacketSourceCoverage[];
  complete: boolean;
  stopReason: string;
}

export interface ContextPacketEvidenceRef {
  domain: string;
  recordId: string;
  entityRef: { type: string; id: string; label?: string } | null;
  canonicalEntityIds: string[];
  occurredAt: string | null;
  updatedAt: string | null;
  provenance: Record<string, unknown> | null;
}

export interface ContextPacketRetrievalContext {
  /** True once retrieval was planned. Missing retrieval output must therefore fail incomplete. */
  requested: boolean;
  resolvedEntities: ContextPacketResolvedEntity[];
  subjectScope: ContextPacketSubjectScope;
  coverageManifest: ContextPacketCoverageManifest | null;
  sourceHealth: Record<string, ContextPacketSourceStatus>;
  sourceFreshness: Record<string, string | null>;
  evidenceRefs: ContextPacketEvidenceRef[];
  retrievalStopReason: string;
}

/**
 * Phase 17 ContextPacket V2. This extends the existing governed-memory packet;
 * it does not replace governance, model, trace, memory, or persistence fields.
 */
export interface CoverageAwareContextPacketV2 extends CompiledContextPacketV2 {
  resolvedEntities: ContextPacketResolvedEntity[];
  subjectScope: ContextPacketSubjectScope;
  coverageManifest: ContextPacketCoverageManifest | null;
  sourceHealth: Record<string, ContextPacketSourceStatus>;
  sourceFreshness: Record<string, string | null>;
  retrievalCompleteness: ContextPacketRetrievalCompleteness;
  retrievalStopReason: string;
  evidenceRefs: ContextPacketEvidenceRef[];
}

export interface ContextPacketCoverageAssessment {
  retrievalCompleteness: ContextPacketRetrievalCompleteness;
  stopReason: string;
  reasons: string[];
  sourceFailureCount: number;
  truncated: boolean;
}

/**
 * Proves retrieval completeness from coverage, never from result count.
 *
 * In particular, zero records may still be complete when every requested
 * source was healthy, searched, fully paginated and positively reported
 * coverageComplete. Conversely, any missing/unavailable/partial source makes
 * the retrieval incomplete even when other sources returned many records.
 */
export function assessContextPacketCoverage(
  context: ContextPacketRetrievalContext,
): ContextPacketCoverageAssessment {
  if (!context.requested) {
    return {
      retrievalCompleteness: 'not_requested',
      stopReason: context.retrievalStopReason || 'retrieval_not_requested',
      reasons: [],
      sourceFailureCount: 0,
      truncated: false,
    };
  }

  const coverage = context.coverageManifest;
  if (!coverage) {
    return {
      retrievalCompleteness: 'incomplete',
      stopReason: context.retrievalStopReason || 'retrieval_response_missing',
      reasons: ['retrieval_coverage_missing'],
      sourceFailureCount: 0,
      truncated: false,
    };
  }

  const requestedDomains = uniqueStrings(coverage.requestedDomains);
  const searchedDomains = new Set(uniqueStrings(coverage.searchedDomains));
  const sourceByDomain = new Map(
    coverage.sources.map((source) => [source.domain, source] as const),
  );
  const reasons: string[] = [];
  const failedDomains = new Set<string>();

  if (requestedDomains.length === 0) reasons.push('retrieval_requested_without_domains');
  if (!coverage.complete) reasons.push('coverage_manifest_incomplete');
  if (!coverage.paginationComplete) reasons.push('coverage_pagination_incomplete');

  for (const domain of uniqueStrings(coverage.unavailableSources)) {
    failedDomains.add(domain);
    reasons.push(`source_unavailable:${domain}`);
  }

  for (const domain of requestedDomains) {
    if (!searchedDomains.has(domain)) {
      failedDomains.add(domain);
      reasons.push(`domain_not_searched:${domain}`);
    }

    const source = sourceByDomain.get(domain);
    if (!source) {
      failedDomains.add(domain);
      reasons.push(`source_coverage_missing:${domain}`);
      continue;
    }
    if (source.sourceStatus !== 'healthy') {
      failedDomains.add(domain);
      reasons.push(`source_${source.sourceStatus}:${domain}`);
    }
    if (!source.paginationComplete || source.hasMore) {
      reasons.push(`source_pagination_incomplete:${domain}`);
    }
    if (!source.coverageComplete) reasons.push(`source_coverage_incomplete:${domain}`);
    if (source.truncated) reasons.push(`source_truncated:${domain}`);
  }

  const truncated = coverage.sources.some((source) => source.truncated);
  const complete =
    requestedDomains.length > 0 &&
    coverage.complete &&
    coverage.paginationComplete &&
    coverage.unavailableSources.length === 0 &&
    reasons.length === 0;

  return {
    retrievalCompleteness: complete ? 'complete' : 'incomplete',
    stopReason:
      context.retrievalStopReason ||
      coverage.stopReason ||
      (complete ? 'retrieval_complete' : 'retrieval_incomplete'),
    reasons: uniqueStrings(reasons),
    sourceFailureCount: failedDomains.size,
    truncated,
  };
}

/** Merge Phase 17 retrieval truth into the existing governed V2 packet. */
export function compileCoverageAwareContextPacket(
  packet: CompiledContextPacketV2,
  context: ContextPacketRetrievalContext,
): CoverageAwareContextPacketV2 {
  const assessment = assessContextPacketCoverage(context);
  const retrievalIncomplete = assessment.retrievalCompleteness === 'incomplete';
  const sourceFailureCount = packet.health.sourceFailureCount + assessment.sourceFailureCount;
  const incomplete = packet.incomplete || retrievalIncomplete;
  const truncated = packet.truncated || assessment.truncated;
  const health: ContextPacketHealth = {
    ...packet.health,
    status: healthStatus({
      conflictCount: packet.health.conflictCount,
      incomplete,
      sourceFailureCount,
    }),
    sourceFailureCount,
    reasons: uniqueStrings([...packet.health.reasons, ...assessment.reasons]),
  };
  const resolvedEntities = context.resolvedEntities.map((entity) => ({ ...entity }));
  const subjectScope = {
    ...context.subjectScope,
    clientIds: [...context.subjectScope.clientIds],
  };
  const coverageManifest = context.coverageManifest
    ? cloneCoverageManifest(context.coverageManifest)
    : null;
  const sourceHealth = { ...context.sourceHealth };
  const sourceFreshness = { ...context.sourceFreshness };
  const evidenceRefs = context.evidenceRefs.map((evidence) => ({
    ...evidence,
    entityRef: evidence.entityRef ? { ...evidence.entityRef } : null,
    canonicalEntityIds: [...evidence.canonicalEntityIds],
    provenance: evidence.provenance ? { ...evidence.provenance } : null,
  }));
  const traceHash = sha256(
    stableStringify({
      baseTraceHash: packet.traceHash,
      phase17: {
        resolvedEntities,
        subjectScope,
        coverageManifest,
        sourceHealth,
        sourceFreshness,
        retrievalCompleteness: assessment.retrievalCompleteness,
        retrievalStopReason: assessment.stopReason,
        evidenceRefs,
        health,
        truncated,
        incomplete,
      },
    }),
  );

  return {
    ...packet,
    traceHash,
    health,
    truncated,
    incomplete,
    resolvedEntities,
    subjectScope,
    coverageManifest,
    sourceHealth,
    sourceFreshness,
    retrievalCompleteness: assessment.retrievalCompleteness,
    retrievalStopReason: assessment.stopReason,
    evidenceRefs,
  };
}

function cloneCoverageManifest(
  coverage: ContextPacketCoverageManifest,
): ContextPacketCoverageManifest {
  return {
    ...coverage,
    requestedDomains: [...coverage.requestedDomains],
    searchedDomains: [...coverage.searchedDomains],
    unavailableSources: [...coverage.unavailableSources],
    sources: coverage.sources.map((source) => ({ ...source })),
  };
}

function healthStatus(input: {
  conflictCount: number;
  incomplete: boolean;
  sourceFailureCount: number;
}): ContextPacketHealth['status'] {
  if (input.conflictCount > 0) return 'conflicted';
  if (input.incomplete) return 'incomplete';
  if (input.sourceFailureCount > 0) return 'degraded';
  return 'healthy';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
