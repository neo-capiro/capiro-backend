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
  it('uses a dedicated private tool API target without changing other API clients', async () => {
    const calls = mockFetch();
    const repo = new ApiToolExecutorRepo(cfg({
      MERIV2_API_BASE_URL: 'https://os.capiro.ai',
      MERIV2_TOOL_API_BASE_URL: 'http://api.capiro-dev.local:4000/',
      INTERNAL_SERVICE_SECRET: 'synthetic-private-secret',
    }));
    await RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
      repo.execute(CTX, 'query_tasks', { limit: 1 }),
    );
    expect(calls[0]?.url).toBe('http://api.capiro-dev.local:4000/api/clio/tools/query_tasks');
    expect(calls[0]?.headers['x-internal-service-secret']).toBe('synthetic-private-secret');
  });

  it('fails closed when a private target has no service identity', () => {
    expect(() => new ApiToolExecutorRepo(cfg({
      MERIV2_TOOL_API_BASE_URL: 'http://api.capiro-dev.local:4000',
    }))).toThrow('Private delegated tool API requires INTERNAL_SERVICE_SECRET');
  });

  it('rejects a private target that could receive forwarded credentials outside the private API', () => {
    expect(() => new ApiToolExecutorRepo(cfg({
      MERIV2_TOOL_API_BASE_URL: 'https://example.com',
      INTERNAL_SERVICE_SECRET: 'synthetic-private-secret',
    }))).toThrow('Private delegated tool API must be an internal .local HTTP endpoint on port 4000');
  });

  it('sends x-internal-service-secret (+ the user bearer) when INTERNAL_SERVICE_SECRET is set', async () => {
    const calls = mockFetch();
    const repo = new ApiToolExecutorRepo(cfg({ INTERNAL_SERVICE_SECRET: 'sec-123' }));
    await RequestCredentialsStore.run({ bearerToken: 'user-tok' }, () =>
      repo.execute(CTX, 'search_congress_bills', { q: 'ndaa' }),
    );
    expect(calls[0]?.headers['x-internal-service-secret']).toBe('sec-123');
    expect(calls[0]?.headers['authorization']).toBe('Bearer user-tok');
    expect(calls[0]?.headers['x-meri-delegated-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
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

describe('ApiToolExecutorRepo — historical delegated 403 acceptance', () => {
  it.each([
    'query_economic_data',
    'query_tasks',
    'query_action_items',
    'query_regulatory_dockets',
  ])('preserves a denied %s call as a failed source read', async (toolName) => {
    const input = { limit: toolName === 'query_economic_data' ? 10 : 50 };
    const requests: Array<{ url: string; init: RequestInit }> = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return {
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: async () => '{"statusCode":403,"message":"Forbidden"}',
        };
      },
    );
    const repo = new ApiToolExecutorRepo(
      cfg({ MERIV2_API_BASE_URL: 'http://127.0.0.1:39999/', INTERNAL_SERVICE_SECRET: 'fixture-secret' }),
    );
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'fixture-user' }, () =>
        repo.execute(CTX, toolName, input),
      ),
    ).rejects.toThrow(`Delegated tool "${toolName}" failed: 403 Forbidden`);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`http://127.0.0.1:39999/api/clio/tools/${toolName}`);
    expect(requests[0]?.init.method).toBe('POST');
    expect(requests[0]?.init.body).toBe(JSON.stringify(input));
    expect(requests[0]?.init.headers).toMatchObject({
      authorization: 'Bearer fixture-user',
      'x-internal-service-secret': 'fixture-secret',
    });
    expect((requests[0]?.init.headers as Record<string, string>)['x-meri-delegated-request-id'])
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('bounds an HTML 403 body and does not retry it', async () => {
    const body = `<html>${'denied'.repeat(100)}</html>`;
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => body,
    }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    const repo = new ApiToolExecutorRepo(cfg({ INTERNAL_SERVICE_SECRET: 'fixture-secret' }));
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'fixture-user' }, () =>
        repo.execute(CTX, 'query_economic_data', { limit: 10 }),
      ),
    ).rejects.toThrow(`Delegated tool "query_economic_data" failed: 403 Forbidden ${body.slice(0, 200)}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
