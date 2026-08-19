import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmIntelligenceProto } from './IntelligenceTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

/**
 * Regression: the Legislative view went BLANK on every tracker_v2 tenant.
 *
 * `/intel-api/clients/:id/recommendations` answers with a BARE array; only the
 * legacy `/api/…/recommendations` route answers with the
 * `{ recommendations, aboveFloorCount, … }` envelope. Two call sites here fetched
 * the intel route without running `adaptRecs`, so `data.recommendations` was
 * `undefined` and `useDomainStats`' `.filter` on it threw mid-render — taking the
 * whole Intelligence tab down, not just the one stat cell.
 *
 * This file pins the v2 shape specifically: the existing IntelligenceTab tests
 * do not mock the intel feature flag, so they only ever exercise the legacy path
 * and could not have caught this.
 */

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock }),
}));

// tracker_v2 ON — this is what routes the reads at the intel-api endpoints.
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  FUNDING_OPPORTUNITIES_FEATURE: 'funding_opportunities',
  useIntelFeature: () => ({ enabled: true, ready: true }),
  useIntelFeatureEnabled: () => true,
}));

const client: Client = {
  id: 'client-1',
  name: 'Overland AI',
  website: 'overland.ai',
  description: null,
  productDescription: null,
  primaryContactName: null,
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: null,
  status: 'active',
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

/** One intel-api recommendation row, as that service actually serves them. */
const INTEL_REC = {
  billId: 'hr-1234-119',
  displayNum: 'H.R. 1234',
  title: 'Autonomous Systems Procurement Act',
  stage: 'committee',
  passageProbability: 0.42,
  fit: 0.91,
  matchedTags: ['autonomy'],
  matchedTopicIds: [],
  matchReasons: [],
  whyKind: 'capability',
  why: 'Matches the client’s autonomy capability',
  latestActionText: 'Referred to committee',
  latestActionDate: '2026-08-01',
  sponsorName: 'Rep. Example',
  sponsorParty: 'D',
  cosponsorsCount: 3,
  jurisdiction: 'federal',
};

/** The intel-api board envelope, which DOES need adaptBoard (already applied). */
const INTEL_BOARD = {
  columns: [
    {
      id: 'committee',
      label: 'In committee',
      cards: [
        {
          billId: 'hr-9-119',
          displayNum: 'H.R. 9',
          title: 'Defense Authorization',
          stage: 'committee',
          passageProbability: 0.5,
          trackedAt: '2026-07-01T00:00:00.000Z',
          jurisdiction: 'federal',
        },
      ],
    },
  ],
  total: 1,
  withheld: 0,
};

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockImplementation((url: string) => {
    if (url.includes('/intel-api/') && url.includes('/recommendations')) {
      // The bare array — NOT an envelope. This is the shape that used to crash.
      return Promise.resolve({ data: [INTEL_REC] });
    }
    if (url.includes('/tracker/board')) return Promise.resolve({ data: INTEL_BOARD });
    return Promise.resolve({ data: {} });
  });
});

function renderLegislative() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ClientCrmIntelligenceProto client={client} view="legislative" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Intelligence → Legislative on a tracker_v2 tenant', () => {
  it('renders instead of blanking when recommendations come back as a bare array', async () => {
    renderLegislative();

    // The panel is on screen at all — the crash used to unmount everything.
    expect(await screen.findByText('Recommendations')).toBeInTheDocument();
    // And the adapted row is rendered, not swallowed.
    expect(await screen.findByText('H.R. 1234')).toBeInTheDocument();
  });

  it('counts high-fit recommendations in the domain stats strip', async () => {
    renderLegislative();

    // fit 0.91 clears the 0.85 high-fit bar, so the strip must say 1 — this is
    // the exact `.filter` expression that threw on the unadapted payload.
    await waitFor(() => {
      const label = screen.getByText('High-fit recommendations');
      expect(label.parentElement).toHaveTextContent('1');
    });
  });
});
