import { WorkspaceContextPlaneService } from './workspace-context-plane.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const MAILBOX = '44444444-4444-4444-8444-444444444444';

function packet(overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    packetId: '55555555-5555-4555-8555-555555555555',
    persistedPacketId: '55555555-5555-4555-8555-555555555555',
    persisted: true,
    surface: 'workspace-gen',
    clientId: CLIENT,
    items: [],
    exclusions: [],
    rendered: [{ type: 'client-compass', body: 'Protect the verified client objective.' }],
    traceHash: 'phase21-trace',
    retrievalCompleteness: 'complete',
    retrievalStopReason: 'complete',
    health: { status: 'healthy', reasons: [] },
    incomplete: false,
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  const domains = [
    'clients',
    'contacts',
    'strategies_work',
    'institutional_knowledge',
    'meetings',
    'mail',
    'outreach',
  ];
  return {
    resolution: {
      subjectScope: { kind: 'client' },
      stopReason: 'ready',
    },
    retrieval: {
      records: [
        {
          domain: 'clients',
          recordId: CLIENT,
          payload: { name: 'Client One', objective: 'Protect the program.' },
        },
      ],
      coverage: {
        requestedDomains: domains,
        searchedDomains: domains,
        requestedEntityCount: 1,
        searchedEntityCount: 1,
        recordsEvaluated: 1,
        recordsReturned: 1,
        paginationComplete: true,
        unavailableSources: [],
        sources: domains.map((domain) => ({
          domain,
          sourceStatus: 'healthy',
          stopReason: 'complete',
          coverageComplete: true,
          paginationComplete: true,
          truncated: false,
        })),
        complete: true,
        stopReason: 'complete',
      },
    },
    ...overrides,
  };
}

function harness(opts: { authorizedClient?: boolean; packetOverrides?: Record<string, unknown>; contextOverrides?: Record<string, unknown> } = {}) {
  const authorizedClient = opts.authorizedClient !== false;
  const tx = {
    client: {
      findMany: jest.fn().mockResolvedValue(authorizedClient ? [{ id: CLIENT }] : []),
    },
    integrationConnection: {
      findMany: jest.fn().mockResolvedValue([{ id: MAILBOX }]),
    },
  };
  const prisma = {
    withTenantUser: jest.fn(async (_tenant: string, _user: string, fn: (value: typeof tx) => unknown) => fn(tx)),
  };
  const gateway = {
    requestContext: jest.fn().mockResolvedValue({
      kind: 'governed_packet',
      packet: packet(opts.packetOverrides),
      context: context(opts.contextOverrides),
    }),
  };
  return {
    service: new WorkspaceContextPlaneService(prisma as never, gateway as never),
    gateway,
  };
}

describe('WorkspaceContextPlaneService Phase 21', () => {
  test('workspace.generate crosses resolver -> Retrieval V2 -> ContextPacket V2 with a server-owned envelope', async () => {
    const h = harness();
    const result = await h.service.resolveForActor(
      { tenantId: TENANT, userId: USER },
      {
        operationId: 'workspace.generate',
        surface: 'workspace-gen',
        task: 'Draft the client white paper.',
        clientId: CLIENT,
        documentId: '66666666-6666-4666-8666-666666666666',
      },
    );

    expect(result.kind).toBe('governed_packet');
    expect(result.governedContext.operationId).toBe('workspace.generate');
    expect(result.governedContext.prompt).toContain('RETRIEVED CONTEXT:');
    expect(result.governedContext.prompt).toContain('Client One');
    expect(result.governedContext.prompt).toContain('Protect the program.');
    expect(result.supplementalEvidence).toContain('Client One');
    expect(result.supplementalEvidence).toContain('"objective":"Protect the program."');
    expect(h.gateway.requestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'workspace.generate',
        currentPhase: 21,
        resolverRequest: expect.objectContaining({
          tenantId: TENANT,
          actorUserId: USER,
          surface: 'workspace-gen',
          clientId: CLIENT,
          securityScope: expect.objectContaining({
            authorizedClientIds: [CLIENT],
            authorizedMailboxConnectionIds: [MAILBOX],
          }),
        }),
        contextRequest: expect.objectContaining({
          tenantId: TENANT,
          actorUserId: USER,
          surface: 'workspace-gen',
          clientId: CLIENT,
          persistence: 'required',
          contractVersion: 2,
        }),
      }),
    );
  });

  test('an unauthorized client never becomes resolver subject or packet client scope', async () => {
    const h = harness({ authorizedClient: false });
    await h.service.resolveForActor(
      { tenantId: TENANT, userId: USER },
      {
        operationId: 'workspace.editor-assist',
        surface: 'workspace-editor',
        task: 'Tighten this paragraph.',
        clientId: CLIENT,
      },
    );

    const call = h.gateway.requestContext.mock.calls[0]![0] as {
      resolverRequest: Record<string, unknown> & { retrieval: { requestedDomains: string[] } };
      contextRequest: Record<string, unknown>;
    };
    expect(call.resolverRequest).not.toHaveProperty('clientId');
    expect(call.resolverRequest.retrieval.requestedDomains).toEqual(['institutional_knowledge']);
    expect(call.contextRequest).not.toHaveProperty('clientId');
    expect(call.contextRequest).toEqual(expect.objectContaining({ ethicalWallAllowed: false }));
  });

  test('partial retrieval remains explicit and never becomes false complete coverage', async () => {
    const domains = ['clients', 'institutional_knowledge'];
    const h = harness({
      packetOverrides: {
        retrievalCompleteness: 'incomplete',
        retrievalStopReason: 'source_partial',
        incomplete: true,
      },
      contextOverrides: {
        retrieval: {
          records: [],
          coverage: {
            requestedDomains: domains,
            searchedDomains: ['clients'],
            requestedEntityCount: 1,
            searchedEntityCount: 1,
            recordsEvaluated: 0,
            recordsReturned: 0,
            paginationComplete: false,
            unavailableSources: ['institutional_knowledge'],
            sources: [
              {
                domain: 'clients',
                sourceStatus: 'degraded',
                stopReason: 'partial',
                coverageComplete: false,
                paginationComplete: false,
                truncated: true,
              },
            ],
            complete: false,
            stopReason: 'source_partial',
          },
        },
      },
    });

    const result = await h.service.resolveForActor(
      { tenantId: TENANT, userId: USER },
      {
        operationId: 'workspace.generate',
        surface: 'workspace-gen',
        task: 'Draft the client memo.',
        clientId: CLIENT,
      },
    );

    expect(result.governedContext.retrieval.coverage.complete).toBe(false);
    expect(result.governedContext.retrieval.coverage.stopReason).toBe('source_partial');
    expect(result.governedContext.prompt).toContain('complete=false');
  });
});
