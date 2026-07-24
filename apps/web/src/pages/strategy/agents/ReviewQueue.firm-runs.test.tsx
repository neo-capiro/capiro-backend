/*
 * Regression test for the firm-level run review surface (Stage F).
 *
 * The bug: the F2 scheduler's firm-calendar placeholder parks a CRITICAL
 * 'firm-calendar-review' finding on a ready_for_review run with NO change-set
 * — but the review queue was change-set-only and WatchRail is strategy-scoped,
 * so no web surface listed runs at all. Every firm occurrence minted a
 * critical review obligation no human could see anywhere in the app, and the
 * runs accumulated in ready_for_review indefinitely.
 *
 * The fix: ReviewQueue renders a "Firm-level checks" section fed by
 * useFirmReviewRuns (GET /agents/runs/firm-review) whose cards show the run's
 * findings + risk and acknowledge via the ready_for_review -> completed run
 * transition. This test pins: the section renders the obligation, "Mark
 * reviewed" fires the transition, and the section disappears when nothing is
 * awaiting review (so the queue is unchanged for tenants without firm runs).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { App } from 'antd';
import type { AgentRun } from '../types.js';

// ---- module mocks -----------------------------------------------------------
// This file sits next to ReviewQueue.tsx, so its '../api.js' / '../clients-lite.js'
// specifiers resolve to the same modules the component imports.

let firmRows: AgentRun[] = [];

const transitionMutate = vi.fn();
const idle = { isLoading: false, isError: false, isSuccess: true, error: null };

vi.mock('../api.js', () => ({
  useChangeSets: () => ({ ...idle, data: [] }),
  useStrategies: () => ({ ...idle, data: [] }),
  useStrategy: () => ({ ...idle, data: undefined }),
  useAgentRun: () => ({ ...idle, data: undefined }),
  useFirmReviewRuns: () => ({ ...idle, data: firmRows }),
  useApplyChangeSet: () => ({ mutate: vi.fn(), isPending: false }),
  useApproveChangeSet: () => ({ mutate: vi.fn(), isPending: false }),
  useRejectChangeSet: () => ({ mutate: vi.fn(), isPending: false }),
  useUndoChangeSet: () => ({ mutate: vi.fn(), isPending: false }),
  useTransitionRun: () => ({ mutate: transitionMutate, isPending: false }),
}));

vi.mock('../clients-lite.js', () => ({
  useClientsLite: () => ({ ...idle, data: [] }),
}));

import { ReviewQueue } from './ReviewQueue.js';

// ---- fixtures ----------------------------------------------------------------

/** What the F2 firm-calendar placeholder persists on the run (scheduler F2). */
const firmRun: AgentRun = {
  id: 'run-firm-1',
  missionId: 'mission-firm',
  strategyId: null,
  state: 'ready_for_review',
  trigger: 'scheduled',
  findings: {
    findings: [
      {
        code: 'firm-calendar-review',
        severity: 'critical',
        nodeIds: [],
        message:
          'Firm-level calendar review due: reference calendars changed since the last scheduled check',
      },
    ],
    riskClassification: { risk: 'critical', autoApplyEligible: false, requiresImpactSummary: true },
    calendarFingerprint: 'fp-1',
  },
  waitingReason: null,
  error: null,
  startedAt: '2026-07-23T09:00:00.000Z',
  finishedAt: null,
  createdAt: '2026-07-23T09:00:00.000Z',
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

// ---- tests --------------------------------------------------------------------

describe('ReviewQueue firm-level run surface', () => {
  beforeEach(() => {
    setupBrowserMocks();
    transitionMutate.mockReset();
    firmRows = [firmRun];
  });

  test('a firm run in ready_for_review renders as a reviewable card: section, critical badge, finding message', () => {
    render(queueTree());

    // The section exists and counts the obligation.
    expect(screen.getByText('Firm-level checks')).toBeInTheDocument();
    expect(screen.getByText('1 awaiting review')).toBeInTheDocument();

    // The card carries the RiskRouter classification and the finding itself —
    // the actual review obligation a human must see.
    expect(screen.getByText('critical')).toBeInTheDocument();
    expect(screen.getByText('Watcher')).toBeInTheDocument();
    expect(screen.getByText(/Firm-level calendar review due/)).toBeInTheDocument();
  });

  test('"Mark reviewed" acknowledges via the run transition (ready_for_review -> completed)', () => {
    render(queueTree());

    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));

    expect(transitionMutate).toHaveBeenCalledTimes(1);
    expect(transitionMutate.mock.calls[0]![0]).toEqual({ id: 'run-firm-1', to: 'completed' });
  });

  test('an acknowledged run drains: the refetch removes the row and the section disappears', () => {
    const utils = render(queueTree());
    expect(screen.getByText('Firm-level checks')).toBeInTheDocument();

    // useTransitionRun's onSuccess invalidates the firm-review list; the
    // refetch returns without the completed run.
    firmRows = [];
    utils.rerender(queueTree());

    expect(screen.queryByText('Firm-level checks')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument();
  });

  test('no firm runs => no section (the change-set queue is unchanged)', () => {
    firmRows = [];
    render(queueTree());

    expect(screen.queryByText('Firm-level checks')).not.toBeInTheDocument();
    // The change-set empty state still renders as before.
    expect(screen.getByText(/Nothing to review/)).toBeInTheDocument();
  });
});
