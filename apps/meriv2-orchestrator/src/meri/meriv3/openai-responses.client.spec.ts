import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import {
  OpenAiResponsesClient,
  anthropicSchemaToResponsesTool,
  extractResponsesFunctionCalls,
  extractResponsesOutputText,
  parseOpenAiResponsesUsage,
  readOpenAiResponsesErrorTelemetry,
} from './openai-responses.client.js';
import { resolveMeriV3ReasoningProfile } from './meriv3-reasoning.js';
import { MeriRunBudget } from './meriv3-run-budget.js';

const responseBody = {
  id: 'resp_1',
  status: 'completed',
  model: 'gpt-5.6',
  output: [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'bounded summary' }] },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Grounded answer.' }],
    },
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'search_memory',
      arguments: '{"query":"Kestrel"}',
    },
  ],
  usage: {
    input_tokens: 120,
    output_tokens: 45,
    input_tokens_details: { cached_tokens: 20 },
  },
};

describe('OpenAiResponsesClient', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('parses text, function calls and usage without exposing reasoning text', () => {
    expect(extractResponsesOutputText(responseBody.output as never)).toBe('Grounded answer.');
    expect(extractResponsesFunctionCalls(responseBody.output as never)).toEqual([
      expect.objectContaining({ call_id: 'call_1', name: 'search_memory' }),
    ]);
    expect(parseOpenAiResponsesUsage(responseBody)).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 20,
      cacheCreationTokens: 0,
    });
  });

  test('returns provider refusal prose but never the reasoning summary', () => {
    const output = [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'private reasoning' }] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'I cannot help with that request.' }],
      },
    ];
    expect(extractResponsesOutputText(output as never)).toBe('I cannot help with that request.');
    expect(extractResponsesOutputText(output as never)).not.toContain('private reasoning');
  });

  test('sends store=false, native reasoning effort and developer function tools', async () => {
    process.env.OPENAI_API_KEY = 'global-openai-key';
    const fetchMock = jest.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    global.fetch = fetchMock as typeof fetch;
    const client = new OpenAiResponsesClient();
    const result = await client.complete({
      profile: resolveMeriV3ReasoningProfile('deep', {}),
      instructions: 'Meri instructions',
      input: [{ role: 'user', content: 'Help' }],
      tools: [
        anthropicSchemaToResponsesTool({
          name: 'search_memory',
          description: 'Search memory',
          input_schema: { type: 'object', properties: { query: { type: 'string' } } },
        }),
      ],
      safetyIdentifier: 'safe-user-hash',
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const sent = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({
      model: 'gpt-6-astra',
      store: false,
      parallel_tool_calls: true,
      max_output_tokens: 24576,
      reasoning: { effort: 'high', summary: 'auto' },
      safety_identifier: 'safe-user-hash',
    });
    expect(result.outputText).toBe('Grounded answer.');
    expect(result.usedTenantKey).toBe(false);
    expect(result.telemetry.effectiveReasoningEffort).toBe('high');
  });

  test('retries once without reasoning when the provider rejects reasoning.effort, then succeeds', async () => {
    process.env.OPENAI_API_KEY = 'global-openai-key';
    const rejection = JSON.stringify({
      error: {
        message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
      },
    });
    const fetchMock = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(new Response(rejection, { status: 400 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...responseBody, model: 'gpt-5.6-terra' }), { status: 200 }),
      );
    global.fetch = fetchMock as typeof fetch;
    const client = new OpenAiResponsesClient();
    const result = await client.complete({
      profile: resolveMeriV3ReasoningProfile('standard', {}),
      instructions: 'Meri instructions',
      input: [{ role: 'user', content: 'Help' }],
      tools: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstSent = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    const secondSent = JSON.parse(
      String((fetchMock.mock.calls[1]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(firstSent).toHaveProperty('reasoning');
    expect(secondSent).not.toHaveProperty('reasoning');
    expect(result.outputText).toBe('Grounded answer.');
    expect(result.telemetry).toMatchObject({
      requestedReasoningEffort: 'medium',
      effectiveReasoningEffort: null,
      effectiveModel: 'gpt-5.6-terra',
      reasoningFallbackReasons: ['reasoning_parameter_unsupported'],
    });
  });

  test('does not retry indefinitely if the provider keeps rejecting reasoning.effort', async () => {
    process.env.OPENAI_API_KEY = 'global-openai-key';
    const rejection = JSON.stringify({
      error: {
        message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
      },
    });
    const fetchMock = jest.fn(async () => new Response(rejection, { status: 400 }));
    global.fetch = fetchMock as typeof fetch;
    const client = new OpenAiResponsesClient();
    await expect(
      client.complete({
        profile: resolveMeriV3ReasoningProfile('standard', {}),
        instructions: 'Meri instructions',
        input: [{ role: 'user', content: 'Help' }],
        tools: [],
      }),
    ).rejects.toThrow(/reasoning\.effort/i);
    // Exactly one retry for the reasoning-param correction, regardless of MAX_RETRIES.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('shares the turn retry ceiling with provider compatibility retries', async () => {
    process.env.OPENAI_API_KEY = 'global-openai-key';
    const rejection = JSON.stringify({
      error: {
        message: "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
      },
    });
    const fetchMock = jest.fn(async () => new Response(rejection, { status: 400 }));
    global.fetch = fetchMock as typeof fetch;
    const budget = new MeriRunBudget({
      maxModelCalls: 4,
      maxToolCalls: 4,
      maxRetryCalls: 0,
      synthesisModelCallReserve: 1,
      noProgressLaps: 3,
      maxCyclePeriod: 4,
    });

    await expect(
      new OpenAiResponsesClient().complete({
        profile: resolveMeriV3ReasoningProfile('standard', {}),
        instructions: 'Meri instructions',
        input: [{ role: 'user', content: 'Help' }],
        tools: [],
        budget,
        budgetPhase: 'acquisition',
      }),
    ).rejects.toThrow('retry_calls');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(budget.snapshot()).toMatchObject({
      modelCalls: 1,
      retryCalls: 0,
      acquisitionStopped: true,
      stopReason: 'retry_calls',
    });
  });

  test('omits every tool field for the final tool-free synthesis request', async () => {
    process.env.OPENAI_API_KEY = 'global-openai-key';
    const fetchMock = jest.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify({ ...responseBody, output: responseBody.output.slice(0, 2) }), {
          status: 200,
        }),
    );
    global.fetch = fetchMock as typeof fetch;
    const client = new OpenAiResponsesClient();
    await client.complete({
      profile: resolveMeriV3ReasoningProfile('standard', {}),
      instructions: 'finish',
      input: [{ role: 'user', content: 'finish' }],
      tools: [],
      toolChoice: 'none',
    });
    const sent = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(sent).not.toHaveProperty('tools');
    expect(sent).not.toHaveProperty('tool_choice');
    expect(sent).not.toHaveProperty('parallel_tool_calls');
  });

  test('uses an explicit tenant model override but not the resolver default model', async () => {
    const seenModels: string[] = [];
    global.fetch = jest.fn(async (_url, init) => {
      const sent = JSON.parse(String(init?.body)) as { model: string };
      seenModels.push(sent.model);
      return new Response(JSON.stringify(responseBody), { status: 200 });
    }) as typeof fetch;
    const client = new OpenAiResponsesClient();
    const profile = resolveMeriV3ReasoningProfile('standard', { MERIV3_MODEL: 'capiro-model' });

    const defaultResult = await RequestCredentialsStore.run(
      {
        bearerToken: 'token',
        aiProvider: {
          provider: 'openai',
          apiKey: 'tenant-key',
          model: 'resolver-default',
          usedTenantKey: true,
          modelOverridden: false,
        },
      },
      () =>
        client.complete({
          profile,
          instructions: 'x',
          input: [{ role: 'user', content: 'x' }],
          tools: [],
        }),
    );
    const overrideResult = await RequestCredentialsStore.run(
      {
        bearerToken: 'token',
        aiProvider: {
          provider: 'openai',
          apiKey: 'tenant-key',
          model: 'tenant-selected-model',
          usedTenantKey: true,
          modelOverridden: true,
        },
      },
      () =>
        client.complete({
          profile,
          instructions: 'x',
          input: [{ role: 'user', content: 'x' }],
          tools: [],
        }),
    );
    expect(seenModels).toEqual(['capiro-model', 'tenant-selected-model']);
    expect(defaultResult.telemetry.requestedModel).toBe('capiro-model');
    expect(overrideResult.telemetry).toMatchObject({
      requestedModel: 'tenant-selected-model',
      effectiveModel: 'gpt-5.6',
    });
  });

  test.each([
    ['incomplete', 'max_output_tokens', true],
    ['failed', null, true],
    ['completed', null, false],
  ])('reports provider finish status %s truthfully', async (status, reason, partial) => {
    process.env.OPENAI_API_KEY = 'test-key';
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...responseBody,
            status,
            incomplete_details: reason ? { reason } : null,
          }),
          { status: 200 },
        ),
    ) as typeof fetch;
    const result = await new OpenAiResponsesClient().complete({
      profile: resolveMeriV3ReasoningProfile('deep', {}),
      instructions: 'Answer.',
      input: [],
      tools: [],
    });
    expect(result.telemetry).toMatchObject({ finishReason: reason ?? status, partial });
  });

  test('does not reset the deadline for a provider reasoning correction', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    let clock = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const rejection = JSON.stringify({
      error: { message: "Unsupported value 'max' for reasoning effort." },
    });
    global.fetch = jest.fn(
      async () =>
        ({
          ok: false,
          status: 400,
          text: async () => rejection,
        }) as Response,
    ) as typeof fetch;
    // The first attempt finishes just before the deadline; processing consumes
    // the remaining budget. A correction must not start a fresh timeout window.
    jest.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      clock = 1_101;
      return { error: { message: "Unsupported value 'max' for reasoning effort." } };
    });
    let failure: unknown;
    try {
      await new OpenAiResponsesClient().complete({
        profile: resolveMeriV3ReasoningProfile('max', {}),
        instructions: 'Answer.',
        input: [],
        tools: [],
        deadlineAt: 1_100,
      });
    } catch (error) {
      failure = error;
    }
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(readOpenAiResponsesErrorTelemetry(failure)).toMatchObject({
      reasoningFallbackReasons: ['max_unsupported'],
      finishReason: 'deadline_exceeded',
      partial: true,
    });
  });

  test('does not extract or return function calls when response status is incomplete', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    const incompleteResponse = JSON.stringify({
      id: 'resp-incomplete',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      model: 'gpt-5.6',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'bounded summary' }] },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Partial answer.' }],
        },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'search_memory',
          arguments: '{\"query\":\"Kestrel\"}',
        },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 45,
        input_tokens_details: { cached_tokens: 20 },
      },
    });
    global.fetch = jest.fn(
      async () => new Response(incompleteResponse, { status: 200 }),
    ) as typeof fetch;
    const result = await new OpenAiResponsesClient().complete({
      profile: resolveMeriV3ReasoningProfile('deep', {}),
      instructions: 'Answer.',
      input: [],
      tools: [],
    });
    expect(result.status).toBe('incomplete');
    expect(result.telemetry.partial).toBe(true);
    expect(result.telemetry.finishReason).toBe('max_output_tokens');
    expect(result.functionCalls).toEqual([]);
    expect(result.outputText).toBe('Partial answer.');
  });

  test.each([
    [
      'an incomplete function-call item',
      { ...responseBody.output[2], status: 'incomplete' },
      'incomplete_function_call',
    ],
    [
      'malformed function-call arguments',
      { ...responseBody.output[2], status: 'completed', arguments: '{"query":' },
      'malformed_function_call',
    ],
  ])(
    'rejects every call in a completed response containing %s',
    async (_label, invalidCall, reason) => {
      process.env.OPENAI_API_KEY = 'test-key';
      global.fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...responseBody,
              output: [
                { ...responseBody.output[2], call_id: 'call-valid', status: 'completed' },
                invalidCall,
              ],
            }),
            { status: 200 },
          ),
      ) as typeof fetch;

      const result = await new OpenAiResponsesClient().complete({
        profile: resolveMeriV3ReasoningProfile('deep', {}),
        instructions: 'Answer.',
        input: [],
        tools: [],
      });

      expect(result.functionCalls).toEqual([]);
      expect(result.telemetry).toMatchObject({ finishReason: reason, partial: true });
    },
  );

  test('cancels retry backoff immediately and does not start another request', async () => {
    jest.useFakeTimers();
    process.env.OPENAI_API_KEY = 'test-key';
    const controller = new AbortController();
    global.fetch = jest.fn(
      async () => new Response('Temporary failure', { status: 503 }),
    ) as typeof fetch;
    const result = new OpenAiResponsesClient().complete({
      profile: resolveMeriV3ReasoningProfile('deep', {}),
      instructions: 'Answer.',
      input: [],
      tools: [],
      signal: controller.signal,
    });
    const rejection = expect(result).rejects.toMatchObject({
      name: 'AbortError',
      telemetry: { finishReason: 'cancelled', partial: true },
    });
    await jest.advanceTimersByTimeAsync(1);
    controller.abort();
    await rejection;
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
