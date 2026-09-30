import { isResearchPortfolioMeriTool } from '../research-portfolios/research-portfolio-meri-tools.service.js';

/** Bind portfolio tools to the server's current turn; ordinary tools keep their existing treatment. */
export function bindResearchPortfolioToolConversation(
  name: string,
  input: Record<string, unknown>,
  currentConversationId: string,
): { input: Record<string, unknown>; refusal?: string } {
  if (!isResearchPortfolioMeriTool(name)) return { input };
  if (input.conversationId !== undefined && input.conversationId !== currentConversationId) {
    return {
      input,
      refusal:
        'This Research Portfolio tool belongs to the current chat. A different conversationId cannot change this turn’s portfolio scope.',
    };
  }
  return { input: { ...input, conversationId: currentConversationId } };
}
