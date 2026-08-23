/**
 * Regression test for the Phase 10 live-discovery request-pacing hang.
 *
 * Root cause: `HttpsPublisherHttpAdapter.rawGet()` paced every request using the
 * caller's `nowIso` — a value the job runtime (`job.mjs`) captures ONCE at
 * process start and threads through, unchanged, for the lifetime of a
 * potentially hours-long crawl (it exists so audit/observedAt timestamps stay
 * deterministic). But `state.lastRequestAt` is genuinely real wall-clock
 * (`new Date().toISOString()`, set right after each `pace()` call). Feeding a
 * frozen "now" against a really-advancing "last request" into
 * `nextHostRequestAt({ nowIso, lastRequestAt, intervalMs })` makes each
 * computed wait equal to the ENTIRE elapsed real time so far plus one interval
 * — the wait itself becomes part of the next wait's input, so it doubles on
 * every request: 1s, 2s, 4s, 8s, 16s, ... 16384s by request 16, which is
 * exactly the shape of the 16-reservation, 7h43m production hang recorded in
 * `defense_budget_discovery_host_budget`.
 *
 * A real-time clock for pacing decisions, independent of the frozen audit
 * `nowIso`, keeps every wait bounded at ~`intervalMs` regardless of how long a
 * run has been going — this test fails (waits explode) against the pre-fix
 * adapter and passes (waits stay bounded and linear) against the fix.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpsPublisherHttpAdapter } from './https-publisher-http.adapter.js';

const FROZEN_JOB_NOW_ISO = '2026-08-01T00:00:00.000Z'; // captured once, never advances — the bug's precondition.

/** A fake response good enough that `follow()` returns immediately with no real network I/O. */
function fakeOkResponse(): Response {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

/**
 * Drives an adapter through N paced requests to the same host using a fully
 * fake, controllable clock: `sleep(ms)` advances the fake clock by exactly
 * `ms` (simulating real time actually passing while paced) with no real
 * waiting, and `clock()` reports that fake time. Returns every wait the
 * adapter asked for, in order.
 */
async function drivePacedRequests(input: {
  adapter: HttpsPublisherHttpAdapter;
  host: string;
  count: number;
}): Promise<number[]> {
  const waits: number[] = [];
  for (let i = 0; i < input.count; i += 1) {
    const before = Date.now();
    await input.adapter.get({
      url: `https://${input.host}/item-${i}`,
      adapterId: 'govinfo-public-laws',
      allowedHosts: [input.host],
      // The caller always passes the SAME frozen job-start timestamp, exactly
      // as `job.mjs` does for a real long-running crawl.
      nowIso: FROZEN_JOB_NOW_ISO,
    });
    waits.push(Date.now() - before);
  }
  return waits;
}

test('pacing stays bounded near intervalMs across many requests, even when the caller always passes the same frozen nowIso', async () => {
  let fakeNowMs = Date.parse(FROZEN_JOB_NOW_ISO);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => fakeOkResponse()) as unknown as typeof fetch;

  try {
    const adapter = new HttpsPublisherHttpAdapter({
      minRequestIntervalMs: () => 1_000,
      // Simulates real time elapsing while paced, without an actual sleep.
      sleep: async (ms: number) => {
        fakeNowMs += ms;
      },
      // The fix under test: a real-time clock independent of the frozen
      // audit nowIso threaded through `get()`'s `nowIso` argument above.
      clock: () => new Date(fakeNowMs).toISOString(),
    });

    const host = 'www.govinfo.gov';
    const requestCount = 16; // matches the exact reservation count from the live hang.
    const waits: number[] = [];
    for (let i = 0; i < requestCount; i += 1) {
      const beforeMs = fakeNowMs;
      await adapter.get({
        url: `https://${host}/item-${i}`,
        adapterId: 'govinfo-public-laws',
        allowedHosts: [host],
        nowIso: FROZEN_JOB_NOW_ISO,
      });
      waits.push(fakeNowMs - beforeMs);
    }

    const totalMs = waits.reduce((a, b) => a + b, 0);
    const maxWaitMs = Math.max(...waits);

    // Pre-fix, this is the doubling series 0,1000,2000,4000,...,16384000 —
    // total ≈ 32,767,000ms (~9.1h simulated), max wait ≈ 16,384,000ms.
    // Post-fix, every wait must stay at ~intervalMs (1000ms): total ≈
    // (requestCount-1)*1000 = 15,000ms, no single wait far above 1,000ms.
    assert.ok(
      maxWaitMs <= 2_000,
      `a single paced wait exploded to ${maxWaitMs}ms — the frozen-clock doubling bug is present ` +
        `(waits observed: ${JSON.stringify(waits)})`,
    );
    assert.ok(
      totalMs <= 20_000,
      `cumulative pacing wait across ${requestCount} requests was ${totalMs}ms — expected roughly ` +
        `${(requestCount - 1) * 1_000}ms of real spacing, not an exponential blowup ` +
        `(waits observed: ${JSON.stringify(waits)})`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pacing is still governed by the real registry interval, not disabled outright', async () => {
  let fakeNowMs = Date.parse(FROZEN_JOB_NOW_ISO);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => fakeOkResponse()) as unknown as typeof fetch;

  try {
    const adapter = new HttpsPublisherHttpAdapter({
      minRequestIntervalMs: () => 5_000,
      sleep: async (ms: number) => {
        fakeNowMs += ms;
      },
      clock: () => new Date(fakeNowMs).toISOString(),
    });
    const host = 'www.govinfo.gov';

    await adapter.get({
      url: `https://${host}/first`,
      adapterId: 'govinfo-public-laws',
      allowedHosts: [host],
      nowIso: FROZEN_JOB_NOW_ISO,
    });
    const beforeSecond = fakeNowMs;
    await adapter.get({
      url: `https://${host}/second`,
      adapterId: 'govinfo-public-laws',
      allowedHosts: [host],
      nowIso: FROZEN_JOB_NOW_ISO,
    });
    const secondWaitMs = fakeNowMs - beforeSecond;

    assert.ok(
      secondWaitMs >= 4_500 && secondWaitMs <= 5_500,
      `expected the second request to wait ~5000ms per the registry interval, got ${secondWaitMs}ms`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
