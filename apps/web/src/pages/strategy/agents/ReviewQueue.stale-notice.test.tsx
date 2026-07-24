/*
 * Regression test for the apply→409 stale-head path (Stage F review queue).
 *
 * The bug: the Regenerate hint was card-local state, but useApplyChangeSet's
 * onError invalidates the change-set lists, the row (marked stale server-side)
 * drops out of the approved query on refetch, and the card holding the note
 * unmounts — the explanation flashed for one round-trip then vanished, making
 * a failed apply look like a silent success.
 *
 * The fix: the hint is queue-level state (ReviewQueue.staleNotices), so it
 * must still render AFTER the refetch removes the row. That post-refetch
 * persistence is exactly what this test pins down.
 *
 * Also pinned: apply's 409 is disambiguated by RESPONSE BODY
 * (isStaleApplyConflict), not status code — a concurrent reviewer winning the
 * apply race also 409s ("Change-set is applied — approve it before applying"),
 * and that loser must see the server's reason, NOT the Regenerate hint (which
 * would send them to re-check a plan that already contains the changes).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { App } from 'antd';
import type { ChangeSet } from '../types.js';

// ---- module mocks -----------------------------------------------------------
// This file sits next to ReviewQueue.tsx, so its '../api.js' / '../clients-lite.js'
// specifiers resolve to the same modules the component imports.

let proposedRows: ChangeSet[] = [];
let approvedRows: ChangeSet[] = [];
let appliedRows: ChangeSet[] = [];

const applyMutate = vi.fn();
const idle = { isLoading: false, isError: false, isSuccess: true, error: null };

vi.mock('../api.js', () => ({
  useChangeSets: (filter: { status?: string } = {}) => ({
    ...idle,
    data:
      filter.status === 'proposed'
        ? proposedRows
        : filter.status === 'approved'
          ? approvedRows
          : appliedRows,
  }),
  useStrategies: () => ({ ...idle, data: [] }),
  useStrategy: () => ({ ...idle, data: undefined }),
  useAgentRun: () => ({ ...idle, data: undefined }),
  useFirmReviewRuns: () => ({ ...idle, data: [] }),
  useApplyChangeSet: () => ({ mutate: applyMutate, isPending: false }),
  useApproveChangeSet: () => ({ mutate: vi.fn(), isPending: false }),
  useRejectChangeSet: () => ({ mutate: vi.fn(), isPending: false }),
  useUndoChangeSet: () => ({ mutate: vi.fn(), isPending: false }),
  useTransitionRun: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../clients-lite.js', () => ({
  useClientsLite: () => ({ ...idle, data: [] }),
}));

import { ReviewQueue } from './ReviewQueue.js';

// ---- fixtures ----------------------------------------------------------------

const approvedCs: ChangeSet = {
  id: 'cs-1',
  strategyId: 'strat-1',
  runId: null,
  summary: 'Re-time markup prep around the new HASC date',
  ops: [{ op: 'retime', nodeId: 'node-1', startsOn: '2026-08-01' }],
  approvedOps: null,
  risk: 'medium',
  status: 'approved',
  strategyVersionId: 'v-1',
  appliedVersionId: null,
  approvedByUserId: 'user-1',
  approvedAt: '2026-07-23T12:00:00.000Z',
  rejectedByUserId: null,
  rejectedAt: null,
  appliedByUserId: null,
  appliedAt: null,
  undoneByUserId: null,
  undoneAt: null,
  createdByUserId: null,
  createdAt: '2026-07-23T11:00:00.000Z',
  updatedAt: '2026-07-23T12:00:00.000Z',
};

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

// A FRESH element each time — rerendering the same element reference lets
// React bail out without re-reading the (mocked) hooks.
const queueTree = () => (
  <MemoryRouter>
    <App>
      <ReviewQueue />
    </App>
  </MemoryRouter>
);

function renderQueue() {
  const utils = render(queueTree());
  return { ...utils, refetch: () => utils.rerender(queueTree()) };
}

// Apply's stale-head 409 body (ChangeSetsService.apply). The status code alone
// is NOT enough — apply also 409s when a concurrent reviewer already
// applied/rejected the set, and only the stale body may raise the Regenerate hint.
const err409 = {
  response: {
    status: 409,
    data: {
      message: 'plan changed since this was proposed — regenerate',
      error: 'Conflict',
      statusCode: 409,
    },
  },
};

// The race-loser 409: another reviewer's apply committed first.
const err409Applied = {
  response: {
    status: 409,
    data: {
      message: 'Change-set is applied — approve it before applying',
      error: 'Conflict',
      statusCode: 409,
    },
  },
};

// ---- tests --------------------------------------------------------------------

describe('ReviewQueue apply→409 stale notice', () => {
  beforeEach(() => {
    setupBrowserMocks();
    applyMutate.mockReset();
    proposedRows = [];
    approvedRows = [approvedCs];
    appliedRows = [];
  });

  test('the stale explanation persists after the refetch removes the row', () => {
    const { refetch } = renderQueue();

    // The approved card is on screen with its Apply button.
    expect(screen.getByText(approvedCs.summary)).toBeInTheDocument();
    applyMutate.mockImplementation((_vars, opts?: { onError?: (e: unknown) => void }) => {
      opts?.onError?.(err409);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    // The notice appears immediately (queue-level state, not card-local)…
    expect(screen.getByRole('status')).toHaveTextContent(/now stale/i);
    expect(screen.getByRole('status')).toHaveTextContent(approvedCs.summary);

    // …then the list refetch lands: the row is stale server-side and drops out
    // of the approved query, unmounting the card.
    approvedRows = [];
    refetch();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();

    // THE BUG: the explanation used to unmount with the card. It must survive.
    expect(screen.getByRole('status')).toHaveTextContent(/was not applied/i);
    expect(screen.getByRole('status')).toHaveTextContent(/regenerate it/i);
    expect(screen.getByRole('status')).toHaveTextContent(approvedCs.summary);
  });

  test('the notice is dismissible and does not duplicate on a second 409', () => {
    const { refetch } = renderQueue();
    applyMutate.mockImplementation((_vars, opts?: { onError?: (e: unknown) => void }) => {
      opts?.onError?.(err409);
    });

    // Two clicks before the refetch lands (retry on the same row) ⇒ one notice.
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getAllByRole('status')).toHaveLength(1);

    approvedRows = [];
    refetch();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  test('losing the apply race (409, already-applied body) shows the server reason, not the Regenerate hint', async () => {
    renderQueue();
    applyMutate.mockImplementation((_vars, opts?: { onError?: (e: unknown) => void }) => {
      opts?.onError?.(err409Applied);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    // No stale notice — regenerating would re-check a plan that ALREADY
    // contains these changes and confuse the loser when nothing is proposed.
    expect(screen.queryByText(/now stale/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/regenerate it/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();

    // The server's own reason surfaces instead (antd message toast).
    expect(
      await screen.findByText(/Change-set is applied — approve it before applying/),
    ).toBeInTheDocument();
  });

  test('a non-409 apply error does not raise a stale notice', () => {
    renderQueue();
    applyMutate.mockImplementation((_vars, opts?: { onError?: (e: unknown) => void }) => {
      opts?.onError?.({ response: { status: 500 } });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.queryByText(/now stale/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
    // The card is still there (a 500 does not stale the row).
    expect(screen.getByText(approvedCs.summary)).toBeInTheDocument();
  });
});
