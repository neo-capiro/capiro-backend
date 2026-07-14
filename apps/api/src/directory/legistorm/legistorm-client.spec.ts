import { describe, expect, test } from '@jest/globals';
import memberPage from './__fixtures__/member-page.json';
import officePage from './__fixtures__/office-page.json';
import staffPage from './__fixtures__/staff-page.json';
import { LegiStormClient } from './legistorm-client.js';

const API_KEY = 'test-key-never-log';
const RANGE = { updatedFrom: '2026-07-01', updatedTo: '2026-07-13' };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function queuedFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses[index++];
    if (!response) throw new Error('unexpected fetch call');
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('LegiStormClient', () => {
  test('fails closed when the API key is blank', () => {
    expect(() => new LegiStormClient({ apiKey: '   ' })).toThrow('LEGISTORM_API_KEY is required');
  });

  test('refuses to transmit the API key over plaintext HTTP', () => {
    expect(
      () => new LegiStormClient({ apiKey: API_KEY, baseUrl: 'http://api.example.invalid' }),
    ).toThrow('baseUrl must use HTTPS');
  });

  test('requires valid updated_from and updated_to dates for list endpoints', async () => {
    const { fetchImpl, calls } = queuedFetch([]);
    const client = new LegiStormClient({ apiKey: API_KEY, fetchImpl });

    await expect(
      client.fetchMembers({ updatedFrom: '', updatedTo: RANGE.updatedTo }),
    ).rejects.toThrow('updatedFrom');
    await expect(
      client.fetchOffices({ updatedFrom: '2026-07-14', updatedTo: '2026-07-13' }),
    ).rejects.toThrow('updatedFrom must not be after updatedTo');
    await expect(
      client.fetchStaff({ updatedFrom: '07/01/2026', updatedTo: RANGE.updatedTo }),
    ).rejects.toThrow('YYYY-MM-DD');
    await expect(
      client.fetchMembers({ updatedFrom: '2026-02-30', updatedTo: RANGE.updatedTo }),
    ).rejects.toThrow('valid YYYY-MM-DD');
    expect(calls).toHaveLength(0);
  });

  test('accepts a real leap day', async () => {
    const { fetchImpl, calls } = queuedFetch([jsonResponse(memberPage)]);
    const client = new LegiStormClient({ apiKey: API_KEY, fetchImpl });

    await expect(
      client.fetchMembers({ updatedFrom: '2024-02-29', updatedTo: '2024-02-29' }),
    ).resolves.toMatchObject({ records: memberPage });
    expect(calls).toHaveLength(1);
  });

  test('paginates members, sends only the API-key header, and preserves raw pages', async () => {
    const first = [
      memberPage[0]!,
      { ...memberPage[0]!, member: { ...memberPage[0]!.member, member_id: 900002 } },
    ];
    const second = [{ ...memberPage[0]!, member: { ...memberPage[0]!.member, member_id: 900003 } }];
    const { fetchImpl, calls } = queuedFetch([jsonResponse(first), jsonResponse(second)]);
    const sleeps: number[] = [];
    const client = new LegiStormClient({
      apiKey: API_KEY,
      pageSize: 2,
      requestDelayMs: 400,
      fetchImpl,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    const result = await client.fetchMembers(RANGE);

    expect(
      result.records.map((record: { member: { member_id: number } }) => record.member.member_id),
    ).toEqual([900001, 900002, 900003]);
    expect(result.rawPages).toEqual([
      { page: 1, body: first },
      { page: 2, body: second },
    ]);
    expect(calls).toHaveLength(2);
    const firstUrl = new URL(calls[0]!.url);
    const secondUrl = new URL(calls[1]!.url);
    expect(firstUrl.pathname).toBe('/v2.019.10/congress/member/list');
    expect(Object.fromEntries(firstUrl.searchParams)).toEqual({
      updated_from: RANGE.updatedFrom,
      updated_to: RANGE.updatedTo,
      status: 'c',
      limit: '2',
      page: '1',
    });
    expect(secondUrl.searchParams.get('page')).toBe('2');
    expect(calls[0]!.init?.headers).toEqual({ 'X-API-KEY': API_KEY, Accept: 'application/json' });
    expect(calls[0]!.init?.redirect).toBe('error');
    expect(sleeps).toEqual([400]);
  });

  test('clamps the page size to the LegiStorm maximum of 100', async () => {
    const { fetchImpl, calls } = queuedFetch([jsonResponse(memberPage)]);
    const client = new LegiStormClient({ apiKey: API_KEY, pageSize: 1000, fetchImpl });

    await client.fetchMembers(RANGE);

    expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('100');
  });

  test('skips non-record elements in a mixed list response (preserving them in rawPages)', async () => {
    // Real /office/list appends a trailing { office_member_addresses } element with no office.
    const mixed = [officePage[0]!, { office_member_addresses: [] }];
    const { fetchImpl } = queuedFetch([jsonResponse(mixed)]);
    const client = new LegiStormClient({ apiKey: API_KEY, fetchImpl });

    const result = await client.fetchOffices(RANGE);

    expect(result.records).toEqual([officePage[0]]); // the non-office element is skipped
    expect(result.rawPages[0]!.body).toEqual(mixed); // but preserved verbatim in raw
  });

  test('fetches only the allowed office and staff list endpoints', async () => {
    for (const testCase of [
      { kind: 'office', pathname: '/v2.019.10/congress/office/list', body: officePage },
      { kind: 'staff', pathname: '/v2.019.10/congress/staff/list', body: staffPage },
    ] as const) {
      const { fetchImpl, calls } = queuedFetch([jsonResponse(testCase.body)]);
      const client = new LegiStormClient({ apiKey: API_KEY, fetchImpl });

      const result =
        testCase.kind === 'office'
          ? await client.fetchOffices(RANGE)
          : await client.fetchStaff(RANGE);

      expect(result.records).toEqual(testCase.body);
      const url = new URL(calls[0]!.url);
      expect(url.pathname).toBe(testCase.pathname);
      expect(url.searchParams.get('updated_from')).toBe(RANGE.updatedFrom);
      expect(url.searchParams.get('updated_to')).toBe(RANGE.updatedTo);
    }
  });

  test('stops at the configured maximum page count', async () => {
    const first = [memberPage[0]!];
    const second = [{ ...memberPage[0]!, member: { ...memberPage[0]!.member, member_id: 900002 } }];
    const { fetchImpl, calls } = queuedFetch([jsonResponse(first), jsonResponse(second)]);
    const client = new LegiStormClient({
      apiKey: API_KEY,
      pageSize: 1,
      maxPages: 2,
      requestDelayMs: 0,
      fetchImpl,
    });

    await expect(client.fetchMembers(RANGE)).rejects.toThrow('maximum page count');
    expect(calls).toHaveLength(2);
  });

  test('stops when the vendor repeats the same full page', async () => {
    const fullPage = [memberPage[0]!];
    const { fetchImpl, calls } = queuedFetch([jsonResponse(fullPage), jsonResponse(fullPage)]);
    const client = new LegiStormClient({
      apiKey: API_KEY,
      pageSize: 1,
      requestDelayMs: 0,
      fetchImpl,
    });

    await expect(client.fetchMembers(RANGE)).rejects.toThrow('repeated page');
    expect(calls).toHaveLength(2);
  });

  test('fetches and validates retired office and staff IDs', async () => {
    for (const testCase of [
      { kind: 'office', pathname: '/v2.019.10/congress/office/retired-ids' },
      { kind: 'staff', pathname: '/v2.019.10/congress/staff/retired-ids' },
    ] as const) {
      const { fetchImpl, calls } = queuedFetch([jsonResponse([700001, 700002])]);
      const client = new LegiStormClient({ apiKey: API_KEY, fetchImpl });

      const result =
        testCase.kind === 'office'
          ? await client.fetchRetiredOfficeIds()
          : await client.fetchRetiredStaffIds();

      expect(result).toEqual({ ids: [700001, 700002], rawBody: [700001, 700002] });
      expect(new URL(calls[0]!.url).pathname).toBe(testCase.pathname);
      expect(new URL(calls[0]!.url).search).toBe('');
    }
  });

  test('rejects malformed retired IDs rather than silently dropping them', async () => {
    const { fetchImpl } = queuedFetch([jsonResponse([1, Number.MAX_SAFE_INTEGER + 1])]);
    const client = new LegiStormClient({ apiKey: API_KEY, fetchImpl });

    await expect(client.fetchRetiredOfficeIds()).rejects.toThrow('invalid retired ID');
  });

  test('retries 429 and 5xx with bounded backoff and injected jitter', async () => {
    const { fetchImpl, calls } = queuedFetch([
      jsonResponse({ error: 'slow down' }, 429, { 'Retry-After': '2' }),
      jsonResponse({ error: 'temporary' }, 503),
      jsonResponse(memberPage),
    ]);
    const sleeps: number[] = [];
    const client = new LegiStormClient({
      apiKey: API_KEY,
      fetchImpl,
      maxRetries: 2,
      randomImpl: () => 0.5,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    const result = await client.fetchMembers(RANGE);

    expect(result.records).toEqual(memberPage);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2000, 625]);
  });

  test('parses HTTP-date Retry-After and clamps oversized delays', async () => {
    const now = Date.parse('2026-07-13T12:00:00Z');
    const httpDate = new Date(now + 5000).toUTCString();
    const first = queuedFetch([
      jsonResponse({}, 503, { 'Retry-After': httpDate }),
      jsonResponse(memberPage),
    ]);
    const firstSleeps: number[] = [];
    const firstClient = new LegiStormClient({
      apiKey: API_KEY,
      fetchImpl: first.fetchImpl,
      nowImpl: () => now,
      maxRetryDelayMs: 10_000,
      sleepImpl: async (ms: number) => {
        firstSleeps.push(ms);
      },
    });

    await firstClient.fetchMembers(RANGE);
    expect(firstSleeps).toEqual([5000]);

    const second = queuedFetch([
      jsonResponse({}, 429, { 'Retry-After': '9999' }),
      jsonResponse(memberPage),
    ]);
    const secondSleeps: number[] = [];
    const secondClient = new LegiStormClient({
      apiKey: API_KEY,
      fetchImpl: second.fetchImpl,
      maxRetryDelayMs: 10_000,
      sleepImpl: async (ms: number) => {
        secondSleeps.push(ms);
      },
    });

    await secondClient.fetchMembers(RANGE);
    expect(secondSleeps).toEqual([10_000]);
  });

  test('falls back to bounded jitter when Retry-After is malformed', async () => {
    const { fetchImpl } = queuedFetch([
      jsonResponse({}, 503, { 'Retry-After': 'not-a-date' }),
      jsonResponse(memberPage),
    ]);
    const sleeps: number[] = [];
    const client = new LegiStormClient({
      apiKey: API_KEY,
      fetchImpl,
      randomImpl: () => 0.5,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    await client.fetchMembers(RANGE);
    expect(sleeps).toEqual([625]);
  });

  test('does not retry auth failures and never exposes the key or query values in errors', async () => {
    const { fetchImpl, calls } = queuedFetch([jsonResponse({ error: 'denied' }, 401)]);
    const client = new LegiStormClient({ apiKey: API_KEY, fetchImpl, maxRetries: 3 });

    let message = '';
    try {
      await client.fetchMembers(RANGE);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(calls).toHaveLength(1);
    expect(message).toContain('member/list');
    expect(message).toContain('401');
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain(RANGE.updatedFrom);
    expect(message).not.toContain(RANGE.updatedTo);
  });

  test('retries a network error only up to the configured bound', async () => {
    const { fetchImpl, calls } = queuedFetch([new Error('socket reset'), new Error('still down')]);
    const sleeps: number[] = [];
    const client = new LegiStormClient({
      apiKey: API_KEY,
      fetchImpl,
      maxRetries: 1,
      randomImpl: () => 0,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    await expect(client.fetchStaff(RANGE)).rejects.toThrow('staff/list request failed');
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([500]);
  });

  test('aborts a hung request at the configured timeout', async () => {
    const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      })) as typeof fetch;
    const client = new LegiStormClient({
      apiKey: API_KEY,
      fetchImpl,
      maxRetries: 0,
      requestTimeoutMs: 5,
    });

    await expect(client.fetchMembers(RANGE)).rejects.toThrow('request failed after 1 attempts');
  });

  test('stops a non-consecutive repeated-page cycle', async () => {
    const pageA = [memberPage[0]!];
    const pageB = [{ ...memberPage[0]!, member: { ...memberPage[0]!.member, member_id: 900002 } }];
    const { fetchImpl, calls } = queuedFetch([
      jsonResponse(pageA),
      jsonResponse(pageB),
      jsonResponse(pageA),
    ]);
    const client = new LegiStormClient({
      apiKey: API_KEY,
      pageSize: 1,
      maxPages: 4,
      requestDelayMs: 0,
      fetchImpl,
    });

    await expect(client.fetchMembers(RANGE)).rejects.toThrow('repeated page');
    expect(calls).toHaveLength(3);
  });

  test('keeps the timeout active while reading the response body', async () => {
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise<unknown>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          }),
      }) as Response) as typeof fetch;
    const client = new LegiStormClient({
      apiKey: API_KEY,
      fetchImpl,
      maxRetries: 0,
      requestTimeoutMs: 5,
    });

    const outcome = await Promise.race([
      client.fetchMembers(RANGE).then(
        () => 'unexpected success',
        (error: Error) => error.message,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('still pending'), 50)),
    ]);
    expect(outcome).toContain('request failed after 1 attempts');
  });

  test('rejects a non-array list response without discarding or inventing records', async () => {
    const { fetchImpl } = queuedFetch([jsonResponse({ data: memberPage })]);
    const client = new LegiStormClient({ apiKey: API_KEY, fetchImpl });

    await expect(client.fetchMembers(RANGE)).rejects.toThrow('expected an array');
  });
});
