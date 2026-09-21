import {
  congressRequestTimeoutMs,
  fetchCongressJson,
  type CongressFetch,
  type CongressHttpResponse,
} from './congress-http';

function response(
  status: number,
  body: unknown,
  options: { retryAfter?: string; statusText?: string; json?: () => Promise<unknown> } = {},
): CongressHttpResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: options.statusText ?? '',
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'retry-after' ? (options.retryAfter ?? null) : null,
    },
    json: options.json ?? (async () => body),
  };
}

const inertDeadline = () => new AbortController().signal;

describe('Congress HTTP ingestion helper', () => {
  it('bounds every attempt, retries timeout failures, and redacts the API key', async () => {
    const createDeadlineSignal = jest.fn(() =>
      AbortSignal.abort(new DOMException('request deadline exceeded', 'TimeoutError')),
    );
    const fetchImpl = jest.fn<ReturnType<CongressFetch>, Parameters<CongressFetch>>(
      async (_url, init) => {
        expect(init.signal.aborted).toBe(true);
        throw init.signal.reason;
      },
    );
    const sleep = jest.fn(async () => undefined);
    const url = 'https://api.congress.gov/v3/bill/119?api_key=top-secret&format=json';

    let thrown: Error | undefined;
    try {
      await fetchCongressJson(url, {
        fetchImpl,
        sleep,
        createDeadlineSignal,
        requestTimeoutMs: 12_345,
        maxRetries: 3,
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).toContain('api_key=[REDACTED]');
    expect(thrown?.message).toContain('request deadline exceeded');
    expect(thrown?.message).not.toContain('top-secret');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(createDeadlineSignal).toHaveBeenCalledTimes(3);
    expect(createDeadlineSignal).toHaveBeenNthCalledWith(1, 12_345);
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
  });

  it('retries a response-body failure before returning parsed JSON', async () => {
    const fetchImpl = jest
      .fn<ReturnType<CongressFetch>, Parameters<CongressFetch>>()
      .mockResolvedValueOnce(
        response(200, null, {
          json: async () => {
            throw new Error('terminated while reading response body');
          },
        }),
      )
      .mockResolvedValueOnce(response(200, { bills: [{ number: '1' }] }));
    const sleep = jest.fn(async () => undefined);

    await expect(
      fetchCongressJson<{ bills: Array<{ number: string }> }>('https://api.congress.gov/v3/bill', {
        fetchImpl,
        sleep,
        createDeadlineSignal: inertDeadline,
      }),
    ).resolves.toEqual({ bills: [{ number: '1' }] });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('honors Retry-After for 429 and exponentially backs off a 5xx response', async () => {
    const fetchImpl = jest
      .fn<ReturnType<CongressFetch>, Parameters<CongressFetch>>()
      .mockResolvedValueOnce(response(429, null, { retryAfter: '7' }))
      .mockResolvedValueOnce(response(503, null, { statusText: 'Unavailable' }))
      .mockResolvedValueOnce(response(200, { ok: true }));
    const sleep = jest.fn(async () => undefined);
    const warn = jest.fn();

    await expect(
      fetchCongressJson('https://api.congress.gov/v3/bill?api_key=secret', {
        fetchImpl,
        sleep,
        warn,
        createDeadlineSignal: inertDeadline,
      }),
    ).resolves.toEqual({ ok: true });

    expect(sleep.mock.calls).toEqual([[7000], [2000]]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.flat().join('\n')).toContain('api_key=[REDACTED]');
    expect(warn.mock.calls.flat().join('\n')).not.toContain('secret');
  });

  it('does not retry an ordinary 4xx response and preserves 404 as null', async () => {
    const sleep = jest.fn(async () => undefined);
    const badRequest = jest.fn<ReturnType<CongressFetch>, Parameters<CongressFetch>>(async () =>
      response(400, null, { statusText: 'Bad Request' }),
    );

    await expect(
      fetchCongressJson('https://api.congress.gov/v3/bill', {
        fetchImpl: badRequest,
        sleep,
        createDeadlineSignal: inertDeadline,
      }),
    ).rejects.toThrow('400 Bad Request');
    expect(badRequest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    const notFound = jest.fn<ReturnType<CongressFetch>, Parameters<CongressFetch>>(async () =>
      response(404, null),
    );
    await expect(
      fetchCongressJson('https://api.congress.gov/v3/bill/119/hr/0', {
        fetchImpl: notFound,
        sleep,
        createDeadlineSignal: inertDeadline,
      }),
    ).resolves.toBeNull();
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('defaults invalid timeout overrides and caps excessively large values', () => {
    expect(congressRequestTimeoutMs(undefined)).toBe(30_000);
    expect(congressRequestTimeoutMs('0')).toBe(30_000);
    expect(congressRequestTimeoutMs('not-a-number')).toBe(30_000);
    expect(congressRequestTimeoutMs('45000')).toBe(45_000);
    expect(congressRequestTimeoutMs('900000')).toBe(300_000);
  });
});
