import type { ConfigService } from '@nestjs/config';
import type { MeriContext } from '@capiro/meriv2-core';
import { ApiClientContextRepo } from './api-client-context.repo';
import { RequestCredentialsStore } from '../request/request-credentials.store';

const ctx: MeriContext = { tenantId: 't', userId: 'u', clerkUserId: 'c', role: 'standard_user' };
const config = {
  get: (k: string) => (k === 'MERIV2_API_BASE_URL' ? 'http://api.test' : undefined),
} as unknown as ConfigService;

describe('ApiClientContextRepo', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });

  it('forwards the bearer token and parses the api response', async () => {
    const calls: Array<{ url: unknown; init: { headers: Record<string, string> } }> = [];
    global.fetch = (async (url: unknown, init: { headers: Record<string, string> }) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ client: { id: 'cid', name: 'Acme' } }) };
    }) as unknown as typeof fetch;

    const repo = new ApiClientContextRepo(config);
    const result = await RequestCredentialsStore.run({ bearerToken: 'TOK' }, () =>
      repo.loadClientContext(ctx, 'cid'),
    );

    expect(result.client.id).toBe('cid');
    expect(calls[0]?.url).toBe('http://api.test/api/engagement/context/cid');
    expect(calls[0]?.init.headers.authorization).toBe('Bearer TOK');
  });

  it('throws when no forwarded credential is in scope', async () => {
    const repo = new ApiClientContextRepo(config);
    await expect(repo.loadClientContext(ctx, 'cid')).rejects.toThrow(/forwarded credential/);
  });

  it('throws on a non-ok api response', async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'denied',
    })) as unknown as typeof fetch;
    const repo = new ApiClientContextRepo(config);
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'TOK' }, () => repo.loadClientContext(ctx, 'cid')),
    ).rejects.toThrow(/403/);
  });
});
