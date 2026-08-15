import type { MeriContext } from '@capiro/meriv2-core';
import type { MeriRetrievalPlan } from '../retrieval/meri-retrieval-plan.js';
import { executeMeriRetrievalRecipe } from './meriv3-retrieval-recipes.js';

const CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as MeriContext;

const plan: MeriRetrievalPlan = {
  version: 1,
  queryClass: 'change_detection',
  subjectScope: 'client',
  targetHint: null,
  recipeTool: 'query_client_changes',
  requireCompleteCoverage: true,
  requiredDomains: ['clients', 'mail', 'meetings', 'tasks', 'action_items', 'outreach', 'legislation'],
  optionalDomains: ['opportunities'],
  recommendedTools: ['query_client_changes'],
  timeWindow: { expression: 'this week', withinDays: 7 },
  activeClients: [],
  reasons: [],
};

describe('query_client_changes', () => {
  test('scans only the supplied focused client and treats older open work as carryover', async () => {
    const now = Date.now();
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const invoke = jest.fn(async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      switch (name) {
        case 'get_client_context':
          return { context: { client: { id: CLIENT_ID, name: 'Client A' } } };
        case 'query_tasks':
          return {
            tasks: [
              { id: 'recent-task', title: 'Recent task', status: 'todo', createdAt: recent },
              { id: 'old-task', title: 'Old task', status: 'blocked', createdAt: old },
            ],
          };
        case 'query_action_items':
          return { actions: [] };
        case 'query_outreach':
          return { campaigns: [] };
        case 'list_emails':
          return { threads: [] };
        case 'query_debriefs':
          return { debriefs: [] };
        case 'search_tracked_bills':
          return { bills: [] };
        case 'get_opportunity_client_context':
          return { counts: { contracts: 2 }, topContracts: [] };
        default:
          return { results: [] };
      }
    });

    const result = (await executeMeriRetrievalRecipe(
      'query_client_changes',
      { clientId: CLIENT_ID, withinDays: 7 },
      { plan, meriContext: ctx, invoke },
    )) as {
      client: { id: string; name: string };
      results: Array<{ id: string }>;
      carryoverAttention: Array<{ id: string }>;
      currentOpportunityPosture: unknown[];
      coverage: { requestedEntityCount: number; searchedEntityCount: number };
    };

    expect(result.client).toEqual({ id: CLIENT_ID, name: 'Client A' });
    expect(result.results.map((row) => row.id)).toContain('recent-task');
    expect(result.carryoverAttention.map((row) => row.id)).toContain('old-task');
    expect(result.currentOpportunityPosture).toHaveLength(1);
    expect(result.coverage).toEqual(
      expect.objectContaining({ requestedEntityCount: 1, searchedEntityCount: 1 }),
    );
    for (const call of calls.filter((call) => 'clientId' in call.input)) {
      expect(call.input.clientId).toBe(CLIENT_ID);
    }
  });

  test('fails closed when no server-pinned client id reaches the recipe', async () => {
    const result = (await executeMeriRetrievalRecipe(
      'query_client_changes',
      { withinDays: 7 },
      { plan, meriContext: ctx, invoke: jest.fn() },
    )) as { error: string };

    expect(result.error).toMatch(/server-pinned focused client id/i);
  });
});
