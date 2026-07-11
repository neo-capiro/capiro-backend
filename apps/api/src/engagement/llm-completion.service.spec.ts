// LlmCompletionService (D1 client, W3.1) — fault-injection + request-shaping.
// Uses an injected fetch + no-op sleep so retries are exercised without waiting.

import { describe, expect, test } from '@jest/globals';
import { LlmCompletionService, type LlmCompletionRequest } from './llm-completion.service.js';

function res(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

const silentLogger = { warn: () => {} };

function makeService(responses: Array<() => Promise<Response>>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return next();
  }) as unknown as typeof fetch;
  const svc = new LlmCompletionService({
    fetchImpl,
    sleepImpl: async () => {},
    logger: silentLogger,
  });
  return { svc, calls };
}

const anthReq: LlmCompletionRequest = {
  provider: 'anthropic',
  apiKey: 'k',
  model: 'claude-sonnet-4-6',
  system: 'SYS',
  userStatic: 'STATIC',
  userVolatile: 'VOLATILE',
  jsonSchema: { type: 'object' },
  jsonSchemaName: 'outreach_draft',
  maxTokens: 2400,
};

const okAnthropic = () =>
  Promise.resolve(
    res(200, {
      content: [{ type: 'text', text: '{"subject":"s","body":"b","contextNote":"c"}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 80 },
    }),
  );

describe('LlmCompletionService — transient retries', () => {
  test('retries a 429 then succeeds', async () => {
    const { svc, calls } = makeService([
      () => Promise.resolve(res(429, { error: { message: 'rate' } })),
      okAnthropic,
    ]);
    const out = await svc.complete(anthReq);
    expect(calls).toHaveLength(2);
    expect(out.text).toContain('"subject":"s"');
    expect(out.usage.inputTokens).toBe(100);
    expect(out.usage.cacheReadTokens).toBe(80);
  });

  test('retries a 500 then succeeds', async () => {
    const { svc, calls } = makeService([() => Promise.resolve(res(500, {})), okAnthropic]);
    await svc.complete(anthReq);
    expect(calls).toHaveLength(2);
  });

  test('retries a network error then succeeds', async () => {
    let first = true;
    const fetchImpl = (async () => {
      if (first) {
        first = false;
        throw new Error('ECONNRESET');
      }
      return okAnthropic();
    }) as unknown as typeof fetch;
    const svc = new LlmCompletionService({
      fetchImpl,
      sleepImpl: async () => {},
      logger: silentLogger,
    });
    const out = await svc.complete(anthReq);
    expect(out.text).toContain('"body":"b"');
  });

  test('gives up after maxRetries and throws typed', async () => {
    const { svc, calls } = makeService([() => Promise.resolve(res(503, {}))]);
    await expect(svc.complete({ ...anthReq, maxRetries: 2 })).rejects.toThrow(/failed/i);
    expect(calls).toHaveLength(3); // initial + 2 retries
  });

  test('a non-retryable 400 fails immediately (no retry)', async () => {
    const { svc, calls } = makeService([
      () => Promise.resolve(res(400, { error: { message: 'bad' } })),
    ]);
    await expect(svc.complete(anthReq)).rejects.toThrow(/bad/);
    expect(calls).toHaveLength(1);
  });
});

describe('LlmCompletionService — truncation reporting', () => {
  test('Anthropic stop_reason=max_tokens ⇒ truncated', async () => {
    const { svc } = makeService([
      () =>
        Promise.resolve(
          res(200, { content: [{ type: 'text', text: '{}' }], stop_reason: 'max_tokens' }),
        ),
    ]);
    const out = await svc.complete(anthReq);
    expect(out.truncated).toBe(true);
    expect(out.stopReason).toBe('max_tokens');
  });

  test('OpenAI status=incomplete/max_output_tokens ⇒ truncated', async () => {
    const { svc } = makeService([
      () =>
        Promise.resolve(
          res(200, {
            output_text: '{}',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
          }),
        ),
    ]);
    const out = await svc.complete({ ...anthReq, provider: 'openai' });
    expect(out.truncated).toBe(true);
  });
});

describe('LlmCompletionService — request shaping', () => {
  test('Anthropic caching marks system + static user block with cache_control', async () => {
    const { svc, calls } = makeService([okAnthropic]);
    await svc.complete({ ...anthReq, cacheSystem: true, cacheUserStatic: true });
    const body = calls[0]!.body;
    expect(Array.isArray(body.system)).toBe(true);
    expect((body.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({
      type: 'ephemeral',
    });
    const content = (body.messages as Array<{ content: unknown }>)[0]!.content as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(content[0]!.text).toBe('STATIC');
    expect(String(content[1]!.text)).toContain('VOLATILE');
    expect(String(content[1]!.text)).toContain('JSON schema:');
  });

  test('legacy v1 OpenAI shape: no instructions, no max_output_tokens', async () => {
    const { svc, calls } = makeService([
      () =>
        Promise.resolve(res(200, { output_text: '{"subject":"s","body":"b","contextNote":""}' })),
    ]);
    await svc.complete({
      ...anthReq,
      provider: 'openai',
      system: '', // v1 OpenAI has no system
      maxTokens: undefined, // v1 OpenAI uncapped
    });
    const body = calls[0]!.body;
    expect(body.instructions).toBeUndefined();
    expect(body.max_output_tokens).toBeUndefined();
    expect(body.input).toContain('VOLATILE');
  });

  test('v2 OpenAI includes instructions + max_output_tokens', async () => {
    const { svc, calls } = makeService([
      () =>
        Promise.resolve(res(200, { output_text: '{"subject":"s","body":"b","contextNote":""}' })),
    ]);
    await svc.complete({ ...anthReq, provider: 'openai', system: 'SYS', maxTokens: 1600 });
    const body = calls[0]!.body;
    expect(body.instructions).toBe('SYS');
    expect(body.max_output_tokens).toBe(1600);
  });
});
