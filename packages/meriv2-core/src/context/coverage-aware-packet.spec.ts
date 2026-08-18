import { describe, expect, test } from '@jest/globals';
import type { CompiledContextPacketV2 } from './contract';
import {
  assessContextPacketCoverage,
  compileCoverageAwareContextPacket,
  type ContextPacketCoverageManifest,
  type ContextPacketRetrievalContext,
} from './coverage-aware-packet';

function coverage(
  overrides: Partial<ContextPacketCoverageManifest> = {},
): ContextPacketCoverageManifest {
  return {
    requestedDomains: ['program_elements'],
    searchedDomains: ['program_elements'],
    requestedEntityCount: 1,
    searchedEntityCount: 1,
    recordsEvaluated: 0,
    recordsReturned: 0,
    paginationComplete: true,
    unavailableSources: [],
    sources: [
      {
        domain: 'program_elements',
        sourceStatus: 'healthy',
        total: 0,
        returned: 0,
        recordsEvaluated: 0,
        requestedEntityCount: 1,
        searchedEntityCount: 1,
        pagesRead: 1,
        hasMore: false,
        nextCursor: null,
        truncated: false,
        paginationComplete: true,
        coverageComplete: true,
        lastSyncAt: '2026-08-17T23:00:00.000Z',
        stopReason: 'complete',
      },
    ],
    complete: true,
    stopReason: 'complete',
    ...overrides,
  };
}

function context(
  overrides: Partial<ContextPacketRetrievalContext> = {},
): ContextPacketRetrievalContext {
  return {
    requested: true,
    resolvedEntities: [],
    subjectScope: { kind: 'external_entity', source: 'explicit', clientIds: [] },
    coverageManifest: coverage(),
    sourceHealth: { program_elements: 'healthy' },
    sourceFreshness: { program_elements: '2026-08-17T23:00:00.000Z' },
    evidenceRefs: [],
    retrievalStopReason: 'complete',
    ...overrides,
  };
}

function basePacket(): CompiledContextPacketV2 {
  return {
    version: 2,
    packetId: null,
    surface: 'research',
    tenantId: 'tenant-1',
    effectiveTenantId: 'tenant-1',
    actorUserId: 'user-1',
    userId: 'user-1',
    clientId: null,
    ref: {},
    exclusions: [],
    rendered: [],
    traceHash: 'trace',
    persisted: false,
    compiledAt: '2026-08-17T23:00:00.000Z',
    traceId: 'trace-1',
    promptVersion: 'prompt-1',
    policyVersion: 'policy-1',
    compilerVersion: 'compiler-1',
    requiredLayers: [],
    health: {
      status: 'healthy',
      missingRequiredLayers: [],
      conflictCount: 0,
      sourceFailureCount: 0,
      reasons: [],
    },
    items: [],
    totalTokenBudget: 1000,
    usedTokens: 0,
    truncated: false,
    incomplete: false,
  };
}

describe('Knowledge Plane Phase 17 coverage-aware ContextPacket V2', () => {
  test('zero records can be complete only when coverage is positively proven', () => {
    const assessment = assessContextPacketCoverage(context());

    expect(assessment.retrievalCompleteness).toBe('complete');
    expect(assessment.reasons).toEqual([]);
    expect(coverage().recordsReturned).toBe(0);
  });

  test('zero records with a missing source cannot masquerade as complete', () => {
    const manifest = coverage({
      searchedDomains: [],
      sources: [],
      complete: false,
      paginationComplete: false,
      stopReason: 'source_unavailable',
      unavailableSources: ['program_elements'],
    });
    const assessment = assessContextPacketCoverage(
      context({ coverageManifest: manifest, retrievalStopReason: 'source_unavailable' }),
    );

    expect(assessment.retrievalCompleteness).toBe('incomplete');
    expect(assessment.reasons).toEqual(
      expect.arrayContaining([
        'coverage_manifest_incomplete',
        'coverage_pagination_incomplete',
        'source_unavailable:program_elements',
        'domain_not_searched:program_elements',
        'source_coverage_missing:program_elements',
      ]),
    );
  });

  test('planned retrieval with no retrieval response fails incomplete', () => {
    const assessment = assessContextPacketCoverage(
      context({ coverageManifest: null, retrievalStopReason: 'retrieval_response_missing' }),
    );

    expect(assessment).toMatchObject({
      retrievalCompleteness: 'incomplete',
      stopReason: 'retrieval_response_missing',
      reasons: ['retrieval_coverage_missing'],
    });
  });

  test('not-requested retrieval remains distinct from complete retrieval', () => {
    const assessment = assessContextPacketCoverage(
      context({
        requested: false,
        coverageManifest: null,
        retrievalStopReason: 'retrieval_not_requested',
      }),
    );

    expect(assessment.retrievalCompleteness).toBe('not_requested');
  });

  test('source truncation makes both retrieval and the packet incomplete/truncated', () => {
    const manifest = coverage({
      complete: false,
      sources: [
        {
          ...coverage().sources[0]!,
          truncated: true,
          coverageComplete: false,
          stopReason: 'safety_cap',
        },
      ],
      stopReason: 'safety_cap',
    });
    const packet = compileCoverageAwareContextPacket(
      basePacket(),
      context({ coverageManifest: manifest, retrievalStopReason: 'safety_cap' }),
    );

    expect(packet.retrievalCompleteness).toBe('incomplete');
    expect(packet.truncated).toBe(true);
    expect(packet.incomplete).toBe(true);
    expect(packet.health.status).toBe('incomplete');
  });

  test('retains governed packet fields while adding Phase 17 retrieval truth', () => {
    const base = basePacket();
    const packet = compileCoverageAwareContextPacket(base, context());

    expect(packet.version).toBe(2);
    expect(packet.policyVersion).toBe(base.policyVersion);
    expect(packet.compilerVersion).toBe(base.compilerVersion);
    expect(packet.requiredLayers).toEqual(base.requiredLayers);
    expect(packet.items).toEqual(base.items);
    expect(packet.retrievalCompleteness).toBe('complete');
    expect(packet.coverageManifest?.recordsReturned).toBe(0);
  });

  test('integrity hash commits to Phase 17 retrieval truth', () => {
    const base = basePacket();
    const complete = compileCoverageAwareContextPacket(base, context());
    const incomplete = compileCoverageAwareContextPacket(
      base,
      context({
        coverageManifest: coverage({
          complete: false,
          stopReason: 'source_degraded',
          sources: [
            {
              ...coverage().sources[0]!,
              sourceStatus: 'degraded',
              coverageComplete: false,
              stopReason: 'source_degraded',
            },
          ],
        }),
        sourceHealth: { program_elements: 'degraded' },
        retrievalStopReason: 'source_degraded',
      }),
    );

    expect(complete.traceHash).not.toBe(base.traceHash);
    expect(incomplete.traceHash).not.toBe(base.traceHash);
    expect(incomplete.traceHash).not.toBe(complete.traceHash);
  });
});
