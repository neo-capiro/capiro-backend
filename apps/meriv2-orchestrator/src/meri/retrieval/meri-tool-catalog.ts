import {
  MERI_RECIPE_CATALOG,
  meriDatasetsForTool,
  type MeriToolCatalogEntry,
} from './meri-data-catalog.js';
import type { MeriRetrievalDomain } from './meri-retrieval-plan.js';

const TOOL_DOMAIN_OVERRIDES: Record<string, MeriRetrievalDomain[]> = {
  search_legiwatch_news: ['legislation', 'clients'],
  get_florida_budget_project: ['legislation', 'clients'],
  compare_florida_budget_amounts: ['legislation', 'clients'],
  prepare_legiwatch_briefing: ['legislation', 'clients'],
  search_legislative_research: ['legislation', 'clients'],
  get_legal_reference: ['legislation', 'clients'],
  compare_legislative_versions: ['legislation', 'clients'],
  get_legiwatch_review: ['legislation', 'clients'],
  preview_legiwatch_relevance: ['legislation', 'clients'],
  resolve_entity: ['identity'],
  lookup_client_registry: ['identity', 'registries'],
  get_client_context: ['clients', 'internal_research'],
  search_client_knowledge: ['internal_research'],
  read_client_documents: ['documents', 'internal_research'],
  search_research_sources: ['internal_research'],
  get_research_portfolio: ['internal_research'],
  get_research_portfolio_analytics: ['internal_research', 'budget'],
  get_research_portfolio_changes: ['internal_research'],
  create_research_portfolio_snapshot: ['internal_research', 'budget'],
  request_research_portfolio_output: ['internal_research', 'budget'],
  save_research_portfolio_output_to_client: ['internal_research', 'clients'],
  watch_research_portfolio: ['internal_research'],
  update_research_portfolio_change_state: ['internal_research'],
  search_memory: ['memory'],
  search_emails: ['mail'],
  list_emails: ['mail'],
  get_email_thread: ['mail'],
  find_contacts: ['contacts'],
  list_upcoming_meetings: ['meetings'],
  query_debriefs: ['meetings'],
  query_tasks: ['tasks'],
  query_action_items: ['action_items'],
  query_outreach: ['outreach'],
  search_tracked_bills: ['legislation'],
  search_congress_bills: ['legislation'],
  search_state_bills: ['legislation'],
  search_committee_hearings: ['hearings'],
  get_committee_roster: ['directory', 'identity'],
  list_members: ['directory', 'identity'],
  get_representation: ['directory'],
  search_acquisition_personnel: ['directory', 'identity'],
  get_acquisition_person: ['directory', 'identity'],
  query_regulatory_dockets: ['regulatory'],
  get_state_rule_status: ['regulatory'],
  search_intel_articles: ['intelligence'],
  search_gao_reports: ['intelligence'],
  search_crs_reports: ['intelligence'],
  query_economic_data: ['economic'],
  get_district_nexus_context: ['clients', 'economic', 'awards', 'opportunities'],
  get_district_nexus_changes: ['clients', 'intelligence'],
  search_program_elements: ['budget'],
  get_program_element: ['budget'],
  get_pe_budget_timeline: ['budget'],
  get_pe_report_language: ['budget'],
  get_pe_contractors: ['budget', 'awards'],
  get_pe_bills: ['budget', 'legislation'],
  search_sam_opportunities: ['opportunities'],
  get_funding_opportunity: ['opportunities'],
  search_funding_opportunities: ['opportunities', 'grants'],
  get_funding_opportunity_requirements: ['opportunities', 'documents'],
  explain_opportunity_match: ['opportunities'],
  get_opportunity_client_context: ['opportunities'],
  get_opportunity_government_landscape: ['opportunities', 'budget'],
  compare_funding_opportunities: ['opportunities'],
  build_opportunity_action_plan: ['opportunities'],
  search_federal_awards: ['awards'],
  search_federal_grants: ['grants'],
  search_lda_filings: ['registries'],
  search_sec_filings: ['registries'],
  search_fara_registrations: ['registries'],
  search_public_web: ['public_web'],
  scrape_web_page: ['public_web'],
  research_federal_market_strategy: [
    'identity',
    'public_web',
    'registries',
    'awards',
    'opportunities',
    'grants',
    'budget',
    'intelligence',
    'directory',
  ],
};

/**
 * “Exhaustive” means this one invocation can establish source completeness for
 * the requested key, not merely that it returns useful records. Search-email
 * is included because it returns an exact count + hasMore and can prove a
 * bounded query is fully returned when totalMatches <= returned; mailbox health
 * is checked separately by MeriRetrievalCoordinator.
 */
const EXHAUSTIVE_TOOLS = new Set([
  'resolve_entity',
  'lookup_client_registry',
  'search_emails',
  'list_emails',
  'get_program_element',
  'get_pe_budget_timeline',
  'get_pe_report_language',
  'get_pe_contractors',
  'get_pe_bills',
  'get_acquisition_person',
  'get_state_rule_status',
  'scrape_web_page',
]);

/**
 * These readers are intentionally partial/top-k/bounded today. Keeping that
 * limitation in the catalog prevents the planner or model from claiming
 * exhaustive coverage before the APIs expose real cursors/totals.
 */
const NON_EXHAUSTIVE_TOOLS = new Set([
  'search_legiwatch_news',
  'get_florida_budget_project',
  'compare_florida_budget_amounts',
  'prepare_legiwatch_briefing',
  'search_legislative_research',
  'get_legal_reference',
  'get_legiwatch_review',
  'preview_legiwatch_relevance',
  'get_funding_opportunity',
  'explain_opportunity_match',
  'get_opportunity_client_context',
  'get_opportunity_government_landscape',
  'compare_funding_opportunities',
  'build_opportunity_action_plan',

  'search_funding_opportunities',
  'get_funding_opportunity_requirements',
  'get_client_context',
  'get_email_thread',
  'search_client_knowledge',
  'read_client_documents',
  'search_research_sources',
  'get_research_portfolio',
  'get_research_portfolio_analytics',
  'get_research_portfolio_changes',
  'search_memory',
  'find_contacts',
  'list_upcoming_meetings',
  'query_debriefs',
  'query_tasks',
  'query_action_items',
  'query_outreach',
  'search_tracked_bills',
  'search_congress_bills',
  'search_state_bills',
  'search_committee_hearings',
  'get_committee_roster',
  'list_members',
  'get_representation',
  'search_acquisition_personnel',
  'query_regulatory_dockets',
  'search_intel_articles',
  'search_gao_reports',
  'search_crs_reports',
  'query_economic_data',
  'get_district_nexus_context',
  'get_district_nexus_changes',
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
      : tool === 'research_federal_market_strategy'
        ? false
        : datasets.length > 0 && datasets.every((dataset) => dataset.capabilities.exhaustiveScan);

  return {
    domains: [...domains],
    exhaustive,
    datasetIds: datasets.map((dataset) => dataset.id),
  };
}
