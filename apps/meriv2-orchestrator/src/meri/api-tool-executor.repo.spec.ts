import type { MeriContext } from '@capiro/meriv2-core';
import { ApiToolExecutorRepo } from './api-tool-executor.repo';
import { classifyApiToolReadOutcome } from './api-tool-read-outcome';
import { RequestCredentialsStore } from '../request/request-credentials.store';
import { withTrustedCurrentTurnScope } from '../request/trusted-current-turn-scope';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const OTHER_CONVERSATION = '44444444-4444-4444-8444-444444444444';
const CLIENT = '55555555-5555-4555-8555-555555555555';
const currentTurn = {
  tenantId: TENANT,
  userId: USER,
  conversationId: CONVERSATION,
  selectedClientId: CLIENT,
};

const originalFetch = global.fetch;
afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetch;
});

function cfg(values: Record<string, string | undefined>) {
  return { get: (k: string) => values[k] } as never;
}

function mockFetch() {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  (global as unknown as { fetch: unknown }).fetch = jest.fn(
    async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
    },
  );
  return calls;
}

function memoryPayload(kind: 'complete' | 'empty' | 'partial') {
  const partial = kind === 'partial';
  const empty = kind === 'empty';
  const source = {
    domain: 'institutional_knowledge',
    sourceStatus: partial ? 'degraded' : 'healthy',
    returned: empty ? 0 : 1,
    recordsEvaluated: empty ? 0 : 1,
    requestedEntityCount: 0,
    searchedEntityCount: 0,
    pagesRead: 1,
    hasMore: false,
    truncated: false,
    paginationComplete: true,
    coverageComplete: !partial,
    stopReason: partial ? 'governed_memory_semantic_projection_incomplete' : 'complete',
  };
  return {
    tool: 'search_memory',
    coverage: {
      requestedDomains: ['institutional_knowledge'],
      searchedDomains: ['institutional_knowledge'],
      requestedEntityCount: 0,
      searchedEntityCount: 0,
      recordsEvaluated: source.recordsEvaluated,
      recordsReturned: source.returned,
      paginationComplete: true,
      unavailableSources: [],
      sources: [source],
      complete: !partial,
      stopReason: source.stopReason,
    },
    factContentUnavailableCount: 0,
    contentStatus: empty ? 'empty' : 'available',
    contentTruncated: false,
    nextCursor: null,
    results: empty ? [] : [{ memoryItemId: 'memory-1' }],
    records: empty ? [] : [{ recordId: 'memory-1' }],
  };
}

const CTX = {} as unknown as MeriContext;

describe('ApiToolExecutorRepo — canonical mail read defaults', () => {
  const payload = {
    totalMatches: 0, returned: 0, hasMore: false, messages: [],
    searchedMailboxes: [{ mailCoverage: { sourceStatus: 'healthy' } }],
  };
  async function request(tool: string, input: Record<string, unknown>, status = 200) {
    const fetchMock = jest.fn().mockImplementation(async () =>
      new Response(JSON.stringify(status === 200 ? payload : { statusCode: status }), { status }),
    );
    global.fetch = fetchMock;
    const deadlineAt = Date.now() + 30_000;
    const repo = new ApiToolExecutorRepo(cfg({
      MERIV2_API_BASE_URL: 'https://api.example.test/',
      INTERNAL_SERVICE_SECRET: 'test-service-secret',
    }));
    const call = RequestCredentialsStore.run({ bearerToken: 'test-user-bearer' }, () =>
      withTrustedCurrentTurnScope(currentTurn, () =>
        repo.execute(CTX, tool, input, { deadlineAt }),
      ),
    );
    if (status === 200) await expect(call).resolves.toEqual(payload);
    else await expect(call).rejects.toThrow(`failed: ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.example.test/api/clio/tools/${tool}`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer test-user-bearer',
      'x-internal-service-secret': 'test-service-secret',
      'content-type': 'application/json', accept: 'application/json',
      'x-meri-deadline-at': String(deadlineAt),
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return JSON.parse(init.body as string);
  }

  test.each(['list_emails', 'search_emails'])('%s expands only omitted/null owner defaults', async (tool) => {
    for (const input of [
      { limit: 1 },
      { limit: 1, folder: null, offset: null },
      { limit: 1, folder: 'inbox' },
      { limit: 1, offset: 2, asOf: '2026-09-07T12:00:00.000Z' },
    ]) {
      const original = structuredClone(input);
      Object.freeze(input);
      expect(await request(tool, input)).toEqual({
        ...original, folder: original.folder ?? 'all', offset: original.offset ?? 0,
      });
      expect(input).toEqual(original);
    }
  });

  test.each(['list_emails', 'search_emails'])('%s preserves explicit values, literal text and client/date scope', async (tool) => {
    for (const fields of [
      { folder: 'sent', offset: 3 },
      { folder: 'invalid-folder', offset: -1 },
      { folder: false, offset: false },
      { folder: '', offset: '0' },
    ]) {
      const input = Object.freeze({
        ...fields, limit: 1, clientId: CLIENT, asOf: '2026-09-07T12:00:00.000Z',
        withinDays: 365, query: 'SELECT * FROM notes LIMIT 1', from: 'null',
        participant: 'literal_%\\text', unrelatedField: null,
      });
      expect(await request(tool, input)).toEqual(input);
    }
  });

  test.each(['query_tasks', 'get_email_thread', 'save_note'])('%s retains its original payload', async (tool) => {
    const input = Object.freeze({ limit: 1, folder: null, offset: null, clientId: CLIENT });
    expect(await request(tool, input, 403)).toEqual(input);
  });

  it('preserves the single-attempt refusal path after expanding mail defaults', async () => {
    expect(await request('list_emails', Object.freeze({ limit: 1 }), 403)).toEqual({
      limit: 1, folder: 'all', offset: 0,
    });
  });
});

describe('ApiToolExecutorRepo — internal service-secret header', () => {
  it('sends x-internal-service-secret (+ the user bearer) when INTERNAL_SERVICE_SECRET is set', async () => {
    const calls = mockFetch();
    const repo = new ApiToolExecutorRepo(cfg({ INTERNAL_SERVICE_SECRET: 'sec-123' }));
    await RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
      repo.execute(CTX, 'search_congress_bills', { q: 'ndaa' }),
    );
    expect(calls[0]?.headers['x-internal-service-secret']).toBe('sec-123');
    expect(calls[0]?.headers['authorization']).toBe('Bearer user-tok');
  });

  it('omits the header when INTERNAL_SERVICE_SECRET is unset (inert until wired)', async () => {
    const calls = mockFetch();
    const repo = new ApiToolExecutorRepo(cfg({}));
    await RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
      repo.execute(CTX, 'search_congress_bills', {}),
    );
    expect(calls[0]?.headers['x-internal-service-secret']).toBeUndefined();
    expect(calls[0]?.headers['authorization']).toBe('Bearer user-tok');
  });
});

describe('ApiToolExecutorRepo — Research Portfolio current-turn boundary', () => {
  it('sends the finite RP envelope and derives an omitted model conversation', async () => {
    let captured: Record<string, unknown> | undefined;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (_url: string, init: { body: string }) => {
        captured = JSON.parse(init.body) as Record<string, unknown>;
        return new Response(JSON.stringify({ authorized: true }));
      },
    );
    const repo = new ApiToolExecutorRepo(cfg({ INTERNAL_SERVICE_SECRET: 'sec-123' }));

    await RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
      withTrustedCurrentTurnScope(currentTurn, () =>
        repo.execute(CTX, 'get_research_portfolio', {}),
      ),
    );

    expect(captured).toEqual({
      version: 1,
      input: { conversationId: CONVERSATION },
      currentTurn,
    });
  });

  it('fails missing scope, cross-model target, invalid context, and missing secret before network', async () => {
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    const repo = new ApiToolExecutorRepo(cfg({ INTERNAL_SERVICE_SECRET: 'sec-123' }));

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        repo.execute(CTX, 'get_research_portfolio', {}),
      ),
    ).rejects.toThrow('Trusted current-turn scope is unavailable');
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        withTrustedCurrentTurnScope(currentTurn, () =>
          repo.execute(CTX, 'get_research_portfolio', {
            conversationId: OTHER_CONVERSATION,
          }),
        ),
      ),
    ).rejects.toThrow('cannot target another conversation');
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        withTrustedCurrentTurnScope({ ...currentTurn, userId: 'invalid' }, () =>
          repo.execute(CTX, 'get_research_portfolio', {}),
        ),
      ),
    ).rejects.toThrow('Trusted current-turn scope is invalid');
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        withTrustedCurrentTurnScope(currentTurn, () =>
          new ApiToolExecutorRepo(cfg({})).execute(CTX, 'get_research_portfolio', {}),
        ),
      ),
    ).rejects.toThrow('INTERNAL_SERVICE_SECRET is not configured');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps ordinary delegated tools compatible without trusted scope or service identity', async () => {
    const calls = mockFetch();
    const repo = new ApiToolExecutorRepo(cfg({}));
    await RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
      repo.execute(CTX, 'search_congress_bills', { query: 'NDAA' }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers['x-internal-service-secret']).toBeUndefined();
  });
});

describe('ApiToolExecutorRepo — delegated read outcomes', () => {
  it('rejects the real get_email_thread HTTP 200 validation-error envelope without retrying', async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'Use exact threadId and messageId UUIDs returned by the mail tools.',
          }),
        ),
    );
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    const repo = new ApiToolExecutorRepo(cfg({}));

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        repo.execute(CTX, 'get_email_thread', { threadId: 'not-a-uuid' }),
      ),
    ).rejects.toThrow('Use exact threadId and messageId UUIDs');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves a partial document payload for useful synthesis', async () => {
    const partial = {
      tool: 'read_client_documents',
      coverage: {
        complete: false,
        truncated: true,
        extractedSectionEmpty: false,
        continuationBlocked: false,
        matched: null,
        nextCursor: 'document:next',
      },
      records: [{ recordId: 'page-1' }],
    };
    const fetchMock = jest.fn(async () => new Response(JSON.stringify(partial)));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    const repo = new ApiToolExecutorRepo(cfg({}));

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        repo.execute(CTX, 'read_client_documents', { clientId: 'client-1' }),
      ),
    ).resolves.toEqual(partial);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects unavailable document content without retrying the unchanged read', async () => {
    const unavailable = {
      tool: 'read_client_documents',
      coverage: {
        complete: false,
        truncated: true,
        extractedSectionEmpty: true,
        continuationBlocked: true,
        missingContent: true,
        matched: null,
        nextCursor: null,
      },
      records: [],
    };
    const fetchMock = jest.fn(async () => new Response(JSON.stringify(unavailable)));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    const repo = new ApiToolExecutorRepo(cfg({}));

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        repo.execute(CTX, 'read_client_documents', { clientId: 'client-1' }),
      ),
    ).rejects.toThrow('document_content_unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed discriminated client-context response after actual fetch parsing', async () => {
    const malformed = {
      tool: 'get_client_context',
      context: { client: { id: 'client-1' } },
    };
    const fetchMock = jest.fn(async () => new Response(JSON.stringify(malformed)));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    const repo = new ApiToolExecutorRepo(cfg({}));

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        repo.execute(CTX, 'get_client_context', { clientId: 'client-1' }),
      ),
    ).rejects.toThrow('get_client_context_result_contract_invalid');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty current client-context section map after actual fetch parsing', async () => {
    const malformed = {
      tool: 'get_client_context',
      context: { client: { id: 'client-1' } },
      profileSections: {},
    };
    const fetchMock = jest.fn(async () => new Response(JSON.stringify(malformed)));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    const repo = new ApiToolExecutorRepo(cfg({}));

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        repo.execute(CTX, 'get_client_context', { clientId: 'client-1' }),
      ),
    ).rejects.toThrow('get_client_context_result_contract_invalid');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'search_emails',
      {
        totalMatches: 2,
        returned: 1,
        hasMore: false,
        offset: 1,
        messages: [{ id: 'mail-2' }],
        searchedMailboxes: [{ mailCoverage: { sourceStatus: 'healthy' } }],
      },
      'mail_coverage_incomplete',
    ],
    [
      'get_email_thread',
      {
        totalMessages: 2,
        returned: 1,
        hasMore: false,
        messageOffset: 1,
        messages: [{ bodyCompleteness: 'full', bodyTruncated: false }],
      },
      'mail_body_coverage_incomplete',
    ],
  ])(
    'preserves the owner %s final page while classifying it partial',
    async (tool, payload, reason) => {
      expect(classifyApiToolReadOutcome(tool, payload)).toEqual({ kind: 'partial', reason });
      const fetchMock = jest.fn(async () => new Response(JSON.stringify(payload)));
      (global as unknown as { fetch: unknown }).fetch = fetchMock;
      const repo = new ApiToolExecutorRepo(cfg({}));

      await expect(
        RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () => repo.execute(CTX, tool, {})),
      ).resolves.toEqual(payload);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['partial', 'empty', 'complete'] as const)(
    'preserves the owner search_memory %s payload through controlled fetch',
    async (kind) => {
      const payload = memoryPayload(kind);
      const fetchMock = jest.fn(async () => new Response(JSON.stringify(payload)));
      (global as unknown as { fetch: unknown }).fetch = fetchMock;
      const repo = new ApiToolExecutorRepo(cfg({}));

      await expect(
        RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
          repo.execute(CTX, 'search_memory', { query: 'funding' }),
        ),
      ).resolves.toEqual(payload);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves an unknown tool nested error field unchanged after actual fetch parsing', async () => {
    const payload = {
      results: [{ title: 'Provider error handling', error: 'quoted source field' }],
    };
    const fetchMock = jest.fn(async () => new Response(JSON.stringify(payload)));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    const repo = new ApiToolExecutorRepo(cfg({}));

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
        repo.execute(CTX, 'search_public_web', { query: 'provider errors' }),
      ),
    ).resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
import { createMeriTelemetryContext } from '@capiro/meriv2-core';
import { createMeriOtelRuntime } from '@capiro/meriv2-core/observability/otel';
import {
  runWithMeriOrchestratorTelemetry,
  setMeriOtelRuntime,
} from '../telemetry/meri-telemetry.runtime.js';

test('real tool owner retry exports distinct attempt IDs matching each transmitted carrier', async () => {
  const spans: any[] = [];
  const carriers: any[] = [];
  const sdk = createMeriOtelRuntime({
    serviceName: 'tool-owner-test',
    exporter: {
      export: (batch, done) => {
        spans.push(...batch);
        done({ code: 0 });
      },
      shutdown: async () => {},
    },
  });
  await setMeriOtelRuntime(sdk);
  global.fetch = jest.fn(async (_url, init) => {
    const headers = init!.headers as Record<string, string>;
    carriers.push(JSON.parse(decodeURIComponent(headers['x-capiro-telemetry-context']!)));
    return carriers.length === 1
      ? new Response(
          JSON.stringify({
            statusCode: 503,
            message: 'The database is temporarily busy. Please retry.',
          }),
          { status: 503, headers: { 'retry-after': '0' } },
        )
      : new Response(
          JSON.stringify({
            totalMatches: 0,
            returned: 0,
            hasMore: false,
            messages: [],
            searchedMailboxes: [{ mailCoverage: { sourceStatus: 'healthy' } }],
          }),
          { status: 200 },
        );
  }) as typeof fetch;
  try {
    await runWithMeriOrchestratorTelemetry(
      createMeriTelemetryContext({ tenantId: TENANT, actorId: USER }),
      () => {},
      () =>
        RequestCredentialsStore.run({ bearerToken: 'PRIVATE_USER_TOKEN' }, () =>
          new ApiToolExecutorRepo(
            cfg({ INTERNAL_SERVICE_SECRET: 'PRIVATE_SERVICE_SECRET' }),
          ).execute(CTX, 'list_emails', {}),
        ),
    );
    await sdk.forceFlush();
    const attempts = spans.filter((span) => span.name === 'meri.orchestrator_tool');
    expect(attempts).toHaveLength(2);
    expect(new Set(carriers.map((value) => value.spanId)).size).toBe(2);
    for (const carrier of carriers)
      expect(
        attempts.some(
          (span) =>
            span.spanContext().spanId === carrier.spanId &&
            span.parentSpanContext.spanId === carrier.parentSpanId,
        ),
      ).toBe(true);
    expect(attempts.map((span) => span.attributes['meri.outcome'])).toEqual([
      'retry_scheduled',
      'completed',
    ]);
    expect(JSON.stringify(attempts.map((span) => span.attributes))).not.toContain('PRIVATE_');
  } finally {
    await setMeriOtelRuntime(undefined);
  }
});
