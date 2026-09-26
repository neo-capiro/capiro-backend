import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createSandboxServer, READINESS_CODE } from '../src/server.js';
import { runSandboxed, type SandboxRunRequest, type SandboxRunResult } from '../src/run.js';

const TOKEN = 'spec-only-token';
const MARKER = { sandboxReadinessProtocolVersion: 1 };

function outcome(overrides: Partial<SandboxRunResult> = {}): SandboxRunResult {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    stdout: '',
    stderr: '',
    results: MARKER,
    images: [],
    warnings: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withServer(
  options: Parameters<typeof createSandboxServer>[0],
  check: (base: string) => Promise<void>,
) {
  const server = createSandboxServer({ token: TOKEN, ...options });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await check(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function readiness(base: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${TOKEN}`);
  return fetch(`${base}/readiness`, {
    ...init,
    method: 'POST',
    headers,
  });
}

function run(base: string) {
  return fetch(`${base}/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'results = 1' }),
  });
}

async function waitFor(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('timed out waiting for server state');
}

async function queueCounts(base: string) {
  const response = await fetch(`${base}/healthz`);
  return response.json() as Promise<{ active: number; queued: number }>;
}

test('readiness is bearer authenticated; healthz does not imply usable Python', async () => {
  let calls = 0;
  await withServer({ runner: async () => { calls += 1; return outcome({ ok: false }); } }, async (base) => {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readiness`, { method: 'POST' })).status, 401);
    assert.equal((await readiness(base, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${base}/readiness`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
    assert.equal((await fetch(`${base}/readiness/`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, redirect: 'manual' })).status, 404);
    assert.equal(calls, 0);
    const response = await readiness(base);
    assert.equal(response.status, 503);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['protocolVersion', 'ready', 'observedAt', 'observation']);
    assert.equal(body.protocolVersion, 1);
    assert.equal(body.ready, false);
    assert.equal(body.observation, 'fresh');
    const ordinaryRun = await run(base);
    assert.equal(ordinaryRun.status, 200);
    assert.equal((await ordinaryRun.json() as SandboxRunResult).ok, false);
  });
});

test('readiness accepts no caller code, datasets, tool name, or other body', async () => {
  let calls = 0;
  await withServer({ runner: async () => { calls += 1; return outcome(); } }, async (base) => {
    for (const body of ['{}', '{"code":"print(1)"}', '{"datasets":[]}', '{"tool":"run_analysis"}']) {
      assert.equal((await readiness(base, { body })).status, 400);
    }
    assert.equal((await readiness(base, { body: 'x'.repeat(8 * 1024 * 1024 + 1) })).status, 413);
    assert.equal(calls, 0);
  });
});

test('an open streamed body reaches a bounded 408 and never starts Python', async () => {
  let calls = 0;
  await withServer({ probeBodyWaitMs: 25, runner: async () => { calls += 1; return outcome(); } }, async (base) => {
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = httpRequest(`${base}/readiness`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'transfer-encoding': 'chunked' },
      }, resolve);
      request.on('error', reject);
      request.flushHeaders();
    });
    assert.equal(response.statusCode, 408);
    response.resume();
    await new Promise<void>((resolve) => response.on('end', resolve));
    assert.equal(calls, 0);
  });
});

test('fixed code checks the image import contract and receipt exposes no runner output', async () => {
  let request: SandboxRunRequest | undefined;
  await withServer({ runner: async (input) => { request = input; return outcome({ stdout: 'secret', stderr: 'private path' }); } }, async (base) => {
    const response = await readiness(base);
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['protocolVersion', 'ready', 'observedAt', 'observation']);
    assert.equal(body.ready, true);
    assert.equal(body.observation, 'fresh');
    assert.equal(typeof body.observedAt, 'string');
    assert.equal(JSON.stringify(body).includes('secret'), false);
    assert.equal(request?.code, READINESS_CODE);
    assert.deepEqual(request?.datasets, []);
    assert.equal(request?.timeoutMs, 20_000);
    for (const name of ['matplotlib.pyplot', 'cycler', 'numpy', 'pandas', 'scipy.stats', 'statsmodels.api', 'seaborn', 'networkx']) {
      assert.equal(READINESS_CODE.includes(name), true, name);
    }
  });
});

test('cached success expires and concurrent callers share one queued probe', async () => {
  let clock = Date.parse('2026-09-25T00:00:00.000Z');
  let calls = 0;
  const gate = deferred<SandboxRunResult>();
  const joined = deferred<void>();
  await withServer({
    now: () => clock,
    probeCacheMs: 30_000,
    onProbeJoin: (source) => { if (source === 'coalesced') joined.resolve(); },
    runner: async () => { calls += 1; return calls === 1 ? gate.promise : outcome(); },
  }, async (base) => {
    const first = readiness(base);
    await waitFor(async () => calls === 1);
    const second = readiness(base);
    await joined.promise;
    assert.equal(calls, 1);
    gate.resolve(outcome());
    const [fresh, coalesced] = await Promise.all([first, second]);
    const firstBody = await fresh.json() as Record<string, unknown>;
    const secondBody = await coalesced.json() as Record<string, unknown>;
    assert.equal(firstBody.observation, 'fresh');
    assert.equal(secondBody.observation, 'coalesced');
    assert.equal(secondBody.observedAt, firstBody.observedAt);
    const cached = await (await readiness(base)).json() as Record<string, unknown>;
    assert.equal(cached.observation, 'cached');
    assert.equal(cached.observedAt, firstBody.observedAt);
    assert.equal(calls, 1);
    clock += 30_001;
    const expired = await (await readiness(base)).json() as Record<string, unknown>;
    assert.equal(expired.observation, 'fresh');
    assert.notEqual(expired.observedAt, firstBody.observedAt);
    assert.equal(calls, 2);
  });
});

test('coalesced callers are bounded without starting a second probe', async () => {
  const gate = deferred<SandboxRunResult>();
  let calls = 0;
  await withServer({
    maxProbeWaiters: 1,
    runner: async () => { calls += 1; return gate.promise; },
  }, async (base) => {
    const first = readiness(base);
    await waitFor(async () => calls === 1);
    const refused = await readiness(base);
    assert.equal(refused.status, 503);
    const body = await refused.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['protocolVersion', 'ready', 'observedAt', 'observation']);
    assert.equal(body.protocolVersion, 1);
    assert.equal(body.ready, false);
    assert.equal(typeof body.observedAt, 'string');
    assert.equal(body.observation, 'refused');
    assert.equal(calls, 1);
    gate.resolve(outcome());
    assert.equal((await first).status, 200);
  });
});

test('response deadline fails closed even when a runner ignores cancellation', async () => {
  let capturedSignal: AbortSignal | undefined;
  await withServer({
    probeResponseTimeoutMs: 25,
    runner: (request) => {
      capturedSignal = request.signal;
      return new Promise<SandboxRunResult>(() => {});
    },
  }, async (base) => {
    const response = await readiness(base);
    assert.equal(response.status, 503);
    assert.equal((await response.json() as Record<string, unknown>).ready, false);
    assert.equal(capturedSignal?.aborted, true);
    assert.equal((await queueCounts(base)).active, 1);
    const cached = await readiness(base);
    assert.equal(cached.status, 503);
    assert.equal((await cached.json() as Record<string, unknown>).observation, 'cached');
  });
});

test('failed, timed-out, missing-marker, and thrown runner outcomes stay unready', async () => {
  const failures: Array<() => Promise<SandboxRunResult>> = [
    async () => outcome({ ok: false, stderr: 'ModuleNotFoundError: required import' }),
    async () => outcome({ ok: false, timedOut: true }),
    async () => outcome({ results: null }),
    async () => { throw new Error('spawn ENOENT and secret environment'); },
  ];
  for (const runner of failures) {
    await withServer({ runner }, async (base) => {
      const fresh = await readiness(base);
      assert.equal(fresh.status, 503);
      const body = await fresh.json() as Record<string, unknown>;
      assert.deepEqual(Object.keys(body), ['protocolVersion', 'ready', 'observedAt', 'observation']);
      assert.equal(body.ready, false);
      const cached = await readiness(base);
      assert.equal(cached.status, 503);
      assert.equal((await cached.json() as Record<string, unknown>).observation, 'cached');
    });
  }
});

test('queue refusal and queue wait timeout fail closed without running probe code', async () => {
  for (const maxQueue of [0, 1]) {
    const gate = deferred<SandboxRunResult>();
    let probeCalls = 0;
    await withServer({
      concurrency: 1,
      maxQueue,
      probeQueueWaitMs: 25,
      runner: (request) => {
        if (request.code === READINESS_CODE) { probeCalls += 1; return Promise.resolve(outcome()); }
        return gate.promise;
      },
    }, async (base) => {
      const activeRun = run(base);
      await waitFor(async () => (await queueCounts(base)).active === 1);
      const response = await readiness(base);
      assert.equal(response.status, 503);
      assert.equal((await response.json() as Record<string, unknown>).ready, false);
      assert.equal(probeCalls, 0);
      assert.equal((await queueCounts(base)).queued, 0);
      gate.resolve(outcome());
      assert.equal((await activeRun).status, 200);
    });
  }
});

test('last caller cancellation removes queued probe without caching unready', async () => {
  const gate = deferred<SandboxRunResult>();
  let probeCalls = 0;
  await withServer({
    concurrency: 1,
    maxQueue: 1,
    runner: (request) => {
      if (request.code !== READINESS_CODE) return gate.promise;
      probeCalls += 1;
      return Promise.resolve(outcome());
    },
  }, async (base) => {
    const activeRun = run(base);
    await waitFor(async () => (await queueCounts(base)).active === 1);
    const controller = new AbortController();
    const pending = readiness(base, { signal: controller.signal }).catch((error: unknown) => error);
    await waitFor(async () => (await queueCounts(base)).queued === 1);
    controller.abort();
    await pending;
    await waitFor(async () => (await queueCounts(base)).queued === 0);
    assert.equal(probeCalls, 0);
    gate.resolve(outcome());
    assert.equal((await activeRun).status, 200);
    const followUp = await readiness(base);
    assert.equal(followUp.status, 200);
    const body = await followUp.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['protocolVersion', 'ready', 'observedAt', 'observation']);
    assert.equal(body.ready, true);
    assert.equal(body.observation, 'fresh');
    assert.equal(probeCalls, 1);
  });
});

test('last caller cancellation aborts an active probe without caching unready', async () => {
  let signal: AbortSignal | undefined;
  let probeCalls = 0;
  await withServer({
    runner: (request) => {
      probeCalls += 1;
      if (probeCalls > 1) return Promise.resolve(outcome());
      return new Promise<SandboxRunResult>((resolve) => {
        signal = request.signal;
        signal?.addEventListener('abort', () => resolve(outcome({ ok: false })), { once: true });
      });
    },
  }, async (base) => {
    const controller = new AbortController();
    const pending = readiness(base, { signal: controller.signal }).catch((error: unknown) => error);
    await waitFor(async () => signal !== undefined);
    controller.abort();
    await pending;
    await waitFor(async () => signal?.aborted === true);
    await waitFor(async () => (await queueCounts(base)).active === 0);
    const followUp = await readiness(base);
    assert.equal(followUp.status, 200);
    const body = await followUp.json() as Record<string, unknown>;
    assert.equal(body.observation, 'fresh');
    assert.equal(body.ready, true);
    assert.equal(probeCalls, 2);
  });
});

test('abandoned runner keeps its slot and cannot overwrite a newer ready cache', async () => {
  const oldRun = deferred<SandboxRunResult>();
  let calls = 0;
  let oldSignal: AbortSignal | undefined;
  await withServer({
    concurrency: 2,
    runner: (request) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(outcome());
      oldSignal = request.signal;
      return oldRun.promise;
    },
  }, async (base) => {
    const controller = new AbortController();
    const abandoned = readiness(base, { signal: controller.signal }).catch((error: unknown) => error);
    await waitFor(async () => calls === 1);
    controller.abort();
    await abandoned;
    await waitFor(async () => oldSignal?.aborted === true);
    assert.equal((await queueCounts(base)).active, 1);

    const fresh = await readiness(base);
    assert.equal(fresh.status, 200);
    assert.equal((await fresh.json() as Record<string, unknown>).observation, 'fresh');
    assert.equal(calls, 2);

    oldRun.resolve(outcome({ ok: false }));
    await waitFor(async () => (await queueCounts(base)).active === 0);
    const cached = await readiness(base);
    assert.equal(cached.status, 200);
    const cachedBody = await cached.json() as Record<string, unknown>;
    assert.equal(cachedBody.observation, 'cached');
    assert.equal(cachedBody.ready, true);
    assert.equal(calls, 2);
  });
});

test('missing Python executable fails the real startup path', async () => {
  const prior = process.env.SANDBOX_PYTHON;
  process.env.SANDBOX_PYTHON = '__capiro_missing_python_executable__';
  try {
    await withServer({ runner: runSandboxed }, async (base) => {
      const response = await readiness(base);
      assert.equal(response.status, 503);
      assert.equal((await response.json() as Record<string, unknown>).ready, false);
    });
  } finally {
    if (prior === undefined) delete process.env.SANDBOX_PYTHON;
    else process.env.SANDBOX_PYTHON = prior;
  }
});
