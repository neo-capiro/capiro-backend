// Phase C (remediation plan §3.c4) — graphFetch must cap Retry-After-driven
// retries, AND the recursive retry call must forward `parseJson` (a
// pre-existing bug: the retry call dropped it, so a retried
// graphPostNoContent would try to .json() a 202/204 and throw).

import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';
import { AmbiguousMailSendError, isDefiniteMailSendRejection } from '../mail-send-result.js';

function makeService(fetchImpl: () => Promise<Response>) {
  const service = Object.create(MicrosoftGraphSyncService.prototype) as MicrosoftGraphSyncService;
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

type GraphFetchFn = (
  method: 'GET' | 'POST',
  url: string,
  accessToken: string,
  body?: unknown,
  headers?: Record<string, string>,
  parseJson?: boolean,
) => Promise<unknown>;

describe('MicrosoftGraphSyncService.graphFetch retry bound', () => {
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
      const graphFetch = (service as unknown as { graphFetch: GraphFetchFn }).graphFetch.bind(service);
      const result = graphFetch('GET', '/me/messages', 'token');
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
      const graphFetch = (service as unknown as { graphFetch: GraphFetchFn }).graphFetch.bind(service);
      const invocation = graphFetch('GET', '/me/messages', 'token');
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
      const graphFetch = (service as unknown as { graphFetch: GraphFetchFn }).graphFetch.bind(service);
      await expect(graphFetch('GET', '/me/messages', 'token')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(calls).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  test('read retry preserves parseJson=false', async () => {
    const calls = jest.fn();
    let call = 0;
    const { service, restore } = makeService(async () => {
      calls();
      call += 1;
      if (call === 1) return jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '1' });
      return jsonResponse(undefined, 202);
    });
    try {
      const graphFetch = (service as unknown as { graphFetch: GraphFetchFn }).graphFetch.bind(service);
      const invocation = graphFetch('GET', '/me/messages', 'token', undefined, {}, false);
      await jest.advanceTimersByTimeAsync(5000);
      const result = await invocation;
      expect(result).toBeUndefined();
      expect(calls).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });
});

// ML-02 exercises the real HTTP helper, never graphPost stubs.
describe('Graph mutation dispatch fence', () => {
  test.each([429, 500, 503])('send POST with Retry-After and %s is dispatched once', async (status) => {
    jest.useFakeTimers();
    const calls = jest.fn();
    const { service, restore } = makeService(async () => {
      calls(); return jsonResponse({ error: 'synthetic' }, status, { 'retry-after': '1' });
    });
    try {
      const invocation = (service as any).graphFetch('POST', '/me/messages/draft/send', 'token', {}, {}, false);
      const assertion = expect(invocation).rejects.toBeInstanceOf(ServiceUnavailableException);
      await jest.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(calls).toHaveBeenCalledTimes(1);
    } finally { restore(); jest.useRealTimers(); }
  });
  test('real draft/send HTTP transport preserves rejection, ambiguity, and no-content acceptance without replay', async () => {
    for (const scenario of ['429', '500', 'socket', 'unclassified', '202', 'malformed-draft'] as const) {
      const calls: string[] = [];
      const original = globalThis.fetch;
      const service = Object.create(MicrosoftGraphSyncService.prototype) as any;
      service.assertConnectionAccess = async () => {};
      service.loadConnection = async () => ({ token: {} });
      service.getValidAccessToken = async () => 'synthetic-token';
      globalThis.fetch = (async (url: string) => {
        calls.push(url);
        if (!url.endsWith('/send')) return new Response(JSON.stringify(scenario === 'malformed-draft' ? {} : { id: 'draft' }), { status: 201 });
        if (scenario === 'socket') throw new TypeError('fetch failed');
        if (scenario === 'unclassified') throw new Error('unexpected response handler');
        return new Response(null, { status: Number(scenario), headers: { 'Retry-After': '1' } });
      }) as typeof fetch;
      try {
        const result = await service.sendMail({ tenantId: 'tenant', userId: 'actor' }, 'mailbox', {
          subject: 'Synthetic', body: 'Synthetic', toRecipients: [{ email: 'a@example.test' }], correlationId: 'intent',
        }).then((value: unknown) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
        expect(calls.filter((url) => url.endsWith('/send'))).toHaveLength(scenario === 'malformed-draft' ? 0 : 1);
        if (scenario === '202') expect(result.value).toMatchObject({ ok: true, providerDraftId: 'draft' });
        else {
          expect(result.error).toBeDefined();
          expect(isDefiniteMailSendRejection(result.error)).toBe(scenario === '429');
          if (scenario === '500' || scenario === 'socket') expect(result.error).toBeInstanceOf(AmbiguousMailSendError);
        }
      } finally { globalThis.fetch = original; }
    }
  });
});
