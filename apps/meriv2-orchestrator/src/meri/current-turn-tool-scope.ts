import type { TrustedCurrentTurnScope } from '../request/trusted-current-turn-scope.js';

/** Exact Research Portfolio tool set present in this checkout's canonical registry. */
export const CURRENT_CONVERSATION_RESEARCH_PORTFOLIO_TOOLS = Object.freeze([
  'get_research_portfolio',
  'get_research_portfolio_analytics',
  'get_research_portfolio_changes',
  'create_research_portfolio_snapshot',
  'request_research_portfolio_output',
  'save_research_portfolio_output_to_client',
  'watch_research_portfolio',
  'update_research_portfolio_change_state',
  'get_research_portfolio_bookmarks',
  'create_research_portfolio_bookmark',
  'get_research_portfolio_fit',
  'get_research_portfolio_reviews',
  'add_research_portfolio_review_note',
  'get_research_portfolio_rules',
  'get_research_portfolio_imports',
  'get_research_portfolio_operations',
  'prepare_research_portfolio_brief',
  'prepare_research_portfolio_meeting',
] as const);

const researchPortfolioTools = new Set<string>(CURRENT_CONVERSATION_RESEARCH_PORTFOLIO_TOOLS);

export function isCurrentConversationResearchPortfolioTool(toolName: string): boolean {
  return researchPortfolioTools.has(toolName);
}

/**
 * Pins only the canonical RP surface to the authenticated V3 turn. Other
 * business tools are intentionally unchanged. The scope is not authorization;
 * the API owner still performs its ordinary ownership and resource checks.
 */
export function bindCurrentConversationToolInput(
  toolName: string,
  input: Record<string, unknown>,
  scope: TrustedCurrentTurnScope | undefined,
): Record<string, unknown> {
  if (!scope || !isCurrentConversationResearchPortfolioTool(toolName)) return input;
  if (!scope.conversationId) {
    throw new Error(`Trusted current conversation is unavailable for delegated tool "${toolName}"`);
  }
  const supplied = input.conversationId;
  if (supplied !== undefined && supplied !== scope.conversationId) {
    throw new Error(`Delegated tool "${toolName}" cannot target another conversation`);
  }
  return { ...input, conversationId: scope.conversationId };
}
