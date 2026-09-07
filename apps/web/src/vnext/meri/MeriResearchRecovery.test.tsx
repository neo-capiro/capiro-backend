import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { readRecoveredResearch } from '../../components/chat/meri-research-recovery.js';
import { MeriResearchRecovery } from './MeriResearchRecovery.js';
vi.mock('../../components/chat/useMeriChatController.js', () => ({
  formatElapsed: (ms: number) => `${ms / 1000}s`,
}));
vi.mock('./MeriAgentSteps.js', () => ({ MeriAgentSteps: () => null }));
import { MeriResearchProgress } from './MeriResearchProgress.js';
const saved = (status: string, phase = 'research') =>
  readRecoveredResearch(
    {
      id: 'research-1',
      metadata: { handoff: { conversationId: 'conversation-1' } },
      run: { id: 'run-1', phase, status, stage: 'Reviewing hearing evidence' },
    },
    'conversation-1',
  );

describe('saved research UI', () => {
  test('offers explicit resume for interrupted work and never claims it is still running', () => {
    const resume = vi.fn();
    render(
      <MeriResearchRecovery
        research={saved('interrupted')}
        error={null}
        busy={false}
        onResume={resume}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('interrupted');
    fireEvent.click(screen.getByRole('button', { name: 'Resume research' }));
    expect(resume).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Stop research' })).toBeNull();
  });
  test('offers Stop for server-running work and no duplicate Resume action', () => {
    render(
      <MeriResearchRecovery
        research={saved('running')}
        error={null}
        busy={false}
        onResume={vi.fn()}
        onStop={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('continues on the server');
    expect(screen.getByRole('button', { name: 'Stop research' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Resume research' })).toBeNull();
  });
  test('does not derive completion percentage from elapsed time versus a budget', () => {
    const { container } = render(
      <MeriResearchProgress
        isStreaming
        progress={{ note: 'Reading transcripts', elapsedMs: 95_000, budgetMs: 100_000 }}
        steps={[]}
      />,
    );
    expect(screen.getByText('95s ELAPSED')).toBeInTheDocument();
    expect(container.querySelector('.vnext-meri__research-bar-indeterminate')).toBeTruthy();
    expect(container.textContent).not.toContain('95%');
    expect(container.textContent).not.toContain('OF 100s');
  });
  test('rejects an out-of-scope handoff and unrecognized run statuses', () => {
    expect(
      readRecoveredResearch(
        {
          id: 'research-1',
          metadata: { handoff: { conversationId: 'other' } },
          run: { id: 'run', phase: 'research', status: 'running' },
        },
        'conversation-1',
      ),
    ).toBeNull();
    expect(saved('almost_complete')).toBeNull();
  });
});
