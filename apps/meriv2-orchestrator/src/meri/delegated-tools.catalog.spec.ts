import { IN_EDITOR_DELEGATED_TOOLS } from './delegated-tools.catalog';

/**
 * Drift guard: the delegated catalog must match apps/api's in-editor allowlist
 * (workspace-assistant.service.ts ASSISTANT_TOOLS) exactly — same names, all
 * read-only. If apps/api adds/removes a read-only assistant tool, this list
 * must be updated in lockstep (the names are transcribed verbatim from
 * TOOL_DEFINITIONS). Kept as an explicit expected set because apps/api is not
 * importable from the orchestrator package.
 */
const EXPECTED_IN_EDITOR_TOOLS = [
  'get_client_context',
  'search_client_knowledge',
  'search_research_sources',
  'read_client_documents',
  'query_intelligence',
  'query_knowledge_graph',
  'find_path_to',
  'search_intel_articles',
  'search_congress_bills',
  'search_tracked_bills',
  'search_lda_filings',
  'search_committee_hearings',
  'search_crs_reports',
  'search_gao_reports',
  'query_regulatory_dockets',
  'search_federal_awards',
  'search_program_elements',
  'get_program_element',
  'get_pe_budget_timeline',
  'get_pe_contractors',
  'get_pe_bills',
  'search_acquisition_personnel',
  'get_acquisition_person',
  'query_economic_data',
  'search_state_bills',
  'get_state_bill_status',
].sort();

describe('IN_EDITOR_DELEGATED_TOOLS catalog', () => {
  it('matches the apps/api in-editor allowlist exactly (26 tools)', () => {
    const names = IN_EDITOR_DELEGATED_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(EXPECTED_IN_EDITOR_TOOLS);
    expect(IN_EDITOR_DELEGATED_TOOLS).toHaveLength(26);
  });

  it('is ALL read-only (no write tool delegated on the read surface)', () => {
    expect(IN_EDITOR_DELEGATED_TOOLS.every((t) => t.readOnly === true)).toBe(true);
  });

  it('has unique names and non-empty descriptions', () => {
    const names = IN_EDITOR_DELEGATED_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(IN_EDITOR_DELEGATED_TOOLS.every((t) => t.description.trim().length > 0)).toBe(true);
  });
});
