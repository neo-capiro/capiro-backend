import { MeriV2ChatClient, type MeriV2ChatStreamEvent } from './meriv2-chat.client.js';

/** Fake streaming body: yields the given chunks, then done. */
function streamBody(chunks: string[]) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () =>
        i < chunks.length
          ? { done: false as const, value: new TextEncoder().encode(chunks[i++]) }
          : { done: true as const, value: undefined },
    }),
  };
}

const originalFetch = global.fetch;
const originalUrl = process.env.MERIV2_ORCHESTRATOR_URL;
afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.MERIV2_ORCHESTRATOR_URL;
  else process.env.MERIV2_ORCHESTRATOR_URL = originalUrl;
  jest.restoreAllMocks();
});

function makeClient(): MeriV2ChatClient {
  process.env.MERIV2_ORCHESTRATOR_URL = 'http://orch.test/';
  return new MeriV2ChatClient();
}

describe('MeriV2ChatClient.streamChat', () => {
  it('POSTs to /meri-api/chat/stream with bearer + BYOK header and parses frames across chunk boundaries', async () => {
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: streamBody([
        'data: {"type":"start"}\n\ndata: {"type":"text","te',
        'xt":"Hello"}\n\nnot-a-frame\ndata: {broken json}\n',
        'data: {"type":"done","reply":"Hello","steps":[]}\n\n',
      ]),
    }));
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;

    const events: MeriV2ChatStreamEvent[] = [];
    await makeClient().streamChat({
      bearerToken: 'jwt-123',
      input: { messages: [{ role: 'user', text: 'hi' }], conversationId: 'c1' },
      aiProvider: {
        provider: 'anthropic',
        apiKey: 'sk-tenant',
        model: 'm',
        usedTenantKey: true,
        modelOverridden: false,
      },
      onEvent: (e) => events.push(e),
    });

    // Frame split mid-JSON reassembles; garbage lines are skipped silently.
    expect(events.map((e) => e.type)).toEqual(['start', 'text', 'done']);
    expect(events[1]).toMatchObject({ type: 'text', text: 'Hello' });

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://orch.test/meri-api/chat/stream');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer jwt-123');
    expect(JSON.parse(headers['x-capiro-ai-provider'] ?? '{}')).toMatchObject({
      provider: 'anthropic',
      usedTenantKey: true,
    });
    expect(JSON.parse(String(init.body))).toMatchObject({ conversationId: 'c1' });
  });

  it('omits the BYOK header when no credential resolved (global-key fallback downstream)', async () => {
    const fetchSpy = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: streamBody(['data: {"type":"done","reply":"","steps":[]}\n\n']),
    }));
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;

    await makeClient().streamChat({
      bearerToken: 'jwt',
      input: { messages: [{ role: 'user', text: 'hi' }] },
      onEvent: () => {},
    });
    const headers = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers['x-capiro-ai-provider']).toBeUndefined();
  });

  it('throws on a non-2xx response (no silent fallback — rollback is the flag)', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      body: null,
    }));
    await expect(
      makeClient().streamChat({
        bearerToken: 'jwt',
        input: { messages: [{ role: 'user', text: 'hi' }] },
        onEvent: () => {},
      }),
    ).rejects.toThrow(/503/);
  });

  it('requires the caller bearer and a configured orchestrator URL', async () => {
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;

    await expect(
      makeClient().streamChat({
        bearerToken: '',
        input: { messages: [] },
        onEvent: () => {},
      }),
    ).rejects.toThrow(/bearer/);

    delete process.env.MERIV2_ORCHESTRATOR_URL;
    const unconfigured = new MeriV2ChatClient();
    expect(unconfigured.configured).toBe(false);
    await expect(
      unconfigured.streamChat({
        bearerToken: 'jwt',
        input: { messages: [] },
        onEvent: () => {},
      }),
    ).rejects.toThrow(/MERIV2_ORCHESTRATOR_URL/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
