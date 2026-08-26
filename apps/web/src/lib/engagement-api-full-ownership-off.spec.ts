import { beforeEach, describe, expect, it, vi } from 'vitest';

// Explicit false — the DEFAULT everywhere until the promotion runbook's
// Gates P1-P5 are complete. Proves the new flag existing does not change
// behavior for every deployment that never sets it.
vi.mock('../env.js', () => ({ isVNextSurface: true, isEngagementApiFullOwnership: false }));

import {
  engagementPreviewHeader,
  isOutreachV3ApiRequest,
} from './engagement-api-preview.js';

const BASE = 'https://os.capiro.test';

beforeEach(() => window.sessionStorage.clear());

describe('engagement-api full ownership OFF (default) — behavior is unchanged from Phase 3', () => {
  it('does NOT auto-route Meetings', () => {
    expect(engagementPreviewHeader('/api/engagement/meetings', BASE)).toBeNull();
  });

  it('does NOT auto-route Reports', () => {
    expect(engagementPreviewHeader('/api/engagement/reports/overview', BASE)).toBeNull();
  });

  it('still auto-routes Outreach V3 exactly as before — full ownership is additive, never subtractive', () => {
    const generation =
      '/api/engagement/outreach-v3/sessions/00000000-0000-4000-8000-000000000001/generation/plan';
    expect(isOutreachV3ApiRequest(generation, BASE)).toBe(true);
    expect(engagementPreviewHeader(generation, BASE)).not.toBeNull();
  });
});
