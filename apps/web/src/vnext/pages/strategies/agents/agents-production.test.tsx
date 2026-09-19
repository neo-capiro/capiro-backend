import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionRuns } from './ExecutionRuns.js';
import { ProposalsQueue } from './ProposalsQueue.js';
import { AgentsTabsVNext } from './AgentsTabsVNext.js';

const mocks = vi.hoisted(() => ({
  runs: [] as any[], firm: [] as any[], execute: vi.fn(), resume: vi.fn(), retry: vi.fn(), cancel: vi.fn(), transition: vi.fn(), reconcile: vi.fn(), policyAvailable: true,
}));
vi.mock('../strategies-api.js', () => ({
  clientName: () => '', memberName: () => 'Reviewer',
  useExecutionRuns: () => ({ data: mocks.runs, isSuccess: true }),
  useFirmReviewRuns: () => ({ data: mocks.firm, isSuccess: true }),
  useStrategies: () => ({ data: [] }), useClientsLite: () => ({ data: [] }),
  useTenantMembers: () => ({ data: [] }), useStrategy: () => ({ data: null }),
  useChangeSets: () => ({ data: [], isSuccess: true }),
  useApproveChangeSet: () => ({}), useApplyChangeSet: () => ({}),
  useRejectChangeSet: () => ({}), useUndoChangeSet: () => ({}),
  useExecuteRun: () => ({ mutate: mocks.execute }),
  useResumeRun: () => ({ mutate: mocks.resume }),
  useRetryRun: () => ({ mutate: mocks.retry }),
  useCancelRun: () => ({ mutate: mocks.cancel }),
  useTransitionRun: () => ({ mutate: mocks.transition }),
  useRunPolicy: (id: string) => ({ data: !mocks.policyAvailable ? undefined : { state: mocks.runs.find((r) => r.id === id)?.state, actions: ['cancel', 'execute', 'resume', 'retry', 'reconcile'], timeoutMinutes: 15 } }),
  useReconcileRun: () => ({ mutate: mocks.reconcile }),
}));
vi.mock('../ScopeBar.js', () => ({ ScopeBar: ({ status }: any) => <p>{status.label}</p> }));
const run = {
  id: 'run-one', state: 'approved', strategyId: '11111111-1111-4111-8111-111111111111',
  trigger: 'manual', createdAt: '2026-09-01', tasks: [], summary: 'Reviewable plan',
};
beforeEach(() => {
  mocks.runs = []; mocks.firm = []; mocks.policyAvailable = true; mocks.reconcile.mockReset();
  mocks.execute.mockReset(); mocks.resume.mockReset(); mocks.retry.mockReset(); mocks.cancel.mockReset(); mocks.transition.mockReset();
});
function ChangeCriteriaRoute() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('?stage-h=1')}>Open criteria link</button>;
}

describe('Agent production regressions', () => {
  it('permits a previously approved plan to be executed explicitly', () => {
    mocks.runs = [run];
    render(<MemoryRouter><ExecutionRuns /></MemoryRouter>);
    expect(mocks.execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Execute plan' }));
    expect(mocks.execute).toHaveBeenCalledWith({ id: run.id }, expect.any(Object));
  });

  it('allows canceling a parked send run; resume completes it (no send control)', () => {
    mocks.runs = [{ ...run, state: 'waiting_for_input', waitingReason: 'awaiting send approval' }];
    render(<MemoryRouter><ExecutionRuns /></MemoryRouter>);
    // No external-send control ever renders; the staged record is the product.
    expect(screen.queryByRole('button', { name: /approve.*send|execute plan/i })).not.toBeInTheDocument();
    // A legacy send-approval park is resumable — Resume completes the run.
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(mocks.resume).toHaveBeenCalledWith({ id: run.id }, expect.any(Object));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(mocks.cancel).toHaveBeenCalledWith({ id: run.id }, expect.any(Object));
  });

  it('follows a staging-rules deep link after the runs page is already mounted', () => {
    render(<MemoryRouter><ExecutionRuns /><ChangeCriteriaRoute /></MemoryRouter>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open criteria link' }));
    expect(screen.getByRole('dialog', { name: 'Staging and review rules' })).toBeInTheDocument();
  });

  it('retries a recoverable failure through the retry action instead of the waiting-only resume action', () => {
    mocks.runs = [{ ...run, state: 'failed_recoverable' }];
    render(<MemoryRouter><ExecutionRuns /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Retry run' }));
    expect(mocks.retry).toHaveBeenCalledWith({ id: run.id }, expect.any(Object));
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it('acknowledges a firm check only after an explicit review and reports a failed transition', () => {
    mocks.firm = [{ ...run, strategyId: null, state: 'ready_for_review', findings: {} }];
    render(<MemoryRouter><ProposalsQueue /></MemoryRouter>);
    expect(mocks.transition).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    expect(mocks.transition).toHaveBeenCalledWith({ id: run.id, to: 'completed' }, expect.any(Object));
    act(() => mocks.transition.mock.calls[0]![1].onError(new Error('Review could not be recorded')));
    expect(screen.getByRole('alert')).toHaveTextContent('Review could not be recorded');
    expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeInTheDocument();
  });

  it('includes firm checks in the shared review status even when no change-sets exist', () => {
    mocks.firm = [{ ...run, strategyId: null, state: 'ready_for_review', findings: {} }];
    render(<MemoryRouter><AgentsTabsVNext tab="runs" /></MemoryRouter>);
    expect(screen.getByText('Review pending')).toBeInTheDocument();
    expect(screen.queryByText('No pending review')).not.toBeInTheDocument();
  });
  it('requires loaded server policy before staging or retrying', () => {
    mocks.runs = [run]; mocks.policyAvailable = false;
    render(<MemoryRouter><ExecutionRuns /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Execute plan' })).toBeDisabled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('checks an old queued run only after an explicit action and does not retry or stage it', () => {
    mocks.runs = [{ ...run, state: 'queued' }];
    render(<MemoryRouter><ExecutionRuns /></MemoryRouter>);
    expect(screen.getByText(/no recorded progress beyond/)).toBeInTheDocument();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check run status' }));
    expect(mocks.reconcile).toHaveBeenCalledWith({ id: run.id }, expect.any(Object));
    expect(mocks.retry).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('prepares a reviewed replacement for version drift instead of resuming the obsolete plan', () => {
    mocks.runs = [{ ...run, state: 'waiting_for_input', waitingReason: 'version drift: plan changed' }];
    render(<MemoryRouter><ExecutionRuns /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare updated plan' }));
    expect(mocks.retry).toHaveBeenCalledWith({ id: run.id }, expect.any(Object));
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it('a staged run offers its policy-listed recovery action instead of hiding as terminal', () => {
    // A staged run holds existing artifacts and can need a further reconcile to
    // reach completed; the action comes from the server run policy, never fabricated.
    mocks.runs = [{ ...run, state: 'staged' }];
    render(<MemoryRouter><ExecutionRuns /></MemoryRouter>);
    const check = screen.getByRole('button', { name: 'Check run status' });
    fireEvent.click(check);
    expect(mocks.reconcile).toHaveBeenCalledWith({ id: run.id }, expect.any(Object));
  });

  it('a staged run whose policy lists no recovery action renders no recovery control', () => {
    mocks.policyAvailable = false;
    mocks.runs = [{ ...run, state: 'staged' }];
    render(<MemoryRouter><ExecutionRuns /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: 'Check run status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

});
