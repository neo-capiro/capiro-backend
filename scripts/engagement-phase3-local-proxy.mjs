#!/usr/bin/env node
/**
 * Local equivalent of the Phase 2 ALB preview rule.
 *
 * Only /api/engagement[/...] + exact X-Capiro-Engagement-Preview:v3 goes to
 * engagement-api. Every other request goes to main. The preview header is
 * forwarded unchanged so the browser exercises the same request contract as
 * live ALB routing.
 *
 * An OPTIONAL in-memory fault controller may be supplied by the local
 * resilience verifier. It is never enabled by the normal runner and exposes no
 * HTTP control endpoint, so production/web code cannot arm a fault.
 */
import http from 'node:http';
import { phase3FaultJsonBody } from './engagement-phase3-faults.mjs';

export const LOCAL_PROXY_PREVIEW_HEADER = 'x-capiro-engagement-preview';
export const LOCAL_PROXY_PREVIEW_VALUE = 'v3';

export function isEngagementProxyPath(url) {
  const pathname = String(url ?? '').split('?')[0];
  return pathname === '/api/engagement' || pathname.startsWith('/api/engagement/');
}

export function exactPreviewHeader(headers) {
  const raw = headers?.[LOCAL_PROXY_PREVIEW_HEADER];
  if (Array.isArray(raw)) return raw.length === 1 && raw[0] === LOCAL_PROXY_PREVIEW_VALUE;
  return raw === LOCAL_PROXY_PREVIEW_VALUE;
}

export function choosePhase3ProxyTarget({ url, headers, mainPort = 4000, engagementPort = 4500 }) {
  const preview = isEngagementProxyPath(url) && exactPreviewHeader(headers);
  return {
    owner: preview ? 'engagement-api' : 'main-api',
    port: preview ? engagementPort : mainPort,
  };
}

function responseStillWritable(res) {
  return !res.destroyed && !res.writableEnded && res.socket?.destroyed !== true;
}

function applyFault(req, res, fault) {
  const run = () => {
    // A timeout test deliberately aborts the client before a delayed fault is
    // emitted. Never turn that expected abort into an uncaught write-after-close
    // exception inside the proxy process.
    if (!responseStillWritable(res)) return;

    if (fault.action === 'reset') {
      req.socket.destroy();
      return;
    }

    const headers = {
      'cache-control': 'no-store',
      ...fault.headers,
    };
    if (fault.action === 'malformed_json' || fault.action === 'partial_response') {
      headers['content-type'] = headers['content-type'] ?? 'application/json';
    }

    if (fault.action === 'partial_response') {
      res.writeHead(fault.status ?? 200, headers);
      res.write(fault.fragment);
      // Destroy after bytes have left the process: callers must distinguish a
      // partial body from a clean, complete JSON response.
      setImmediate(() => {
        if (responseStillWritable(res)) res.destroy();
      });
      return;
    }

    if (fault.action === 'malformed_json') {
      res.writeHead(fault.status ?? 200, headers);
      res.end(fault.fragment || '{"malformed":');
      return;
    }

    const body = phase3FaultJsonBody(fault);
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    res.writeHead(fault.status, headers);
    res.end(body);
  };

  if (fault.delayMs > 0) setTimeout(run, fault.delayMs);
  else run();
}

export function createPhase3Proxy({
  host = '127.0.0.1',
  port = 4600,
  mainPort = 4000,
  engagementPort = 4500,
  onDecision = () => {},
  faultController = null,
} = {}) {
  const server = http.createServer((req, res) => {
    const target = choosePhase3ProxyTarget({
      url: req.url,
      headers: req.headers,
      mainPort,
      engagementPort,
    });
    const fault = faultController?.match?.({
      method: req.method,
      url: req.url,
      headers: req.headers,
      owner: target.owner,
    });
    onDecision({
      method: req.method,
      url: req.url,
      owner: target.owner,
      faultId: fault?.id ?? null,
    });

    if (fault) {
      applyFault(req, res, fault);
      return;
    }

    const upstream = http.request(
      {
        hostname: host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${host}:${target.port}` },
      },
      (upstreamRes) => {
        if (!responseStillWritable(res)) {
          upstreamRes.destroy();
          return;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (!responseStillWritable(res)) return;
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      res.end(
        JSON.stringify({
          statusCode: 502,
          code: 'ENGAGEMENT_PHASE3_LOCAL_PROXY_UPSTREAM',
          message: error.message,
        }),
      );
    });
    req.pipe(upstream);
  });

  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      return `http://${host}:${port}`;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
