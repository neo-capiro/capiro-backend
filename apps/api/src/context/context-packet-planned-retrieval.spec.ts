import type {
  ContextRetrievalDirective,
  ContextRetrievalResult,
} from './context-resolver.types.js';
import { buildContextPacketRetrievalContext } from './context-packet-v2.service.js';

const planned: ContextRetrievalDirective = {
  queryClass: 'lookup',
  requestedDomains: ['clients', 'contacts', 'institutional_knowledge'],
  query: 'RTX',
  requireComplete: false,
};

const unresolved: ContextRetrievalResult = {
  resolution: {
    status: 'unresolved',
    stopReason: 'no_candidate_above_threshold',
    securityScope: {
      tenantId: '11111111-1111-1111-1111-111111111111',
      actorUserId: '22222222-2222-2222-2222-222222222222',
      authorizedClientIds: ['33333333-3333-3333-3333-333333333333'],
      authorizedMailboxConnectionIds: [],
      graphPartitions: [],
      allowExternalLookup: true,
    },
    subjectScope: { kind: 'external_entity', source: 'explicit', clientIds: [] },
    subjectEntity: {
      status: 'unresolved',
      confidence: 0.2,
      resolutionMethod: 'multi_source_no_match',
      publicLookupRan: true,
      stopReason: 'no_candidate_above_threshold',
      candidates: [],
    },
    focusEntityRefs: [],
    canonicalEntityIds: [],
    // Deliberately carries an unrelated selected client as UI state. The failed
    // external-entity resolution must not convert it into subject authorization.
    uiContext: { clientId: '33333333-3333-3333-3333-333333333333' },
    retrievalAllowed: false,
    trace: {
      resolverVersion: 'phase15-v1',
      uiClientSelected: true,
      uiClientWithinSecurityEnvelope: true,
      uiClientUsedAsSubject: false,
      currentObjectSelected: false,
      currentObjectUsedAsFocus: false,
      externalLookupPermitted: true,
      externalLookupRan: true,
      retrievalPlanned: false,
    },
  },
};

describe('Phase 17 planned retrieval truth', () => {
  test('unresolved entity keeps intended domains unchecked and incomplete even without a built RetrievalRequest', () => {
    const context = buildContextPacketRetrievalContext(unresolved, planned);

    expect(context.requested).toBe(true);
    expect(context.subjectScope).toEqual({
      kind: 'external_entity',
      source: 'explicit',
      clientIds: [],
    });
    expect(context.coverageManifest).toMatchObject({
      requestedDomains: ['clients', 'contacts', 'institutional_knowledge'],
      searchedDomains: [],
      unavailableSources: ['clients', 'contacts', 'institutional_knowledge'],
      recordsEvaluated: 0,
      recordsReturned: 0,
      paginationComplete: false,
      complete: false,
      stopReason: 'retrieval_response_missing',
    });
    expect(context.sourceHealth).toEqual({
      clients: 'unavailable',
      contacts: 'unavailable',
      institutional_knowledge: 'unavailable',
    });
    expect(context.sourceFreshness).toEqual({
      clients: null,
      contacts: null,
      institutional_knowledge: null,
    });
    expect(context.evidenceRefs).toEqual([]);
    expect(context.retrievalStopReason).toBe('retrieval_response_missing');
  });
});
