// Phase C (remediation plan §3.c2) — googleGet must cap Retry-After-driven
// retries. Before this, a provider that kept returning 429/5xx with a small
// Retry-After header could hold a request open forever.

import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { GoogleSyncService } from './google-sync.service.js';

function makeService(fetchImpl: () => Promise<Response>) {
  const service = Object.create(GoogleSyncService.prototype) as GoogleSyncService;
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
  return { service, restore: () => (globalThis.fetch = original) };
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  const headerMap = new Map(Object.entries(headers));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('GoogleSyncService.googleGet retry bound', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('429 with retry-after:1 forever rejects after exactly 3 attempts', async () => {
    const calls = jest.fn();
    const { service, restore } = makeService(async () => {
      calls();
      return jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '1' });
    });
    try {
      const result = (service as unknown as { googleGet: (u: string, t: string) => Promise<unknown> })
        .googleGet('https://example.test/x', 'token');
      // Attach the rejection assertion BEFORE advancing fake timers: the
      // rejection actually happens inside advanceTimersByTimeAsync's flush, so
      // attaching afterward leaves a window where Node sees an unhandled
      // rejection on the same promise.
      const assertion = expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
      await jest.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(calls).toHaveBeenCalledTimes(3);
    } finally {
      restore();
    }
  });

  test('429 with retry-after:1 then 200 resolves after 2 attempts', async () => {
    const calls = jest.fn();
    let call = 0;
    const { service, restore } = makeService(async () => {
      calls();
      call += 1;
      if (call === 1) return jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '1' });
      return jsonResponse({ ok: true }, 200);
    });
    try {
      const invocation = (service as unknown as { googleGet: (u: string, t: string) => Promise<unknown> })
        .googleGet('https://example.test/x', 'token');
      await jest.advanceTimersByTimeAsync(5000);
      const result = await invocation;
      expect(result).toEqual({ ok: true });
      expect(calls).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  test('500 with no retry-after header rejects on the first call (unchanged trigger condition)', async () => {
    const calls = jest.fn();
    const { service, restore } = makeService(async () => {
      calls();
      return jsonResponse({ error: 'boom' }, 500);
    });
    try {
      await expect(
        (service as unknown as { googleGet: (u: string, t: string) => Promise<unknown> }).googleGet(
          'https://example.test/x',
          'token',
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(calls).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
