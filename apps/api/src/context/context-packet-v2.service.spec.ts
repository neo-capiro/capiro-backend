import type { CompiledContextPacketV2, ContextRequest } from '@capiro/meriv2-core';
import type { ContextRetrievalResult } from './context-resolver.types.js';
import { ContextLayerService } from './context-layer.service.js';
import {
  buildContextPacketRetrievalContext,
  ContextPacketV2Service,
} from './context-packet-v2.service.js';

function basePacket(overrides: Partial<CompiledContextPacketV2> = {}): CompiledContextPacketV2 {
  return {
    version: 2,
    packetId: null,
    surface: 'research',
    tenantId: '11111111-1111-1111-1111-111111111111',
    effectiveTenantId: '11111111-1111-1111-1111-111111111111',
    actorUserId: '22222222-2222-2222-2222-222222222222',
    userId: '22222222-2222-2222-2222-222222222222',
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
    ...overrides,
  };
}

function compilerRequest(): ContextRequest {
  return {
    tenantId: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    clientId: '99999999-9999-9999-9999-999999999999',
    surface: 'research',
    layers: [
      'firm-identity',
      'firm-playbook',
      'user-voice',
      'client-steering',
      'client-people',
    ],
  };
}

function retrievalResult(input: { withRetrieval?: boolean } = {}): ContextRetrievalResult {
  const withRetrieval = input.withRetrieval ?? true;
  const resolution: ContextRetrievalResult['resolution'] = {
    status: 'ready',
    stopReason: 'context_resolved_for_retrieval',
    securityScope: {
      tenantId: '11111111-1111-1111-1111-111111111111',
      actorUserId: '22222222-2222-2222-2222-222222222222',
      authorizedClientIds: ['99999999-9999-9999-9999-999999999999'],
      authorizedMailboxConnectionIds: [],
      graphPartitions: [],
      allowExternalLookup: true,
    },
    subjectScope: { kind: 'external_entity', source: 'explicit', clientIds: [] },
    subjectEntity: {
      status: 'resolved',
      canonicalEntityId: 'entity-rtx',
      canonicalName: 'RTX Corporation',
      entityType: 'organization',
      confidence: 0.99,
      resolutionMethod: 'exact_domain',
      publicLookupRan: false,
      stopReason: 'resolved',
      candidates: [],
    },
    focusEntityRefs: [{ type: 'canonical_entity', id: 'entity-rtx', label: 'RTX Corporation' }],
    canonicalEntityIds: ['entity-rtx'],
    uiContext: { clientId: '99999999-9999-9999-9999-999999999999' },
    retrievalAllowed: true,
    retrievalRequest: {
      queryClass: 'lookup',
      requestedDomains: ['program_elements'],
      caller: {
        tenantId: '11111111-1111-1111-1111-111111111111',
        userId: '22222222-2222-2222-2222-222222222222',
      },
      query: 'RTX',
      canonicalEntityIds: ['entity-rtx'],
    },
    trace: {
      resolverVersion: 'phase15-v1',
      uiClientSelected: true,
      uiClientWithinSecurityEnvelope: true,
      uiClientUsedAsSubject: false,
      currentObjectSelected: false,
      currentObjectUsedAsFocus: false,
      externalLookupPermitted: true,
      externalLookupRan: false,
      retrievalPlanned: true,
    },
  };

  if (!withRetrieval) return { resolution };

  return {
    resolution,
    retrieval: {
      records: [
        {
          domain: 'program_elements',
          recordId: 'pe-0605053A',
          entityRef: {
            type: 'canonical_entity',
            id: 'entity-rtx',
            label: 'RTX Corporation',
            metadata: { secretEntityMetadata: 'must not persist' },
          },
          canonicalEntityIds: ['entity-rtx'],
          occurredAt: new Date('2026-08-17T22:00:00.000Z'),
          updatedAt: new Date('2026-08-17T22:30:00.000Z'),
          payload: { secretBodyThatMustNotBeCopied: 'large source payload' },
          provenance: { source: 'DoD budget justification', page: 42 },
        },
      ],
      coverage: {
        requestedDomains: ['program_elements'],
        searchedDomains: ['program_elements'],
        requestedEntityCount: 1,
        searchedEntityCount: 1,
        recordsEvaluated: 1,
        recordsReturned: 1,
        paginationComplete: true,
        unavailableSources: [],
        sources: [
          {
            domain: 'program_elements',
            sourceStatus: 'healthy',
            total: 1,
            returned: 1,
            recordsEvaluated: 1,
            requestedEntityCount: 1,
            searchedEntityCount: 1,
            pagesRead: 1,
            hasMore: false,
            truncated: false,
            paginationComplete: true,
            coverageComplete: true,
            lastSyncAt: new Date('2026-08-17T22:30:00.000Z'),
            stopReason: 'complete',
          },
        ],
        complete: true,
        stopReason: 'complete',
      },
      observability: {
        queryClass: 'lookup',
        requestedDomains: ['program_elements'],
        queriedDatasets: ['program_elements'],
        requestedEntityCount: 1,
        queriedEntityCount: 1,
        pagesByDomain: { program_elements: 1 },
        sourceHealth: { program_elements: 'healthy' },
        freshnessByDomain: {
          program_elements: new Date('2026-08-17T22:30:00.000Z'),
        },
        coverageComplete: true,
        stopReason: 'complete',
      },
    },
  };
}

describe('ContextPacketV2Service Phase 17', () => {
  test('maps resolver/retrieval truth into the governed packet without UI-client leakage', async () => {
    const compiler = { compile: jest.fn().mockResolvedValue(basePacket()) };
    const prisma = { withTenant: jest.fn() };
    const service = new ContextPacketV2Service(
      compiler as never,
      new ContextLayerService(),
      prisma as never,
    );

    const packet = await service.compile(compilerRequest(), retrievalResult());

    expect(compiler.compile).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: null,
        layers: expect.not.arrayContaining(['client-steering', 'client-people']),
      }),
    );
    expect(packet.version).toBe(2);
    if (packet.version !== 2) throw new Error('expected v2');
    expect(packet.subjectScope.kind).toBe('external_entity');
    expect(packet.resolvedEntities[0]).toMatchObject({
      canonicalEntityId: 'entity-rtx',
      canonicalName: 'RTX Corporation',
    });
    expect(packet.retrievalCompleteness).toBe('complete');
    expect(packet.sourceHealth.program_elements).toBe('healthy');
    expect(packet.sourceFreshness.program_elements).toBe('2026-08-17T22:30:00.000Z');
    expect(packet.traceHash).not.toBe('trace');
  });

  test('stores bounded evidence identity/provenance but never copies retrieval payload or entity metadata', () => {
    const context = buildContextPacketRetrievalContext(retrievalResult());
    const encoded = JSON.stringify(context.evidenceRefs);

    expect(context.evidenceRefs[0]).toMatchObject({
      domain: 'program_elements',
      recordId: 'pe-0605053A',
      entityRef: {
        type: 'canonical_entity',
        id: 'entity-rtx',
        label: 'RTX Corporation',
      },
      provenance: { source: 'DoD budget justification', page: 42 },
    });
    expect(encoded).not.toContain('secretBodyThatMustNotBeCopied');
    expect(encoded).not.toContain('large source payload');
    expect(encoded).not.toContain('secretEntityMetadata');
    expect(encoded).not.toContain('must not persist');
  });

  test('planned retrieval with no response preserves requested domains and cannot masquerade as complete', async () => {
    const compiler = { compile: jest.fn().mockResolvedValue(basePacket()) };
    const service = new ContextPacketV2Service(
      compiler as never,
      new ContextLayerService(),
      { withTenant: jest.fn() } as never,
    );

    const packet = await service.compile(
      compilerRequest(),
      retrievalResult({ withRetrieval: false }),
    );

    if (packet.version !== 2) throw new Error('expected v2');
    expect(packet.coverageManifest).toMatchObject({
      requestedDomains: ['program_elements'],
      searchedDomains: [],
      unavailableSources: ['program_elements'],
      complete: false,
      stopReason: 'retrieval_response_missing',
    });
    expect(packet.sourceHealth.program_elements).toBe('unavailable');
    expect(packet.sourceFreshness.program_elements).toBeNull();
    expect(packet.retrievalCompleteness).toBe('incomplete');
    expect(packet.retrievalStopReason).toBe('retrieval_response_missing');
    expect(packet.incomplete).toBe(true);
    expect(packet.health.status).toBe('incomplete');
  });

  test('persists retrieval metadata, evidence refs, failures, integrity hash, and revised health on the same packet row', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn(),
    };
    const prisma = {
      withTenant: jest.fn().mockImplementation(async (_tenantId, run) => run(tx)),
    };
    const compiler = {
      compile: jest.fn().mockResolvedValue(
        basePacket({
          packetId: '33333333-3333-3333-3333-333333333333',
          persistedPacketId: '33333333-3333-3333-3333-333333333333',
          persisted: true,
        }),
      ),
    };
    const service = new ContextPacketV2Service(
      compiler as never,
      new ContextLayerService(),
      prisma as never,
    );

    const packet = await service.compile(compilerRequest(), retrievalResult());

    expect(packet.version).toBe(2);
    expect(prisma.withTenant).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      expect.any(Function),
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  test('keeps off/shadow v1 output unchanged until Phase 18 enforcement', async () => {
    const v1 = {
      ...basePacket(),
      version: 1 as const,
      items: [],
    } as never;
    const compiler = { compile: jest.fn().mockResolvedValue(v1) };
    const service = new ContextPacketV2Service(
      compiler as never,
      new ContextLayerService(),
      { withTenant: jest.fn() } as never,
    );

    const packet = await service.compile(compilerRequest(), retrievalResult());

    expect(packet).toBe(v1);
  });
});
