/**
 * The canonical READ-ONLY tool surface for the in-document ("in-editor") Meri
 * assistant, shared by BOTH implementations of that surface:
 *
 *  - the legacy path in apps/api (WorkspaceAssistantService), and
 *  - the MeriV2 path in apps/meriv2-orchestrator (InEditorAssistantService).
 *
 * It lives here — not duplicated in each app — because the two paths are selected
 * by a feature flag at runtime. When the sets drifted, flipping the flag silently
 * changed which tools Meri could reach, which is exactly the class of
 * behaviour-changing routing this must not have.
 *
 * It is an ALLOWLIST, not a denylist: a newly registered write tool can never
 * leak into the editor by default. The surface deliberately spans federal,
 * state, regulatory, representation, and defense-budget work, because the
 * assistant must not silently assume a federal jurisdiction.
 */
export const IN_EDITOR_READ_TOOLS: ReadonlySet<string> = new Set<string>([
  // Firm + client knowledge
  'get_client_context',
  'search_client_knowledge',
  'search_research_sources',
  'read_client_documents',
  // Intelligence + graph
  'query_intelligence',
  'query_knowledge_graph',
  'find_path_to',
  'search_intel_articles',
  // Federal legislative
  'search_congress_bills',
  'search_tracked_bills',
  'search_lda_filings',
  'search_committee_hearings',
  'search_crs_reports',
  'search_gao_reports',
  // Regulatory
  'query_regulatory_dockets',
  // Awards + defense budget
  'search_federal_awards',
  'search_program_elements',
  'get_program_element',
  'get_pe_budget_timeline',
  'get_pe_contractors',
  'get_pe_bills',
  'search_acquisition_personnel',
  'get_acquisition_person',
  'query_economic_data',
  // State legislative + rules (a SEPARATE namespace from federal Congress)
  'search_state_bills',
  'get_state_bill_status',
  'search_state_floor_votes',
  'get_state_legislator',
  'get_state_rule_status',
  // Representation
  'get_committee_roster',
  'get_representation',
  'list_members',
]);

const IN_EDITOR_TOOL_LABELS: Readonly<Record<string, string>> = {
  get_client_context: 'Reviewed client context',
  search_client_knowledge: 'Searched client knowledge',
  search_research_sources: 'Searched research sources',
  read_client_documents: 'Read client documents',
  query_intelligence: 'Queried policy intelligence',
  query_knowledge_graph: 'Queried the knowledge graph',
  find_path_to: 'Traced knowledge-graph connections',
  search_intel_articles: 'Searched intel articles',
  search_congress_bills: 'Searched Congress bills',
  search_tracked_bills: 'Searched tracked bills',
  search_lda_filings: 'Searched LDA filings',
  search_committee_hearings: 'Searched committee hearings',
  search_crs_reports: 'Searched CRS reports',
  search_gao_reports: 'Searched GAO reports',
  query_regulatory_dockets: 'Queried regulatory dockets',
  search_federal_awards: 'Searched federal awards',
  search_program_elements: 'Searched program elements',
  get_program_element: 'Looked up a program element',
  get_pe_budget_timeline: 'Pulled PE budget timeline',
  get_pe_contractors: 'Pulled PE contractors',
  get_pe_bills: 'Pulled PE bill references',
  search_acquisition_personnel: 'Searched acquisition personnel',
  get_acquisition_person: 'Looked up an acquisition contact',
  query_economic_data: 'Queried economic data',
  search_state_bills: 'Searched state bills',
  get_state_bill_status: 'Looked up a state bill status',
  search_state_floor_votes: 'Searched state floor votes',
  get_state_legislator: 'Looked up a state legislator',
  get_state_rule_status: 'Looked up a rule status',
  get_committee_roster: 'Reviewed a committee roster',
  get_representation: 'Resolved facility representation',
  list_members: 'Listed current members of Congress',
};

/** Human label for the editor's thought-process view. Shared by both paths. */
export function inEditorToolLabel(tool: string): string {
  return IN_EDITOR_TOOL_LABELS[tool] ?? `Ran ${tool}`;
}

/**
 * Bounded, non-leaking category for a failed tool lookup. Tool errors can carry
 * provider/DB detail, so only a category is ever shown to the model or the user.
 */
export function inEditorToolErrorCategory(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('timeout') || message.includes('abort')) return 'timeout';
  if (message.includes('not found')) return 'not_found';
  if (message.includes('forbidden') || message.includes('unauthorized')) return 'authorization';
  return 'lookup_failed';
}
