/**
 * Ported from pages/reviews/ReviewQueuePage.test.tsx — same hook-level mocks,
 * same ?id= deep-link semantics (default-to-'all' filter + row highlight),
 * adapted to the vNext markup (highlight class instead of an inline outline).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { VNextReviewQueuePage } from './VNextReviewQueuePage.js';
import type { ReviewRequestDto } from '../../../pages/reviews/types.js';

vi.mock('../../../lib/me.js', () => ({
  useMe: () => ({ data: { role: 'user_admin' }, isLoading: false }),
}));

const listMock = vi.fn();
vi.mock('../../../pages/reviews/reviews-api.js', () => ({
  useReviewsList: (status: string) => listMock(status),
  useTeamMembers: () => ({ data: [] }),
  useApproveReview: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useRejectReview: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useAssignReview: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));

function setUrl(search: string) {
  window.history.pushState({}, '', `/reviews${search}`);
}

if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = vi.fn();
}

function review(overrides: Partial<ReviewRequestDto> = {}): ReviewRequestDto {
  return {
    id: 'r1',
    riskTier: 'high',
    surface: 'alert-memo',
    subjectType: 'alert',
    subjectId: 'alert-1',
    clientId: 'client-1',
    title: 'Client memo — H.R. 8800',
    reason: 'D6/critical',
    status: 'pending',
    requestedBy: 'u1',
    assignedTo: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('VNextReviewQueuePage — ?id= deep link (MP-13 / Gate H phase b)', () => {
  beforeEach(() => {
    listMock.mockReset();
    setUrl('');
  });

  test('with no ?id=, defaults to the Pending filter (unchanged behavior)', async () => {
    listMock.mockReturnValue({
      data: [review()],
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(<VNextReviewQueuePage />);

    await screen.findByText('Client memo — H.R. 8800');
    expect(listMock).toHaveBeenCalledWith('pending');
  });

  test('with ?id=, defaults to the All filter so an already-decided review is still findable', async () => {
    setUrl('?id=r2');
    listMock.mockReturnValue({
      data: [review({ id: 'r2', status: 'approved' })],
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(<VNextReviewQueuePage />);

    await screen.findByText('Client memo — H.R. 8800');
    expect(listMock).toHaveBeenCalledWith('all');
  });

  test('highlights the row matching ?id=', async () => {
    setUrl('?id=r2');
    listMock.mockReturnValue({
      data: [review({ id: 'r1' }), review({ id: 'r2', title: 'Target review' })],
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(<VNextReviewQueuePage />);

    const target = await screen.findByText('Target review');
    const highlightedWrapper = target.closest('.amx-review-highlight');
    await waitFor(() => expect(highlightedWrapper).not.toBeNull());
    const other = screen.getByText('Client memo — H.R. 8800');
    expect(other.closest('.amx-review-highlight')).toBeNull();
  });

  test('renders the pending decision controls + risk/surface/status badges', async () => {
    listMock.mockReturnValue({
      data: [review()],
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(<VNextReviewQueuePage />);

    await screen.findByText('Client memo — H.R. 8800');
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Alert memo')).toBeInTheDocument();
    // 'Pending' appears both as the status badge and the filter control.
    expect(screen.getAllByText('Pending').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    // user_admin is a tenant admin — the Assign control is present.
    expect(screen.getByLabelText('Assign reviewer')).toBeInTheDocument();
  });

  test('honest empty state', async () => {
    listMock.mockReturnValue({ data: [], isLoading: false, isFetching: false, refetch: vi.fn() });
    render(<VNextReviewQueuePage />);

    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
  });
});
