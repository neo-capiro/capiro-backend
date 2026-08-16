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
