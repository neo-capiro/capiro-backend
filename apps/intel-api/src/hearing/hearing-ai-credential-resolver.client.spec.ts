import type { ConfigService } from '@nestjs/config';
import { HearingAiCredentialResolver } from './hearing-ai-credential-resolver.client';

function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  const values: Record<string, string | undefined> = {
    API_BASE_URL: 'https://api.test',
    INTERNAL_SERVICE_SECRET: 'shh',
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

const originalFetch = global.fetch;
afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('HearingAiCredentialResolver', () => {
  it('is not configured, and never calls fetch, when INTERNAL_SERVICE_SECRET is unset', async () => {
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    const resolver = new HearingAiCredentialResolver(
      makeConfig({ INTERNAL_SERVICE_SECRET: undefined }),
    );
    expect(resolver.configured).toBe(false);
    expect(await resolver.resolve('tenant-1')).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves the tenant credential and sends the shared secret header', async () => {
    const fetchSpy = jest.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.test/api/internal/ai-credentials/resolve');
      expect((init.headers as Record<string, string>)['x-internal-service-secret']).toBe('shh');
      expect(JSON.parse(init.body as string)).toEqual({
        tenantId: 'tenant-1',
        provider: 'anthropic',
      });
      return {
        ok: true,
        json: async () => ({
          resolved: true,
          provider: 'anthropic',
          apiKey: 'sk-tenant',
          model: 'claude-x',
          usedTenantKey: true,
          modelOverridden: false,
        }),
      };
    });
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    const resolver = new HearingAiCredentialResolver(makeConfig());

    const result = await resolver.resolve('tenant-1');
    expect(result).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-tenant',
      model: 'claude-x',
      usedTenantKey: true,
      modelOverridden: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('caches a successful resolve — a second call within the TTL does not re-fetch', async () => {
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        resolved: true,
        provider: 'anthropic',
        apiKey: 'sk-tenant',
        model: 'claude-x',
        usedTenantKey: true,
        modelOverridden: false,
      }),
    }));
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    const resolver = new HearingAiCredentialResolver(makeConfig());

    await resolver.resolve('tenant-1');
    await resolver.resolve('tenant-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when apps/api says the tenant has no credential (global fallback)', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ resolved: false }),
    }));
    const resolver = new HearingAiCredentialResolver(makeConfig());
    expect(await resolver.resolve('tenant-1')).toBeUndefined();
  });

  it('degrades to undefined on a non-ok response, and does NOT cache the failure', async () => {
    let call = 0;
    const fetchSpy = jest.fn(async () => {
      call += 1;
      if (call === 1) return { ok: false, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          resolved: true,
          provider: 'anthropic',
          apiKey: 'sk-tenant',
          model: 'claude-x',
          usedTenantKey: true,
          modelOverridden: false,
        }),
      };
    });
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    const resolver = new HearingAiCredentialResolver(makeConfig());

    expect(await resolver.resolve('tenant-1')).toBeUndefined();
    // A retry immediately after should hit the network again (failure not cached).
    expect(await resolver.resolve('tenant-1')).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-tenant',
      model: 'claude-x',
      usedTenantKey: true,
      modelOverridden: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('degrades to undefined when fetch throws', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new Error('network down');
    });
    const resolver = new HearingAiCredentialResolver(makeConfig());
    expect(await resolver.resolve('tenant-1')).toBeUndefined();
  });
});
