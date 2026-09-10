import { ForbiddenException } from '@nestjs/common';
import { describe, expect, jest, test } from '@jest/globals';
import type { UniversalEntityResolutionOrchestrationResult } from '../knowledge/entities/universal-entity-resolution-orchestrator.types.js';
import type { RetrievalResponse } from '../retrieval/retrieval-v2.types.js';
import { ContextResolverService } from './context-resolver.service.js';
import type { ContextResolutionRequest } from './context-resolver.types.js';

const retrievalResponse = {} as RetrievalResponse;

function resolvedEntity(): UniversalEntityResolutionOrchestrationResult {
  const now = new Date('2026-08-17T12:00:00.000Z');
  return {
    resolutionId: 'resolution-1',
    status: 'resolved',
    entity: {
      id: 'entity-1',
      tenantId: null,
      identityScope: 'global_public',
      entityType: 'organization',
      canonicalName: 'Anduril Industries',
      normalizedName: 'anduril industries',
      status: 'active',
      resolutionConfidence: 0.99,
      resolutionMethod: 'canonical_name_exact',
      metadata: {},
      mergedIntoEntityId: null,
      createdAt: now,
      updatedAt: now,
    },
    confidence: 0.99,
    resolutionMethod: 'canonical_name_exact',
    candidates: [],
    provenance: [],
    requiresUserConfirmation: false,
    attemptedStages: [],
    publicLookupRan: false,
    stopReason: 'deterministic_match',
  };
}

function ambiguousEntity(): UniversalEntityResolutionOrchestrationResult {
  return {
    resolutionId: 'resolution-2',
    status: 'ambiguous',
    entity: null,
    confidence: 0.5,
    resolutionMethod: 'multiple_name_matches',
    candidates: [
      {
        candidateKey: 'a',
        entityId: 'entity-a',
        canonicalName: 'Acme A',
        entityType: 'organization',
        confidence: 0.5,
        stage: 'existing_canonical',
        sourceType: 'canonical_entity',
        sourceId: 'entity-a',
        sourceUrl: null,
        evidenceKinds: ['name_only'],
        provenance: [],
      },
      {
        candidateKey: 'b',
        entityId: 'entity-b',
        canonicalName: 'Acme B',
        entityType: 'organization',
        confidence: 0.5,
        stage: 'existing_canonical',
        sourceType: 'canonical_entity',
        sourceId: 'entity-b',
        sourceUrl: null,
        evidenceKinds: ['name_only'],
        provenance: [],
      },
    ],
    provenance: [],
    requiresUserConfirmation: true,
    attemptedStages: [],
    publicLookupRan: false,
    stopReason: 'ambiguous_candidates_require_confirmation',
  };
}

function request(overrides: Partial<ContextResolutionRequest> = {}): ContextResolutionRequest {
  return {
    tenantId: 'tenant-1',
    actorUserId: 'user-1',
    surface: 'chat',
    task: 'Research the requested subject',
    securityScope: { authorizedClientIds: ['client-1', 'client-2'] },
    ...overrides,
  };
}

function harness(entityResult = resolvedEntity()) {
  const callOrder: string[] = [];
  const entityResolver = {
    resolveAcrossSources: jest.fn(async () => {
      callOrder.push('entity');
      return entityResult;
    }),
  };
  const retrieval = {
    retrieve: jest.fn(async () => {
      callOrder.push('retrieval');
      return retrievalResponse;
    }),
  };
  return {
    service: new ContextResolverService(entityResolver as never, retrieval as never),
    entityResolver,
    retrieval,
    callOrder,
  };
}

describe('ContextResolverService', () => {
  test('does not convert the UI-selected client into subject scope or authorization', async () => {
    const { service, entityResolver } = harness();
    const result = await service.resolve(
      request({
        clientId: 'client-1',
        retrieval: { queryClass: 'lookup', requestedDomains: ['clients'] },
      }),
    );

    expect(result.subjectScope).toEqual({
      kind: 'general',
      source: 'default_general',
      clientIds: [],
    });
    expect(result.focusEntityRefs).toEqual([]);
    expect(result.retrievalRequest?.caller).toMatchObject({
      authorizedClientIds: ['client-1', 'client-2'],
    });
    expect(result.retrievalRequest?.caller.clientIds).toBeUndefined();
    expect(result.trace).toMatchObject({
      uiClientSelected: true,
      uiClientWithinSecurityEnvelope: true,
      uiClientUsedAsSubject: false,
    });
    expect(entityResolver.resolveAcrossSources).not.toHaveBeenCalled();
  });

  test('uses a client only when client subject scope is explicit and authorized', async () => {
    const { service } = harness();
    const result = await service.resolve(
      request({
        subjectScope: 'client',
        clientId: 'client-1',
        retrieval: { queryClass: 'lookup', requestedDomains: ['clients'] },
      }),
    );

    expect(result.subjectScope.clientIds).toEqual(['client-1']);
    expect(result.focusEntityRefs).toEqual([{ type: 'client', id: 'client-1' }]);
    expect(result.retrievalRequest?.caller.clientIds).toEqual(['client-1']);
    expect(result.trace.uiClientUsedAsSubject).toBe(true);
  });

  test('fails closed when a client subject is outside SecurityScope', async () => {
    const { service, retrieval } = harness();

    await expect(
      service.resolveAndRetrieve(request({ subjectScope: 'client', clientId: 'client-99' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
  });

  test('uses the authorized client envelope for explicit portfolio scope', async () => {
    const { service } = harness();
    const result = await service.resolve(
      request({
        subjectScope: 'portfolio',
        retrieval: { queryClass: 'portfolio_scan', requestedDomains: ['clients'] },
      }),
    );

    expect(result.subjectScope.clientIds).toEqual(['client-1', 'client-2']);
    expect(result.retrievalRequest?.caller.clientIds).toEqual(['client-1', 'client-2']);
  });

  test('resolves an external entity before Retrieval V2 and never auto-registers it', async () => {
    const { service, entityResolver, retrieval, callOrder } = harness();
    const result = await service.resolveAndRetrieve(
      request({
        securityScope: {
          authorizedClientIds: ['client-1', 'client-2'],
          allowExternalLookup: true,
        },
        subjectScope: 'external_entity',
        subject: {
          query: 'Anduril Industries',
          entityTypeHint: 'organization',
          allowExternalLookup: true,
        },
        retrieval: {
          queryClass: 'entity_history',
          requestedDomains: ['institutional_knowledge'],
          windowStart: new Date('2026-01-01T00:00:00.000Z'),
          windowEnd: new Date('2026-08-18T00:00:00.000Z'),
          observedThrough: new Date('2026-08-17T23:59:59.000Z'),
        },
      }),
    );

    expect(callOrder).toEqual(['entity', 'retrieval']);
    expect(result.resolution.canonicalEntityIds).toEqual(['entity-1']);
    expect(result.resolution.retrievalRequest?.canonicalEntityIds).toEqual(['entity-1']);
    expect(entityResolver.resolveAcrossSources).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({
        allowExternalLookup: true,
        allowAuthoritativePublicRegistration: false,
      }),
    );
    expect(retrieval.retrieve).toHaveBeenCalledTimes(1);
  });

  test('blocks retrieval when external identity remains ambiguous', async () => {
    const { service, retrieval } = harness(ambiguousEntity());
    const result = await service.resolveAndRetrieve(
      request({
        subjectScope: 'external_entity',
        subject: { query: 'Acme' },
        retrieval: { queryClass: 'lookup', requestedDomains: ['directory'] },
      }),
    );

    expect(result.resolution.status).toBe('ambiguous');
    expect(result.resolution.retrievalAllowed).toBe(false);
    expect(result.resolution.subjectEntity?.candidates).toHaveLength(2);
    expect(retrieval.retrieve).not.toHaveBeenCalled();
  });

  test('requires both request and SecurityScope opt-in before external lookup', async () => {
    const { service, entityResolver } = harness();
    await service.resolve(
      request({
        securityScope: {
          authorizedClientIds: ['client-1'],
          allowExternalLookup: false,
        },
        subjectScope: 'external_entity',
        subject: { query: 'Anduril', allowExternalLookup: true },
      }),
    );

    expect(entityResolver.resolveAcrossSources).toHaveBeenCalledWith(
      'tenant-1',
      expect.objectContaining({ allowExternalLookup: false }),
    );
  });

  test('does not promote the current UI object to focus without explicit opt-in', async () => {
    const { service } = harness();
    const baseline = await service.resolve(
      request({ currentObject: { type: 'program_element', id: '0605053A' } }),
    );
    const optedIn = await service.resolve(
      request({
        currentObject: { type: 'program_element', id: '0605053A' },
        includeCurrentObjectAsFocus: true,
      }),
    );

    expect(baseline.focusEntityRefs).toEqual([]);
    expect(baseline.trace.currentObjectUsedAsFocus).toBe(false);
    expect(optedIn.focusEntityRefs).toEqual([{ type: 'program_element', id: '0605053A' }]);
    expect(optedIn.trace.currentObjectUsedAsFocus).toBe(true);
  });

  test('carries an explicit authorized mailbox subset into Retrieval V2', async () => {
    const { service } = harness();
    const result = await service.resolve(
      request({
        securityScope: {
          authorizedClientIds: ['client-1'],
          authorizedMailboxConnectionIds: ['mailbox-1'],
        },
        retrieval: { queryClass: 'lookup', requestedDomains: ['mail'] },
      }),
    );

    expect(result.retrievalRequest?.caller.authorizedMailboxConnectionIds).toEqual(['mailbox-1']);
  });

  test('bridges the authorized envelope into legacy exact client lookup', async () => {
    const { service } = harness();
    const result = await service.resolve(
      request({
        retrieval: {
          queryClass: 'lookup',
          requestedDomains: ['clients'],
          exactLexical: { kind: 'canonical_name', value: 'Acme' },
        },
      }),
    );

    expect(result.retrievalRequest?.caller.clientIds).toEqual(['client-1', 'client-2']);
  });
});
