import type { MeriContext } from '@capiro/meriv2-core';
import { ApiToolExecutorRepo } from './api-tool-executor.repo';
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
});
