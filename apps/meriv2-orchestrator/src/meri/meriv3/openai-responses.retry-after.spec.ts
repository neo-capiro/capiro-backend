import { OpenAiResponsesClient, parseRetryAfterMs } from './openai-responses.client.js';
import { resolveMeriV3ReasoningProfile } from './meriv3-reasoning.js';

const okBody = {
  id: 'resp_1',
  status: 'completed',
  model: 'gpt-6-astra',
  output: [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
  ],
  usage: { input_tokens: 10, output_tokens: 2 },
};

describe('parseRetryAfterMs', () => {
  const headers = (values: Record<string, string>) => new Headers(values);

  it('prefers retry-after-ms, then retry-after seconds or an HTTP date', () => {
    expect(parseRetryAfterMs(headers({ 'retry-after-ms': '1500' }))).toBe(1500);
    expect(parseRetryAfterMs(headers({ 'retry-after-ms': '20', 'retry-after': '9' }))).toBe(20);
    expect(parseRetryAfterMs(headers({ 'retry-after': '2' }))).toBe(2000);
    expect(parseRetryAfterMs(headers({ 'retry-after': '0.5' }))).toBe(500);
    const now = Date.parse('2026-10-05T12:00:00Z');
    expect(
      parseRetryAfterMs(headers({ 'retry-after': 'Mon, 05 Oct 2026 12:00:03 GMT' }), now),
    ).toBe(3000);
  });

  it('returns null when the provider gave no usable instruction', () => {
    expect(parseRetryAfterMs(headers({}))).toBeNull();
    expect(parseRetryAfterMs(headers({ 'retry-after': 'soon' }))).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });
});

describe('OpenAiResponsesClient honors Retry-After', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('waits the provider-requested time before retrying a 429', async () => {
    jest.useFakeTimers();
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchMock = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, headers: { 'retry-after': '4' } }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(okBody), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = new OpenAiResponsesClient().complete({
      profile: resolveMeriV3ReasoningProfile('standard', {}),
      instructions: 'Answer.',
      input: [],
      tools: [],
    });
    await jest.advanceTimersByTimeAsync(3_000);
    // The default back-off is under one second; the provider asked for four.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_100);
    await expect(result).resolves.toMatchObject({ model: 'gpt-6-astra' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails the attempt at once when Retry-After exceeds the turn deadline', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchMock = jest.fn(
      async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '3600' } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      new OpenAiResponsesClient().complete({
        profile: resolveMeriV3ReasoningProfile('standard', {}),
        instructions: 'Answer.',
        input: [],
        tools: [],
      }),
    ).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
