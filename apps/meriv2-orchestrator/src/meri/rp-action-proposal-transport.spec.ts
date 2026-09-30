import { buildResearchPortfolioProposalTransport } from './rp-action-proposal-transport.js';

const currentTurn = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  conversationId: '33333333-3333-4333-8333-333333333333',
  selectedClientId: null,
};
const otherConversation = '44444444-4444-4444-8444-444444444444';

describe('Research Portfolio action-proposal transport', () => {
  it('derives omitted outer and inner conversations from the trusted current turn', () => {
    expect(
      buildResearchPortfolioProposalTransport(
        {
          tool: 'create_research_portfolio_snapshot',
          input: { operationKey: 'snapshot:1' },
          surface: 'chat',
        },
        currentTurn,
      ),
    ).toEqual({
      version: 1,
      proposal: {
        tool: 'create_research_portfolio_snapshot',
        input: {
          operationKey: 'snapshot:1',
          conversationId: currentTurn.conversationId,
        },
        conversationId: currentTurn.conversationId,
        surface: 'chat',
      },
      currentTurn,
    });
  });

  it.each([
    [{ conversationId: otherConversation }, {}],
    [{}, { conversationId: otherConversation }],
  ])('rejects outer or inner retargeting', (outer, inner) => {
    expect(() =>
      buildResearchPortfolioProposalTransport(
        {
          tool: 'create_research_portfolio_snapshot',
          input: inner,
          surface: 'chat',
          ...outer,
        },
        currentTurn,
      ),
    ).toThrow('cannot target another conversation');
  });

  it('fails closed without trusted scope and guards the future manage name', () => {
    expect(() =>
      buildResearchPortfolioProposalTransport(
        {
          tool: 'manage_research_portfolio',
          input: {},
          surface: 'chat',
        },
        undefined,
      ),
    ).toThrow('Trusted current conversation is unavailable');
  });

  it('leaves non-RP proposal requests unchanged', () => {
    const request = {
      tool: 'send_email',
      input: { conversationId: otherConversation },
      conversationId: otherConversation,
      surface: 'chat' as const,
    };
    expect(buildResearchPortfolioProposalTransport(request, currentTurn)).toBe(request);
  });
});
