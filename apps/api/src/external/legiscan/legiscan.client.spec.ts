import { getSessionList, getMasterListRaw, getBill } from './legiscan.client.js';

/**
 * W0.6 (2026-07-10 hot-fix, S1-D): this client had zero test coverage.
 * Covers the deterministic, non-retry paths — envelope-status error
 * handling and getMasterListRaw's session-key/malformed-entry filtering.
 * Retry/backoff timing is intentionally out of scope here (real prod
 * behavior, not implicated by the audit's quota-governance findings).
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

describe('legiscanFetch envelope-status handling (via getSessionList)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('returns the parsed payload when status is OK', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ status: 'OK', sessions: [{ session_id: 1 }] }));
    const r = await getSessionList('key', 'TX');
    expect(r).toEqual([{ session_id: 1 }]);
  });

  it('returns [] when the sessions field is absent, even with status OK', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ status: 'OK' }));
    const r = await getSessionList('key', 'TX');
    expect(r).toEqual([]);
  });

  it('REGRESSION-GUARD: throws with the LegiScan alert message when status is not OK', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ status: 'ERROR', alert: { message: 'invalid key' } }));
    await expect(getSessionList('bad-key', 'TX')).rejects.toThrow(/invalid key/);
  });

  it('throws a plain HTTP error for a non-2xx, non-retryable status (e.g. 404)', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({}, 404));
    await expect(getSessionList('key', 'TX')).rejects.toThrow(/LegiScan HTTP 404/);
  });

  it('getBill returns null when the bill field is absent (no exception)', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ status: 'OK' }));
    const r = await getBill('key', 42);
    expect(r).toBeNull();
  });
});

describe('getMasterListRaw (session-key + malformed-entry filtering)', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('skips the embedded "session" metadata key and keeps only real bill entries', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        status: 'OK',
        masterlist: {
          session: { session_id: 1, session_name: 'Regular' },
          '1001': { bill_id: 1001, number: 'HB1', change_hash: 'h1' },
          '1002': { bill_id: 1002, number: 'HB2', change_hash: 'h2' },
        },
      }),
    );
    const r = await getMasterListRaw('key', 1);
    expect(r).toHaveLength(2);
    expect(r.map((b) => b.bill_id).sort()).toEqual([1001, 1002]);
  });

  it('drops malformed entries missing bill_id or change_hash', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        status: 'OK',
        masterlist: {
          '1': { bill_id: 1, number: 'HB1', change_hash: 'h1' }, // valid
          '2': { number: 'HB2', change_hash: 'h2' }, // missing bill_id
          '3': { bill_id: 3, number: 'HB3' }, // missing change_hash
        },
      }),
    );
    const r = await getMasterListRaw('key', 1);
    expect(r).toHaveLength(1);
    expect(r[0]?.bill_id).toBe(1);
  });

  it('returns [] when the masterlist field is entirely absent', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ status: 'OK' }));
    const r = await getMasterListRaw('key', 1);
    expect(r).toEqual([]);
  });
});
