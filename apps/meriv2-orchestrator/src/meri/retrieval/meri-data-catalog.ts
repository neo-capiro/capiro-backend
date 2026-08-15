import type {
  MeriRetrievalDomain,
  MeriRetrievalRecipeTool,
} from './meri-retrieval-plan.js';

export type MeriCatalogEntityType =
  | 'client'
  | 'company'
  | 'person'
  | 'meeting'
  | 'message'
  | 'task'
  | 'action_item'
  | 'outreach'
  | 'document'
  | 'bill'
  | 'hearing'
  | 'committee'
  | 'office'
  | 'regulatory_record'
  | 'intel_record'
  | 'economic_record'
  | 'program_element'
  | 'opportunity'
  | 'award'
  | 'grant'
  | 'memory'
  | 'registry_record'
  | 'web_document';

export interface MeriDatasetCapabilities {
  exactFiltering: boolean;
  dateRange: boolean;
  pagination: boolean;
  exhaustiveScan: boolean;
  semanticSearch: boolean;
}

export interface MeriDatasetDefinition {
  id: string;
  description: string;
  domains: MeriRetrievalDomain[];
  entities: MeriCatalogEntityType[];
  tools: string[];
  timeSemantics: {
    occurredAt?: string[];
    changedAt?: string[];
    deadlineAt?: string[];
  };
  capabilities: MeriDatasetCapabilities;
  authority: string[];
  scope: 'tenant' | 'tenant_and_client' | 'public';
}

export interface MeriToolCatalogEntry {
  domains: MeriRetrievalDomain[];
  exhaustive: boolean;
  datasetIds: string[];
}

export interface MeriRecipeCatalogEntry {
  tool: MeriRetrievalRecipeTool;
  description: string;
  requiredDomains: MeriRetrievalDomain[];
  optionalDomains: MeriRetrievalDomain[];
  recommendedTools: string[];
}

const caps = (
  exactFiltering: boolean,
  semanticSearch: boolean,
  options: Partial<Pick<MeriDatasetCapabilities, 'dateRange' | 'pagination' | 'exhaustiveScan'>> = {},
): MeriDatasetCapabilities => ({
  exactFiltering,
  semanticSearch,
  dateRange: options.dateRange ?? false,
  pagination: options.pagination ?? false,
  exhaustiveScan: options.exhaustiveScan ?? false,
});

export const MERI_DATASET_CATALOG: MeriDatasetDefinition[] = [
  {
    id: 'client_portfolio',
    description: 'Authorized Capiro client roster and structured client profile context.',
    domains: ['clients', 'internal_research'],
    entities: ['client', 'company', 'person'],
    tools: ['get_client_context', 'search_client_knowledge', 'search_research_sources'],
    timeSemantics: { changedAt: ['updatedAt'] },
    capabilities: caps(true, true),
    authority: ['client identity', 'client profile', 'client capabilities', 'client strategies'],
    scope: 'tenant_and_client',
  },
  {
    id: 'client_documents',
    description: 'Authorized client document inventory and extracted document text.',
    domains: ['documents', 'internal_research'],
    entities: ['document', 'client', 'company'],
    tools: ['read_client_documents', 'search_client_knowledge'],
    timeSemantics: { occurredAt: ['createdAt'], changedAt: ['updatedAt', 'indexedAt'] },
    capabilities: caps(true, true),
    authority: ['client-supplied document content', 'document provenance'],
    scope: 'tenant_and_client',
  },
  {
    id: 'mail_messages',
    description:
      'Synchronized Microsoft 365 and Google Workspace message records. search_emails provides an exact match count but no continuation cursor when matches exceed its result limit.',
    domains: ['mail'],
    entities: ['message', 'person', 'company', 'client'],
    tools: ['search_emails', 'list_emails'],
    timeSemantics: { occurredAt: ['sentAt', 'receivedAt'], changedAt: ['updatedAt'] },
    capabilities: caps(true, false),
    authority: ['communication occurrence', 'participants', 'message content', 'thread chronology'],
    scope: 'tenant',
  },
  {
    id: 'contacts',
    description: 'Authorized synchronized and CRM contact identities.',
    domains: ['contacts', 'identity'],
    entities: ['person', 'company', 'client'],
    tools: ['find_contacts'],
    timeSemantics: { changedAt: ['updatedAt', 'lastContactAt'] },
    capabilities: caps(true, false),
    authority: ['contact identity', 'email address', 'known organization association'],
    scope: 'tenant',
  },
  {
    id: 'meetings_and_debriefs',
    description: 'Upcoming meetings, completed meetings, notes and debrief records.',
    domains: ['meetings'],
    entities: ['meeting', 'person', 'company', 'client'],
    tools: ['list_upcoming_meetings', 'query_debriefs'],
    timeSemantics: {
      occurredAt: ['startsAt', 'endedAt', 'occurredAt'],
      changedAt: ['updatedAt'],
    },
    capabilities: caps(true, false),
    authority: ['meeting occurrence', 'meeting participants', 'debrief content'],
    scope: 'tenant_and_client',
  },
  {
    id: 'engagement_tasks',
    description: 'Firm tasks, commitments and execution deadlines.',
    domains: ['tasks'],
    entities: ['task', 'client', 'person', 'company'],
    tools: ['query_tasks'],
    timeSemantics: {
      occurredAt: ['createdAt'],
      changedAt: ['updatedAt', 'completedAt'],
      deadlineAt: ['dueDate'],
    },
    capabilities: caps(true, false),
    authority: ['task status', 'task owner', 'task deadline'],
    scope: 'tenant_and_client',
  },
  {
    id: 'action_items',
    description: 'Needs Attention and action-recommendation records.',
    domains: ['action_items'],
    entities: ['action_item', 'client'],
    tools: ['query_action_items'],
    timeSemantics: {
      occurredAt: ['createdAt'],
      changedAt: ['updatedAt'],
      deadlineAt: ['deadline'],
    },
    capabilities: caps(true, false),
    authority: ['action-item status', 'priority', 'recommended action'],
    scope: 'tenant_and_client',
  },
  {
    id: 'outreach',
    description: 'Outreach campaigns, recipients, sends and response state.',
    domains: ['outreach'],
    entities: ['outreach', 'client', 'person'],
    tools: ['query_outreach'],
    timeSemantics: { occurredAt: ['sentAt', 'createdAt'], changedAt: ['updatedAt'] },
    capabilities: caps(true, false),
    authority: ['outreach status', 'recipient count', 'send occurrence'],
    scope: 'tenant_and_client',
  },
  {
    id: 'institutional_memory',
    description:
      'Curated tenant/client/user memories used as contextual nuance, not live operational truth.',
    domains: ['memory'],
    entities: ['memory', 'client', 'company', 'person'],
    tools: ['search_memory'],
    timeSemantics: { changedAt: ['updatedAt', 'confirmedAt'] },
    capabilities: caps(false, true),
    authority: ['firm preferences', 'relationship nuance', 'historical context'],
    scope: 'tenant_and_client',
  },
  {
    id: 'tracked_legislation',
    description: 'Authorized client-linked tracked bills and current legislative state.',
    domains: ['legislation'],
    entities: ['bill', 'client'],
    tools: ['search_tracked_bills', 'search_congress_bills', 'search_state_bills'],
    timeSemantics: { occurredAt: ['latestActionDate', 'actionDate'], changedAt: ['updatedAt'] },
    capabilities: caps(true, true),
    authority: ['bill identity', 'bill stage', 'legislative actions'],
    scope: 'tenant_and_client',
  },
  {
    id: 'committee_hearings',
    description: 'Congressional committee hearing records and schedules.',
    domains: ['hearings'],
    entities: ['hearing', 'committee'],
    tools: ['search_committee_hearings'],
    timeSemantics: { occurredAt: ['date', 'startsAt'], changedAt: ['updatedAt'] },
    capabilities: caps(true, true),
    authority: ['hearing identity', 'committee', 'hearing date'],
    scope: 'public',
  },
  {
    id: 'government_directory',
    description:
      'Congressional committee rosters, member rosters, representation and acquisition personnel.',
    domains: ['directory', 'identity'],
    entities: ['person', 'committee', 'office', 'client', 'program_element'],
    tools: [
      'get_committee_roster',
      'list_members',
      'get_representation',
      'search_acquisition_personnel',
      'get_acquisition_person',
    ],
    timeSemantics: { changedAt: ['updatedAt'] },
    capabilities: caps(true, true),
    authority: [
      'government identity',
      'committee membership',
      'representation',
      'acquisition role',
    ],
    scope: 'public',
  },
  {
    id: 'regulatory_dockets',
    description: 'Federal/state regulatory docket and rule lifecycle records.',
    domains: ['regulatory'],
    entities: ['regulatory_record'],
    tools: ['query_regulatory_dockets', 'get_state_rule_status'],
    timeSemantics: {
      occurredAt: ['publishedAt', 'effectiveAt'],
      changedAt: ['updatedAt'],
      deadlineAt: ['commentDeadline'],
    },
    capabilities: caps(true, true),
    authority: ['rule identity', 'lifecycle stage', 'comment deadline'],
    scope: 'public',
  },
  {
    id: 'federal_intelligence_sources',
    description: 'Capiro-synced news/intelligence, GAO reports and CRS reports.',
    domains: ['intelligence'],
    entities: ['intel_record', 'web_document'],
    tools: ['search_intel_articles', 'search_gao_reports', 'search_crs_reports'],
    timeSemantics: { occurredAt: ['publishedAt', 'date'], changedAt: ['updatedAt'] },
    capabilities: caps(false, true),
    authority: ['synced source metadata', 'source-linked summaries'],
    scope: 'public',
  },
  {
    id: 'economic_data',
    description: 'Census, BLS and BEA economic data exposed through Capiro.',
    domains: ['economic'],
    entities: ['economic_record'],
    tools: ['query_economic_data'],
    timeSemantics: { occurredAt: ['period', 'year'], changedAt: ['updatedAt'] },
    capabilities: caps(true, false),
    authority: ['reported economic statistic', 'geography', 'period'],
    scope: 'public',
  },
  {
    id: 'defense_budget',
    description: 'Program Elements, budget-year values, marks, projects and provenance.',
    domains: ['budget'],
    entities: ['program_element', 'client'],
    tools: [
      'search_program_elements',
      'get_program_element',
      'get_pe_budget_timeline',
      'get_pe_report_language',
    ],
    timeSemantics: { occurredAt: ['fiscalYear'], changedAt: ['updatedAt'] },
    capabilities: caps(true, true),
    authority: [
      'Program Element identity',
      'budget values',
      'budget-source provenance',
      'report language',
    ],
    scope: 'tenant_and_client',
  },
  {
    id: 'federal_opportunities',
    description: 'SAM.gov and related federal opportunity records.',
    domains: ['opportunities'],
    entities: ['opportunity', 'company'],
    tools: ['search_sam_opportunities'],
    timeSemantics: { occurredAt: ['postedDate'], deadlineAt: ['responseDeadline'] },
    capabilities: caps(true, true),
    authority: ['opportunity identity', 'agency', 'deadline', 'solicitation status'],
    scope: 'public',
  },
  {
    id: 'client_funding_pipeline',
    description:
      'Client-scored grants and contract opportunity posture, match explanations and government landscape.',
    domains: ['opportunities'],
    entities: ['opportunity', 'grant', 'client', 'program_element'],
    tools: [
      'get_funding_opportunity',
      'explain_opportunity_match',
      'get_opportunity_client_context',
      'get_opportunity_government_landscape',
      'compare_funding_opportunities',
      'build_opportunity_action_plan',
    ],
    timeSemantics: {
      changedAt: ['updatedAt'],
      deadlineAt: ['deadline', 'responseDeadline', 'closeDate'],
    },
    capabilities: caps(true, false),
    authority: [
      'client match score',
      'eligibility assessment',
      'recorded decision',
      'pipeline freshness',
    ],
    scope: 'tenant_and_client',
  },
  {
    id: 'federal_awards',
    description: 'Federal award and recipient records.',
    domains: ['awards', 'identity'],
    entities: ['award', 'company'],
    tools: ['search_federal_awards'],
    timeSemantics: { occurredAt: ['actionDate', 'startDate'], changedAt: ['updatedAt'] },
    capabilities: caps(true, true),
    authority: ['award occurrence', 'recipient identity', 'award amount', 'agency'],
    scope: 'public',
  },
  {
    id: 'federal_grants',
    description: 'Federal grant opportunity records.',
    domains: ['grants'],
    entities: ['grant', 'company'],
    tools: ['search_federal_grants'],
    timeSemantics: { occurredAt: ['postedDate'], deadlineAt: ['closeDate'] },
    capabilities: caps(true, true),
    authority: ['grant identity', 'eligibility', 'agency', 'deadline'],
    scope: 'public',
  },
  {
    id: 'public_registries',
    description: 'LDA, SEC and FARA public identity and filing records.',
    domains: ['registries', 'identity'],
    entities: ['company', 'registry_record'],
    tools: [
      'lookup_client_registry',
      'search_lda_filings',
      'search_sec_filings',
      'search_fara_registrations',
    ],
    timeSemantics: { occurredAt: ['filingDate', 'period'], changedAt: ['updatedAt'] },
    capabilities: caps(true, true),
    authority: ['registered identity', 'public filing occurrence', 'public identifier'],
    scope: 'public',
  },
  {
    id: 'public_web',
    description: 'Current public web search and explicitly scraped web pages.',
    domains: ['public_web', 'identity'],
    entities: ['company', 'person', 'web_document'],
    tools: ['search_public_web', 'scrape_web_page'],
    timeSemantics: { occurredAt: ['publishedAt'], changedAt: ['retrievedAt'] },
    capabilities: caps(false, true),
    authority: ['public claims when supported by the cited page'],
    scope: 'public',
  },
];

export const MERI_RECIPE_CATALOG: Record<MeriRetrievalRecipeTool, MeriRecipeCatalogEntry> = {
  query_relationship_brief: {
    tool: 'query_relationship_brief',
    description: 'Entity-aware relationship, inbox and commitment history.',
    requiredDomains: ['identity', 'internal_research', 'mail', 'contacts', 'memory'],
    optionalDomains: [
      'documents',
      'meetings',
      'tasks',
      'outreach',
      'legislation',
      'opportunities',
      'public_web',
    ],
    recommendedTools: [
      'query_relationship_brief',
      'resolve_entity',
      'search_emails',
      'list_emails',
      'find_contacts',
      'search_research_sources',
      'search_memory',
      'search_client_knowledge',
      'read_client_documents',
      'get_client_context',
      'query_debriefs',
      'query_tasks',
      'query_outreach',
      'search_tracked_bills',
    ],
  },
  query_client_changes: {
    tool: 'query_client_changes',
    description: 'Date-bounded material change scan for the selected authorized client.',
    requiredDomains: [
      'clients',
      'mail',
      'meetings',
      'tasks',
      'action_items',
      'outreach',
      'legislation',
    ],
    optionalDomains: ['opportunities', 'budget', 'memory'],
    recommendedTools: [
      'query_client_changes',
      'get_client_context',
      'query_tasks',
      'query_action_items',
      'query_outreach',
      'list_emails',
      'query_debriefs',
      'search_tracked_bills',
      'get_opportunity_client_context',
    ],
  },
  query_portfolio_changes: {
    tool: 'query_portfolio_changes',
    description: 'Date-bounded material change scan across every authorized active client.',
    requiredDomains: [
      'clients',
      'mail',
      'meetings',
      'tasks',
      'action_items',
      'outreach',
      'legislation',
    ],
    optionalDomains: ['budget', 'opportunities', 'memory', 'hearings', 'regulatory', 'intelligence'],
    recommendedTools: [
      'query_portfolio_changes',
      'query_tasks',
      'query_action_items',
      'query_outreach',
      'list_emails',
      'query_debriefs',
      'search_tracked_bills',
      'get_client_context',
      'get_opportunity_client_context',
    ],
  },
  research_external_company: {
    tool: 'research_external_company',
    description: 'Public/internal company identity and federal-market evidence collection.',
    requiredDomains: ['identity', 'public_web', 'registries', 'awards', 'opportunities'],
    optionalDomains: ['grants', 'budget', 'internal_research', 'mail', 'memory', 'intelligence'],
    recommendedTools: [
      'research_external_company',
      'resolve_entity',
      'search_public_web',
      'scrape_web_page',
      'search_lda_filings',
      'search_sec_filings',
      'search_federal_awards',
      'search_sam_opportunities',
      'search_federal_grants',
      'search_program_elements',
      'search_research_sources',
      'search_memory',
    ],
  },
  query_portfolio_overlap: {
    tool: 'query_portfolio_overlap',
    description: 'Evidence-backed external-company comparison against every authorized active client.',
    requiredDomains: ['identity', 'clients', 'internal_research'],
    optionalDomains: ['public_web', 'awards', 'opportunities', 'budget', 'memory'],
    recommendedTools: [
      'query_portfolio_overlap',
      'research_external_company',
      'get_client_context',
      'get_opportunity_client_context',
    ],
  },
};

const DATASETS_BY_TOOL = new Map<string, MeriDatasetDefinition[]>();
for (const dataset of MERI_DATASET_CATALOG) {
  for (const tool of dataset.tools) {
    const current = DATASETS_BY_TOOL.get(tool) ?? [];
    current.push(dataset);
    DATASETS_BY_TOOL.set(tool, current);
  }
}

export function meriDatasetsForTool(tool: string): MeriDatasetDefinition[] {
  return [...(DATASETS_BY_TOOL.get(tool) ?? [])];
}

export function meriToolCatalogEntry(tool: string): MeriToolCatalogEntry {
  const recipe = MERI_RECIPE_CATALOG[tool as MeriRetrievalRecipeTool];
  if (recipe) {
    return {
      domains: [...recipe.requiredDomains],
      exhaustive: true,
      datasetIds: [],
    };
  }
  const datasets = meriDatasetsForTool(tool);
  return {
    domains: [...new Set(datasets.flatMap((dataset) => dataset.domains))],
    exhaustive: datasets.length > 0 && datasets.every((dataset) => dataset.capabilities.exhaustiveScan),
    datasetIds: datasets.map((dataset) => dataset.id),
  };
}

export function meriRecipeCatalogEntry(
  tool: MeriRetrievalRecipeTool,
): MeriRecipeCatalogEntry {
  return MERI_RECIPE_CATALOG[tool];
}
