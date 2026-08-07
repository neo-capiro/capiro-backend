import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENGAGEMENT_PREVIEW_HEADER,
  ENGAGEMENT_PREVIEW_HEADER_VALUE,
  ENGAGEMENT_PREVIEW_STORAGE_KEY,
  activateEngagementPreview,
  clearEngagementPreview,
  consumePreviewActivation,
  engagementPreviewHeader,
  isEngagementApiRequest,
  isEngagementPreviewActive,
  readEngagementPreviewMode,
  resolveRequestPath,
} from './engagement-api-preview.js';
import {
  ENGAGEMENT_PREVIEW_ROUTE_COUNT,
  ENGAGEMENT_PREVIEW_ROUTE_PATTERNS,
} from './engagement-api-preview-routes.generated.js';

const BASE = 'https://app.capiro.test';

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('mode', () => {
  it('is off by default', () => {
    expect(readEngagementPreviewMode()).toBe('off');
    expect(isEngagementPreviewActive()).toBe(false);
  });

  it('turns on for exactly v3', () => {
    activateEngagementPreview();
    expect(readEngagementPreviewMode()).toBe('v3');
    expect(window.sessionStorage.getItem(ENGAGEMENT_PREVIEW_STORAGE_KEY)).toBe('v3');
  });

  it('clears', () => {
    activateEngagementPreview();
    clearEngagementPreview();
    expect(readEngagementPreviewMode()).toBe('off');
  });

  // Fails closed: a value that merely resembles the activation value is off.
  it.each(['V3', 'v3 ', 'true', '1', 'on', '', 'V3;v3'])('fails closed for %o', (stored) => {
    window.sessionStorage.setItem(ENGAGEMENT_PREVIEW_STORAGE_KEY, stored);
    expect(readEngagementPreviewMode()).toBe('off');
  });
});

describe('consumePreviewActivation', () => {
  it('activates on the exact value and removes only that parameter', () => {
    const result = consumePreviewActivation('?engagement-api-preview=v3');
    expect(result.mode).toBe('v3');
    expect(result.changed).toBe(true);
    expect(result.nextSearch).toBe('');
  });

  it('deactivates on off', () => {
    activateEngagementPreview();
    const result = consumePreviewActivation('?engagement-api-preview=off');
    expect(result.mode).toBe('off');
    expect(result.changed).toBe(true);
  });

  it('ignores an unknown value without changing a running preview', () => {
    activateEngagementPreview();
    const result = consumePreviewActivation('?engagement-api-preview=v4');
    expect(result.mode).toBe('v3');
    expect(result.changed).toBe(true);
    expect(result.nextSearch).toBe('');
  });

  it('ignores an unknown value without turning the preview on', () => {
    const result = consumePreviewActivation('?engagement-api-preview=yes');
    expect(result.mode).toBe('off');
  });

  it('is inert when the parameter is absent', () => {
    const result = consumePreviewActivation('?meeting=abc&tab=notes');
    expect(result.changed).toBe(false);
    expect(result.nextSearch).toBe('?meeting=abc&tab=notes');
  });

  // The contract: meeting IDs, detail tabs, dates, report filters, client
  // filters and unrelated parameters all survive activation.
  it('preserves every other query parameter and their order', () => {
    const result = consumePreviewActivation(
      '?meeting=m-1&engagement-api-preview=v3&tab=debrief&from=2026-01-01&client=c-9',
    );
    expect(result.mode).toBe('v3');
    expect(result.nextSearch).toBe('?meeting=m-1&tab=debrief&from=2026-01-01&client=c-9');
  });

  it('removes duplicated activation parameters entirely', () => {
    const result = consumePreviewActivation(
      '?engagement-api-preview=v3&meeting=m-1&engagement-api-preview=off',
    );
    expect(result.nextSearch).toBe('?meeting=m-1');
  });

  it('accepts a search string without the leading question mark', () => {
    const result = consumePreviewActivation('engagement-api-preview=v3&meeting=m-1');
    expect(result.mode).toBe('v3');
    expect(result.nextSearch).toBe('?meeting=m-1');
  });
});

describe('isEngagementApiRequest', () => {
  it('matches manifest routes, relative and absolute', () => {
    expect(isEngagementApiRequest('/api/engagement/meetings', BASE)).toBe(true);
    expect(isEngagementApiRequest(`${BASE}/api/engagement/meetings`, BASE)).toBe(true);
    expect(isEngagementApiRequest('/api/engagement/capabilities', BASE)).toBe(true);
  });

  it('matches parameterized routes at any depth', () => {
    expect(isEngagementApiRequest('/api/engagement/meetings/m-1', BASE)).toBe(true);
    expect(isEngagementApiRequest('/api/engagement/meetings/m-1/debriefs/d-2', BASE)).toBe(true);
  });

  it('ignores the query string and a trailing slash', () => {
    expect(isEngagementApiRequest('/api/engagement/meetings?from=2026-01-01', BASE)).toBe(true);
    expect(isEngagementApiRequest('/api/engagement/meetings/', BASE)).toBe(true);
  });

  // The reason this is a pattern list and not a prefix test.
  it('does not match a look-alike prefix', () => {
    expect(isEngagementApiRequest('/api/engagement-something-else', BASE)).toBe(false);
    expect(isEngagementApiRequest('/api/engagementx/meetings', BASE)).toBe(false);
  });

  it('does not match an unknown path under the real prefix', () => {
    expect(isEngagementApiRequest('/api/engagement/not-a-real-route', BASE)).toBe(false);
    expect(isEngagementApiRequest('/api/engagement/meetings/m-1/not-a-subroute', BASE)).toBe(false);
  });

  // Negative control: /not-engagement/... receives no header.
  it.each([
    '/me',
    '/api/me',
    '/not-engagement/meetings',
    '/api/capiro-admin/tenants',
    '/api/clients',
    '/api/directory/members',
    '/workspace-api/documents',
    '/strategy-api/plans',
    '/assets/index-abc123.js',
    '/runtime-config.js',
  ])('rejects non-Engagement request %s', (url) => {
    expect(isEngagementApiRequest(url, BASE)).toBe(false);
  });

  it('rejects the two manifest paths deliberately excluded from preview', () => {
    expect(isEngagementApiRequest('/api/internal/ai-credentials/resolve', BASE)).toBe(false);
    expect(isEngagementApiRequest('/webhooks/recall', BASE)).toBe(false);
  });

  it('fails closed on an unresolvable or absent URL', () => {
    expect(isEngagementApiRequest(undefined, BASE)).toBe(false);
    expect(isEngagementApiRequest('', BASE)).toBe(false);
    expect(isEngagementApiRequest('http://', BASE)).toBe(false);
  });

  it('resolves relative URLs when no base is configured', () => {
    expect(resolveRequestPath('/api/engagement/meetings')).toBe('/api/engagement/meetings');
    expect(isEngagementApiRequest('/api/engagement/meetings')).toBe(true);
  });

  it('resolves against a base that carries a path', () => {
    expect(isEngagementApiRequest('/api/engagement/meetings', 'https://app.capiro.test/x')).toBe(
      true,
    );
  });
});

describe('engagementPreviewHeader', () => {
  it('returns nothing while the mode is off, even for an Engagement route', () => {
    expect(engagementPreviewHeader('/api/engagement/meetings', BASE)).toBeNull();
  });

  // The literals are asserted here, not just referenced: the header name and
  // value are a contract with the Phase 2 ALB preview rule, which matches them
  // exactly. A rename that only touched the constant would otherwise pass every
  // test in this file and fail only in a live environment.
  it('returns the exact header for an Engagement route while on', () => {
    activateEngagementPreview();
    expect(engagementPreviewHeader('/api/engagement/meetings', BASE)).toEqual({
      name: 'X-Capiro-Engagement-Preview',
      value: 'v3',
    });
    expect(ENGAGEMENT_PREVIEW_HEADER).toBe('X-Capiro-Engagement-Preview');
    expect(ENGAGEMENT_PREVIEW_HEADER_VALUE).toBe('v3');
  });

  // Negative control: header on /me fails.
  it('returns nothing for /me and the admin console while on', () => {
    activateEngagementPreview();
    expect(engagementPreviewHeader('/api/me', BASE)).toBeNull();
    expect(engagementPreviewHeader('/api/capiro-admin/tenants', BASE)).toBeNull();
  });
});

describe('generated pattern list', () => {
  it('is non-empty, anchored, and self-consistent', () => {
    expect(ENGAGEMENT_PREVIEW_ROUTE_PATTERNS.length).toBe(ENGAGEMENT_PREVIEW_ROUTE_COUNT);
    expect(ENGAGEMENT_PREVIEW_ROUTE_COUNT).toBeGreaterThan(0);
    for (const pattern of ENGAGEMENT_PREVIEW_ROUTE_PATTERNS) {
      expect(pattern.startsWith('^/api/engagement/')).toBe(true);
      expect(pattern.endsWith('$')).toBe(true);
    }
  });

  it('has no duplicate patterns', () => {
    expect(new Set(ENGAGEMENT_PREVIEW_ROUTE_PATTERNS).size).toBe(
      ENGAGEMENT_PREVIEW_ROUTE_PATTERNS.length,
    );
  });
});

describe('storage failure', () => {
  it('treats an unreadable sessionStorage as off rather than throwing', () => {
    const spy = vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readEngagementPreviewMode()).toBe('off');
    expect(() => engagementPreviewHeader('/api/engagement/meetings', BASE)).not.toThrow();
    spy.mockRestore();
  });
});

/**
 * Static assertions on the route table. 3.3 must not duplicate the Engagement
 * page or change its path — the whole point is that ONE existing UI code path
 * serves both modes. A duplicate registration would type-check and render fine
 * while quietly giving preview its own component tree, which is exactly the
 * false parity Phase 3 exists to prevent.
 */
describe('App route registration', () => {
  const appSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../App.tsx'),
    'utf8',
  );

  it('registers EngagementPage exactly once', () => {
    const registrations = appSource.match(/element=\{<EngagementPage\s*\/>\}/g) ?? [];
    expect(registrations).toHaveLength(1);
  });

  it('keeps the Engagement SPA route at /engagement/*', () => {
    expect(appSource).toContain('<Route path="/engagement/*" element={<EngagementPage />} />');
  });

  it('mounts the preview boundary exactly once', () => {
    const mounts = appSource.match(/<EngagementPreviewBoundary\s*\/>/g) ?? [];
    expect(mounts).toHaveLength(1);
  });
});
