import { ConfigService } from '@nestjs/config';
import type { MeriRetrievalDomain, MeriRetrievalPlan } from '../retrieval/meri-retrieval-plan.js';
import type {
  MeriSemanticGatewayDecision,
  MeriSemanticGatewayMode,
} from './meriv3-semantic-runtime.store.js';

export interface MeriSemanticToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface MeriSemanticToolSelection {
  schemas: MeriSemanticToolSchema[];
  decision: MeriSemanticGatewayDecision;
}

export interface MeriSemanticToolSelectionInput {
  schemas: MeriSemanticToolSchema[];
  tenantId: string;
  request: string;
  recentUserContext?: string;
  plan: MeriRetrievalPlan;
}

const MAX_MODEL_FACING_TOOLS = 20;

const RECIPE_SUPPORT: Record<string, readonly string[]> = {
  query_relationship_brief: [
    'resolve_entity',
    'search_emails',
    'search_research_sources',
    'search_memory',
  ],
  query_client_changes: [
    'get_client_context',
    'search_client_knowledge',
    'search_research_sources',
  ],
  query_portfolio_changes: ['search_research_sources', 'query_intelligence'],
  research_external_company: [
    'resolve_entity',
    'search_public_web',
    'scrape_web_page',
    'search_federal_awards',
    'search_sam_opportunities',
    'search_federal_grants',
    'search_program_elements',
    'run_analysis',
  ],
  research_federal_market_strategy: [
    'resolve_entity',
    'search_public_web',
    'scrape_web_page',
    'run_analysis',
  ],
  query_portfolio_overlap: [
    'resolve_entity',
    'search_public_web',
    'scrape_web_page',
    'run_analysis',
  ],
};

const MAIL_HISTORY_SUPPORT = [
  'search_emails',
  'find_contacts',
  'search_memory',
  'lookup_client_registry',
] as const;

const QUICK_COMPANY_PROFILE_SUPPORT = [
  'lookup_client_registry',
  'search_research_sources',
  'search_public_web',
  'scrape_web_page',
] as const;

function supportForPlan(plan: MeriRetrievalPlan, recipe: string): readonly string[] {
  if (plan.reasons.includes('mail-history-focus')) return MAIL_HISTORY_SUPPORT;
  if (plan.reasons.includes('quick-company-profile')) return QUICK_COMPANY_PROFILE_SUPPORT;
  return RECIPE_SUPPORT[recipe] ?? [];
}

const DOMAIN_SUPPORT: Partial<Record<MeriRetrievalDomain, readonly string[]>> = {
  identity: ['resolve_entity'],
  clients: ['get_client_context', 'search_client_knowledge'],
  internal_research: ['search_research_sources'],
  documents: ['read_client_documents', 'search_client_knowledge'],
  mail: ['search_emails', 'list_emails'],
  contacts: ['find_contacts'],
  meetings: ['list_upcoming_meetings', 'query_debriefs'],
  tasks: ['query_tasks', 'list_scheduled_tasks'],
  action_items: ['query_action_items'],
  outreach: ['query_outreach'],
  memory: ['search_memory'],
  legislation: [
    'search_congress_bills',
    'get_bill_status',
    'search_floor_votes',
    'search_state_bills',
    'get_state_bill_status',
  ],
  hearings: ['search_committee_hearings'],
  regulatory: ['query_regulatory_dockets', 'get_state_rule_status'],
  directory: ['list_members', 'get_committee_roster', 'search_acquisition_personnel'],
  intelligence: ['query_intelligence', 'search_intel_articles'],
  economic: ['query_economic_data'],
  budget: ['search_program_elements', 'get_program_element', 'get_pe_budget_timeline'],
  opportunities: [
    'search_funding_opportunities',
    'get_funding_opportunity',
    'get_funding_opportunity_requirements',
    'search_procurement_forecasts',
    'search_sam_opportunities',
  ],
  awards: ['search_federal_awards'],
  grants: ['search_funding_opportunities', 'get_funding_opportunity', 'search_federal_grants'],
  registries: ['search_lda_filings', 'search_sec_filings', 'search_fara_registrations'],
  public_web: ['search_public_web', 'scrape_web_page'],
};

const ACTION_RULES: ReadonlyArray<{ pattern: RegExp; tools: readonly string[] }> = [
  {
    pattern: /\b(?:send|email|reply|respond)\b/i,
    tools: ['search_emails', 'send_email', 'reply_email'],
  },
  {
    pattern: /\b(?:word|docx|document|memo|briefing|report)\b/i,
    tools: ['create_artifact', 'create_word', 'draft_policy_memo', 'create_meeting_brief'],
  },
  {
    pattern: /\b(?:excel|xlsx|spreadsheet|workbook)\b/i,
    tools: ['create_artifact', 'create_excel'],
  },
  {
    pattern: /\b(?:powerpoint|pptx|slide\s*deck|presentation|deck)\b/i,
    tools: ['create_artifact', 'create_powerpoint'],
  },
  {
    pattern: /\b(?:meeting\s+brief|prep\s+me\s+for|upcoming\s+meeting)\b/i,
    tools: ['list_upcoming_meetings', 'create_artifact', 'create_meeting_brief'],
  },
  {
    pattern:
      /\b(?:create|add|update|complete|close|mark|schedule|cancel)\b.{0,30}\b(?:task|follow[- ]?up|to[- ]?do)\b|\b(?:task|follow[- ]?up|to[- ]?do)\b.{0,30}\b(?:create|add|update|complete|close|mark|schedule|cancel)\b/i,
    tools: [
      'query_tasks',
      'list_scheduled_tasks',
      'create_task',
      'update_task',
      'schedule_task',
      'cancel_scheduled_task',
    ],
  },
  {
    pattern: /\b(?:remember|memory|forget|forgot|correct what you remember|still right)\b/i,
    tools: ['search_memory', 'save_memory', 'confirm_memory', 'correct_memory', 'forget_memory'],
  },
  {
    pattern: /\b(?:save|record|add)\b.{0,20}\bnote\b/i,
    tools: ['save_note'],
  },
  {
    pattern: /\b(?:create|add|onboard)\b.{0,20}\bclient\b/i,
    tools: ['lookup_client_registry', 'create_client'],
  },
  {
    pattern: /\b(?:update|edit|enrich|fill|change)\b.{0,30}\bclient\b|\bclient\s+profile\b/i,
    tools: ['get_client_context', 'update_client_profile'],
  },
];

const TOPIC_RULES: ReadonlyArray<{ pattern: RegExp; tools: readonly string[] }> = [
  {
    pattern:
      /\b(?:funding|grants?|nofo|opportunit(?:y|ies)|solicitations?|sam\.gov|sources\s+sought|procurement|forecasts?)\b/i,
    tools: [
      'search_funding_opportunities',
      'get_funding_opportunity_requirements',
      'search_procurement_forecasts',
      'search_federal_grants',
      'search_sam_opportunities',
      'get_funding_opportunity',
      'analyze_funding_opportunity',
    ],
  },
  {
    pattern:
      /\b(?:program\s+element|procurement\s+line|budget\s+line|r-?1|r-?2|p-?1|p-?40|fy\d{2})\b/i,
    tools: [
      'search_program_elements',
      'get_program_element',
      'get_pe_budget_timeline',
      'get_pe_report_language',
      'get_pe_contractors',
      'get_pe_bills',
    ],
  },
  {
    pattern: /\b(?:bill|legislation|legislative|congress|committee|markup|floor\s+vote|hearing)\b/i,
    tools: [
      'resolve_entity',
      'search_congress_bills',
      'get_bill_status',
      'search_floor_votes',
      'search_committee_hearings',
      'get_committee_roster',
      'list_members',
    ],
  },
  {
    pattern: /\b(?:state\s+bill|state\s+legisl|governor|state\s+rule)\b/i,
    tools: [
      'search_state_bills',
      'get_state_bill_status',
      'search_state_floor_votes',
      'get_state_legislator',
      'get_state_rule_status',
    ],
  },
  {
    pattern: /\b(?:award|contractor|usaspending|obligation|federal\s+spending)\b/i,
    tools: ['search_federal_awards', 'search_sam_opportunities'],
  },
  {
    pattern: /\b(?:inbox|mail|email|correspondence|thread)\b/i,
    tools: ['search_emails', 'list_emails', 'find_contacts'],
  },
  {
    pattern: /\b(?:web|internet|website|online|latest|recent|news)\b/i,
    tools: ['search_public_web', 'scrape_web_page', 'search_intel_articles'],
  },
  {
    pattern: /\b(?:analy[sz]e|compare|rank|trend|chart|graph|visual|scenario|calculate)\b/i,
    tools: ['run_analysis'],
  },
];

function parseList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function addAvailable(
  bucket: string[],
  names: readonly string[],
  available: ReadonlySet<string>,
): void {
  for (const name of names) {
    if (available.has(name) && !bucket.includes(name)) bucket.push(name);
  }
}

/**
 * Narrows the OpenAI-facing schema set while preserving the governed registry
 * and every backend capability. In shadow mode it only calculates and logs the
 * proposed set; in enabled mode it exposes that set for an allowlisted tenant.
 */
export class MeriSemanticToolGateway {
  constructor(private readonly config: ConfigService) {}

  modeForTenant(tenantId: string): MeriSemanticGatewayMode {
    if (!this.gatewayTenantAllowed(tenantId)) return 'legacy';
    if (this.flag('MERI_SEMANTIC_TOOL_GATEWAY_ENABLED')) return 'enabled';
    if (this.flag('MERI_SEMANTIC_TOOL_GATEWAY_SHADOW')) return 'shadow';
    return 'legacy';
  }

  canonicalResearchDirectorEnabled(tenantId: string): boolean {
    if (!this.flag('MERI_RESEARCH_DIRECTOR_CANONICAL_ENABLED')) return false;
    const configured = this.config.get<string>('MERI_RESEARCH_DIRECTOR_CANONICAL_TENANTS');
    const allowlist = parseList(
      configured ?? this.config.get<string>('MERI_SEMANTIC_TOOL_GATEWAY_TENANTS'),
    );
    const normalized = tenantId.trim().toLowerCase();
    return allowlist.has('*') || allowlist.has(normalized);
  }

  select(input: MeriSemanticToolSelectionInput): MeriSemanticToolSelection {
    const legacyNames = unique(input.schemas.map((schema) => schema.name));
    const available = new Set(legacyNames);
    const mode = this.modeForTenant(input.tenantId);
    const canonicalResearchDirector = this.canonicalResearchDirectorEnabled(input.tenantId);
    const critical: string[] = [];
    const support: string[] = [];
    const requestContext = [input.recentUserContext, input.request].filter(Boolean).join('\n');

    let recipe = input.plan.recipeTool;
    if (
      canonicalResearchDirector &&
      recipe === 'research_external_company' &&
      !input.plan.reasons.includes('quick-company-profile')
    ) {
      recipe = 'research_federal_market_strategy';
    }
    if (recipe) addAvailable(critical, [recipe], available);
    if (recipe) addAvailable(support, supportForPlan(input.plan, recipe), available);

    if (!recipe) {
      const domains = unique([
        ...input.plan.requiredDomains,
        ...input.plan.optionalDomains,
      ]) as MeriRetrievalDomain[];
      for (const domain of domains) addAvailable(support, DOMAIN_SUPPORT[domain] ?? [], available);

      if (input.plan.subjectScope === 'client') {
        addAvailable(support, ['get_client_context', 'search_client_knowledge'], available);
      } else if (input.plan.subjectScope === 'portfolio') {
        addAvailable(support, ['search_research_sources', 'query_intelligence'], available);
      } else if (input.plan.subjectScope === 'external_entity') {
        addAvailable(
          support,
          ['resolve_entity', 'search_public_web', 'scrape_web_page'],
          available,
        );
      } else {
        addAvailable(
          support,
          ['search_research_sources', 'query_intelligence', 'resolve_entity'],
          available,
        );
      }
    }

    for (const rule of ACTION_RULES) {
      if (rule.pattern.test(requestContext)) addAvailable(critical, rule.tools, available);
    }
    for (const rule of TOPIC_RULES) {
      if (rule.pattern.test(requestContext)) addAvailable(support, rule.tools, available);
    }

    if (/\b(?:hubspot|airtable|connected\s+app|crm\s+record)\b/i.test(requestContext)) {
      addAvailable(
        critical,
        legacyNames.filter((name) => name.startsWith('mcp__')),
        available,
      );
    }

    if (canonicalResearchDirector) {
      const oldIndex = critical.indexOf('research_external_company');
      if (oldIndex >= 0 && recipe === 'research_federal_market_strategy')
        critical.splice(oldIndex, 1);
      const supportIndex = support.indexOf('research_external_company');
      if (supportIndex >= 0 && recipe === 'research_federal_market_strategy') {
        support.splice(supportIndex, 1);
      }
    }

    const proposedNames = unique([...critical, ...support]).slice(0, MAX_MODEL_FACING_TOOLS);
    const schemaByName = new Map(input.schemas.map((schema) => [schema.name, schema]));
    const proposedSchemas = proposedNames
      .map((name) => schemaByName.get(name))
      .filter((schema): schema is MeriSemanticToolSchema => Boolean(schema));

    const fallbackToLegacy =
      mode === 'enabled' && proposedSchemas.length === 0 && input.schemas.length > 0;
    const fallbackReason = fallbackToLegacy
      ? 'The semantic router selected no registered schema, so the governed legacy surface was retained.'
      : null;
    const exposedSchemas =
      mode === 'enabled' && !fallbackToLegacy ? proposedSchemas : input.schemas;
    const exposedNames = unique(exposedSchemas.map((schema) => schema.name));
    const proposedSet = new Set(proposedNames);
    const removedNames = legacyNames.filter((name) => !proposedSet.has(name));

    return {
      schemas: exposedSchemas,
      decision: {
        mode,
        legacyNames,
        proposedNames,
        exposedNames,
        removedNames,
        fallbackToLegacy,
        fallbackReason,
        canonicalResearchDirector,
      },
    };
  }

  private flag(name: string): boolean {
    return this.config.get<string>(name)?.trim().toLowerCase() === 'true';
  }

  private gatewayTenantAllowed(tenantId: string): boolean {
    const allowlist = parseList(this.config.get<string>('MERI_SEMANTIC_TOOL_GATEWAY_TENANTS'));
    const normalized = tenantId.trim().toLowerCase();
    return allowlist.has('*') || allowlist.has(normalized);
  }
}
