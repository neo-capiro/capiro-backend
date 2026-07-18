import type { Request } from 'express';
import {
  RequestScopedLlmClient,
  parseAnthropicToolStream,
  classifyLlmError,
} from './request-scoped-llm.client';
import { parseAiProviderHeader } from './meri.controller';
import {
  RequestCredentialsStore,
  type ResolvedAiProvider,
} from '../request/request-credentials.store';

/**
 * BYOK2 — the orchestrator LLM credential resolution order:
 *   tenant credential on the request (option c) > global env key > throw.
 * The Anthropic HTTP call is intercepted via global.fetch to assert which key
 * and model actually reach the wire — key material itself is never logged.
 */

const anthropicOk = {
  ok: true,
  status: 200,
  json: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
};

function mockFetch() {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  (global as unknown as { fetch: unknown }).fetch = jest.fn(
    async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return anthropicOk;
    },
  );
  return calls;
}

const originalFetch = global.fetch;
afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = originalFetch;
  jest.restoreAllMocks();
});

const tenantCred: ResolvedAiProvider = {
  provider: 'anthropic',
  apiKey: 'sk-tenant-abc',
  model: 'claude-tenant-model',
  usedTenantKey: true,
  modelOverridden: false,
};

describe('RequestScopedLlmClient (BYOK2 resolution order)', () => {
  it('uses the tenant key from the request scope, keeping the orchestrator default model when not overridden', async () => {
    const calls = mockFetch();
    const client = new RequestScopedLlmClient('sk-global', 'claude-default');
    const out = await RequestCredentialsStore.run(
      { bearerToken: 't', aiProvider: tenantCred },
      () => client.completeJson({ system: 's', prompt: 'p' }),
    );
    expect(out).toEqual({ ok: true });
    expect(calls[0]?.headers['x-api-key']).toBe('sk-tenant-abc');
    expect(calls[0]?.body.model).toBe('claude-default'); // modelOverridden=false → default wins
  });

  it("honors the tenant's explicit model override", async () => {
    const calls = mockFetch();
    const client = new RequestScopedLlmClient('sk-global', 'claude-default');
    await RequestCredentialsStore.run(
      { bearerToken: 't', aiProvider: { ...tenantCred, modelOverridden: true } },
      () => client.completeJson({ system: 's', prompt: 'p' }),
    );
    expect(calls[0]?.headers['x-api-key']).toBe('sk-tenant-abc');
    expect(calls[0]?.body.model).toBe('claude-tenant-model');
  });

  it('falls back to the global env key when no tenant credential is on the request', async () => {
    const calls = mockFetch();
    const client = new RequestScopedLlmClient('sk-global', 'claude-default');
    await RequestCredentialsStore.run({ bearerToken: 't' }, () =>
      client.completeJson({ system: 's', prompt: 'p' }),
    );
    expect(calls[0]?.headers['x-api-key']).toBe('sk-global');
    expect(calls[0]?.body.model).toBe('claude-default');
  });

  it('falls back to the global key outside any request scope (no ALS store)', async () => {
    const calls = mockFetch();
    const client = new RequestScopedLlmClient('sk-global', 'claude-default');
    await client.completeJson({ system: 's', prompt: 'p' });
    expect(calls[0]?.headers['x-api-key']).toBe('sk-global');
  });

  it('throws when neither a tenant credential nor a global key exists', async () => {
    mockFetch();
    const client = new RequestScopedLlmClient(undefined, 'claude-default');
    await expect(client.completeJson({ system: 's', prompt: 'p' })).rejects.toThrow(
      /No LLM credential available/,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('RequestScopedLlmClient.completeWithTools (tool-use round)', () => {
  const toolUseResponse = {
    ok: true,
    status: 200,
    json: async () => ({
      content: [
        { type: 'text', text: 'looking that up' },
        { type: 'tool_use', id: 'tu_1', name: 'search_congress_bills', input: { q: 'ndaa' } },
      ],
      stop_reason: 'tool_use',
    }),
  };
  function mockToolFetch() {
    const calls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (_url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({ headers: init.headers, body: JSON.parse(init.body) });
        return toolUseResponse;
      },
    );
    return calls;
  }

  const tools = [
    { name: 'search_congress_bills', description: 'x', input_schema: { type: 'object' } },
  ];

  it('sends system+messages+tools on the tenant key and returns content + stopReason', async () => {
    const calls = mockToolFetch();
    const client = new RequestScopedLlmClient('sk-global', 'claude-default');
    const out = await RequestCredentialsStore.run(
      { bearerToken: 't', aiProvider: tenantCred },
      () =>
        client.completeWithTools({
          system: 'sys',
          messages: [{ role: 'user', content: 'find bills' }],
          tools,
          maxTokens: 1024,
        }),
    );
    expect(out.stopReason).toBe('tool_use');
    expect(out.content).toHaveLength(2);
    expect(calls[0]?.headers['x-api-key']).toBe('sk-tenant-abc');
    expect(calls[0]?.body.model).toBe('claude-default');
    expect(calls[0]?.body.tools).toEqual(tools);
    expect(calls[0]?.body.system).toBe('sys');
  });

  it('falls back to the global key with no tenant credential', async () => {
    const calls = mockToolFetch();
    const client = new RequestScopedLlmClient('sk-global', 'claude-default');
    await client.completeWithTools({ system: 's', messages: [], tools, maxTokens: 10 });
    expect(calls[0]?.headers['x-api-key']).toBe('sk-global');
  });

  it('throws on a non-2xx response (caller degrades)', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 529,
      text: async () => 'overloaded',
    }));
    const client = new RequestScopedLlmClient('sk-global', 'claude-default');
    await expect(
      client.completeWithTools({ system: 's', messages: [], tools, maxTokens: 10 }),
    ).rejects.toThrow(/Anthropic HTTP 529/);
  });

  it('throws with no credential and never calls fetch', async () => {
    mockToolFetch();
    const client = new RequestScopedLlmClient(undefined, 'claude-default');
    await expect(
      client.completeWithTools({ system: 's', messages: [], tools, maxTokens: 10 }),
    ).rejects.toThrow(/No LLM credential available/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // 4.5.1: an OpenAI credential routes the round through the Chat Completions
  // adapter — Anthropic-shaped in/out, so the loop drivers never change.
  it('runs the round on OpenAI for an openai credential (translated both ways)', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(
      async (url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content: 'checking',
                  tool_calls: [
                    {
                      id: 'call_9',
                      type: 'function',
                      function: { name: 'search_congress_bills', arguments: '{"q":"ndaa"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          }),
        };
      },
    );
    const client = new RequestScopedLlmClient('sk-global', 'claude-default');
    const out = await RequestCredentialsStore.run(
      {
        bearerToken: 't',
        aiProvider: {
          ...tenantCred,
          provider: 'openai' as const,
          model: 'gpt-x',
          modelOverridden: true,
        },
      },
      () =>
        client.completeWithTools({
          system: 'sys',
          messages: [
            { role: 'user', content: 'find bills' },
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'on it' },
                {
                  type: 'tool_use',
                  id: 'call_1',
                  name: 'search_congress_bills',
                  input: { q: 'x' },
                },
              ],
            },
            {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"rows":[]}' }],
            },
          ],
          tools,
          maxTokens: 512,
        }),
    );
    // Request went to OpenAI on the tenant key, Anthropic wire translated out.
    expect(calls[0]!.url).toContain('api.openai.com');
    expect(calls[0]!.headers.Authorization).toBe('Bearer sk-tenant-abc');
    const msgs = calls[0]!.body.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'sys' });
    expect(msgs[2]).toMatchObject({
      role: 'assistant',
      content: 'on it',
      tool_calls: [{ id: 'call_1', function: { name: 'search_congress_bills' } }],
    });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"rows":[]}' });
    expect(calls[0]!.body.tools[0].function.name).toBe('search_congress_bills');
    // Response translated back into Anthropic shape.
    expect(out.stopReason).toBe('tool_use');
    expect(out.content).toEqual([
      { type: 'text', text: 'checking' },
      { type: 'tool_use', id: 'call_9', name: 'search_congress_bills', input: { q: 'ndaa' } },
    ]);
    expect(out.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(out.usedTenantKey).toBe(true);
  });

  // 2.2: the OpenAI tool-loop translation carries only text + tool_result blocks,
  // so an image block would be silently dropped. Fail loud instead of answering
  // as if no image was sent.
  it('fails loud on image content for an OpenAI credential (vision unsupported)', async () => {
    const fetchSpy = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchSpy;
    const client = new RequestScopedLlmClient('sk-global', 'claude-default');
    await expect(
      RequestCredentialsStore.run(
        { bearerToken: 't', aiProvider: { ...tenantCred, provider: 'openai' as const } },
        () =>
          client.completeWithTools({
            system: 'sys',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
                  },
                  { type: 'text', text: 'what does this show?' },
                ],
              },
            ],
            tools,
            maxTokens: 128,
          }),
      ),
    ).rejects.toThrow(/vision.*not supported/i);
    expect(fetchSpy).not.toHaveBeenCalled(); // never reached the OpenAI API
  });
});

describe('classifyLlmError (resilience classification)', () => {
  it('credit/quota exhaustion → failover, NOT retry (the 2026-07-15 outage class)', () => {
    expect(
      classifyLlmError(
        new Error('Anthropic HTTP 400: {"error":{"message":"credit balance too low"}}'),
      ),
    ).toEqual({ retryable: false, failover: true });
    expect(classifyLlmError(new Error('insufficient_quota'))).toEqual({
      retryable: false,
      failover: true,
    });
    expect(classifyLlmError(new Error('OpenAI HTTP 402: payment required'))).toEqual({
      retryable: false,
      failover: true,
    });
  });
  it('overload / 5xx → retryable + failover', () => {
    expect(classifyLlmError(new Error('Anthropic HTTP 529: overloaded'))).toEqual({
      retryable: true,
      failover: true,
    });
    expect(classifyLlmError(new Error('Anthropic HTTP 503'))).toEqual({
      retryable: true,
      failover: true,
    });
    expect(classifyLlmError(new Error('OpenAI HTTP 429'))).toEqual({
      retryable: true,
      failover: true,
    });
  });
  it('network errors → retryable + failover', () => {
    expect(classifyLlmError(new Error('fetch failed')).failover).toBe(true);
    expect(classifyLlmError(new Error('read ECONNRESET')).retryable).toBe(true);
  });
  it('non-credit 4xx / unknown → neither (do not retry or failover)', () => {
    expect(classifyLlmError(new Error('Anthropic HTTP 400: invalid request'))).toEqual({
      retryable: false,
      failover: false,
    });
    expect(classifyLlmError(new Error('boom'))).toEqual({ retryable: false, failover: false });
  });
  it('recognizes the meriv2-core "request failed (NNN)" shape (completeJson/completeWithSchema path)', () => {
    // AnthropicLlmClient/OpenAiLlmClient throw "<Provider> request failed (NNN): ..."
    // (no "HTTP" prefix) — the status must still classify or reasoning-tool
    // failover would silently only catch credit-balance text.
    expect(classifyLlmError(new Error('Anthropic request failed (529): overloaded'))).toEqual({
      retryable: true,
      failover: true,
    });
    expect(classifyLlmError(new Error('OpenAI request failed (503): upstream'))).toEqual({
      retryable: true,
      failover: true,
    });
    expect(classifyLlmError(new Error('Anthropic request failed (400): bad'))).toEqual({
      retryable: false,
      failover: false,
    });
  });
});

describe('RequestScopedLlmClient reasoning-tool resilience (completeJson / completeWithSchema)', () => {
  it('retries the SAME provider on a transient overload and then succeeds (completeJson)', async () => {
    let n = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      n += 1;
      if (n === 1) return { ok: false, status: 529, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
      };
    });
    const client = new RequestScopedLlmClient('sk-global', 'claude-default');
    const out = await client.completeJson({ system: 's', prompt: 'p' });
    expect(out).toEqual({ ok: true });
    expect(n).toBe(2); // one retry, same provider
  });

  it('fails a GLOBAL-key credit error over to the global OpenAI fallback (completeJson)', async () => {
    const urls: string[] = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('anthropic')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: 'credit balance too low' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
      };
    });
    const client = new RequestScopedLlmClient('sk-global-anthropic', 'claude-default', undefined, {
      apiKey: 'sk-global-openai',
      model: 'gpt-x',
      provider: 'openai',
    });
    const out = await client.completeJson({ system: 's', prompt: 'p' });
    expect(out).toEqual({ ok: true });
    expect(urls.some((u) => u.includes('anthropic'))).toBe(true);
    expect(urls.some((u) => u.includes('openai'))).toBe(true);
  });

  it('does NOT fail a tenant BYOK key over to the global account (completeJson)', async () => {
    const urls: string[] = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      urls.push(url);
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'credit balance too low' } }),
      };
    });
    const client = new RequestScopedLlmClient('sk-global-anthropic', 'claude-default', undefined, {
      apiKey: 'sk-global-openai',
      model: 'gpt-x',
      provider: 'openai',
    });
    await expect(
      RequestCredentialsStore.run({ bearerToken: 't', aiProvider: tenantCred }, () =>
        client.completeJson({ system: 's', prompt: 'p' }),
      ),
    ).rejects.toThrow(/credit balance/);
    expect(urls.every((u) => u.includes('anthropic'))).toBe(true); // never crossed to OpenAI
  });

  it('fails a GLOBAL-key quota error over to the fallback (completeWithSchema)', async () => {
    const urls: string[] = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('anthropic')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: 'insufficient_quota' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: { tool_calls: [{ function: { name: 'extract', arguments: '{"v":1}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      };
    });
    const client = new RequestScopedLlmClient('sk-global-anthropic', 'claude-default', undefined, {
      apiKey: 'sk-global-openai',
      model: 'gpt-x',
      provider: 'openai',
    });
    const out = await client.completeWithSchema({
      system: 's',
      prompt: 'p',
      toolName: 'extract',
      toolDescription: 'd',
      inputSchema: { type: 'object' },
    });
    expect(out.input).toEqual({ v: 1 });
    expect(urls.some((u) => u.includes('openai'))).toBe(true);
  });

  it('is inert without a configured fallback (completeJson unchanged)', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'credit balance too low' } }),
    }));
    const client = new RequestScopedLlmClient('sk-global', 'claude-default'); // no fallback
    await expect(client.completeJson({ system: 's', prompt: 'p' })).rejects.toThrow(
      /credit balance/,
    );
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1); // credit err not retried, no fallback
  });
});

describe('RequestScopedLlmClient resilience (retry + BYOK-safe failover)', () => {
  const tools = [
    { name: 'search_congress_bills', description: 'x', input_schema: { type: 'object' } },
  ];

  it('retries the SAME provider on a transient overload and then succeeds', async () => {
    let n = 0;
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      n += 1;
      if (n === 1) return { ok: false, status: 529, text: async () => 'overloaded' };
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
      };
    });
    const client = new RequestScopedLlmClient('sk-global', 'claude-default');
    const out = await client.completeWithTools({ system: 's', messages: [], tools, maxTokens: 10 });
    expect(out.stopReason).toBe('end_turn');
    expect(n).toBe(2); // one retry
  });

  it('fails a GLOBAL-key Anthropic credit error over to the global OpenAI fallback', async () => {
    const urls: string[] = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      urls.push(url);
      if (url.includes('anthropic')) {
        return { ok: false, status: 400, text: async () => 'credit balance too low' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'hi from openai' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      };
    });
    const client = new RequestScopedLlmClient('sk-global-anthropic', 'claude-default', undefined, {
      apiKey: 'sk-global-openai',
      model: 'gpt-x',
      provider: 'openai',
    });
    const out = await client.completeWithTools({ system: 's', messages: [], tools, maxTokens: 10 });
    expect(urls.some((u) => u.includes('anthropic'))).toBe(true);
    expect(urls.some((u) => u.includes('openai'))).toBe(true);
    expect(out.content).toEqual([{ type: 'text', text: 'hi from openai' }]);
  });

  it('does NOT fail a tenant BYOK key over to the global account (throws, never touches OpenAI)', async () => {
    const urls: string[] = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
      urls.push(url);
      return { ok: false, status: 400, text: async () => 'credit balance too low' };
    });
    const client = new RequestScopedLlmClient('sk-global-anthropic', 'claude-default', undefined, {
      apiKey: 'sk-global-openai',
      model: 'gpt-x',
      provider: 'openai',
    });
    await expect(
      RequestCredentialsStore.run({ bearerToken: 't', aiProvider: tenantCred }, () =>
        client.completeWithTools({ system: 's', messages: [], tools, maxTokens: 10 }),
      ),
    ).rejects.toThrow(/credit balance/);
    expect(urls.every((u) => u.includes('anthropic'))).toBe(true); // never crossed to OpenAI
  });

  it('is inert without a configured fallback (single-provider behavior unchanged)', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => 'credit balance too low',
    }));
    const client = new RequestScopedLlmClient('sk-global', 'claude-default'); // no fallback
    await expect(
      client.completeWithTools({ system: 's', messages: [], tools, maxTokens: 10 }),
    ).rejects.toThrow(/credit balance/);
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1); // credit err not retried, no fallback
  });
});

describe('parseAiProviderHeader', () => {
  const reqWith = (value: unknown): Request =>
    ({ headers: { 'x-capiro-ai-provider': value } }) as unknown as Request;

  it('parses a well-formed credential', () => {
    const parsed = parseAiProviderHeader(reqWith(JSON.stringify(tenantCred)));
    expect(parsed).toEqual(tenantCred);
  });

  it('returns undefined when the header is absent', () => {
    expect(parseAiProviderHeader({ headers: {} } as unknown as Request)).toBeUndefined();
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['missing apiKey', JSON.stringify({ provider: 'anthropic', model: 'm' })],
    ['empty apiKey', JSON.stringify({ provider: 'anthropic', apiKey: '', model: 'm' })],
    ['unknown provider', JSON.stringify({ provider: 'other', apiKey: 'k', model: 'm' })],
    ['missing model', JSON.stringify({ provider: 'anthropic', apiKey: 'k' })],
  ])('drops %s (global-fallback path, never a 4xx)', (_label, value) => {
    expect(parseAiProviderHeader(reqWith(value))).toBeUndefined();
  });

  it('coerces the booleans strictly (absent → false)', () => {
    const parsed = parseAiProviderHeader(
      reqWith(JSON.stringify({ provider: 'anthropic', apiKey: 'k', model: 'm' })),
    );
    expect(parsed).toEqual({
      provider: 'anthropic',
      apiKey: 'k',
      model: 'm',
      usedTenantKey: false,
      modelOverridden: false,
    });
  });
});

describe('parseAnthropicToolStream (2.4 token streaming)', () => {
  // Jest's node sandbox has no global ReadableStream, so hand-roll the minimal
  // web-stream surface parseAnthropicToolStream consumes: `body.getReader()`
  // returning a reader whose `read()` yields Uint8Array chunks then `done`.
  function streamOf(chunks: string[]): Response {
    const enc = new TextEncoder();
    const queue = chunks.map((c) => enc.encode(c));
    let i = 0;
    const body = {
      getReader: () => ({
        read: async () =>
          i < queue.length
            ? { done: false as const, value: queue[i++] }
            : { done: true as const, value: undefined },
      }),
    };
    return { body } as unknown as Response;
  }

  it('fires text deltas live and reconstructs text + tool_use blocks, stopReason, and usage', async () => {
    // Split across two network chunks, with an SSE event boundary mid-chunk, to
    // exercise the buffering (an event must not be dropped when split).
    const events = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":2,"cache_creation_input_tokens":3}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world [1]"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"search_congress_bills","input":{}}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"ndaa\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":1}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    const whole = events.join('');
    const mid = Math.floor(whole.length / 2);
    const deltas: string[] = [];
    const res = await parseAnthropicToolStream(
      streamOf([whole.slice(0, mid), whole.slice(mid)]),
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual(['Hello ', 'world [1]']); // live, in order
    expect(res.content).toEqual([
      { type: 'text', text: 'Hello world [1]' },
      { type: 'tool_use', id: 'tu_1', name: 'search_congress_bills', input: { q: 'ndaa' } },
    ]);
    expect(res.stopReason).toBe('tool_use');
    expect(res.usage).toEqual({
      inputTokens: 10,
      outputTokens: 42,
      cacheReadTokens: 2,
      cacheCreationTokens: 3,
    });
  });

  it('handles a text-only turn (no tool_use) and end_turn stop reason', async () => {
    const chunks = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Done."}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    ];
    const deltas: string[] = [];
    const res = await parseAnthropicToolStream(streamOf(chunks), (d) => deltas.push(d));
    expect(deltas).toEqual(['Done.']);
    expect(res.content).toEqual([{ type: 'text', text: 'Done.' }]);
    expect(res.stopReason).toBe('end_turn');
    expect(res.usage.outputTokens).toBe(3);
  });
});
