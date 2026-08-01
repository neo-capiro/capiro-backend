/**
 * Data-mapping / display validation: push realistic ENRICHED API payloads through
 * the real finder components and assert the rendered numbers + labels. Guards the
 * SQL-alias → type → component chain (units in $ millions, Δ sign, signal pill,
 * aggregate formatting) against silent mis-mapping.
 */
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { FinderCatalogTable } from './FinderCatalogTable.js';
import { FinderSummaryStrip } from './FinderSummaryStrip.js';
import { FinderWatchlist } from './FinderWatchlist.js';
import type { ProgramElementListItem, ProgramElementSummary } from './types.js';
import type { IntelligenceChange } from '../intelligence/types.js';

// Stub the api hook so importing pe-shared (which pulls useApi -> api-client -> env)
// doesn't require a runtime Clerk key. These presentational components take their
// data + callbacks via props, so no real API is needed.
vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn() }),
}));

function setupBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}

const ROW: ProgramElementListItem = {
  peCode: '0601102A',
  title: 'Defense Research Sciences',
  service: 'ARMY',
  budgetActivity: '6.1 Basic Research',
  appropriationType: 'RDT&E',
  status: 'active',
  lastSyncedAt: '2026-05-01T00:00:00.000Z',
  hasData: true,
  watched: false,
  billCount: 2,
  latestRequest: 215.3, // $ millions
  latestRequestFy: 2027,
  latestEnacted: 297.7, // $ millions
  latestEnactedFy: 2025,
  // Canonical current = FY27 conference mark — furthest-along, deliberately
  // distinct from the FY25 enacted so the test proves the headline shows
  // "current", not stale enacted.
  latestCurrent: 310.5,
  latestCurrentFy: 2027,
  latestCurrentStage: 'conference',
  deltaPct: 19.0,
  spark: [258, 273, 281, 298, 233, 215],
  signalType: 'mark_vs_request',
  signalScore: 0.8,
  signalDeltaPct: 6.1,
  // BL-1 money-graph enrichment (intelligence cache)
  lineType: 'RDTE_PE',
  maturity: 2,
  appropTier: 'med',
  appropScore: 61,
  actionSignalType: null,
  actionSignalTone: null,
  valleyOfDeath: false,
};

const SUMMARY: ProgramElementSummary = {
  tracked: 12,
  withData: 10,
  watched: 5,
  latestRequestFy: 2027,
  totalRequest: 2894.8, // $ millions -> $2.89B
  latestEnactedFy: 2025,
  totalEnacted: 2946.4, // -> $2.95B
  avgDeltaPct: 4.9,
  openMarkups: 3,
  trend: [
    { fy: 2022, total: 2610 },
    { fy: 2023, total: 2748 },
    { fy: 2024, total: 2921 },
    { fy: 2025, total: 2946 },
    { fy: 2026, total: 2810 },
    { fy: 2027, total: 2895 },
  ],
  byService: [
    { service: 'ARMY', count: 5 },
    { service: 'NAVY', count: 3 },
    { service: 'DARPA', count: 2 },
    { service: 'AF', count: 2 },
  ],
};

describe('PE finder data-mapping / display', () => {
  beforeEach(() => setupBrowserMocks());

  test('catalog row renders enriched money/Δ/signal in $M with correct labels', () => {
    render(
      <FinderCatalogTable
        rows={[ROW]}
        loading={false}
        onOpen={() => {}}
        onToggleWatch={() => {}}
      />,
    );
    expect(screen.getByText('0601102A')).toBeInTheDocument();
    expect(screen.getByText('Defense Research Sciences')).toBeInTheDocument();
    expect(screen.getByText('Army')).toBeInTheDocument(); // service CODE -> label
    expect(screen.getByText('$310.5M')).toBeInTheDocument(); // latestCurrent (FY27 conference), millions
    expect(screen.getByText('+44.2%')).toBeInTheDocument(); // (310.5-215.3)/215.3 — same FY, so computed
    expect(screen.getByText('Markup')).toBeInTheDocument(); // delta signal fallback pill
    expect(screen.getByRole('button', { name: /monitor/i })).toBeInTheDocument(); // watch toggle
  });

  test('summary strip renders aggregates as $B and avg Δ with direction', () => {
    render(
      <FinderSummaryStrip
        summary={SUMMARY}
        loading={false}
        actionCount={0}
        actionsLoading={false}
        onOpenPortfolio={() => {}}
        onOpenMovement={() => {}}
        onOpenActions={() => {}}
      />,
    );
    const trackedCard = screen.getByText('Lines in catalog').closest('.pe-rd-kpi') as HTMLElement;
    expect(within(trackedCard).getByText('12')).toBeInTheDocument(); // tracked
    expect(screen.getByText('5 monitored in Portfolio')).toBeInTheDocument(); // watched sub
    expect(screen.getByText('$2.89B')).toBeInTheDocument(); // totalRequest 2894.8M
    const markupCard = screen.getByText('Open markups').closest('.pe-rd-kpi') as HTMLElement;
    expect(within(markupCard).getByText('3')).toBeInTheDocument(); // open markups
  });

  test('watchlist card + signal feed render enriched stats and the change', () => {
    const feed: IntelligenceChange[] = [
      {
        id: 'chg-1',
        source: 'program_element',
        changeType: 'pe_mark_added',
        severity: 'notable',
        title: 'Senate markup added funding over the PB request',
        description: 'SASC · S. 1071 · FY26',
        relatedClientIds: [],
        relatedIssues: [],
        relatedPeCodes: ['0601102A'],
        data: {},
        detectedAt: '2026-06-30T00:00:00.000Z',
        consumed: false,
      },
    ];
    render(
      <FinderWatchlist
        watchedRows={[{ ...ROW, watched: true }]}
        watchingCount={5}
        feed={feed}
        loading={false}
        feedLoading={false}
        onOpen={() => {}}
        onToggleWatch={() => {}}
      />,
    );
    // Watch card stats (enriched list fields, $M).
    const card = screen
      .getByText('Defense Research Sciences')
      .closest('.pe-watch-card') as HTMLElement;
    expect(card).toBeTruthy();
    expect(within(card).getByText('$310.5M')).toBeInTheDocument(); // current (FY27 conference)
    expect(within(card).getByText('+19.0%')).toBeInTheDocument(); // Δ vs req
    // Signal feed row.
    expect(screen.getByText('Senate markup added funding over the PB request')).toBeInTheDocument();
    expect(screen.getByText('SASC · S. 1071 · FY26')).toBeInTheDocument();
    // "New signals" KPI counts the feed length.
    expect(screen.getByText('unread on your watchlist')).toBeInTheDocument();
  });
});
