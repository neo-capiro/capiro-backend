import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientFillWithMeriDrawer } from './ClientFillWithMeriDrawer.js';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock }),
}));

const baseRun = {
  id: 'run-1',
  clientId: 'client-1',
  requestedSources: [],
  sourceStates: {},
  summary: {},
  error: null,
  startedAt: '2026-08-25T16:00:00.000Z',
  completedAt: null,
  findings: [],
};

function renderDrawer() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <div className="capiro-vnext-root">
        <ClientFillWithMeriDrawer
          clientId="client-1"
          clientName="Overland AI"
          initialWebsite="https://overland.ai"
          open
          onClose={vi.fn()}
        />
      </div>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

describe('Fill with Meri prototype-parity drawer', () => {
  it('opens on the six-pass plan without silently starting a run', async () => {
    getMock.mockResolvedValue({ data: null });
    postMock.mockResolvedValue({ data: { ...baseRun, status: 'running' } });
    renderDrawer();

    const drawer = await screen.findByRole('dialog', { name: 'Fill with Meri' });
    expect(within(drawer).getByText('Understand client')).toBeInTheDocument();
    expect(within(drawer).getByText('Verify & reconcile')).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();

    fireEvent.click(within(drawer).getByText('Review source settings'));
    expect(within(drawer).getByDisplayValue('https://overland.ai')).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Start the review' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      '/api/clients/client-1/fill-with-meri/runs',
      { website: 'https://overland.ai' },
    ));
  });

  it('renders real task progress and wires cancel and failed-task retry', async () => {
    const run = {
      ...baseRun,
      status: 'running',
      stage: 'research',
      progress: { total: 3, queued: 0, running: 1, completed: 1, failed: 1, cancelled: 0 },
      tasks: [
        { id: 'task-web', runId: 'run-1', taskType: 'public_web', taskKey: 'web', status: 'running', dependsOn: [], attempt: 1, maxAttempts: 3, outputSummary: null, errorCode: null, errorMessage: null, nextAttemptAt: null, completedAt: null, createdAt: '', updatedAt: '' },
        { id: 'task-sam', runId: 'run-1', taskType: 'sam_gov', taskKey: 'sam', status: 'failed', dependsOn: [], attempt: 3, maxAttempts: 3, outputSummary: null, errorCode: 'unavailable', errorMessage: 'SAM.gov unavailable', nextAttemptAt: null, completedAt: null, createdAt: '', updatedAt: '' },
        { id: 'task-lda', runId: 'run-1', taskType: 'lda', taskKey: 'lda', status: 'completed', dependsOn: [], attempt: 1, maxAttempts: 3, outputSummary: null, errorCode: null, errorMessage: null, nextAttemptAt: null, completedAt: '', createdAt: '', updatedAt: '' },
      ],
    };
    getMock.mockImplementation((url: string) => Promise.resolve({ data: url.endsWith('/latest') ? run : run }));
    postMock.mockImplementation((url: string) => Promise.resolve({ data: url.endsWith('/cancel') ? { ...run, status: 'cancelled' } : run }));
    renderDrawer();

    expect(await screen.findByRole('dialog', { name: 'Meri is updating this record' })).toBeInTheDocument();
    expect(await screen.findByText('Public web research')).toBeInTheDocument();
    expect(screen.getByText('SAM.gov unavailable')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      '/api/clients/client-1/fill-with-meri/runs/run-1/tasks/task-sam/retry',
      {},
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      '/api/clients/client-1/fill-with-meri/runs/run-1/cancel',
      {},
    ));
  });

  it('uses the real completion score and stages only safe findings for Apply', async () => {
    const findings = [
      {
        id: 'safe', runId: 'run-1', kind: 'profile_field', targetKey: 'description', source: 'public_web', factKind: 'fact', currentValue: null, proposedValue: 'Autonomy software', evidence: [{ label: 'Company about page' }], confidence: .93, status: 'pending', appliedAt: null, createdAt: '',
      },
      {
        id: 'conflict', runId: 'run-1', kind: 'profile_field', targetKey: 'website', source: 'public_web', factKind: 'fact', currentValue: 'old.example', proposedValue: 'new.example', evidence: [], confidence: .98, status: 'pending', appliedAt: null, createdAt: '',
      },
      {
        id: 'coverage', runId: 'run-1', kind: 'profile_completion', targetKey: 'profile-completion', source: 'completion_audit', factKind: 'fact', currentValue: null, proposedValue: { score: 87 }, evidence: [], confidence: 1, status: 'informational', appliedAt: null, createdAt: '',
      },
    ];
    const run = { ...baseRun, status: 'completed', completedAt: '2026-08-25T16:01:00.000Z', stage: 'review_ready', findings };
    getMock.mockResolvedValue({ data: run });
    postMock.mockResolvedValue({ data: { applied: 1, failed: 0 } });
    renderDrawer();

    expect(await screen.findByRole('dialog', { name: 'Client record review' })).toBeInTheDocument();
    expect(screen.getByText('87%')).toBeInTheDocument();
    expect(screen.getByText('Needs your judgment')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept all safe changes' }));
    expect(screen.getByRole('button', { name: 'Apply 1 update' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply 1 update' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      '/api/clients/client-1/fill-with-meri/runs/run-1/apply',
      { findingIds: ['safe'] },
    ));
  });
});
