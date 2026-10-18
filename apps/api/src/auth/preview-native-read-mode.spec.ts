import { describe, expect, it } from '@jest/globals';
import type { Request } from 'express';
import { isPreviewNativeReadRoute, previewNativeReadMode } from './preview-native-read-mode.js';

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
