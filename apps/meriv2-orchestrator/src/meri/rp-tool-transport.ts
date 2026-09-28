import type { TrustedCurrentTurnScope } from '../request/trusted-current-turn-scope.js';
import {
  bindCurrentConversationToolInput,
  isCurrentConversationResearchPortfolioTool,
} from './current-turn-tool-scope.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ResearchPortfolioToolTransportEnvelope {
  version: 1;
  input: Record<string, unknown>;
  currentTurn: {
    tenantId: string;
    userId: string;
    conversationId: string;
    selectedClientId: string | null;
  };
}

/** Builds the private finite envelope used only by canonical RP tool execution. */
export function buildResearchPortfolioToolTransport(
  toolName: string,
  input: Record<string, unknown>,
  scope: TrustedCurrentTurnScope | undefined,
): Record<string, unknown> | ResearchPortfolioToolTransportEnvelope {
  if (!isCurrentConversationResearchPortfolioTool(toolName)) return input;
  const boundedInput = bindCurrentConversationToolInput(toolName, input, scope);
  if (
    !scope ||
    !UUID.test(scope.tenantId) ||
    !UUID.test(scope.userId) ||
    typeof scope.conversationId !== 'string' ||
    !UUID.test(scope.conversationId) ||
    (scope.selectedClientId !== null && !UUID.test(scope.selectedClientId))
  ) {
    throw new Error(`Trusted current-turn scope is invalid for delegated tool "${toolName}"`);
  }
  return {
    version: 1,
    input: boundedInput,
    currentTurn: {
      tenantId: scope.tenantId,
      userId: scope.userId,
      conversationId: scope.conversationId,
      selectedClientId: scope.selectedClientId,
    },
  };
}
