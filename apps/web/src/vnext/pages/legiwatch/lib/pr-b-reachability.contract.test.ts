/**
 * PR B reachability contract (LW-QA-003/004/§11).
 * Source-level assertions — same posture as figma-strategy-legiwatch-contract.
 * Guarantees the detail/committee routes stay wired from every entry surface
 * and that the honest-state helpers stay imported by the detail route.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

describe('PR B reachability contract (LW-QA-003/004)', () => {
  const routes = source('../VNextLegiWatchRoutes.tsx');
  const hearings = source('../hearings/HearingsTab.tsx');
  const detail = source('../hearings/HearingDetailRoute.tsx');
  const committee = source('../hearings/CommitteeRoomRoute.tsx');
  const feed = source('../feed/FeedTab.tsx');

  it('registers detail + committee routes BEFORE the catch-all', () => {
    expect(routes).toContain('path="/legiwatch/hearings/:hearingId"');
    expect(routes).toContain('path="/legiwatch/committees/:systemCode"');
    const detailIdx = routes.indexOf('path="/legiwatch/hearings/:hearingId"');
    const catchIdx = routes.indexOf('path="/legiwatch/*"');
    expect(detailIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(detailIdx);
  });

  it('calendar chips + list rows + history rows open the detail route', () => {
    expect(hearings).toContain("navigate(`/legiwatch/hearings/${encodeURIComponent(e.id)}`)");
    expect(hearings).toMatch(/openHearing/);
    // My Sessions history is keyboard-reachable and prefers hearingId → detail.
    expect(hearings).toMatch(/onKeyDown/);
    expect(hearings).toContain("navigate(`/legiwatch/hearings/${encodeURIComponent(s.hearingId)}`)");
  });

  it('list rows link the committee room; detail links back', () => {
    expect(hearings).toContain('/legiwatch/committees/');
    expect(detail).toContain('/legiwatch/committees/');
    expect(committee).toContain('/legiwatch/hearings/');
  });

  it('feed rows deep-link via the bounded resolver (never title fuzzy)', () => {
    expect(feed).toContain("from '../lib/feed-hearing-link.js'");
    expect(feed).toContain('feedHearingDetailHref');
    // The hearing deep-link resolution itself must never consult `it.title`.
    expect(feed).not.toMatch(/hearingHref\s*=\s*feedHearingDetailHref\([^)]*title/);
  });

  it('detail route uses the shared state helpers (UNKNOWN ≠ CLOSED)', () => {
    expect(detail).toContain("from '../lib/hearing-detail-states.js'");
    expect(detail).toContain('isClosedSession');
    expect(detail).toContain('accessPillLabel');
    expect(detail).toContain('transcriptAvailability');
    // Regression: UNKNOWN must never be folded into the closed-session branch.
    expect(detail).not.toMatch(/CLOSED.*PRIVATE.*UNKNOWN|UNKNOWN.*CLOSED SESSION/);
  });

  it('detail surfaces transcript + intelligence + client relevance sections', () => {
    expect(detail).toContain('aria-label="Transcript"');
    expect(detail).toContain('aria-label="Intelligence"');
    expect(detail).toContain('aria-label="Client relevance"');
    expect(detail).toContain('usePublicHearingTranscript');
    expect(detail).toContain('useHearingIntelligence');
  });
});
