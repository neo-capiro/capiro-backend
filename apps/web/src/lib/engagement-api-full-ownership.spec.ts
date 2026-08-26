import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../env.js', () => ({ isVNextSurface: true, isEngagementApiFullOwnership: true }));

import {
  ENGAGEMENT_PREVIEW_HEADER,
  ENGAGEMENT_PREVIEW_HEADER_VALUE,
  activateEngagementPreview,
  engagementPreviewHeader,
  isOutreachV3ApiRequest,
} from './engagement-api-preview.js';

const BASE = 'https://os.capiro.test';

beforeEach(() => window.sessionStorage.clear());

describe('engagement-api full ownership auto-routing (opt-in, vNext only)', () => {
  it('auto-routes Meetings once full ownership is on — the exact route Phase 3 deliberately excluded', () => {
    expect(isOutreachV3ApiRequest('/api/engagement/meetings', BASE)).toBe(false);
    expect(engagementPreviewHeader('/api/engagement/meetings', BASE)).toEqual({
      name: ENGAGEMENT_PREVIEW_HEADER,
      value: ENGAGEMENT_PREVIEW_HEADER_VALUE,
    });
  });

  it('auto-routes Reports once full ownership is on', () => {
    expect(engagementPreviewHeader('/api/engagement/reports/overview', BASE)).toEqual({
      name: ENGAGEMENT_PREVIEW_HEADER,
      value: ENGAGEMENT_PREVIEW_HEADER_VALUE,
    });
  });

  it('still returns null for a path outside the accepted Engagement manifest, full ownership or not', () => {
    expect(engagementPreviewHeader('/api/me', BASE)).toBeNull();
    expect(engagementPreviewHeader('/api/capiro-admin/tenants', BASE)).toBeNull();
    expect(engagementPreviewHeader('/api/clients', BASE)).toBeNull();
  });

  it('still routes Outreach V3 the same way it always did (full ownership is additive, not a replacement)', () => {
    const generation =
      '/api/engagement/outreach-v3/sessions/00000000-0000-4000-8000-000000000001/generation/plan';
    expect(isOutreachV3ApiRequest(generation, BASE)).toBe(true);
    expect(engagementPreviewHeader(generation, BASE)).toEqual({
      name: ENGAGEMENT_PREVIEW_HEADER,
      value: ENGAGEMENT_PREVIEW_HEADER_VALUE,
    });
  });

  it('the manual toggle still works independently and is not made redundant', () => {
    // Even a route full ownership doesn't specially know about still routes,
    // as long as it is in the manifest, once the user has manually toggled.
    activateEngagementPreview();
    expect(engagementPreviewHeader('/api/engagement/meetings', BASE)).toEqual({
      name: ENGAGEMENT_PREVIEW_HEADER,
      value: ENGAGEMENT_PREVIEW_HEADER_VALUE,
    });
  });
});
