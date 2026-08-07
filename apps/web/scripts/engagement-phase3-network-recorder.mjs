#!/usr/bin/env node
/** Pure network-contract helpers used by the Phase 3 browser parity harness. */

export const PREVIEW_HEADER = 'x-capiro-engagement-preview';
export const PREVIEW_VALUE = 'v3';
export const SERVICE_HEADER = 'x-capiro-service';
export const SERVICE_VALUE = 'engagement-api';

export function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? value.join(',') : value;
}

export function requestPath(url) {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return '';
  }
}

export function isEngagementRequest(url) {
  const pathname = requestPath(url);
  return pathname === '/api/engagement' || pathname.startsWith('/api/engagement/');
}

export function requestHasExactPreviewHeader(record) {
  return String(headerValue(record?.headers, PREVIEW_HEADER) ?? '') === PREVIEW_VALUE;
}

export function responseHasServiceIdentity(record) {
  return String(headerValue(record?.responseHeaders, SERVICE_HEADER) ?? '').toLowerCase() === SERVICE_VALUE;
}

export function sanitizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) => !/authorization|cookie|set-cookie/i.test(key)),
  );
}

export function sanitizeNetworkRecord(record) {
  return {
    mode: record.mode,
    surface: record.surface,
    requestId: record.requestId,
    method: record.method,
    url: record.url,
    status: record.status ?? null,
    headers: sanitizeHeaders(record.headers),
    responseHeaders: sanitizeHeaders(record.responseHeaders),
  };
}

/**
 * Assert the load-bearing routing contract against observed browser traffic.
 * `main` must never send the preview header. `preview` must send it on every
 * Engagement request and nowhere else. Every preview Engagement response must
 * identify `engagement-api`, including non-2xx responses.
 */
export function validateNetworkRecords(records) {
  const issues = [];
  for (const record of records) {
    const engagement = isEngagementRequest(record.url);
    const previewHeader = requestHasExactPreviewHeader(record);

    if (record.mode === 'main' && previewHeader) {
      issues.push(`main request sent preview header: ${record.method} ${record.url}`);
    }
    if (record.mode === 'preview') {
      if (engagement && !previewHeader) {
        issues.push(`preview Engagement request missed header: ${record.method} ${record.url}`);
      }
      if (!engagement && previewHeader) {
        issues.push(`preview header leaked to non-Engagement request: ${record.method} ${record.url}`);
      }
      if (engagement && record.status != null && !responseHasServiceIdentity(record)) {
        issues.push(
          `preview Engagement response missed service identity: ${record.method} ${record.url} status=${record.status}`,
        );
      }
    }
  }
  return issues;
}

export function assertNetworkRecords(records) {
  const issues = validateNetworkRecords(records);
  if (issues.length) throw new Error(`Phase 3 network contract failed:\n${issues.join('\n')}`);
}
