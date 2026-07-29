import type { MeriAlert } from './chat-store.js';
import type { MeriChatController } from './useMeriChatController.js';

const noop = () => undefined;
const asyncNoop = async () => undefined;

export function createMeriVisualController({
  empty = false,
  alerts = [],
}: {
  empty?: boolean;
  alerts?: MeriAlert[];
} = {}): MeriChatController {
  const messages = empty
    ? []
    : [
        {
          id: 'u1',
          role: 'user' as const,
          content: 'What changed for C2 Strategies today?',
          createdAt: new Date('2026-07-11T12:00:00.000Z'),
        },
        {
          id: 'a1',
          role: 'assistant' as const,
          content:
            '**Three developments need attention today.**\n\n- The FY27 defense markup moved to Thursday.\n- A competitor filed a new LD-2 covering energy storage.\n- The grid-resilience comment period opened for 30 days.\n\nI can turn this into a client-ready brief.',
          createdAt: new Date('2026-07-11T12:01:00.000Z'),
          suggestions: ['Draft the client brief', 'Show the cited sources'],
          feedback: null,
        },
      ];

  return {
    isOpen: true,
    messages,
    sessionId: 'visual-session',
    isStreaming: false,
    alertsBadge: alerts.length,
    pendingAlerts: alerts,
    alertsOpen: false,
    setAlertsOpen: noop,
    sessionTitle: 'C2 — weekly brief',
    setSessionTitle: noop,
    clients: [
      { id: 'c2', name: 'C2 Strategies' },
      { id: 'maven', name: 'Maven Advocacy Partners' },
    ],
    selectedClientValue: 'c2',
    changeSessionClient: asyncNoop,
    activeConversationId: 'visual-session',
    isSavingMeta: false,
    metaError: null,
    learnedMemories: [
      {
        id: 'm1',
        key: 'format',
        value: 'Weekly briefs should lead with action items.',
        scope: 'private',
      },
      { id: 'm2', key: 'tone', value: 'Use concise, client-ready language.', scope: 'firm' },
    ],
    forgottenMemories: [],
    learnedExpanded: false,
    setLearnedExpanded: noop,
    orchestratorConflict: null,
    pendingApprovals: [],
    approvingProposalId: null,
    orchestratorTemplate: null,
    contextLabel: 'Portfolio · C2 Strategies',
    hideMeriFab: false,
    activeArtifact: null,
    setActiveArtifact: noop,
    stagedAttachments: [],
    attachmentNotice: null,
    writeMode: false,
    researchMode: false,
    researchAwaitingAnswers: false,
    researchQuestions: [],
    researchReports: {},
    // ChatDrawer indexes this by message id; omitting it made the fixture throw
    // "Cannot read properties of undefined (reading 'u1')". Pre-existing gap.
    researchOffers: {},
    lastUserMessageId: empty ? null : 'u1',
    editingMessageId: null,
    setEditingMessageId: noop,
    editingText: '',
    setEditingText: noop,
    showTypingIndicator: false,
    messagesEndRef: { current: null },
    orchestratorIntent: null,
    orchestratorTier: null,
    trustSteps: [],
    planSteps: [],
    reasoningText: '',
    drawerRef: { current: null },
    drawerWidth: 420,
    startResize: noop,
    authHeaders: async () => ({ 'Content-Type': 'application/json' }),
    handleClose: noop,
    handleNewSession: async () => undefined,
    saveConversationMeta: asyncNoop,
    archiveConversation: asyncNoop,
    submitMemoryEdit: asyncNoop,
    saveMemoryEdit: asyncNoop,
    forgetMemory: noop,
    undoForgetMemory: noop,
    handleApprovePending: asyncNoop,
    handleApproveAll: asyncNoop,
    handleDismissPending: noop,
    handleClearAllAlerts: asyncNoop,
    handleDismissAlert: asyncNoop,
    sendMessage: asyncNoop,
    submitFeedback: asyncNoop,
    handleRegenerate: noop,
    handleEditResend: noop,
    fetchResearchExport: asyncNoop,
    submitResearchAnswers: asyncNoop,
    handleStop: noop,
    handleAttachFiles: noop,
    removeStagedAttachment: noop,
    setWriteMode: noop,
    setResearchMode: noop,
    setResearchAwaitingAnswers: noop,
    setResearchQuestions: noop,
    researchSessionRef: { current: null },
  } as unknown as MeriChatController;
}
