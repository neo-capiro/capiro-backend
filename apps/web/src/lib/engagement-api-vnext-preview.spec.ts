import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({ isVNextSurface: true }));

import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  ENGAGEMENT_PREVIEW_HEADER,
  ENGAGEMENT_PREVIEW_HEADER_VALUE,
  activateEngagementPreview,
  engagementPreviewHeader,
  isOutreachV3ApiRequest,
} from './engagement-api-preview.js';
import {
  ENGAGEMENT_PREVIEW_STALE_RESPONSE,
  assertEngagementRequestModeCurrent,
  markEngagementRequest,
} from './engagement-preview-errors.js';

const BASE = 'https://os.capiro.test';

function vnextResponse(mode: 'preview' | 'main'): AxiosResponse {
  const config = { headers: {} } as AxiosRequestConfig;
  markEngagementRequest(config, mode);
  return {
    data: {},
    status: 200,
    statusText: 'OK',
    headers: { 'x-capiro-service': 'engagement-api' },
    config: config as AxiosResponse['config'],
  };
}

beforeEach(() => window.sessionStorage.clear());

describe('vNext Outreach V3 automatic routing', () => {
  it('routes an exact V3 execution endpoint without moving Meetings or Reports', () => {
    const generation =
      '/api/engagement/outreach-v3/sessions/00000000-0000-4000-8000-000000000001/generation/plan';

    expect(isOutreachV3ApiRequest(generation, BASE)).toBe(true);
    expect(engagementPreviewHeader(generation, BASE)).toEqual({
      name: ENGAGEMENT_PREVIEW_HEADER,
      value: ENGAGEMENT_PREVIEW_HEADER_VALUE,
    });

    expect(engagementPreviewHeader('/api/engagement/meetings', BASE)).toBeNull();
    expect(engagementPreviewHeader('/api/engagement/reports/overview', BASE)).toBeNull();
  });

  it('fails closed for an unknown path under the V3 prefix', () => {
    expect(
      engagementPreviewHeader('/api/engagement/outreach-v3/not-a-real-route', BASE),
    ).toBeNull();
  });

  // Regression: template provenance 404 on os.capiro.ai.
  // The SPA called GET …/templates/provenance/:sessionId without the preview
  // header because the path was missing from the generated allowlist, so the
  // request hit main API where OutreachV3StateGuard returns 404 (flag off).
  // engagement-api (flag on) returns 200 with null for ordinary sessions.
  it('routes template provenance + the rest of the templates surface to engagement-api', () => {
    const provenance =
      '/api/engagement/outreach-v3/templates/provenance/24d50277-2202-414c-8965-a0962d2c48ad';
    expect(isOutreachV3ApiRequest(provenance, BASE)).toBe(true);
    expect(engagementPreviewHeader(provenance, BASE)).toEqual({
      name: ENGAGEMENT_PREVIEW_HEADER,
      value: ENGAGEMENT_PREVIEW_HEADER_VALUE,
    });

    for (const path of [
      '/api/engagement/outreach-v3/templates',
      '/api/engagement/outreach-v3/templates/from-session',
      '/api/engagement/outreach-v3/templates/from-scratch',
      '/api/engagement/outreach-v3/templates/00000000-0000-4000-8000-000000000099',
      '/api/engagement/outreach-v3/templates/00000000-0000-4000-8000-000000000099/use',
      '/api/engagement/outreach-v3/templates/00000000-0000-4000-8000-000000000099/duplicate',
      '/api/engagement/outreach-v3/templates/00000000-0000-4000-8000-000000000099/archive',
      '/api/engagement/outreach-v3/templates/00000000-0000-4000-8000-000000000099/publish',
      '/api/engagement/outreach-v3/templates/00000000-0000-4000-8000-000000000099/draft',
      '/api/engagement/outreach-v3/templates/00000000-0000-4000-8000-000000000099/versions/from-session',
    ]) {
      expect(engagementPreviewHeader(path, BASE)).toEqual({
        name: ENGAGEMENT_PREVIEW_HEADER,
        value: ENGAGEMENT_PREVIEW_HEADER_VALUE,
      });
    }
  });
});

describe('vNext Outreach V3 response freshness (regression: production incident)', () => {
  // The manual preview toggle is never engaged on the vNext surface, so a
  // 'preview'-dispatched response (attached automatically because
  // isVNextSurface is true) always looked "stale" against readEngagementPreviewMode()
  // and was discarded — even though the request just succeeded. This blocked
  // every new Outreach V3 session on os.capiro.ai.
  it('accepts a vNext-auto-dispatched preview response with the manual toggle untouched', () => {
    expect(() => assertEngagementRequestModeCurrent(vnextResponse('preview'))).not.toThrow();
  });

  it('still catches a genuine main-dispatched response no longer matching current mode', () => {
    // isVNextSurface only excuses the 'preview' side of the check; a request
    // dispatched as 'main' must still be held to the manual toggle so a real
    // toggle-driven race (rare on vNext, but not impossible) is still caught.
    activateEngagementPreview();
    try {
      expect(() => assertEngagementRequestModeCurrent(vnextResponse('main'))).toThrowError(
        expect.objectContaining({ code: ENGAGEMENT_PREVIEW_STALE_RESPONSE }),
      );
    } finally {
      window.sessionStorage.clear();
    }
  });
});
