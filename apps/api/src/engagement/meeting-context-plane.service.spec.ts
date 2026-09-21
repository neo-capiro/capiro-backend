import {
  MEETING_CLIENT_CONTEXT_DOMAINS,
  MeetingContextPlaneService,
} from './meeting-context-plane.service.js';
import { withMeetingPrepExecution } from './meeting-prep-job-runtime.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const MEETING = '44444444-4444-4444-8444-444444444444';
const MAILBOX = '55555555-5555-4555-8555-555555555555';
const PACKET = '66666666-6666-4666-8666-666666666666';

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
    traceHash: 'phase24-trace',
    clientId: CLIENT,
    rendered: [
      {
        layer: 'firm-identity',
        id: 'firm-1',
        type: 'firm-soul',
        title: 'Firm Soul',
        body: 'Use disciplined, candid government-affairs analysis.',
      },
      {
        layer: 'client-steering',
        id: 'client-1',
        type: 'client-compass',
        title: 'Client Compass',
        body: 'Protect the verified client objective and surface uncertainty.',
      },
    ],
    retrievalCompleteness: 'complete',
    retrievalStopReason: 'complete',
    ...overrides,
  };
}

function context(overrides: Record<string, unknown> = {}) {
  const domains = [...MEETING_CLIENT_CONTEXT_DOMAINS];
  return {
    resolution: {
      status: 'ready',
      stopReason: 'context_resolved_for_retrieval',
      subjectScope: { kind: 'client', source: 'explicit', clientIds: [CLIENT] },
      uiContext: { clientId: CLIENT, currentObject: { type: 'meeting', id: MEETING } },
      focusEntityRefs: [],
      canonicalEntityIds: [],
      retrievalAllowed: true,
      trace: {},
      securityScope: {},
    },
    retrieval: {
      records: [
        {
          domain: 'mail',
          recordId: 'mail-1',
          payload: {
            clientId: CLIENT,
            subject: 'Prior follow-up',
            snippet: 'The office asked for a concise implementation timeline.',
            body: 'PRIVATE FULL MAIL BODY MUST NOT PROPAGATE',
          },
        },
        {
          domain: 'meetings',
          recordId: 'meeting-old',
          payload: { clientId: CLIENT, subject: 'Prior client meeting', status: 'completed' },
        },
        {
          domain: 'institutional_knowledge',
          recordId: 'memory-1',
          payload: {
            title: 'user:neo:capiro_demo_structure',
            key: 'capiro_demo_structure',
            value: 'Standard Capiro demo covers meeting intelligence and budget tracking.',
            scope: 'user_private',
          },
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

function harness(
  options: {
    authorized?: boolean;
    storedClientId?: string | null;
    derivedClientId?: string | null;
    isInternal?: boolean;
    manuallyCleared?: boolean;
    packetOverrides?: Record<string, unknown>;
    contextOverrides?: Record<string, unknown>;
  } = {},
) {
  const storedClientId = options.storedClientId === undefined ? CLIENT : options.storedClientId;
  const isInternal = options.isInternal === true;
  const derivedClientId = options.derivedClientId === undefined ? null : options.derivedClientId;
  const effectiveClientId =
    isInternal || options.manuallyCleared ? null : (storedClientId ?? derivedClientId);
  const tx = {
    meeting: {
      findFirst: jest.fn().mockResolvedValue({
        id: MEETING,
        clientId: storedClientId,
        isInternal,
        associationSignals: options.manuallyCleared ? { manual: true } : {},
        subject: 'FY27 client strategy session',
        description: 'Discuss implementation sequencing.',
        startsAt: new Date('2026-08-21T14:00:00.000Z'),
        endsAt: new Date('2026-08-21T15:00:00.000Z'),
        organizerEmail: 'neo@capiro.ai',
        organizerName: 'Neo Martinez',
        attendees: [
          { name: 'Jamie Contact', email: 'jamie@example.com' },
          { name: 'Neo Martinez', email: 'neo@capiro.ai' },
        ],
      }),
    },
    tenantMembership: {
      findFirst: jest.fn().mockResolvedValue({ user: { email: 'neo@capiro.ai' } }),
    },
    client: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          options.authorized === false || !effectiveClientId ? [] : [{ id: effectiveClientId }],
        ),
      findFirst: jest.fn().mockResolvedValue(effectiveClientId ? { name: 'Acme Corp' } : null),
    },
    integrationConnection: {
      findMany: jest.fn().mockResolvedValue([{ id: MAILBOX }]),
    },
  };
  const prisma = {
    withTenantUser: jest.fn(
      async (_tenantId: string, _userId: string, callback: (value: typeof tx) => unknown) =>
        callback(tx),
    ),
  };
  const gateway = {
    requestContext: jest.fn().mockResolvedValue({
      kind: 'governed_packet',
      packet: packet({
        clientId: effectiveClientId,
        ...(options.packetOverrides ?? {}),
      }),
      context: context(options.contextOverrides),
    }),
  };
  const associations = {
    associate: jest.fn().mockResolvedValue({
      clientId: derivedClientId,
      score: derivedClientId ? 0.95 : 0,
      reason: derivedClientId ? 'known profile contact' : 'no match',
      signals: {},
    }),
  };
  return {
    service: new MeetingContextPlaneService(
      prisma as never,
      gateway as never,
      associations as never,
    ),
    gateway,
    associations,
  };
}

const ctx = { tenantId: TENANT, userId: USER } as never;

describe('MeetingContextPlaneService Phase 24', () => {
  test('passes an explicit board into durable prep without filtering native client history', async () => {
    const h = harness();
    await withMeetingPrepExecution(
      {
        jobId: 'job',
        depth: 'standard',
        deadlineAt: Date.now() + 60 * 60_000,
        signal: new AbortController().signal,
        checkpoint: jest.fn(),
        loadCheckpoint: () => undefined,
        commit: jest.fn(),
      },
      () =>
        h.service.resolve(ctx, {
          meetingId: MEETING,
          mode: 'prep',
          userInstruction: 'Use monday board 18431248553',
        }),
    );
    expect(h.gateway.requestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        resolverRequest: expect.objectContaining({
          clientId: CLIENT,
          actorUserId: USER,
          tenantId: TENANT,
          retrieval: expect.objectContaining({
            query: null,
            mondayBoardContext: 'Use monday board 18431248553',
            requestedDomains: expect.arrayContaining(['monday', 'mail', 'meetings', 'tasks']),
          }),
        }),
      }),
    );
  });

  test('prep crosses the shared gateway with server-owned scope, a client-side background lookup and record-only evidence', async () => {
    const h = harness();
    const result = await h.service.resolve(ctx, {
      meetingId: MEETING,
      mode: 'prep',
      userInstruction: 'Focus on the unresolved implementation question.',
    });

    expect(result.packetId).toBe(PACKET);
    expect(result.coverage.complete).toBe(true);
    expect(result.modelContextBlock).toContain('MODE: prep');
    expect(result.modelContextBlock).toContain('Prior follow-up');
    expect(result.modelContextBlock).toContain(
      'The office asked for a concise implementation timeline.',
    );
    expect(result.modelContextBlock).not.toContain('PRIVATE FULL MAIL BODY MUST NOT PROPAGATE');
    // Steering and harvested memory frame the prompt but are never citable.
    expect(result.modelContextBlock).toContain('Protect the verified client objective');
    expect(result.modelContextBlock).toContain('Standard Capiro demo covers');
    expect(result.evidenceSources?.map((source) => source.id)).toEqual([
      'mail:mail-1',
      'meetings:meeting-old',
    ]);
    expect(JSON.stringify(result.evidenceSources)).not.toContain(
      'PRIVATE FULL MAIL BODY MUST NOT PROPAGATE',
    );
    expect(h.associations.associate).not.toHaveBeenCalled();
    expect(h.gateway.requestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'meetings.prep-debrief',
        currentPhase: 24,
        requestId: MEETING,
        resolverRequest: expect.objectContaining({
          tenantId: TENANT,
          actorUserId: USER,
          surface: 'engagement',
          subjectScope: 'client',
          clientId: CLIENT,
          currentObject: { type: 'meeting', id: MEETING },
          securityScope: expect.objectContaining({
            authorizedClientIds: [CLIENT],
            authorizedMailboxConnectionIds: [MAILBOX],
            allowExternalLookup: false,
          }),
          retrieval: expect.objectContaining({
            queryClass: 'lookup',
            requestedDomains: ['institutional_knowledge'],
            // The subject and the firm's own attendee would only pull memory
            // about the firm; the client side drives the lookup.
            query: 'Acme Corp Jamie Contact jamie@example.com',
          }),
        }),
        contextRequest: expect.objectContaining({
          tenantId: TENANT,
          actorUserId: USER,
          surface: 'memo',
          clientId: CLIENT,
          layers: [
            'firm-identity',
            'firm-playbook',
            'user-voice',
            'client-steering',
            'client-people',
          ],
          persistence: 'required',
          contractVersion: 2,
          ref: expect.objectContaining({ canonicalClientId: CLIENT }),
        }),
      }),
    );
  });

  test('a server-derived effective client becomes the resolver and packet subject', async () => {
    const h = harness({ storedClientId: null, derivedClientId: CLIENT });
    await h.service.resolve(ctx, { meetingId: MEETING, mode: 'prep' });

    expect(h.associations.associate).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      expect.objectContaining({
        subject: 'FY27 client strategy session',
        attendeeEmails: ['jamie@example.com', 'neo@capiro.ai'],
      }),
    );
    expect(h.gateway.requestContext).toHaveBeenCalledWith(
      expect.objectContaining({
        resolverRequest: expect.objectContaining({
          subjectScope: 'client',
          clientId: CLIENT,
        }),
        contextRequest: expect.objectContaining({ clientId: CLIENT }),
      }),
    );
  });

  test('debrief context is explicitly non-evidentiary for attendance, decisions, commitments and tasks', async () => {
    const h = harness();
    const result = await h.service.resolve(ctx, {
      meetingId: MEETING,
      mode: 'debrief',
      sourceMethod: 'upload',
    });

    expect(result.modelContextBlock).toContain('MODE: debrief');
    expect(result.modelContextBlock).toContain(
      'only source.text, visibleNotes, and confirmed current-meeting metadata may establish what happened',
    );
    expect(result.modelContextBlock).toContain(
      'does not authorize sending email, creating commitments/tasks, or mutating CRM records',
    );
  });

  test('walled or unauthorized effective client fails before resolver/retrieval', async () => {
    const h = harness({ authorized: false });
    await expect(
      h.service.resolve(ctx, { meetingId: MEETING, mode: 'prep' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(h.gateway.requestContext).not.toHaveBeenCalled();
  });

  test('partial or zero-result retrieval remains explicitly incomplete', async () => {
    const domains = [...MEETING_CLIENT_CONTEXT_DOMAINS];
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
            sources: [
              source('clients', {
                sourceStatus: 'degraded',
                coverageComplete: false,
                paginationComplete: false,
              }),
            ],
            complete: false,
            stopReason: 'source_partial',
          },
          observability: {},
        },
      },
    });

    const result = await h.service.resolve(ctx, { meetingId: MEETING, mode: 'prep' });
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.recordsReturned).toBe(0);
    expect(result.coverage.stopReason).toBe('source_partial');
    expect(result.modelContextBlock).toContain('complete=false');
  });

  test.each(['internal', 'manually cleared'])(
    'an explicitly %s meeting uses general scope and does not expose client layers or mailbox history',
    async (mode) => {
      const h = harness({
        storedClientId: null,
        isInternal: mode === 'internal',
        manuallyCleared: mode === 'manually cleared',
        derivedClientId: CLIENT,
      });
      h.gateway.requestContext.mockResolvedValue({
        kind: 'governed_packet',
        packet: packet({ clientId: null }),
        context: {
          resolution: {
            ...context().resolution,
            subjectScope: { kind: 'general', source: 'explicit', clientIds: [] },
            uiContext: { currentObject: { type: 'meeting', id: MEETING } },
          },
          retrieval: {
            records: [],
            coverage: {
              requestedDomains: ['institutional_knowledge'],
              searchedDomains: ['institutional_knowledge'],
              requestedEntityCount: 0,
              searchedEntityCount: 0,
              recordsEvaluated: 0,
              recordsReturned: 0,
              paginationComplete: true,
              unavailableSources: [],
              sources: [source('institutional_knowledge', { total: 0, returned: 0 })],
              complete: true,
              stopReason: 'complete',
            },
            observability: {},
          },
        },
      });

      await h.service.resolve(ctx, { meetingId: MEETING, mode: 'prep' });
      expect(h.associations.associate).not.toHaveBeenCalled();
      const call = h.gateway.requestContext.mock.calls[0]![0] as {
        resolverRequest: { subjectScope: string; retrieval: { requestedDomains: string[] } };
        contextRequest: { clientId?: string; layers: string[] };
      };
      expect(call.resolverRequest.subjectScope).toBe('general');
      expect(call.resolverRequest.retrieval.requestedDomains).toEqual(['institutional_knowledge']);
      expect(call.contextRequest).not.toHaveProperty('clientId');
      expect(call.contextRequest.layers).not.toContain('client-steering');
      expect(call.contextRequest.layers).not.toContain('client-people');
    },
  );
});
