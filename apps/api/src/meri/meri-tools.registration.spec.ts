jest.mock('../clients/client-capabilities.service.js', () => ({
  ClientCapabilitiesService: jest.fn(),
}));
jest.mock('../clients/client-people.service.js', () => ({ ClientPeopleService: jest.fn() }));
jest.mock('../clients/client-facilities.service.js', () => ({
  ClientFacilitiesService: jest.fn(),
}));
jest.mock('../engagement/mail-sender.service.js', () => ({ EngagementMailSender: jest.fn() }));
jest.mock('../regulatory-docket/regulatory-docket.service.js', () => ({
  RegulatoryDocketService: jest.fn(),
}));
jest.mock('../lda-intel/lda-intel.service.js', () => ({ LdaIntelService: jest.fn() }));
jest.mock('../lobby-intel/lobby-intel.service.js', () => ({ LobbyIntelService: jest.fn() }));
jest.mock('../federal-spending/federal-spending.service.js', () => ({
  FederalSpendingService: jest.fn(),
}));
jest.mock('./analytics/analytics-db.service.js', () => ({ AnalyticsDbService: jest.fn() }));
jest.mock('../intelligence/actions/action-recommendation-read.service.js', () => ({
  ActionRecommendationReadService: jest.fn(),
}));
jest.mock('../intelligence/intelligence.service.js', () => ({ IntelligenceService: jest.fn() }));
jest.mock('../clients/clients.service.js', () => ({ ClientsService: jest.fn() }));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: jest.fn() }));
jest.mock('../program-element/program-element-read.service.js', () => ({
  ProgramElementReadService: jest.fn(),
}));
jest.mock('../acquisition-personnel/acquisition-personnel-read.service.js', () => ({
  AcquisitionPersonnelReadService: jest.fn(),
}));
jest.mock('../memory/memory-candidate.service.js', () => ({ MemoryCandidateService: jest.fn() }));
jest.mock('../memory/memory-ingest.service.js', () => ({ MemoryIngestService: jest.fn() }));
jest.mock('../memory/memory-store.service.js', () => ({ MemoryStoreService: jest.fn() }));
jest.mock('../clients/representation-resolver.service.js', () => ({
  RepresentationResolverService: jest.fn(),
}));
jest.mock('./meri-docgen.service.js', () => ({ MeriDocgenService: jest.fn() }));
jest.mock('./meri-context-plane.service.js', () => ({ MeriContextPlaneService: jest.fn() }));
jest.mock('../funding-opportunities/meri-opportunity-tools.adapter.js', () => ({
  MeriOpportunityToolsAdapter: jest.fn(),
}));
// These contracts stub the domain ports; loading the unrelated mail/generation graph is unnecessary.
jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: jest.fn() }));
jest.mock('./meri-defense-budget-tool.helpers.js', () => ({}));

import { MeriToolsService, TOOL_DEFINITIONS } from './meri-tools.service.js';

describe('buyer workspace Meri tool', () => {
  it('passes a pinned read through without changing coverage or unsupported gaps', async () => {
    const payload = {
      subject: { type: 'pe', id: '0603851F' },
      asOfFy: 2027,
      knownAt: '2026-09-24T00:00:00.000Z',
      budget: {
        state: 'unsupported',
        data: null,
        coverage: { unresolvedReasons: [{ code: 'gap' }] },
        freshness: null,
      },
      federalEvidence: { state: 'unsupported', data: null },
      acquisition: { state: 'partial', data: { events: [1] } },
      fundingExecution: { state: 'complete', data: { publications: [2] } },
    };
    const read = jest.fn(async () => payload);
    const service = Object.assign(Object.create(MeriToolsService.prototype), {
      buyerWorkspace: { read },
    }) as MeriToolsService;
    const input = { peCode: '0603851F', asOfFy: 2027, knownAt: '2026-09-24T00:00:00Z' };
    await expect(service.execute({} as never, 'get_pe_buyer_workspace', input)).resolves.toEqual({
      tool: 'get_pe_buyer_workspace',
      ...payload,
    });
    expect(read).toHaveBeenCalledWith(input);
    await expect(
      service.execute({} as never, 'get_pe_buyer_workspace', { ...input, asOfFy: '2027' }),
    ).rejects.toThrow('asOfFy');
    expect(read).toHaveBeenCalledTimes(1);
  });
});

/**
 * Tool-registration regression spec. Guards the whole Meri tool surface so a
 * future change cannot silently drop a tool, orphan a schema, or lose a
 * required-input constraint. EXPECTED_TOOLS is intentionally explicit: removing
 * a tool (or renaming one) must fail loudly here and be a deliberate edit.
 */

const EXPECTED_TOOLS = [
  'search_legiwatch_news',
  'get_florida_budget_project',
  'compare_florida_budget_amounts',
  'prepare_legiwatch_briefing',
  'search_legislative_research',
  'get_legal_reference',
  'compare_legislative_versions',
  'save_legislative_research',
  'get_legiwatch_review',
  'preview_legiwatch_relevance',
  'save_legiwatch_relevance',
  'apply_legiwatch_suggestion',
  // Engagement + research
  'get_client_context',
  'search_capiro_data',
  'get_research_evidence',
  'read_chat_attachments',
  'read_monday_client_boards',
  'search_research_sources',
  // Defense Intelligence Research Portfolios — one domain service surface.
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
  // Client knowledge base (assistant-parity F5)
  'search_client_knowledge',
  // Analysis sandbox (assistant-parity F4; pilot-gated per tenant)
  'run_analysis',
  // Federal intelligence
  'query_intelligence',
  // Institutional-memory knowledge graph (read-only insight tools)
  'query_knowledge_graph',
  'find_path_to',
  'search_memory',
  'search_congress_bills',
  // Vote/status truth layer (LegiWatch A5)
  'get_bill_status',
  'read_bill_text',
  'get_certification_status',
  'search_floor_votes',
  // Budget-score spine (Bucket-#3 C4.F1, SC2.4)
  'search_cbo_cost_estimates',
  // Canonical entity resolution (Bucket-#3 C6.P6.2, SC2.2)
  'resolve_entity',
  'search_lda_filings',
  // Global-data analytics (structured aggregate queries over the ingested
  // reference datasets — LDA, grants, SAM/USAspending, SEC, FARA, bills,
  // GAO/CRS, FEC, news — never tenant-private data).
  'list_global_datasets',
  'query_global_data',
  'search_sec_filings',
  'search_fara_registrations',
  'search_federal_grants',
  'search_federal_awards',
  'search_gao_reports',
  // State Legislation Platform (Phase 0 S6) — LegiScan-backed state tools
  'search_state_bills',
  'get_state_bill_status',
  'search_state_floor_votes',
  'get_state_legislator',
  // 50-state analyst (Phase 1 M4.1/M4.2) — committee rosters + representation
  'get_committee_roster',
  'get_representation',
  'list_members',
  'get_state_rule_status',
  'search_intel_articles',
  'search_committee_hearings',
  'search_crs_reports',
  'query_economic_data',
  'get_district_nexus_context',
  'get_district_nexus_changes',
  // Web
  'search_public_web',
  'scrape_web_page',
  // Drafting / notes / email / memory
  'create_meeting_brief',
  'draft_policy_memo',
  'save_note',
  'save_chat_attachments',
  'send_email',
  'list_emails',
  'search_emails',
  'get_email_thread',
  'list_upcoming_meetings',
  'reply_email',
  'save_memory',
  // Memory governance verbs (Phase 1, 1D)
  'confirm_memory',
  'correct_memory',
  'forget_memory',
  // DoD program elements + acquisition personnel
  'search_program_elements',
  'get_program_element',
  'get_pe_budget_timeline',
  'get_pe_buyer_workspace',
  'get_pe_contractors',
  'get_pe_bills',
  'get_pe_report_language',
  'search_acquisition_personnel',
  'get_acquisition_person',
  'find_contacts',
  // Document generation
  'create_word',
  'create_excel',
  'create_powerpoint',
  // Scheduling
  'schedule_task',
  'list_scheduled_tasks',
  'cancel_scheduled_task',
  // Firm operational data (tool-coverage expansion)
  'query_tasks',
  'query_action_items',
  'search_tracked_bills',
  'query_regulatory_dockets',
  'search_sam_opportunities',
  'query_debriefs',
  'read_client_meetings',
  'read_client_documents',
  'query_outreach',
  // Client creation (LDA-first): read-only pre-check + approval-gated write
  'lookup_client_registry',
  // Approval-gated writes (tool-coverage expansion)
  'create_client',
  'create_task',
  'update_task',
  'update_client_profile',
  // Business Development Phase 4 — prospect-scoped reads + approved save
  'get_business_development_context',
  'get_business_development_evidence',
  'get_business_development_brief',
  'resolve_business_development_source',
  'save_business_development_brief',
  // Business Development Phase 5 — read-only ingested-alert summary
  'get_business_development_recent_changes',
  // Funding Opportunities (P37) — READ-ONLY local tools. None is
  // side-effecting, so all survive the read-only chat surface below.
  'get_funding_opportunity',
  'search_funding_opportunities',
  'get_funding_opportunity_requirements',
  'explain_opportunity_match',
  'get_opportunity_client_context',
  'get_opportunity_government_landscape',
  'compare_funding_opportunities',
  'build_opportunity_action_plan',
] as const;

/** Tools whose schema must enforce required inputs, and exactly which. */
const REQUIRED_INPUTS: Record<string, string[]> = {
  search_legiwatch_news: ['view'],
  get_florida_budget_project: ['fiscalYear'],
  compare_florida_budget_amounts: ['leftId', 'leftRevision', 'rightId', 'rightRevision'],
  prepare_legiwatch_briefing: [
    'folderId',
    'template',
    'title',
    'analysis',
    'cutoff',
    'timezone',
    'requestKey',
    'sources',
    'citations',
  ],
  search_legislative_research: ['jurisdiction', 'sessionKey'],
  get_legal_reference: ['jurisdiction', 'view'],
  compare_legislative_versions: [
    'jurisdiction',
    'sessionKey',
    'leftId',
    'leftRevision',
    'rightId',
    'rightRevision',
  ],
  save_legislative_research: [
    'jurisdiction',
    'sessionKey',
    'title',
    'analysis',
    'requestKey',
    'documents',
    'citations',
  ],
  get_client_context: ['clientId'],
  search_capiro_data: ['query', 'domains'],
  get_research_evidence: ['sessionId'],
  read_chat_attachments: [],
  read_monday_client_boards: ['clientId'],
  search_research_sources: ['query'],
  get_research_portfolio: ['conversationId'],
  get_research_portfolio_analytics: ['conversationId'],
  get_research_portfolio_changes: ['conversationId'],
  create_research_portfolio_snapshot: [
    'conversationId',
    'operationKey',
    'name',
    'expectedRevision',
  ],
  request_research_portfolio_output: ['conversationId', 'operationKey'],
  save_research_portfolio_output_to_client: [
    'conversationId',
    'outputId',
    'clientId',
    'operationKey',
  ],
  watch_research_portfolio: ['conversationId'],
  update_research_portfolio_change_state: ['conversationId', 'eventId', 'action'],
  get_research_portfolio_bookmarks: ['conversationId'],
  create_research_portfolio_bookmark: ['conversationId', 'targetKind', 'targetId'],
  get_research_portfolio_fit: ['conversationId'],
  get_research_portfolio_reviews: ['conversationId'],
  add_research_portfolio_review_note: ['conversationId', 'reviewId', 'body'],
  get_research_portfolio_rules: ['conversationId'],
  get_research_portfolio_imports: ['conversationId'],
  get_research_portfolio_operations: ['conversationId'],
  prepare_research_portfolio_brief: ['conversationId'],
  prepare_research_portfolio_meeting: ['conversationId'],
  search_client_knowledge: ['query'],
  run_analysis: ['code'],
  search_public_web: ['query'],
  scrape_web_page: ['url'],
  create_meeting_brief: ['meetingId'],
  draft_policy_memo: ['clientId'],
  save_note: ['body'],
  save_chat_attachments: ['clientId', 'conversationId', 'attachmentIds'],
  get_legiwatch_review: ['view'],
  preview_legiwatch_relevance: ['folderId', 'jurisdiction', 'sessionKey', 'billId'],
  save_legiwatch_relevance: [
    'folderId',
    'jurisdiction',
    'sessionKey',
    'billId',
    'explanation',
    'documentId',
    'start',
    'end',
    'quote',
    'previewHash',
    'requestKey',
  ],
  apply_legiwatch_suggestion: [
    'folderId',
    'jurisdiction',
    'sessionKey',
    'suggestionId',
    'expectedVersion',
    'requestKey',
    'action',
  ],
  send_email: ['to', 'subject', 'body'],
  reply_email: ['threadId', 'body'],
  get_email_thread: ['threadId'],
  save_memory: ['content'],
  confirm_memory: ['memoryItemId'],
  correct_memory: ['memoryItemId', 'newContent'],
  forget_memory: ['memoryItemId'],
  get_program_element: ['peCode'],
  get_pe_budget_timeline: ['peCode'],
  get_pe_buyer_workspace: ['peCode', 'asOfFy', 'knownAt'],
  get_pe_contractors: ['peCode'],
  get_pe_bills: ['peCode'],
  get_pe_report_language: ['peCode'],
  get_acquisition_person: ['id'],
  find_path_to: ['to'],
  search_memory: ['query'],
  query_global_data: ['dataset', 'select'],
  resolve_entity: ['query'],
  get_bill_status: ['billId'],
  read_bill_text: ['billId'],
  get_certification_status: ['program', 'query'],
  get_state_bill_status: ['billId'],
  get_state_legislator: ['query'],
  get_committee_roster: ['committee', 'jurisdiction'],
  get_representation: ['clientId'],
  get_state_rule_status: ['query'],
  create_word: ['title', 'sections'],
  create_excel: ['title', 'sheets'],
  create_powerpoint: ['title', 'slides'],
  schedule_task: ['name', 'prompt', 'intervalMinutes'],
  cancel_scheduled_task: ['taskId'],
  search_tracked_bills: ['clientId'],
  query_debriefs: ['clientId'],
  read_client_meetings: ['clientId'],
  read_client_documents: ['clientId'],
  lookup_client_registry: ['name'],
  create_client: ['name'],
  create_task: ['title'],
  update_task: ['taskId'],
  update_client_profile: ['clientId'],
  resolve_business_development_source: ['citationIndex'],
  save_business_development_brief: ['expectedVersionNumber', 'sections'],
  // P37. `clientId` is required on every funding tool — see the schema block's own note:
  // the chat loop's client-scope refusal keys on that field, so a tool without
  // it would read straight past a scoped session's boundary.
  get_funding_opportunity: ['clientId', 'source', 'sourceRecordId'],
  search_funding_opportunities: ['clientId'],
  get_funding_opportunity_requirements: ['clientId', 'source', 'sourceRecordId'],
  explain_opportunity_match: ['clientId', 'source', 'sourceRecordId'],
  get_opportunity_client_context: ['clientId'],
  get_opportunity_government_landscape: ['clientId', 'source', 'sourceRecordId'],
  compare_funding_opportunities: ['clientId', 'opportunities'],
  build_opportunity_action_plan: ['clientId', 'source', 'sourceRecordId'],
};

// anthropicToolSchemas() is self-contained (no constructor deps), so an
// uninitialized prototype instance is enough to read the schema surface.
function schemas() {
  const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
  return service.anthropicToolSchemas({
    tenantId: '11111111-1111-4111-8111-111111111111',
    surface: 'chat',
    env: {
      MERI_STATUS_PROVENANCE_MODE: 'enforce',
      MERI_STATUS_PROVENANCE_TENANTS: 'all',
      MERI_STATUS_PROVENANCE_SURFACES: 'chat',
    },
  });
}

describe('Meri tool registration', () => {
  it('dispatches read_chat_attachments only through the dedicated owner service', async () => {
    const read = jest.fn(async () => ({ tool: 'read_chat_attachments', records: [] }));
    const service = Object.assign(Object.create(MeriToolsService.prototype), {
      chatAttachmentReader: { read },
    }) as MeriToolsService;
    const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;
    const input = { conversationId: '11111111-1111-4111-8111-111111111111' };
    await expect(service.execute(ctx, 'read_chat_attachments', input)).resolves.toMatchObject({
      tool: 'read_chat_attachments',
    });
    expect(read).toHaveBeenCalledWith(ctx, input);
  });

  it.each(['get_legiwatch_review', 'apply_legiwatch_suggestion'] as const)(
    '%s injects authenticated identity and validates the client before the owner-service call',
    async (name) => {
      const original = global.fetch,
        secret = process.env.INTERNAL_SERVICE_SECRET;
      const ctx = {
          tenantId: '11111111-1111-4111-8111-111111111111',
          clerkUserId: 'current-actor',
        },
        input = {
          view: 'suggestions',
          clientId: 'client-1',
          folderId: 'folder-1',
          jurisdiction: 'FL',
          sessionKey: '2026',
          tenantId: 'spoofed',
          actor: 'spoofed',
        };
      const ensureClientVisible = jest.fn(async () => 'client-1'),
        service = Object.assign(Object.create(MeriToolsService.prototype), {
          ensureClientVisible,
        }) as MeriToolsService;
      try {
        process.env.INTERNAL_SERVICE_SECRET = 'synthetic-adapter-secret';
        global.fetch = jest.fn(
          async () => ({ ok: true, json: async () => ({ rows: [], effects: [] }) }) as Response,
        );
        await service.execute(ctx as never, name, input);
        expect(ensureClientVisible).toHaveBeenCalledWith(ctx, 'client-1');
        const [url, request] = (global.fetch as jest.Mock).mock.calls[0]!;
        expect(url).toContain(
          '/internal/legiwatch/meri/' + (name === 'get_legiwatch_review' ? 'read' : 'apply'),
        );
        expect(JSON.parse(request.body)).toMatchObject({
          tenantId: ctx.tenantId,
          actor: ctx.clerkUserId,
          input: { folderId: 'folder-1', jurisdiction: 'FL', sessionKey: '2026' },
        });
        ensureClientVisible.mockRejectedValueOnce(new Error('client withdrawn'));
        await expect(service.execute(ctx as never, name, input)).rejects.toThrow(
          'client withdrawn',
        );
        expect(global.fetch).toHaveBeenCalledTimes(1);
      } finally {
        global.fetch = original;
        if (secret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
        else process.env.INTERNAL_SERVICE_SECRET = secret;
      }
    },
  );
  it('passes authorized actor, client and continuation parameters to canonical funding handlers', async () => {
    const actor = { tenantId: 'tenant-1', userId: 'user-1', role: 'standard_user' } as const;
    const opportunityTools = {
      searchFundingOpportunities: jest.fn(async () => ({ state: 'available' })),
      getFundingOpportunityRequirements: jest.fn(async () => ({ state: 'available' })),
      getFundingOpportunity: jest.fn(async () => ({ state: 'available' })),
    };
    const service = Object.assign(Object.create(MeriToolsService.prototype), {
      opportunityTools,
    }) as MeriToolsService;
    const discovery = {
      clientId: 'client-1',
      source: 'sam_gov',
      query: 'power conversion',
      page: 2,
      pageSize: 3,
      activeState: 'all',
    };
    await service.execute(actor as never, 'search_funding_opportunities', discovery);
    expect(opportunityTools.searchFundingOpportunities).toHaveBeenCalledWith(actor, discovery);
    const requirements = {
      clientId: 'client-1',
      source: 'sam_gov',
      sourceRecordId: 'notice-1',
      offset: 25,
      limit: 10,
    };
    await service.execute(actor as never, 'get_funding_opportunity_requirements', requirements);
    expect(opportunityTools.getFundingOpportunityRequirements).toHaveBeenCalledWith(
      actor,
      requirements,
    );
    const body = {
      clientId: 'client-1',
      source: 'grants_gov',
      sourceRecordId: 'grant-1',
      summaryOffset: 1200,
      summaryLimit: 4000,
    };
    await service.execute(actor as never, 'get_funding_opportunity', body);
    expect(opportunityTools.getFundingOpportunity).toHaveBeenCalledWith(actor, body);
  });

  it.each([
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
  ] as const)(
    '%s delegates authorization and handling to the canonical portfolio adapter',
    async (name) => {
      const actor = {
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'standard_user',
      } as const;
      const input = { conversationId: '11111111-1111-4111-8111-111111111111' };
      const execute = jest.fn().mockResolvedValue({ authorized: true });
      const service = Object.assign(Object.create(MeriToolsService.prototype), {
        researchPortfolioTools: { execute },
      }) as MeriToolsService;

      await expect(service.execute(actor as never, name, input)).resolves.toEqual({
        authorized: true,
      });
      expect(execute).toHaveBeenCalledWith(actor, name, input);

      execute.mockRejectedValueOnce(new Error('portfolio scope denied'));
      await expect(service.execute(actor as never, name, input)).rejects.toThrow(
        'portfolio scope denied',
      );
    },
  );

  it('every advertised core schema dispatches to an existing callable handler', async () => {
    const sentinel = { dispatched: true };
    const calls: string[] = [];
    const opportunityMethods = new Set([
      'getFundingOpportunity',
      'explainOpportunityMatch',
      'getOpportunityClientContext',
      'searchFundingOpportunities',
      'getFundingOpportunityRequirements',
      'getOpportunityGovernmentLandscape',
      'compareFundingOpportunities',
      'buildOpportunityActionPlan',
    ]);
    const dispatchOnly = new Proxy(Object.create(MeriToolsService.prototype), {
      get(target, property) {
        if (property === 'prisma')
          return {
            withTenantUser: async () => {
              calls.push('withTenantUser');
              return sentinel;
            },
          };
        if (property === 'contextPlane')
          return {
            searchToolData: async () => {
              calls.push('searchToolData');
              return sentinel;
            },
          };
        if (property === 'opportunityTools') {
          return new Proxy(
            {},
            {
              get(_target, method) {
                if (!opportunityMethods.has(String(method))) return undefined;
                return () => {
                  calls.push(String(method));
                  return sentinel;
                };
              },
            },
          );
        }
        if (property === 'requireBizDevTools') {
          return () => ({
            getContext: () => {
              calls.push('getContext');
              return sentinel;
            },
            getEvidence: () => {
              calls.push('getEvidence');
              return sentinel;
            },
            getBrief: () => {
              calls.push('getBrief');
              return sentinel;
            },
            resolveSource: () => {
              calls.push('resolveSource');
              return sentinel;
            },
            saveBrief: () => {
              calls.push('saveBrief');
              return sentinel;
            },
            getRecentChanges: () => {
              calls.push('getRecentChanges');
              return sentinel;
            },
          });
        }
        if (property === 'requireResearchPortfolioTools') {
          return () => ({
            execute: () => {
              calls.push('researchPortfolioExecute');
              return sentinel;
            },
          });
        }
        if (property === 'districtTools')
          return {
            getContext: () => {
              calls.push('getContext');
              return sentinel;
            },
            getChanges: () => {
              calls.push('getChanges');
              return sentinel;
            },
          };
        const actual = Reflect.get(target, property);
        if (typeof actual !== 'function') return actual;
        return () => {
          calls.push(String(property));
          return sentinel;
        };
      },
    });
    for (const schema of TOOL_DEFINITIONS) {
      calls.length = 0;
      const result = await MeriToolsService.prototype.execute.call(
        dispatchOnly,
        { tenantId: 'tenant-1', userId: 'user-1', role: 'standard_user' } as never,
        schema.name,
        schema.name === 'search_capiro_data'
          ? { query: 'strategy', domains: ['strategies_work'] }
          : schema.name === 'get_research_evidence'
            ? { sessionId: '11111111-1111-4111-8111-111111111111' }
            : schema.name === 'read_chat_attachments'
              ? { conversationId: '11111111-1111-4111-8111-111111111111' }
              : {},
      );
      expect(result).toMatchObject(sentinel);
      expect(calls).toHaveLength(1);
    }
  });

  it('registers exactly the expected tool surface (drop/rename fails loudly)', () => {
    const definedNames = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect([...definedNames].sort()).toEqual([...EXPECTED_TOOLS].sort());
    // No duplicates.
    expect(new Set(definedNames).size).toBe(definedNames.length);
  });

  it('emits one anthropic schema per tool definition (no orphans either way)', () => {
    const toolSchemas = schemas();
    expect(toolSchemas).toHaveLength(TOOL_DEFINITIONS.length);
    expect(toolSchemas.map((schema) => schema.name)).toEqual(
      TOOL_DEFINITIONS.map((tool) => tool.name),
    );
  });

  it('keeps the baseline schema list identical while status provenance is off', () => {
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    const enabled = schemas();
    const baseline = enabled.filter((schema) => schema.name !== 'get_certification_status');
    expect(
      service.anthropicToolSchemas({ tenantId: 'tenant-1', surface: 'chat', env: {} }),
    ).toEqual(baseline);
    expect(enabled.filter((schema) => !baseline.some((item) => item.name === schema.name))).toEqual(
      [expect.objectContaining({ name: 'get_certification_status' })],
    );
    expect(
      service.anthropicToolSchemas({
        tenantId: 'tenant-1',
        surface: 'chat',
        env: {
          MERI_STATUS_PROVENANCE_MODE: 'shadow',
          MERI_STATUS_PROVENANCE_TENANTS: 'all',
          MERI_STATUS_PROVENANCE_SURFACES: 'chat',
        },
      }),
    ).toEqual(baseline);
  });

  it('can independently remove research portfolio tools from the model surface', () => {
    const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    const toolSchemas = service.anthropicToolSchemas({
      tenantId: '11111111-1111-4111-8111-111111111111',
      surface: 'chat',
      env: {
        MERI_STATUS_PROVENANCE_MODE: 'enforce',
        MERI_STATUS_PROVENANCE_TENANTS: 'all',
        MERI_STATUS_PROVENANCE_SURFACES: 'chat',
        RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED: 'false',
      },
    });

    expect(toolSchemas.some((schema) => schema.name === 'get_research_portfolio')).toBe(false);
    expect(toolSchemas.some((schema) => schema.name === 'search_capiro_data')).toBe(true);
    expect(toolSchemas.some((schema) => schema.name === 'get_certification_status')).toBe(true);
  });

  it('legacy read-only chat excludes every side-effecting (write) tool from the model surface', () => {
    const svc = Object.create(MeriToolsService.prototype) as MeriToolsService;
    const writeTools = [
      'prepare_legiwatch_briefing',
      'save_legislative_research',
      'save_legiwatch_relevance',
      'apply_legiwatch_suggestion',
      'send_email',
      'reply_email',
      'update_client_profile',
      'save_note',
      'save_chat_attachments',
      'save_memory',
      'confirm_memory',
      'correct_memory',
      'forget_memory',
      'create_word',
      'create_excel',
      'create_powerpoint',
      'schedule_task',
      'cancel_scheduled_task',
      'create_client',
      'create_task',
      'update_task',
      'create_meeting_brief',
      'draft_policy_memo',
      'save_business_development_brief',
      'create_research_portfolio_snapshot',
      'request_research_portfolio_output',
      'save_research_portfolio_output_to_client',
      'watch_research_portfolio',
      'update_research_portfolio_change_state',
      'create_research_portfolio_bookmark',
      'add_research_portfolio_review_note',
    ];
    // isSideEffecting flags exactly the write tools — and not read/compute tools.
    for (const t of writeTools) expect(svc.isSideEffecting(t)).toBe(true);
    for (const t of [
      'get_client_context',
      'search_congress_bills',
      'run_analysis',
      'query_intelligence',
      'get_business_development_context',
      'get_business_development_evidence',
      'get_business_development_brief',
      'resolve_business_development_source',
      'get_business_development_recent_changes',
    ]) {
      expect(svc.isSideEffecting(t)).toBe(false);
    }
    // The legacy in-process chat's read-only filter (mirrors meri.service.ts)
    // drops ALL side-effecting tools so the model can never select an ungated
    // write, while read/compute tools survive.
    const readOnlySurface = schemas()
      .filter((s) => !svc.isSideEffecting(s.name))
      .map((s) => s.name);
    for (const t of writeTools) expect(readOnlySurface).not.toContain(t);
    expect(readOnlySurface).toContain('get_client_context');
    expect(readOnlySurface).toContain('search_congress_bills');
  });

  it('every schema is a typed object schema with a non-empty description', () => {
    for (const schema of schemas()) {
      expect(schema.description.length).toBeGreaterThan(10);
      expect(schema.input_schema.type).toBe('object');
      expect(schema.input_schema.properties).toBeDefined();
      expect(Array.isArray(schema.input_schema.required)).toBe(true);
    }
  });

  it('enforces required inputs for every tool that has them', () => {
    const byName = new Map(schemas().map((schema) => [schema.name, schema]));
    for (const [tool, required] of Object.entries(REQUIRED_INPUTS)) {
      const schema = byName.get(tool);
      expect(schema).toBeDefined();
      expect([...(schema!.input_schema.required as string[])].sort()).toEqual([...required].sort());
      // Every required field must exist in properties.
      const properties = schema!.input_schema.properties as Record<string, unknown>;
      for (const field of required) {
        expect(properties[field]).toBeDefined();
      }
    }
  });

  it('advertises the same nonempty bounded attachment batch that the filing service accepts', () => {
    const schema = schemas().find((tool) => tool.name === 'save_chat_attachments');
    const properties = schema!.input_schema.properties as Record<string, unknown>;
    expect(properties.attachmentIds).toMatchObject({
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: { type: 'string', minLength: 1 },
    });
  });
  it('advertises exact published-record views on the existing authoritative hearing tool', () => {
    const schema = schemas().find((tool) => tool.name === 'search_committee_hearings')!;
    expect(schema.input_schema.properties).toMatchObject({
      recordsView: { type: 'string' },
      recordId: { type: 'string' },
      asOf: { type: 'string' },
      hearingId: { type: 'string' },
      clientId: { type: 'string' },
    });
    expect(schema.description).toMatch(/published records|published-record/i);
  });

  it('tools without required inputs declare an empty required array', () => {
    for (const schema of schemas()) {
      if (!(schema.name in REQUIRED_INPUTS)) {
        expect(schema.input_schema.required).toEqual([]);
      }
    }
  });

  it('declares conversation scope without asking the model to supply it for business-development tools', () => {
    const byName = new Map(schemas().map((schema) => [schema.name, schema]));
    for (const name of [
      'get_business_development_context',
      'get_business_development_evidence',
      'get_business_development_brief',
      'resolve_business_development_source',
      'save_business_development_brief',
      'get_business_development_recent_changes',
    ]) {
      const schema = byName.get(name)!;
      expect(schema.input_schema.properties).toHaveProperty('conversationId');
      expect(schema.input_schema.required).not.toContain('conversationId');
    }
  });

  it('preserves a confirmed briefing draft link through the governed action summary', async () => {
    const beforeFetch = global.fetch,
      beforeSecret = process.env.INTERNAL_SERVICE_SECRET;
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-internal';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        selectionId: 'selection-1',
        draft: { draftId: 'draft-1', state: 'complete', replayed: true },
      }),
    });
    try {
      const result = await (MeriToolsService.prototype as any).legiwatchTool.call(
        { isSideEffecting: () => true },
        { tenantId: 'tenant-1', clerkUserId: 'owner-1' },
        'prepare_legiwatch_briefing',
        { requestKey: 'same-key' },
      );
      expect(result).toMatchObject({
        documentId: 'draft-1',
        location: '/workspace/draft/draft-1',
        status: 'saved',
        reused: true,
      });
      expect(result.message).toBe('Private briefing draft saved in Workspace.');
    } finally {
      global.fetch = beforeFetch;
      if (beforeSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
      else process.env.INTERNAL_SERVICE_SECRET = beforeSecret;
    }
  });

  it('does not report a saved briefing when the Workspace receipt is missing', async () => {
    const beforeFetch = global.fetch,
      beforeSecret = process.env.INTERNAL_SERVICE_SECRET;
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-internal';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ selectionId: 'selection-1', draftState: 'workspace_not_configured' }),
    });
    try {
      await expect(
        (MeriToolsService.prototype as any).legiwatchTool.call(
          { isSideEffecting: () => true },
          { tenantId: 'tenant-1', clerkUserId: 'owner-1' },
          'prepare_legiwatch_briefing',
          { requestKey: 'same-key' },
        ),
      ).rejects.toThrow('Private briefing draft receipt unavailable');
    } finally {
      global.fetch = beforeFetch;
      if (beforeSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
      else process.env.INTERNAL_SERVICE_SECRET = beforeSecret;
    }
  });
});
