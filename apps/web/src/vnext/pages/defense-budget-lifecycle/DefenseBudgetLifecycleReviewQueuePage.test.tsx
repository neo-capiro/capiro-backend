import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { DefenseBudgetLifecycleReviewQueuePage } from './DefenseBudgetLifecycleReviewQueuePage.js';
import type { ReviewQueueItem } from './defense-budget-lifecycle-api.js';

const apiGetMock = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGetMock }) }));
vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({ isLoading: false, data: { tenant: { slug: 'capiro-internal' } } }),
}));

function reviewItemFixture(overrides: Partial<ReviewQueueItem> = {}): ReviewQueueItem {
  return {
    expectedSourceId: 'es-1',
    fiscalYear: 2027,
    authorityTrack: 'authorization',
    stage: 'hasc_report',
    sourceFamily: 'auth_committee_report',
    adapterId: 'hasc',
    label: 'HASC Report FY2027',
    expectedState: 'review_required',
    expectedSourceReviewReason: 'classifier confidence below threshold',
    observation: {
      fiscalYear: 2027,
      authorityTrack: 'authorization',
      stage: 'hasc_report',
      sourceFamily: 'auth_committee_report',
      adapterId: 'hasc',
      discoveredUrl: 'https://www.congress.gov/crpt/119hrpt1/pdf/crpt-1.pdf',
      contentSha256: '2'.repeat(64),
      byteSize: 4096,
      observationState: 'review_required',
      classificationConfidence: 0.62,
      reviewReasons: ['content excerpt did not corroborate metadata'],
      sourceDocumentId: null,
      supersededByObservationId: null,
      firstSeenAt: '2027-05-20T00:00:00.000Z',
      lastSeenAt: '2027-05-20T00:00:00.000Z',
      seenCount: 1,
    },
    ...overrides,
  };
}

function renderPage(path = '/defense-budget-lifecycle/review-queue?fiscalYear=2027') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <DefenseBudgetLifecycleReviewQueuePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DefenseBudgetLifecycleReviewQueuePage', () => {
  it('renders the review reason, observation reasons, and a disabled resolve action', async () => {
    apiGetMock.mockResolvedValue({ data: [reviewItemFixture()] });

    renderPage();

    await waitFor(() => expect(screen.getByText('HASC Report FY2027')).toBeInTheDocument());
    expect(screen.getByText('classifier confidence below threshold')).toBeInTheDocument();
    expect(screen.getByText('content excerpt did not corroborate metadata')).toBeInTheDocument();
    const resolveButton = screen.getByRole('button', { name: /Resolve/ });
    expect(resolveButton).toBeDisabled();
  });

  it('shows an empty state when nothing is held for review', async () => {
    apiGetMock.mockResolvedValue({ data: [] });

    renderPage();

    await waitFor(() => expect(screen.getByText('Nothing held for review')).toBeInTheDocument());
  });

  it('shows an error state when the review queue request fails', async () => {
    apiGetMock.mockRejectedValue(new Error('network down'));

    renderPage();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
