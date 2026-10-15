import type { ConfigService } from '@nestjs/config';
import { StrategyContextPlaneClient, operationFor } from './strategy-context-plane.client.js';
import type { StrategyGovernedTurnContext } from './strategy-governed-context.types.js';
import { objectiveFixture } from './objective-generation.fixture.js';
import { digest } from './objective-generation.types.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';

function governed(
  operationId: StrategyGovernedTurnContext['operationId'] = 'strategies.generate',
): StrategyGovernedTurnContext {
  const surface =
    operationId === 'workspace.generate'
      ? 'workspace-gen'
      : operationId === 'outreach.generate'
        ? 'outreach'
        : 'strategy';
  return {
    version: 1,
    operationId,
    prompt: 'governed context',
    contextPacket: {
      packetId: 'packet-1',
      persisted: true,
      surface,
      clientId: CLIENT,
      items: [],
      exclusions: [],
      unauthorizedCount: 0,
      degraded: false,
    },
    retrieval: {
      plan: {
        version: 1,
        queryClass: 'lookup',
        subjectScope: 'client',
        targetHint: null,
        recipeTool: null,
        requireCompleteCoverage: false,
        requiredDomains: ['clients'],
        timeWindow: null,
      },
      coverage: {
        version: 1,
        complete: true,
        requestedDomains: ['clients'],
        searchedDomains: ['clients'],
        missingDomains: [],
        partialDomains: [],
        requestedEntityCount: 1,
        searchedEntityCount: 1,
        recordsEvaluated: 1,
        recordsReturned: 1,
        paginationComplete: true,
        truncated: false,
        sourceHealth: [],
        unavailableSources: [],
        toolsInvoked: [],
        stopReason: 'complete',
      },
    },
  };
}

function config(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('StrategyContextPlaneClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('posts the server-owned scope under the internal service secret', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'governed_packet', governedContext: governed() }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new StrategyContextPlaneClient(
      config({
        API_INTERNAL_URL: 'https://api.internal/',
        INTERNAL_SERVICE_SECRET: 'secret',
      }),
    );

    await expect(
      client.compile({
        tenantId: 'tenant-1',
        clerkUserId: 'user-1',
        clientId: CLIENT,
        mode: 'assistant',
        query: 'Move a step',
        strategyId: 'strategy-1',
        nodeId: 'node-1',
        traceId: 'trace-1',
      }),
    ).resolves.toEqual(governed());

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.internal/api/internal/strategy/context/compile',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-internal-service-secret': 'secret',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toMatchObject({
      tenantId: 'tenant-1',
      clerkUserId: 'user-1',
      clientId: CLIENT,
      mode: 'assistant',
      strategyId: 'strategy-1',
      nodeId: 'node-1',
      traceId: 'trace-1',
    });
  });

  test.each([
    ['workspace_draft', 'workspace.generate'],
    ['outreach_record', 'outreach.generate'],
  ] as const)('validates %s document context against %s', async (artifactKind, operationId) => {
    const expected = governed(operationId);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'governed_packet', governedContext: expected }),
    }) as unknown as typeof fetch;
    const client = new StrategyContextPlaneClient(
      config({ API_BASE_URL: 'https://api', INTERNAL_SERVICE_SECRET: 'secret' }),
    );
    await expect(
      client.compile({
        tenantId: 'tenant-1',
        clerkUserId: 'user-1',
        clientId: CLIENT,
        mode: 'document',
        artifactKind,
        nodeId: 'node-1',
      }),
    ).resolves.toEqual(expected);
  });

  test('fails before transport when the internal secret is absent', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new StrategyContextPlaneClient(config({ API_BASE_URL: 'https://api' }));
    await expect(
      client.compile({
        tenantId: 'tenant-1',
        clerkUserId: 'user-1',
        clientId: CLIENT,
        mode: 'draft',
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects packet operation, client, or surface drift', async () => {
    const invalid = governed('outreach.generate');
    invalid.contextPacket = { ...invalid.contextPacket, clientId: 'other-client' };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ kind: 'governed_packet', governedContext: invalid }),
    }) as unknown as typeof fetch;
    const client = new StrategyContextPlaneClient(
      config({ API_BASE_URL: 'https://api', INTERNAL_SERVICE_SECRET: 'secret' }),
    );
    await expect(
      client.compile({
        tenantId: 'tenant-1',
        clerkUserId: 'user-1',
        clientId: CLIENT,
        mode: 'draft',
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  test('maps Strategy execution documents to destination operations', () => {
    expect(operationFor('draft', null)).toBe('strategies.generate');
    expect(operationFor('assistant', null)).toBe('strategies.generate');
    expect(operationFor('document', 'workspace_draft')).toBe('workspace.generate');
    expect(operationFor('document', 'outreach_record')).toBe('outreach.generate');
    expect(() => operationFor('document', null)).toThrow(
      'Strategy document context requires an artifact kind',
    );
  });
});

describe('Objective Context Plane receiving validation', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });
  function fixture() {
    const f = objectiveFixture();
    const g = governed(); g.contextPacket.packetId = f.admission.context.packetId;
    g.contextPacket.clientId = f.request.clientId; g.contextPacket.compiledAt = f.admission.context.compiledAt;
    f.admission.context.coverageDigest = digest({ manifest: f.admission.coverage, history: g.retrieval.coverage, policy: 'objective-v1-required-lossless' });
    f.admission.context.inputDigest = digest({ sourceDigest: f.admission.context.sourceDigest, coverageDigest: f.admission.context.coverageDigest,
      packetId: f.admission.context.packetId, requestId: f.admission.requestId, type: f.admission.type,
      localDigest: f.admission.localDigest, externalDigest: f.admission.externalDigest, historyDigest: f.admission.historyDigest,
      promptDigest: digest(g.prompt) });
    const client = new StrategyContextPlaneClient(config({ API_BASE_URL: 'https://fixture.invalid', INTERNAL_SERVICE_SECRET: 'fixture-secret' }));
    const request: any = { tenantId: f.actor.tenantId, clerkUserId: f.actor.clerkUserId, clientId: f.request.clientId, mode: 'draft',
      objective: f.request.objective, generationRequestId: f.request.requestId, generationType: f.request.type };
    return { ...f, g, client, request };
  }
  test('validates exact actor/source/packet/digests before exposing governed context', async () => {
    const f = fixture(); const onAdmission = jest.fn(async () => undefined);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ kind: 'governed_packet', governedContext: f.g, objectiveAdmission: f.admission }) }) as any;
    await expect(f.client.compile(f.request,onAdmission)).resolves.toBe(f.g);
    expect(onAdmission).toHaveBeenCalledWith(f.admission);
  });
  test.each(['actor','source','coverage','input','packet','prompt','time'])('rejects mismatched %s', async which => {
    const f = fixture();
    if (which === 'actor') f.admission.clerkUserId = 'foreign';
    if (which === 'source') f.admission.source.objectiveVersion++;
    if (which === 'coverage') f.admission.coverage.push({ fabricated: true });
    if (which === 'input') f.admission.context.inputDigest = 'f'.repeat(64);
    if (which === 'packet') f.g.contextPacket.packetId = 'wrong-packet';
    if (which === 'prompt') f.g.prompt += ' substituted source text';
    if (which === 'time') f.admission.historyObservedAt = '';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ kind: 'governed_packet', governedContext: f.g, objectiveAdmission: f.admission }) }) as any;
    const consume = jest.fn(async () => undefined);
    await expect(f.client.compile(f.request,consume)).rejects.toMatchObject({ status: 503 });
    expect(consume).not.toHaveBeenCalled();
  });
  test.each(['history','mailbox-scope','local','external'])('rejects changed %s at final observation', async which => {
    const f = fixture(); const body: any = { tenantId: f.request.tenantId, clerkUserId: f.request.clerkUserId, requestId: f.admission.requestId,
      source: f.admission.source, sourceDigest: f.admission.context.sourceDigest, localDigest: f.admission.localDigest,
      externalDigest: f.admission.externalDigest, historyDigest: f.admission.historyDigest, complete: true, checkedAt: new Date().toISOString() };
    if (which === 'history' || which === 'mailbox-scope') body.historyDigest = 'f'.repeat(64);
    if (which === 'local') body.localDigest = 'f'.repeat(64);
    if (which === 'external') body.externalDigest = 'f'.repeat(64);
    global.fetch = jest.fn().mockResolvedValue({ ok:true,json:async()=>body }) as any;
    await expect(f.client.recheckObjective(f.request,f.admission)).rejects.toMatchObject({ response: { code: 'OBJECTIVE_CONTEXT_INCOMPLETE' } });
  });
});
