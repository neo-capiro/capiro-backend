import { MeriRetrievalCoordinator } from './meri-retrieval-coordinator.js';
import type { MeriRetrievalPlan } from './meri-retrieval-plan.js';

function plan(): MeriRetrievalPlan {
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
  };
}

describe('MeriRetrievalCoordinator', () => {
  test('does not let a successful composite recipe hide a partial underlying search', async () => {
    const coordinator = new MeriRetrievalCoordinator();

    const manifest = await coordinator.run(plan(), async () => {
      coordinator.observe('search_research_sources', {}, { results: [] });
      coordinator.observe('query_relationship_brief', {}, {
        coverage: {
          complete: true,
          requestedEntityCount: 1,
          searchedEntityCount: 1,
        },
        results: [],
      });
      return coordinator.coverage();
    });

    expect(manifest.complete).toBe(false);
    expect(manifest.partialDomains).toContain('internal_research');
  });

  test('treats bounded task results without a cursor/total contract as partial', async () => {
    const coordinator = new MeriRetrievalCoordinator();
    const taskPlan: MeriRetrievalPlan = {
      ...plan(),
      queryClass: 'change_detection',
      subjectScope: 'portfolio',
      recipeTool: 'query_portfolio_changes',
      requiredDomains: ['tasks'],
      activeClients: [{ id: 'Client A', name: 'Client A', status: 'active' }],
    };

    const observation = await coordinator.run(taskPlan, async () => {
      coordinator.observe('query_tasks', { limit: 50 }, { tasks: [] });
      return coordinator.observations()[0];
    });

    expect(observation?.status).toBe('partial');
    expect(observation?.detail).toContain('cursor/total completeness contract');
  });

  test('treats a stale mailbox as partial even when the result page is complete', async () => {
    const coordinator = new MeriRetrievalCoordinator();

    const observation = await coordinator.run(plan(), async () => {
      coordinator.observe('search_emails', { query: 'Victory Six' }, {
        totalMatches: 1,
        returned: 1,
        hasMore: false,
        messages: [{ id: 'mail-1' }],
        searchedMailboxes: [
          {
            accountEmail: 'neo@example.com',
            provider: 'microsoft_365',
            status: 'connected',
            syncedMessages: 100,
            lastSyncAt: '2020-01-01T00:00:00.000Z',
          },
        ],
      });
      return coordinator.observations()[0];
    });

    expect(observation?.status).toBe('partial');
    expect(observation?.detail).toContain('has not synchronized within the last 48 hours');
  });

  test('keeps a current, fully paginated mailbox result complete', async () => {
    const coordinator = new MeriRetrievalCoordinator();

    const observation = await coordinator.run(plan(), async () => {
      coordinator.observe('search_emails', { query: 'Victory Six' }, {
        totalMatches: 1,
        returned: 1,
        hasMore: false,
        messages: [{ id: 'mail-1' }],
        searchedMailboxes: [
          {
            accountEmail: 'neo@example.com',
            provider: 'microsoft_365',
            status: 'connected',
            syncedMessages: 100,
            lastSyncAt: new Date().toISOString(),
          },
        ],
      });
      return coordinator.observations()[0];
    });

    expect(observation?.status).toBe('complete');
  });

  test('isolates concurrent request observations with AsyncLocalStorage', async () => {
    const coordinator = new MeriRetrievalCoordinator();
    const firstPlan = plan();
    const secondPlan: MeriRetrievalPlan = {
      ...plan(),
      queryClass: 'lookup',
      subjectScope: 'client',
      targetHint: null,
      recipeTool: null,
      requireCompleteCoverage: false,
      requiredDomains: [],
    };

    const [first, second] = await Promise.all([
      coordinator.run(firstPlan, async () => {
        await Promise.resolve();
        coordinator.observe('search_emails', {}, {
          totalMatches: 2,
          returned: 2,
          messages: [{ id: 'a' }, { id: 'b' }],
          searchedMailboxes: [
            {
              accountEmail: 'first@example.com',
              provider: 'microsoft_365',
              status: 'connected',
              syncedMessages: 2,
              lastSyncAt: new Date().toISOString(),
            },
          ],
        });
        return coordinator.observations().map((observation) => observation.tool);
      }),
      coordinator.run(secondPlan, async () => {
        await Promise.resolve();
        coordinator.observe('get_client_context', {}, { context: { client: { id: 'c' } } });
        return coordinator.observations().map((observation) => observation.tool);
      }),
    ]);

    expect(first).toEqual(['search_emails']);
    expect(second).toEqual(['get_client_context']);
  });
});
