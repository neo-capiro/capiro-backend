import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { OpportunityTimeline } from './OpportunityTimeline.js';
import type { OpportunityTimelineResponse } from './funding-opportunities-api.js';

/**
 * The notice-history timeline (P28).
 *
 * The one thing this panel must never say is "the notice was updated" — that
 * label is the reason the phase exists. So the central tests read the rendered
 * text and assert that every entry names the dimension and at least one of the
 * two values.
 *
 * The other central property: FOUR different kinds of empty, only one of which
 * is a fact about the notice. Collapsing any of the other three into "no
 * amendments" is the false claim the whole program is built to avoid.
 */

const { apiGetMock, flags } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  flags: { funding_opportunities_notice_history: true } as Record<string, boolean>,
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: vi.fn(), patch: vi.fn() }),
}));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({ enabled: flags[feature] === true, ready: true }),
  useIntelFeatureEnabled: (feature: string) => flags[feature] === true,
}));

const SAM_ID = '11111111-1111-1111-1111-111111111111';

function timeline(partial: Partial<OpportunityTimelineResponse> = {}): OpportunityTimelineResponse {
  return {
    source: 'sam_gov',
    sourceRecordId: SAM_ID,
    entries: [
      {
        tangoNoticeId: 'N-1',
        title: 'Turbofan Engine Sustainment',
        postedDate: '2026-06-01T00:00:00.000Z',
        providerUpdatedAt: '2026-06-01T00:00:00.000Z',
        sourceUrl: 'https://sam.gov/opp/n1/view',
        isFirstObservation: true,
        changes: [],
      },
      {
        tangoNoticeId: 'N-2',
        title: 'Turbofan Engine Sustainment',
        postedDate: '2026-07-01T00:00:00.000Z',
        providerUpdatedAt: '2026-07-01T00:00:00.000Z',
        sourceUrl: null,
        isFirstObservation: false,
        changes: [
          {
            dimension: 'deadline',
            severity: 'critical',
            before: '2026-09-01T17:00:00.000Z',
            after: '2026-08-15T17:00:00.000Z',
            summary:
              'The response deadline moved earlier, from 2026-09-01T17:00:00.000Z to 2026-08-15T17:00:00.000Z.',
          },
          {
            dimension: 'attachments',
            severity: 'informational',
            before: '3',
            after: '5',
            summary: '2 attachments added (now 5).',
          },
        ],
      },
    ],
    changeCount: 2,
    bySeverity: { critical: 1, significant: 0, informational: 1 },
    // THREE, not four: `description` was corrected out of this list once the
    // SDK's own NOTICE_SCHEMA was read rather than TangoNotice's field list.
    unsupported: [
      { dimension: 'stage', reason: 'The provider states no notice type on a notice.' },
      { dimension: 'place_of_performance', reason: 'The provider states no place of performance on a notice.' },
      { dimension: 'contact', reason: 'The provider states no point of contact on a notice.' },
    ],
    coverage: 'available',
    coverageExplanation: '2 notices observed for this solicitation.',
    generatedAt: '2026-08-07T12:00:00.000Z',
    ...partial,
  };
}

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
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: () => ({ getPropertyValue: () => '' }),
  });
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>{node}</AntApp>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setupBrowserMocks();
  apiGetMock.mockReset();
  flags.funding_opportunities_notice_history = true;
});

describe('every entry says WHAT changed, never "the notice was updated"', () => {
  test('each change renders its dimension and its composed sentence', async () => {
    apiGetMock.mockResolvedValue({ data: timeline() });
    wrap(<OpportunityTimeline source="sam_gov" sourceRecordId={SAM_ID} />);
    const entry = await screen.findByTestId('fo-timeline-entry-N-2');
    expect(entry).toHaveTextContent('deadline');
    expect(entry).toHaveTextContent('moved earlier');
    expect(entry).toHaveTextContent('attachments');
    expect(entry).toHaveTextContent('2 attachments added (now 5).');
  });

  test('no generic update label appears anywhere in the panel', async () => {
    apiGetMock.mockResolvedValue({ data: timeline() });
    const { container } = wrap(<OpportunityTimeline source="sam_gov" sourceRecordId={SAM_ID} />);
    await screen.findByTestId('fo-timeline-entry-N-2');
    expect(container.textContent ?? '').not.toMatch(/the notice was updated/i);
  });

  test('the FIRST entry says there is nothing before it, not "no changes"', async () => {
    // "Nothing changed" would be a claim about the agency. "Nothing to compare
    // against" is a fact about Capiro's own coverage.
    apiGetMock.mockResolvedValue({ data: timeline() });
    wrap(<OpportunityTimeline source="sam_gov" sourceRecordId={SAM_ID} />);
    const entry = await screen.findByTestId('fo-timeline-entry-N-1');
    expect(entry).toHaveTextContent('First observation');
    expect(entry).toHaveTextContent(/nothing before it to compare against/i);
  });

  test('a later notice with no comparable change says so precisely', async () => {
    apiGetMock.mockResolvedValue({
      data: timeline({
        entries: [
          { ...timeline().entries[0]! },
          { ...timeline().entries[1]!, changes: [] },
        ],
        changeCount: 0,
        bySeverity: { critical: 0, significant: 0, informational: 0 },
      }),
    });
    wrap(<OpportunityTimeline source="sam_gov" sourceRecordId={SAM_ID} />);
    const entry = await screen.findByTestId('fo-timeline-entry-N-2');
    expect(entry).toHaveTextContent(/Nothing Capiro can compare changed in this notice/i);
  });

  test('the change count and severity bands are summarised', async () => {
    apiGetMock.mockResolvedValue({ data: timeline() });
    wrap(<OpportunityTimeline source="sam_gov" sourceRecordId={SAM_ID} />);
    expect((await screen.findByTestId('fo-timeline-change-count')).textContent).toBe('2');
    expect(screen.getByText('Affects whether you can respond')).toBeTruthy();
  });

  test('a severity band with a zero count is not rendered as a zero', async () => {
    apiGetMock.mockResolvedValue({ data: timeline() });
    wrap(<OpportunityTimeline source="sam_gov" sourceRecordId={SAM_ID} />);
    await screen.findByTestId('fo-timeline-change-count');
    expect(screen.queryByText('Affects whether you may respond')).toBeNull();
  });
});

describe('the four kinds of nothing are four different sentences', () => {
  test('the flag off says so, and says it means nothing about the notice', async () => {
    flags.funding_opportunities_notice_history = false;
    wrap(<OpportunityTimeline source="sam_gov" sourceRecordId={SAM_ID} />);
    const el = await screen.findByTestId('fo-timeline-not-enabled');
    expect(el).toHaveTextContent(/not enabled for this workspace/i);
    expect(el).toHaveTextContent(/says nothing about whether this solicitation has been amended/i);
    // And it does not ask the API for something the API would 404.
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('never synced is reported as a Capiro gap, not as "no amendments"', async () => {
    apiGetMock.mockResolvedValue({
      data: timeline({
        entries: [],
        changeCount: 0,
        coverage: 'no_notices_synced',
        coverageExplanation:
          'Notice history has not been synchronised yet. This is not a statement that the solicitation was never amended.',
      }),
    });
    wrap(<OpportunityTimeline source="sam_gov" sourceRecordId={SAM_ID} />);
    const el = await screen.findByTestId('fo-timeline-no_notices_synced');
    expect(el).toHaveTextContent(/not a statement that the solicitation was never amended/i);
  });

  test('not crosswalked is a DIFFERENT sentence from never synced', async () => {
    apiGetMock.mockResolvedValue({
      data: timeline({
        entries: [],
        changeCount: 0,
        coverage: 'not_crosswalked',
        coverageExplanation:
          "No synchronised notice is linked to this solicitation. The provider's record of it has not been crosswalked to Capiro's own, so its amendment history cannot be shown.",
      }),
    });
    wrap(<OpportunityTimeline source="sam_gov" sourceRecordId={SAM_ID} />);
    expect(await screen.findByTestId('fo-timeline-not_crosswalked')).toHaveTextContent(
      /has not been crosswalked/i,
    );
  });

  test('a grant never asks the API at all, and says why', async () => {
    wrap(<OpportunityTimeline source="grants_gov" sourceRecordId="DE-FOA-0001" />);
    expect(await screen.findByTestId('fo-timeline')).toHaveTextContent(
      /Grants\.gov publishes no notice history/i,
    );
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('a request failure is NOT reported as an empty history', async () => {
    apiGetMock.mockRejectedValue(new Error('network down'));
    wrap(<OpportunityTimeline source="sam_gov" sourceRecordId={SAM_ID} />);
    expect(await screen.findByTestId('fo-timeline-error')).toHaveTextContent(
      /request failure, not an empty history/i,
    );
  });
});

describe('what the timeline cannot see is stated, not omitted', () => {
  test('the unsupported dimensions are listed, with the reason on hover', async () => {
    // A reader who knows the timeline misses stage transitions can go check the
    // source. A reader who was never told assumes it covers everything.
    apiGetMock.mockResolvedValue({ data: timeline() });
    wrap(<OpportunityTimeline source="sam_gov" sourceRecordId={SAM_ID} />);
    const el = await screen.findByTestId('fo-timeline-unsupported');
    expect(el).toHaveTextContent('stage');
    expect(el).toHaveTextContent('contact');
    expect(el).toHaveTextContent(/which is not the same as one not having happened/i);
  });

  test('it hits the timeline route for the right record', async () => {
    apiGetMock.mockResolvedValue({ data: timeline() });
    wrap(<OpportunityTimeline source="sam_gov" sourceRecordId={SAM_ID} />);
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(
        `/api/intelligence/opportunities/sam_gov/${SAM_ID}/timeline`,
      ),
    );
  });
});
