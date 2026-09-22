import { describe, expect, it, jest } from '@jest/globals';
import { buildClaimSupportQuestion } from './claim-support-question';
import type { EvidenceEnvelope } from './decision-contract';
import { createJevDecisionProvider } from './jev-decision-provider';
import {
  createJevClient,
  JevCancelledError,
  JevRequestError,
  JevTimeoutError,
  type JevFetch,
} from './jev-client';

const envelope: EvidenceEnvelope = {
  envelopeVersion: 'meri-evidence-envelope-v1',
  claimId: 'claim-1',
  claimText: 'The program received funding.',
  claimKind: 'fact',
  claimCategory: 'budget_amount',
  tenantId: 'tenant-1',
  clientId: null,
  scopeQualifiers: ['FY2026'],
  asOf: '2026-09-21',
  sources: [
    {
      evidenceId: 'evidence-1',
      sourceType: 'document',
      sourceId: 'source-1',
      documentId: 'document-1',
      version: 'v1',
      locator: 'p. 2',
      passage: 'The program received $1 million.',
      sourceDate: '2026-09-20',
      publishedAt: null,
      effectiveAt: null,
      retrievedAt: '2026-09-21T00:00:00Z',
    },
  ],
};
const question = buildClaimSupportQuestion(envelope);

function validResponse(overrides: Record<string, unknown> = {}) {
  return {
    model: 'jev-1.13.0',
    answers: {
      claim_support: {
        type: 'choice',
        choice: 'supported',
        probabilities: {
          supported: 0.7,
          contradicted: 0.1,
          insufficient_evidence: 0.15,
          conflicting_evidence: 0.05,
        },
        confidence: 0.6,
        ...overrides,
      },
    },
    usage: { input_tokens: 10, output_tokens: 2 },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function client(fetchImpl: JevFetch, options: { maxAttempts?: number; timeoutMs?: number; sleepImpl?: (ms: number) => Promise<void> } = {}) {
  return createJevClient({
    apiKey: 'test-key',
    model: 'jev-1.13.0',
    timeoutMs: options.timeoutMs ?? 100,
    maxAttempts: options.maxAttempts ?? 2,
    fetchImpl,
    sleepImpl: options.sleepImpl ?? (async () => undefined),
  });
}

describe('Jev client', () => {
  it.each([[401], [422]])('does not retry HTTP %s', async (status) => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, status)) as unknown as JevFetch;
    await expect(client(fetchImpl).systemOne(question)).rejects.toMatchObject({ status });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries 429 once and honors capped Retry-After', async () => {
    const sleep = jest.fn(async () => undefined);
    const fetchImpl = jest
      .fn<JevFetch>()
      .mockResolvedValueOnce(jsonResponse({}, 429, { 'retry-after': '99' }))
      .mockResolvedValueOnce(jsonResponse(validResponse()));
    const result = await client(fetchImpl, { sleepImpl: sleep }).systemOne(question);
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(30000);
  });

  it('fails after two 529 attempts', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, 529)) as unknown as JevFetch;
    await expect(client(fetchImpl).systemOne(question)).rejects.toMatchObject({ code: 'overloaded' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps per-attempt timeout and external cancellation distinctly', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as JevFetch;
    await expect(client(hanging, { timeoutMs: 1, maxAttempts: 1 }).systemOne(question)).rejects.toBeInstanceOf(JevTimeoutError);
    const controller = new AbortController();
    const pending = client(hanging).systemOne(question, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(JevCancelledError);
  });

  it.each([
    'not json',
    validResponse({ probabilities: { supported: 0.9, contradicted: 0.9, insufficient_evidence: 0, conflicting_evidence: 0 } }),
    validResponse({ choice: 'unknown' }),
  ])('rejects malformed response %#', async (body) => {
    const fetchImpl = jest.fn(async () => jsonResponse(body)) as unknown as JevFetch;
    await expect(client(fetchImpl).systemOne(question)).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('refuses a key in the request body before fetch', async () => {
    const fetchImpl = jest.fn() as unknown as JevFetch;
    await expect(client(fetchImpl).systemOne({ state: 'test-key', questions: question.questions })).rejects.toBeInstanceOf(JevRequestError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends authorization only in the header', async () => {
    const fetchImpl = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
      expect(String(init?.body)).not.toContain('test-key');
      expect(init?.redirect).toBe('error');
      return jsonResponse(validResponse());
    }) as unknown as JevFetch;
    await client(fetchImpl).systemOne(question);
  });
});

describe('question and provider', () => {
  it('refuses oversized state pre-flight', () => {
    const source = envelope.sources[0];
    if (!source) throw new Error('test fixture source missing');
    expect(() => buildClaimSupportQuestion({ ...envelope, sources: [{ ...source, passage: 'x'.repeat(130000) }] })).toThrow(JevRequestError);
  });

  it('scope mismatch returns scope_refused without a network call', async () => {
    const fetchImpl = jest.fn() as unknown as JevFetch;
    const provider = createJevDecisionProvider({ client: client(fetchImpl), model: 'jev-1.13.0', scope: { tenantId: 'other', surface: 'chat' } });
    await expect(provider.assess(envelope, question)).resolves.toMatchObject({ kind: 'failure', state: 'scope_refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('round-trips a schema-derived response into an evidence decision', async () => {
    const fixture = require('./__fixtures__/recorded-choice-response.v1.json');
    const fetchImpl = jest.fn(async () => jsonResponse(fixture.response)) as unknown as JevFetch;
    const provider = createJevDecisionProvider({ client: client(fetchImpl), model: 'jev-1.13.0', scope: { tenantId: envelope.tenantId, surface: 'chat' } });
    await expect(provider.assess(envelope, question)).resolves.toMatchObject({ kind: 'outcome', outcome: 'supported', evidenceIds: ['evidence-1'] });
  });

  it('maps auth and request failures to stable decisions', async () => {
    for (const [status, reason] of [[401, 'auth_failed'], [422, 'request_rejected']] as const) {
      const fetchImpl = jest.fn(async () => jsonResponse({}, status)) as unknown as JevFetch;
      const provider = createJevDecisionProvider({ client: client(fetchImpl), model: 'jev-1.13.0', scope: { tenantId: envelope.tenantId, surface: 'chat' } });
      await expect(provider.assess(envelope, question)).resolves.toMatchObject({ kind: 'failure', state: 'judge_unavailable', reasonCodes: [reason] });
    }
  });
});
