import type { ConfigService } from '@nestjs/config';
import { WorkspaceGenClient } from './workspace-gen.client';
import { RequestCredentialsStore } from '../../request/request-credentials.store';

function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  const values: Record<string, string | undefined> = {
    MERIV2_WORKSPACE_BASE_URL: 'http://ws.test',
    ...overrides,
  };
  return { get: (k: string) => values[k] } as unknown as ConfigService;
}

const originalFetch = global.fetch;
afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('WorkspaceGenClient', () => {
  it('routes to the NON-PROXY generate-all-direct entry with the forwarded bearer', async () => {
    const fetchSpy = jest.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://ws.test/workspace-api/drafts/draft-1/generate-all-direct');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer jwt');
      return { ok: true, json: async () => ({ id: 'draft-1', documents: [] }) };
    });
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    const client = new WorkspaceGenClient(makeConfig());

    const out = await RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
      client.generateAllSections('draft-1'),
    );
    expect(out).toEqual({ id: 'draft-1', documents: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws when there is no forwarded bearer (never calls workspace unauthenticated)', async () => {
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    const client = new WorkspaceGenClient(makeConfig());
    await expect(client.generateAllSections('draft-1')).rejects.toThrow(/bearer/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws on a non-ok workspace response', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      text: async () => 'down',
    }));
    const client = new WorkspaceGenClient(makeConfig());
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'jwt' }, () =>
        client.generateAllSections('draft-1'),
      ),
    ).rejects.toThrow(/workspace-generation failed: 503/);
  });
});
