/**
 * Clio analysis sandbox runner (assistant-parity F4).
 *
 * A deliberately tiny, zero-dependency HTTP service that executes
 * model-written Python in a hardened child process. Deployed as its own
 * Fargate service with a no-egress security group and a zero-permission task
 * role (docs/adr/0001-clio-analysis-sandbox-isolation.md). The API calls it
 * VPC-internally with a shared bearer token.
 *
 * Endpoints:
 *   GET  /healthz          → { ok: true }
 *   POST /run (bearer)     → SandboxRunResult (queued; bounded concurrency)
 */
import { createServer } from 'node:http';
import { runSandboxed, validateRunRequest, type SandboxRunResult } from './run.js';

const PORT = Number(process.env.PORT ?? 4100);
const TOKEN = process.env.CLIO_SANDBOX_TOKEN ?? '';
const CONCURRENCY = Math.max(1, Number(process.env.CLIO_SANDBOX_CONCURRENCY ?? 2));
const MAX_QUEUE = 20;
const MAX_BODY_BYTES = 8 * 1024 * 1024;

let active = 0;
const queue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (active < CONCURRENCY) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUE) {
      reject(new Error('sandbox queue is full'));
      return;
    }
    queue.push(() => {
      active += 1;
      resolve();
    });
  });
}

function releaseSlot(): void {
  active -= 1;
  const next = queue.shift();
  if (next) next();
}

function send(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    send(res, 200, { ok: true, active, queued: queue.length });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/run') {
    send(res, 404, { error: 'not found' });
    return;
  }
  if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) {
    send(res, 401, { error: 'unauthorized' });
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
        const result: SandboxRunResult = await runSandboxed(validation.req);
        send(res, 200, result);
      } catch (err) {
        send(res, 500, { error: err instanceof Error ? err.message : 'sandbox failure' });
      } finally {
        releaseSlot();
      }
    })();
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`clio-sandbox listening on :${PORT} (concurrency ${CONCURRENCY})`);
  if (!TOKEN) {
    // eslint-disable-next-line no-console
    console.warn('CLIO_SANDBOX_TOKEN is not set — all /run requests will be rejected');
  }
});
