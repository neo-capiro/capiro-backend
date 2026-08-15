import type { MeriContext } from '@capiro/meriv2-core';
import type { MeriRetrievalPlan } from '../retrieval/meri-retrieval-plan.js';
import {
  executeMeriRetrievalRecipe,
  type MeriUnderlyingToolInvoker,
} from './meriv3-retrieval-recipes.js';

function plan(overrides: Partial<MeriRetrievalPlan> = {}): MeriRetrievalPlan {
  return {
    version: 1,
    queryClass: 'relationship_history',
    subjectScope: 'external_entity',
    targetHint: 'Victory Six',
    recipeTool: 'query_relationship_brief',
    requireCompleteCoverage: true,
    requiredDomains: ['identity', 'internal_research', 'mail', 'contacts', 'memory'],
    optionalDomains: [],
    recommendedTools: [],
    timeWindow: null,
    activeClients: [],
    reasons: [],
    ...overrides,
  };
}

const meriContext = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as MeriContext;

function identityAndResearchMock(extra?: MeriUnderlyingToolInvoker) {
  return jest.fn(async (name: string, input: Record<string, unknown>) => {
    if (extra) {
      const delegated = await extra(name, input);
      if (delegated !== undefined) return delegated;
    }
    switch (name) {
      case 'resolve_entity':
        return { results: [] };
      case 'lookup_client_registry':
        return { results: [] };
      case 'search_research_sources':
        return {
          results: [
            {
              id: 'internal-1',
              title: 'Pilot relationship note',
              description: 'Pilot relationship and connector request.',
            },
          ],
        };
      case 'search_lda_filings':
        return {
          results: [
            {
              id: 'lda-1',
              registrantName: 'Victory Six Advisors',
              clientName: 'Victory Six Advisors',
              website: 'https://v6advisors.com',
            },
          ],
        };
      case 'search_sec_filings':
      case 'search_federal_awards':
        return { results: [] };
      case 'search_public_web':
        return {
          results: [
            {
              id: 'web-1',
              title: 'Victory Six Advisors',
              url: 'https://v6advisors.com',
              snippet: 'Official Victory Six Advisors website.',
            },
          ],
        };
      case 'search_memory':
        return {
          results: [
            {
              id: 'memory-1',
              title: 'Relationship memory',
              text: 'Sean is the pilot champion.',
            },
          ],
        };
      default:
        return { results: [] };
    }
  });
}

describe('MeriV3 retrieval recipes', () => {
  test('builds an entity-aware relationship brief across aliases, domain, mail and contacts', async () => {
    const invoke = identityAndResearchMock(async (name, input) => {
      if (name === 'search_emails') {
        return {
          totalMatches: 1,
          returned: 1,
          hasMore: false,
          messages: [
            {
              id: 'mail-1',
              subject: 'V6 | Capiro orientation',
              bodyText: 'Sean asked to finish connector setup.',
              sentAt: '2026-08-10T15:00:00.000Z',
              fromEmail: 'sean@v6advisors.com',
            },
          ],
          searchedMailboxes: [
            {
              provider: 'microsoft_365',
              status: 'connected',
              syncedMessages: 400,
              lastSyncAt: '2026-08-14T10:00:00.000Z',
            },
          ],
        };
      }
      if (name === 'find_contacts') {
        return {
          results: [
            {
              id: 'contact-1',
              name: 'Sean Montplaisir',
              description: 'Victory Six contact',
            },
          ],
        };
      }
      return undefined;
    });

    const raw = await executeMeriRetrievalRecipe(
      'query_relationship_brief',
      { entity: 'Victory Six', withinDays: 30 },
      { plan: plan(), meriContext, invoke },
    );
    const result = raw as {
      resolvedEntity: { canonicalName: string; domains: string[] } | null;
      results: Array<{ sourceTool: string; title: string }>;
      coverage: { requestedEntityCount: number; searchedEntityCount: number };
    };

    expect(result.resolvedEntity?.canonicalName).toBe('Victory Six Advisors');
    expect(result.resolvedEntity?.domains).toContain('v6advisors.com');
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceTool: 'search_emails', title: 'V6 | Capiro orientation' }),
        expect.objectContaining({ sourceTool: 'find_contacts', title: 'Sean Montplaisir' }),
      ]),
    );
    expect(result.coverage).toEqual(
      expect.objectContaining({ requestedEntityCount: 1, searchedEntityCount: 1 }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'search_emails',
      expect.objectContaining({ participant: 'v6advisors.com', withinDays: 30, limit: 50 }),
    );
  });

  test('fans a portfolio change scan out to every active client', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const invoke = jest.fn(async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input });
      switch (name) {
        case 'query_tasks':
          return {
            tasks: [
              {
                id: 'task-new',
                title: 'Prepare client briefing',
                status: 'todo',
                updatedAt: '2026-08-12T12:00:00.000Z',
                clientId: 'client-a',
                clientName: 'Client A',
              },
              {
                id: 'task-old',
                title: 'Carryover follow-up',
                status: 'blocked',
                updatedAt: '2026-07-20T12:00:00.000Z',
                clientId: 'client-b',
                clientName: 'Client B',
              },
            ],
          };
        case 'query_action_items':
        case 'query_outreach':
        case 'list_emails':
          return { results: [] };
        case 'query_debriefs':
          return {
            debriefs: [
              {
                id: `debrief-${String(input.clientId)}`,
                title: `Debrief for ${String(input.clientId)}`,
                occurredAt: '2026-08-13T12:00:00.000Z',
                clientName: String(input.clientId),
              },
            ],
          };
        case 'search_tracked_bills':
          return { bills: [] };
        default:
          return { results: [] };
      }
    });
    const portfolioPlan = plan({
      queryClass: 'change_detection',
      subjectScope: 'portfolio',
      targetHint: null,
      recipeTool: 'query_portfolio_changes',
      requiredDomains: [
        'clients',
        'mail',
        'meetings',
        'tasks',
        'action_items',
        'outreach',
        'legislation',
      ],
      activeClients: [
        { id: 'Client A', name: 'Client A', status: 'active' },
        { id: 'Client B', name: 'Client B', status: 'active' },
      ],
      timeWindow: { expression: 'this week', withinDays: 7 },
    });

    const raw = await executeMeriRetrievalRecipe(
      'query_portfolio_changes',
      { from: '2026-08-10T00:00:00.000Z', to: '2026-08-14T23:59:59.000Z' },
      { plan: portfolioPlan, meriContext, invoke },
    );
    const result = raw as {
      results: Array<{ id: string }>;
      carryoverAttention: Array<{ id: string }>;
      coverage: {
        requestedEntityCount: number;
        searchedEntityCount: number;
      };
    };

    expect(result.coverage).toEqual(
      expect.objectContaining({ requestedEntityCount: 2, searchedEntityCount: 2 }),
    );
    expect(result.results.map((item) => item.id)).toEqual(
      expect.arrayContaining(['task-new', 'debrief-Client A', 'debrief-Client B']),
    );
    expect(result.carryoverAttention.map((item) => item.id)).toContain('task-old');
    expect(
      calls
        .filter((call) => call.name === 'query_debriefs')
        .map((call) => call.input.clientId),
    ).toEqual(expect.arrayContaining(['Client A', 'Client B']));
    expect(
      calls
        .filter((call) => call.name === 'search_tracked_bills')
        .map((call) => call.input.clientId),
    ).toEqual(expect.arrayContaining(['Client A', 'Client B']));
  });

  test('ranks portfolio overlap from external evidence and every client profile', async () => {
    const invoke = jest.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'search_public_web') {
        return {
          results: [
            {
              id: 'web-company',
              title: 'Kinetic Industries Inc.',
              url: 'https://kineticindustries.com',
              snippet: 'Supply chain logistics, readiness, inventory and Navy distribution consulting.',
            },
          ],
        };
      }
      if (name === 'get_client_context') {
        const clientId = String(input.clientId);
        if (clientId === 'Logistics Client') {
          return {
            context: {
              client: {
                name: 'Logistics Client',
                description: 'Navy supply chain and readiness modernization.',
              },
            },
            profile: {
              capabilities: [
                { name: 'Supply Chain Logistics' },
                { name: 'Inventory Readiness' },
              ],
            },
          };
        }
        return {
          context: {
            client: {
              name: 'Health Client',
              description: 'Clinical software and hospital analytics.',
            },
          },
          profile: { capabilities: [{ name: 'Healthcare Analytics' }] },
        };
      }
      if (name === 'resolve_entity') return { results: [] };
      if (name === 'lookup_client_registry') return { results: [] };
      if (name === 'search_research_sources') return { results: [] };
      if (name === 'search_memory') return { results: [] };
      if (
        ['search_lda_filings', 'search_sec_filings', 'search_federal_awards', 'search_sam_opportunities', 'search_federal_grants'].includes(name)
      ) {
        return { results: [] };
      }
      return { results: [] };
    });
    const overlapPlan = plan({
      queryClass: 'portfolio_scan',
      subjectScope: 'portfolio',
      targetHint: 'Kinetic Industries Inc.',
      recipeTool: 'query_portfolio_overlap',
      requiredDomains: ['identity', 'clients', 'internal_research'],
      activeClients: [
        { id: 'Logistics Client', name: 'Logistics Client', status: 'active' },
        { id: 'Health Client', name: 'Health Client', status: 'active' },
      ],
    });

    const raw = await executeMeriRetrievalRecipe(
      'query_portfolio_overlap',
      { entity: 'Kinetic Industries Inc.' },
      { plan: overlapPlan, meriContext, invoke },
    );
    const result = raw as {
      results: Array<{
        title: string;
        metadata?: { overlapScore?: number; matchedTerms?: string[] };
      }>;
      coverage: { requestedEntityCount: number; searchedEntityCount: number };
    };

    expect(result.coverage).toEqual(
      expect.objectContaining({ requestedEntityCount: 2, searchedEntityCount: 2 }),
    );
    expect(result.results[0]?.title).toBe('Logistics Client');
    expect(result.results[0]?.metadata?.overlapScore).toBeGreaterThan(
      result.results[1]?.metadata?.overlapScore ?? 0,
    );
    expect(result.results[0]?.metadata?.matchedTerms).toEqual(
      expect.arrayContaining(['supply', 'chain', 'logistics', 'readiness']),
    );
    expect(invoke).toHaveBeenCalledWith('get_client_context', {
      clientId: 'Logistics Client',
    });
    expect(invoke).toHaveBeenCalledWith('get_client_context', {
      clientId: 'Health Client',
    });
  });
});
