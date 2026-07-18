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
