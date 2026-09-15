/**
 * Controller stub for the Meri vNext visual harness. Built on the repo's
 * existing createMeriVisualController() scaffold (MeriOverlay.visual-fixture.ts)
 * with every newer controller field the vNext surfaces read filled in, and the
 * reference scenario's transcript/approvals/clients overriding the scaffold's
 * generic ones. Fixture-only: nothing in the production bundle imports this.
 */
import type { MeriChatController } from '../../../components/chat/useMeriChatController.js';
import { createMeriVisualController } from '../../../components/chat/MeriOverlay.visual-fixture.js';
import {
  FIXTURE_CLIENTS,
  FIXTURE_MESSAGES,
  FIXTURE_PENDING_APPROVAL,
  FIXTURE_ACTIVE_CONVERSATION_ID,
} from './meri-visual-fixture.js';

const noop = () => undefined;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const asyncNoop = async (..._args: unknown[]) => undefined;

export function createMeriShellVisualController(): MeriChatController {
  const base = createMeriVisualController() as unknown as Record<string, unknown>;
  return {
    ...base,
    messages: FIXTURE_MESSAGES,
    sessionId: FIXTURE_ACTIVE_CONVERSATION_ID,
    sessionTitle: 'FY27 Ground Robotics mark analysis',
    clients: FIXTURE_CLIENTS,
    selectedClientValue: 'client-overland',
    persistedClientId: 'client-overland',
    activeConversationId: FIXTURE_ACTIVE_CONVERSATION_ID,
    scopePersistStatus: 'idle',
    pendingApprovals: [FIXTURE_PENDING_APPROVAL],
    contextLabel: 'Overland AI · scoped conversation',
    isResearchStreaming: false,
    researchProgress: null,
    turnProgress: null,
    researchRecovery: null,
    researchRecoveryError: null,
    lastRetrieval: null,
    lastUserMessageId: 'msg-user-2',
    researchOffers: {},
    researchReports: {},
    suggestMemoryCorrection: asyncNoop,
    resumeResearch: noop,
    handleRunResearchOffer: noop,
    invalidateRouteStream: noop,
    discardRouteState: noop,
    saveConversationMeta: async () => true,
  } as unknown as MeriChatController;
}
