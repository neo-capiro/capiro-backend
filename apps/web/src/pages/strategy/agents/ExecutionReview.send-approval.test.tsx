/*
 * Safety-critical invariant test for the Stage G Execution review
 * (/strategies/agents/execution).
 *
 * Plan §G, non-negotiable: the actual EXTERNAL SEND stays HARD-DISABLED until
 * Stage H security evals. The send-approval control must therefore render
 * VISIBLY DISABLED with the exact Stage-H copy, and it must never fire the
 * resume/approve wiring even if clicked (a double lock: the control is
 * `disabled` AND the handler is gated behind the never-set SEND flag).
 *
 * This test pins that invariant so a future refactor cannot silently make the
 * "Approve this send" control live before the Stage-H work lands. It also pins
 * the two adjacent behaviours the surface promises: a ready_for_review run
 * offers "Execute plan" (staging, not sending) and NOT a send control, and a
 * non-send waiting_for_input run renders its PRECISE reason (not a generic
 * error).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { App } from 'antd';
import type { ExecutionRun } from '../types.js';

// ---- module mocks -----------------------------------------------------------
// This file sits next to ExecutionReview.tsx, so its '../api.js' /
// '../clients-lite.js' specifiers resolve to the same modules the component
// imports. The pure helpers in './agent-utils.js' are used for real.

let runsData: ExecutionRun[] = [];

const executeMutate = vi.fn();
const resumeMutate = vi.fn();
const idle = { isLoading: false, isError: false, isSuccess: true, error: null };

vi.mock('../api.js', () => ({
  useExecutionRuns: () => ({ ...idle, data: runsData }),
  useExecuteRun: () => ({ mutate: executeMutate, isPending: false }),
  useResumeRun: () => ({ mutate: resumeMutate, isPending: false }),
  useStrategies: () => ({ ...idle, data: [] }),
  // P0-2 recovery controls. This suite is about the send-approval gate, so the
  // policy resolves to nothing — the recovery block renders no action buttons and
  // cannot interfere with the assertions below.
  useRunPolicy: () => ({ ...idle, data: undefined }),
  useCancelRun: () => ({ mutate: vi.fn(), isPending: false }),
  useRetryRun: () => ({ mutate: vi.fn(), isPending: false }),
  useMarkRunFailed: () => ({ mutate: vi.fn(), isPending: false }),
  useReconcileRun: () => ({ mutate: vi.fn(), isPending: false }),
  useResolveReservation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../clients-lite.js', () => ({
  useClientsLite: () => ({ ...idle, data: [] }),
}));

import { ExecutionReview, SEND_DISABLED_COPY } from './ExecutionReview.js';

// ---- fixtures ----------------------------------------------------------------

/** A run parked on the (inert) send-approval gate with a staged outreach preview. */
const sendApprovalRun: ExecutionRun = {
  id: 'exec-send-1',
  missionId: 'm-1',
  strategyId: 'strat-1',
  state: 'waiting_for_input',
  trigger: 'manual',
  waitingReason: 'awaiting send approval',
  error: null,
  summary: 'Stage the coalition sign-on ask to three offices',
  tasks: [
    {
      id: 't-1',
      type: 'await_send_approval',
      nodeId: 'node-1',
      title: 'Coalition sign-on ask',
      status: 'awaiting_approval',
      artifactRef: 'outreach-1',
      blockedReason: null,
      model: null,
      groundedFactCount: null,
      send: {
        subject: 'Please co-sign our FY27 appropriations letter',
        body: 'Dear office,\n\nWe would value your support…',
        recipients: ['Rep. A office', 'Rep. B office', 'Rep. C office'],
        ask: 'Co-sign by Friday',
        window: 'this week',
        approvalToken: 'tok-abc',
        contentHash: 'hash-1',
        approvedContentHash: null,
      },
    },
  ],
  startedAt: '2026-07-24T09:00:00.000Z',
  finishedAt: null,
  createdAt: '2026-07-24T09:00:00.000Z',
};

const readyRun: ExecutionRun = {
  id: 'exec-ready-1',
  missionId: 'm-1',
  strategyId: 'strat-1',
  state: 'ready_for_review',
  trigger: 'manual',
  waitingReason: null,
  error: null,
  summary: 'Prepare the white paper draft',
  tasks: [
    {
      id: 't-2',
      type: 'workspace_draft',
      nodeId: 'node-2',
      title: 'FY27 white paper',
      status: 'planned',
      artifactRef: null,
      blockedReason: null,
      model: null,
      groundedFactCount: null,
      send: null,
    },
  ],
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-07-24T08:00:00.000Z',
};

const blockedRun: ExecutionRun = {
  id: 'exec-blocked-1',
  missionId: 'm-1',
  strategyId: 'strat-1',
  state: 'waiting_for_input',
  trigger: 'manual',
  waitingReason: 'Execution requires an interactive session',
  error: null,
  summary: null,
  tasks: [],
  startedAt: null,
  finishedAt: null,
  createdAt: '2026-07-24T07:00:00.000Z',
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

// A FRESH element each time — rerendering the same reference lets React bail
// out without re-reading the (mocked) hooks.
const reviewTree = () => (
  <MemoryRouter>
    <App>
      <ExecutionReview />
    </App>
  </MemoryRouter>
);

// ---- tests --------------------------------------------------------------------

describe('ExecutionReview send-approval hard-disable (Stage G safety boundary)', () => {
  beforeEach(() => {
    setupBrowserMocks();
    executeMutate.mockReset();
    resumeMutate.mockReset();
    runsData = [sendApprovalRun];
  });

  test('the "Approve this send" control renders VISIBLY DISABLED with the Stage-H copy', () => {
    render(reviewTree());

    // The staged-outreach panel is present…
    expect(screen.getByText('Outreach staged — awaiting send approval')).toBeInTheDocument();

    // …the approve control exists and is DISABLED (the safety invariant)…
    const approve = screen.getByRole('button', { name: /approve this send/i });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('aria-disabled', 'true');

    // …and the exact Stage-H copy is shown.
    expect(screen.getByText(SEND_DISABLED_COPY)).toBeInTheDocument();
  });

  test('clicking the disabled approve control never fires the resume/send wiring', () => {
    render(reviewTree());
    const approve = screen.getByRole('button', { name: /approve this send/i });

    fireEvent.click(approve);

    // Double lock: even if a click reaches the handler, it is gated behind the
    // never-set send flag — no resume (the Stage-H send path) is triggered.
    expect(resumeMutate).not.toHaveBeenCalled();
  });

  test('the panel echoes what would be approved (recipients, subject, ask)', () => {
    render(reviewTree());

    // The subject is echoed twice (the "what would be approved" line + the
    // Subject field) — assert at least one, not a single match.
    expect(screen.getAllByText(/Please co-sign our FY27 appropriations letter/).length).toBeGreaterThan(0);
    expect(screen.getByText('Rep. A office')).toBeInTheDocument();
    expect(screen.getByText('Rep. B office')).toBeInTheDocument();
    expect(screen.getByText('Rep. C office')).toBeInTheDocument();
    // The invalidation contract is always surfaced.
    expect(
      screen.getByText(/Any edit to the staged content invalidates a prior approval/i),
    ).toBeInTheDocument();
  });

  test('a ready_for_review run offers Execute (staging) and NO send control', () => {
    runsData = [readyRun];
    render(reviewTree());

    expect(screen.getByRole('button', { name: /execute plan/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve this send/i })).not.toBeInTheDocument();
    expect(screen.queryByText(SEND_DISABLED_COPY)).not.toBeInTheDocument();
  });

  test('a non-send waiting_for_input run shows its PRECISE reason, not a generic error', () => {
    runsData = [blockedRun];
    render(reviewTree());

    expect(screen.getByText('Needs an interactive session')).toBeInTheDocument();
    expect(screen.getByText('Execution requires an interactive session')).toBeInTheDocument();
    // Not the send panel.
    expect(screen.queryByRole('button', { name: /approve this send/i })).not.toBeInTheDocument();
  });
});
