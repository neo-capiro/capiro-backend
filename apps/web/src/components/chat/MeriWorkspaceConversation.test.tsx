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
vi.mock('./ResearchClarifyForm.js', () => ({ ResearchClarifyForm: () => <div /> }));
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
});
