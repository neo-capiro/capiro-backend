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
  // Wave 1 moved Client Relevance out of the route body into its own component;
  // the route composes it. The contract is that the section is REACHABLE from
  // the detail route, not that its markup lives in one particular file.
  const relevancePanel = source('../hearings/ClientRelevancePanel.tsx');
  const actions = source('../hearings/HearingActions.tsx');

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
    expect(detail).toContain('usePublicHearingTranscript');
    expect(detail).toContain('useHearingIntelligence');
    // Client relevance is composed from its own component (Wave 1 W1-6).
    expect(detail).toContain('<ClientRelevancePanel');
    expect(relevancePanel).toContain('aria-label="Client relevance"');
  });

  it('detail composes the Wave 1 Follow, Attend, relevance and action surfaces', () => {
    // Follow and Attend are DIFFERENT products and must stay two dialogs.
    expect(detail).toContain('<FollowDialog');
    expect(detail).toContain('<AttendDialog');
    expect(detail).toContain('<HearingActions');
    expect(actions).toContain('aria-label="Actions"');
  });

  it('the archive sub-view is reachable and routes results to canonical detail', () => {
    const archive = source('../hearings/ArchiveSubTab.tsx');
    expect(hearings).toContain('<ArchiveSubTab');
    expect(hearings).toContain("id: 'archive' as const");
    // Every archive result funnels to the ONE canonical destination.
    expect(archive).toContain('row.detailPath');
    expect(archive).not.toMatch(/navigate\('\/intelligence\/hearing-watch/);
  });

  it('the committee room offers following and intelligence history', () => {
    expect(committee).toContain('<CommitteeFollowControl');
    expect(committee).toContain('<CommitteeIntelligenceHistorySection');
  });
});
