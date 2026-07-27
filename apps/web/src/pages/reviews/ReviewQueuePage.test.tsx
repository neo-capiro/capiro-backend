import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { App as AntApp } from 'antd';
import { ReviewQueuePage } from './ReviewQueuePage.js';
import type { ReviewRequestDto } from './types.js';

/**
 * MP-13 / Gate H phase b: /reviews?id= was already emitted by StepGenerate.tsx
 * (and, after phase a, by MemoComposerDrawer/DistrictBriefComposerDrawer's View
 * review request) but this page read no route or query params at all — the
 * link was dead. It now defaults to the 'all' status filter when a target id
 * is present (the linked review's status is unknown from the link alone) and
 * highlights the matching card.
 */

vi.mock('../../lib/me.js', () => ({
  useMe: () => ({ data: { role: 'user_admin' }, isLoading: false }),
}));

const listMock = vi.fn();
vi.mock('./reviews-api.js', () => ({
  useReviewsList: (status: string) => listMock(status),
  useTeamMembers: () => ({ data: [] }),
  useApproveReview: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRejectReview: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAssignReview: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

function renderPage() {
  return render(
    <AntApp>
      <ReviewQueuePage />
    </AntApp>,
  );
}

describe('ReviewQueuePage — ?id= deep link (MP-13 / Gate H phase b)', () => {
  beforeEach(() => {
    listMock.mockReset();
    setUrl('');
  });

  test('with no ?id=, defaults to the Pending filter (unchanged behavior)', async () => {
    listMock.mockReturnValue({ data: [review()], isLoading: false, isFetching: false, refetch: vi.fn() });
    renderPage();

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
    renderPage();

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
    renderPage();

    const target = await screen.findByText('Target review');
    // Walk up to the wrapper div ReviewQueuePage renders around the matched card.
    const highlightedWrapper = target.closest('[style*="outline"]');
    await waitFor(() => expect(highlightedWrapper).not.toBeNull());
    const other = screen.getByText('Client memo — H.R. 8800');
    expect(other.closest('[style*="outline"]')).toBeNull();
  });
});
