import { describe, expect, it } from 'vitest';
import {
  canonicalEngagementLocation,
  engagementDestination,
  isVNextEngagementPath,
} from './engagement-route-state.js';

describe('vNext Engagement route state', () => {
  it('claims Outreach, Meetings and Library — the three destinations with a shipped vNext component — and nothing else yet', () => {
    expect(isVNextEngagementPath('/engagement/outreach')).toBe(true);
    expect(isVNextEngagementPath('/engagement/outreach/draft/123')).toBe(true);
    // Meetings shipped in an earlier phase (VNextMeetingsWorkspace) — the
    // bare module root and the meetings path itself are both claimed.
    expect(isVNextEngagementPath('/engagement')).toBe(true);
    expect(isVNextEngagementPath('/engagement/meetings')).toBe(true);

    // Library shipped this phase (VNextMeetingLibrary). Note the real Library
    // route is the flat `/engagement/meeting-library`, not nested under
    // `/engagement/meetings/` (see LIBRARY_PATH's comment).
    expect(isVNextEngagementPath('/engagement/meeting-library')).toBe(true);

    // Reports stays canonical until its own vNext component ships in a later
    // phase — see ENGAGEMENT_DESTINATION_READY.
    expect(isVNextEngagementPath('/engagement/reports')).toBe(false);

    // Unrelated paths are never claimed.
    expect(isVNextEngagementPath('/engagements')).toBe(false);
    expect(isVNextEngagementPath('/settings/integrations')).toBe(false);
  });

  it('recognizes the four rendered destinations regardless of rollout status', () => {
    expect(engagementDestination('/engagement')).toBe('meetings');
    expect(engagementDestination('/engagement/meetings')).toBe('meetings');
    expect(engagementDestination('/engagement/meeting-library')).toBe('library');
    expect(engagementDestination('/engagement/outreach/abc')).toBe('outreach');
    expect(engagementDestination('/engagement/reports')).toBe('reports');
  });

  it('keeps the hidden overview out of navigation', () => {
    expect(canonicalEngagementLocation('/engagement', '')).toBe('/engagement/meetings');
    expect(canonicalEngagementLocation('/engagement/overview', '?state=ready')).toBe(
      '/engagement/meetings',
    );
  });

  it('preserves old copied meeting links while canonicalizing their state', () => {
    expect(
      canonicalEngagementLocation(
        '/engagement/meetings/meeting%201',
        '?detail=notes&view=calendar&date=2026-08-18',
      ),
    ).toBe('/engagement/meetings?view=month&date=2026-08-18&meeting=meeting+1&tab=notes');
  });

  it('preserves native Outreach campaign ids and conversational step state', () => {
    expect(
      canonicalEngagementLocation('/engagement/outreach/campaign-1', '?step=context'),
    ).toBeNull();
    expect(engagementDestination('/engagement/outreach/campaign-1')).toBe('outreach');
  });
});
