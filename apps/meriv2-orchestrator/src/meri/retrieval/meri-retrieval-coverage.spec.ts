import type { MeriRetrievalPlan } from './meri-retrieval-plan.js';
import {
  appendMeriCoverageDisclosure,
  buildMeriCoverageManifest,
  observeMeriToolCoverage,
} from './meri-retrieval-coverage.js';

function plan(overrides: Partial<MeriRetrievalPlan> = {}): MeriRetrievalPlan {
  return {
    version: 1,
    queryClass: 'change_detection',
    subjectScope: 'portfolio',
    targetHint: null,
    recipeTool: 'query_portfolio_changes',
    requireCompleteCoverage: true,
    requiredDomains: [
      'clients',
      'mail',
      'meetings',
      'tasks',
      'action_items',
      'outreach',
      'legislation',
    ],
    optionalDomains: [],
    recommendedTools: ['query_portfolio_changes'],
    timeWindow: { expression: 'this week', withinDays: 7 },
    activeClients: [
      { id: 'Client A', name: 'Client A', status: 'active' },
      { id: 'Client B', name: 'Client B', status: 'active' },
    ],
    reasons: [],
    ...overrides,
  };
}

describe('Meri retrieval coverage', () => {
  test('marks a fully enumerated portfolio recipe complete even with zero changes', () => {
    const observation = observeMeriToolCoverage('query_portfolio_changes', {}, {
      coverage: {
        complete: true,
        requestedEntityCount: 2,
        searchedEntityCount: 2,
      },
      results: [],
      carryoverAttention: [],
    });

    const manifest = buildMeriCoverageManifest(plan(), [observation]);

    expect(manifest.complete).toBe(true);
    expect(manifest.requestedEntityCount).toBe(2);
    expect(manifest.searchedEntityCount).toBe(2);
    expect(manifest.missingDomains).toEqual([]);
    expect(manifest.paginationComplete).toBe(true);
  });

  test('does not treat a zero-result semantic search as exhaustive coverage', () => {
    const observation = observeMeriToolCoverage('search_research_sources', {}, {
      query: 'updates this week',
      results: [],
    });
    const relationshipPlan = plan({
      queryClass: 'relationship_history',
      subjectScope: 'external_entity',
      recipeTool: 'query_relationship_brief',
      requiredDomains: ['identity', 'internal_research', 'mail', 'contacts', 'memory'],
      activeClients: [],
    });

    const manifest = buildMeriCoverageManifest(relationshipPlan, [observation]);

    expect(manifest.complete).toBe(false);
    expect(manifest.partialDomains).toContain('internal_research');
    expect(manifest.missingDomains).toEqual(
      expect.arrayContaining(['identity', 'mail', 'contacts', 'memory']),
    );
  });

  test('reports pagination and mailbox outages as partial coverage', () => {
    const observation = observeMeriToolCoverage('search_emails', {}, {
      totalMatches: 80,
      returned: 50,
      hasMore: true,
      messages: Array.from({ length: 50 }, (_, index) => ({ id: `mail-${index}` })),
      searchedMailboxes: [
        {
          provider: 'microsoft_365',
          status: 'connected',
          syncedMessages: 1000,
          lastSyncAt: '2026-08-14T10:00:00.000Z',
        },
        {
          provider: 'google_workspace',
          status: 'error',
          syncedMessages: 0,
          note: 'Sync failed',
        },
      ],
    });
    const relationshipPlan = plan({
      queryClass: 'relationship_history',
      subjectScope: 'external_entity',
      recipeTool: 'query_relationship_brief',
      requiredDomains: ['mail'],
      activeClients: [],
    });

    const manifest = buildMeriCoverageManifest(relationshipPlan, [observation]);
    const reply = appendMeriCoverageDisclosure('Inbox brief', relationshipPlan, manifest);

    expect(manifest.complete).toBe(false);
    expect(manifest.paginationComplete).toBe(false);
    expect(manifest.truncated).toBe(true);
    expect(manifest.unavailableSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'google_workspace' }),
      ]),
    );
    expect(reply).toContain('Coverage is partial');
    expect(reply).toContain('additional or truncated results');
    expect(reply).toContain('google_workspace');
  });

  test('does not append a disclosure to a normal lookup with no required retrieval', () => {
    const lookupPlan = plan({
      queryClass: 'lookup',
      subjectScope: 'client',
      recipeTool: null,
      requireCompleteCoverage: false,
      requiredDomains: [],
      activeClients: [],
      timeWindow: null,
    });
    const manifest = buildMeriCoverageManifest(lookupPlan, []);

    expect(manifest.complete).toBe(true);
    expect(manifest.stopReason).toBe('no-retrieval-required');
    expect(appendMeriCoverageDisclosure('Answer', lookupPlan, manifest)).toBe('Answer');
  });
});
