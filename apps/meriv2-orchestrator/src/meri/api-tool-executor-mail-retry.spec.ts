import { ApiToolExecutorRepo } from './api-tool-executor.repo.js';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';
import type { ToolExecutionControl } from '@capiro/meriv2-core';

const CAPACITY = { statusCode: 503, message: 'The database is temporarily busy. Please retry.' };
const config = { get: (key: string) => key === 'MERIV2_TOOL_TIMEOUT_MS' ? '60000' : undefined };
const originalFetch = global.fetch;

function busy(retryAfter: string | null = '2', payload: unknown = CAPACITY, status = 503) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: retryAfter === null ? {} : { 'Retry-After': retryAfter },
  });
}

function execute(tool = 'list_emails', control?: ToolExecutionControl) {
  return RequestCredentialsStore.run({ bearerToken: 'caller-bearer' }, () =>
    new ApiToolExecutorRepo(config as never).execute(
      {} as never, tool, { withinDays: 14, folder: 'inbox' }, control,
    ),
  );
}

describe('mail read retry after explicit API capacity failure', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  test.each(['list_emails', 'search_emails', 'get_email_thread'])(
    '%s recovers once, retaining request scope, identity and original deadline',
    async (tool) => {
      const receipt = { totalMatches: 389, returned: 15, hasMore: true };
      const fetchMock = jest.fn().mockResolvedValueOnce(busy())
        .mockResolvedValueOnce(new Response(JSON.stringify(receipt)));
      global.fetch = fetchMock;
      const deadlineAt = Date.now() + 5_000;
      const result = execute(tool, { deadlineAt });
      await jest.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual(receipt);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
      const request = fetchMock.mock.calls[1][1] as RequestInit;
      expect(request.headers).toMatchObject({
        authorization: 'Bearer caller-bearer', 'x-meri-deadline-at': String(deadlineAt),
      });
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  test('exhausted retry remains a failure, never an empty search result', async () => {
    const fetchMock = jest.fn().mockImplementation(async () => busy());
    global.fetch = fetchMock;
    const result = expect(execute()).rejects.toThrow('failed: 503');
    await jest.advanceTimersByTimeAsync(2_000);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each([
    ['no Retry-After', null, CAPACITY, 503],
    ['invalid Retry-After', 'soon', CAPACITY, 503],
    ['long Retry-After', '6', CAPACITY, 503],
    ['feature refusal', '2', { statusCode: 503, code: 'FEATURE_DISABLED' }, 503],
    ['unstructured service failure', '2', 'unavailable', 503],
    ['authentication failure', '2', CAPACITY, 401],
    ['authorization failure', '2', CAPACITY, 403],
  ] as const)('does not retry %s', async (_label, retryAfter, payload, status) => {
    const fetchMock = jest.fn().mockResolvedValue(busy(retryAfter, payload, status));
    global.fetch = fetchMock;
    await expect(execute()).rejects.toThrow(`failed: ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(['send_email', 'save_note', 'save_chat_attachments', 'search_memory'])(
    'never adds a retry to %s', async (tool) => {
      const fetchMock = jest.fn().mockResolvedValue(busy());
      global.fetch = fetchMock;
      await expect(execute(tool)).rejects.toThrow('failed: 503');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  test('does not retry when the server delay would consume the remaining turn deadline', async () => {
    const fetchMock = jest.fn().mockResolvedValue(busy());
    global.fetch = fetchMock;
    await expect(execute('list_emails', { deadlineAt: Date.now() + 1_000 })).rejects.toThrow('failed: 503');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('cancellation during Retry-After cancels the wait without another request', async () => {
    const abort = new AbortController();
    const fetchMock = jest.fn().mockResolvedValue(busy());
    global.fetch = fetchMock;
    const result = expect(execute('search_emails', { signal: abort.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await jest.advanceTimersByTimeAsync(500);
    abort.abort();
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('the retry fetch uses the remaining deadline rather than a fresh timeout', async () => {
    const fetchMock = jest.fn().mockResolvedValueOnce(busy()).mockImplementationOnce(
      async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      }),
    );
    global.fetch = fetchMock;
    const result = expect(execute('list_emails', { deadlineAt: Date.now() + 2_500 }))
      .rejects.toMatchObject({ name: 'TimeoutError' });
    await jest.advanceTimersByTimeAsync(2_500);
    await result;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('accepts a short HTTP-date Retry-After', async () => {
    const retryAt = new Date(Date.now() + 2_000).toUTCString();
    const fetchMock = jest.fn().mockResolvedValueOnce(busy(retryAt))
      .mockResolvedValueOnce(new Response('{"returned":0,"totalMatches":0}'));
    global.fetch = fetchMock;
    const result = execute();
    await jest.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toEqual({ returned: 0, totalMatches: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
