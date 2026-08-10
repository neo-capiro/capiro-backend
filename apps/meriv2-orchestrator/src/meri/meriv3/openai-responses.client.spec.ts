import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import {
  OpenAiResponsesClient,
  anthropicSchemaToResponsesTool,
  extractResponsesFunctionCalls,
  extractResponsesOutputText,
  parseOpenAiResponsesUsage,
} from './openai-responses.client.js';
import { resolveMeriV3ReasoningProfile } from './meriv3-reasoning.js';

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
      model: 'gpt-5.6',
      store: false,
      parallel_tool_calls: true,
      max_output_tokens: 24576,
      reasoning: { effort: 'high', summary: 'auto' },
      safety_identifier: 'safe-user-hash',
    });
    expect(result.outputText).toBe('Grounded answer.');
    expect(result.usedTenantKey).toBe(false);
  });

  test('omits the reasoning parameter for Standard (Terra), which rejects it', async () => {
    process.env.OPENAI_API_KEY = 'global-openai-key';
    const fetchMock = jest.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify({ ...responseBody, model: 'gpt-5.6-terra' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    global.fetch = fetchMock as typeof fetch;
    const client = new OpenAiResponsesClient();
    await client.complete({
      profile: resolveMeriV3ReasoningProfile('standard', {}),
      instructions: 'Meri instructions',
      input: [{ role: 'user', content: 'Help' }],
      tools: [],
    });
    const sent = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(sent.model).toBe('gpt-5.6-terra');
    expect(sent).not.toHaveProperty('reasoning');
  });

  test('omits the reasoning parameter for Fast (Luna), which rejects it', async () => {
    process.env.OPENAI_API_KEY = 'global-openai-key';
    const fetchMock = jest.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(JSON.stringify({ ...responseBody, model: 'gpt-5.6-luna' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    global.fetch = fetchMock as typeof fetch;
    const client = new OpenAiResponsesClient();
    await client.complete({
      profile: resolveMeriV3ReasoningProfile('fast', {}),
      instructions: 'Meri instructions',
      input: [{ role: 'user', content: 'Help' }],
      tools: [],
    });
    const sent = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(sent.model).toBe('gpt-5.6-luna');
    expect(sent).not.toHaveProperty('reasoning');
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

    await RequestCredentialsStore.run(
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
    await RequestCredentialsStore.run(
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
  });
});
