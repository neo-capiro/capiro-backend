import type { MeriContext } from '@capiro/meriv2-core';
import type { MeriRetrievalPlan } from '../retrieval/meri-retrieval-plan.js';
import {
  executeMeriRetrievalRecipe,
  MERI_RELATIONSHIP_RECIPE_VARIANT_CONTRACT,
  MERI_RETRIEVAL_TOOL_SCHEMAS,
  type MeriUnderlyingToolInvoker,
} from './meriv3-retrieval-recipes.js';
import { MERI_SKILL_REGISTRY } from '@capiro/shared/meri-skills';

function plan(overrides: Partial<MeriRetrievalPlan> = {}): MeriRetrievalPlan {
  return {
    version: 1,
    queryClass: 'relationship_history',
    subjectScope: 'external_entity',
    targetHint: 'Victory Six',
    recipeTool: 'query_relationship_brief',
    requireCompleteCoverage: true,
    requiredDomains: ['mail', 'contacts', 'memory'],
    optionalDomains: ['clients', 'internal_research', 'documents', 'meetings', 'tasks', 'outreach'],
    recommendedTools: [],
    timeWindow: null,
    activeClients: [],
    reasons: [],
    ...overrides,
  };
}

const meriContext = { tenantId: 'tenant-1', userId: 'user-1' } as unknown as MeriContext;

function relationshipMock(extra?: MeriUnderlyingToolInvoker) {
  return jest.fn(async (name: string, input: Record<string, unknown>) => {
    if (extra) {
      const delegated = await extra(name, input);
      if (delegated !== undefined) return delegated;
    }
    switch (name) {
      case 'lookup_client_registry':
        return {
          results: [
            {
              id: 'client-v6',
              clientId: 'client-v6',
              name: 'Victory Six Advisors',
              domain: 'v6advisors.com',
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
  test('relationship variants preserve skill intent while recording shared recipe execution limits', async () => {
    const schema = MERI_RETRIEVAL_TOOL_SCHEMAS.find(
      (candidate) => candidate.name === MERI_RELATIONSHIP_RECIPE_VARIANT_CONTRACT.recipeTool,
    );
    expect(schema?.input_schema.required).toEqual(['entity']);
    expect(schema?.input_schema.properties).toHaveProperty('withinDays');
    expect(schema?.description).toContain(
      'coverage manifest reports mailbox health/pagination only',
    );

    for (const variant of Object.values(MERI_RELATIONSHIP_RECIPE_VARIANT_CONTRACT.variants)) {
      const skill = MERI_SKILL_REGISTRY.find((candidate) => candidate.id === variant.skillId);
      expect(skill?.canonicalRecipe).toBe(variant.canonicalRecipe);
      expect(skill?.semanticDomains).toEqual(variant.intentDomains);
    }

    const broadInvoke = relationshipMock();
    const broadRaw = await executeMeriRetrievalRecipe(
      'query_relationship_brief',
      { entity: 'Victory Six' },
      { plan: plan(), meriContext, invoke: broadInvoke },
    );
    const broad = broadRaw as {
      coverage: { requestedDomains: string[] };
      diagnostics: { mailHistoryFocus: boolean };
    };

    const mailInvoke = relationshipMock();
    const mailRaw = await executeMeriRetrievalRecipe(
      'query_relationship_brief',
      { entity: 'Victory Six' },
      {
        plan: plan({ reasons: ['recipe:query_relationship_brief', 'mail-history-focus'] }),
        meriContext,
        invoke: mailInvoke,
      },
    );
    const mail = mailRaw as {
      coverage: { requestedDomains: string[] };
      diagnostics: { mailHistoryFocus: boolean };
    };

    expect(broad.diagnostics.mailHistoryFocus).toBe(false);
    expect(broad.coverage.requestedDomains).toEqual(['mail']);
    expect(broadInvoke.mock.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'get_client_context',
        'search_client_knowledge',
        'query_debriefs',
        'query_tasks',
        'query_outreach',
      ]),
    );
    expect(mail.diagnostics.mailHistoryFocus).toBe(true);
    expect(mail.coverage.requestedDomains).toEqual(['mail']);
    const mailCalls = mailInvoke.mock.calls.map(([name]) => name);
    for (const omitted of [
      'get_client_context',
      'search_client_knowledge',
      'query_debriefs',
      'query_tasks',
      'query_outreach',
      'list_upcoming_meetings',
      'read_client_documents',
      'search_research_sources',
    ]) {
      expect(mailCalls).not.toContain(omitted);
    }
  });

  test('uses the native API existing-client ID for shared-mode client readers', async () => {
    const apiShapedInvoke = jest.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'lookup_client_registry') {
        return {
          existingClient: { id: 'client-v6', name: 'Victory Six Advisors', website: null },
          ldaExactMatch: null,
          ldaCandidates: [],
          guidance: 'Use get_client_context.',
        };
      }
      if (name === 'get_client_context') return { clientId: input.clientId, profile: {} };
      if (name === 'search_client_knowledge') return { results: [] };
      if (name === 'query_debriefs') return { results: [] };
      if (name === 'query_tasks') return { error: 'tasks temporarily unavailable' };
      if (name === 'query_outreach') return { results: [] };
      return { results: [] };
    });
    const raw = await executeMeriRetrievalRecipe(
      'query_relationship_brief',
      { entity: 'Victory Six Advisors' },
      { plan: plan(), meriContext, invoke: apiShapedInvoke },
    );
    const result = raw as {
      resolvedEntity: { clientId?: string | null } | null;
      diagnostics: { optionalSourceFailures: string[] };
    };
    const clientReaderNames = [
      'get_client_context',
      'search_client_knowledge',
      'query_debriefs',
      'query_tasks',
      'query_outreach',
    ];

    expect(result.resolvedEntity?.clientId).toBe('client-v6');
    const readerCalls = apiShapedInvoke.mock.calls.filter(([name]) =>
      clientReaderNames.includes(name),
    );
    expect(readerCalls.map(([name]) => name).sort()).toEqual([...clientReaderNames].sort());
    expect(readerCalls.every(([, input]) => input.clientId === 'client-v6')).toBe(true);
    expect(result.diagnostics.optionalSourceFailures).toContain('query_tasks');
  });

  test.each([
    ['no existing client', null],
    [
      'ambiguous registry match only',
      {
        existingClient: null,
        ldaExactMatch: null,
        ldaCandidates: [{ ldaClientId: 'lda-1', name: 'Victory Six Advisors' }],
        guidance: 'Ask the user to resolve the match.',
      },
    ],
    ['malformed empty client ID', { id: '   ', name: 'Victory Six Advisors' }],
  ])('does not fan out to client readers for %s', async (_label, existingClient) => {
    const guardedInvoke = jest.fn(async (name: string) => {
      if (name === 'lookup_client_registry') {
        return {
          existingClient,
          ldaExactMatch: null,
          ldaCandidates: [],
          guidance: 'No resolved client.',
        };
      }
      return { results: [] };
    });
    await executeMeriRetrievalRecipe(
      'query_relationship_brief',
      { entity: 'Victory Six Advisors' },
      { plan: plan(), meriContext, invoke: guardedInvoke },
    );

    for (const clientReader of [
      'get_client_context',
      'search_client_knowledge',
      'query_debriefs',
      'query_tasks',
      'query_outreach',
    ]) {
      expect(guardedInvoke.mock.calls.map(([name]) => name)).not.toContain(clientReader);
    }
  });

  test('keeps the five client readers skipped in mail-history focus with a valid native ID', async () => {
    const mailFocusInvoke = jest.fn(async (name: string) => {
      if (name === 'lookup_client_registry') {
        return {
          existingClient: { id: 'client-v6', name: 'Victory Six Advisors', website: null },
          ldaExactMatch: null,
          ldaCandidates: [],
          guidance: 'Use get_client_context.',
        };
      }
      return { results: [] };
    });
    const raw = await executeMeriRetrievalRecipe(
      'query_relationship_brief',
      { entity: 'Victory Six Advisors' },
      {
        plan: plan({ reasons: ['recipe:query_relationship_brief', 'mail-history-focus'] }),
        meriContext,
        invoke: mailFocusInvoke,
      },
    );
    const result = raw as { resolvedEntity: { clientId?: string | null } | null };
    expect(result.resolvedEntity?.clientId).toBe('client-v6');

    for (const clientReader of [
      'get_client_context',
      'search_client_knowledge',
      'query_debriefs',
      'query_tasks',
      'query_outreach',
    ]) {
      expect(mailFocusInvoke.mock.calls.map(([name]) => name)).not.toContain(clientReader);
    }
  });

  test('builds a mailbox-first relationship brief and closes a bounded truncation gap', async () => {
    const invoke = relationshipMock(async (name, input) => {
      if (name === 'search_emails') {
        if (typeof input.query === 'string' && input.query !== 'Victory Six') {
          return {
            totalMatches: 1,
            returned: 1,
            hasMore: false,
            messages: [
              {
                id: 'mail-1',
                subject: String(input.query),
                bodyText: 'Sean asked to finish connector setup.',
                sentAt: '2026-08-10T15:00:00.000Z',
                fromEmail: 'sean@v6advisors.com',
              },
            ],
          };
        }
        if (typeof input.participant === 'string') {
          return {
            totalMatches: 1,
            returned: 1,
            hasMore: false,
            messages: [
              {
                id: 'mail-2',
                subject: 'V6 | Pilot feedback',
                bodyText: 'Sean shared pilot feedback and next steps.',
                sentAt: '2026-08-12T15:00:00.000Z',
                fromEmail: 'sean@v6advisors.com',
              },
            ],
          };
        }
        return {
          totalMatches: 2,
          returned: 1,
          hasMore: true,
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
              lastSyncAt: new Date().toISOString(),
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
              email: 'sean@v6advisors.com',
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
      {
        plan: plan({ reasons: ['mail-history-focus'] }),
        meriContext,
        invoke,
      },
    );
    const result = raw as {
      resolvedEntity: { canonicalName: string; domains: string[] } | null;
      results: Array<{ sourceTool: string; title: string }>;
      coverage: {
        complete: boolean;
        authoritative: boolean;
        requestedEntityCount: number;
        searchedEntityCount: number;
        recordsEvaluated: number;
        recordsReturned: number;
      };
    };

    expect(result.resolvedEntity?.canonicalName).toBe('Victory Six');
    expect(result.resolvedEntity?.domains).toContain('v6advisors.com');
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceTool: 'search_emails', title: 'V6 | Capiro orientation' }),
        expect.objectContaining({ sourceTool: 'search_emails', title: 'V6 | Pilot feedback' }),
        expect.objectContaining({ sourceTool: 'find_contacts', title: 'Sean Montplaisir' }),
      ]),
    );
    expect(result.coverage).toEqual(
      expect.objectContaining({
        complete: true,
        authoritative: true,
        requestedEntityCount: 1,
        searchedEntityCount: 1,
        recordsEvaluated: 2,
        recordsReturned: 2,
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'search_emails',
      expect.objectContaining({
        participant: expect.stringMatching(/@v6advisors\.com$|^v6advisors\.com$/),
        withinDays: 30,
        limit: 50,
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'search_emails',
      expect.objectContaining({
        query: 'V6 | Capiro orientation',
        participant: 'v6advisors.com',
        withinDays: 30,
        limit: 50,
      }),
    );
    for (const forbidden of [
      'resolve_entity',
      'search_lda_filings',
      'search_sec_filings',
      'search_federal_awards',
      'search_public_web',
      'search_federal_grants',
      'search_program_elements',
    ]) {
      expect(invoke).not.toHaveBeenCalledWith(forbidden, expect.anything());
    }
  });

  test('keeps stale mailbox coverage incomplete even after bounded follow-ups', async () => {
    const invoke = relationshipMock(async (name, input) => {
      if (name === 'search_emails') {
        return {
          totalMatches: 1,
          returned: 1,
          hasMore: false,
          messages: [
            {
              id: 'mail-stale',
              subject: 'Victory Six update',
              bodyText: 'A synchronized message.',
              sentAt: '2026-08-10T15:00:00.000Z',
              fromEmail: 'sean@v6advisors.com',
            },
          ],
          ...(input.query === 'Victory Six'
            ? {
                searchedMailboxes: [
                  {
                    provider: 'microsoft_365',
                    status: 'connected',
                    syncedMessages: 400,
                    lastSyncAt: '2020-01-01T00:00:00.000Z',
                  },
                ],
              }
            : {}),
        };
      }
      if (name === 'find_contacts') {
        return {
          results: [
            {
              id: 'contact-stale',
              name: 'Sean Montplaisir',
              email: 'sean@v6advisors.com',
            },
          ],
        };
      }
      return undefined;
    });

    const raw = await executeMeriRetrievalRecipe(
      'query_relationship_brief',
      { entity: 'Victory Six' },
      {
        plan: plan({ reasons: ['mail-history-focus'] }),
        meriContext,
        invoke,
      },
    );
    const result = raw as {
      coverage: {
        complete: boolean;
        authoritative: boolean;
        unavailableSources: Array<{ source: string; reason: string }>;
      };
    };

    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.authoritative).toBe(true);
    expect(result.coverage.unavailableSources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'mail',
          reason: expect.stringContaining('has not synchronized within the last 48 hours'),
        }),
      ]),
    );
  });

  test('uses the bounded company-profile lane for an ordinary lookup', async () => {
    const invoke = jest.fn(async (name: string) => {
      switch (name) {
        case 'lookup_client_registry':
          return {
            results: [
              {
                id: 'overland',
                name: 'Overland AI',
                domain: 'overland.ai',
                description: 'Defense ground autonomy company.',
              },
            ],
          };
        case 'search_research_sources':
          return {
            results: [
              {
                id: 'internal-overland',
                title: 'Overland AI',
                description: 'Autonomous ground vehicles for off-road defense missions.',
              },
            ],
          };
        case 'search_public_web':
          return {
            results: [
              {
                id: 'web-overland',
                title: 'Overland AI',
                url: 'https://overland.ai',
                snippet: 'Ground autonomy for defense operations in complex terrain.',
              },
            ],
          };
        case 'scrape_web_page':
          return {
            id: 'site-overland',
            title: 'Overland AI',
            url: 'https://overland.ai',
            text: 'Autonomous vehicle systems for off-road and contested environments.',
          };
        default:
          return { results: [] };
      }
    });
    const lookupPlan = plan({
      queryClass: 'lookup',
      targetHint: 'Overland AI',
      recipeTool: 'research_external_company',
      requireCompleteCoverage: false,
      requiredDomains: ['public_web'],
      optionalDomains: ['clients', 'internal_research'],
      reasons: ['quick-company-profile'],
    });

    const raw = await executeMeriRetrievalRecipe(
      'research_external_company',
      { entity: 'Overland AI' },
      { plan: lookupPlan, meriContext, invoke },
    );
    const result = raw as {
      profileMode: string;
      researchSubject: string;
      results: Array<{ sourceTool: string }>;
      coverage: { complete: boolean; authoritative: boolean };
    };

    expect(result.profileMode).toBe('quick');
    expect(result.researchSubject).toBe('Overland AI');
    expect(result.coverage).toEqual(
      expect.objectContaining({ complete: true, authoritative: true }),
    );
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceTool: 'search_public_web' }),
        expect.objectContaining({ sourceTool: 'scrape_web_page' }),
      ]),
    );
    for (const forbidden of [
      'resolve_entity',
      'search_lda_filings',
      'search_sec_filings',
      'search_federal_awards',
      'search_sam_opportunities',
      'search_federal_grants',
      'search_program_elements',
      'get_program_element',
      'get_pe_budget_timeline',
      'get_pe_report_language',
    ]) {
      expect(invoke).not.toHaveBeenCalledWith(forbidden, expect.anything());
    }
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
      calls.filter((call) => call.name === 'query_debriefs').map((call) => call.input.clientId),
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
              snippet:
                'Supply chain logistics, readiness, inventory and Navy distribution consulting.',
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
              capabilities: [{ name: 'Supply Chain Logistics' }, { name: 'Inventory Readiness' }],
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
        [
          'search_lda_filings',
          'search_sec_filings',
          'search_federal_awards',
          'search_sam_opportunities',
          'search_federal_grants',
        ].includes(name)
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
