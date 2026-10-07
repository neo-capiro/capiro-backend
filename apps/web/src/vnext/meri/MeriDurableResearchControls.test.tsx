import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import type { MeriDurableResearchObserver } from './useMeriDurableResearch.js';

const mocks = vi.hoisted(() => ({
  observe: vi.fn(),
  send: vi.fn(),
  stop: vi.fn(),
  resume: vi.fn(),
}));
vi.mock('./useMeriDurableResearch.js', () => ({
  useMeriDurableResearch: (...args: unknown[]) => mocks.observe(...args),
}));
import {
  APPROVAL_WAIT_REFRESH_MS,
  MeriDurableResearchControls,
} from './MeriDurableResearchControls.js';

function observer(status: 'running' | 'cancel_requested' = 'running'): MeriDurableResearchObserver {
  return {
    snapshot: {
      version: 1,
      researchId: 'research-1',
      run: {
        id: 'run-1',
        leaseEpoch: 2,
        eventSequence: 8,
        phase: 'research',
        status,
        stage: 'Reading the House bill',
        startedAt: '2026-09-28T12:00:00.000Z',
        heartbeatAt: '2026-09-28T12:00:10.000Z',
      },
      coordinator: {
        version: 1,
        planVersion: 2,
        goalRevision: 1,
        goal: {
          objective: 'Assess the bill for the selected client',
          constraints: ['House version only'],
          deliverables: [],
        },
        deadlineAt: null,
        leaseEpoch: 2,
        aggregateBudgetRef: 'researchToolBudget',
        cancellation:
          status === 'cancel_requested'
            ? {
                state: 'requested',
                requestId: 'cancel-1',
                reason: 'User pressed Stop',
                requestedAt: '2026-09-28T12:05:00.000Z',
                observedAt: null,
              }
            : { state: 'none' },
        steps: [
          {
            id: 'read-bill',
            objective: 'Read the authoritative bill',
            dependsOn: [],
            goalRevision: 1,
            effect: 'safe_read',
            attempt: 1,
            deadlineAt: null,
            outcome: 'completed',
            sourceRefs: ['receipt:bill'],
            operationRefs: [],
            leaseEpoch: 2,
            completedAt: '2026-09-28T12:04:00.000Z',
            failureCode: null,
          },
          {
            id: 'assess',
            objective: 'Assess client impact',
            dependsOn: ['read-bill'],
            goalRevision: 1,
            effect: 'safe_read',
            attempt: 1,
            deadlineAt: null,
            outcome: 'reserved',
            sourceRefs: [],
            operationRefs: [],
            leaseEpoch: 2,
            completedAt: null,
            failureCode: null,
          },
        ],
      },
      events: [],
      nextSequence: 8,
    },
    error: null,
    steeringSending: false,
    steeringTransportUncertain: false,
    steeringConflictRevision: null,
    acceptedDirection: null,
    refresh: vi.fn(),
    sendSteering: mocks.send,
  };
}

const controller = {
  authHeaders: vi.fn(async () => ({})),
  handleStop: mocks.stop,
  resumeResearch: mocks.resume,
  researchRecovery: null,
  isStreaming: false,
} as unknown as MeriChatController;

beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue(true);
  mocks.stop.mockReset();
  mocks.resume.mockReset();
  mocks.observe.mockReset().mockReturnValue(observer());
});

describe('Meri durable research controls', () => {
  test('shows current goal/progress and requires explicit Send for editable steering', async () => {
    render(<MeriDurableResearchControls controller={controller} researchId="research-1" />);
    expect(screen.getByText('Assess the bill for the selected client')).toBeInTheDocument();
    expect(screen.getByText('Goal revision 1')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 current steps complete')).toBeInTheDocument();
    expect(screen.getByText(/continues in the background/)).toBeInTheDocument();

    const direction = screen.getByLabelText('Update the research direction');
    fireEvent.change(direction, { target: { value: 'Focus on section 4.' } });
    expect(mocks.send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send direction' }));
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith('Focus on section 4.'));
  });

  test('Stop is explicit and cancel_requested remains Stopping until terminal observation', () => {
    const view = render(
      <MeriDurableResearchControls controller={controller} researchId="research-1" />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(mocks.stop).toHaveBeenCalledOnce();

    mocks.observe.mockReturnValue(observer('cancel_requested'));
    view.rerender(<MeriDurableResearchControls controller={controller} researchId="research-1" />);
    expect(screen.getAllByText('Stopping…').length).toBeGreaterThan(0);
    expect(screen.getByText(/worker to confirm termination/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send direction' })).toBeNull();
  });

  test('renders a terminal coordinator without a run and does not offer mutation controls', () => {
    const terminal = observer();
    terminal.snapshot = terminal.snapshot ? { ...terminal.snapshot, run: null } : null;
    mocks.observe.mockReturnValue(terminal);
    render(<MeriDurableResearchControls controller={controller} researchId="research-1" />);
    expect(screen.getByText('complete')).toBeInTheDocument();
    expect(screen.getByText('The durable research task is complete.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send direction' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });
});

describe('Release D: a job waiting on an approval card', () => {
  function withApprovalStep(operationRefs: string[]): MeriDurableResearchObserver {
    const base = observer();
    const snapshot = base.snapshot!;
    return {
      ...base,
      snapshot: {
        ...snapshot,
        run: null,
        coordinator: {
          ...snapshot.coordinator,
          steps: [
            ...snapshot.coordinator.steps.map((step) => ({ ...step, outcome: 'completed' as const })),
            {
              id: 'propose-summary-email',
              objective: 'Email me the summary',
              dependsOn: ['assess'],
              goalRevision: 1,
              effect: 'approval_required',
              attempt: 0,
              deadlineAt: null,
              outcome: 'waiting_for_approval',
              sourceRefs: [],
              operationRefs,
              leaseEpoch: 2,
              completedAt: null,
              failureCode: null,
            },
          ],
        },
      } as never,
    };
  }

  test('says approval is needed and opens the Approvals panel', () => {
    mocks.observe.mockReturnValue(withApprovalStep(['proposal:proposal-1']));
    const onOpenApprovals = vi.fn();
    render(
      <MeriDurableResearchControls
        controller={controller}
        researchId="research-1"
        onOpenApprovals={onOpenApprovals}
      />,
    );
    expect(screen.getByText('approval needed')).toBeInTheDocument();
    expect(screen.getByText(/nothing happens until you\s+approve it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review it' }));
    expect(onOpenApprovals).toHaveBeenCalledOnce();
  });

  test('re-checks the job while the card waits, so a decision clears it', () => {
    vi.useFakeTimers();
    try {
      const waiting = withApprovalStep(['proposal:proposal-1']);
      mocks.observe.mockReturnValue(waiting);
      render(<MeriDurableResearchControls controller={controller} researchId="research-1" />);
      expect(waiting.refresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(APPROVAL_WAIT_REFRESH_MS);
      expect(waiting.refresh).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test('an approval step that was never posted is not a wait', () => {
    mocks.observe.mockReturnValue(withApprovalStep([]));
    render(<MeriDurableResearchControls controller={controller} researchId="research-1" />);
    expect(screen.queryByText('approval needed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review it' })).toBeNull();
  });
});
