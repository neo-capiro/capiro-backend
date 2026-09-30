import {
  CRM_FILL_CONTEXT_DOMAINS,
  ClientProfileFillContextPlaneService,
  projectClientProfileContactCandidates,
} from './client-profile-fill-context-plane.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const OTHER_CLIENT = '44444444-4444-4444-8444-444444444444';
const MAILBOX = '55555555-5555-4555-8555-555555555555';
const PACKET = '66666666-6666-4666-8666-666666666666';

const canonicalClient = {
  id: CLIENT,
  name: 'Acme Corp',
  website: 'https://acme.example',
  description: 'Existing authoritative description',
  productDescription: null,
  primaryContactName: 'Alex Client',
  primaryContactEmail: 'alex@acme.example',
  primaryContactPhone: null,
  uei: null,
  cageCode: null,
  naicsCodes: [],
  pscCodes: [],
  updatedAt: new Date('2026-08-20T00:00:00.000Z'),
};

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
    tenantId: TENANT,
    clientId: CLIENT,
    traceHash: 'phase23-trace',
    rendered: [
      { type: 'firm-soul', title: 'Firm Soul', body: 'Use disciplined CRM curation.' },
      { type: 'client-compass', title: 'Client Compass', body: 'Protect the approved client position.' },
    ],
    exclusions: [],
    retrievalCompleteness: 'complete',
    retrievalStopReason: 'complete',
    ...overrides,
  };
}

function resolution(overrides: Record<string, unknown> = {}) {
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
    uiContext: { clientId: CLIENT, currentObject: { type: 'client', id: CLIENT } },
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
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  const domains = [...CRM_FILL_CONTEXT_DOMAINS];
  return {
    resolution: resolution(),
    retrieval: {
      records: [
        {
          domain: 'contacts',
          recordId: 'contact-1',
          payload: {
            id: 'contact-1',
            clientId: CLIENT,
            fullName: 'Jamie Contact',
            email: 'jamie@acme.example',
            phone: '202-555-0100',
            title: 'VP Government Affairs',
            organization: 'Acme Corp',
            source: 'mail_sync',
          },
          provenance: { source: 'engagement_contacts', recordId: 'contact-1' },
        },
        {
          domain: 'mail',
          recordId: 'mail-1',
          payload: { subject: 'Private thread', bodyText: 'SECRET MAIL BODY MUST NOT ENTER MODEL PREFLIGHT' },
          provenance: { source: 'mail_messages', recordId: 'mail-1' },
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

function harness(opts: {
  authorized?: boolean;
  packetOverrides?: Record<string, unknown>;
  contextOverrides?: Record<string, unknown>;
} = {}) {
  const tx = {
    client: {
      findFirst: jest.fn().mockResolvedValue(opts.authorized === false ? null : canonicalClient),
      findMany: jest.fn().mockResolvedValue(opts.authorized === false ? [] : [{ id: CLIENT }]),
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
    service: new ClientProfileFillContextPlaneService(prisma as never, gateway as never),
    gateway,
    tx,
  };
}

describe('ClientProfileFillContextPlaneService Phase 23', () => {
  test('resolves the exact canonical CRM client through the shared Context Plane', async () => {
    const h = harness();
    const result = await h.service.resolve(
      { tenantId: TENANT, userId: USER } as never,
      { clientId: CLIENT, requestedSources: ['public_web', 'synced_email'] },
    );

    expect(result.packetId).toBe(PACKET);
    expect(result.canonicalClient.id).toBe(CLIENT);
    expect(result.coverage.complete).toBe(true);
    expect(result.modelContextBlock).toContain('CANONICAL CRM IDENTITY');
    expect(result.modelContextBlock).toContain('not external evidence');
    expect(result.modelContextBlock).not.toContain('SECRET MAIL BODY');

    expect(h.gateway.requestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'crm.fill-with-meri',
        currentPhase: 23,
        resolverRequest: expect.objectContaining({
          tenantId: TENANT,
          actorUserId: USER,
          surface: 'client-profile',
          subjectScope: 'client',
          clientId: CLIENT,
          currentObject: { type: 'client', id: CLIENT },
          securityScope: expect.objectContaining({
            authorizedClientIds: [CLIENT],
            authorizedMailboxConnectionIds: [MAILBOX],
            allowExternalLookup: false,
          }),
          retrieval: expect.objectContaining({
            queryClass: 'lookup',
            requestedDomains: [...CRM_FILL_CONTEXT_DOMAINS],
          }),
        }),
        contextRequest: expect.objectContaining({
          tenantId: TENANT,
          actorUserId: USER,
          clientId: CLIENT,
          surface: 'research',
          persistence: 'required',
          contractVersion: 2,
          layers: [
            'firm-identity',
            'firm-playbook',
            'user-voice',
            'client-steering',
            'client-people',
          ],
        }),
      }),
    );
  });

  test('the wall decision is read off the actor-keyed wall filter, never asserted', async () => {
    const h = harness();
    await h.service.resolve({ tenantId: TENANT, userId: USER } as never, { clientId: CLIENT });

    // Both the canonical-client read and the retrieval scope carry the wall
    // predicate for THIS actor; the packet's ethical-wall flag is derived from them.
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
        contextRequest: expect.objectContaining({ ethicalWallAllowed: true }),
      }),
    );
  });

  test('walled, archived, cross-tenant, or otherwise unauthorized client fails before retrieval', async () => {
    const h = harness({ authorized: false });
    await expect(
      h.service.resolve(
        { tenantId: TENANT, userId: USER } as never,
        { clientId: CLIENT },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.gateway.requestContext).not.toHaveBeenCalled();
  });

  test('resolver or packet client drift fails closed', async () => {
    const h = harness({
      packetOverrides: { clientId: OTHER_CLIENT },
      contextOverrides: {
        resolution: resolution({
          subjectScope: { kind: 'client', source: 'explicit', clientIds: [OTHER_CLIENT] },
        }),
      },
    });
    await expect(
      h.service.resolve(
        { tenantId: TENANT, userId: USER } as never,
        { clientId: CLIENT },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  test('partial or zero-result retrieval never becomes false complete coverage', async () => {
    const domains = [...CRM_FILL_CONTEXT_DOMAINS];
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
    const result = await h.service.resolve(
      { tenantId: TENANT, userId: USER } as never,
      { clientId: CLIENT },
    );
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.recordsReturned).toBe(0);
    expect(result.coverage.missingDomains.length).toBeGreaterThan(0);
    expect(result.modelContextBlock).toContain('complete=false');
  });

  test('synced-contact projection accepts only records explicitly scoped to the canonical client', async () => {
    const h = harness();
    const bundle = await h.service.resolve(
      { tenantId: TENANT, userId: USER } as never,
      { clientId: CLIENT },
    );
    bundle.records.push({
      domain: 'contacts',
      recordId: 'wrong-client-contact',
      payload: { clientId: OTHER_CLIENT, fullName: 'Wrong Client Person' },
    } as never);

    expect(projectClientProfileContactCandidates(bundle)).toEqual([
      expect.objectContaining({
        recordId: 'contact-1',
        name: 'Jamie Contact',
        email: 'jamie@acme.example',
      }),
    ]);
  });
});
