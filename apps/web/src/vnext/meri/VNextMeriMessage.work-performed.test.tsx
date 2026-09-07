import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../../components/chat/chat-store.js';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import type { TrustStep } from '../../components/chat/work-performed-shared.js';

vi.mock('../../lib/use-api.js', () => ({ useApi: () => ({}) }));
vi.mock('../components/feedback/toast.js', () => ({
  useCapiroToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('./meri-icons.js', () => ({
  MeriIcon: ({ name }: { name: string }) => <span data-testid={`icon-${name}`} />,
}));
vi.mock('./MeriAnalysisChartCard.js', () => ({ MeriAnalysisChartCard: () => null }));
vi.mock('./MeriMessageFeedback.js', () => ({ MeriMessageFeedback: () => null }));
vi.mock('./MeriMemoryCallout.js', () => ({ MeriMemoryCallout: () => null }));
vi.mock('./MeriAttachmentChip.js', () => ({
  MeriAttachmentChip: () => null,
  attachmentChipSpec: vi.fn(),
}));
vi.mock('./MeriWorkPerformed.js', () => ({
  MeriWorkPerformed: ({ planSteps }: { planSteps: string[] }) => (
    <div aria-label="Planned work">{planSteps.join(' ')}</div>
  ),
}));
vi.mock('./MeriResearchProgress.js', () => ({
  MeriResearchProgress: ({ steps }: { steps: TrustStep[] }) => (
    <div aria-label="Research progress">{steps.map((step) => step.label).join(' ')}</div>
  ),
}));

import { VNextMeriMessage } from './VNextMeriMessage.js';

const savedStep: TrustStep = {
  tool: 'get_client_context',
  label: 'Reviewed client profile',
  status: 'done',
  detail: 'Read 3 capabilities',
  count: 3,
};

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'saved-turn',
    role: 'assistant',
    content: 'The answer based on the client profile.',
    createdAt: new Date('2026-09-06T00:00:00Z'),
    planSteps: ['Review the selected client.'],
    trustSteps: [savedStep],
    orchestratorIntent: 'query_clients',
    orchestratorTier: 'deep',
    ...overrides,
  };
}

function controller(overrides: Record<string, unknown> = {}): MeriChatController {
  return {
    researchReports: {},
    researchOffers: {},
    pendingApprovals: [],
    isResearchStreaming: false,
    planSteps: ['Search current legislation.'],
    trustSteps: [{ tool: 'search_bills', label: 'Searching new bills', status: 'running' }],
    orchestratorIntent: 'query_intelligence',
    orchestratorTier: 'fast',
    ...overrides,
  } as unknown as MeriChatController;
}

function props(overrides: Record<string, unknown> = {}) {
  return {
    message: message(),
    controller: controller(),
    isLastAssistant: true,
    isStreaming: false,
    onOpenMemory: vi.fn(),
    onOpenSourceDetail: vi.fn(),
    onOpenTurnInspector: vi.fn(),
    ...overrides,
  };
}

describe('Meri message work performed', () => {
  test('uses the same source number and record in inline citations and the inspector', () => {
    const citation = {
      n: 7,
      id: 'attachment-1',
      title: 'Earlier attachment',
      type: 'source',
      tool: 'get_research_evidence',
      url: null,
      snippet: 'Verified attachment evidence.',
    };
    const original = props({
      message: message({ content: 'Evidence [7].', citations: [citation] }),
    });
    render(<VNextMeriMessage {...original} />);
    fireEvent.click(screen.getByRole('button', { name: '[7]' }));
    expect(screen.getByText('Verified attachment evidence.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }));
    expect(original.onOpenTurnInspector).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: expect.objectContaining({
          sources: [
            expect.objectContaining({
              citationNumber: 7,
              title: 'Earlier attachment',
            }),
          ],
        }),
      }),
      'thinking',
    );
  });

  test('keeps a completed turn’s work when a later turn starts streaming', () => {
    const original = props();
    const { rerender } = render(<VNextMeriMessage {...original} />);
    expect(screen.getByLabelText('Work performed')).toHaveTextContent(savedStep.label);

    rerender(<VNextMeriMessage {...original} isLastAssistant={false} isStreaming />);

    expect(screen.getByLabelText('Work performed')).toHaveTextContent(savedStep.label);
    expect(screen.queryByText('Searching new bills')).not.toBeInTheDocument();
    expect(screen.queryByTestId('icon-Loading01')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'SHOW REASONING' }));
    expect(screen.getByText('Review the selected client.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }));
    expect(original.onOpenTurnInspector).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'saved-turn',
        thinking: {
          plan: 'Review the selected client.',
          steps: [savedStep],
          intent: 'query_clients',
          tier: 'deep',
        },
      }),
      'thinking',
    );
  });

  test('renders the latest reloaded message and its inspector from saved work', () => {
    const original = props({
      controller: controller({
        planSteps: [],
        trustSteps: [],
        orchestratorIntent: null,
        orchestratorTier: null,
      }),
    });
    render(<VNextMeriMessage {...original} />);

    expect(screen.getByLabelText('Work performed')).toHaveTextContent(savedStep.label);
    fireEvent.click(screen.getByRole('button', { name: 'Show work' }));
    expect(original.onOpenTurnInspector).toHaveBeenCalledWith(
      expect.objectContaining({
        thinking: expect.objectContaining({
          steps: [savedStep],
          intent: 'query_clients',
          tier: 'deep',
        }),
      }),
      'thinking',
    );
  });

  test('does not borrow another turn’s work for a finished message without saved work', () => {
    render(
      <VNextMeriMessage
        {...props({
          message: message({
            planSteps: undefined,
            trustSteps: undefined,
            orchestratorIntent: undefined,
            orchestratorTier: undefined,
          }),
        })}
      />,
    );

    expect(screen.queryByLabelText('Work performed')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show work' })).not.toBeInTheDocument();
    expect(screen.queryByText('Searching new bills')).not.toBeInTheDocument();
  });

  test('uses live work only on the streaming message and distinguishes tool statuses', () => {
    render(
      <VNextMeriMessage
        {...props({
          isStreaming: true,
          controller: controller({
            trustSteps: [
              { tool: 'search_bills', label: 'Searching new bills', status: 'running' },
              {
                tool: 'read_document',
                label: 'Document unavailable',
                status: 'error',
                detail: 'Access denied',
              },
              { tool: 'get_directory', label: 'Read directory', status: 'done' },
            ],
          }),
        })}
      />,
    );

    const work = within(screen.getByLabelText('Work performed'));
    expect(work.getByText('Searching new bills')).toHaveAttribute('title', 'Running');
    expect(work.getByTestId('icon-Loading01')).toBeInTheDocument();
    expect(work.getByTestId('icon-AlertCircle')).toBeInTheDocument();
    expect(work.getByTestId('icon-CheckCircle')).toBeInTheDocument();
    expect(work.getByText('Document unavailable')).toHaveAttribute(
      'title',
      'Not completed: Access denied',
    );
    expect(work.queryByText(savedStep.label)).not.toBeInTheDocument();
  });

  test('shows an unfinished saved step as incomplete after streaming ends', () => {
    render(
      <VNextMeriMessage
        {...props({
          message: message({
            trustSteps: [{ tool: 'search_bills', label: 'Interrupted search', status: 'running' }],
          }),
        })}
      />,
    );
    const work = within(screen.getByLabelText('Work performed'));

    expect(work.getByTestId('icon-Clock')).toBeInTheDocument();
    expect(work.queryByTestId('icon-Loading01')).not.toBeInTheDocument();
    expect(work.queryByTestId('icon-CheckCircle')).not.toBeInTheDocument();
    expect(work.getByText('Interrupted search')).toHaveAttribute('title', 'Incomplete');
  });

  test('keeps a saved plan visible when an earlier turn has no tool steps', () => {
    render(
      <VNextMeriMessage
        {...props({
          isLastAssistant: false,
          isStreaming: true,
          message: message({ trustSteps: [] }),
        })}
      />,
    );
    expect(screen.getByLabelText('Planned work')).toHaveTextContent('Review the selected client.');
    expect(screen.queryByText('Search current legislation.')).not.toBeInTheDocument();
  });

  test('retains the dedicated live research progress display', () => {
    render(
      <VNextMeriMessage
        {...props({ isStreaming: true, controller: controller({ isResearchStreaming: true }) })}
      />,
    );
    expect(screen.getByLabelText('Research progress')).toHaveTextContent('Searching new bills');
    expect(screen.queryByLabelText('Work performed')).not.toBeInTheDocument();
  });
});
