import { MeriV3ChatClient } from './meriv3-chat.client.js';

function sseResponse(frames: unknown[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('MeriV3ChatClient', () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.MERIV2_ORCHESTRATOR_URL;

  beforeEach(() => {
    process.env.MERIV2_ORCHESTRATOR_URL = 'https://app.capiro.test';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.MERIV2_ORCHESTRATOR_URL;
    else process.env.MERIV2_ORCHESTRATOR_URL = originalUrl;
    jest.restoreAllMocks();
  });

  test('posts the reasoning mode and parses frames across the V3 route', async () => {
    const fetchMock = jest.fn(async () =>
      sseResponse([
        { type: 'runtime', runtime: 'meriv3', model: 'gpt-5.1', reasoningMode: 'deep' },
        { type: 'text', text: 'Answer' },
        {
          type: 'done',
          runtime: 'meriv3',
          model: 'gpt-5.1',
          reasoningMode: 'deep',
          reasoningEffort: 'high',
          reply: 'Answer',
          steps: [],
        },
      ]),
    );
    global.fetch = fetchMock as typeof fetch;
    const client = new MeriV3ChatClient();
    const events: unknown[] = [];
    await client.streamChat({
      bearerToken: 'bearer',
      input: {
        messages: [{ role: 'user', text: 'Analyze this' }],
        reasoningMode: 'deep',
      },
      aiProvider: {
        provider: 'openai',
        apiKey: 'resolved-key',
        model: 'gpt-5.1',
        usedTenantKey: false,
        modelOverridden: false,
      },
      onEvent: (event) => events.push(event),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.capiro.test/meri-api/v3/chat/stream',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual(
      expect.objectContaining({ authorization: 'Bearer bearer' }),
    );
    expect(JSON.parse(String(init.body))).toMatchObject({ reasoningMode: 'deep' });
    expect(events).toHaveLength(3);
  });

  test('fails before the network without the caller bearer', async () => {
    global.fetch = jest.fn() as typeof fetch;
    const client = new MeriV3ChatClient();
    await expect(
      client.streamChat({
        bearerToken: '',
        input: { messages: [], reasoningMode: 'standard' },
        onEvent: () => {},
      }),
    ).rejects.toThrow('requires the caller bearer token');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('refuses an Anthropic credential instead of misrouting it to OpenAI', async () => {
    const client = new MeriV3ChatClient();
    await expect(
      client.streamChat({
        bearerToken: 'bearer',
        input: { messages: [], reasoningMode: 'standard' },
        aiProvider: {
          provider: 'anthropic',
          apiKey: 'anthropic-key',
          model: 'claude',
          usedTenantKey: true,
          modelOverridden: true,
        },
        onEvent: () => {},
      }),
    ).rejects.toThrow('requires an OpenAI credential');
  });
});
