import { MERI_TOOL_NAMES } from '@capiro/shared';
import type { TrustedCurrentTurnScope } from '../request/trusted-current-turn-scope';
import {
  CURRENT_CONVERSATION_RESEARCH_PORTFOLIO_TOOLS,
  isCurrentConversationResearchPortfolioTool,
} from './current-turn-tool-scope';
import { buildResearchPortfolioToolTransport } from './rp-tool-transport';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const OTHER_CONVERSATION = '44444444-4444-4444-8444-444444444444';
const CLIENT = '55555555-5555-4555-8555-555555555555';

const scope: TrustedCurrentTurnScope = {
  tenantId: TENANT,
  userId: USER,
  conversationId: CONVERSATION,
  selectedClientId: CLIENT,
};

describe('Research Portfolio tool transport envelope', () => {
  it('tracks exactly the 19 current canonical names including management', () => {
    const canonical = MERI_TOOL_NAMES.filter((name) => name.includes('research_portfolio')).sort();
    expect([...CURRENT_CONVERSATION_RESEARCH_PORTFOLIO_TOOLS].sort()).toEqual(canonical);
    expect(canonical).toHaveLength(19);
    expect(isCurrentConversationResearchPortfolioTool('manage_research_portfolio')).toBe(true);
    expect(canonical).toContain('manage_research_portfolio');
  });

  it.each(CURRENT_CONVERSATION_RESEARCH_PORTFOLIO_TOOLS)(
    '%s derives omitted model conversation and emits only the finite current-turn envelope',
    (name) => {
      expect(buildResearchPortfolioToolTransport(name, { limit: 2 }, scope)).toEqual({
        version: 1,
        input: { limit: 2, conversationId: CONVERSATION },
        currentTurn: scope,
      });
      expect(
        buildResearchPortfolioToolTransport(
          name,
          { conversationId: CONVERSATION, limit: 2 },
          scope,
        ),
      ).toEqual({
        version: 1,
        input: { conversationId: CONVERSATION, limit: 2 },
        currentTurn: scope,
      });
    },
  );

  it('fails missing scope, missing conversation, cross-model target, and malformed trusted context', () => {
    expect(() =>
      buildResearchPortfolioToolTransport('get_research_portfolio', {}, undefined),
    ).toThrow('Trusted current-turn scope is unavailable');
    expect(() =>
      buildResearchPortfolioToolTransport(
        'get_research_portfolio',
        {},
        {
          ...scope,
          conversationId: null,
        },
      ),
    ).toThrow('Trusted current conversation is unavailable');
    expect(() =>
      buildResearchPortfolioToolTransport(
        'get_research_portfolio',
        { conversationId: OTHER_CONVERSATION },
        scope,
      ),
    ).toThrow('cannot target another conversation');
    expect(() =>
      buildResearchPortfolioToolTransport(
        'get_research_portfolio',
        {},
        {
          ...scope,
          tenantId: 'not-a-uuid',
        },
      ),
    ).toThrow('Trusted current-turn scope is invalid');
    expect(() =>
      buildResearchPortfolioToolTransport(
        'manage_research_portfolio',
        {},
        {
          ...scope,
          selectedClientId: 'not-a-uuid',
        },
      ),
    ).toThrow('Trusted current-turn scope is invalid');
  });

  it('leaves ordinary delegated tools byte-for-byte compatible', () => {
    const input = { conversationId: OTHER_CONVERSATION, query: 'NDAA' };
    expect(buildResearchPortfolioToolTransport('search_congress_bills', input, undefined)).toBe(
      input,
    );
  });
});
