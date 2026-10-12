import type { MeriRetrievalPlan } from '../retrieval/meri-retrieval-plan.js';
import { canonicalizeMeriCompanyResearchPlan } from '../retrieval/meri-retrieval-canonicalization.js';
import {
  MeriSemanticToolGateway,
  type MeriSemanticToolSchema,
} from './meri-semantic-tool-gateway.js';

const schema = (name: string): MeriSemanticToolSchema => ({
  name,
  description: name,
  input_schema: { type: 'object', properties: {} },
});

const schemas = [
  'query_relationship_brief',
  'query_client_changes',
  'query_portfolio_changes',
  'research_external_company',
  'research_federal_market_strategy',
  'query_portfolio_overlap',
  'resolve_entity',
  'lookup_client_registry',
  'search_emails',
  'list_emails',
  'get_email_thread',
  'find_contacts',
  'search_research_sources',
  'search_memory',
  'list_memory_proposals',
  'search_public_web',
  'scrape_web_page',
  'search_federal_awards',
  'search_sam_opportunities',
  'search_federal_grants',
  'search_program_elements',
  'run_analysis',
  'send_email',
  'reply_email',
  'create_word',
  'create_task',
  'update_task',
  'save_memory',
  'save_note',
  'save_chat_attachments',
  'read_client_documents',
  'forget_memory',
  'mcp__hubspot__search_companies',
  'unused_legacy_tool',
].map(schema);

function config(values: Record<string, string | undefined> = {}) {
  return {
    get: jest.fn((key: string) => values[key]),
  } as never;
}

function plan(recipeTool: MeriRetrievalPlan['recipeTool'] = 'query_relationship_brief') {
  return {
    version: 1,
    queryClass: recipeTool === 'research_external_company' ? 'federal_market_analysis' : 'lookup',
    subjectScope: recipeTool?.startsWith('query_portfolio') ? 'portfolio' : 'external_entity',
    targetHint: 'Victory Six',
    recipeTool,
    requireCompleteCoverage: Boolean(recipeTool),
    requiredDomains: [],
    optionalDomains: [],
    recommendedTools: [],
    timeWindow: null,
    activeClients: [],
    reasons: [],
  } satisfies MeriRetrievalPlan;
}

describe('MeriSemanticToolGateway', () => {
  test.each(['Does Aster prefer text alerts?', 'Show my pending Institutional Memory proposals.'])(
    'exposes approved recall and the distinct pending reader for %s',
    (request) => {
      const gateway = new MeriSemanticToolGateway(
        config({
          MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
          MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: '*',
        }),
      );
      const selected = gateway.select({ schemas, tenantId: 'tenant-1', request, plan: plan(null) });
      expect(selected.decision.exposedNames).toEqual(
        expect.arrayContaining(['search_memory', 'list_memory_proposals']),
      );
    },
  );
  test('exposes canonical document generation for a PDF-only request', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: '*',
      }),
    );
    const selected = gateway.select({
      schemas,
      tenantId: 'tenant-1',
      request: 'Make a PDF.',
      plan: plan(null),
    });
    expect(selected.decision.exposedNames).toContain('create_word');
  });
  test.each([
    'Please find the attached documents. Save this information in Sightline Intelligence.',
    'Save these files under Sightline.',
    'Ingest the uploaded documents into the selected client record.',
  ])('keeps the client attachment filing tool in the enabled surface: %s', (request) => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const selected = gateway.select({ schemas, tenantId: 'tenant-1', request, plan: plan(null) });
    expect(selected.decision.exposedNames).toEqual(
      expect.arrayContaining([
        'save_chat_attachments',
        'lookup_client_registry',
        'read_client_documents',
      ]),
    );
  });

  test('a follow-up retains attachment filing from recent user context', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const selected = gateway.select({
      schemas,
      tenantId: 'tenant-1',
      request: 'Yes, save them there.',
      recentUserContext: 'Here are the attached documents for Sightline Intelligence.',
      plan: plan(null),
    });
    expect(selected.decision.exposedNames).toContain('save_chat_attachments');
  });

  test.each([
    'Send it to the client profile.',
    'Send Strat Discussion.pptx to the client profile.',
    'Save the doc under the selected client.',
    'Upload this document to the selected profile.',
    'Upload it to their Files tab.',
    'Put these attachments in their Files tab.',
    'Add the PDF to this client’s profile.',
  ])('exposes original-file saving for a profile filing request: %s', (request) => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const selected = gateway.select({ schemas, tenantId: 'tenant-1', request, plan: plan(null) });
    expect(selected.decision.mode).toBe('enabled');
    expect(selected.decision.fallbackToLegacy).toBe(false);
    expect(selected.decision.exposedNames).toEqual(
      expect.arrayContaining([
        'save_chat_attachments',
        'lookup_client_registry',
        'read_client_documents',
      ]),
    );
  });

  test.each([
    'Send the email to Jordan.',
    'Send the attachments to Jordan by email.',
    'Read the document in the client profile.',
    'Show the Files tab for this client.',
    'Read the uploaded document and draft a reply.',
  ])('does not offer client filing for unrelated email or read requests: %s', (request) => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const selected = gateway.select({ schemas, tenantId: 'tenant-1', request, plan: plan(null) });
    expect(selected.decision.exposedNames).not.toContain('save_chat_attachments');
    if (/^Send/.test(request)) expect(selected.decision.exposedNames).toContain('send_email');
  });

  test.each([
    'For client Sightline I want to log the notes from the Sen Wyden Engagement.',
    'How should I file my notes under Sightline?',
    'These notes should be saved under the selected client. Please save them.',
  ])('makes the note-writing path available for client filing language: %s', (request) => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const selected = gateway.select({ schemas, tenantId: 'tenant-1', request, plan: plan(null) });
    expect(selected.decision.exposedNames).toEqual(
      expect.arrayContaining(['save_note', 'lookup_client_registry']),
    );
  });

  test('reading an attachment does not itself select a client write', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const selected = gateway.select({
      schemas,
      tenantId: 'tenant-1',
      request: 'Read the attached letter and draft a response.',
      plan: plan(null),
    });
    expect(selected.decision.exposedNames).not.toContain('save_chat_attachments');
  });

  test.each([
    'Recommend opportunities for this client',
    'Assess grant eligibility',
    'Review procurement forecasts',
  ])('exposes canonical funding inputs through the enabled runtime: %s', (request) => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const fundingSchemas = [
      'search_funding_opportunities',
      'get_funding_opportunity',
      'get_funding_opportunity_requirements',
      'search_procurement_forecasts',
    ].map(schema);
    const selected = gateway.select({
      schemas: [...schemas, ...fundingSchemas],
      tenantId: 'tenant-1',
      request,
      plan: {
        ...plan('research_federal_market_strategy'),
        subjectScope: 'client',
        requiredDomains: ['opportunities'],
      },
    });
    expect(selected.decision.mode).toBe('enabled');
    expect(selected.decision.exposedNames).toEqual(
      expect.arrayContaining(fundingSchemas.map((item) => item.name)),
    );
  });

  test('defaults closed and preserves the governed legacy schema surface', () => {
    const gateway = new MeriSemanticToolGateway(config());
    const selected = gateway.select({
      schemas,
      tenantId: 'tenant-1',
      request: 'Tell me everything about Victory Six',
      plan: plan(),
    });

    expect(selected.decision.mode).toBe('legacy');
    expect(selected.schemas.map((item) => item.name)).toEqual(schemas.map((item) => item.name));
  });

  test('shadow mode proposes a narrow set while leaving behavior unchanged', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_SHADOW: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const selected = gateway.select({
      schemas,
      tenantId: 'tenant-1',
      request: 'Tell me everything about Victory Six',
      plan: plan(),
    });

    expect(selected.decision.mode).toBe('shadow');
    expect(selected.schemas).toHaveLength(schemas.length);
    expect(selected.decision.proposedNames).toEqual(
      expect.arrayContaining(['query_relationship_brief', 'resolve_entity', 'search_emails']),
    );
    expect(selected.decision.proposedNames).not.toContain('unused_legacy_tool');
    expect(selected.decision.proposedNames.length).toBeLessThanOrEqual(20);
  });

  test('enabled mode exposes only the semantic proposal for an allowlisted tenant', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const selected = gateway.select({
      schemas,
      tenantId: 'tenant-1',
      request: 'What changed across my clients this week?',
      plan: plan('query_portfolio_changes'),
    });

    expect(selected.decision.mode).toBe('enabled');
    expect(selected.schemas.map((item) => item.name)).toEqual(selected.decision.proposedNames);
    expect(selected.decision.exposedNames).toContain('query_portfolio_changes');
    expect(selected.decision.exposedNames).not.toContain('unused_legacy_tool');
  });

  test('quick company profiles stay bounded even when canonical Research Director is enabled', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
        MERI_RESEARCH_DIRECTOR_CANONICAL_ENABLED: 'true',
        MERI_RESEARCH_DIRECTOR_CANONICAL_TENANTS: 'tenant-1',
      }),
    );
    const quickPlan: MeriRetrievalPlan = {
      ...plan('research_external_company'),
      queryClass: 'lookup',
      requiredDomains: ['public_web'],
      optionalDomains: ['clients', 'internal_research'],
      reasons: ['recipe:research_external_company', 'quick-company-profile'],
    };
    const canonicalPlan = canonicalizeMeriCompanyResearchPlan(quickPlan, true);
    const selected = gateway.select({
      schemas,
      tenantId: 'tenant-1',
      request: 'What does Overland AI do?',
      plan: canonicalPlan,
    });

    expect(canonicalPlan.recipeTool).toBe('research_external_company');
    expect(selected.decision.exposedNames).toEqual(
      expect.arrayContaining([
        'research_external_company',
        'lookup_client_registry',
        'search_research_sources',
        'search_public_web',
        'scrape_web_page',
      ]),
    );
    for (const forbidden of [
      'research_federal_market_strategy',
      'resolve_entity',
      'search_federal_awards',
      'search_sam_opportunities',
      'search_federal_grants',
      'search_program_elements',
      'run_analysis',
    ]) {
      expect(selected.decision.exposedNames).not.toContain(forbidden);
    }
  });

  test('mailbox history exposes mail support but no external-company or federal-market lanes', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const mailPlan: MeriRetrievalPlan = {
      ...plan('query_relationship_brief'),
      queryClass: 'relationship_history',
      requiredDomains: ['mail'],
      optionalDomains: ['contacts', 'memory', 'internal_research'],
      reasons: ['recipe:query_relationship_brief', 'mail-history-focus'],
    };
    const selected = gateway.select({
      schemas,
      tenantId: 'tenant-1',
      request: 'Tell me my email history with C2 Strategies',
      plan: mailPlan,
    });

    expect(selected.decision.exposedNames).toEqual(
      expect.arrayContaining([
        'query_relationship_brief',
        'search_emails',
        'list_emails',
        'get_email_thread',
        'find_contacts',
        'search_memory',
        'lookup_client_registry',
      ]),
    );
    for (const forbidden of [
      'resolve_entity',
      'search_research_sources',
      'search_public_web',
      'scrape_web_page',
      'search_federal_awards',
      'search_sam_opportunities',
      'search_federal_grants',
      'search_program_elements',
      'research_external_company',
      'research_federal_market_strategy',
    ]) {
      expect(selected.decision.exposedNames).not.toContain(forbidden);
    }
  });

  test('the Research Director flag replaces the old model-facing company reasoning path', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
        MERI_RESEARCH_DIRECTOR_CANONICAL_ENABLED: 'true',
        MERI_RESEARCH_DIRECTOR_CANONICAL_TENANTS: 'tenant-1',
      }),
    );
    const basePlan = plan('research_external_company');
    const canonicalPlan = canonicalizeMeriCompanyResearchPlan(basePlan, true);
    const selected = gateway.select({
      schemas,
      tenantId: 'tenant-1',
      request: 'Tell me what federal programs Kinetic Industries should pursue',
      plan: canonicalPlan,
    });

    expect(canonicalPlan.recipeTool).toBe('research_federal_market_strategy');
    expect(selected.decision.canonicalResearchDirector).toBe(true);
    expect(selected.decision.exposedNames).toContain('research_federal_market_strategy');
    expect(selected.decision.exposedNames).not.toContain('research_external_company');
  });

  test('recent conversation context keeps governed action tools available for terse follow-ups', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const selected = gateway.select({
      schemas,
      tenantId: 'tenant-1',
      request: 'Do it',
      recentUserContext: 'Draft the email and send it to the client\nDo it',
      plan: plan(null),
    });

    expect(selected.decision.exposedNames).toEqual(
      expect.arrayContaining(['search_emails', 'send_email', 'reply_email']),
    );
  });

  test('connected-app schemas are exposed only when the request names the connected app', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const selected = gateway.select({
      schemas,
      tenantId: 'tenant-1',
      request: 'Look up the company in HubSpot',
      plan: plan(null),
    });

    expect(selected.decision.exposedNames).toContain('mcp__hubspot__search_companies');
  });

  test('a tenant outside the allowlist cannot enable the reduced surface', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-2',
      }),
    );
    const selected = gateway.select({
      schemas,
      tenantId: 'tenant-1',
      request: 'Tell me everything about Victory Six',
      plan: plan(),
    });

    expect(selected.decision.mode).toBe('legacy');
    expect(selected.schemas).toHaveLength(schemas.length);
  });

  test('enabled mode fails safe to legacy when no semantic schema exists', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: '*',
      }),
    );
    const onlyUnknown = [schema('unused_legacy_tool')];
    const selected = gateway.select({
      schemas: onlyUnknown,
      tenantId: 'tenant-1',
      request: 'Hello',
      plan: plan(null),
    });

    expect(selected.decision.fallbackToLegacy).toBe(true);
    expect(selected.schemas).toEqual(onlyUnknown);
  });

  test('protects every authorized required capability without recreating unavailable names', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const selected = gateway.select({
      schemas: [schema('get_bill_status'), schema('read_client_documents')],
      tenantId: 'tenant-1',
      request: 'Hello',
      plan: plan(null),
      protectedNames: ['get_bill_status', 'read_client_documents', 'excluded_write_tool'],
    });

    expect(selected.decision.requestedNames).toEqual(
      expect.arrayContaining(['get_bill_status', 'read_client_documents', 'excluded_write_tool']),
    );
    expect(selected.decision.selectedNames).toEqual(['get_bill_status', 'read_client_documents']);
    expect(selected.decision.exposedNames).not.toContain('excluded_write_tool');
  });

  test('bounds fallback discovery and intersects it with the live authorized surface', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
      }),
    );
    const live = Array.from({ length: 12 }, (_, index) => schema(`known_${index}`));
    const selected = gateway.select({
      schemas: live,
      tenantId: 'tenant-1',
      request: 'Hello',
      plan: plan(null),
      discoveryNames: [...live.map((item) => item.name), 'unknown_leaf_name'],
    });

    expect(
      selected.decision.selectedNames.filter((name) => name.startsWith('known_')),
    ).toHaveLength(8);
    expect(selected.decision.exposedNames).not.toContain('unknown_leaf_name');
  });

  test('native selection can explicitly decline the skipped Research Director route', () => {
    const gateway = new MeriSemanticToolGateway(
      config({
        MERI_SEMANTIC_TOOL_GATEWAY_ENABLED: 'true',
        MERI_SEMANTIC_TOOL_GATEWAY_TENANTS: 'tenant-1',
        MERI_RESEARCH_DIRECTOR_CANONICAL_ENABLED: 'true',
        MERI_RESEARCH_DIRECTOR_CANONICAL_TENANTS: 'tenant-1',
      }),
    );
    const selected = gateway.select({
      schemas,
      tenantId: 'tenant-1',
      request: 'Research Victory Six.',
      plan: plan('research_external_company'),
      allowCanonicalResearchDirector: false,
    });

    expect(selected.decision.canonicalResearchDirector).toBe(false);
    expect(selected.decision.exposedNames).not.toContain('research_federal_market_strategy');
  });
});
