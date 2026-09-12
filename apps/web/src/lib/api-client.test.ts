import { beforeEach, describe, expect, test } from 'vitest';
import type { AxiosRequestConfig } from 'axios';
import {
  DEFAULT_TIMEOUT_MS,
  GENERATION_TIMEOUT_MS,
  MAIL_TIMEOUT_MS,
  MEETING_PREP_TIMEOUT_MS,
  buildApiClient,
  isGenerationUrl,
  isMailThreadUrl,
  isMeetingPrepUrl,
} from './api-client.js';
import {
  activateEngagementPreview,
  clearEngagementPreview,
  ENGAGEMENT_PREVIEW_STORAGE_KEY,
} from './engagement-api-preview.js';
import {
  ENGAGEMENT_PREVIEW_ROUTE_MISS,
  ENGAGEMENT_PREVIEW_STALE_RESPONSE,
} from './engagement-preview-errors.js';

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
    const previewWasSent = headerOf(config, PREVIEW_HEADER_NAME) === 'v3';
    return {
      data: {},
      status: 200,
      statusText: 'OK',
      headers: previewWasSent ? { 'x-capiro-service': 'engagement-api' } : {},
      config,
    };
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

describe('meeting prep timeout', () => {
  test.each([
    '/api/engagement/meetings/m1/prep',
    '/api/engagement/meetings/m1/prep?mode=deep',
    'https://api.example.test/api/engagement/meetings/m1/prep/',
  ])('recognizes the exact generation route: %s', (url) => {
    expect(isMeetingPrepUrl(url)).toBe(true);
  });
  test.each([
    '/api/engagement/meetings/m1/prep-jobs/latest',
    '/api/engagement/meetings/m1/prep-monday-mapping',
    '/api/engagement/meeting-preps/p1/approve',
    undefined,
  ])('does not extend status, mapping or approval requests: %s', (url) => {
    expect(isMeetingPrepUrl(url)).toBe(false);
  });
  test('extends POST prep to 55 minutes without changing ordinary calls or explicit timeouts', async () => {
    const client = buildApiClient(async () => 'test-token');
    let captured: AxiosRequestConfig | undefined;
    client.defaults.adapter = async (config) => {
      captured = config;
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };
    await client.post('/api/engagement/meetings/m1/prep', {});
    expect(captured?.timeout).toBe(MEETING_PREP_TIMEOUT_MS);
    expect(MEETING_PREP_TIMEOUT_MS).toBe(55 * 60000);
    await client.post('/api/engagement/meetings/m1/prep', {}, { timeout: 5000 });
    expect(captured?.timeout).toBe(5000);
    await client.post('/api/engagement/meetings/m1/prep', {}, { timeout: 0 });
    expect(captured?.timeout).toBe(0);
    await client.get('/api/engagement/meetings/m1/prep-jobs/latest');
    expect(captured?.timeout).toBe(DEFAULT_TIMEOUT_MS);
  });
});

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
      // Outreach V3 draft generation. These are NOT matched by /generate/i —
      // "generation" is generat+ion — so they silently ran on the 30s default.
      // Observed live: "Generate samples" reported "timeout of 30000ms
      // exceeded" while the server had already persisted the drafts.
      '/api/engagement/outreach-v3/sessions/s1/generation/samples',
      '/api/engagement/outreach-v3/sessions/s1/generation/full',
      // "Refine with Meri": one governed gateway call, measured at 61s live.
      '/api/engagement/outreach-v3/sessions/s1/drafts/a1/refine',
      // Strategy Execution Agent execute/resume (F03): Meri draft + external
      // staging hop. Observed live: "timeout of 30000ms exceeded" while the
      // server completed and the UI kept inviting a second Execute plan.
      '/strategy-api/agents/execution/runs/run-1/execute',
      '/strategy-api/agents/execution/runs/run-1/resume',
      '/strategy-api/agents/execution/runs/run-1/resume?force=1',
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
      // Execution list/policy/cancel are fast — only execute/resume escalate.
      '/strategy-api/agents/execution/runs',
      '/strategy-api/agents/execution/runs/run-1/policy',
      '/strategy-api/agents/execution/runs/run-1/cancel',
      '/strategy-api/agents/execution/plan',
      undefined,
    ];
    for (const url of ordinaryUrls) {
      expect(isGenerationUrl(url), String(url)).toBe(false);
    }
  });
});

describe('isMailThreadUrl', () => {
  test('matches full mail-thread reads (get the longer timeout)', () => {
    const mailUrls = [
      '/api/engagement/mail-threads',
      '/api/engagement/mail-threads/thread-1',
    ];
    for (const url of mailUrls) {
      expect(isMailThreadUrl(url), url).toBe(true);
    }
  });

  test('does not match ordinary endpoints (keep the tight default)', () => {
    const ordinaryUrls = ['/api/clients', '/api/engagement/meetings', undefined];
    for (const url of ordinaryUrls) {
      expect(isMailThreadUrl(url), String(url)).toBe(false);
    }
  });

  test('escalates a mail-thread request timeout, without touching the generation escalation', async () => {
    const client = buildApiClient(async () => 'test-token');
    let captured: AxiosRequestConfig | undefined;
    client.defaults.adapter = async (config) => {
      captured = config;
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    await client.get('/api/engagement/mail-threads/thread-1');
    expect(captured?.timeout).toBe(MAIL_TIMEOUT_MS);

    await client.get('/api/engagement/meetings');
    expect(captured?.timeout).toBe(DEFAULT_TIMEOUT_MS);
  });

  test('still honors an explicit per-request timeout on a mail-thread request', async () => {
    const client = buildApiClient(async () => 'test-token');
    let captured: AxiosRequestConfig | undefined;
    client.defaults.adapter = async (config) => {
      captured = config;
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };

    await client.get('/api/engagement/mail-threads/thread-1', { timeout: 5_000 });
    expect(captured?.timeout).toBe(5_000);
  });
});

/**
 * Phase 3 (3.3+3.4+3.9): the preview header is attached in the SAME interceptor
 * that owns the generation timeout, Clerk bearer and impersonation header,
 * every marked preview response must prove `engagement-api` service identity,
 * and a response whose dispatch mode is no longer current is discarded.
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

  test('rejects a preview success that lacks engagement-api service identity', async () => {
    activateEngagementPreview();
    const client = buildApiClient(async () => 'test-token');
    client.defaults.adapter = async (config) => ({
      data: { from: 'main' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    });

    await expect(client.get('/api/engagement/meetings')).rejects.toMatchObject({
      code: ENGAGEMENT_PREVIEW_ROUTE_MISS,
    });
  });

  test('rejects a preview response when preview is toggled off in flight', async () => {
    activateEngagementPreview();
    const client = buildApiClient(async () => 'test-token');
    client.defaults.adapter = async (config) => {
      expect(headerOf(config, PREVIEW_HEADER_NAME)).toBe('v3');
      clearEngagementPreview();
      return {
        data: { ok: true },
        status: 200,
        statusText: 'OK',
        headers: { 'x-capiro-service': 'engagement-api' },
        config,
      };
    };

    await expect(client.get('/api/engagement/meetings')).rejects.toMatchObject({
      code: ENGAGEMENT_PREVIEW_STALE_RESPONSE,
    });
  });
});
