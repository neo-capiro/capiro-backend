import { Injectable } from '@nestjs/common';
import {
  compileCoverageAwareContextPacket,
  type CompiledContextPacket,
  type ContextPacketCoverageManifest,
  type ContextPacketEvidenceRef,
  type ContextPacketResolvedEntity,
  type ContextPacketRetrievalContext,
  type ContextPacketSourceStatus,
  type ContextRequest,
  type CoverageAwareContextPacketV2,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CoverageManifest,
  RetrievalRecord,
  RetrievalResponse,
} from '../retrieval/retrieval-v2.types.js';
import { ContextCompilerService } from './context-compiler.service.js';
import { ContextLayerService } from './context-layer.service.js';
import type {
  ContextResolutionResult,
  ContextResolvedEntity,
  ContextRetrievalDirective,
  ContextRetrievalResult,
} from './context-resolver.types.js';

export type Phase17CompiledContextPacket =
  | Exclude<CompiledContextPacket, { version: 2 }>
  | CoverageAwareContextPacketV2;

export interface PersistedContextPacketRetrievalState {
  retrievalContext: Record<string, unknown>;
  evidence: unknown;
  sourceFailures: unknown;
}

/**
 * Phase 17 compiler boundary.
 *
 * Phase 15 resolves subject/security and Retrieval V2 proves coverage. Phase 16
 * normalizes those inputs into the shared five layers. This service is the first
 * boundary that combines those results with the existing governed ContextPacket
 * V2 without creating a second packet implementation.
 */
@Injectable()
export class ContextPacketV2Service {
  constructor(
    private readonly compiler: ContextCompilerService,
    private readonly layers: ContextLayerService,
    private readonly prisma: PrismaService,
  ) {}

  async compile(
    request: ContextRequest,
    result: ContextRetrievalResult,
    plannedRetrieval?: ContextRetrievalDirective,
  ): Promise<Phase17CompiledContextPacket> {
    const bridge = this.layers.bridgeToCompiler(result.resolution, request);
    const basePacket = await this.compiler.compile(bridge.compilerRequest);

    // Preserve the existing off/shadow rollback contract. Phase 18 owns broad
    // enforcement; Phase 17 only establishes the V2 contract.
    if (basePacket.version !== 2) return basePacket;

    const retrievalContext = buildContextPacketRetrievalContext(result, plannedRetrieval);
    const packet = compileCoverageAwareContextPacket(basePacket, retrievalContext);
    await this.persistCoverageAwareState(packet, retrievalContext);
    return packet;
  }

  /** Read the durable Phase 17 metadata/evidence boundary for audits and tests. */
  async readPersistedRetrievalState(
    tenantId: string,
    packetId: string,
  ): Promise<PersistedContextPacketRetrievalState | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          retrievalContext: Record<string, unknown>;
          evidence: unknown;
          sourceFailures: unknown;
        }>
      >`
        SELECT retrieval_context_jsonb AS "retrievalContext",
               evidence_jsonb AS "evidence",
               source_failures_jsonb AS "sourceFailures"
        FROM context_packet
        WHERE tenant_id = ${tenantId}::uuid
          AND id = ${packetId}::uuid
        LIMIT 1
      `;
      return rows[0] ?? null;
    });
  }

  private async persistCoverageAwareState(
    packet: CoverageAwareContextPacketV2,
    retrievalContext: ContextPacketRetrievalContext,
  ): Promise<void> {
    if (!packet.persisted) return;
    const packetId = packet.persistedPacketId ?? packet.packetId;
    if (!packetId) throw new Error('context_packet_v2_retrieval_persistence_id_missing');

    const { evidenceRefs: _evidenceRefs, ...retrievalMetadata } = retrievalContext;
    const persistedRetrievalContext = {
      ...retrievalMetadata,
      retrievalCompleteness: packet.retrievalCompleteness,
      retrievalStopReason: packet.retrievalStopReason,
    };
    const sourceFailures = buildSourceFailures(packet.coverageManifest);

    await this.prisma.withTenant(packet.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE context_packet
        SET retrieval_context_jsonb = ${JSON.stringify(persistedRetrievalContext)}::jsonb,
            evidence_jsonb = ${JSON.stringify(packet.evidenceRefs)}::jsonb,
            source_failures_jsonb = ${JSON.stringify(sourceFailures)}::jsonb,
            health_jsonb = ${JSON.stringify(packet.health)}::jsonb,
            packet_hash = ${packet.traceHash},
            truncated = ${packet.truncated},
            incomplete = ${packet.incomplete}
        WHERE tenant_id = ${packet.tenantId}::uuid
          AND id = ${packetId}::uuid
      `;
      if (updated !== 1) {
        throw new Error('context_packet_v2_retrieval_persistence_missing');
      }
    });
  }
}

export function buildContextPacketRetrievalContext(
  result: ContextRetrievalResult,
  plannedRetrieval?: ContextRetrievalDirective,
): ContextPacketRetrievalContext {
  const resolution = result.resolution;
  const retrieval = result.retrieval;
  const requested = !!resolution.retrievalRequest || !!plannedRetrieval;
  const coverageManifest = retrieval
    ? mapCoverageManifest(retrieval.coverage)
    : requested
      ? missingRetrievalCoverageManifest(resolution, plannedRetrieval)
      : null;

  return {
    requested,
    resolvedEntities: mapResolvedEntities(resolution),
    subjectScope: {
      kind: resolution.subjectScope.kind,
      source: resolution.subjectScope.source,
      clientIds: [...resolution.subjectScope.clientIds],
    },
    coverageManifest,
    sourceHealth: retrieval
      ? mapSourceHealth(retrieval)
      : requested
        ? missingSourceHealth(resolution, plannedRetrieval)
        : {},
    sourceFreshness: retrieval
      ? mapSourceFreshness(retrieval)
      : requested
        ? missingSourceFreshness(resolution, plannedRetrieval)
        : {},
    evidenceRefs: retrieval ? retrieval.records.map(mapEvidenceRef) : [],
    retrievalStopReason:
      retrieval?.coverage.stopReason ??
      (requested ? 'retrieval_response_missing' : resolution.stopReason),
  };
}

function mapResolvedEntities(resolution: ContextResolutionResult): ContextPacketResolvedEntity[] {
  const out: ContextPacketResolvedEntity[] = [];
  const seen = new Set<string>();
  if (resolution.subjectEntity) {
    const entity = mapResolvedEntity(resolution.subjectEntity);
    out.push(entity);
    if (entity.canonicalEntityId) seen.add(entity.canonicalEntityId);
  }
  for (const canonicalEntityId of resolution.canonicalEntityIds) {
    if (seen.has(canonicalEntityId)) continue;
    out.push({
      status: 'resolved',
      canonicalEntityId,
      canonicalName: null,
      entityType: null,
      confidence: 1,
      resolutionMethod: 'canonical_reference',
      publicLookupRan: false,
      stopReason: 'canonical_reference',
    });
    seen.add(canonicalEntityId);
  }
  return out;
}

function mapResolvedEntity(entity: ContextResolvedEntity): ContextPacketResolvedEntity {
  return {
    status: entity.status,
    canonicalEntityId: entity.canonicalEntityId ?? null,
    canonicalName: entity.canonicalName ?? null,
    entityType: entity.entityType ?? null,
    confidence: entity.confidence,
    resolutionMethod: entity.resolutionMethod,
    publicLookupRan: entity.publicLookupRan,
    stopReason: entity.stopReason,
  };
}

function mapCoverageManifest(coverage: CoverageManifest): ContextPacketCoverageManifest {
  return {
    requestedDomains: [...coverage.requestedDomains],
    searchedDomains: [...coverage.searchedDomains],
    requestedEntityCount: coverage.requestedEntityCount,
    searchedEntityCount: coverage.searchedEntityCount,
    recordsEvaluated: coverage.recordsEvaluated,
    recordsReturned: coverage.recordsReturned,
    paginationComplete: coverage.paginationComplete,
    unavailableSources: [...coverage.unavailableSources],
    sources: coverage.sources.map((source) => ({
      domain: source.domain,
      sourceStatus: source.sourceStatus,
      total: source.total ?? null,
      returned: source.returned,
      recordsEvaluated: source.recordsEvaluated,
      requestedEntityCount: source.requestedEntityCount,
      searchedEntityCount: source.searchedEntityCount,
      pagesRead: source.pagesRead,
      hasMore: source.hasMore,
      nextCursor: source.nextCursor ?? null,
      truncated: source.truncated,
      paginationComplete: source.paginationComplete,
      coverageComplete: source.coverageComplete,
      lastSyncAt: iso(source.lastSyncAt),
      stopReason: source.stopReason,
    })),
    complete: coverage.complete,
    stopReason: coverage.stopReason,
  };
}

function missingRetrievalCoverageManifest(
  resolution: ContextResolutionResult,
  plannedRetrieval?: ContextRetrievalDirective,
): ContextPacketCoverageManifest {
  const requestedDomains = requestedDomainsFor(resolution, plannedRetrieval);
  const requestedEntityCount =
    resolution.retrievalRequest?.canonicalEntityIds?.length ??
    resolution.subjectScope.clientIds.length;
  return {
    requestedDomains,
    searchedDomains: [],
    requestedEntityCount,
    searchedEntityCount: 0,
    recordsEvaluated: 0,
    recordsReturned: 0,
    paginationComplete: false,
    unavailableSources: [...requestedDomains],
    sources: requestedDomains.map((domain) => ({
      domain,
      sourceStatus: 'unavailable',
      total: null,
      returned: 0,
      recordsEvaluated: 0,
      requestedEntityCount,
      searchedEntityCount: 0,
      pagesRead: 0,
      hasMore: false,
      nextCursor: null,
      truncated: false,
      paginationComplete: false,
      coverageComplete: false,
      lastSyncAt: null,
      stopReason: 'retrieval_response_missing',
    })),
    complete: false,
    stopReason: 'retrieval_response_missing',
  };
}

function mapSourceHealth(retrieval: RetrievalResponse): Record<string, ContextPacketSourceStatus> {
  const out: Record<string, ContextPacketSourceStatus> = {};
  for (const [domain, status] of Object.entries(retrieval.observability.sourceHealth)) {
    if (status) out[domain] = status;
  }
  for (const source of retrieval.coverage.sources) out[source.domain] = source.sourceStatus;
  return out;
}

function mapSourceFreshness(retrieval: RetrievalResponse): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [domain, value] of Object.entries(retrieval.observability.freshnessByDomain)) {
    out[domain] = iso(value);
  }
  for (const source of retrieval.coverage.sources) out[source.domain] = iso(source.lastSyncAt);
  return out;
}

function missingSourceHealth(
  resolution: ContextResolutionResult,
  plannedRetrieval?: ContextRetrievalDirective,
): Record<string, ContextPacketSourceStatus> {
  return Object.fromEntries(
    requestedDomainsFor(resolution, plannedRetrieval).map((domain) => [
      domain,
      'unavailable' as const,
    ]),
  );
}

function missingSourceFreshness(
  resolution: ContextResolutionResult,
  plannedRetrieval?: ContextRetrievalDirective,
): Record<string, string | null> {
  return Object.fromEntries(
    requestedDomainsFor(resolution, plannedRetrieval).map((domain) => [domain, null]),
  );
}

function requestedDomainsFor(
  resolution: ContextResolutionResult,
  plannedRetrieval?: ContextRetrievalDirective,
): ContextPacketCoverageManifest['requestedDomains'] {
  return [
    ...new Set(
      resolution.retrievalRequest?.requestedDomains ?? plannedRetrieval?.requestedDomains ?? [],
    ),
  ];
}

function mapEvidenceRef(record: RetrievalRecord): ContextPacketEvidenceRef {
  return {
    domain: record.domain,
    recordId: record.recordId,
    entityRef: record.entityRef
      ? {
          type: record.entityRef.type,
          id: record.entityRef.id,
          ...(record.entityRef.label ? { label: record.entityRef.label } : {}),
        }
      : null,
    canonicalEntityIds: [...(record.canonicalEntityIds ?? [])],
    occurredAt: iso(record.occurredAt),
    updatedAt: iso(record.updatedAt),
    provenance: record.provenance ? { ...record.provenance } : null,
  };
}

function buildSourceFailures(
  coverage: ContextPacketCoverageManifest | null,
): Array<{ domain: string; status: string; stopReason: string }> {
  if (!coverage) return [];
  const byDomain = new Map(coverage.sources.map((source) => [source.domain, source] as const));
  const out: Array<{ domain: string; status: string; stopReason: string }> = [];
  for (const domain of coverage.requestedDomains) {
    const source = byDomain.get(domain);
    if (!source) {
      out.push({ domain, status: 'missing', stopReason: 'source_coverage_missing' });
      continue;
    }
    if (
      source.sourceStatus !== 'healthy' ||
      !source.paginationComplete ||
      !source.coverageComplete ||
      source.hasMore ||
      source.truncated
    ) {
      out.push({ domain, status: source.sourceStatus, stopReason: source.stopReason });
    }
  }
  return out;
}

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}
