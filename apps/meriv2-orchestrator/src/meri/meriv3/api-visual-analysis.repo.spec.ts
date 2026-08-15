import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { ApiVisualAnalysisRepo } from './api-visual-analysis.repo.js';

function config(values: Record<string, string>) {
  return { get: jest.fn((key: string) => values[key]) };
}

describe('ApiVisualAnalysisRepo', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('checks the API-owned sandbox capability using the current user and impersonation context', async () => {
    const repo = new ApiVisualAnalysisRepo(
      config({ MERIV2_API_BASE_URL: 'https://api.internal/' }) as never,
    );
    const fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify({ visualAnalysis: { enabled: true } }), { status: 200 }),
    );
    global.fetch = fetchMock as typeof fetch;

    await expect(
      RequestCredentialsStore.run(
        { bearerToken: 'user-bearer', impersonateTenantId: 'tenant-impersonated' },
        () => repo.available(),
      ),
    ).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.internal/api/clio/v3/capabilities');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer user-bearer',
      'x-capiro-impersonate-tenant': 'tenant-impersonated',
      accept: 'application/json',
    });
    expect(init.headers).not.toHaveProperty('x-internal-service-secret');
  });

  test('availability fails closed on missing credentials, non-2xx, or malformed capability data', async () => {
    const repo = new ApiVisualAnalysisRepo(
      config({ MERIV2_API_BASE_URL: 'https://api.internal' }) as never,
    );
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
    await expect(repo.available()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-bearer' }, () => repo.available()),
    ).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ visualAnalysis: { enabled: 'true' } }), { status: 200 }),
    );
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-bearer' }, () => repo.available()),
    ).resolves.toBe(false);
  });

  test('forwards user, impersonation and strict internal service identity for execution', async () => {
    const repo = new ApiVisualAnalysisRepo(
      config({
        MERIV2_API_BASE_URL: 'https://api.internal/',
        INTERNAL_SERVICE_SECRET: 'service-secret',
        MERIV2_TOOL_TIMEOUT_MS: '60000',
      }) as never,
    );
    const fetchMock = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            results: { findings: { delta: -22.7 } },
            artifacts: [{ id: 'chart-1', kind: 'analysis_chart', persisted: true }],
          }),
          { status: 200 },
        ),
    );
    global.fetch = fetchMock as typeof fetch;

    await expect(
      RequestCredentialsStore.run(
        { bearerToken: 'user-bearer', impersonateTenantId: 'tenant-impersonated' },
        () =>
          repo.execute({
            conversationId: 'conversation-1',
            code: 'print(1)',
            datasets: [{ name: 'funding', rows: [{ amount: 1 }] }],
          }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        artifacts: [expect.objectContaining({ id: 'chart-1' })],
      }),
    );

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.internal/api/clio/v3/visual-analysis');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer user-bearer',
      'x-internal-service-secret': 'service-secret',
      'x-capiro-impersonate-tenant': 'tenant-impersonated',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      conversationId: 'conversation-1',
      code: 'print(1)',
      datasets: [{ name: 'funding', rows: [{ amount: 1 }] }],
    });
  });

  test('uses the same identity boundary to discard assurance-held visual artifacts', async () => {
    const repo = new ApiVisualAnalysisRepo(
      config({
        MERIV2_API_BASE_URL: 'https://api.internal',
        INTERNAL_SERVICE_SECRET: 'service-secret',
      }) as never,
    );
    const fetchMock = jest.fn(
      async () => new Response(JSON.stringify({ deleted: 1 }), { status: 200 }),
    );
    global.fetch = fetchMock as typeof fetch;

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-bearer' }, () =>
        repo.discard(['a1111111-1111-4111-8111-111111111111']),
      ),
    ).resolves.toEqual({ deleted: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.internal/api/clio/v3/visual-analysis/discard');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer user-bearer',
      'x-internal-service-secret': 'service-secret',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      artifactIds: ['a1111111-1111-4111-8111-111111111111'],
    });
  });

  test('fails before network access without a forwarded user bearer', async () => {
    const repo = new ApiVisualAnalysisRepo(
      config({
        MERIV2_API_BASE_URL: 'https://api.internal',
        INTERNAL_SERVICE_SECRET: 'service-secret',
      }) as never,
    );
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
    await expect(
      repo.execute({ conversationId: 'conversation-1', code: 'print(1)' }),
    ).rejects.toThrow('No forwarded credential available');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('fails before network access when the strict service secret is missing', async () => {
    const repo = new ApiVisualAnalysisRepo(
      config({ MERIV2_API_BASE_URL: 'https://api.internal' }) as never,
    );
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-bearer' }, () =>
        repo.execute({ conversationId: 'conversation-1', code: 'print(1)' }),
      ),
    ).rejects.toThrow('internal service identity is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('sanitizes an API failure to a bounded transport error', async () => {
    const repo = new ApiVisualAnalysisRepo(
      config({
        MERIV2_API_BASE_URL: 'https://api.internal',
        INTERNAL_SERVICE_SECRET: 'service-secret',
      }) as never,
    );
    global.fetch = jest.fn(
      async () =>
        new Response('provider body '.repeat(100), { status: 500, statusText: 'Server Error' }),
    ) as typeof fetch;

    await expect(
      RequestCredentialsStore.run({ bearerToken: 'user-bearer' }, () =>
        repo.execute({ conversationId: 'conversation-1', code: 'print(1)' }),
      ),
    ).rejects.toThrow(/Visual analysis failed: 500/);
  });
});
