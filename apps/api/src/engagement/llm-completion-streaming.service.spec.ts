// completeStreaming() — SSE transport, retry semantics, and provider fallback.
// Kept separate from llm-completion.service.spec.ts (the non-streaming
// transport's existing test file) since these fixtures need a `.body`
// ReadableStream the non-streaming tests never touch.

import { describe, expect, test } from '@jest/globals';
import { LlmCompletionService, type LlmCompletionRequest } from './llm-completion.service.js';

const silentLogger = { warn: () => {} };

/** Builds a Response-like object whose body streams the given SSE event bodies as UTF-8 chunks. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const encoded = chunks.map((c) => encoder.encode(c));
  let i = 0;
  return {
    status,
    headers: { get: () => null },
    json: async () => ({}),
    body: {
      getReader: () => ({
        read: async () => {
          if (i < encoded.length) {
            const value = encoded[i];
            i++;
            return { done: false, value };
          }
          return { done: true, value: undefined };
        },
      }),
    },
  } as unknown as Response;
}

function errorResponse(status: number, retryAfterSeconds?: number): Response {
  return {
    status,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'retry-after' && retryAfterSeconds ? String(retryAfterSeconds) : null),
    },
    json: async () => ({ error: { message: 'boom' } }),
  } as unknown as Response;
}

function sseEvent(type: string, fields: Record<string, unknown>): string {
  return 'data: ' + JSON.stringify({ type, ...fields });
}

const req: LlmCompletionRequest = {
  provider: 'openai',
  apiKey: 'k',
  model: 'gpt-5',
  system: 'SYS',
  userStatic: 'STATIC',
  userVolatile: 'VOLATILE',
  jsonSchema: { type: 'object' },
  jsonSchemaName: 'outreach_draft',
};

function makeService(responses: Array<() => Promise<Response>>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return next();
  }) as unknown as typeof fetch;
  const svc = new LlmCompletionService({ fetchImpl, sleepImpl: async () => {}, logger: silentLogger });
  return { svc, calls };
}

const FULL_TEXT = '{"subject":"Hi","body":"Thanks for reaching out.","contextNote":"n/a"}';

describe('completeStreaming — happy path', () => {
  test('feeds onProgress the accumulating raw text and returns the parsed final result', async () => {
    const { svc, calls } = makeService([
      () =>
        Promise.resolve(
          sseResponse([
            sseEvent('response.output_text.delta', { delta: '{"subject":"Hi","body":"Thanks ' }) + '\n\n',
            sseEvent('response.output_text.delta', { delta: 'for reaching out.","contextNote":"n/a"}' }) + '\n\n',
            sseEvent('response.completed', {
              response: {
                status: 'completed',
                output_text: FULL_TEXT,
                usage: { input_tokens: 10, output_tokens: 5 },
              },
            }) + '\n\n',
          ]),
        ),
    ]);

    const progressCalls: string[] = [];
    const result = await svc.completeStreaming(req, (rawTextSoFar) => progressCalls.push(rawTextSoFar));

    // Request is marked as a streaming call.
    expect(calls[0]!.body.stream).toBe(true);
    // onProgress fires once per delta, with the FULL accumulated text each time.
    expect(progressCalls).toEqual([
      '{"subject":"Hi","body":"Thanks ',
      '{"subject":"Hi","body":"Thanks for reaching out.","contextNote":"n/a"}',
    ]);
    // The final result is parsed exactly as the non-streaming path would.
    expect(result.text).toBe(FULL_TEXT);
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
  });

  test('reassembles an event split across chunk boundaries mid-line', async () => {
    const wholeEvent = sseEvent('response.output_text.delta', { delta: 'Hello' }) + '\n\n';
    const splitPoint = Math.floor(wholeEvent.length / 2);
    const { svc } = makeService([
      () =>
        Promise.resolve(
          sseResponse([
            wholeEvent.slice(0, splitPoint),
            wholeEvent.slice(splitPoint) +
              sseEvent('response.completed', {
                response: { status: 'completed', output_text: 'Hello', usage: {} },
              }) +
              '\n\n',
          ]),
        ),
    ]);
    const progressCalls: string[] = [];
    const result = await svc.completeStreaming(req, (t) => progressCalls.push(t));
    expect(progressCalls).toEqual(['Hello']);
    expect(result.text).toBe('Hello');
  });

  test('ignores an unparseable or unrecognized event without failing the call', async () => {
    const { svc } = makeService([
      () =>
        Promise.resolve(
          sseResponse([
            'data: {not valid json\n\n',
            sseEvent('response.some_future_event_type', { anything: 'goes' }) + '\n\n',
            sseEvent('response.completed', {
              response: { status: 'completed', output_text: 'ok', usage: {} },
            }) + '\n\n',
          ]),
        ),
    ]);
    const result = await svc.completeStreaming(req, () => {});
    expect(result.text).toBe('ok');
  });
});

describe('completeStreaming — retry semantics', () => {
  test('retries a 429 rejected before any streaming begins, then succeeds', async () => {
    const { svc, calls } = makeService([
      () => Promise.resolve(errorResponse(429, 0)),
      () =>
        Promise.resolve(
          sseResponse([
            sseEvent('response.completed', {
              response: { status: 'completed', output_text: 'ok', usage: {} },
            }) + '\n\n',
          ]),
        ),
    ]);
    const result = await svc.completeStreaming(req, () => {});
    expect(calls).toHaveLength(2);
    expect(result.text).toBe('ok');
  });

  test('a stream that ends without response.completed is retryable, and the retry starts progress over from scratch', async () => {
    const { svc, calls } = makeService([
      () =>
        Promise.resolve(
          // Connection drops after one delta — no completed event ever arrives.
          sseResponse([sseEvent('response.output_text.delta', { delta: 'partial' }) + '\n\n']),
        ),
      () =>
        Promise.resolve(
          sseResponse([
            sseEvent('response.output_text.delta', { delta: 'full' }) + '\n\n',
            sseEvent('response.completed', {
              response: { status: 'completed', output_text: 'full', usage: {} },
            }) + '\n\n',
          ]),
        ),
    ]);
    const progressCalls: string[] = [];
    const result = await svc.completeStreaming(req, (t) => progressCalls.push(t));
    expect(calls).toHaveLength(2);
    // The failed first attempt's "partial" progress is never followed by a
    // "partialfull" — the retry's own accumulation starts from '' again.
    expect(progressCalls).toEqual(['partial', 'full']);
    expect(result.text).toBe('full');
  });

  test('a non-retryable status fails immediately without retrying', async () => {
    const { svc, calls } = makeService([() => Promise.resolve(errorResponse(401))]);
    await expect(svc.completeStreaming(req, () => {})).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe('completeStreaming — provider fallback', () => {
  test('Anthropic falls back to the non-streaming path with no progress callbacks', async () => {
    const { svc, calls } = makeService([
      () =>
        Promise.resolve({
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            content: [{ type: 'text', text: '{"subject":"s"}' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        } as unknown as Response),
    ]);
    const progressCalls: string[] = [];
    const result = await svc.completeStreaming(
      { ...req, provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-4-6' },
      (t) => progressCalls.push(t),
    );
    expect(progressCalls).toEqual([]);
    expect(result.text).toBe('{"subject":"s"}');
    // Never asked the provider to stream.
    expect(calls[0]!.body.stream).toBeUndefined();
  });
});
