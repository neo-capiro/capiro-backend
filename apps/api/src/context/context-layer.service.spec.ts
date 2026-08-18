import {
  CONTEXT_LAYER_DEFINITIONS,
  CONTEXT_LAYER_ORDER,
  type ContextRequest,
} from '@capiro/meriv2-core';
import {
  RETRIEVAL_DOMAINS,
  type RetrievalDomain,
} from '../retrieval/retrieval-v2.types.js';
import {
  CONTEXT_LAYER_BY_RETRIEVAL_DOMAIN,
  ContextLayerService,
} from './context-layer.service.js';
import type {
  ContextResolutionResult,
  ContextSubjectScope,
} from './context-resolver.types.js';

function makeResolution(input: {
  kind?: ContextSubjectScope;
  clientIds?: string[];
  uiClientId?: string;
  domains?: RetrievalDomain[];
} = {}): ContextResolutionResult {
  const domains = input.domains ?? [];
  const retrievalRequest = domains.length
    ? {
        queryClass: 'lookup' as const,
        requestedDomains: domains,
        caller: { tenantId: 'tenant-1', userId: 'user-1' },
        query: 'test',
      }
    : undefined;

  return {
    status: 'ready',
    stopReason: retrievalRequest ? 'context_resolved_for_retrieval' : 'context_scope_resolved',
    securityScope: {
      tenantId: 'tenant-1',
      actorUserId: 'user-1',
      authorizedClientIds: ['client-1', 'client-2', 'ui-client'],
      authorizedMailboxConnectionIds: ['mailbox-1'],
      graphPartitions: [],
      allowExternalLookup: false,
    },
    subjectScope: {
      kind: input.kind ?? 'external_entity',
      source: 'explicit',
      clientIds: input.clientIds ?? [],
    },
    focusEntityRefs: [],
    canonicalEntityIds: [],
    uiContext: input.uiClientId ? { clientId: input.uiClientId } : {},
    retrievalAllowed: !!retrievalRequest,
    ...(retrievalRequest ? { retrievalRequest } : {}),
    trace: {
      resolverVersion: 'phase15-v1',
      uiClientSelected: !!input.uiClientId,
      uiClientWithinSecurityEnvelope: !!input.uiClientId,
      uiClientUsedAsSubject: input.kind === 'client',
      currentObjectSelected: false,
      currentObjectUsedAsFocus: false,
      externalLookupPermitted: false,
      externalLookupRan: false,
      retrievalPlanned: !!retrievalRequest,
    },
  };
}

function compilerRequest(input: Partial<ContextRequest> = {}): ContextRequest {
  return {
    tenantId: 'tenant-1',
    userId: 'user-1',
    surface: 'chat',
    layers: [
      'firm-identity',
      'firm-playbook',
      'user-voice',
      'client-steering',
      'client-people',
    ],
    ...input,
  };
}

function byId<T extends { id: string }>(items: readonly T[], id: string): T {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`missing layer ${id}`);
  return item;
}

describe('Knowledge Plane Phase 16 five context layers', () => {
  const service = new ContextLayerService();

  test('freezes exactly five architectural layers with Layer D reserved for live authoritative data', () => {
    expect(CONTEXT_LAYER_ORDER).toEqual([
      'firm-context',
      'user-context',
      'client-context',
      'live-authoritative',
      'institutional-knowledge',
    ]);
    expect(Object.keys(CONTEXT_LAYER_DEFINITIONS)).toHaveLength(5);
    expect(CONTEXT_LAYER_DEFINITIONS['firm-context']).toMatchObject({
      id: 'A',
      contentClass: 'steering',
    });
    expect(CONTEXT_LAYER_DEFINITIONS['user-context']).toMatchObject({
      id: 'B',
      contentClass: 'steering',
    });
    expect(CONTEXT_LAYER_DEFINITIONS['client-context']).toMatchObject({
      id: 'C',
      contentClass: 'steering',
    });
    expect(CONTEXT_LAYER_DEFINITIONS['live-authoritative']).toMatchObject({
      id: 'D',
      contentClass: 'evidence',
    });
    expect(CONTEXT_LAYER_DEFINITIONS['institutional-knowledge']).toMatchObject({
      id: 'E',
      contentClass: 'evidence',
    });
    expect(CONTEXT_LAYER_ORDER).not.toContain('external-research');
    expect(CONTEXT_LAYER_ORDER).not.toContain('security-scope');
    expect(CONTEXT_LAYER_ORDER).not.toContain('subject-scope');
    expect(CONTEXT_LAYER_ORDER).not.toContain('ui-context');
    expect(CONTEXT_LAYER_ORDER).not.toContain('meri');
    expect(CONTEXT_LAYER_ORDER).not.toContain('workspace');
  });

  test('keeps the existing SteeringLayer vocabulary as sub-layers of A-C', () => {
    const layers = service.fromCompilerRequest(compilerRequest({ clientId: 'client-1' }));

    expect(byId(layers, 'A').selectedSteeringLayers).toEqual([
      'firm-identity',
      'firm-playbook',
    ]);
    expect(byId(layers, 'B').selectedSteeringLayers).toEqual(['user-voice']);
    expect(byId(layers, 'C').selectedSteeringLayers).toEqual([
      'client-steering',
      'client-people',
    ]);
    expect(byId(layers, 'D').selectedSteeringLayers).toEqual([]);
    expect(byId(layers, 'E').selectedSteeringLayers).toEqual([]);
  });

  test('requires every Retrieval V2 domain to make an explicit D-or-E decision', () => {
    expect(Object.keys(CONTEXT_LAYER_BY_RETRIEVAL_DOMAIN).sort()).toEqual(
      [...RETRIEVAL_DOMAINS].sort(),
    );
    expect(
      Object.values(CONTEXT_LAYER_BY_RETRIEVAL_DOMAIN).every(
        (layer) => layer === 'live-authoritative' || layer === 'institutional-knowledge',
      ),
    ).toBe(true);
    expect(CONTEXT_LAYER_BY_RETRIEVAL_DOMAIN.program_elements).toBe('live-authoritative');
    expect(CONTEXT_LAYER_BY_RETRIEVAL_DOMAIN.legiwatch_bills).toBe('live-authoritative');
    expect(CONTEXT_LAYER_BY_RETRIEVAL_DOMAIN.directory).toBe('live-authoritative');
    expect(CONTEXT_LAYER_BY_RETRIEVAL_DOMAIN.mail).toBe('institutional-knowledge');
    expect(CONTEXT_LAYER_BY_RETRIEVAL_DOMAIN.meetings).toBe('institutional-knowledge');
    expect(CONTEXT_LAYER_BY_RETRIEVAL_DOMAIN.strategies_work).toBe('institutional-knowledge');
    expect(CONTEXT_LAYER_BY_RETRIEVAL_DOMAIN.institutional_knowledge).toBe(
      'institutional-knowledge',
    );
  });

  test('maps resolver output into D/E without turning UI focus into client context', () => {
    const layers = service.fromResolution(
      makeResolution({
        kind: 'external_entity',
        clientIds: [],
        uiClientId: 'ui-client',
        domains: ['program_elements', 'directory', 'mail', 'meetings'],
      }),
    );

    expect(layers).toHaveLength(5);
    expect(layers.map((layer) => layer.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(byId(layers, 'C').subjectClientIds).toEqual([]);
    expect(byId(layers, 'D').sourceRefs).toEqual(['program_elements', 'directory']);
    expect(byId(layers, 'E').sourceRefs).toEqual(['mail', 'meetings']);
    for (const layer of layers) {
      expect(layer).not.toHaveProperty('securityScope');
      expect(layer).not.toHaveProperty('subjectScope');
      expect(layer).not.toHaveProperty('uiContext');
    }
  });

  test('bridge removes legacy client steering when the resolved subject is external', () => {
    const bridge = service.bridgeToCompiler(
      makeResolution({ kind: 'external_entity', uiClientId: 'ui-client' }),
      compilerRequest({ clientId: 'ui-client' }),
    );

    expect(bridge.compilerRequest.clientId).toBeNull();
    expect(bridge.compilerRequest.layers).not.toContain('client-steering');
    expect(bridge.compilerRequest.layers).not.toContain('client-people');
    expect(byId(bridge.contextLayers, 'C').subjectClientIds).toEqual([]);
    expect(byId(bridge.contextLayers, 'C').selectedSteeringLayers).toEqual([]);
  });

  test('bridge keeps one explicitly resolved client and never substitutes the UI client', () => {
    const bridge = service.bridgeToCompiler(
      makeResolution({
        kind: 'client',
        clientIds: ['client-1'],
        uiClientId: 'ui-client',
      }),
      compilerRequest({ clientId: 'ui-client' }),
    );

    expect(bridge.compilerRequest.clientId).toBe('client-1');
    expect(bridge.compilerRequest.layers).toContain('client-steering');
    expect(byId(bridge.contextLayers, 'C').subjectClientIds).toEqual(['client-1']);
  });

  test('portfolio scope fails closed for the legacy single-client steering compiler', () => {
    const bridge = service.bridgeToCompiler(
      makeResolution({ kind: 'portfolio', clientIds: ['client-1', 'client-2'] }),
      compilerRequest({ clientId: 'client-1' }),
    );

    expect(bridge.compilerRequest.clientId).toBeNull();
    expect(bridge.compilerRequest.layers).not.toContain('client-steering');
    expect(bridge.compilerRequest.layers).not.toContain('client-people');
    expect(byId(bridge.contextLayers, 'C').subjectClientIds).toEqual([
      'client-1',
      'client-2',
    ]);
  });
});
