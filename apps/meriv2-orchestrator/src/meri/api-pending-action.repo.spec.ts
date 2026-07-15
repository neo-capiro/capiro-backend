import type { ConfigService } from '@nestjs/config';
import { ApiPendingActionRepo } from './api-pending-action.repo';
import { RequestCredentialsStore } from '../request/request-credentials.store';

/**
 * B4.1: this repo caches the EXACT {tool, input} behind a WARN decision so
 * apps/api's approve endpoint can replay it directly instead of re-asking the
 * model (which re-derives a different, differently-fingerprinted proposal
 * every time — the confirmed root cause of "approve does nothing").
 */
const config = {
  get: (k: string) => (k === 'MERIV2_API_BASE_URL' ? 'http://api.test' : undefined),
} as unknown as ConfigService;

describe('ApiPendingActionRepo', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    (global as unknown as { fetch: unknown }).fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('posts the fingerprint + tool + exact input, forwarding the caller bearer', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return { ok: true, status: 200 };
      },
    );
    const repo = new ApiPendingActionRepo(config);

    await RequestCredentialsStore.run({ bearerToken: 'TOK' }, () => {
      repo.record({ fingerprint: 'fp1', tool: 'update_client_profile', input: { clientId: 'c1' } });
      return Promise.resolve();
    });
    // record() is fire-and-forget; flush the microtask queue before asserting.
    await new Promise((r) => setImmediate(r));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://api.test/api/clio/pending-actions');
    expect(calls[0]?.headers.authorization).toBe('Bearer TOK');
    expect(calls[0]?.body).toEqual({
      fingerprint: 'fp1',
      tool: 'update_client_profile',
      input: { clientId: 'c1' },
    });
  });

  it('skips silently with no bearer in scope (never throws into the turn)', async () => {
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    const repo = new ApiPendingActionRepo(config);

    expect(() => repo.record({ fingerprint: 'fp1', tool: 'send_email', input: {} })).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('swallows a non-2xx response (fail-open — never blocks the turn)', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
    }));
    const repo = new ApiPendingActionRepo(config);

    await RequestCredentialsStore.run({ bearerToken: 'TOK' }, () => {
      expect(() =>
        repo.record({ fingerprint: 'fp1', tool: 'send_email', input: {} }),
      ).not.toThrow();
      return Promise.resolve();
    });
    await new Promise((r) => setImmediate(r));
  });

  it('swallows a network failure (fail-open — never blocks the turn)', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const repo = new ApiPendingActionRepo(config);

    await RequestCredentialsStore.run({ bearerToken: 'TOK' }, () => {
      expect(() =>
        repo.record({ fingerprint: 'fp1', tool: 'send_email', input: {} }),
      ).not.toThrow();
      return Promise.resolve();
    });
    await new Promise((r) => setImmediate(r));
  });
});
