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
  'search_emails',
  'search_research_sources',
  'search_memory',
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
});
