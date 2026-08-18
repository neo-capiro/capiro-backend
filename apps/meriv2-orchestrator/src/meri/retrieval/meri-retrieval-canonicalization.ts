import type {
  MeriRetrievalDomain,
  MeriRetrievalPlan,
} from './meri-retrieval-plan.js';

const REQUIRED_DOMAINS: MeriRetrievalDomain[] = [
  'identity',
  'public_web',
  'registries',
  'awards',
  'opportunities',
  'grants',
  'budget',
  'intelligence',
  'directory',
];

const OPTIONAL_DOMAINS: MeriRetrievalDomain[] = [
  'internal_research',
  'memory',
  'legislation',
  'hearings',
];

const RECOMMENDED_TOOLS = [
  'research_federal_market_strategy',
  'resolve_entity',
  'search_public_web',
  'scrape_web_page',
  'search_lda_filings',
  'search_sec_filings',
  'search_federal_awards',
  'search_sam_opportunities',
  'search_federal_grants',
  'search_program_elements',
  'get_program_element',
  'get_pe_budget_timeline',
  'get_pe_report_language',
  'get_pe_contractors',
  'get_pe_bills',
  'search_acquisition_personnel',
  'search_intel_articles',
  'search_gao_reports',
  'search_crs_reports',
  'search_committee_hearings',
  'search_research_sources',
  'search_memory',
];

/**
 * Feature-flagged Phase-4 cutover. The legacy external-company recipe remains
 * callable internally as an evidence collector, but it is no longer the
 * model-facing reasoning path for an allowlisted tenant.
 *
 * A bounded company-description lookup is deliberately excluded. The same
 * recipe name powers both quick profiles and federal-market investigations;
 * `quick-company-profile` is the intent contract that prevents a simple
 * “what does this company do?” question from becoming a full Research Director
 * run across registries, awards, opportunities, grants and budget data.
 */
export function canonicalizeMeriCompanyResearchPlan(
  plan: MeriRetrievalPlan,
  enabled: boolean,
): MeriRetrievalPlan {
  if (
    !enabled ||
    plan.recipeTool !== 'research_external_company' ||
    plan.reasons.includes('quick-company-profile')
  ) {
    return plan;
  }
  return {
    ...plan,
    recipeTool: 'research_federal_market_strategy',
    requiredDomains: [...REQUIRED_DOMAINS],
    optionalDomains: [...OPTIONAL_DOMAINS],
    recommendedTools: [...RECOMMENDED_TOOLS],
    reasons: [
      ...new Set([
        ...plan.reasons.filter((reason) => reason !== 'recipe:research_external_company'),
        'recipe:research_federal_market_strategy',
        'research-director-required',
        'research-director-canonical-cutover',
      ]),
    ],
  };
}
