#!/usr/bin/env node
/**
 * Local equivalent of the Phase 2 ALB preview rule.
 *
 * Only /api/engagement[/...] + exact X-Capiro-Engagement-Preview:v3 goes to
 * engagement-api. Every other request goes to main. The preview header is
 * forwarded unchanged so the browser exercises the same request contract as
 * live ALB routing.
 */
import http from 'node:http';

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

export function createPhase3Proxy({
  host = '127.0.0.1',
  port = 4600,
  mainPort = 4000,
  engagementPort = 4500,
  onDecision = () => {},
} = {}) {
  const server = http.createServer((req, res) => {
    const target = choosePhase3ProxyTarget({
      url: req.url,
      headers: req.headers,
      mainPort,
      engagementPort,
    });
    onDecision({ method: req.method, url: req.url, owner: target.owner });

    const upstream = http.request(
      {
        hostname: host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${host}:${target.port}` },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ statusCode: 502, code: 'ENGAGEMENT_PHASE3_LOCAL_PROXY_UPSTREAM', message: error.message }));
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
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
