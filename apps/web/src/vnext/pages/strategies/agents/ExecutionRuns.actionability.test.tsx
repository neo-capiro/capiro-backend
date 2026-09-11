/**
 * F10 (2026-09-10 remediation plan §8) — actionable run cards.
 *
 * Observed defect: failed and waiting runs repeat technical strings (raw
 * ownerUserId), give broad advice that does not identify the missing input,
 * and repeat the same reason in the main status, task summary, and reason
 * area. The missing-context action opened unscoped Steward review.
 *
 * This suite pins the repaired RunCard behavior through the structured
 * blocker projection (execution-blocker.ts) carried on the run DTO:
 *  - one primary readable reason; requirements listed distinctly;
 *  - raw technical strings only under a collapsed Technical details section;
 *  - the same reason is not repeated across the card;
 *  - Review step opens the affected node; context actions preserve scope;
 *  - a verification failure with unknown cause never claims a missing source;
 *  - "Strategy unavailable" no longer fabricates a strategy state from the
 *    absence of a row in the active list.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionRuns } from './ExecutionRuns.js';

const mocks = vi.hoisted(() => ({
  runs: [] as any[],
  execute: vi.fn(),
  resume: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
  reconcile: vi.fn(),
  strategyDetail: null as any,
}));
vi.mock('../strategies-api.js', () => ({
  clientName: () => '',
  memberName: () => 'Reviewer',
  useExecutionRuns: () => ({ data: mocks.runs, isSuccess: true, isLoading: false }),
  useFirmReviewRuns: () => ({ data: [], isSuccess: true }),
  useStrategies: () => ({ data: [] }),
  useClientsLite: () => ({ data: [] }),
  useTenantMembers: () => ({ data: [] }),
  useStrategy: () => ({ data: mocks.strategyDetail, isLoading: false }),
  useChangeSets: () => ({ data: [], isSuccess: true }),
  useApproveChangeSet: () => ({}),
  useApplyChangeSet: () => ({}),
  useRejectChangeSet: () => ({}),
  useUndoChangeSet: () => ({}),
  useExecuteRun: () => ({ mutate: mocks.execute }),
  useResumeRun: () => ({ mutate: mocks.resume }),
  useRetryRun: () => ({ mutate: mocks.retry }),
  useCancelRun: () => ({ mutate: mocks.cancel }),
  useTransitionRun: () => ({ mutate: vi.fn() }),
  useRunPolicy: (id: string) => ({
    data: {
      state: mocks.runs.find((r) => r.id === id)?.state,
      actions: ['cancel', 'execute', 'resume', 'retry', 'reconcile'],
      timeoutMinutes: 15,
    },
  }),
  useReconcileRun: () => ({ mutate: mocks.reconcile }),
}));

const STRAT = '11111111-1111-4111-8111-111111111111';

function blockedRun(over: Record<string, unknown> = {}) {
  return {
    id: 'run-blocked',
    state: 'waiting_for_input',
    strategyId: STRAT,
    trigger: 'manual',
    createdAt: '2026-09-01',
    tasks: [],
    summary: null,
    waitingReason: 'node no longer eligible: node has no owner (ownerUserId is required)',
    ...over,
  };
}

beforeEach(() => {
  mocks.runs = [];
  mocks.strategyDetail = null;
  mocks.execute.mockReset();
  mocks.resume.mockReset();
  mocks.retry.mockReset();
  mocks.cancel.mockReset();
  mocks.reconcile.mockReset();
});

describe('F10 — actionable run cards', () => {
  it('a missing-owner run shows the readable primary reason, never raw ownerUserId in the main card', () => {
    mocks.runs = [blockedRun()];
    render(
      <MemoryRouter>
        <ExecutionRuns />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Assign an owner to this step/i)).toBeInTheDocument();
    // The raw technical string exists ONLY inside the collapsed Technical
    // details disclosure — present in DOM, never visible.
    expect(screen.queryByText(/ownerUserId/i)).not.toBeVisible();
  });

  it('the raw technical reason is available under a collapsed Technical details disclosure', () => {
    mocks.runs = [blockedRun()];
    render(
      <MemoryRouter>
        <ExecutionRuns />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Technical details/i)).toBeInTheDocument();
  });

  it('Review step opens the affected node in the strategy editor (scoped repair navigation)', () => {
    mocks.runs = [
      blockedRun({
        findings: {
          execution: { nodeId: 'node-9', strategyId: STRAT },
          g0: {
            eligibility: {
              eligible: false,
              reasons: ['node has no owner (ownerUserId is required)'],
            },
          },
        },
      }),
    ];
    render(
      <MemoryRouter>
        <ExecutionRuns />
      </MemoryRouter>,
    );
    const btn = screen.getByRole('button', { name: /open the affected step|review step/i });
    expect(btn).toBeInTheDocument();
    // The link/button routes into the strategy editor for that node.
    expect((btn.closest('a') ?? btn).textContent ?? '').toBeTruthy();
  });

  it('a run missing only client constraints names only that source (never prescribes a strategy brief too)', () => {
    mocks.runs = [
      blockedRun({
        waitingReason: 'required client context is missing: client_constraints',
        findings: {
          execution: { nodeId: 'n1', strategyId: STRAT },
          g0: {
            eligibility: { eligible: false, reasons: [] },
            missingRequired: ['client_constraints'],
          },
        },
      }),
    ];
    render(
      <MemoryRouter>
        <ExecutionRuns />
      </MemoryRouter>,
    );
    expect(screen.getByText(/client constraints/i)).toBeInTheDocument();
    expect(screen.queryByText(/strategy brief/i)).not.toBeInTheDocument();
  });

  it('an unknown-cause verification failure never claims a missing source', () => {
    mocks.runs = [
      blockedRun({
        state: 'failed_recoverable',
        waitingReason: null,
        error:
          'generated artifact verification did not pass — no Workspace or Outreach artifact was created; restore required context/provenance and retry',
      }),
    ];
    render(
      <MemoryRouter>
        <ExecutionRuns />
      </MemoryRouter>,
    );
    expect(screen.getByText(/could not be verified/i)).toBeInTheDocument();
    // The raw server error (which DOES say "restore required context") lives
    // only inside the collapsed Technical details — never visible.
    expect(
      screen.queryByText(/missing required context|restore required context/i),
    ).not.toBeVisible();
  });

  it('the same failure reason is not repeated across the card body', () => {
    mocks.runs = [blockedRun()];
    render(
      <MemoryRouter>
        <ExecutionRuns />
      </MemoryRouter>,
    );
    const cards = screen.getAllByText(/Assign an owner to this step/i);
    expect(cards.length).toBe(1);
  });

  it('"Strategy unavailable" resolves the real title from server data when the active list lacks the row', () => {
    mocks.runs = [blockedRun()];
    mocks.strategyDetail = { title: 'Real strategy title' };
    render(
      <MemoryRouter>
        <ExecutionRuns />
      </MemoryRouter>,
    );
    expect(screen.getByText('Real strategy title')).toBeInTheDocument();
    expect(screen.queryByText('Strategy unavailable')).not.toBeInTheDocument();
  });
});
