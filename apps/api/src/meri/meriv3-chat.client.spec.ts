import { MeriV3ChatClient } from './meriv3-chat.client.js';
import { createMeriTelemetryContext } from '@capiro/meriv2-core';
import { runWithMeriApiTelemetry } from './meri-telemetry.runtime.js';

function sseResponse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('MeriV3ChatClient', () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.MERIV2_ORCHESTRATOR_URL;

  beforeEach(() => {
    process.env.MERIV2_ORCHESTRATOR_URL = 'https://app.capiro.test';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.MERIV2_ORCHESTRATOR_URL;
    else process.env.MERIV2_ORCHESTRATOR_URL = originalUrl;
    jest.restoreAllMocks();
  });

  test('posts the reasoning mode and parses retrieval coverage across the V3 route', async () => {
    const retrieval = {
      plan: {
        version: 1,
        queryClass: 'relationship_history',
        subjectScope: 'external_entity',
        targetHint: 'Victory Six',
        recipeTool: 'query_relationship_brief',
        requireCompleteCoverage: true,
        requiredDomains: ['mail'],
        timeWindow: null,
      },
      coverage: {
        version: 1,
        complete: false,
        requestedDomains: ['mail'],
        searchedDomains: ['mail'],
        missingDomains: [],
        partialDomains: ['mail'],
        requestedEntityCount: 1,
        searchedEntityCount: 1,
        recordsEvaluated: 1,
        recordsReturned: 1,
        paginationComplete: true,
        truncated: false,
        sourceHealth: [],
        unavailableSources: [],
        toolsInvoked: ['search_emails'],
        stopReason: 'partial',
      },
    } as const;
    const fetchMock = jest.fn(async (..._args: Parameters<typeof fetch>) =>
      sseResponse([
        { type: 'runtime', runtime: 'meriv3', model: 'gpt-5.1', reasoningMode: 'deep' },
        { type: 'text', text: 'Answer' },
        {
          type: 'done',
          runtime: 'meriv3',
          model: 'gpt-5.1',
          reasoningMode: 'deep',
          reasoningEffort: 'high',
          reply: 'Answer',
          steps: [],
          retrieval,
        },
      ]),
    );
    global.fetch = fetchMock as typeof fetch;
    const client = new MeriV3ChatClient();
    const events: unknown[] = [];
    const telemetry = createMeriTelemetryContext({
      tenantId: 'tenant-a',
      actorId: 'actor-a',
      conversationId: 'conversation-a',
      browserRequestId: 'browser-a',
    });
    await runWithMeriApiTelemetry(
      telemetry,
      () => {},
      () =>
        client.streamChat({
          bearerToken: 'bearer',
          input: {
            messages: [{ role: 'user', text: 'Analyze this' }],
            reasoningMode: 'deep',
          },
          aiProvider: {
            provider: 'openai',
            apiKey: 'resolved-key',
            model: 'gpt-5.1',
            usedTenantKey: false,
            modelOverridden: false,
          },
          onEvent: (event) => events.push(event),
        }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.capiro.test/meri-api/v3/chat/stream',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual(
      expect.objectContaining({
        authorization: 'Bearer bearer',
        'x-request-id': telemetry.requestId,
        traceparent: expect.stringContaining(telemetry.traceId),
      }),
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      reasoningMode: 'deep',
      telemetryContext: {
        traceId: telemetry.traceId,
        requestId: telemetry.requestId,
        serverTurnId: telemetry.serverTurnId,
        runId: telemetry.runId,
        tenantId: telemetry.tenantId,
        actorId: telemetry.actorId,
      },
    });
    expect(events).toHaveLength(3);
    expect(events[2]).toEqual(expect.objectContaining({ type: 'done', retrieval }));
  });

  test('fails before the network without the caller bearer', async () => {
    global.fetch = jest.fn() as typeof fetch;
    const client = new MeriV3ChatClient();
    await expect(
      client.streamChat({
        bearerToken: '',
        input: { messages: [], reasoningMode: 'standard' },
        onEvent: () => {},
      }),
    ).rejects.toThrow('requires the caller bearer token');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('refuses an Anthropic credential instead of misrouting it to OpenAI', async () => {
    const client = new MeriV3ChatClient();
    await expect(
      client.streamChat({
        bearerToken: 'bearer',
        input: { messages: [], reasoningMode: 'standard' },
        aiProvider: {
          provider: 'anthropic',
          apiKey: 'anthropic-key',
          model: 'claude',
          usedTenantKey: true,
          modelOverridden: true,
        },
        onEvent: () => {},
      }),
    ).rejects.toThrow('requires an OpenAI credential');
  });
});
import { createMeriOtelRuntime } from '@capiro/meriv2-core/observability/otel';
import { setMeriOtelRuntime } from './meri-telemetry.runtime.js';

test('real proxy owner transmits the actual exported client span identity', async () => {
  const savedFetch = global.fetch;
  const savedUrl = process.env.MERIV2_ORCHESTRATOR_URL;
  const spans: any[] = [];
  let body: any;
  let headers: Record<string, string> = {};
  const sdk = createMeriOtelRuntime({
    serviceName: 'proxy-owner-test',
    exporter: {
      export: (batch, done) => {
        spans.push(...batch);
        done({ code: 0 });
      },
      shutdown: async () => {},
    },
  });
  await setMeriOtelRuntime(sdk);
  process.env.MERIV2_ORCHESTRATOR_URL = 'https://orchestrator.test';
  global.fetch = jest.fn(async (_url, init) => {
    body = JSON.parse(String(init!.body));
    headers = init!.headers as Record<string, string>;
    return sseResponse([{ type: 'done' }]);
  }) as typeof fetch;
  const root = createMeriTelemetryContext({ tenantId: 'tenant', actorId: 'actor' });
  try {
    await runWithMeriApiTelemetry(
      root,
      () => {},
      () =>
        new MeriV3ChatClient().streamChat({
          bearerToken: 'PRIVATE_BEARER',
          input: {
            messages: [{ role: 'user', text: 'PRIVATE_PROMPT' }],
            reasoningMode: 'standard',
          },
          onEvent: () => {},
        }),
    );
    await sdk.forceFlush();
    const child = spans.find((span) => span.name === 'meri.api_orchestrator');
    expect(child).toBeDefined();
    expect(child.parentSpanContext.spanId).toBe(root.spanId);
    expect(body.telemetryContext.spanId).toBe(child.spanContext().spanId);
    expect(headers.traceparent).toBe(`00-${root.traceId}-${child.spanContext().spanId}-01`);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('PRIVATE_');
  } finally {
    global.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.MERIV2_ORCHESTRATOR_URL;
    else process.env.MERIV2_ORCHESTRATOR_URL = savedUrl;
    await setMeriOtelRuntime(undefined);
  }
});
