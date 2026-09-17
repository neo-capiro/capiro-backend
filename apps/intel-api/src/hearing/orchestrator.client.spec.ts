import { OrchestratorClient } from './orchestrator.client';

/**
 * Hearing summarizeHearing budget split — the EVIDENCE branch runs a bounded
 * manual-thinking step on a 60s inner provider budget, so only that branch
 * widens its outer deadline to 65s; the legacy (non-evidence) recap keeps the
 * 35s floor and extraction keeps its single 8s timeout. These tests use fake
 * timers with an AbortSignal-AWARE fetch stub (it rejects when the client's
 * AbortController fires), not a mock that ignores the signal — so a wrong
 * budget is caught by the abort actually firing.
 */
describe('OrchestratorClient.summarizeHearing — per-branch timeout budget', () => {
  const base = 'http://orchestrator.test';
  let client: OrchestratorClient;

  const evidence = [
    { segmentId: 's1', text: 'some transcript text', startMs: 0, endMs: 1000, speakerLabel: '0' },
  ];

  function makeClient() {
    const config = { get: (k: string) => (k === 'MERIV2_ORCHESTRATOR_URL' ? base : undefined) };
    const aiCreds = { resolve: async () => undefined };
    return new OrchestratorClient(config as never, aiCreds as never);
  }

  /** AbortSignal-aware fetch: never responds on its own, rejects when the
   *  caller's signal aborts — exactly what a real fetch under an AbortController
   *  does. Returns the init.signal so the test can read the chosen budget. */
  function hangingFetch() {
    const seen: Array<{ signal: AbortSignal }> = [];
    const fetchImpl = (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      seen.push({ signal });
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
        );
      });
    };
    return { fetchImpl: fetchImpl as unknown as typeof fetch, seen };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    client = makeClient();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const summarizeParams = {
    tenantId: 't',
    sessionId: 'sess',
    clerkUserId: 'u',
    title: 'Hearing',
    quotes: [],
    mentions: [],
    actionItems: [],
  };

  it('evidence branch aborts after 65000ms (thinking headroom), not the 35s floor', async () => {
    const { fetchImpl, seen } = hangingFetch();
    jest.spyOn(global, 'fetch').mockImplementation(fetchImpl);
    const p = client.summarizeHearing({ ...summarizeParams, evidence });
    const assertion = expect(p).resolves.toBeNull(); // abort → graceful null
    await jest.advanceTimersByTimeAsync(34999);
    expect(seen[0]!.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1); // 35000 — legacy floor passed, still alive
    expect(seen[0]!.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(29999); // 64999
    expect(seen[0]!.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1); // 65000 — evidence deadline fires
    expect(seen[0]!.signal.aborted).toBe(true);
    await assertion;
  });

  it('legacy (non-evidence) branch keeps the 35000ms floor', async () => {
    const { fetchImpl, seen } = hangingFetch();
    jest.spyOn(global, 'fetch').mockImplementation(fetchImpl);
    const p = client.summarizeHearing(summarizeParams); // no evidence
    const assertion = expect(p).resolves.toBeNull();
    await jest.advanceTimersByTimeAsync(34999);
    expect(seen[0]!.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1); // 35000 — legacy deadline fires
    expect(seen[0]!.signal.aborted).toBe(true);
    await assertion;
  });

  it('narrativeSource (legacy authored recap) widens to 130000ms, not the 35s floor', async () => {
    const { fetchImpl, seen } = hangingFetch();
    jest.spyOn(global, 'fetch').mockImplementation(fetchImpl);
    const narrativeSource = [
      { segmentId: 's1', text: 'opening statement', startMs: 0, endMs: 1000, speakerLabel: '0' },
    ];
    const p = client.summarizeHearing({ ...summarizeParams, narrativeSource });
    const assertion = expect(p).resolves.toBeNull();
    await jest.advanceTimersByTimeAsync(65000); // governed evidence budget passed, still alive
    expect(seen[0]!.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(64999); // 129999
    expect(seen[0]!.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1); // 130000 — narrative deadline fires
    expect(seen[0]!.signal.aborted).toBe(true);
    await assertion;
  });

  it('extract() keeps its single default 8000ms timeout (no reasoning headroom there)', async () => {
    const { fetchImpl, seen } = hangingFetch();
    jest.spyOn(global, 'fetch').mockImplementation(fetchImpl);
    const p = client.extract({
      tenantId: 't',
      sessionId: 'sess',
      clerkUserId: 'u',
      segment: { id: 's1' } as never,
      sessionContext: { issueIds: [], billIds: [], programElementIds: [], agencyIds: [] },
    });
    const assertion = expect(p).resolves.toEqual({ entityMentions: [], issueTags: [] });
    await jest.advanceTimersByTimeAsync(7999);
    expect(seen[0]!.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1); // 8000 — extraction deadline fires
    expect(seen[0]!.signal.aborted).toBe(true);
    await assertion;
  });
});
