import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { buildClaimSupportQuestion } from './claim-support-question';
import type { EvidenceEnvelope } from './decision-contract';
import { createJevDecisionProvider } from './jev-decision-provider';
import {
  createJevClient,
  JevCancelledError,
  JevRateLimitError,
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

function client(
  fetchImpl: JevFetch,
  options: {
    maxAttempts?: number;
    timeoutMs?: number;
    sleepImpl?: (ms: number) => Promise<void>;
  } = {},
) {
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

  it('allows a caller to lower the retry ceiling', async () => {
    const sleep = jest.fn(async () => undefined);
    const fetchImpl = jest.fn(async () => jsonResponse({}, 429)) as unknown as JevFetch;
    await expect(
      client(fetchImpl, { sleepImpl: sleep }).systemOne(question, { maxAttempts: 1 }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails after two 529 attempts', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({}, 529)) as unknown as JevFetch;
    await expect(client(fetchImpl).systemOne(question)).rejects.toMatchObject({
      code: 'overloaded',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps per-attempt timeout and external cancellation distinctly', async () => {
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      })) as JevFetch;
    await expect(
      client(hanging, { timeoutMs: 1, maxAttempts: 1 }).systemOne(question),
    ).rejects.toBeInstanceOf(JevTimeoutError);
    const controller = new AbortController();
    const pending = client(hanging).systemOne(question, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(JevCancelledError);
  });

  it.each([
    'not json',
    validResponse({
      probabilities: {
        supported: 0.9,
        contradicted: 0.9,
        insufficient_evidence: 0,
        conflicting_evidence: 0,
      },
    }),
    validResponse({ choice: 'unknown' }),
  ])('rejects malformed response %#', async (body) => {
    const fetchImpl = jest.fn(async () => jsonResponse(body)) as unknown as JevFetch;
    await expect(client(fetchImpl).systemOne(question)).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  it('refuses a key in the request body before fetch', async () => {
    const fetchImpl = jest.fn() as unknown as JevFetch;
    await expect(
      client(fetchImpl).systemOne({ state: 'test-key', questions: question.questions }),
    ).rejects.toBeInstanceOf(JevRequestError);
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

describe('Jev client retry budget', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  /** Body-less responses keep the fake-timer flow free of stream reads. */
  const statusOnly = (status: number, headers: Record<string, string> = {}) =>
    new Response(null, { status, headers });
  /** Built-in timer sleep and Date.now, both driven by the fake clock. */
  const timerClient = (fetchImpl: JevFetch, maxAttempts = 2) =>
    createJevClient({
      apiKey: 'test-key',
      model: 'jev-1.13.0',
      timeoutMs: 100,
      maxAttempts,
      fetchImpl,
    });
  const useFakeTimers = () =>
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  /** Observes settlement without awaiting, so a client that wrongly keeps sleeping fails fast instead of hanging. */
  const observe = <T>(promise: Promise<T>) => {
    const outcome: { settled: boolean; value?: T; error?: unknown } = { settled: false };
    promise.then(
      (value) => {
        outcome.settled = true;
        outcome.value = value;
      },
      (error) => {
        outcome.settled = true;
        outcome.error = error;
      },
    );
    return outcome;
  };

  it('fails a 429 immediately when Retry-After cannot fit before deadlineAt, instead of sleeping up to 30 s', async () => {
    useFakeTimers();
    const start = Date.now();
    const fetchImpl = jest
      .fn<JevFetch>()
      .mockResolvedValue(statusOnly(429, { 'retry-after': '99' }));
    const outcome = observe(
      timerClient(fetchImpl).systemOne(question, { deadlineAt: start + 4_000 }),
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(outcome.settled).toBe(true);
    expect(outcome.error).toBeInstanceOf(JevRateLimitError);
    expect(Date.now() - start).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('sleeps only a backoff that fits the deadline and retries within the remaining budget', async () => {
    useFakeTimers();
    const start = Date.now();
    const fetchImpl = jest
      .fn<JevFetch>()
      .mockResolvedValueOnce(statusOnly(429, { 'retry-after': '3' }))
      .mockResolvedValueOnce(jsonResponse(validResponse()));
    const pending = timerClient(fetchImpl).systemOne(question, { deadlineAt: start + 4_000 });
    const outcome = observe(pending);
    await jest.advanceTimersByTimeAsync(2_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(outcome.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ attempts: 2, latencyMs: 3_000 });
    expect(Date.now() - start).toBe(3_000);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects promptly with JevCancelledError when the caller aborts during the backoff sleep', async () => {
    useFakeTimers();
    const start = Date.now();
    const fetchImpl = jest
      .fn<JevFetch>()
      .mockResolvedValue(statusOnly(429, { 'retry-after': '3' }));
    const controller = new AbortController();
    const outcome = observe(
      timerClient(fetchImpl).systemOne(question, {
        signal: controller.signal,
        deadlineAt: start + 10_000,
      }),
    );
    await jest.advanceTimersByTimeAsync(1_000);
    expect(outcome.settled).toBe(false);
    controller.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(outcome.settled).toBe(true);
    expect(outcome.error).toBeInstanceOf(JevCancelledError);
    expect(Date.now() - start).toBe(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('gives up with JevTimeoutError rather than a new attempt when an injected sleep overshoots the deadline', async () => {
    useFakeTimers();
    const start = Date.now();
    const fetchImpl = jest
      .fn<JevFetch>()
      .mockResolvedValue(statusOnly(429, { 'retry-after': '1' }));
    const sleep = jest.fn(async (_ms: number) => {
      jest.setSystemTime(start + 5_000);
    });
    await expect(
      client(fetchImpl, { sleepImpl: sleep }).systemOne(question, { deadlineAt: start + 4_000 }),
    ).rejects.toBeInstanceOf(JevTimeoutError);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a transport failure: the request may already have been processed and billed', async () => {
    const sleep = jest.fn(async () => undefined);
    const fetchImpl = jest.fn<JevFetch>().mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      client(fetchImpl, { maxAttempts: 3, sleepImpl: sleep }).systemOne(question),
    ).rejects.toMatchObject({
      code: 'network_error',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('question and provider', () => {
  it('refuses oversized state pre-flight', () => {
    const source = envelope.sources[0];
    if (!source) throw new Error('test fixture source missing');
    expect(() =>
      buildClaimSupportQuestion({
        ...envelope,
        sources: [{ ...source, passage: 'x'.repeat(130000) }],
      }),
    ).toThrow(JevRequestError);
  });

  it('scope mismatch returns scope_refused without a network call', async () => {
    const fetchImpl = jest.fn() as unknown as JevFetch;
    const provider = createJevDecisionProvider({
      client: client(fetchImpl),
      model: 'jev-1.13.0',
      scope: { tenantId: 'other', surface: 'chat' },
    });
    await expect(provider.assess(envelope, question)).resolves.toMatchObject({
      kind: 'failure',
      state: 'scope_refused',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('round-trips a schema-derived response into an evidence decision', async () => {
    const fixture = require('./__fixtures__/recorded-choice-response.v1.json');
    const fetchImpl = jest.fn(async () => jsonResponse(fixture.response)) as unknown as JevFetch;
    const provider = createJevDecisionProvider({
      client: client(fetchImpl),
      model: 'jev-1.13.0',
      scope: { tenantId: envelope.tenantId, surface: 'chat' },
    });
    await expect(provider.assess(envelope, question)).resolves.toMatchObject({
      kind: 'outcome',
      outcome: 'supported',
      evidenceIds: ['evidence-1'],
    });
  });

  it('maps auth and request failures to stable decisions', async () => {
    for (const [status, reason] of [
      [401, 'auth_failed'],
      [422, 'request_rejected'],
    ] as const) {
      const fetchImpl = jest.fn(async () => jsonResponse({}, status)) as unknown as JevFetch;
      const provider = createJevDecisionProvider({
        client: client(fetchImpl),
        model: 'jev-1.13.0',
        scope: { tenantId: envelope.tenantId, surface: 'chat' },
      });
      await expect(provider.assess(envelope, question)).resolves.toMatchObject({
        kind: 'failure',
        state: 'judge_unavailable',
        reasonCodes: [reason],
      });
    }
  });
});

// Stage 4a/4b design (docs/meri/grounding/stage-4/) needs an ordered-levels question type
// alongside choice/noul. No production caller sends `score` yet; this exercises the wire
// contract and validation in isolation.
describe('score question type', () => {
  const scoreQuestion = {
    state: { subject: 'client-1', opportunity: 'opp-1' },
    questions: {
      capability_class_alignment: {
        type: 'score' as const,
        instructions: 'How closely does the capability class align?',
        levels: {
          no_overlap: 'No overlap between capability and requirement classes.',
          related_domain: 'Related domain, no class match.',
          same_class: 'Same capability class.',
          directly_comparable: 'Directly comparable capability and requirement.',
        },
      },
    },
  };
  const validScoreAnswer = (overrides: Record<string, unknown> = {}) => ({
    model: 'jev-1.13.0',
    answers: {
      capability_class_alignment: {
        type: 'score',
        level: 'same_class',
        probabilities: {
          no_overlap: 0.05,
          related_domain: 0.15,
          same_class: 0.6,
          directly_comparable: 0.2,
        },
        confidence: 0.55,
        ...overrides,
      },
    },
    usage: { input_tokens: 8, output_tokens: 2 },
  });

  it('accepts a valid score answer and preserves the declared level order', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(validScoreAnswer())) as unknown as JevFetch;
    const result = await client(fetchImpl).systemOne(scoreQuestion);
    expect(result.response.answers.capability_class_alignment).toMatchObject({
      type: 'score',
      level: 'same_class',
    });
  });

  it('rejects a level not present in the declared levels', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse(validScoreAnswer({ level: 'off_scale' })),
    ) as unknown as JevFetch;
    await expect(client(fetchImpl).systemOne(scoreQuestion)).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  it('rejects probabilities that do not sum to 1 across every declared level', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse(
        validScoreAnswer({
          probabilities: {
            no_overlap: 0.9,
            related_domain: 0.9,
            same_class: 0.9,
            directly_comparable: 0.9,
          },
        }),
      ),
    ) as unknown as JevFetch;
    await expect(client(fetchImpl).systemOne(scoreQuestion)).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });

  it('rejects probabilities missing a declared level', async () => {
    const fetchImpl = jest.fn(async () => {
      const body = validScoreAnswer();
      delete (body.answers.capability_class_alignment.probabilities as Record<string, number>)
        .directly_comparable;
      return jsonResponse(body);
    }) as unknown as JevFetch;
    await expect(client(fetchImpl).systemOne(scoreQuestion)).rejects.toMatchObject({
      code: 'malformed_response',
    });
  });
});
