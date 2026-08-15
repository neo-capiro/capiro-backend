import {
  MERI_RECIPE_CATALOG,
  meriDatasetsForTool,
  type MeriToolCatalogEntry,
} from './meri-data-catalog.js';
import type { MeriRetrievalDomain } from './meri-retrieval-plan.js';

const TOOL_DOMAIN_OVERRIDES: Record<string, MeriRetrievalDomain[]> = {
  resolve_entity: ['identity'],
  lookup_client_registry: ['identity', 'registries'],
  get_client_context: ['clients', 'internal_research'],
  search_client_knowledge: ['internal_research'],
  search_research_sources: ['internal_research'],
  search_memory: ['memory'],
  search_emails: ['mail'],
  list_emails: ['mail'],
  find_contacts: ['contacts'],
  list_upcoming_meetings: ['meetings'],
  query_debriefs: ['meetings'],
  query_tasks: ['tasks'],
  query_action_items: ['action_items'],
  query_outreach: ['outreach'],
  search_tracked_bills: ['legislation'],
  search_congress_bills: ['legislation'],
  search_state_bills: ['legislation'],
  search_program_elements: ['budget'],
  get_program_element: ['budget'],
  get_pe_budget_timeline: ['budget'],
  search_sam_opportunities: ['opportunities'],
  search_federal_awards: ['awards'],
  search_federal_grants: ['grants'],
  search_lda_filings: ['registries'],
  search_sec_filings: ['registries'],
  search_fara_registrations: ['registries'],
  search_public_web: ['public_web'],
  scrape_web_page: ['public_web'],
};

const EXHAUSTIVE_TOOLS = new Set([
  'resolve_entity',
  'lookup_client_registry',
  'get_client_context',
  'search_emails',
  'find_contacts',
  'list_upcoming_meetings',
  'query_debriefs',
  'query_tasks',
  'query_action_items',
  'query_outreach',
  'search_tracked_bills',
  'get_program_element',
  'get_pe_budget_timeline',
  'scrape_web_page',
]);

const NON_EXHAUSTIVE_TOOLS = new Set([
  'search_client_knowledge',
  'search_research_sources',
  'search_memory',
  'list_emails',
  'search_congress_bills',
  'search_state_bills',
  'search_program_elements',
  'search_sam_opportunities',
  'search_federal_awards',
  'search_federal_grants',
  'search_lda_filings',
  'search_sec_filings',
  'search_fara_registrations',
  'search_public_web',
]);

export function meriToolCoverageCatalogEntry(tool: string): MeriToolCatalogEntry {
  const recipe = MERI_RECIPE_CATALOG[tool as keyof typeof MERI_RECIPE_CATALOG];
  if (recipe) {
    return {
      domains: [...recipe.requiredDomains],
      exhaustive: true,
      datasetIds: [],
    };
  }

  const datasets = meriDatasetsForTool(tool);
  const domains = TOOL_DOMAIN_OVERRIDES[tool] ?? [
    ...new Set(datasets.flatMap((dataset) => dataset.domains)),
  ];
  const exhaustive = EXHAUSTIVE_TOOLS.has(tool)
    ? true
    : NON_EXHAUSTIVE_TOOLS.has(tool)
      ? false
      : datasets.length > 0 && datasets.every((dataset) => dataset.capabilities.exhaustiveScan);

  return {
    domains: [...domains],
    exhaustive,
    datasetIds: datasets.map((dataset) => dataset.id),
  };
}
