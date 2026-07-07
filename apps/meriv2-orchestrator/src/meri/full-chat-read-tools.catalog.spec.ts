import { FULL_CHAT_READ_TOOLS } from './full-chat-read-tools.catalog';
import { IN_EDITOR_DELEGATED_TOOLS } from './delegated-tools.catalog';
import { WRITE_DELEGATED_TOOLS } from './write-tools.catalog';

/**
 * Full apps/api Meri tool surface (meri-tools.service.ts TOOL_DEFINITIONS),
 * transcribed verbatim — 55 tools. Kept as an explicit expected set because
 * apps/api is not importable from the orchestrator package.
 */
const ALL_APPS_API_TOOLS = [
  'get_client_context',
  'search_research_sources',
  'run_analysis',
  'search_client_knowledge',
  'query_intelligence',
  'query_knowledge_graph',
  'find_path_to',
  'search_memory',
  'search_congress_bills',
  'search_cbo_cost_estimates',
  'resolve_entity',
  'search_lda_filings',
  'search_sec_filings',
  'search_fara_registrations',
  'search_federal_grants',
  'search_federal_awards',
  'search_gao_reports',
  'search_state_bills',
  'search_intel_articles',
  'search_committee_hearings',
  'search_crs_reports',
  'query_economic_data',
  'search_public_web',
  'scrape_web_page',
  'create_meeting_brief',
  'draft_policy_memo',
  'save_note',
  'send_email',
  'list_emails',
  'reply_email',
  'save_memory',
  'search_program_elements',
  'get_program_element',
  'get_pe_budget_timeline',
  'get_pe_contractors',
  'get_pe_bills',
  'search_acquisition_personnel',
  'get_acquisition_person',
  'create_word',
  'create_excel',
  'create_powerpoint',
  'schedule_task',
  'list_scheduled_tasks',
  'cancel_scheduled_task',
  'query_tasks',
  'query_action_items',
  'search_tracked_bills',
  'query_regulatory_dockets',
  'search_sam_opportunities',
  'query_debriefs',
  'query_outreach',
  'read_client_documents',
  'create_task',
  'update_task',
  'update_client_profile',
].sort();

describe('FULL_CHAT_READ_TOOLS catalog', () => {
  it('matches the expected 17-tool set, all read-only', () => {
    const expected = [
      'run_analysis',
      'search_memory',
      'search_sec_filings',
      'search_fara_registrations',
      'search_federal_grants',
      'search_state_bills',
      'search_cbo_cost_estimates',
      'resolve_entity',
      'search_public_web',
      'scrape_web_page',
      'list_emails',
      'list_scheduled_tasks',
      'query_tasks',
      'query_action_items',
      'search_sam_opportunities',
      'query_debriefs',
      'query_outreach',
    ].sort();
    expect(FULL_CHAT_READ_TOOLS.map((t) => t.name).sort()).toEqual(expected);
    expect(FULL_CHAT_READ_TOOLS).toHaveLength(17);
    expect(FULL_CHAT_READ_TOOLS.every((t) => t.readOnly === true)).toBe(true);
  });

  it('has unique names and non-empty descriptions', () => {
    const names = FULL_CHAT_READ_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(FULL_CHAT_READ_TOOLS.every((t) => t.description.trim().length > 0)).toBe(true);
  });
});

describe('Combined delegated-tool coverage (in-editor + write + full-chat-read)', () => {
  it("the three catalogs together cover apps/api's full tool surface exactly — no gap, no duplicate", () => {
    const combined = [
      ...IN_EDITOR_DELEGATED_TOOLS.map((t) => t.name),
      ...WRITE_DELEGATED_TOOLS.map((t) => t.name),
      ...FULL_CHAT_READ_TOOLS.map((t) => t.name),
    ].sort();
    expect(combined).toEqual(ALL_APPS_API_TOOLS);
    expect(new Set(combined).size).toBe(combined.length); // no tool double-registered
  });
});
