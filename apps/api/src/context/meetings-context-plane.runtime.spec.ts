import { MeetingsContextPlaneRuntime } from './meetings-context-plane.runtime.js';
import { EngagementAiService as EngagementAiProvider } from '../engagement/engagement-ai.service.js';
import { createGovernedMeetingAiService } from '../engagement/governed-meeting-ai.factory.js';
import { createGovernedEngagementService } from '../engagement/governed-engagement.factory.js';
import { guardEngagementAiService } from '../engagement/runtime/engagement-ai-runtime.boundary.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';
import { currentMeetingGovernedContext, type MeetingGovernedContext } from '../engagement/meeting-context-runtime.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const MEETING = '44444444-4444-4444-8444-444444444444';
const MAILBOX = '55555555-5555-4555-8555-555555555555';

const ctx = { tenantId: TENANT, userId: USER } as never;
const meeting = {
  id: MEETING,
  meetingId: MEETING,
  clientId: CLIENT,
  title: 'Acme legislative strategy review',
  attendees: [{ name: 'Jamie Contact' }],
  transcript: 'Jamie said the team will send the revised language Friday.',
};

class EngagementAiService {
  async generateMeetingPrep(value: unknown) {
    await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        instructions: 'Prepare the meeting brief.',
        input: `CALENDAR INPUT:\n${JSON.stringify(value)}`,
      }),
    });
    return { summary: 'prep' };
  }

  async generateMeetingDebrief(value: unknown) {
    await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        max_tokens: 800,
        system: 'Debrief only from supplied notes.',
        messages: [{ role: 'user', content: `CURRENT TRANSCRIPT:\n${JSON.stringify(value)}` }],
      }),
    });
    return { recap: 'debrief' };
  }
}

class MeetingCaller {
  constructor(private readonly ai: EngagementAiService) {}

  runPrep(value: unknown, canonicalMeeting: unknown) {
    return this.ai.generateMeetingPrep(canonicalMeeting);
  }

  runDebrief(value: unknown, canonicalMeeting: unknown) {
    return this.ai.generateMeetingDebrief(canonicalMeeting);
  }
}

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

const domains = [
  'clients',
  'contacts',
  'meetings',
  'tasks',
  'outreach',
  'institutional_knowledge',
  'mail',
];

function gatewayResult(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'governed_packet',
    packet: {
      version: 2,
      packetId: '66666666-6666-4666-8666-666666666666',
      persistedPacketId: '66666666-6666-4666-8666-666666666666',
      persisted: true,
      clientId: CLIENT,
      traceHash: 'phase24-trace',
      rendered: [
        {
          type: 'client-compass',
          title: 'Client Compass',
          body: 'Protect the client objective and distinguish proposals from commitments.',
        },
      ],
      retrievalCompleteness: 'complete',
      retrievalStopReason: 'complete',
    },
    context: {
      resolution: {
        status: 'ready',
        stopReason: 'context_resolved_for_retrieval',
        subjectScope: { kind: 'client', source: 'explicit', clientIds: [CLIENT] },
      },
      retrieval: {
        records: [
          {
            domain: 'tasks',
            recordId: 'old-task-1',
            payload: {
              title: 'Prior follow-up',
              status: 'open',
              description: 'An old task, not a current meeting commitment.',
            },
            provenance: { source: 'tenant_tasks' },
          },
        ],
        coverage: {
          requestedDomains: domains,
          searchedDomains: domains,
          requestedEntityCount: domains.length,
          searchedEntityCount: domains.length,
          recordsEvaluated: 1,
          recordsReturned: 1,
          paginationComplete: true,
          unavailableSources: [],
          sources: domains.map((domain) => source(domain)),
          complete: true,
          stopReason: 'complete',
        },
      },
    },
    ...overrides,
  };
}

function harness(
  options: {
    authorized?: boolean;
    gatewayResult?: Record<string, unknown>;
    proxyAliases?: boolean;
    omitAiOwner?: boolean;
  } = {},
) {
  const rawAi = new EngagementAiService();
  const bind = (target: EngagementAiService) => new Proxy(target, {
    get(value, property, receiver) {
      const member = Reflect.get(value, property, receiver);
      return typeof member === 'function' ? member.bind(value) : member;
    },
  });
  const guardedAi = options.proxyAliases ? bind(rawAi) : rawAi;
  const ai = options.proxyAliases ? bind(guardedAi) : guardedAi;
  const caller = new MeetingCaller(ai);
  const providers = new Map<unknown, { instance: unknown }>([
    [options.omitAiOwner ? 'unregistered-ai' : EngagementAiProvider, { instance: ai }],
    ['raw-ai-alias', { instance: guardedAi }],
    ['caller', { instance: caller }],
  ]);
  const moduleRef = {
    get: jest.fn((token: unknown, scope: unknown) => {
      expect(token).toBe(EngagementAiProvider);
      expect(scope).toEqual({ strict: false });
      return ai;
    }),
    container: {
      getModules: () =>
        new Map([
          [
            'test',
            {
              providers,
              controllers: new Map(),
            },
          ],
        ]),
    },
  };
  const tx = {
    client: {
      findFirst: jest
        .fn()
        .mockResolvedValue(options.authorized === false ? null : { id: CLIENT, name: 'Acme Corp' }),
      findMany: jest.fn().mockResolvedValue(options.authorized === false ? [] : [{ id: CLIENT }]),
    },
    integrationConnection: {
      findMany: jest.fn().mockResolvedValue([{ id: MAILBOX }]),
    },
  };
  const prisma = {
    withTenantUser: jest.fn(
      async (_tenantId: string, _userId: string, fn: (value: typeof tx) => unknown) => fn(tx),
    ),
  };
  const gateway = {
    requestContext: jest.fn().mockResolvedValue(options.gatewayResult ?? gatewayResult()),
  };
  const runtime = new MeetingsContextPlaneRuntime(
    gateway as never,
    prisma as never,
    moduleRef as never,
  );
  return { runtime, ai, rawAi, caller, gateway, prisma, moduleRef };
}

describe('MeetingsContextPlaneRuntime Phase 24', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('uses the canonical token across governed proxy aliases and restores the shared methods', async () => {
    const h = harness({ proxyAliases: true });
    expect(h.ai.constructor.name).not.toBe('EngagementAiService');
    expect(h.runtime.install()).toEqual({ callersPatched: 2, aiMethodsPatched: 2 });
    expect(h.moduleRef.get).toHaveBeenCalledTimes(1);
    expect(Object.hasOwn(h.rawAi, 'generateMeetingPrep')).toBe(true);
    await h.caller.runPrep(ctx, meeting);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    h.runtime.restoreForTest();
    expect(Object.hasOwn(h.rawAi, 'generateMeetingPrep')).toBe(false);
    expect(Object.hasOwn(h.rawAi, 'generateMeetingDebrief')).toBe(false);
    expect(globalThis.fetch).toBe(fetchMock);
  });

  test('an unregistered lookalike AI does not install a compatibility runtime', () => {
    const h = harness({ omitAiOwner: true });
    expect(h.runtime.install()).toEqual({ callersPatched: 0, aiMethodsPatched: 0 });
    expect(h.moduleRef.get).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(fetchMock);
  });

  test('prep resolves one governed packet before provider work and injects server-owned scope', async () => {
    const h = harness();
    const installed = h.runtime.install();
    expect(installed).toEqual({ callersPatched: 2, aiMethodsPatched: 2 });

    await h.caller.runPrep(ctx, meeting);

    expect(h.gateway.requestContext).toHaveBeenCalledTimes(1);
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
            requestedDomains: domains,
          }),
        }),
        contextRequest: expect.objectContaining({
          surface: 'memo',
          clientId: CLIENT,
          persistence: 'required',
          contractVersion: 2,
          ref: expect.objectContaining({
            operationId: 'meetings.prep-debrief',
            meetingId: MEETING,
            mode: 'prep',
          }),
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.input).toContain('<capiro_meetings_context_plane>');
    expect(body.input).toContain('PREP AUTHORITY');
    expect(body.input).toContain('An old task, not a current meeting commitment.');
    expect(body.input).toContain('CALENDAR INPUT');
    h.runtime.restoreForTest();
  });

  test('debrief keeps the current transcript as sole commitment/quote authority', async () => {
    const h = harness();
    h.runtime.install();

    await h.caller.runDebrief(ctx, meeting);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.system).toContain('Only the current transcript/notes can support quotes');
    expect(body.messages[0].content).toContain('<capiro_meetings_context_plane>');
    expect(body.messages[0].content).toContain('CURRENT TRANSCRIPT/NOTES AUTHORITY');
    expect(body.messages[0].content).toContain('Never convert an old task');
    expect(body.messages[0].content).toContain('CURRENT TRANSCRIPT');
    h.runtime.restoreForTest();
  });

  test('a direct AI call that bypasses a tenant-scoped live caller fails closed', async () => {
    const h = harness();
    h.runtime.install();
    await expect(h.ai.generateMeetingPrep(meeting)).rejects.toThrow(
      'phase24_meetings_governed_invocation_required:prep',
    );
    expect(h.gateway.requestContext).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    h.runtime.restoreForTest();
  });

  test('walled or unauthorized client fails before retrieval/provider work', async () => {
    const h = harness({ authorized: false });
    h.runtime.install();
    await expect(h.caller.runPrep(ctx, meeting)).rejects.toThrow(
      'phase24_meetings_client_not_authorized',
    );
    expect(h.gateway.requestContext).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    h.runtime.restoreForTest();
  });

  test('partial and zero-record retrieval remains explicitly incomplete', async () => {
    const partial = gatewayResult();
    (partial.packet as Record<string, unknown>).retrievalCompleteness = 'incomplete';
    (partial.packet as Record<string, unknown>).retrievalStopReason = 'source_partial';
    const retrieval = (partial.context as any).retrieval;
    retrieval.records = [];
    retrieval.coverage = {
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
    };
    const h = harness({ gatewayResult: partial });
    h.runtime.install();

    await h.caller.runPrep(ctx, meeting);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.input).toContain('complete=false');
    expect(body.input).toContain('stopReason=source_partial');
    expect(body.input).toContain('recordsReturned=0');
    h.runtime.restoreForTest();
  });
});

function canonicalBundle(mode: 'prep' | 'debrief', clientId: string | null = CLIENT, meetingId = MEETING): MeetingGovernedContext {
  return { kind: 'governed_packet', mode, meetingId, clientId, packetId: 'first-packet', traceHash: 'first-trace',
    modelContextBlock: `FIRST-CANONICAL-PACKET:${mode}:${meetingId}:${clientId ?? 'none'}`,
    coverage: { complete: false, requestedDomains: [], searchedDomains: [], missingDomains: [], partialDomains: [],
      recordsReturned: 0, paginationComplete: true, truncated: false, stopReason: 'synthetic_source_only' } };
}

function composition(options: { inferred?: boolean; policyDisabled?: boolean; clientId?: string | null;
  canonical?: { resolve: (actor: unknown, input: { meetingId: string; mode: 'prep' | 'debrief' }) => Promise<MeetingGovernedContext> } } = {}) {
  const clientId = options.clientId === undefined ? CLIENT : options.clientId;
  const row = { ...meeting, clientId: options.inferred ? null : clientId };
  const rawAi = new EngagementAiService();
  const policy = new EngagementRuntimePolicyService({ serviceName: 'api', processMode: 'active', backgroundOwner: 'api',
    externalActions: options.policyDisabled ? 'disabled' : 'enabled', callbacksEnabled: false, recallWebhookEnabled: false });
  const guardedAi = guardEngagementAiService(rawAi as never, policy);
  const publicAi = createGovernedMeetingAiService(guardedAi);
  const providerInput = (text?: string) => ({ meeting: row, client: clientId ? { id: clientId } : null, attendees: [],
    congressionalDirectoryMatches: [], recentMeetings: [], recentThreads: [], tasks: [],
    transcript: text ?? 'Current transcript evidence', notes: ['Current visible note'], clientContext: 'OLD-PRIVATE-HISTORY' });
  const rawCaller = {
    // Both original factory bindings are required even though this fixture never invokes Outreach.
    async generateOutreachDraft() { throw new Error('unused_outreach_fixture'); },
    async generateBatchEmails() { throw new Error('unused_batch_fixture'); },
    async generateMeetingPrep(actor: unknown, _meetingId: string) { return publicAi.generateMeetingPrep(providerInput() as never, actor as never); },
    async generateMeetingDebriefDraft(actor: unknown, _meetingId: string, input: { sourceText: string }) {
      return publicAi.generateMeetingDebrief(providerInput(input.sourceText) as never, actor as never);
    },
  };
  const canonical = options.canonical ?? { resolve: jest.fn(async (_actor: unknown, input: { meetingId: string; mode: 'prep' | 'debrief' }) => canonicalBundle(input.mode, clientId, input.meetingId)) };
  const publicCaller = createGovernedEngagementService(rawCaller as never, { guard: (fn: () => unknown) => fn() } as never,
    canonical as never, policy);
  const providers = new Map<unknown, { instance: unknown }>([
    [EngagementAiProvider, { instance: publicAi }], ['guarded-ai', { instance: guardedAi }],
    ['raw-ai', { instance: rawAi }], ['raw-caller', { instance: rawCaller }], ['public-caller', { instance: publicCaller }],
  ]);
  const moduleRef = { get: (token: unknown) => { expect(token).toBe(EngagementAiProvider); return publicAi; },
    container: { getModules: () => new Map([['actual-factory-composition', { providers, controllers: new Map() }]]) } };
  const tx = { client: { findFirst: jest.fn(async () => ({ id: CLIENT, name: 'Acme' })), findMany: jest.fn(async () => [{ id: CLIENT }]) },
    integrationConnection: { findMany: jest.fn(async () => []) } };
  const prisma = { withTenantUser: jest.fn(async (tenant: string, actor: string, fn: (value: typeof tx) => unknown) => {
    expect([tenant, actor]).toEqual([TENANT, USER]); return fn(tx);
  }) };
  const gateway = { requestContext: jest.fn(async (input: { contextRequest: { clientId?: string } }) => {
    const result = gatewayResult();
    (result.packet as any).clientId = input.contextRequest.clientId ?? null;
    (result.packet as any).rendered = [{ body: 'SECOND-COMPATIBILITY-PACKET' }];
    return result;
  }) };
  const runtime = new MeetingsContextPlaneRuntime(gateway as never, prisma as never, moduleRef as never);
  return { runtime, rawAi, guardedAi, publicAi, rawCaller, publicCaller, canonical, gateway, row, providerInput };
}

describe('Meetings runtime composed with actual governed factories and policy', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => { fetchMock = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) }); globalThis.fetch = fetchMock as unknown as typeof fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; jest.restoreAllMocks(); });

  test.each(['prep', 'debrief'] as const)('%s keeps the single canonical stored-client packet at the provider seam', async mode => {
    const h = composition(); const before = Object.getOwnPropertyDescriptors(h.rawAi); h.runtime.install();
    try {
      if (mode === 'prep') await h.publicCaller.generateMeetingPrep(ctx, MEETING);
      else await h.publicCaller.generateMeetingDebriefDraft(ctx, MEETING, { sourceText: 'Current transcript', method: 'manual' });
      expect(h.canonical.resolve).toHaveBeenCalledTimes(1);
      expect(h.gateway.requestContext).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.stringify(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)));
      expect(body).toContain(`FIRST-CANONICAL-PACKET:${mode}:${MEETING}:${CLIENT}`);
      expect(body).not.toContain('SECOND-COMPATIBILITY-PACKET');
      expect(body.match(/FIRST-CANONICAL-PACKET/g)).toHaveLength(1);
      expect(currentMeetingGovernedContext()).toBeNull();
    } finally { h.runtime.restoreForTest(); expect(globalThis.fetch).toBe(fetchMock); expect(Object.getOwnPropertyDescriptors(h.rawAi)).toEqual(before); }
  });

  test.each(['prep', 'debrief'] as const)('%s preserves canonical inferred client when the meeting row has no clientId', async mode => {
    const h = composition({ inferred: true }); h.runtime.install();
    try {
      if (mode === 'prep') await h.publicCaller.generateMeetingPrep(ctx, MEETING);
      else await h.publicCaller.generateMeetingDebriefDraft(ctx, MEETING, { sourceText: 'Current notes', method: 'manual' });
      expect(h.canonical.resolve).toHaveBeenCalledTimes(1); expect(h.gateway.requestContext).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.stringify(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)));
      expect(body).toContain(`FIRST-CANONICAL-PACKET:${mode}:${MEETING}:${CLIENT}`);
      expect(body).not.toContain('SECOND-COMPATIBILITY-PACKET');
      expect(currentMeetingGovernedContext()).toBeNull();
    } finally { h.runtime.restoreForTest(); }
  });
});
