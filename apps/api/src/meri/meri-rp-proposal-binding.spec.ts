import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  authorizeResearchPortfolioProposalConversation,
  bindResearchPortfolioProposalInput,
  bindStoredResearchPortfolioProposalInput,
  isResearchPortfolioProposalTool,
} from './meri-rp-proposal-binding.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const OTHER_CONVERSATION = '44444444-4444-4444-8444-444444444444';
const CLIENT = '55555555-5555-4555-8555-555555555555';
const OTHER_CLIENT = '66666666-6666-4666-8666-666666666666';
const ctx = { tenantId: TENANT, userId: USER } as TenantContext;
const metadata = {
  researchPortfolioScope: {
    kind: 'research_portfolio',
    researchPortfolioId: '77777777-7777-4777-8777-777777777777',
    researchPortfolioName: 'Autonomous Systems',
    researchPortfolioRevision: 3,
    scopeVersion: 'a'.repeat(64),
  },
};

const RP_TOOLS = [
  'manage_research_portfolio',
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
] as const;

describe('Research Portfolio proposal binding', () => {
  it('recognizes exactly the Defense-owned RP proposal tool names', () => {
    for (const tool of RP_TOOLS) expect(isResearchPortfolioProposalTool(tool)).toBe(true);
    expect(isResearchPortfolioProposalTool('create_research_portfolio_bookmark_extra')).toBe(false);
    expect(isResearchPortfolioProposalTool('save_note')).toBe(false);
  });

  it('inherits an absent inner conversation and accepts an exact supplied conversation', () => {
    expect(
      bindResearchPortfolioProposalInput(
        'create_research_portfolio_snapshot',
        { operationKey: 'snapshot:1' },
        CONVERSATION,
      ),
    ).toEqual({ operationKey: 'snapshot:1', conversationId: CONVERSATION });
    expect(
      bindResearchPortfolioProposalInput(
        'create_research_portfolio_snapshot',
        { conversationId: CONVERSATION, operationKey: 'snapshot:1' },
        CONVERSATION,
      ),
    ).toEqual({ conversationId: CONVERSATION, operationKey: 'snapshot:1' });
  });

  it('fails closed for a missing outer conversation or a different supplied inner conversation', () => {
    expect(() =>
      bindResearchPortfolioProposalInput('create_research_portfolio_snapshot', {}, undefined),
    ).toThrow(BadRequestException);
    expect(() =>
      bindResearchPortfolioProposalInput(
        'create_research_portfolio_snapshot',
        { conversationId: OTHER_CONVERSATION },
        CONVERSATION,
      ),
    ).toThrow(BadRequestException);
  });

  it('requires an exact already-persisted inner/outer binding for legacy rows', () => {
    expect(
      bindStoredResearchPortfolioProposalInput(
        'create_research_portfolio_snapshot',
        { conversationId: CONVERSATION },
        CONVERSATION,
      ),
    ).toEqual({ conversationId: CONVERSATION });
    expect(() =>
      bindStoredResearchPortfolioProposalInput(
        'create_research_portfolio_snapshot',
        {},
        CONVERSATION,
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      bindStoredResearchPortfolioProposalInput(
        'create_research_portfolio_snapshot',
        { conversationId: OTHER_CONVERSATION },
        CONVERSATION,
      ),
    ).toThrow(BadRequestException);
  });

  it('does not alter ordinary non-RP tool input', () => {
    const input = { conversationId: OTHER_CONVERSATION, body: 'Notes' };
    expect(bindResearchPortfolioProposalInput('save_note', input, CONVERSATION)).toBe(input);
  });

  it('uses the existing owned, unarchived conversation and current RP membership authority', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      metadata,
      clientId: CLIENT,
    });
    const authorize = jest.fn().mockResolvedValue({ researchPortfolioId: 'portfolio-1' });
    const prisma = {
      withTenant: jest.fn((_tenantId: string, callback: (tx: unknown) => unknown) =>
        callback({ clioConversation: { findFirst } }),
      ),
    };

    await authorizeResearchPortfolioProposalConversation(
      prisma as never,
      { authorize } as never,
      ctx,
      CONVERSATION,
      CLIENT,
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: CONVERSATION,
        tenantId: TENANT,
        userId: USER,
        archivedAt: null,
      },
      select: { metadata: true, clientId: true },
    });
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing current conversation and a changed policy-bound client', async () => {
    const scope = { authorize: jest.fn().mockResolvedValue({ researchPortfolioId: 'portfolio-1' }) };
    const prisma = (conversation: unknown) => ({
      withTenant: jest.fn((_tenantId: string, callback: (tx: unknown) => unknown) =>
        callback({ clioConversation: { findFirst: jest.fn().mockResolvedValue(conversation) } }),
      ),
    });

    await expect(
      authorizeResearchPortfolioProposalConversation(
        prisma(null) as never,
        scope as never,
        ctx,
        CONVERSATION,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      authorizeResearchPortfolioProposalConversation(
        prisma({ metadata, clientId: OTHER_CLIENT }) as never,
        scope as never,
        ctx,
        CONVERSATION,
        CLIENT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
