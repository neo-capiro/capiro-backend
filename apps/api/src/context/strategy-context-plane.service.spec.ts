import {
  PHASE_26,
  STRATEGY_CONTEXT_DOMAINS,
  StrategyContextPlaneService,
} from './strategy-context-plane.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const MAILBOX = '44444444-4444-4444-8444-444444444444';
const MEMBERSHIP = '55555555-5555-4555-8555-555555555555';
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

/**
 * Default anchor projection: the requested Strategy and node both exist, are
 * live, sit in this tenant, and belong to the requested client. Tests override
 * `anchorRows` to model the cross-client / missing / cross-strategy cases.
 */
const LIVE_ANCHORS = [
  { anchor: 'strategy', anchorId: STRATEGY, clientId: CLIENT, strategyId: null },
  { anchor: 'node', anchorId: NODE, clientId: CLIENT, strategyId: STRATEGY },
];

function harness(
  opts: {
    userFound?: boolean;
    membershipFound?: boolean;
    clientFound?: boolean;
    packetSurface?: string;
    contextOverrides?: Record<string, unknown>;
    anchorRows?: Record<string, unknown>[];
  } = {},
) {
  const tx = {
    client: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.clientFound === false ? null : { id: CLIENT, name: 'Acme Corp' }),
      findMany: jest.fn().mockResolvedValue(opts.clientFound === false ? [] : [{ id: CLIENT }]),
    },
    integrationConnection: {
      findMany: jest.fn().mockResolvedValue([{ id: MAILBOX }]),
    },
    // The active-membership probe runs inside withTenant, because
    // tenant_memberships is FORCE RLS and capiro_app has no BYPASSRLS.
    tenantMembership: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.membershipFound === false ? null : { id: MEMBERSHIP }),
    },
    // sp_strategy/sp_node anchor projection. api-strategy owns those tables and
    // apps/api has no Prisma model for them, so the bridge reads them raw.
    $queryRaw: jest.fn().mockResolvedValue(opts.anchorRows ?? LIVE_ANCHORS),
  };
  const prisma = {
    user: {
      findFirst: jest.fn().mockResolvedValue(opts.userFound === false ? null : { id: USER }),
    },
    withTenant: jest.fn(async (_tenantId: string, fn: (value: typeof tx) => unknown) => fn(tx)),
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
    h.gateway.requestContext.mockResolvedValue(gatewayResult({ type: 'strategy', id: STRATEGY }));

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

  test('the wall decision is read off the actor-keyed wall filter, never asserted', async () => {
    const h = harness();
    h.gateway.requestContext.mockResolvedValue(
      gatewayResult({ type: 'strategy_draft', id: CLIENT }),
    );

    await h.service.resolve({
      tenantId: TENANT,
      clerkUserId: 'user_test',
      clientId: CLIENT,
      mode: 'draft',
    });

    // Keyed on the RESOLVED internal user, not the Clerk id the bridge was sent.
    const wall = [{ memoryWall: false }, { memoryAccessGrants: { some: { userId: USER } } }];
    expect(h.tx.client.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: CLIENT, tenantId: TENANT, OR: wall }),
      }),
    );
    expect(h.tx.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: TENANT, OR: wall }) }),
    );
    expect(h.gateway.requestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        contextRequest: expect.objectContaining({ userId: USER, ethicalWallAllowed: true }),
      }),
    );
  });

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

  test('rejects a known user whose tenant membership is not active', async () => {
    const h = harness({ membershipFound: false });
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

  test('resolves the actor in two steps so the RLS-protected membership read is tenant-scoped', async () => {
    // Regression guard for the production failure where the active-membership
    // check rode along as a `memberships: { some: ... }` relation filter on the
    // un-scoped `users` lookup. `tenant_memberships` is FORCE ROW LEVEL
    // SECURITY (`rls_bypass() OR tenant_id = current_tenant_id()`) and
    // `capiro_app` has no BYPASSRLS, so that subquery saw zero rows with no
    // tenant GUC set and EVERY caller 404'd as `Strategy actor not found`.
    const h = harness();
    h.gateway.requestContext.mockResolvedValue(
      gatewayResult({ type: 'strategy_draft', id: CLIENT }),
    );

    await h.service.resolve({
      tenantId: TENANT,
      clerkUserId: 'user_test',
      clientId: CLIENT,
      mode: 'draft',
    });

    // 1. the un-scoped lookup touches ONLY `users` — no membership relation.
    expect(h.prisma.user.findFirst).toHaveBeenCalledWith({
      where: { clerkUserId: 'user_test' },
      select: { id: true },
    });
    // 2. the membership probe runs inside a tenant scope.
    expect(h.prisma.withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(h.tx.tenantMembership.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, userId: USER, status: 'active' },
      select: { id: true },
    });
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
  // -- Anchor validation (#1157) --------------------------------------------
  //
  // The bridge previously accepted any strategyId/nodeId and returned 201. No
  // data leak was demonstrated - retrieval is SubjectScope-filtered, so a
  // cross-client anchor produced a packet equivalent to the clean control for
  // the requested client - but provenance was misleading and there was no
  // fail-closed invariant to stop a future retrieval change from turning that
  // into a real isolation problem.
  describe('Strategy anchor validation', () => {
    const CLIENT_B = '88888888-8888-4888-8888-888888888888';
    const STRATEGY_B = '99999999-9999-4999-8999-999999999999';

    test('a nonexistent Strategy fails closed before any retrieval', async () => {
      const h = harness({ anchorRows: [] });
      await expect(
        h.service.resolve({
          tenantId: TENANT,
          clerkUserId: 'user_test',
          clientId: CLIENT,
          mode: 'assistant',
          strategyId: STRATEGY,
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(h.gateway.requestContext).not.toHaveBeenCalled();
    });

    test('a Strategy owned by another client fails closed before any retrieval', async () => {
      const h = harness({
        anchorRows: [
          { anchor: 'strategy', anchorId: STRATEGY, clientId: CLIENT_B, strategyId: null },
        ],
      });
      await expect(
        h.service.resolve({
          tenantId: TENANT,
          clerkUserId: 'user_test',
          clientId: CLIENT,
          mode: 'assistant',
          strategyId: STRATEGY,
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(h.gateway.requestContext).not.toHaveBeenCalled();
    });

    test('a nonexistent node fails closed before any retrieval', async () => {
      const h = harness({ anchorRows: [] });
      await expect(
        h.service.resolve({
          tenantId: TENANT,
          clerkUserId: 'user_test',
          clientId: CLIENT,
          mode: 'document',
          artifactKind: 'workspace_draft',
          nodeId: NODE,
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(h.gateway.requestContext).not.toHaveBeenCalled();
    });

    test('a node from a different Strategy fails closed before any retrieval', async () => {
      const h = harness({
        anchorRows: [
          { anchor: 'strategy', anchorId: STRATEGY, clientId: CLIENT, strategyId: null },
          { anchor: 'node', anchorId: NODE, clientId: CLIENT, strategyId: STRATEGY_B },
        ],
      });
      await expect(
        h.service.resolve({
          tenantId: TENANT,
          clerkUserId: 'user_test',
          clientId: CLIENT,
          mode: 'document',
          artifactKind: 'workspace_draft',
          strategyId: STRATEGY,
          nodeId: NODE,
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(h.gateway.requestContext).not.toHaveBeenCalled();
    });

    test('a node whose owning Strategy belongs to another client fails closed', async () => {
      const h = harness({
        anchorRows: [{ anchor: 'node', anchorId: NODE, clientId: CLIENT_B, strategyId: STRATEGY }],
      });
      await expect(
        h.service.resolve({
          tenantId: TENANT,
          clerkUserId: 'user_test',
          clientId: CLIENT,
          mode: 'document',
          artifactKind: 'outreach_record',
          nodeId: NODE,
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(h.gateway.requestContext).not.toHaveBeenCalled();
    });

    test('a malformed anchor id is not-found, never a cast failure', async () => {
      const h = harness();
      await expect(
        h.service.resolve({
          tenantId: TENANT,
          clerkUserId: 'user_test',
          clientId: CLIENT,
          mode: 'assistant',
          strategyId: 'not-a-uuid',
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(h.tx.$queryRaw).not.toHaveBeenCalled();
      expect(h.gateway.requestContext).not.toHaveBeenCalled();
    });

    test('every rejected anchor uses one non-disclosing response', async () => {
      const cases: Record<string, unknown>[][] = [
        [],
        [{ anchor: 'strategy', anchorId: STRATEGY, clientId: CLIENT_B, strategyId: null }],
      ];
      const messages = new Set<string>();
      for (const anchorRows of cases) {
        const h = harness({ anchorRows });
        await h.service
          .resolve({
            tenantId: TENANT,
            clerkUserId: 'user_test',
            clientId: CLIENT,
            mode: 'assistant',
            strategyId: STRATEGY,
          })
          .catch((error: { message: string }) => messages.add(error.message));
      }
      // Existing-in-another-client must be indistinguishable from nonexistent.
      expect(messages.size).toBe(1);
      expect([...messages][0]).not.toContain(CLIENT_B);
    });

    test('a valid Strategy under the requested client is admitted', async () => {
      const h = harness();
      h.gateway.requestContext.mockResolvedValue(gatewayResult({ type: 'strategy', id: STRATEGY }));
      const result = await h.service.resolve({
        tenantId: TENANT,
        clerkUserId: 'user_test',
        clientId: CLIENT,
        mode: 'assistant',
        strategyId: STRATEGY,
      });
      expect(result.kind).toBe('governed_packet');
      expect(h.gateway.requestContext).toHaveBeenCalledTimes(1);
    });

    test('a valid node under a valid Strategy and client is admitted', async () => {
      const h = harness();
      h.gateway.requestContext.mockResolvedValue(
        gatewayResult({ type: 'strategy_node', id: NODE }, 'workspace-gen'),
      );
      const result = await h.service.resolve({
        tenantId: TENANT,
        clerkUserId: 'user_test',
        clientId: CLIENT,
        mode: 'document',
        artifactKind: 'workspace_draft',
        strategyId: STRATEGY,
        nodeId: NODE,
      });
      expect(result.kind).toBe('governed_packet');
      expect(h.gateway.requestContext).toHaveBeenCalledTimes(1);
    });

    test('draft mode without an anchor never runs an anchor query', async () => {
      const h = harness();
      h.gateway.requestContext.mockResolvedValue(
        gatewayResult({ type: 'strategy_draft', id: CLIENT }),
      );
      await h.service.resolve({
        tenantId: TENANT,
        clerkUserId: 'user_test',
        clientId: CLIENT,
        mode: 'draft',
      });
      expect(h.tx.$queryRaw).not.toHaveBeenCalled();
    });

    test('the wall/authorization path still rejects before the anchor query', async () => {
      const h = harness({ clientFound: false });
      await expect(
        h.service.resolve({
          tenantId: TENANT,
          clerkUserId: 'user_test',
          clientId: CLIENT,
          mode: 'assistant',
          strategyId: STRATEGY,
        }),
      ).rejects.toMatchObject({ status: 404 });
      // Client authorization is resolved first, so an unauthorized caller never
      // reaches the sp_* projection at all.
      expect(h.tx.$queryRaw).not.toHaveBeenCalled();
      expect(h.gateway.requestContext).not.toHaveBeenCalled();
    });
  });
});

describe('Objective history observation boundary', () => {
  test('rechecks current mailbox envelope and history through existing resolver without compiling another packet', async () => {
    const h = harness();
    const observed = { source: { clientId: CLIENT, objectiveId: NODE, objectiveVersion: 1, objectiveRevisionId: STRATEGY },
      intent: { outcome: 'saved goal' }, sourceDigest: 'a'.repeat(64), localDigest: 'b'.repeat(64), externalDigest: 'c'.repeat(64), issues: [] };
    const resolver = { resolveAndRetrieve: jest.fn(async () => context({ type: 'strategy_draft', id: CLIENT })) };
    const objective = { observe: jest.fn(async () => observed) };
    const service = new StrategyContextPlaneService(h.prisma as never,h.gateway as never,objective as never,resolver as never);
    const input: any = { tenantId: TENANT,clerkUserId:'user_test',clientId:CLIENT,mode:'draft',objective:{objectiveId:NODE,objectiveVersion:1},generationRequestId:STRATEGY,generationType:'appropriations' };
    const first = await service.checkObjective(input);
    h.tx.integrationConnection.findMany.mockResolvedValue([]);
    const revoked = await service.checkObjective(input);
    expect(revoked.historyDigest).not.toBe(first.historyDigest);
    resolver.resolveAndRetrieve.mockImplementation(async () => {
      const value = context({type:'strategy_draft',id:CLIENT}); value.retrieval!.records[0]!.payload.title = 'Changed plan title'; return value;
    });
    const changed = await service.checkObjective(input);
    expect(changed.historyDigest).not.toBe(revoked.historyDigest);
    expect(h.gateway.requestContext).not.toHaveBeenCalled();
    expect(first).toHaveProperty('checkedAt');
  });
  test('Objective dispatch refuses per-record provenance overflow instead of claiming lossless coverage', async () => {
    const h = harness();
    const result = gatewayResult({ type:'strategy_draft',id:CLIENT });
    result.context.retrieval!.records[0]!.provenance = { source:'fixture', detail:'x'.repeat(501) } as any;
    h.gateway.requestContext.mockResolvedValue(result);
    const service = new StrategyContextPlaneService(h.prisma as never,h.gateway as never,{ observe:async()=>({intent:{outcome:'saved'}}) } as never);
    await expect(service.resolve({tenantId:TENANT,clerkUserId:'user_test',clientId:CLIENT,mode:'draft',objective:{objectiveId:NODE,objectiveVersion:1}}))
      .rejects.toMatchObject({ response: {code:'OBJECTIVE_CONTEXT_INCOMPLETE'} });
  });
});
