import { describe, expect, it } from '@jest/globals';
import type { Request } from 'express';
import {
  coreRosterPreviewDecision, isPreviewNativeReadRoute, previewNativeReadMode,
} from './preview-native-read-mode.js';

function request(method: string, path: string, originalUrl = path): Request {
  return { method, path, originalUrl, url: originalUrl } as Request;
}

describe('preview native memory route predicate', () => {
  it.each([
    '/api/memory/candidates/mine',
    '/api/memory/candidates/mine?limit=25',
    '/api/memory/candidates/mine/11111111-1111-4111-8111-111111111111/status',
    '/api/memory/owner/items',
    '/API/MEMORY/OWNER/ITEMS/',
  ])('matches only the exact GET handler shape (%s)', (target) => {
    const path = target.split('?')[0]!;
    expect(isPreviewNativeReadRoute(request('GET', path, target))).toBe(true);
    expect(isPreviewNativeReadRoute(request('HEAD', path, target))).toBe(true);
  });

  it('recognizes a parsed memory GET when Node receives an absolute-form target', () => {
    expect(isPreviewNativeReadRoute(request(
      'GET', '/api/memory/owner/items',
      'http://first-chat-preview.app-dev.capiro.ai/api/memory/owner/items',
    ))).toBe(true);
  });

  it.each([
    ['GET', '/api/memory/candidates'],
    ['GET', '/api/memory/candidates/mine/other'],
    ['GET', '/api/memory/candidates/mine/other/status/extra'],
    ['GET', '/api/memory/owner/items/other'],
    ['POST', '/api/memory/candidates/mine'],
    ['POST', '/api/memory/candidates/other/owner-decision'],
    ['PUT', '/api/memory/owner/items'],
  ])('does not allocate nearby or mutation route %s %s', (method, path) => {
    expect(isPreviewNativeReadRoute(request(method, path))).toBe(false);
  });

  it('requires both the exact preview Host and its enabled setting', () => {
    const host = 'first-chat-preview.app-dev.capiro.ai';
    expect(previewNativeReadMode(true, host)).toBe('preview');
    expect(previewNativeReadMode(false, host)).toBe('unavailable');
    expect(previewNativeReadMode(true, 'app.capiro.ai')).toBe('unavailable');
    expect(previewNativeReadMode(true, `${host}:443`)).toBe('unavailable');
    expect(previewNativeReadMode(false, 'app.capiro.ai')).toBe('ordinary');
  });
});

const rosterHost = 'core-roster-preview.capiro.ai';
function rosterRequest(
  method = 'GET', target = '/api/clients', host = rosterHost,
  parsedPath = target.split('?')[0]!, rawHosts: string[] = [host],
): Request {
  return {
    method, path: parsedPath, originalUrl: target, url: target,
    headers: { host }, rawHeaders: rawHosts.flatMap((value) => ['Host', value]),
  } as unknown as Request;
}

describe('Core roster preview exact Host and target decision', () => {
  it('allows only the origin-form roster GET with both task settings enabled', () => {
    expect(coreRosterPreviewDecision(rosterRequest(), true, true)).toBe('preview');
    expect(coreRosterPreviewDecision(rosterRequest('GET',
      '/api/clients?profileStatus=ACTIVE&sectorTag=defense&includeArchived=false'), true, true))
      .toBe('preview');
    expect(coreRosterPreviewDecision(rosterRequest(), false, true)).toBe('unavailable');
    expect(coreRosterPreviewDecision(rosterRequest(), true, false)).toBe('unavailable');
    expect(coreRosterPreviewDecision(rosterRequest(), false, false)).toBe('unavailable');
  });

  it.each([
    ['HEAD', '/api/clients', '/api/clients'],
    ['POST', '/api/clients', '/api/clients'],
    ['GET', '/api/clients/', '/api/clients/'],
    ['GET', '/api/clients/client-id', '/api/clients/client-id'],
    ['GET', '/api/me', '/api/me'],
    ['GET', '/api/memory/owner/items', '/api/memory/owner/items'],
    ['GET', '/health', '/health'],
    ['POST', '/webhooks/clerk', '/webhooks/clerk'],
    ['GET', '/api/internal/status', '/api/internal/status'],
    ['GET', 'http://core-roster-preview.capiro.ai/api/clients', '/api/clients'],
    ['GET', '//core-roster-preview.capiro.ai/api/clients', '/api/clients'],
    ['GET', '/api/%63lients', '/api/clients'],
    ['GET', '/api/clients', '/api/me'],
  ])('denies method/target ambiguity %s %s', (method, target, parsedPath) => {
    expect(coreRosterPreviewDecision(rosterRequest(method, target, rosterHost, parsedPath), true, true))
      .toBe('not-found');
  });

  it.each([
    rosterHost.toUpperCase(), `${rosterHost}:443`, `${rosterHost}.`,
    `${rosterHost}.evil.example`, `evil.example, ${rosterHost}`,
  ])('denies a malformed reserved Host (%s)', (host) => {
    expect(coreRosterPreviewDecision(rosterRequest('GET', '/api/clients', host), true, true))
      .toBe('not-found');
  });

  it('rejects duplicate or missing raw Host headers even when Node retains the exact parsed Host', () => {
    expect(coreRosterPreviewDecision(rosterRequest('GET', '/api/clients', rosterHost,
      '/api/clients', [rosterHost, 'portfolio-preview.app.capiro.ai']), true, true))
      .toBe('not-found');
    expect(coreRosterPreviewDecision(rosterRequest('GET', '/api/clients', rosterHost,
      '/api/clients', []), true, true)).toBe('not-found');
  });

  it('reserves an absolute-form roster target even when Host claims ordinary Portfolio', () => {
    expect(coreRosterPreviewDecision(rosterRequest('GET',
      `http://${rosterHost}/api/clients`, 'portfolio-preview.app.capiro.ai', '/api/clients'), true, true))
      .toBe('not-found');
  });

  it.each([
    '/api/clients?unknown=x',
    '/api/clients?sectorTag=defense&sectorTag=energy',
    '/api/clients?sectorTag=%XX',
    `/api/clients?sectorTag=${'a'.repeat(513)}`,
    '/api/clients?sectorTag=defense#fragment',
  ])('rejects unbounded or ambiguous query parsing (%s)', (target) => {
    expect(coreRosterPreviewDecision(rosterRequest('GET', target), true, true)).toBe('not-found');
  });

  it('keeps non-first-chat native GETs unavailable and ignores X-Forwarded-Host', () => {
    const portfolio = rosterRequest('GET', '/api/clients', 'portfolio-preview.app.capiro.ai');
    portfolio.headers['x-forwarded-host'] = rosterHost;
    expect(coreRosterPreviewDecision(portfolio, true, true)).toBe('unrelated');
    expect(previewNativeReadMode(true, portfolio.headers.host, true)).toBe('unavailable');
    expect(previewNativeReadMode(true, rosterHost, true)).toBe('unavailable');
    expect(previewNativeReadMode(true, 'other.example', true)).toBe('unavailable');
    expect(previewNativeReadMode(true, 'first-chat-preview.app-dev.capiro.ai', true)).toBe('preview');
  });
});
