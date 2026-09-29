import type { TrustedCurrentTurnScope } from '../request/trusted-current-turn-scope.js';
import { isCurrentConversationResearchPortfolioTool } from './current-turn-tool-scope.js';

export interface ResearchPortfolioProposalRequest {
  tool: string;
  input: Record<string, unknown>;
  conversationId?: string;
  surface: 'chat';
}

export interface ResearchPortfolioProposalTransportEnvelope {
  version: 1;
  proposal: ResearchPortfolioProposalRequest & { conversationId: string };
  currentTurn: {
    tenantId: string;
    userId: string;
    conversationId: string;
    selectedClientId: string | null;
  };
}

/**
 * Builds the narrow server envelope used only by RP action proposals. The
 * model may repeat the active conversation for compatibility, but never
 * chooses either the outer proposal target or the canonical inner target.
 */
export function buildResearchPortfolioProposalTransport(
  request: ResearchPortfolioProposalRequest,
  scope: TrustedCurrentTurnScope | undefined,
): ResearchPortfolioProposalRequest | ResearchPortfolioProposalTransportEnvelope {
  if (!isCurrentConversationResearchPortfolioTool(request.tool.trim())) return request;
  if (!scope?.conversationId) {
    throw new Error(
      `Trusted current conversation is unavailable for Research Portfolio proposal "${request.tool}"`,
    );
  }
  if (request.conversationId !== undefined && request.conversationId !== scope.conversationId) {
    throw new Error('Research Portfolio proposals cannot target another conversation');
  }
  const suppliedInner = request.input.conversationId;
  if (suppliedInner !== undefined && suppliedInner !== scope.conversationId) {
    throw new Error('Research Portfolio proposal input cannot target another conversation');
  }
  return {
    version: 1,
    proposal: {
      ...request,
      input: { ...request.input, conversationId: scope.conversationId },
      conversationId: scope.conversationId,
    },
    currentTurn: {
      tenantId: scope.tenantId,
      userId: scope.userId,
      conversationId: scope.conversationId,
      selectedClientId: scope.selectedClientId,
    },
  };
}
