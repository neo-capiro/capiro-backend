import { OpenAiResponsesClient } from './openai-responses.client.js';
import { resolveMeriV3ReasoningProfile } from './meriv3-reasoning.js';

const completedBody = {
  id: 'resp_max',
  status: 'completed',
  model: 'gpt-5.6',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Completed with supported reasoning.' }],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 5 },
};

function requestBody(call: unknown): { reasoning: { effort: string } } {
  const init = (call as [unknown, RequestInit | undefined] | undefined)?.[1];
  return JSON.parse(String(init?.body)) as { reasoning: { effort: string } };
}

describe('OpenAiResponsesClient reasoning effort fallback', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    jest.restoreAllMocks();
  });

  test('sends max for Max when the configured model accepts it', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchMock = jest.fn(async () =>
      new Response(JSON.stringify(completedBody), { status: 200 }),
    );
    global.fetch = fetchMock as typeof fetch;

    await new OpenAiResponsesClient().complete({
      profile: resolveMeriV3ReasoningProfile('max', {}),
      instructions: 'Research deeply.',
      input: [{ role: 'user', content: 'Build a strategy.' }],
      tools: [],
    });

    const request = requestBody(fetchMock.mock.calls[0]);
    expect(request.reasoning.effort).toBe('max');
  });

  test('retries Max with xhigh instead of disabling reasoning when max is unsupported', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const rejection = JSON.stringify({
      error: {
        message:
          "Unsupported value: 'max' for reasoning.effort with this model. Allowed values include 'xhigh' and 'high'.",
      },
    });
    const fetchMock = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(new Response(rejection, { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(completedBody), { status: 200 }));
    global.fetch = fetchMock as typeof fetch;

    const result = await new OpenAiResponsesClient().complete({
      profile: resolveMeriV3ReasoningProfile('max', {}),
      instructions: 'Research deeply.',
      input: [{ role: 'user', content: 'Build a strategy.' }],
      tools: [],
    });

    const first = requestBody(fetchMock.mock.calls[0]);
    const second = requestBody(fetchMock.mock.calls[1]);
    expect(first.reasoning.effort).toBe('max');
    expect(second.reasoning.effort).toBe('xhigh');
    expect(result.outputText).toBe('Completed with supported reasoning.');
  });

  test('continues from max to xhigh to high when the BYOK model supports only high', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const maxRejection = JSON.stringify({
      error: { message: "The reasoning effort value 'max' is not supported by this model." },
    });
    const xhighRejection = JSON.stringify({
      error: { message: "The reasoning effort value 'xhigh' is not supported by this model." },
    });
    const fetchMock = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(new Response(maxRejection, { status: 400 }))
      .mockResolvedValueOnce(new Response(xhighRejection, { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(completedBody), { status: 200 }));
    global.fetch = fetchMock as typeof fetch;

    const result = await new OpenAiResponsesClient().complete({
      profile: resolveMeriV3ReasoningProfile('max', {}),
      instructions: 'Research deeply.',
      input: [{ role: 'user', content: 'Build a strategy.' }],
      tools: [],
    });

    const efforts = fetchMock.mock.calls.map((call) => requestBody(call).reasoning.effort);
    expect(efforts).toEqual(['max', 'xhigh', 'high']);
    expect(result.outputText).toBe('Completed with supported reasoning.');
  });
});
