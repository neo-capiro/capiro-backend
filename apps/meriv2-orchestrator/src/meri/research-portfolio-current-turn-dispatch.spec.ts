import type { MeriContext } from '@capiro/meriv2-core';
import { ApiToolExecutorRepo } from './api-tool-executor.repo';
import { CURRENT_CONVERSATION_RESEARCH_PORTFOLIO_TOOLS } from './current-turn-tool-scope';
import { RequestCredentialsStore } from '../request/request-credentials.store';
import { withTrustedCurrentTurnScope } from '../request/trusted-current-turn-scope';

// These are the nineteen identities formerly exercised by the raw API loop's
// ResearchPortfolioMeriTurnBinding.spec.ts. Exercise the current executor, its
// real request stores, binder and typed envelope; no legacy loop fragment.
// The trusted scope is a fixture established by the controller in production.
// These dispatch tests do not authenticate a caller or grant Core resource access.
const names = [
  'get_research_portfolio', 'get_research_portfolio_analytics',
  'get_research_portfolio_changes', 'create_research_portfolio_snapshot',
  'request_research_portfolio_output', 'save_research_portfolio_output_to_client',
  'watch_research_portfolio', 'update_research_portfolio_change_state',
  'get_research_portfolio_bookmarks', 'create_research_portfolio_bookmark',
  'get_research_portfolio_fit', 'get_research_portfolio_reviews',
  'add_research_portfolio_review_note', 'get_research_portfolio_rules',
  'get_research_portfolio_imports', 'get_research_portfolio_operations',
  'prepare_research_portfolio_brief', 'prepare_research_portfolio_meeting',
  'manage_research_portfolio',
];
const currentTurn = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  conversationId: '33333333-3333-4333-8333-333333333333',
  selectedClientId: '55555555-5555-4555-8555-555555555555',
};
const otherConversationId = '44444444-4444-4444-8444-444444444444';
const emptyMemoryResult = {
  tool: 'search_memory', factContentUnavailableCount: 0, contentStatus: 'empty',
  contentTruncated: false, nextCursor: null, results: [], records: [],
  coverage: { complete: true, paginationComplete: true, sources: [{
    domain: 'institutional_knowledge', sourceStatus: 'healthy', hasMore: false,
    truncated: false, paginationComplete: true, coverageComplete: true,
  }] },
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
beforeAll(() => {
  expect([...names].sort()).toEqual([...CURRENT_CONVERSATION_RESEARCH_PORTFOLIO_TOOLS].sort());
});

function harness() {
  const requests: RequestInit[] = [];
  const fetchSpy = jest.fn(async (url: unknown, init?: RequestInit) => {
    requests.push(init ?? {});
    return new Response(JSON.stringify(String(url).endsWith('/search_memory')
      ? emptyMemoryResult : { portfolio: 'Current turn portfolio' }));
  });
  globalThis.fetch = fetchSpy as typeof fetch;
  const repo = new ApiToolExecutorRepo({
    get: (key: string) => key === 'INTERNAL_SERVICE_SECRET' ? 'fixture-service-identity' : undefined,
  } as never);
  return {
    fetchSpy, requests,
    run: (name: string, input: Record<string, unknown>) =>
      RequestCredentialsStore.run({ bearerToken: 'fixture-verified-user' }, () =>
        withTrustedCurrentTurnScope(currentTurn, () => repo.execute({} as MeriContext, name, input))),
  };
}

describe('Current-turn Research Portfolio delegated dispatch', () => {
  it.each(names)('refuses model retargeting for %s before actual delegated dispatch', async name => {
    const h = harness();
    await expect(h.run(name, { conversationId: otherConversationId })).rejects.toThrow('cannot target another conversation');
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it('injects omitted current conversation and retains exact current conversation', async () => {
    for (const input of [{}, { conversationId: currentTurn.conversationId }]) {
      const h = harness();
      await expect(h.run('get_research_portfolio', input)).resolves.toEqual({ portfolio: 'Current turn portfolio' });
      expect(h.fetchSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(h.requests[0].body as string)).toEqual({
        version: 1, input: { conversationId: currentTurn.conversationId }, currentTurn,
      });
      expect(h.requests[0].headers).toMatchObject({
        authorization: 'Bearer fixture-verified-user',
        'x-internal-service-secret': 'fixture-service-identity',
      });
    }
  });

  it('ordinary delegated tools preserve their existing supplied conversation treatment', async () => {
    const h = harness();
    const input = { conversationId: otherConversationId, query: 'funding' };
    await h.run('search_memory', input);
    expect(h.fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.requests[0].body as string)).toEqual(input);
  });

  it('rejects null/empty/non-string scope attempts without rewriting them as a successful current request', async () => {
    for (const conversationId of [null, '', 23]) {
      const h = harness();
      await expect(h.run('get_research_portfolio', { conversationId })).rejects.toThrow('cannot target another conversation');
      expect(h.fetchSpy).not.toHaveBeenCalled();
    }
  });
});
