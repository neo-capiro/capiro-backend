/*
 * P0-2 web contract: a stranded run must be recoverable FROM THE UI.
 *
 * The audited defect: "no user-facing cancel, retry, reconcile, or repair path".
 * Cancel existed as dead server code with no route and no caller; retry was
 * impossible because the idempotency key returned the same stuck run; nothing
 * could repair a run that died between the artifact hop and its back-link write.
 *
 * These tests pin the UI half of the fix, and specifically pin the two properties
 * that make it safe:
 *
 *  1. The controls are driven by the SERVER's allowed-action list, not by a
 *     client-side state table. A UI that keeps its own copy of the state machine
 *     will eventually offer a button the API rejects — which is the misleading-
 *     state defect this audit is about.
 *  2. The stranded-reservation case is presented as an explicit human choice
 *     (link the found document / confirm nothing was created) and never as an
 *     automatic repair, because the create-only artifact client cannot ask
 *     upstream whether the document exists.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { App } from 'antd';
import type { ExecutionRun, ReconcileResult, RunAction, RunPolicy } from '../types.js';

const idle = { isLoading: false, isError: false, isSuccess: true, error: null };

let runsData: ExecutionRun[] = [];
let policyData: RunPolicy | undefined;
let reconcileResult: ReconcileResult;

const cancelMutate = vi.fn();
const retryMutate = vi.fn();
const markFailedMutate = vi.fn();
const reconcileMutate = vi.fn();
const resolveMutate = vi.fn();

vi.mock('../api.js', () => ({
  useExecutionRuns: () => ({ ...idle, data: runsData }),
  useExecuteRun: () => ({ mutate: vi.fn(), isPending: false }),
  useResumeRun: () => ({ mutate: vi.fn(), isPending: false }),
  useStrategies: () => ({ ...idle, data: [] }),
  useRunPolicy: () => ({ ...idle, data: policyData }),
  useCancelRun: () => ({ mutate: cancelMutate, isPending: false }),
  useRetryRun: () => ({ mutate: retryMutate, isPending: false }),
  useMarkRunFailed: () => ({ mutate: markFailedMutate, isPending: false }),
  useReconcileRun: () => ({
    // Invoke the caller's onSuccess with the canned result so the outcome
    // rendering is exercised, exactly as react-query would.
    mutate: (vars: { id: string }, opts?: { onSuccess?: (r: ReconcileResult) => void }) => {
      reconcileMutate(vars);
      opts?.onSuccess?.(reconcileResult);
    },
    isPending: false,
  }),
  useResolveReservation: () => ({ mutate: resolveMutate, isPending: false }),
}));

vi.mock('../clients-lite.js', () => ({
  useClientsLite: () => ({ ...idle, data: [] }),
}));

import { ExecutionReview } from './ExecutionReview.js';

function run(over: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    id: 'exec-stuck-1',
    missionId: 'm-1',
    strategyId: 'strat-1',
    state: 'failed_recoverable',
    trigger: 'manual',
    waitingReason: null,
    error: 'no agent progress for over 15 minutes while executing',
    summary: 'Draft the FY27 position paper',
    tasks: [],
    startedAt: '2026-07-25T10:00:00.000Z',
    finishedAt: null,
    createdAt: '2026-07-25T10:00:00.000Z',
    attempt: 1,
    ...over,
  };
}

function policy(actions: RunAction[], over: Partial<RunPolicy> = {}): RunPolicy {
  return {
    runId: 'exec-stuck-1',
    state: 'failed_recoverable',
    reason:
      'Failed part-way, but recoverable — reconcile to find out what was actually created, or retry.',
    actions,
    terminal: false,
    timeoutMinutes: null,
    heartbeatAt: '2026-07-25T10:00:00.000Z',
    attempt: 1,
    retryOfRunId: null,
    supersededByRunId: null,
    ...over,
  };
}

function renderReview() {
  return render(
    <MemoryRouter>
      <App>
        <ExecutionReview />
      </App>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cancelMutate.mockReset();
  retryMutate.mockReset();
  markFailedMutate.mockReset();
  reconcileMutate.mockReset();
  resolveMutate.mockReset();
  runsData = [run()];
  policyData = policy(['retry', 'reconcile', 'mark_failed', 'cancel', 'return_to_node', 'compare']);
  reconcileResult = { runId: 'exec-stuck-1', findings: [], applied: null, needsHuman: false };
});

describe('P0-2 recovery controls', () => {
  test('a recoverable failure shows the plain-words reason, not a bare state', () => {
    renderReview();
    expect(screen.getByText(/Failed part-way, but recoverable/)).toBeTruthy();
    expect(screen.getByText('Failed — recoverable')).toBeTruthy();
  });

  test('renders every control the server says is allowed', () => {
    renderReview();
    for (const label of [/Reconcile/, /Retry/, /Cancel run/, /Mark failed/, /Return to strategy/]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  test('the diagnostic ID control is ALWAYS available, whatever the state', () => {
    policyData = policy([]);
    renderReview();
    expect(screen.getByRole('button', { name: /Copy diagnostic ID/ })).toBeTruthy();
  });

  test('hides controls the server does NOT allow — the UI keeps no state machine of its own', () => {
    policyData = policy(['return_to_node', 'compare']);
    renderReview();

    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel run/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reconcile/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Mark failed/ })).toBeNull();
    // ...but the always-on one stays.
    expect(screen.getByRole('button', { name: /Copy diagnostic ID/ })).toBeTruthy();
  });

  test('renders no action buttons at all while the policy is unknown', () => {
    policyData = undefined;
    renderReview();
    expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Cancel run/ })).toBeNull();
  });

  test('Retry calls the retry mutation for the right run', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(retryMutate.mock.calls[0]![0]).toEqual({ id: 'exec-stuck-1' });
  });

  test('Cancel run calls the cancel mutation', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: /Cancel run/ }));
    expect(cancelMutate.mock.calls[0]![0]).toEqual({ id: 'exec-stuck-1' });
  });

  test('Mark failed calls the mark-failed mutation', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: /Mark failed/ }));
    expect(markFailedMutate.mock.calls[0]![0]).toEqual({ id: 'exec-stuck-1' });
  });

  test('shows a later attempt number so a retried run is not confused with the original', () => {
    policyData = policy(['retry'], { attempt: 3 });
    runsData = [run({ attempt: 3, supersededByRunId: null })];
    renderReview();
    expect(screen.getByText(/Attempt 3/)).toBeTruthy();
  });

  test('marks a superseded attempt as such', () => {
    policyData = policy(['compare'], { attempt: 2, supersededByRunId: 'exec-stuck-2' });
    runsData = [run({ state: 'superseded', attempt: 2, supersededByRunId: 'exec-stuck-2' })];
    renderReview();
    expect(screen.getByText(/superseded by a later attempt/)).toBeTruthy();
  });
});

describe('P0-2 reconcile outcomes', () => {
  test('reports what reconciliation repaired', () => {
    reconcileResult = {
      runId: 'exec-stuck-1',
      findings: [
        {
          code: 'ARTIFACT_NOT_ADVANCED',
          severity: 'auto',
          detail:
            'The Workspace draft was created and linked to the step, but the run never recorded it. Nothing was sent.',
          transition: { to: 'staged', reason: 'reconciliation found the created artifact' },
        },
      ],
      applied: { to: 'staged', reason: 'reconciliation found the created artifact' },
      needsHuman: false,
    };
    renderReview();

    fireEvent.click(screen.getByRole('button', { name: /Reconcile/ }));

    expect(reconcileMutate).toHaveBeenCalledWith({ id: 'exec-stuck-1' });
    // The finding is explained in words, including the safety fact.
    expect(screen.getByText(/never recorded it\. Nothing was sent\./)).toBeTruthy();
  });

  test('a clean reconcile explains that nothing needed repair', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: /Reconcile/ }));
    // No findings => no finding text rendered, and no reservation prompt.
    expect(screen.queryByText(/Check Workspace and Outreach/)).toBeNull();
  });
});

describe('P0-2 stranded reservation — an explicit human decision', () => {
  beforeEach(() => {
    reconcileResult = {
      runId: 'exec-stuck-1',
      findings: [
        {
          code: 'RESERVATION_WITHOUT_ARTIFACT',
          severity: 'human',
          detail:
            'Staging reserved its slot but never recorded a created artifact. A draft or record may or may not exist upstream.',
          transition: null,
          resolutions: ['Adopt its id', 'Release the reservation'],
        },
      ],
      applied: null,
      needsHuman: true,
    };
  });

  test('offers BOTH resolutions and does not repair anything itself', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: /Reconcile/ }));

    expect(
      screen.getByText(/Check Workspace and Outreach for a document from this run/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Link it/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Nothing was created/ })).toBeTruthy();
    expect(resolveMutate).not.toHaveBeenCalled();
  });

  test('"Link it" is disabled until an id is supplied — never adopt an empty ref', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: /Reconcile/ }));

    const link = screen.getByRole('button', { name: /Link it/ }) as HTMLButtonElement;
    expect(link.disabled).toBe(true);
    fireEvent.click(link);
    expect(resolveMutate).not.toHaveBeenCalled();
  });

  test('adopts the id the operator found', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: /Reconcile/ }));

    fireEvent.change(screen.getByLabelText('Created document id'), {
      target: { value: '  ws-found-1  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Link it/ }));

    expect(resolveMutate.mock.calls[0]![0]).toEqual({
      id: 'exec-stuck-1',
      action: 'adopt',
      // Trimmed — a pasted id with whitespace must not become a different ref.
      artifactRef: 'ws-found-1',
    });
  });

  test('releases the reservation when the operator confirms nothing was created', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: /Reconcile/ }));
    fireEvent.click(screen.getByRole('button', { name: /Nothing was created/ }));

    expect(resolveMutate.mock.calls[0]![0]).toEqual({ id: 'exec-stuck-1', action: 'release' });
  });
});

describe('P0-2 run state vocabulary', () => {
  test('a staged run says staged AND not sent — never a bare success', () => {
    runsData = [run({ state: 'staged', error: null })];
    policyData = policy(['open_artifact', 'return_to_node', 'cancel'], {
      state: 'staged',
      reason:
        'Staged — the draft or record exists and is linked to the step. Nothing was sent. Confirm to finish.',
    });
    renderReview();

    expect(screen.getByText('Staged — not sent')).toBeTruthy();
    expect(screen.getByText(/Nothing was sent/)).toBeTruthy();
  });

  test('a terminal failure surfaces its error and offers only a fresh attempt', () => {
    runsData = [run({ state: 'failed_terminal', error: 'the plan step is no longer in the plan' })];
    policyData = policy(['retry', 'return_to_node', 'compare'], {
      state: 'failed_terminal',
      terminal: true,
      reason: 'Failed and cannot be recovered — start a new attempt if you still need this.',
    });
    renderReview();

    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getByText(/the plan step is no longer in the plan/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cancel run/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy();
  });
});
