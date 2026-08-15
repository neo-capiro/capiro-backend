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
  | 'bill'
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

export const MERI_DATASET_CATALOG: MeriDatasetDefinition[] = [
  {
    id: 'client_portfolio',
    description: 'Authorized Capiro client roster and structured client profile context.',
    domains: ['clients', 'internal_research'],
    entities: ['client', 'company', 'person'],
    tools: ['get_client_context', 'search_client_knowledge', 'search_research_sources'],
    timeSemantics: { changedAt: ['updatedAt'] },
    capabilities: {
      exactFiltering: true,
      dateRange: false,
      pagination: false,
      exhaustiveScan: false,
      semanticSearch: true,
    },
    authority: ['client identity', 'client profile', 'client capabilities', 'client strategies'],
    scope: 'tenant_and_client',
  },
  {
    id: 'mail_messages',
    description: 'Synchronized Microsoft 365 and Google Workspace message records.',
    domains: ['mail'],
    entities: ['message', 'person', 'company', 'client'],
    tools: ['search_emails', 'list_emails'],
    timeSemantics: { occurredAt: ['sentAt', 'receivedAt'], changedAt: ['updatedAt'] },
    capabilities: {
      exactFiltering: true,
      dateRange: true,
      pagination: true,
      exhaustiveScan: true,
      semanticSearch: false,
    },
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
    capabilities: {
      exactFiltering: true,
      dateRange: false,
      pagination: false,
      exhaustiveScan: false,
      semanticSearch: false,
    },
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
    capabilities: {
      exactFiltering: true,
      dateRange: false,
      pagination: false,
      exhaustiveScan: false,
      semanticSearch: false,
    },
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
    capabilities: {
      exactFiltering: true,
      dateRange: false,
      pagination: false,
      exhaustiveScan: false,
      semanticSearch: false,
    },
    authority: ['task status', 'task owner', 'task deadline'],
    scope: 'tenant_and_client',
  },
  {
    id: 'action_items',
    description: 'Needs Attention and action-recommendation records.',
    domains: ['action_items'],
    entities: ['action_item', 'client'],
    tools: ['query_action_items'],
    timeSemantics: { occurredAt: ['createdAt'], changedAt: ['updatedAt'], deadlineAt: ['deadline'] },
    capabilities: {
      exactFiltering: true,
      dateRange: false,
      pagination: false,
      exhaustiveScan: false,
      semanticSearch: false,
    },
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
    capabilities: {
      exactFiltering: true,
      dateRange: false,
      pagination: false,
      exhaustiveScan: false,
      semanticSearch: false,
    },
    authority: ['outreach status', 'recipient count', 'send occurrence'],
    scope: 'tenant_and_client',
  },
  {
    id: 'institutional_memory',
    description: 'Curated tenant/client/user memories used as contextual nuance, not live operational truth.',
    domains: ['memory'],
    entities: ['memory', 'client', 'company', 'person'],
    tools: ['search_memory'],
    timeSemantics: { changedAt: ['updatedAt', 'confirmedAt'] },
    capabilities: {
      exactFiltering: false,
      dateRange: false,
      pagination: false,
      exhaustiveScan: false,
      semanticSearch: true,
    },
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
    capabilities: {
      exactFiltering: true,
      dateRange: false,
      pagination: false,
      exhaustiveScan: false,
      semanticSearch: true,
    },
    authority: ['bill identity', 'bill stage', 'legislative actions'],
    scope: 'tenant_and_client',
  },
  {
    id: 'defense_budget',
    description: 'Program Elements, budget-year values, marks, projects and provenance.',
    domains: ['budget'],
    entities: ['program_element', 'client'],
    tools: ['search_program_elements', 'get_program_element', 'get_pe_budget_timeline'],
    timeSemantics: { occurredAt: ['fiscalYear'], changedAt: ['updatedAt'] },
    capabilities: {
      exactFiltering: true,
      dateRange: true,
      pagination: false,
      exhaustiveScan: false,
      semanticSearch: true,
    },
    authority: ['Program Element identity', 'budget values', 'budget-source provenance'],
    scope: 'tenant_and_client',
  },
  {
    id: 'federal_opportunities',
    description: 'SAM.gov and related federal opportunity records.',
    domains: ['opportunities'],
    entities: ['opportunity', 'company'],
    tools: ['search_sam_opportunities'],
    timeSemantics: { occurredAt: ['postedDate'], deadlineAt: ['responseDeadline'] },
    capabilities: {
      exactFiltering: true,
      dateRange: true,
      pagination: true,
      exhaustiveScan: false,
      semanticSearch: true,
    },
    authority: ['opportunity identity', 'agency', 'deadline', 'solicitation status'],
    scope: 'public',
  },
  {
    id: 'federal_awards',
    description: 'Federal award and recipient records.',
    domains: ['awards', 'identity'],
    entities: ['award', 'company'],
    tools: ['search_federal_awards'],
    timeSemantics: { occurredAt: ['actionDate', 'startDate'], changedAt: ['updatedAt'] },
    capabilities: {
      exactFiltering: true,
      dateRange: true,
      pagination: true,
      exhaustiveScan: false,
      semanticSearch: true,
    },
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
    capabilities: {
      exactFiltering: true,
      dateRange: true,
      pagination: true,
      exhaustiveScan: false,
      semanticSearch: true,
    },
    authority: ['grant identity', 'eligibility', 'agency', 'deadline'],
    scope: 'public',
  },
  {
    id: 'public_registries',
    description: 'LDA, SEC and FARA public identity and filing records.',
    domains: ['registries', 'identity'],
    entities: ['company', 'registry_record'],
    tools: ['lookup_client_registry', 'search_lda_filings', 'search_sec_filings', 'search_fara_registrations'],
    timeSemantics: { occurredAt: ['filingDate', 'period'], changedAt: ['updatedAt'] },
    capabilities: {
      exactFiltering: true,
      dateRange: true,
      pagination: true,
      exhaustiveScan: false,
      semanticSearch: true,
    },
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
    capabilities: {
      exactFiltering: false,
      dateRange: false,
      pagination: false,
      exhaustiveScan: false,
      semanticSearch: true,
    },
    authority: ['public claims when supported by the cited page'],
    scope: 'public',
  },
];

export const MERI_RECIPE_CATALOG: Record<MeriRetrievalRecipeTool, MeriRecipeCatalogEntry> = {
  query_relationship_brief: {
    tool: 'query_relationship_brief',
    description: 'Entity-aware relationship, inbox and commitment history.',
    requiredDomains: ['identity', 'internal_research', 'mail', 'contacts', 'memory'],
    optionalDomains: ['meetings', 'tasks', 'outreach', 'legislation', 'public_web'],
    recommendedTools: [
      'query_relationship_brief',
      'resolve_entity',
      'search_emails',
      'find_contacts',
      'search_research_sources',
      'search_memory',
    ],
  },
  query_portfolio_changes: {
    tool: 'query_portfolio_changes',
    description: 'Date-bounded material change scan across every authorized active client.',
    requiredDomains: ['clients', 'mail', 'meetings', 'tasks', 'action_items', 'outreach', 'legislation'],
    optionalDomains: ['budget', 'opportunities', 'memory'],
    recommendedTools: [
      'query_portfolio_changes',
      'query_tasks',
      'query_action_items',
      'query_outreach',
      'list_emails',
      'query_debriefs',
      'search_tracked_bills',
    ],
  },
  research_external_company: {
    tool: 'research_external_company',
    description: 'Public/internal company identity and federal-market evidence collection.',
    requiredDomains: ['identity', 'public_web', 'registries', 'awards', 'opportunities'],
    optionalDomains: ['grants', 'budget', 'internal_research', 'mail', 'memory'],
    recommendedTools: [
      'research_external_company',
      'resolve_entity',
      'search_public_web',
      'search_lda_filings',
      'search_sec_filings',
      'search_federal_awards',
      'search_sam_opportunities',
      'search_federal_grants',
    ],
  },
  query_portfolio_overlap: {
    tool: 'query_portfolio_overlap',
    description: 'Evidence-backed external-company comparison against every authorized active client.',
    requiredDomains: ['identity', 'clients', 'internal_research'],
    optionalDomains: ['public_web', 'awards', 'opportunities', 'memory'],
    recommendedTools: ['query_portfolio_overlap', 'research_external_company', 'get_client_context'],
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
