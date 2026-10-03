import { withTrustedCurrentTurnScope } from '../request/trusted-current-turn-scope.js';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';
import { OpenAiResponsesClient } from './meriv3/openai-responses.client.js';
import { resolveMeriV3ReasoningProfile } from './meriv3/meriv3-reasoning.js';
import { MeriRunBudget, stableProviderOperationId } from './meriv3/meriv3-run-budget.js';
import { RequestScopedLlmClient } from './request-scoped-llm.client.js';

const capture = <T>(fn: () => T) =>
  withTrustedCurrentTurnScope(
    {
      tenantId: 'unit-tenant',
      userId: 'unit-user',
      conversationId: 'unit-chat',
      selectedClientId: 'unit-client',
      capturePolicy: {
        expectedCaptureWrites: [
          'user_message',
          'assistant_message',
          'capture_evidence',
          'provider_budget_ledger',
        ],
      } as never,
    },
    fn,
  );
const wire = {
  model: 'gpt-6-astra',
  store: false,
  max_output_tokens: 8192,
  input: [{ role: 'user', content: 'unit text' }],
};
const response = () =>
  new Response(
    JSON.stringify({
      id: 'unit-response',
      model: 'gpt-6-astra',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '{"ok":true}' }],
        },
        { type: 'function_call', call_id: 'unit-call', name: 'result', arguments: '{"ok":true}' },
      ],
      usage: { input_tokens: 23, output_tokens: 8 },
    }),
    { status: 200 },
  );
function accounting() {
  const reserve = jest.fn(async (_binding: unknown) => ({
    reservationId: 'unit-reservation',
    dispatchAllowed: true,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  const settle = jest.fn(async () => {});
  return {
    reserve,
    settle,
    budget: MeriRunBudget.fromToolRoundCeiling(
      10,
      { deadlineAt: Date.now() + 60_000 },
      { reserve, settle },
    ),
  };
}
const originalFetch = global.fetch;
const originalKey = process.env.OPENAI_API_KEY;
afterEach(() => {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalKey;
});

test.each([true, false])(
  'native Responses capture=%s sets default tier only for capture before byte reservation',
  async (scoped) => {
    process.env.OPENAI_API_KEY = 'unit-only-key';
    const a = accounting();
    const fetcher = jest.fn(async (..._args: Parameters<typeof fetch>) => response());
    global.fetch = fetcher;
    const run = () =>
      new OpenAiResponsesClient().complete({
        profile: resolveMeriV3ReasoningProfile('standard', {}),
        instructions: 'unit',
        input: wire.input,
        tools: [],
        budget: a.budget,
      });
    await (scoped ? capture(run) : run());
    const init = fetcher.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body)).service_tier).toBe(scoped ? 'default' : undefined);
    expect(a.reserve).toHaveBeenCalledTimes(1);
    expect(a.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        maxInputTokens: Buffer.byteLength(String(init.body)),
        maxOutputTokens: JSON.parse(String(init.body)).max_output_tokens,
      }),
    );
  },
);

test.each([
  { service_tier: 'priority' },
  { service_tier: 'auto' },
  { service_tier: 'flex' },
  {
    input: [
      { role: 'user', content: [{ type: 'input_image', image_url: 'https://unit.invalid/x' }] },
    ],
  },
  { input: [{ role: 'user', content: [{ type: 'input_audio', data: 'unit' }] }] },
  { input: [{ type: 'item_reference', id: 'external-item' }] },
  { tools: [{ type: 'web_search' }] },
  { tool_choice: { type: 'web_search' } },
  { tools: [{ type: 'code_interpreter', container: { type: 'auto' } }] },
  { previous_response_id: 'external-response' },
  { conversation: 'external-conversation' },
  {
    input: [
      {
        type: 'function_call_output',
        call_id: 'unit',
        output: [{ type: 'input_file', file_id: 'external-file' }],
      },
    ],
  },
])('capture refuses unsupported priced units before reservation or fetch: %j', async (override) => {
  const a = accounting();
  const fetcher = jest.fn(async () => response());
  await expect(
    capture(() =>
      a.budget.budgetedFetch('repair', fetcher)('https://api.openai.com/v1/responses', {
        method: 'POST',
        body: JSON.stringify({ ...wire, ...override }),
      }),
    ),
  ).rejects.toThrow('meri_capture_provider_wire');
  expect(fetcher).not.toHaveBeenCalled();
  expect(a.reserve).not.toHaveBeenCalled();
});

test.each([
  'https://proxy.invalid/v1/responses',
  'https://api.openai.com/v1/chat/completions',
  'https://api.openai.com/v1/responses?region=other',
])('capture refuses unqualified endpoint %s before reservation', async (url) => {
  const a = accounting();
  const fetcher = jest.fn(async () => response());
  await expect(
    capture(() =>
      a.budget.budgetedFetch('selection', fetcher)(url, {
        method: 'POST',
        body: JSON.stringify(wire),
      }),
    ),
  ).rejects.toThrow('meri_capture_provider_wire');
  expect(fetcher).not.toHaveBeenCalled();
  expect(a.reserve).not.toHaveBeenCalled();
});

test('capture allows inline text, function and reasoning replay; binds normalized final body', async () => {
  const a = accounting();
  const fetcher = jest.fn(async (..._args: Parameters<typeof fetch>) => response());
  const body = {
    ...wire,
    tools: [{ type: 'function', name: 'unit', parameters: { type: 'object' } }],
    input: [
      ...wire.input,
      {
        type: 'reasoning',
        id: 'unit-reasoning',
        summary: [{ type: 'summary_text', text: 'unit' }],
        encrypted_content: 'unit-inline-reasoning',
      },
      { type: 'function_call', call_id: 'unit-call', name: 'unit', arguments: '{}' },
      { type: 'function_call_output', call_id: 'unit-call', output: 'unit text' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'unit', annotations: [] }],
      },
    ],
  };
  const before = JSON.stringify(body);
  await capture(() =>
    a.budget.budgetedFetch('repair', fetcher)('https://api.openai.com/v1/responses', {
      method: 'POST',
      body: before,
    }),
  );
  const sent = fetcher.mock.calls[0]![1]!;
  expect(JSON.stringify(body)).toBe(before);
  expect(JSON.parse(String(sent.body)).service_tier).toBe('default');
  expect(sent.redirect).toBe('error');
  expect(a.reserve).toHaveBeenCalledWith(
    expect.objectContaining({
      logicalOperationId: stableProviderOperationId('provider-fetch', {
        url: 'https://api.openai.com/v1/responses',
        method: 'POST',
        body: sent.body,
        phase: 'repair',
      }),
      maxInputTokens: Buffer.byteLength(String(sent.body)),
      maxOutputTokens: 8192,
    }),
  );
});

test('ordinary budgeted fetch preserves custom endpoint, premium tier and multimodal body', async () => {
  const a = accounting();
  const fetcher = jest.fn(async (..._args: Parameters<typeof fetch>) => response());
  const init = {
    method: 'POST',
    body: JSON.stringify({
      ...wire,
      service_tier: 'priority',
      input: [{ type: 'input_image', image_url: 'unit' }],
    }),
  };
  await a.budget.budgetedFetch('repair', fetcher)('https://proxy.invalid/v1/responses', init);
  expect(fetcher.mock.calls[0]![1]!.body).toBe(init.body);
  expect(fetcher.mock.calls[0]![1]!.redirect).toBeUndefined();
});

test.each(['schema', 'json'] as const)(
  'capture core %s reserves prepared output8192 and final bytes once per retry',
  async (method) => {
    const a = accounting();
    const fetcher = jest
      .fn<Promise<Response>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(new Response('{"error":{"message":"rate limited"}}', { status: 429 }))
      .mockImplementation(async () => response());
    global.fetch = fetcher;
    const client = new RequestScopedLlmClient('unit-key', 'gpt-6-astra', 5000);
    await capture(() =>
      RequestCredentialsStore.run(
        {
          bearerToken: 'unit-token',
          aiProvider: {
            provider: 'openai',
            apiKey: 'unit-key',
            model: 'gpt-6-astra',
            usedTenantKey: true,
            modelOverridden: false,
          },
        },
        () => {
          const bounded = client.withProviderBudget(a.budget, 'repair', 'unit-repair');
          const params = { system: 'unit', prompt: 'unit', maxTokens: 512 };
          return method === 'json'
            ? bounded.completeJson(params)
            : bounded.completeWithSchema!({
                ...params,
                toolName: 'result',
                toolDescription: 'unit',
                inputSchema: { type: 'object' },
              });
        },
      ),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(a.reserve).toHaveBeenCalledTimes(2);
    expect(a.settle).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 2; i++) {
      const body = String(fetcher.mock.calls[i]![1]!.body);
      expect(JSON.parse(body)).toMatchObject({ service_tier: 'default', max_output_tokens: 8192 });
      expect(a.reserve.mock.calls[i]![0]).toMatchObject({
        kind: 'openai_responses',
        provider: 'openai',
        model: 'gpt-6-astra',
        maxInputTokens: Buffer.byteLength(body),
        maxOutputTokens: 8192,
      });
    }
    expect(a.settle.mock.calls.at(-1)).toEqual([
      expect.anything(),
      { kind: 'known', inputTokens: 23, outputTokens: 8 },
    ]);
    expect(a.reserve.mock.calls[1]![0]).toMatchObject({
      retryOfAttemptId: (a.reserve.mock.calls[0]![0] as { attemptId: string }).attemptId,
    });
  },
);

test('capture Typesafe JEV remains unqualified by OpenAI rates, with no provider fetch', async () => {
  const a = accounting();
  a.reserve.mockRejectedValueOnce(new Error('meri_capture_provider_budget_price_unknown'));
  const fetcher = jest.fn(async () => response());
  await expect(
    capture(() =>
      a.budget.budgetedFetch('selection', fetcher)('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        body: '{"model":"jev-1.13.0"}',
      }),
    ),
  ).rejects.toThrow('price_unknown');
  expect(a.reserve).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'jev', provider: 'jev', model: 'jev-1.13.0' }),
  );
  expect(fetcher).not.toHaveBeenCalled();
});

test('native Responses refuses image input before either reservation or fetch', async () => {
  process.env.OPENAI_API_KEY = 'unit-only-key';
  const a = accounting();
  const fetcher = jest.fn(async () => response());
  global.fetch = fetcher;
  await expect(
    capture(() =>
      new OpenAiResponsesClient().complete({
        profile: resolveMeriV3ReasoningProfile('standard', {}),
        instructions: 'unit',
        input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'unit' }] }],
        tools: [],
        budget: a.budget,
      }),
    ),
  ).rejects.toThrow('meri_capture_provider_wire');
  expect(a.reserve).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([undefined, 0, -1, 1.5])(
  'capture rejects invalid final output ceiling %s before reservation',
  async (max_output_tokens) => {
    const a = accounting();
    const fetcher = jest.fn(async () => response());
    await expect(
      capture(() =>
        a.budget.budgetedFetch('repair', fetcher)('https://api.openai.com/v1/responses', {
          method: 'POST',
          body: JSON.stringify({ ...wire, max_output_tokens }),
        }),
      ),
    ).rejects.toThrow('meri_capture_provider_wire');
    expect(a.reserve).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  },
);

test('capture core fallback reserves each actual prepared provider wire without duplicate outer reservations', async () => {
  const a = accounting();
  const fetcher = jest
    .fn<Promise<Response>, Parameters<typeof fetch>>()
    .mockResolvedValueOnce(
      new Response('{"error":{"message":"insufficient credit"}}', { status: 402 }),
    )
    .mockImplementation(async () => response());
  global.fetch = fetcher;
  const client = new RequestScopedLlmClient('unit-primary', 'claude-sonnet-5', 5000, {
    provider: 'openai',
    apiKey: 'unit-fallback',
    model: 'gpt-6-astra',
  });
  await capture(() =>
    client.withProviderBudget(a.budget, 'repair', 'unit-fallback').completeWithSchema!({
      system: 'unit',
      prompt: 'unit',
      maxTokens: 512,
      toolName: 'result',
      toolDescription: 'unit',
      inputSchema: { type: 'object' },
    }),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(a.reserve).toHaveBeenCalledTimes(2);
  expect(a.settle).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 2; i++) {
    const body = String(fetcher.mock.calls[i]![1]!.body);
    const parsed = JSON.parse(body);
    expect(a.reserve.mock.calls[i]![0]).toMatchObject({
      model: parsed.model,
      maxInputTokens: Buffer.byteLength(body),
      maxOutputTokens: parsed.max_output_tokens ?? parsed.max_tokens,
    });
  }
  expect(a.reserve.mock.calls[0]![0]).toMatchObject({
    kind: 'anthropic_messages',
    provider: 'anthropic',
  });
  expect(a.reserve.mock.calls[1]![0]).toMatchObject({
    kind: 'openai_responses',
    provider: 'openai',
    maxOutputTokens: 8192,
  });
  expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body)).service_tier).toBe('default');
});

test('capture core unpriced configured provider fails before dispatch and does not silently choose fallback', async () => {
  const a = accounting();
  a.reserve.mockRejectedValueOnce(new Error('meri_capture_provider_budget_price_unknown'));
  const fetcher = jest.fn(async () => response());
  global.fetch = fetcher;
  const client = new RequestScopedLlmClient('unit-primary', 'claude-sonnet-5', 5000, {
    provider: 'openai',
    apiKey: 'unit-fallback',
    model: 'gpt-6-astra',
  });
  await expect(
    capture(() =>
      client
        .withProviderBudget(a.budget, 'repair', 'unit-unpriced')
        .completeJson({ system: 'unit', prompt: 'unit' }),
    ),
  ).rejects.toThrow('price_unknown');
  expect(a.reserve).toHaveBeenCalledTimes(1);
  expect(a.settle).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

test('capture core refuses an unbudgeted completion before provider dispatch', async () => {
  const fetcher = jest.fn(async () => response());
  global.fetch = fetcher;
  await expect(
    capture(() =>
      new RequestScopedLlmClient('unit', 'gpt-6-astra').completeJson({
        system: 'unit',
        prompt: 'unit',
      }),
    ),
  ).rejects.toThrow('meri_capture_provider_wire_budget_missing');
  expect(fetcher).not.toHaveBeenCalled();
});

test('ordinary core budget keeps prior request shape and accounting behavior', async () => {
  const a = accounting();
  const fetcher = jest.fn(async (..._args: Parameters<typeof fetch>) => response());
  global.fetch = fetcher;
  const client = new RequestScopedLlmClient('unit', 'gpt-6-astra', 5000);
  await RequestCredentialsStore.run(
    {
      bearerToken: 'unit',
      aiProvider: {
        provider: 'openai',
        apiKey: 'unit',
        model: 'gpt-6-astra',
        usedTenantKey: true,
        modelOverridden: false,
      },
    },
    () =>
      client
        .withProviderBudget(a.budget, 'repair', 'ordinary')
        .completeJson({ system: 'unit', prompt: 'unit', maxTokens: 512 }),
  );
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).service_tier).toBeUndefined();
  expect(a.reserve).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 512 }));
  expect(a.settle.mock.calls.at(-1)).toEqual([expect.anything(), { kind: 'uncertain' }]);
});
