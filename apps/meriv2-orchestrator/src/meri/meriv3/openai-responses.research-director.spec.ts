import { MeriV3ResearchRuntimeStore } from './meriv3-research-runtime.store.js';
import { OpenAiResponsesClient } from './openai-responses.client.js';
import { resolveMeriV3ReasoningProfile } from './meriv3-reasoning.js';

function messageResponse(text: string, id: string) {
  return {
    id,
    status: 'completed',
    model: 'gpt-5.6',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 1 } },
  };
}

function toolResponse() {
  return {
    id: 'resp-tool',
    status: 'completed',
    model: 'gpt-5.6',
    output: [
      {
        type: 'function_call',
        call_id: 'call-research',
        name: 'research_federal_market_strategy',
        arguments: '{"entity":"Kinetic Industries"}',
      },
    ],
    usage: { input_tokens: 8, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
  };
}

function requestBody(call: unknown): Record<string, unknown> {
  const init = (call as [unknown, RequestInit | undefined] | undefined)?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe('OpenAI Responses Research Director runtime', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    jest.restoreAllMocks();
  });

  test('forces the exact high-level research recipe on the first tools-bearing request', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify(toolResponse()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    global.fetch = fetchMock as typeof fetch;
    const client = new OpenAiResponsesClient();

    const result = await MeriV3ResearchRuntimeStore.run(
      {
        forcedFirstTool: 'research_federal_market_strategy',
        criticInstructions: 'critic',
        synthesisInstructions: 'synthesis',
      },
      () =>
        client.complete({
          profile: resolveMeriV3ReasoningProfile('deep', {}),
          instructions: 'research',
          input: [{ role: 'user', content: 'Build a strategy' }],
          tools: [
            {
              type: 'function',
              name: 'research_federal_market_strategy',
              description: 'Research',
              parameters: { type: 'object', properties: {} },
            },
          ],
          toolChoice: 'auto',
        }),
    );

    const sent = requestBody(fetchMock.mock.calls[0]);
    expect(sent.tool_choice).toEqual({
      type: 'function',
      name: 'research_federal_market_strategy',
    });
    expect(result.functionCalls[0]?.name).toBe('research_federal_market_strategy');
  });

  test('runs a hidden critic and replaces the draft with artifact-quality synthesis', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const responses = [
      messageResponse('Initial grounded draft.', 'resp-draft'),
      messageResponse(
        '{"missingSections":["Congressional strategy"],"unsupportedClaims":[],"contradictions":[],"overlookedLanes":["OTA consortium"],"requiredCaveats":[],"synthesisPriorities":["Add acquisition access"]}',
        'resp-critic',
      ),
      messageResponse('Final comprehensive strategy.', 'resp-final'),
    ];
    const fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify(responses.shift()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    global.fetch = fetchMock as typeof fetch;
    const client = new OpenAiResponsesClient();

    const result = await MeriV3ResearchRuntimeStore.run(
      {
        forcedFirstTool: 'research_federal_market_strategy',
        criticInstructions: 'Run the silent senior-reviewer audit.',
        synthesisInstructions: 'Write the final artifact-quality strategy.',
      },
      async () => {
        // Simulate the first tool-bearing round having already consumed the
        // forced recipe. This call represents the next no-function draft round.
        expect(MeriV3ResearchRuntimeStore.consumeForcedFirstTool()).toBe(
          'research_federal_market_strategy',
        );
        return client.complete({
          profile: resolveMeriV3ReasoningProfile('deep', {}),
          instructions: 'base instructions',
          input: [
            { role: 'user', content: 'Build a comprehensive federal strategy' },
            {
              type: 'function_call_output',
              call_id: 'call-research',
              output: '{"coverageGate":{"readyForSynthesis":true}}',
            },
          ],
          tools: [
            {
              type: 'function',
              name: 'research_federal_market_strategy',
              description: 'Research',
              parameters: { type: 'object', properties: {} },
            },
          ],
          toolChoice: 'auto',
          timeoutMs: 120_000,
        });
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const criticRequest = requestBody(fetchMock.mock.calls[1]);
    const synthesisRequest = requestBody(fetchMock.mock.calls[2]);
    expect(criticRequest.instructions).toContain('silent senior-reviewer audit');
    expect(criticRequest).not.toHaveProperty('tools');
    expect(synthesisRequest.instructions).toContain('artifact-quality strategy');
    expect(synthesisRequest).not.toHaveProperty('tools');
    expect(JSON.stringify(synthesisRequest.input)).toContain('Congressional strategy');
    expect(result.outputText).toBe('Final comprehensive strategy.');
    expect(result.usage).toEqual({
      inputTokens: 30,
      outputTokens: 15,
      cacheReadTokens: 3,
      cacheCreationTokens: 0,
    });
    expect(result.providerCalls).toHaveLength(3);
    expect(result.providerCalls?.every((call) => call.finishReason === 'completed')).toBe(true);
    expect(result.telemetry).toMatchObject({ finishReason: 'completed', partial: false });
  });

  test('rejects an incomplete critic before synthesis and returns a qualified closed draft', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const incompleteCritic = {
      ...messageResponse('PARTIAL CRITIC MUST NOT REACH SYNTHESIS', 'resp-critic-incomplete'),
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    };
    const responses = [
      messageResponse('Closed grounded draft.', 'resp-draft'),
      incompleteCritic,
      messageResponse('Synthesis must not run.', 'resp-final'),
    ];
    const requests: Record<string, unknown>[] = [];
    global.fetch = jest.fn(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await MeriV3ResearchRuntimeStore.run(
      {
        forcedFirstTool: 'research_federal_market_strategy',
        criticInstructions: 'Run the silent senior-reviewer audit.',
        synthesisInstructions: 'Write the final artifact-quality strategy.',
      },
      () =>
        new OpenAiResponsesClient().complete({
          profile: resolveMeriV3ReasoningProfile('deep', {}),
          instructions: 'Research.',
          input: [],
          tools: [],
          timeoutMs: 120_000,
        }),
    );

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain('PARTIAL CRITIC MUST NOT REACH SYNTHESIS');
    expect(result.outputText).toContain('Closed grounded draft.');
    expect(result.outputText).toContain('Research finalization was incomplete');
    expect(result.outputText).not.toContain('PARTIAL CRITIC');
    expect(result.telemetry).toMatchObject({
      finishReason: 'research_finalization_failed',
      partial: true,
    });
    expect(result.providerCalls).toHaveLength(2);
  });

  test('does not release the draft as a completed answer when Stop interrupts finalization', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const controller = new AbortController();
    const fetchMock = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(messageResponse('Draft.', 'draft')), { status: 200 }),
      )
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new DOMException('Aborted', 'AbortError');
      });
    global.fetch = fetchMock as typeof fetch;

    await expect(
      MeriV3ResearchRuntimeStore.run(
        {
          forcedFirstTool: 'research_federal_market_strategy',
          criticInstructions: 'Review.',
          synthesisInstructions: 'Synthesize.',
        },
        () =>
          new OpenAiResponsesClient().complete({
            profile: resolveMeriV3ReasoningProfile('deep', {}),
            instructions: 'Research.',
            input: [],
            tools: [],
            timeoutMs: 120_000,
            signal: controller.signal,
          }),
      ),
    ).rejects.toMatchObject({
      name: 'AbortError',
      telemetry: { finishReason: 'cancelled', partial: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('marks a released draft partial and keeps critic usage when final synthesis fails', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    global.fetch = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(messageResponse('Draft.', 'draft')), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(messageResponse('Review.', 'critic')), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: 'Invalid synthesis.' } }), { status: 400 }),
      ) as typeof fetch;

    const result = await MeriV3ResearchRuntimeStore.run(
      {
        forcedFirstTool: 'research_federal_market_strategy',
        criticInstructions: 'Review.',
        synthesisInstructions: 'Synthesize.',
      },
      () =>
        new OpenAiResponsesClient().complete({
          profile: resolveMeriV3ReasoningProfile('deep', {}),
          instructions: 'Research.',
          input: [],
          tools: [],
          timeoutMs: 120_000,
        }),
    );
    expect(result.outputText).toContain('Draft.');
    expect(result.outputText).toContain('Research finalization was incomplete');
    expect(result.telemetry).toMatchObject({
      finishReason: 'research_finalization_failed',
      partial: true,
    });
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
    expect(result.providerCalls).toHaveLength(3);
    expect(result.providerCalls?.[2]).toMatchObject({
      finishReason: 'provider_http_400',
      effectiveReasoningEffort: null,
      partial: true,
    });
  });
});
