import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('./ManagedComposerPlus.js', () => ({
  ManagedComposerPlus: ({ onUpload }: { onUpload: () => void }) => (
    <button type="button" aria-label="Add files or connected apps" onClick={onUpload}>
      +
    </button>
  ),
}));
vi.mock('./ChatMessage.js', () => ({
  ChatMessage: ({ content, role }: { content: string; role: string }) => (
    <div data-testid={`message-${role}`}>{content}</div>
  ),
}));
vi.mock('./WorkPerformed.js', () => ({ WorkPerformed: () => <div data-testid="work-log" /> }));
vi.mock('./AnalysisChartCard.js', () => ({ AnalysisChartCard: () => <div /> }));
vi.mock('./ActionProposalList.js', () => ({ ActionProposalList: () => <div data-testid="proposals" /> }));
// Rendered shallowly, but faithfully enough to assert WHICH question is shown
// and that submitting routes the answer back to the controller.
vi.mock('./ResearchClarifyForm.js', () => ({
  ResearchClarifyForm: ({
    questions,
    headline,
    onSubmit,
  }: {
    questions: Array<string | { question: string }>;
    headline?: string;
    onSubmit: (answers: Record<string, string>, skipped: boolean) => void;
  }) => (
    <div data-testid="clarify-form">
      <span>{headline}</span>
      {questions.map((q, i) => (
        <span key={i}>{typeof q === 'string' ? q : q.question}</span>
      ))}
      <button type="button" onClick={() => onSubmit({ '0': 'Acme Corp' }, false)}>
        Send answer
      </button>
    </div>
  ),
}));
vi.mock('./MeriCanvas.js', () => ({ MeriCanvas: () => <div /> }));
vi.mock('../../env.js', () => ({ config: { apiBaseUrl: 'https://api.test' } }));
// The component calls `useApi()` (added with the semantic-skills work), and the
// real hook uses Clerk's `useAuth`, which throws outside a ClerkProvider.
vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({
    get: () => Promise.resolve({ data: [] }),
    post: () => Promise.resolve({ data: {} }),
  }),
}));

import { MeriWorkspaceConversation } from './MeriWorkspaceConversation.js';

function makeController(overrides: Record<string, unknown> = {}) {
  return {
    messages: [],
    isStreaming: false,
    activeConversationId: null,
    clients: [
      { id: 'client-1', name: 'Kestrel Dynamics' },
      { id: 'client-2', name: 'C2 Strategies' },
    ],
    selectedClientValue: '',
    changeSessionClient: vi.fn(),
    stagedAttachments: [],
    attachmentNotice: null,
    handleAttachFiles: vi.fn(),
    removeStagedAttachment: vi.fn(),
    sendMessage: vi.fn(),
    handleStop: vi.fn(),
    pendingApprovals: [],
    approvingProposalId: null,
    handleApprovePending: vi.fn(),
    handleApproveAll: vi.fn(),
    handleDismissPending: vi.fn(),
    hermesInteractions: [],
    hermesRunStatus: null,
    hermesBusyRequestId: null,
    resolveHermesApproval: vi.fn(),
    answerHermesClarification: vi.fn(),
    activeArtifact: null,
    setActiveArtifact: vi.fn(),
    authHeaders: vi.fn(),
    orchestratorIntent: null,
    orchestratorTier: null,
    trustSteps: [],
    planSteps: [],
    researchAwaitingAnswers: false,
    researchQuestions: [],
    submitResearchAnswers: vi.fn(),
    researchReports: {},
    researchOffers: {},
    handleRunResearchOffer: vi.fn(),
    fetchResearchExport: vi.fn(),
    orchestratorConflict: null,
    messagesEndRef: { current: null },
    ...overrides,
  } as never;
}

describe('MeriWorkspaceConversation', () => {
  test('matches the prototype new-thread hierarchy and prompt library', () => {
    render(
      <MeriWorkspaceConversation
        controller={makeController()}
        userLabel="Maya Reyes"
        greetingName="Maya"
        tenantName="Ardent Federal Strategies"
      />,
    );

    expect(screen.getByRole('heading', { name: /Maya\./ })).toBeTruthy();
    expect(screen.getByText(/Ardent Federal Strategies · 2 clients in scope/)).toBeTruthy();
    expect(screen.getByText('PROMPT LIBRARY')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add files or connected apps' })).toBeTruthy();
    expect(
      screen.getByText(
        'MERI CITES SOURCES · NETWORK WRITES AND EXTERNAL SENDS REQUIRE YOUR APPROVAL',
      ),
    ).toBeTruthy();
  });

  test('sends a prompt from the prototype composer', () => {
    const sendMessage = vi.fn();
    render(
      <MeriWorkspaceConversation
        controller={makeController({ sendMessage })}
        userLabel="Maya Reyes"
        greetingName="Maya"
        tenantName="Ardent Federal Strategies"
      />,
    );

    fireEvent.change(screen.getByLabelText('Message Meri'), {
      target: { value: 'What changed for Kestrel?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(sendMessage).toHaveBeenCalledWith('What changed for Kestrel?');
  });

  test('uses the scope menu instead of the old header client dropdown', () => {
    const changeSessionClient = vi.fn();
    render(
      <MeriWorkspaceConversation
        controller={makeController({
          activeConversationId: 'conv-1',
          selectedClientValue: 'client-1',
          changeSessionClient,
        })}
        userLabel="Maya Reyes"
        greetingName="Maya"
        tenantName="Ardent Federal Strategies"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /SCOPE: KESTREL DYNAMICS/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /C2 Strategies/i }));
    expect(changeSessionClient).toHaveBeenCalledWith('client-2');
  });

  test('renders real thread messages with the prototype user and Meri hierarchy', () => {
    const now = new Date('2026-08-07T18:30:00-04:00');
    render(
      <MeriWorkspaceConversation
        controller={makeController({
          activeConversationId: 'conv-1',
          selectedClientValue: 'client-1',
          messages: [
            { id: 'u1', role: 'user', content: 'What changed?', createdAt: now },
            { id: 'a1', role: 'assistant', content: 'The Senate moved first.', createdAt: now },
          ],
        })}
        userLabel="Maya Reyes"
        greetingName="Maya"
        tenantName="Ardent Federal Strategies"
      />,
    );

    expect(screen.getByTestId('message-user')).toHaveTextContent('What changed?');
    expect(screen.getByTestId('message-assistant')).toHaveTextContent('The Senate moved first.');
    expect(screen.getByText('Meri')).toBeTruthy();
    expect(screen.getByText(/SCOPED TO KESTREL DYNAMICS/)).toBeTruthy();
  });

  test('renders a native Hermes approval card while the run is still streaming, and Run once calls resolveHermesApproval', () => {
    const resolveHermesApproval = vi.fn();
    render(
      <MeriWorkspaceConversation
        controller={makeController({
          isStreaming: true,
          messages: [
            { id: 'u1', role: 'user', content: 'Run the cleanup script', createdAt: new Date() },
          ],
          hermesRunStatus: 'waiting_for_approval',
          hermesInteractions: [
            {
              kind: 'approval',
              runId: 'run-1',
              requestId: 'req-1',
              proposalId: 'hermes:run-1:req-1',
              label: 'Run: rm -rf build/',
              command: 'rm -rf build/',
              choices: ['once', 'deny'],
              createdAt: new Date().toISOString(),
              // Not yet expired relative to the real clock HermesApprovalCard
              // reads by default (no `now` override is threaded through here).
              expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
              resolution: null,
            },
          ],
          resolveHermesApproval,
        })}
        userLabel="Maya Reyes"
        greetingName="Maya"
        tenantName="Ardent Federal Strategies"
      />,
    );

    // Renders even while isStreaming — unlike the business pendingApprovals
    // list, which is gated on `!isStreaming` (contracts.md: waiting_for_approval
    // is a LIVE mid-turn state, not a post-turn one).
    expect(screen.getByText('rm -rf build/')).toBeTruthy();
    expect(screen.getByText('Waiting for your approval')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run once' }));
    expect(resolveHermesApproval).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1', runId: 'run-1' }),
      'approve_once',
    );
  });

  test('renders a clarification whose run has already ended, and lets the user answer it', () => {
    // A durable continuation is defined by its request id, not by a live run —
    // by the time the user reads the question the run has usually finished.
    const answerHermesClarification = vi.fn();
    render(
      <MeriWorkspaceConversation
        controller={makeController({
          isStreaming: false,
          hermesRunStatus: null,
          messages: [{ id: 'u1', role: 'user', content: 'File this', createdAt: new Date() }],
          hermesInteractions: [
            {
              kind: 'clarification',
              runId: 'run-finished',
              requestId: 'clar_7',
              question: 'Which client should I file this under?',
              choices: [],
              multiSelect: false,
              createdAt: new Date().toISOString(),
              resolution: null,
              runTerminal: true,
            },
          ],
          answerHermesClarification,
        })}
        userLabel="Maya Reyes"
        greetingName="Maya"
        tenantName="Ardent Federal Strategies"
      />,
    );

    expect(screen.getByText('Which client should I file this under?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(answerHermesClarification).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'clar_7', runId: 'run-finished' }),
      'Acme Corp',
    );
  });

  test('renders a native approval on a finished run as no-longer-actionable, not as a live decision', () => {
    render(
      <MeriWorkspaceConversation
        controller={makeController({
          messages: [{ id: 'u1', role: 'user', content: 'Clean up', createdAt: new Date() }],
          hermesInteractions: [
            {
              kind: 'approval',
              runId: 'run-finished',
              requestId: 'req-1',
              proposalId: 'hermes:run-finished:req-1',
              label: 'Run: rm -rf build/',
              command: 'rm -rf build/',
              choices: ['once', 'deny'],
              createdAt: new Date().toISOString(),
              expiresAt: null,
              resolution: null,
              runTerminal: true,
            },
          ],
        })}
        userLabel="Maya Reyes"
        greetingName="Maya"
        tenantName="Ardent Federal Strategies"
      />,
    );

    expect(screen.getByText(/run has ended/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run once' })).toBeNull();
  });

  test('states plainly that mid-run guidance is not available for this runtime yet', () => {
    // contracts.md §6 "Steer" / MW-09: the route exists server-side but there
    // is no steering UX, so the UI says so instead of implying the capability.
    render(
      <MeriWorkspaceConversation
        controller={makeController({
          isStreaming: true,
          messages: [{ id: 'u1', role: 'user', content: 'Do the thing', createdAt: new Date() }],
          hermesRunStatus: 'running',
        })}
        userLabel="Maya Reyes"
        greetingName="Maya"
        tenantName="Ardent Federal Strategies"
      />,
    );

    const steer = screen.getByRole('button', { name: /not available for this runtime yet/i });
    expect(steer).toBeDisabled();
  });

  test('does not offer the guidance affordance when the run is waiting on the user instead of working', () => {
    render(
      <MeriWorkspaceConversation
        controller={makeController({
          messages: [{ id: 'u1', role: 'user', content: 'Do the thing', createdAt: new Date() }],
          hermesRunStatus: 'waiting_for_clarification',
        })}
        userLabel="Maya Reyes"
        greetingName="Maya"
        tenantName="Ardent Federal Strategies"
      />,
    );

    expect(screen.getByText('Waiting for your answer')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /not available for this runtime yet/i })).toBeNull();
  });
});
