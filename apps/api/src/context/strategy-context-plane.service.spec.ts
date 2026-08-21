import {
  PHASE_26,
  STRATEGY_CONTEXT_DOMAINS,
  StrategyContextPlaneService,
} from './strategy-context-plane.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const MAILBOX = '44444444-4444-4444-8444-444444444444';
const STRATEGY = '55555555-5555-4555-8555-555555555555';
const NODE = '66666666-6666-4666-8666-666666666666';
const PACKET = '77777777-7777-4777-8777-777777777777';

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

function packet(surface: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    packetId: PACKET,
    persistedPacketId: PACKET,
    persisted: true,
    traceHash: 'phase26-trace',
    surface,
    clientId: CLIENT,
    items: [
      {
        id: 'memory-1',
        layer: 'client-steering',
        type: 'client-compass',
        authority: 'human-authored',
        selectionTier: 'automatic',
      },
    ],
    rendered: [
      {
        id: 'memory-1',
        layer: 'client-steering',
        type: 'client-compass',
        title: 'Client Compass',
        body: 'Prioritize the verified client objective.',
      },
    ],
    exclusions: [],
    health: { status: 'healthy', reasons: [] },
    retrievalCompleteness: 'complete',
    retrievalStopReason: 'complete',
    ...overrides,
  };
}

function context(
  currentObject: { type: string; id: string },
  overrides: Record<string, unknown> = {},
) {
  const domains = [...STRATEGY_CONTEXT_DOMAINS];
  return {
    resolution: {
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
      uiContext: { clientId: CLIENT, currentObject },
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
    },
    retrieval: {
      records: [
        {
          domain: 'strategies_work',
          recordId: `strategy:${STRATEGY}`,
          payload: {
            kind: 'strategy',
            id: STRATEGY,
            clientId: CLIENT,
            title: 'Current plan duplicate',
          },
          provenance: { source: 'sp_strategy' },
        },
        {
          domain: 'strategies_work',
          recordId: 'context_fact:fact-1',
          payload: {
            kind: 'context_fact',
            id: 'fact-1',
            clientId: CLIENT,
            fact: 'The client approved the FY27 objective.',
            sourceRef: 'heading:Goal',
          },
          provenance: { source: 'sp_context_fact' },
        },
        {
          domain: 'mail',
          recordId: 'mail-1',
          payload: {
            clientId: CLIENT,
            subject: 'Prior discussion',
            snippet: 'Discussed the verified objective.',
            bodyText: 'FULL PRIVATE MAIL BODY MUST NOT REACH THE MODEL',
          },
          provenance: { source: 'mail_messages' },
        },
      ],
      coverage: {
        requestedDomains: domains,
        searchedDomains: domains,
        requestedEntityCount: domains.length,
        searchedEntityCount: domains.length,
        recordsEvaluated: 3,
        recordsReturned: 3,
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

function harness(opts: {
  userFound?: boolean;
  clientFound?: boolean;
  packetSurface?: string;
  contextOverrides?: Record<string, unknown>;
} = {}) {
  const tx = {
    client: {
      findFirst: jest.fn().mockResolvedValue(
        opts.clientFound === false ? null : { id: CLIENT, name: 'Acme Corp' },
      ),
      findMany: jest.fn().mockResolvedValue(
        opts.clientFound === false ? [] : [{ id: CLIENT }],
      ),
    },
    integrationConnection: {
      findMany: jest.fn().mockResolvedValue([{ id: MAILBOX }]),
    },
  };
  const prisma = {
    user: {
      findFirst: jest.fn().mockResolvedValue(
        opts.userFound === false ? null : { id: USER },
      ),
    },
    withTenantUser: jest.fn(
      async (_tenantId: string, _userId: string, fn: (value: typeof tx) => unknown) => fn(tx),
    ),
  };
  const gateway = {
    requestContext: jest.fn(),
  };
  const service = new StrategyContextPlaneService(prisma as never, gateway as never);
  return { service, gateway, prisma, tx, opts };
}

function gatewayResult(
  currentObject: { type: string; id: string },
  surface = 'strategy',
  contextOverrides: Record<string, unknown> = {},
) {
  return {
    kind: 'governed_packet',
    packet: packet(surface),
    context: context(currentObject, contextOverrides),
  };
}

describe('StrategyContextPlaneService Phase 26', () => {
  test('Strategy draft uses strategies.generate and a persisted strategy packet', async () => {
    const h = harness();
    h.gateway.requestContext.mockResolvedValue(
      gatewayResult({ type: 'strategy_draft', id: CLIENT }),
    );

    const result = await h.service.resolve({
      tenantId: TENANT,
      clerkUserId: 'user_test',
      clientId: CLIENT,
      mode: 'draft',
      query: 'Protect the FY27 request',
    });

    expect(result.governedContext.operationId).toBe('strategies.generate');
    expect(result.governedContext.contextPacket.surface).toBe('strategy');
    expect(result.governedContext.prompt).toContain('Prioritize the verified client objective');
    expect(result.governedContext.prompt).toContain('The client approved the FY27 objective');
    expect(result.governedContext.prompt).not.toContain('FULL PRIVATE MAIL BODY');
    expect(h.gateway.requestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'strategies.generate',
        currentPhase: PHASE_26,
        resolverRequest: expect.objectContaining({
          surface: 'strategy',
          subjectScope: 'client',
          clientId: CLIENT,
          securityScope: expect.objectContaining({
            authorizedClientIds: [CLIENT],
            authorizedMailboxConnectionIds: [MAILBOX],
            allowExternalLookup: false,
          }),
        }),
        contextRequest: expect.objectContaining({
          surface: 'strategy',
          clientId: CLIENT,
          persistence: 'required',
        }),
      }),
    );
  });

  test('Strategy assistant excludes the duplicate current-plan retrieval record', async () => {
    const h = harness();
    h.gateway.requestContext.mockResolvedValue(
      gatewayResult({ type: 'strategy', id: STRATEGY }),
    );

    const result = await h.service.resolve({
      tenantId: TENANT,
      clerkUserId: 'user_test',
      clientId: CLIENT,
      mode: 'assistant',
      query: 'Move the coalition step',
      strategyId: STRATEGY,
    });

    expect(result.records.some((record) => record.recordId === `strategy:${STRATEGY}`)).toBe(false);
    expect(result.governedContext.prompt).not.toContain('Current plan duplicate');
    expect(result.governedContext.prompt).toContain('The client approved the FY27 objective');
  });

  test.each([
    ['workspace_draft', 'workspace.generate', 'workspace-gen'],
    ['outreach_record', 'outreach.generate', 'outreach'],
  ] as const)(
    '%s document generation compiles under its destination operation',
    async (artifactKind, operationId, surface) => {
      const h = harness();
      h.gateway.requestContext.mockResolvedValue(
        gatewayResult({ type: 'strategy_node', id: NODE }, surface),
      );

      const result = await h.service.resolve({
        tenantId: TENANT,
        clerkUserId: 'user_test',
        clientId: CLIENT,
        mode: 'document',
        artifactKind,
        nodeId: NODE,
        query: 'Draft the staged artifact',
      });

      expect(result.governedContext.operationId).toBe(operationId);
      expect(result.governedContext.contextPacket.surface).toBe(surface);
      expect(h.gateway.requestContext).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId,
          currentPhase: PHASE_26,
          resolverRequest: expect.objectContaining({ surface }),
          contextRequest: expect.objectContaining({ surface }),
        }),
      );
    },
  );

  test('rejects a walled, archived, cross-tenant, or missing client before retrieval', async () => {
    const h = harness({ clientFound: false });
    await expect(
      h.service.resolve({
        tenantId: TENANT,
        clerkUserId: 'user_test',
        clientId: CLIENT,
        mode: 'draft',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.gateway.requestContext).not.toHaveBeenCalled();
  });

  test('rejects an actor without an active tenant membership before retrieval', async () => {
    const h = harness({ userFound: false });
    await expect(
      h.service.resolve({
        tenantId: TENANT,
        clerkUserId: 'user_test',
        clientId: CLIENT,
        mode: 'draft',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.gateway.requestContext).not.toHaveBeenCalled();
  });

  test('rejects packet/client or packet/surface drift', async () => {
    const h = harness();
    h.gateway.requestContext.mockResolvedValue({
      ...gatewayResult({ type: 'strategy', id: STRATEGY }),
      packet: packet('outreach'),
    });
    await expect(
      h.service.resolve({
        tenantId: TENANT,
        clerkUserId: 'user_test',
        clientId: CLIENT,
        mode: 'assistant',
        strategyId: STRATEGY,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('partial or unavailable shared sources remain explicitly incomplete', async () => {
    const domains = [...STRATEGY_CONTEXT_DOMAINS];
    const h = harness();
    h.gateway.requestContext.mockResolvedValue({
      kind: 'governed_packet',
      packet: packet('strategy', {
        retrievalCompleteness: 'incomplete',
        retrievalStopReason: 'source_partial',
      }),
      context: context(
        { type: 'strategy_draft', id: CLIENT },
        {
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
              sources: [
                source('clients', {
                  sourceStatus: 'degraded',
                  coverageComplete: false,
                }),
              ],
              complete: false,
              stopReason: 'source_partial',
            },
            observability: {},
          },
        },
      ),
    });

    const result = await h.service.resolve({
      tenantId: TENANT,
      clerkUserId: 'user_test',
      clientId: CLIENT,
      mode: 'draft',
    });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.missingDomains.length).toBeGreaterThan(0);
    expect(result.governedContext.retrieval.coverage.complete).toBe(false);
    expect(result.governedContext.prompt).toContain('complete=false');
  });
});
