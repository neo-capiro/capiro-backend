import type { ConfigService } from '@nestjs/config';
import { StrategyOrchestratorClient } from './strategy-orchestrator.client.js';
import { runWithStrategyGovernedContext } from './strategy-governed-context.runtime.js';
import type { StrategyGovernedTurnContext } from './strategy-governed-context.types.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';

function config(values: Record<string, string | undefined>): ConfigService {
  return { get: jest.fn((key: string) => values[key]) } as unknown as ConfigService;
}

function governed(
  operationId: StrategyGovernedTurnContext['operationId'] = 'strategies.generate',
): StrategyGovernedTurnContext {
  return {
    version: 1,
    operationId,
    prompt: 'governed context',
    contextPacket: {
      packetId: 'packet-1',
      persisted: true,
      surface:
        operationId === 'workspace.generate'
          ? 'workspace-gen'
          : operationId === 'outreach.generate'
            ? 'outreach'
            : 'strategy',
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

describe('StrategyOrchestratorClient governed transport', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function client(secret = 'secret') {
    return new StrategyOrchestratorClient(
      config({
        MERIV2_ORCHESTRATOR_URL: 'https://meri.internal/',
        INTERNAL_SERVICE_SECRET: secret,
      }),
    );
  }

  test('direct Strategy draft calls fail before transport when no governed runtime exists', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      client().draft({ clientId: CLIENT, type: 'appropriations' }, 'token'),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('forwards the governed bundle and internal marker to the orchestrator', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ summary: 'Drafted', nodes: [] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const ctx = governed();

    await runWithStrategyGovernedContext(ctx, () =>
      client().draft({ clientId: CLIENT, type: 'appropriations' }, 'token'),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://meri.internal/meri-api/strategy-draft',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer token',
          'x-internal-service-secret': 'secret',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.clientId).toBe(CLIENT);
    expect(body.governedContext).toEqual(ctx);
  });

  test.each([
    ['workspace_draft', 'workspace.generate'],
    ['outreach_record', 'outreach.generate'],
  ] as const)('requires %s to carry %s context', async (kind, operationId) => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ title: null, summary: null, sections: [], model: null }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const ctx = governed(operationId);

    await runWithStrategyGovernedContext(ctx, () =>
      client().nodeDocumentDraft({ clientId: CLIENT, kind }, 'token'),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.governedContext.operationId).toBe(operationId);
  });

  test('rejects a Strategy packet on an Outreach document path', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      runWithStrategyGovernedContext(governed('strategies.generate'), () =>
        client().nodeDocumentDraft(
          { clientId: CLIENT, kind: 'outreach_record' },
          'token',
        ),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('report narrative is an internal, delegated hop that needs no governed bundle', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sections: [], model: 'm', usage: { inputTokens: 1, outputTokens: 1 } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await client().reportNarrative(
      { audience: 'client', evidence: [{ id: 'plan:strategy', text: 'x' }] },
      undefined,
      undefined,
      { tenantId: 'tenant-1', clerkUserId: 'user-1' },
      12_345,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://meri.internal/meri-api/strategy-report-narrative',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-internal-service-secret': 'secret',
          'x-capiro-delegated-tenant': 'tenant-1',
          'x-capiro-delegated-user': 'user-1',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.governedContext).toBeUndefined();
    expect(body.evidence).toEqual([{ id: 'plan:strategy', text: 'x' }]);
  });

  test('report narrative without a bearer or delegation fails before transport', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      client().reportNarrative({ audience: 'client', evidence: [] }, undefined),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('requires the internal secret for governed reasoning routes', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      runWithStrategyGovernedContext(governed(), () =>
        client('').draft({ clientId: CLIENT }, 'token'),
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ---- draftStreaming() — the async draft-job worker's NDJSON transport ----

  /** A fake chunked-response body: each array entry is delivered as one
   *  `reader.read()` chunk, so a test can either send one line per chunk or
   *  split a single line across chunks to exercise the buffering. */
  function fakeNdjsonBody(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) {
            return { done: false, value: encoder.encode(chunks[i++]) };
          }
          return { done: true, value: undefined };
        },
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
    } as unknown as ReadableStream<Uint8Array>;
  }

  test('streams progress lines to the callback and resolves with the terminal result', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: fakeNdjsonBody([
        '{"type":"progress","stage":"drafting","attempt":1,"round":1,"delta":"Hello"}\n',
        '{"type":"progress","stage":"drafting","attempt":1,"round":2,"delta":" world"}\n',
        '{"type":"result","summary":"Drafted 1 step","nodes":[{"kind":"action"}]}\n',
      ]),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const progressEvents: unknown[] = [];

    const result = await runWithStrategyGovernedContext(governed(), () =>
      client().draftStreaming(
        { clientId: CLIENT, type: 'appropriations' },
        undefined,
        undefined,
        { tenantId: 'tenant-1', clerkUserId: 'user-1' },
        (evt) => progressEvents.push(evt),
      ),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://meri.internal/meri-api/strategy-draft-stream',
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-internal-service-secret': 'secret',
          'x-capiro-delegated-tenant': 'tenant-1',
          'x-capiro-delegated-user': 'user-1',
        }),
      }),
    );
    expect(fetchMock.mock.calls[0]![1].headers.authorization).toBeUndefined();
    expect(progressEvents).toEqual([
      { type: 'progress', stage: 'drafting', attempt: 1, round: 1, delta: 'Hello' },
      { type: 'progress', stage: 'drafting', attempt: 1, round: 2, delta: ' world' },
    ]);
    expect(result).toEqual({ summary: 'Drafted 1 step', nodes: [{ kind: 'action' }] });
  });

  test('reassembles a single NDJSON line split across chunk boundaries', async () => {
    const line = '{"type":"result","summary":"ok","nodes":[]}\n';
    const splitAt = 20;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: fakeNdjsonBody([line.slice(0, splitAt), line.slice(splitAt)]),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await runWithStrategyGovernedContext(governed(), () =>
      client().draftStreaming({ clientId: CLIENT, type: 'appropriations' }, 'token', undefined, undefined, () => {}),
    );

    expect(result).toEqual({ summary: 'ok', nodes: [] });
  });

  test('a stream-level {type:error} line rejects with its message, not the generic transport failure', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: fakeNdjsonBody(['{"type":"error","message":"Meri could not draft this strategy"}\n']),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      runWithStrategyGovernedContext(governed(), () =>
        client().draftStreaming({ clientId: CLIENT, type: 'appropriations' }, 'token', undefined, undefined, () => {}),
      ),
    ).rejects.toMatchObject({ status: 503, message: 'Meri could not draft this strategy' });
  });

  test('a malformed line is skipped rather than failing the whole call', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: fakeNdjsonBody([
        'not json at all\n',
        '{"type":"progress","delta":"hi"}\n',
        '{"type":"result","summary":"ok","nodes":[]}\n',
      ]),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const progress = jest.fn();

    const result = await runWithStrategyGovernedContext(governed(), () =>
      client().draftStreaming({ clientId: CLIENT, type: 'appropriations' }, 'token', undefined, undefined, progress),
    );

    expect(progress).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ summary: 'ok', nodes: [] });
  });

  test('a stream that ends without a terminal result/error rejects with a clear message', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      body: fakeNdjsonBody(['{"type":"progress","delta":"still going"}\n']),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      runWithStrategyGovernedContext(governed(), () =>
        client().draftStreaming({ clientId: CLIENT, type: 'appropriations' }, 'token', undefined, undefined, () => {}),
      ),
    ).rejects.toMatchObject({ status: 503, message: expect.stringMatching(/ended without a result/) });
  });

  test('draftStreaming also requires governed context before transport', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      client().draftStreaming({ clientId: CLIENT, type: 'appropriations' }, 'token', undefined, undefined, () => {}),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('Steward extraction remains a separate authenticated operation', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ facts: [], conflicts: [], summary: 'none' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(client().stewardExtract({ documentId: 'doc-1' }, 'token')).resolves.toEqual({
      facts: [],
      conflicts: [],
      summary: 'none',
    });
    const init = fetchMock.mock.calls[0]![1];
    expect(init.headers['x-internal-service-secret']).toBeUndefined();
  });
});
