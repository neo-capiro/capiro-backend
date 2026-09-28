import type { MeriContext } from '@capiro/meriv2-core';
import { ApiToolExecutorRepo } from './api-tool-executor.repo';
import { classifyApiToolReadOutcome } from './api-tool-read-outcome';
import { RequestCredentialsStore } from '../request/request-credentials.store';

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
