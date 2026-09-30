import {
  LEGIWATCH_CLIENT_CONTEXT_DOMAINS,
  LegiWatchContextPlaneService,
} from './legiwatch-context-plane.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const MAILBOX = '44444444-4444-4444-8444-444444444444';
const PACKET = '55555555-5555-4555-8555-555555555555';

function source(domain: string, overrides: Record<string, unknown> = {}) {
  return {
    domain,
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
    stopReason: 'complete',
    ...overrides,
  };
}

function packet(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    packetId: PACKET,
    persistedPacketId: PACKET,
    persisted: true,
    traceHash: 'phase22-trace',
    rendered: [
      {
        layer: 'firm-identity',
        id: 'm0',
        type: 'firm-soul',
        slug: 'firm',
        title: 'Firm Soul',
        body: 'Use disciplined government-affairs analysis.',
        contentHash: 'h0',
      },
      {
        layer: 'client-steering',
        id: 'm1',
        type: 'client-compass',
        slug: CLIENT,
        title: 'Client Compass',
        body: 'Prioritize the manufacturing coalition and avoid speculative claims.',
        contentHash: 'h1',
      },
    ],
    exclusions: [],
    retrievalCompleteness: 'complete',
    retrievalStopReason: 'complete',
    ...overrides,
  };
}

function resolution() {
  return {
    status: 'ready',
    stopReason: 'context_resolved_for_retrieval',
    securityScope: {
      tenantId: TENANT,
      actorUserId: USER,
      authorizedClientIds: [CLIENT],
      authorizedMailboxConnectionIds: [MAILBOX],
      graphPartitions: [],
      allowExternalLookup: false,
    },
    subjectScope: { kind: 'client', source: 'explicit', clientIds: [CLIENT] },
    focusEntityRefs: [],
    canonicalEntityIds: [],
    uiContext: { clientId: CLIENT },
    retrievalAllowed: true,
    trace: {
      resolverVersion: 'phase15-v1',
      uiClientSelected: true,
      uiClientWithinSecurityEnvelope: true,
      uiClientUsedAsSubject: true,
      currentObjectSelected: true,
      currentObjectUsedAsFocus: true,
      externalLookupPermitted: false,
      externalLookupRan: false,
      retrievalPlanned: true,
    },
  };
}

function context(overrides: Record<string, unknown> = {}) {
  const domains = [...LEGIWATCH_CLIENT_CONTEXT_DOMAINS];
  return {
    resolution: resolution(),
    retrieval: {
      records: [
        {
          // A domain LegiWatch actually requests, so it must be projected.
          domain: 'institutional_knowledge',
          recordId: 'note-1',
          payload: { objective: 'Build bipartisan support before the next procedural window.' },
          provenance: { source: 'tenant_note' },
        },
        {
          // LegiWatch never requests Strategy work state. Even if a shared
          // adapter returns it, the projection must DROP it — LegiWatch reporting
          // must not consume Strategy execution/plan state as client history.
          domain: 'strategies_work',
          recordId: 'strategy-1',
          payload: { objective: 'UNREQUESTED STRATEGY WORK PAYLOAD' },
          provenance: { source: 'tenant_strategy' },
        },
      ],
      coverage: {
        requestedDomains: domains,
        searchedDomains: domains,
        requestedEntityCount: domains.length,
        searchedEntityCount: domains.length,
        recordsEvaluated: 2,
        recordsReturned: 2,
        paginationComplete: true,
        unavailableSources: [],
        sources: domains.map((domain) => source(domain)),
        complete: true,
        stopReason: 'complete',
      },
      observability: {},
    },
    ...overrides,
  };
}

function harness(opts: { authorized?: boolean; contextOverrides?: Record<string, unknown>; packetOverrides?: Record<string, unknown> } = {}) {
  const tx = {
    client: {
      findMany: jest.fn().mockResolvedValue(opts.authorized === false ? [] : [{ id: CLIENT }]),
    },
    integrationConnection: {
      findMany: jest.fn().mockResolvedValue([{ id: MAILBOX }]),
    },
  };
  const prisma = {
    withTenantUser: jest.fn(async (_tenantId: string, _userId: string, fn: (value: typeof tx) => unknown) => fn(tx)),
  };
  const gateway = {
    requestContext: jest.fn().mockResolvedValue({
      kind: 'governed_packet',
      packet: packet(opts.packetOverrides),
      context: context(opts.contextOverrides),
    }),
  };
  return {
    service: new LegiWatchContextPlaneService(prisma as never, gateway as never),
    gateway,
    tx,
  };
}

const input = {
  clientId: CLIENT,
  clientName: 'Acme Corp',
  alertId: 'alert-1',
  alertTitle: 'H.R. 8800 floor action scheduled',
  sourceType: 'bill',
  sourceRef: 'hr8800-119',
};

describe('LegiWatchContextPlaneService Phase 22', () => {
  test('crosses the shared gateway with server-owned client and mailbox scope', async () => {
    const h = harness();
    const result = await h.service.resolve({ tenantId: TENANT, userId: USER } as never, input);

    expect(result.packetId).toBe(PACKET);
    expect(result.coverage.complete).toBe(true);
    expect(result.steering).toContain('Use disciplined government-affairs analysis');
    expect(result.steering).toContain('Prioritize the manufacturing coalition');
    expect(result.supplementalContext).toContain('Build bipartisan support');
    expect(result.supplementalContext).toContain('FACT SHEET remains the ONLY material');
    // Unrequested domains are dropped rather than silently rendered.
    expect(result.supplementalContext).not.toContain('UNREQUESTED STRATEGY WORK PAYLOAD');
    expect(result.supplementalContext).not.toContain('strategies_work');

    expect(h.gateway.requestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'legiwatch.generate-report',
        currentPhase: 22,
        resolverRequest: expect.objectContaining({
          tenantId: TENANT,
          actorUserId: USER,
          surface: 'legiwatch',
          subjectScope: 'client',
          clientId: CLIENT,
          securityScope: expect.objectContaining({
            authorizedClientIds: [CLIENT],
            authorizedMailboxConnectionIds: [MAILBOX],
            allowExternalLookup: false,
          }),
          retrieval: expect.objectContaining({
            queryClass: 'lookup',
            requestedDomains: [...LEGIWATCH_CLIENT_CONTEXT_DOMAINS],
            query: 'H.R. 8800',
          }),
        }),
        contextRequest: expect.objectContaining({
          surface: 'memo',
          tenantId: TENANT,
          actorUserId: USER,
          clientId: CLIENT,
          layers: ['firm-identity', 'firm-playbook', 'client-steering', 'client-people'],
          persistence: 'required',
          contractVersion: 2,
        }),
      }),
    );
  });

  test('never requests legislative/public fact domains from the supplemental rail', async () => {
    const h = harness();
    await h.service.resolve({ tenantId: TENANT, userId: USER } as never, input);
    const call = h.gateway.requestContext.mock.calls[0]![0] as {
      resolverRequest: { retrieval: { requestedDomains: string[] } };
    };
    const requested = call.resolverRequest.retrieval.requestedDomains;
    expect(requested).not.toContain('legiwatch_bills');
    expect(requested).not.toContain('hearings');
    expect(requested).not.toContain('program_elements');
    expect(requested).toEqual([...LEGIWATCH_CLIENT_CONTEXT_DOMAINS]);
  });

  test('the wall decision is read off the actor-keyed wall filter, never asserted', async () => {
    const h = harness();
    await h.service.resolve({ tenantId: TENANT, userId: USER } as never, input);

    // The envelope is the upstream enforcement: both the retrieval scope and the
    // packet's ethical-wall flag are derived from this one actor-keyed read.
    expect(h.tx.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: TENANT,
          OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: USER } } }],
        }),
      }),
    );
    expect(h.gateway.requestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        contextRequest: expect.objectContaining({ ethicalWallAllowed: true }),
      }),
    );
  });

  test('walled or unauthorized client fails before the gateway can retrieve anything', async () => {
    const h = harness({ authorized: false });
    await expect(
      h.service.resolve({ tenantId: TENANT, userId: USER } as never, input),
    ).rejects.toMatchObject({ status: 403 });
    expect(h.gateway.requestContext).not.toHaveBeenCalled();
  });

  test('partial or unavailable context remains explicitly incomplete', async () => {
    const domains = [...LEGIWATCH_CLIENT_CONTEXT_DOMAINS];
    const h = harness({
      packetOverrides: {
        retrievalCompleteness: 'incomplete',
        retrievalStopReason: 'source_partial',
      },
      contextOverrides: {
        retrieval: {
          records: [],
          coverage: {
            requestedDomains: domains,
            searchedDomains: ['clients'],
            requestedEntityCount: domains.length,
            searchedEntityCount: 1,
            recordsEvaluated: 0,
            recordsReturned: 0,
            paginationComplete: false,
            unavailableSources: domains.slice(1),
            sources: [source('clients', { sourceStatus: 'degraded', coverageComplete: false })],
            complete: false,
            stopReason: 'source_partial',
          },
          observability: {},
        },
      },
    });

    const result = await h.service.resolve({ tenantId: TENANT, userId: USER } as never, input);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.stopReason).toBe('source_partial');
    expect(result.coverage.missingDomains.length).toBeGreaterThan(0);
    expect(result.supplementalContext).toContain('complete=false');
  });
});
