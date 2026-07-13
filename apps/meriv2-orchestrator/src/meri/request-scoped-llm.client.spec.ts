import type { Request } from 'express';
import { RequestScopedLlmClient } from './request-scoped-llm.client';
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
