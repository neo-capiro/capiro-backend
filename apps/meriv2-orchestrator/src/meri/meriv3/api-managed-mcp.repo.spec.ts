import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { ApiManagedMcpRepo } from './api-managed-mcp.repo.js';

const HUBSPOT_SEARCH = 'mcp__meriv3_hubspot__search_contacts';
const AIRTABLE_SEARCH = 'mcp__meriv3_airtable__search_records';

function config(values: Record<string, string>) {
  return {
    get: jest.fn((key: string) => values[key]),
  };
}

describe('ApiManagedMcpRepo', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('no user bearer means no managed schemas and no network call', async () => {
    const repo = new ApiManagedMcpRepo(
      config({ MERIV2_API_BASE_URL: 'https://api.internal' }) as never,
    );
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
    await expect(repo.schemas()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('schema discovery forwards user identity but not the internal write identity', async () => {
    const repo = new ApiManagedMcpRepo(
      config({
        MERIV2_API_BASE_URL: 'https://api.internal/',
        INTERNAL_SERVICE_SECRET: 'service-secret',
      }) as never,
    );
    const fetchMock = jest.fn(async () =>
      new Response(
        JSON.stringify({
          schemas: [
            {
              name: HUBSPOT_SEARCH,
              description: 'Search contacts',
              input_schema: { type: 'object' },
              source: 'managed_mcp',
              appId: 'hubspot',
              appName: 'HubSpot',
              readOnly: true,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    global.fetch = fetchMock as typeof fetch;

    const result = await RequestCredentialsStore.run(
      { bearerToken: 'user-bearer', impersonateTenantId: 'tenant-impersonated' },
      () => repo.schemas(),
    );
    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.internal/api/clio/v3/mcp-tool-schemas',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer user-bearer',
          'x-capiro-impersonate-tenant': 'tenant-impersonated',
        }),
      }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).not.toHaveProperty('x-internal-service-secret');
  });

  test('execution carries bearer, impersonation and service identity', async () => {
    const repo = new ApiManagedMcpRepo(
      config({
        MERIV2_API_BASE_URL: 'https://api.internal',
        INTERNAL_SERVICE_SECRET: 'service-secret',
        MERIV2_TOOL_TIMEOUT_MS: '60000',
      }) as never,
    );
    const fetchMock = jest.fn(async () =>
      new Response(JSON.stringify({ contacts: [{ id: '123' }] }), { status: 200 }),
    );
    global.fetch = fetchMock as typeof fetch;

    await expect(
      RequestCredentialsStore.run(
        { bearerToken: 'user-bearer', impersonateTenantId: 'tenant-impersonated' },
        () => repo.executeRead(HUBSPOT_SEARCH, { query: 'Acme' }),
      ),
    ).resolves.toEqual({ contacts: [{ id: '123' }] });

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe(`https://api.internal/api/clio/v3/mcp-tools/${HUBSPOT_SEARCH}`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer user-bearer',
      'x-internal-service-secret': 'service-secret',
      'x-capiro-impersonate-tenant': 'tenant-impersonated',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({ query: 'Acme' });
  });

  test('execution fails before network access when no user bearer is present', async () => {
    const repo = new ApiManagedMcpRepo(
      config({ MERIV2_API_BASE_URL: 'https://api.internal' }) as never,
    );
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
    await expect(repo.executeRead(AIRTABLE_SEARCH, {})).rejects.toThrow(
      'No forwarded credential available',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
