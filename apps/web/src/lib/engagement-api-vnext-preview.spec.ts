import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({ isVNextSurface: true }));

import {
  ENGAGEMENT_PREVIEW_HEADER,
  ENGAGEMENT_PREVIEW_HEADER_VALUE,
  engagementPreviewHeader,
  isOutreachV3ApiRequest,
} from './engagement-api-preview.js';

const BASE = 'https://os.capiro.test';

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
