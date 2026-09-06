import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionRuns } from './ExecutionRuns.js';
import { ProposalsQueue } from './ProposalsQueue.js';
import { AgentsTabsVNext } from './AgentsTabsVNext.js';

const mocks = vi.hoisted(() => ({
  runs: [] as any[], firm: [] as any[], execute: vi.fn(), resume: vi.fn(), retry: vi.fn(), cancel: vi.fn(), transition: vi.fn(),
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
}));
vi.mock('../ScopeBar.js', () => ({ ScopeBar: ({ status }: any) => <p>{status.label}</p> }));
const run = {
  id: 'run-one', state: 'approved', strategyId: '11111111-1111-4111-8111-111111111111',
  trigger: 'manual', createdAt: '2026-09-01', tasks: [], summary: 'Reviewable plan',
};
beforeEach(() => {
  mocks.runs = []; mocks.firm = [];
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

  it('allows canceling a parked send run while keeping send and resume unavailable', () => {
    mocks.runs = [{ ...run, state: 'waiting_for_input', waitingReason: 'awaiting send approval' }];
    render(<MemoryRouter><ExecutionRuns /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /approve.*send|resume|execute plan/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.cancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(mocks.cancel).toHaveBeenCalledWith({ id: run.id }, expect.any(Object));
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it('follows a Stage H deep link after the runs page is already mounted', () => {
    render(<MemoryRouter><ExecutionRuns /><ChangeCriteriaRoute /></MemoryRouter>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open criteria link' }));
    expect(screen.getByRole('dialog', { name: 'Stage H security criteria' })).toBeInTheDocument();
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

  it('includes firm checks in the shared approval status even when no change-sets exist', () => {
    mocks.firm = [{ ...run, strategyId: null, state: 'ready_for_review', findings: {} }];
    render(<MemoryRouter><AgentsTabsVNext tab="runs" /></MemoryRouter>);
    expect(screen.getByText('Human approval required')).toBeInTheDocument();
    expect(screen.queryByText('No pending review')).not.toBeInTheDocument();
  });
});
