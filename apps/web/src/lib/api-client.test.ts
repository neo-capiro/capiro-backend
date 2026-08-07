import { beforeEach, describe, expect, test } from 'vitest';
import type { AxiosRequestConfig } from 'axios';
import { DEFAULT_TIMEOUT_MS, GENERATION_TIMEOUT_MS, buildApiClient, isGenerationUrl } from './api-client.js';
import {
  activateEngagementPreview,
  ENGAGEMENT_PREVIEW_STORAGE_KEY,
} from './engagement-api-preview.js';

/**
 * Drive the real request interceptor by swapping in an adapter that captures
 * the resolved config. Nothing here reaches the network.
 */
async function captureRequest(
  url: string,
  options: { actAsTenantSlug?: string; token?: string | null; timeout?: number } = {},
): Promise<AxiosRequestConfig> {
  const client = buildApiClient(
    async () => (options.token === undefined ? 'test-token' : options.token),
    options.actAsTenantSlug,
  );
  let captured: AxiosRequestConfig | undefined;
  client.defaults.adapter = async (config) => {
    captured = config;
    return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
  };
  await client.get(url, options.timeout ? { timeout: options.timeout } : undefined);
  if (!captured) throw new Error('adapter never ran');
  return captured;
}

function headerOf(config: AxiosRequestConfig, name: string): unknown {
  const headers = config.headers as Record<string, unknown> | undefined;
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

const PREVIEW_HEADER_NAME = 'x-capiro-engagement-preview';

describe('isGenerationUrl', () => {
  test('matches AI content-generation endpoints (get the long timeout)', () => {
    const generationUrls = [
      '/api/engagement/outreach/generate-batch',
      '/api/intelligence/actions/generate',
      '/api/intelligence/actions/xyz/artifacts',
      '/api/engagement/attachments/abc/extract-text',
      '/api/clio/research/abc/clarify',
      // In-editor Meri assistant: bounded multi-round Sonnet+tool loop, runs
      // well past the 30s default on a "thinking" turn (regression guard).
      '/api/workspace/assistant',
      // "Let Meri draft an edit": single AI rewrite, can exceed 30s.
      '/api/workspace/documents/doc123/comments/c456/suggest',
    ];
    for (const url of generationUrls) {
      expect(isGenerationUrl(url), url).toBe(true);
    }
  });

  test('does not match ordinary fast endpoints (keep the tight default)', () => {
    const ordinaryUrls = [
      '/api/clients',
      '/api/engagement/outreach/audiences',
      '/api/intelligence/changes',
      // Ordinary workspace CRUD must stay on the tight 30s default.
      '/api/workspace/drafts/abc',
      '/api/workspace/documents/doc123/comments',
      undefined,
    ];
    for (const url of ordinaryUrls) {
      expect(isGenerationUrl(url), String(url)).toBe(false);
    }
  });
});

/**
 * Phase 3 (3.3): the preview header is attached in the SAME interceptor that
 * owns the generation timeout, the Clerk bearer and the impersonation header.
 * These tests exist to prove the addition disturbs none of them.
 */
describe('engagement API preview header', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test('is absent by default on an Engagement request', async () => {
    const config = await captureRequest('/api/engagement/meetings');
    expect(headerOf(config, PREVIEW_HEADER_NAME)).toBeUndefined();
  });

  test('is attached to an Engagement request while the preview is on', async () => {
    activateEngagementPreview();
    const config = await captureRequest('/api/engagement/meetings');
    expect(headerOf(config, PREVIEW_HEADER_NAME)).toBe('v3');
  });

  test.each([
    '/api/me',
    '/api/clients',
    '/api/capiro-admin/tenants',
    '/api/workspace/documents',
    '/api/strategy/plans',
    '/api/directory/members',
    '/api/engagement-something-else',
  ])('is NOT attached to %s while the preview is on', async (url) => {
    activateEngagementPreview();
    const config = await captureRequest(url);
    expect(headerOf(config, PREVIEW_HEADER_NAME)).toBeUndefined();
  });

  test('fails closed on an unknown stored value', async () => {
    window.sessionStorage.setItem(ENGAGEMENT_PREVIEW_STORAGE_KEY, 'V3');
    const config = await captureRequest('/api/engagement/meetings');
    expect(headerOf(config, PREVIEW_HEADER_NAME)).toBeUndefined();
  });

  test('leaves the Clerk bearer and impersonation header intact', async () => {
    activateEngagementPreview();
    const config = await captureRequest('/api/engagement/meetings', {
      actAsTenantSlug: 'acme',
    });
    expect(headerOf(config, 'Authorization')).toBe('Bearer test-token');
    expect(headerOf(config, 'x-capiro-impersonate-tenant')).toBe('acme');
    expect(headerOf(config, PREVIEW_HEADER_NAME)).toBe('v3');
  });

  test('keeps the admin-console impersonation suppression', async () => {
    activateEngagementPreview();
    const config = await captureRequest('/api/capiro-admin/tenants', {
      actAsTenantSlug: 'acme',
    });
    expect(headerOf(config, 'x-capiro-impersonate-tenant')).toBeUndefined();
    expect(headerOf(config, PREVIEW_HEADER_NAME)).toBeUndefined();
  });

  test('leaves the generation-timeout escalation intact', async () => {
    activateEngagementPreview();
    const generation = await captureRequest('/api/engagement/attachments/abc/extract-text');
    expect(generation.timeout).toBe(GENERATION_TIMEOUT_MS);

    const ordinary = await captureRequest('/api/engagement/meetings');
    expect(ordinary.timeout).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('still honors an explicit per-request timeout', async () => {
    activateEngagementPreview();
    const config = await captureRequest('/api/engagement/attachments/abc/extract-text', {
      timeout: 5_000,
    });
    expect(config.timeout).toBe(5_000);
  });

  test('attaches without a token present', async () => {
    activateEngagementPreview();
    const config = await captureRequest('/api/engagement/meetings', { token: null });
    expect(headerOf(config, 'Authorization')).toBeUndefined();
    expect(headerOf(config, PREVIEW_HEADER_NAME)).toBe('v3');
  });
});
