/**
 * Clio analysis sandbox runner (assistant-parity F4).
 *
 * The readiness receipt is a short-lived observation of this sandbox's Python
 * startup and required imports. It says nothing about tenant/tool eligibility
 * and does not reserve capacity for a later /run invocation.
 *
 * Endpoints:
 *   GET  /healthz             → process liveness only
 *   POST /run (bearer)        → SandboxRunResult
 *   POST /readiness (bearer)  → bounded, fixed-code runtime observation
 */
import { createServer, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSandboxed, validateRunRequest, type SandboxRunRequest, type SandboxRunResult } from './run.js';

const PORT = Number(process.env.PORT ?? 4100);
const TOKEN = process.env.CLIO_SANDBOX_TOKEN ?? '';
const CONCURRENCY = Math.max(1, Number(process.env.CLIO_SANDBOX_CONCURRENCY ?? 2));
const MAX_QUEUE = 20;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PROBE_QUEUE_WAIT_MS = 2_000;
const PROBE_RUN_TIMEOUT_MS = 20_000;
const PROBE_RESPONSE_TIMEOUT_MS = 25_000;
const PROBE_BODY_WAIT_MS = 2_000;
const PROBE_CACHE_MS = 30_000;
const MAX_PROBE_WAITERS = 16;
const READINESS_PROTOCOL_VERSION = 1;

type ReadinessSource = 'fresh' | 'coalesced' | 'cached' | 'refused';

// The harness pre-imports this stack but deliberately swallows optional import
// failures for ordinary runs. Explicit imports here make a missing library fail
// the probe while using the same harness, Python executable, and image.
export const READINESS_CODE = [
  'import matplotlib',
  'matplotlib.use("Agg")',
  'import matplotlib.pyplot',
  'from cycler import cycler',
  'import numpy',
  'import pandas',
  'import scipy',
  'import scipy.stats',
  'import statsmodels.api',
  'import seaborn',
  'import networkx',
  'results = {"sandboxReadinessProtocolVersion": 1}',
].join('\n');

interface ReadinessObservation {
  ready: boolean;
  observedAt: string;
  status: 200 | 503;
}

interface InFlightProbe {
  controller: AbortController;
  promise: Promise<ReadinessObservation>;
  waiters: number;
  settled: boolean;
  abandoned: boolean;
}

interface SandboxServerOptions {
  token?: string;
  concurrency?: number;
  maxQueue?: number;
  runner?: (request: SandboxRunRequest) => Promise<SandboxRunResult>;
  now?: () => number;
  probeQueueWaitMs?: number;
  probeRunTimeoutMs?: number;
  probeResponseTimeoutMs?: number;
  probeBodyWaitMs?: number;
  probeCacheMs?: number;
  maxProbeWaiters?: number;
  onProbeJoin?: (source: 'fresh' | 'coalesced') => void;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Options exist for isolated HTTP specs; production uses the fixed defaults. */
export function createSandboxServer(options: SandboxServerOptions = {}) {
  const token = options.token ?? TOKEN;
  const concurrency = options.concurrency ?? CONCURRENCY;
  const maxQueue = options.maxQueue ?? MAX_QUEUE;
  const runner = options.runner ?? runSandboxed;
  const now = options.now ?? Date.now;
  const probeQueueWaitMs = options.probeQueueWaitMs ?? PROBE_QUEUE_WAIT_MS;
  const probeRunTimeoutMs = options.probeRunTimeoutMs ?? PROBE_RUN_TIMEOUT_MS;
  const probeResponseTimeoutMs = options.probeResponseTimeoutMs ?? PROBE_RESPONSE_TIMEOUT_MS;
  const probeBodyWaitMs = options.probeBodyWaitMs ?? PROBE_BODY_WAIT_MS;
  const probeCacheMs = options.probeCacheMs ?? PROBE_CACHE_MS;
  const maxProbeWaiters = options.maxProbeWaiters ?? MAX_PROBE_WAITERS;

  let active = 0;
  const queue: Array<() => void> = [];
  let cached: (ReadinessObservation & { completedAt: number }) | null = null;
  let inFlight: InFlightProbe | null = null;

  function acquireSlot(signal?: AbortSignal, waitMs?: number): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error('sandbox admission cancelled'));
    if (active < concurrency) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      if (queue.length >= maxQueue) {
        reject(new Error('sandbox queue is full'));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const refuse = (reason: string) => {
        const index = queue.indexOf(grant);
        if (index < 0) return;
        queue.splice(index, 1);
        cleanup();
        reject(new Error(reason));
      };
      const onAbort = () => refuse('sandbox admission cancelled');
      const grant = () => {
        cleanup();
        active += 1;
        resolve();
      };
      queue.push(grant);
      if (waitMs !== undefined) {
        timer = setTimeout(() => refuse('sandbox admission timed out'), waitMs);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  function releaseSlot(): void {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  }

  function receipt(res: ServerResponse, observation: ReadinessObservation, source: ReadinessSource) {
    send(res, observation.status, {
      protocolVersion: READINESS_PROTOCOL_VERSION,
      ready: observation.ready,
      observedAt: observation.observedAt,
      observation: source,
    });
  }

  async function executeProbe(controller: AbortController): Promise<ReadinessObservation> {
    const signal = controller.signal;
    let ready = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const attempt = (async () => {
        let acquired = false;
        try {
          await acquireSlot(signal, probeQueueWaitMs);
          acquired = true;
          return await runner({
            code: READINESS_CODE,
            datasets: [],
            timeoutMs: probeRunTimeoutMs,
            signal,
          });
        } catch {
          return null;
        } finally {
          // If a runner ignores cancellation, retain its slot until it exits.
          if (acquired) releaseSlot();
        }
      })();
      const deadline = new Promise<null>((resolve) => {
        deadlineTimer = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, probeResponseTimeoutMs);
      });
      const result = await Promise.race([attempt, deadline]);
      if (!result) throw new Error('probe unavailable');
      const marker = result.results;
      ready = !signal.aborted && result.ok && !result.timedOut && result.exitCode === 0 &&
        !!marker && typeof marker === 'object' && !Array.isArray(marker) &&
        (marker as Record<string, unknown>).sandboxReadinessProtocolVersion === READINESS_PROTOCOL_VERSION;
    } catch {
      // No exception text, Python output, paths, or environment reach the receipt.
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
    return {
      ready,
      observedAt: new Date(now()).toISOString(),
      status: ready ? 200 : 503,
    };
  }

  function joinProbe(res: ServerResponse, probe: InFlightProbe, source: 'fresh' | 'coalesced') {
    probe.waiters += 1;
    options.onProbeJoin?.(source);
    let attached = true;
    const detach = () => {
      if (!attached) return;
      attached = false;
      res.off('close', detach);
      probe.waiters -= 1;
      if (probe.waiters === 0 && !probe.settled) {
        probe.abandoned = true;
        if (inFlight === probe) inFlight = null;
        probe.controller.abort();
      }
    };
    res.once('close', detach);
    void probe.promise.then((observation) => {
      if (!res.destroyed) receipt(res, observation, source);
      detach();
    });
  }

  function handleReadiness(res: ServerResponse) {
    const current = now();
    if (cached && current >= cached.completedAt && current - cached.completedAt < probeCacheMs) {
      receipt(res, cached, 'cached');
      return;
    }
    if (inFlight) {
      if (inFlight.waiters >= maxProbeWaiters) {
        receipt(res, { ready: false, observedAt: new Date(now()).toISOString(), status: 503 }, 'refused');
        return;
      }
      joinProbe(res, inFlight, 'coalesced');
      return;
    }
    const controller = new AbortController();
    const probe: InFlightProbe = {
      controller,
      promise: undefined as unknown as Promise<ReadinessObservation>,
      waiters: 0,
      settled: false,
      abandoned: false,
    };
    inFlight = probe;
    probe.promise = executeProbe(controller).then((observation) => {
      probe.settled = true;
      if (!probe.abandoned) cached = { ...observation, completedAt: now() };
      if (inFlight === probe) inFlight = null;
      return observation;
    });
    joinProbe(res, probe, 'fresh');
  }

  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      send(res, 200, { ok: true, active, queued: queue.length });
      return;
    }
    const isRun = req.method === 'POST' && req.url === '/run';
    const isReadiness = req.method === 'POST' && req.url === '/readiness';
    if (!isRun && !isReadiness) {
      send(res, 404, { error: 'not found' });
      return;
    }
    if (!token || req.headers.authorization !== `Bearer ${token}`) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }

    if (isReadiness) {
      let rejected = false;
      const rejectBody = (status: number, error: string) => {
        if (rejected) return;
        rejected = true;
        clearTimeout(bodyTimer);
        res.shouldKeepAlive = false;
        res.setHeader('connection', 'close');
        req.pause();
        send(res, status, { error });
      };
      const bodyTimer = setTimeout(() => rejectBody(408, 'request timeout'), probeBodyWaitMs);
      res.once('close', () => clearTimeout(bodyTimer));
      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (contentLength > 0) {
        rejectBody(
          contentLength > MAX_BODY_BYTES ? 413 : 400,
          contentLength > MAX_BODY_BYTES ? 'request too large' : 'body must be empty',
        );
        return;
      }
      req.on('data', (chunk: Buffer) => {
        if (chunk.length > 0) rejectBody(400, 'body must be empty');
      });
      req.on('end', () => {
        clearTimeout(bodyTimer);
        if (!rejected && !res.destroyed) handleReadiness(res);
      });
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        send(res, 413, { error: 'request too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          send(res, 400, { error: 'invalid JSON' });
          return;
        }
        const validation = validateRunRequest(parsed);
        if (!validation.ok) {
          send(res, 400, { error: validation.error });
          return;
        }
        try {
          await acquireSlot();
        } catch (err) {
          send(res, 429, { error: err instanceof Error ? err.message : 'queue full' });
          return;
        }
        try {
          const result: SandboxRunResult = await runner(validation.req);
          send(res, 200, result);
        } catch (err) {
          send(res, 500, { error: err instanceof Error ? err.message : 'sandbox failure' });
        } finally {
          releaseSlot();
        }
      })();
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createSandboxServer().listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`clio-sandbox listening on :${PORT} (concurrency ${CONCURRENCY})`);
    if (!TOKEN) {
      // eslint-disable-next-line no-console
      console.warn('CLIO_SANDBOX_TOKEN is not set — all /run and /readiness requests will be rejected');
    }
  });
}
