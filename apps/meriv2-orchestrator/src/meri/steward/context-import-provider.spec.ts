import { RequestScopedLlmClient } from '../request-scoped-llm.client.js';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';

const PARAMS = {
  system: 'Source-only extraction',
  messages: [{ role: 'user' as const, content: 'Source facts' }],
  tools: [{ name: 'extract', description: 'Extract', input_schema: { type: 'object' } }],
  maxTokens: 32,
  toolChoice: { type: 'tool' as const, name: 'extract' },
};

function anthropicResponse() {
  return {
    ok: true,
    json: async () => ({
      content: [{ type: 'tool_use', id: 'tu_1', name: 'extract', input: {} }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  } as Response;
}

function openAiResponse() {
  return {
    ok: true,
    json: async () => ({
      choices: [
        {
          message: {
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'extract', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
  } as Response;
}

afterEach(() => jest.restoreAllMocks());

describe('context import responding provider and credential scope', () => {
  it('reports the actual Anthropic provider even for a custom model alias', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(anthropicResponse());
    const client = new RequestScopedLlmClient('fake-global', 'custom-alias');
    const response = await client.completeWithTools(PARAMS);
    expect(response.provider).toBe('anthropic');
    expect(response.model).toBe('custom-alias');
    expect(fetch.mock.calls[0]?.[0]).toContain('anthropic.com');
  });

  it('uses the scoped tenant OpenAI credential and reports its provider', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(openAiResponse());
    const client = new RequestScopedLlmClient('fake-global', 'default-model');
    const response = await RequestCredentialsStore.run(
      {
        bearerToken: 'test-bearer',
        aiProvider: {
          provider: 'openai',
          apiKey: 'fake-tenant',
          model: 'custom-tenant-alias',
          usedTenantKey: true,
          modelOverridden: true,
        },
      },
      () => client.completeWithTools(PARAMS),
    );
    expect(response.provider).toBe('openai');
    expect(response.usedTenantKey).toBe(true);
    expect(response.model).toBe('custom-tenant-alias');
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer fake-tenant',
    });
    expect(RequestCredentialsStore.get()).toBeUndefined();
  });

  it('records the fallback provider after a global primary failure', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 402,
        text: async () => 'payment required',
      } as Response)
      .mockResolvedValueOnce(openAiResponse());
    const client = new RequestScopedLlmClient('fake-global', 'primary-model', 1000, {
      apiKey: 'fake-fallback',
      model: 'fallback-model',
      provider: 'openai',
    });
    const response = await client.completeWithTools(PARAMS);
    expect(response.provider).toBe('openai');
    expect(response.model).toBe('fallback-model');
    expect(response.usedTenantKey).toBe(false);
  });
});
