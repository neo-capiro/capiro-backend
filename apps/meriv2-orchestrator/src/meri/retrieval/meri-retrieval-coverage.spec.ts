import type { MeriRetrievalPlan } from './meri-retrieval-plan.js';
import {
  appendMeriCoverageDisclosure,
  buildMeriCoverageManifest,
  observeMeriToolCoverage,
  coalesceMeriMailPages,
} from './meri-retrieval-coverage.js';

function mailPage(offset: number, returned: number, scope: Record<string, unknown> = {}) {
  const asOf = '2026-09-07T12:00:00.000Z';
  return {
    offset,
    asOf,
    queryScope: {
      query: null,
      from: null,
      participant: null,
      clientId: null,
      folder: 'inbox',
      withinDays: 14,
      asOf,
      ...scope,
    },
    totalMatches: 75,
    returned,
    hasMore: offset + returned < 75,
    messages: Array.from({ length: returned }, (_, i) => ({ id: `mail-${offset + i}` })),
    searchedMailboxes: [
      {
        provider: 'microsoft_365',
        status: 'connected',
        syncedMessages: 100,
        mailCoverage: { sourceStatus: 'healthy', lastMailSyncAt: asOf },
      },
    ],
  };
}

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
  test('keeps legacy newest-thread listings partial during a mixed-version rollout', () => {
    expect(observeMeriToolCoverage('list_emails', {}, { threads: [], count: 0 }).status).toBe(
      'partial',
    );
  });

  test('honors an explicit final page while counting 75 matching messages only once', () => {
    const first = observeMeriToolCoverage('list_emails', {}, mailPage(0, 50));
    const final = observeMeriToolCoverage('list_emails', {}, mailPage(50, 25));
    expect(final).toMatchObject({ hasMore: false, truncated: false, returned: 25, total: 75 });
    const manifest = buildMeriCoverageManifest(
      plan({ requiredDomains: ['mail'], subjectScope: 'general' }),
      [first, final, first],
    );
    expect(manifest).toMatchObject({
      complete: true,
      paginationComplete: true,
      truncated: false,
      recordsEvaluated: 75,
      recordsReturned: 75,
    });
  });

  test('does not close a mail query from only its final page or pages with different filters', () => {
    const first = observeMeriToolCoverage('list_emails', {}, mailPage(0, 50));
    const final = observeMeriToolCoverage('list_emails', {}, mailPage(50, 25));
    expect(coalesceMeriMailPages([final])[0]).toMatchObject({
      status: 'partial',
      hasMore: true,
      returned: 25,
      total: 75,
    });
    const different = observeMeriToolCoverage(
      'list_emails',
      {},
      mailPage(50, 25, { folder: 'sent' }),
    );
    const manifest = buildMeriCoverageManifest(
      plan({ requiredDomains: ['mail'], subjectScope: 'general' }),
      [first, different],
    );
    expect(manifest.complete).toBe(false);
    expect(manifest.paginationComplete).toBe(false);
  });

  test('recovers omitted whole rows through safe projected-page continuation but not clipped message content', () => {
    const first = observeMeriToolCoverage(
      'search_emails',
      {},
      {
        ...mailPage(0, 30),
        truncated: true,
        projection: { truncated: true, contentTruncated: false },
      },
    );
    const last = observeMeriToolCoverage('search_emails', {}, mailPage(30, 45));
    expect(coalesceMeriMailPages([first, last])[0]).toMatchObject({
      status: 'complete',
      returned: 75,
      total: 75,
      truncated: false,
    });
    const clipped = observeMeriToolCoverage(
      'search_emails',
      {},
      {
        ...mailPage(0, 30),
        truncated: true,
        projection: { truncated: true, contentTruncated: true },
      },
    );
    expect(coalesceMeriMailPages([clipped, last])[0]).toMatchObject({
      status: 'partial',
      truncated: true,
    });
  });

  test.each(['list_emails', 'search_emails'])(
    '%s uses mail health and message totals over thread grouping',
    (tool) => {
      const payload = {
        totalMatches: 2,
        returned: 2,
        count: 1,
        hasMore: false,
        messages: [{ id: 'mail-1' }, { id: 'mail-2' }],
        threads: [{ id: 'thread-1' }],
        searchedMailboxes: [
          {
            provider: 'microsoft_365',
            status: 'connected',
            syncedMessages: 100,
            mailCoverage: {
              sourceStatus: 'degraded',
              reason: 'mail_capture_repair_required',
              lastMailSyncAt: null,
            },
          },
        ],
      };
      const observation = observeMeriToolCoverage(
        tool,
        { withinDays: 14, folder: 'inbox' },
        payload,
      );
      expect(observation).toMatchObject({
        returned: 2,
        total: 2,
        status: 'partial',
        sourceHealth: [
          { source: 'microsoft_365', status: 'partial', detail: 'mail_capture_repair_required' },
        ],
      });
    },
  );

  test('marks a fully enumerated portfolio recipe complete even with zero changes', () => {
    const observation = observeMeriToolCoverage(
      'query_portfolio_changes',
      {},
      {
        coverage: {
          complete: true,
          requestedEntityCount: 2,
          searchedEntityCount: 2,
        },
        results: [],
        carryoverAttention: [],
      },
    );

    const manifest = buildMeriCoverageManifest(plan(), [observation]);

    expect(manifest.complete).toBe(true);
    expect(manifest.requestedEntityCount).toBe(2);
    expect(manifest.searchedEntityCount).toBe(2);
    expect(manifest.missingDomains).toEqual([]);
    expect(manifest.paginationComplete).toBe(true);
  });

  test('does not treat a zero-result semantic search as exhaustive coverage', () => {
    const observation = observeMeriToolCoverage(
      'search_research_sources',
      {},
      {
        query: 'updates this week',
        results: [],
      },
    );
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

  test('trusts explicit mailbox exhaustion even though the catalog is not globally exhaustive', () => {
    const observation = observeMeriToolCoverage(
      'search_emails',
      {},
      {
        totalMatches: 2,
        returned: 2,
        hasMore: false,
        messages: [{ id: 'mail-1' }, { id: 'mail-2' }],
      },
    );
    const relationshipPlan = plan({
      queryClass: 'relationship_history',
      subjectScope: 'external_entity',
      recipeTool: 'query_relationship_brief',
      requiredDomains: ['mail'],
      activeClients: [],
    });

    const manifest = buildMeriCoverageManifest(relationshipPlan, [observation]);

    expect(observation.status).toBe('complete');
    expect(manifest.complete).toBe(true);
    expect(manifest.paginationComplete).toBe(true);
  });

  test('renders pagination and mailbox outages as one clean coverage note', () => {
    const observation = observeMeriToolCoverage(
      'search_emails',
      {},
      {
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
      },
    );
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
      expect.arrayContaining([expect.objectContaining({ source: 'google_workspace' })]),
    );
    expect(reply).toContain('**Coverage note:**');
    expect(reply).toContain('Mailbox data was unavailable');
    expect(reply).not.toContain('Coverage is partial');
    expect(reply).not.toContain('google_workspace');
    expect(reply).not.toContain('Sync failed');
  });

  test('does not let an irrelevant optional-source outage downgrade complete mail coverage', () => {
    const mail = observeMeriToolCoverage(
      'search_emails',
      {},
      {
        totalMatches: 1,
        returned: 1,
        hasMore: false,
        messages: [{ id: 'mail-1' }],
      },
    );
    const publicWeb = observeMeriToolCoverage(
      'search_public_web',
      {},
      {
        error: '502 Bad Gateway',
        results: [],
      },
    );
    const relationshipPlan = plan({
      queryClass: 'relationship_history',
      subjectScope: 'external_entity',
      recipeTool: 'query_relationship_brief',
      requiredDomains: ['mail'],
      optionalDomains: ['public_web'],
      activeClients: [],
    });

    const manifest = buildMeriCoverageManifest(relationshipPlan, [mail, publicWeb]);

    expect(manifest.complete).toBe(true);
    expect(manifest.unavailableSources).toEqual([]);
    expect(appendMeriCoverageDisclosure('Inbox brief', relationshipPlan, manifest)).toBe(
      'Inbox brief',
    );
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
