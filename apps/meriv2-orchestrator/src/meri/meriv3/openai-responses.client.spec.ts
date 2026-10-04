import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import {
  OpenAiResponsesClient,
  anthropicSchemaToResponsesTool,
  extractResponsesFunctionCalls,
  extractResponsesOutputText,
  parseOpenAiResponsesUsage,
  observedOpenAiResponsesUsage,
  readOpenAiResponsesErrorTelemetry,
} from './openai-responses.client.js';
import { resolveMeriV3ReasoningProfile } from './meriv3-reasoning.js';
import { MeriRunBudget } from './meriv3-run-budget.js';
import { createMeriTelemetryContext } from '@capiro/meriv2-core';
import {
  currentMeriTaskUsage,
  runWithMeriOrchestratorTelemetry,
} from '../../telemetry/meri-telemetry.runtime.js';

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

  test('returns unknown usage (null tokens) when provider does not report usage', () => {
    const responseWithoutUsage = {
      id: 'resp_no_usage',
      status: 'completed',
      model: 'gpt-5.6',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'bounded summary' }] },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Answer.' }],
        },
      ],
    };

    // When usage is missing, tokens are null (unknown) not zero
    const usage = observedOpenAiResponsesUsage(responseWithoutUsage as never);
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.cacheReadTokens).toBeNull();
    expect(usage.cacheCreationTokens).toBeNull();

    // Verify this distinguishes "no usage reported" from "usage of zero"
    const responseWithZeroUsage = {
      id: 'resp_zero_usage',
      status: 'completed',
      model: 'gpt-5.6',
      output: [],
      usage: { input_tokens: 0, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } },
    };
    const zeroUsage = observedOpenAiResponsesUsage(responseWithZeroUsage as never);
    expect(zeroUsage.inputTokens).toBe(0);
    expect(zeroUsage.outputTokens).toBe(0);
    expect(zeroUsage.cacheReadTokens).toBe(0);
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

  test.each([
    undefined,
    {},
    { input_tokens: null, output_tokens: '0' },
    { input_tokens: -1, output_tokens: 0.5 },
  ])('does not coerce missing or malformed observations into zero: %p', (usage) => {
    expect(observedOpenAiResponsesUsage({ usage } as never)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
    });
  });

  test.each([
    [undefined, 'unknown', null, null],
    [{ input_tokens: 7 }, 'partial', 7, null],
    [{ input_tokens: 0, output_tokens: 0 }, 'known', 0, 0],
  ])(
    'reports wire observations independently of legacy usage defaults: %p',
    async (usage, status, inputTokens, outputTokens) => {
      process.env.OPENAI_API_KEY = 'fixture-key';
      global.fetch = jest.fn(
        async () =>
          new Response(JSON.stringify({ ...responseBody, model: 'gpt-5.6-terra', usage }), {
            status: 200,
          }),
      ) as typeof fetch;
      const lines: string[] = [];
      await runWithMeriOrchestratorTelemetry(
        createMeriTelemetryContext({ tenantId: 'tenant', actorId: 'actor' }),
        (line) => lines.push(line),
        async () => {
          await new OpenAiResponsesClient().complete({
            profile: resolveMeriV3ReasoningProfile('standard', {}),
            instructions: 'private prompt',
            input: [],
            tools: [],
          });
          expect(currentMeriTaskUsage()).toMatchObject({
            status,
            inputTokens,
            outputTokens,
            knownEstimatedCostUsd: status === 'known' ? 0 : null,
          });
        },
      );
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).usage).toMatchObject({
        status,
        inputTokens,
        outputTokens,
        knownEstimatedCostUsd: status === 'known' ? 0 : null,
      });
      expect(lines.join('')).not.toContain('private prompt');
    },
  );

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

  test('reserves the actual wire output ceiling after model policy raises a smaller profile', async () => {
    process.env.OPENAI_API_KEY = 'unit-only-key';
    const reserve = jest.fn(async () => ({
      reservationId: 'unit-reservation',
      dispatchAllowed: true,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const budget = MeriRunBudget.fromToolRoundCeiling(
      10,
      {},
      {
        reserve,
        settle: jest.fn(async () => {}),
      },
    );
    const fetchMock = jest.fn(async (..._args: Parameters<typeof fetch>) => {
      expect(reserve).toHaveBeenCalledTimes(1);
      return new Response(JSON.stringify(responseBody), { status: 200 });
    });
    global.fetch = fetchMock as typeof fetch;
    const profile = resolveMeriV3ReasoningProfile('standard', {
      MERIV3_STANDARD_MAX_OUTPUT_TOKENS: '2048',
    });
    expect(profile.maxOutputTokens).toBe(2048);
    await new OpenAiResponsesClient().complete({
      profile,
      instructions: 'synthetic',
      input: [{ role: 'user', content: 'synthetic memory' }],
      tools: [],
      budget,
    });
    const wire = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(wire.max_output_tokens).toBe(8192);
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 8192 }));
  });

  test('keeps a tenant Sol request and its reservation within the configured output ceiling', async () => {
    const reserve = jest.fn(async () => ({
      reservationId: 'sol-reservation',
      dispatchAllowed: true,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const budget = MeriRunBudget.fromToolRoundCeiling(
      10,
      {},
      {
        reserve,
        settle: jest.fn(async () => {}),
      },
    );
    const fetchMock = jest.fn(async (..._args: Parameters<typeof fetch>) => {
      expect(reserve).toHaveBeenCalledTimes(1);
      return new Response(JSON.stringify({ ...responseBody, model: 'gpt-6.1-sol' }), {
        status: 200,
      });
    });
    global.fetch = fetchMock as typeof fetch;
    const profile = resolveMeriV3ReasoningProfile('standard', {
      MERIV3_STANDARD_MAX_OUTPUT_TOKENS: '2048',
    });
    const result = await RequestCredentialsStore.run(
      {
        bearerToken: 'unit-token',
        aiProvider: {
          provider: 'openai',
          apiKey: 'unit-key',
          model: 'gpt-6.1-sol',
          usedTenantKey: true,
          modelOverridden: true,
        },
      },
      () =>
        new OpenAiResponsesClient().complete({
          profile,
          instructions: 'Use evidence.',
          input: [{ role: 'user', content: 'Find the record.' }],
          tools: [
            {
              type: 'function',
              name: 'lookup',
              description: 'Lookup',
              parameters: { type: 'object', properties: {} },
            },
          ],
          budget,
        }),
    );
    const wire = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(wire).toMatchObject({ model: 'gpt-6.1-sol', max_output_tokens: 2048, store: false });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/responses');
    expect(wire.tools).toEqual([expect.objectContaining({ name: 'lookup' })]);
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-6.1-sol', maxOutputTokens: 2048 }),
    );
    expect(result.telemetry).toMatchObject({
      requestedModel: 'gpt-6.1-sol',
      effectiveModel: 'gpt-6.1-sol',
    });
    expect(profile.model).toBe('gpt-6-astra');
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
    const trace = createMeriTelemetryContext({
      tenantId: 'tenant-a',
      actorId: 'actor-a',
      conversationId: 'conversation-a',
    });
    const telemetryLines: string[] = [];
    let taskUsage: ReturnType<typeof currentMeriTaskUsage> | undefined;
    const result = await runWithMeriOrchestratorTelemetry(
      trace,
      (line) => telemetryLines.push(line),
      async () => {
        const completed = await client.complete({
          profile: resolveMeriV3ReasoningProfile('standard', {}),
          instructions: 'Meri instructions',
          input: [{ role: 'user', content: 'Help' }],
          tools: [],
        });
        taskUsage = currentMeriTaskUsage();
        return completed;
      },
    );
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
    const attempts = telemetryLines.map((line) => JSON.parse(line) as Record<string, any>);
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((event) => event.traceId))).toEqual(new Set([trace.traceId]));
    expect(attempts[0]).toMatchObject({
      name: 'meri.provider.attempt.finalized',
      provider: 'openai',
      outcome: 'error',
      usage: { status: 'unknown', knownEstimatedCostUsd: null, unknownAttempts: 1 },
    });
    expect(attempts[1]).toMatchObject({
      name: 'meri.provider.attempt.finalized',
      effectiveModel: 'gpt-5.6-terra',
      outcome: 'completed',
      usage: {
        status: 'known',
        inputTokens: 120,
        outputTokens: 45,
        knownEstimatedCostUsd: 0.0009750000000000001,
      },
    });
    expect(taskUsage).toMatchObject({
      status: 'partial',
      inputTokens: 120,
      outputTokens: 45,
      knownEstimatedCostUsd: 0.0009750000000000001,
      unknownAttempts: 1,
      owner: 'AiUsageEvent',
    });
    expect(telemetryLines.join('\n')).not.toContain('Meri instructions');
    expect(telemetryLines.join('\n')).not.toContain('Help');
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
import { createMeriOtelRuntime } from '@capiro/meriv2-core/observability/otel';
import { setMeriOtelRuntime } from '../../telemetry/meri-telemetry.runtime.js';

test('actual provider retries export distinct sibling attempt spans without request payloads', async () => {
  const savedFetch = global.fetch;
  const savedKey = process.env.OPENAI_API_KEY;
  const spans: any[] = [];
  const sdk = createMeriOtelRuntime({
    serviceName: 'provider-owner-test',
    exporter: {
      export: (batch, done) => {
        spans.push(...batch);
        done({ code: 0 });
      },
      shutdown: async () => {},
    },
  });
  await setMeriOtelRuntime(sdk);
  process.env.OPENAI_API_KEY = 'PRIVATE_PROVIDER_KEY';
  let attempts = 0;
  global.fetch = jest.fn(async () =>
    ++attempts === 1
      ? new Response('{"error":{"message":"temporary capacity"}}', { status: 503 })
      : new Response(JSON.stringify(responseBody), { status: 200 }),
  ) as typeof fetch;
  try {
    await runWithMeriOrchestratorTelemetry(
      createMeriTelemetryContext({ tenantId: 'tenant', actorId: 'actor' }),
      () => {},
      async () => {
        await new OpenAiResponsesClient().complete({
          profile: resolveMeriV3ReasoningProfile('standard', {}),
          instructions: 'PRIVATE_PROMPT_SECRET',
          input: [],
          tools: [],
        });
      },
    );
    await sdk.forceFlush();
    const providers = spans.filter((span) => span.name === 'meri.orchestrator_provider');
    expect(providers).toHaveLength(2);
    expect(providers[0].spanContext().spanId).not.toBe(providers[1].spanContext().spanId);
    expect(providers[0].parentSpanContext.spanId).toBe(providers[1].parentSpanContext.spanId);
    expect(providers.map((span) => span.attributes['meri.attempt'])).toEqual([1, 2]);
    expect(providers.map((span) => span.status.code)).toEqual([2, 1]);
    expect(providers[0].attributes['meri.usage.status']).toBe('unknown');
    const serialized = JSON.stringify(
      providers.map((span) => ({
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );
    expect(serialized).not.toContain('PRIVATE_PROMPT_SECRET');
    expect(serialized).not.toContain('PRIVATE_PROVIDER_KEY');
    expect(serialized).not.toContain('Grounded answer.');
  } finally {
    global.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    await setMeriOtelRuntime(undefined);
  }
});
