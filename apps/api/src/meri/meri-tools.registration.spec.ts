import { MeriToolsService, TOOL_DEFINITIONS } from './meri-tools.service.js';

/**
 * Tool-registration regression spec. Guards the whole Meri tool surface so a
 * future change cannot silently drop a tool, orphan a schema, or lose a
 * required-input constraint. EXPECTED_TOOLS is intentionally explicit: removing
 * a tool (or renaming one) must fail loudly here and be a deliberate edit.
 */

const EXPECTED_TOOLS = [
  // Engagement + research
  'get_client_context',
  'search_research_sources',
  // Client knowledge base (assistant-parity F5)
  'search_client_knowledge',
  // Analysis sandbox (assistant-parity F4; pilot-gated per tenant)
  'run_analysis',
  // Federal intelligence
  'query_intelligence',
  // Institutional-memory knowledge graph (read-only insight tools)
  'query_knowledge_graph',
  'find_path_to',
  'search_memory',
  'search_congress_bills',
  // Vote/status truth layer (LegiWatch A5)
  'get_bill_status',
  'search_floor_votes',
  // Budget-score spine (Bucket-#3 C4.F1, SC2.4)
  'search_cbo_cost_estimates',
  // Canonical entity resolution (Bucket-#3 C6.P6.2, SC2.2)
  'resolve_entity',
  'search_lda_filings',
  'search_sec_filings',
  'search_fara_registrations',
  'search_federal_grants',
  'search_federal_awards',
  'search_gao_reports',
  // State Legislation Platform (Phase 0 S6) — LegiScan-backed state tools
  'search_state_bills',
  'get_state_bill_status',
  'search_state_floor_votes',
  'get_state_legislator',
  // 50-state analyst (Phase 1 M4.1/M4.2) — committee rosters + representation
  'get_committee_roster',
  'get_representation',
  'get_state_rule_status',
  'search_intel_articles',
  'search_committee_hearings',
  'search_crs_reports',
  'query_economic_data',
  // Web
  'search_public_web',
  'scrape_web_page',
  // Drafting / notes / email / memory
  'create_meeting_brief',
  'draft_policy_memo',
  'save_note',
  'send_email',
  'list_emails',
  'reply_email',
  'save_memory',
  // DoD program elements + acquisition personnel
  'search_program_elements',
  'get_program_element',
  'get_pe_budget_timeline',
  'get_pe_contractors',
  'get_pe_bills',
  'get_pe_report_language',
  'search_acquisition_personnel',
  'get_acquisition_person',
  // Document generation
  'create_word',
  'create_excel',
  'create_powerpoint',
  // Scheduling
  'schedule_task',
  'list_scheduled_tasks',
  'cancel_scheduled_task',
  // Firm operational data (tool-coverage expansion)
  'query_tasks',
  'query_action_items',
  'search_tracked_bills',
  'query_regulatory_dockets',
  'search_sam_opportunities',
  'query_debriefs',
  'read_client_documents',
  'query_outreach',
  // Approval-gated writes (tool-coverage expansion)
  'create_task',
  'update_task',
  'update_client_profile',
] as const;

/** Tools whose schema must enforce required inputs, and exactly which. */
const REQUIRED_INPUTS: Record<string, string[]> = {
  get_client_context: ['clientId'],
  search_research_sources: ['query'],
  search_client_knowledge: ['query'],
  run_analysis: ['code'],
  search_public_web: ['query'],
  scrape_web_page: ['url'],
  create_meeting_brief: ['meetingId'],
  draft_policy_memo: ['clientId'],
  save_note: ['body'],
  send_email: ['to', 'subject', 'body'],
  reply_email: ['threadId', 'body'],
  save_memory: ['content'],
  get_program_element: ['peCode'],
  get_pe_budget_timeline: ['peCode'],
  get_pe_contractors: ['peCode'],
  get_pe_bills: ['peCode'],
  get_pe_report_language: ['peCode'],
  get_acquisition_person: ['id'],
  find_path_to: ['to'],
  search_memory: ['query'],
  resolve_entity: ['query'],
  get_bill_status: ['billId'],
  get_state_bill_status: ['billId'],
  get_state_legislator: ['query'],
  get_committee_roster: ['committee', 'jurisdiction'],
  get_representation: ['clientId'],
  get_state_rule_status: ['query'],
  create_word: ['title', 'sections'],
  create_excel: ['title', 'sheets'],
  create_powerpoint: ['title', 'slides'],
  schedule_task: ['name', 'prompt', 'intervalMinutes'],
  cancel_scheduled_task: ['taskId'],
  search_tracked_bills: ['clientId'],
  query_debriefs: ['clientId'],
  read_client_documents: ['clientId'],
  create_task: ['title'],
  update_task: ['taskId'],
  update_client_profile: ['clientId'],
};

// anthropicToolSchemas() is self-contained (no constructor deps), so an
// uninitialized prototype instance is enough to read the schema surface.
function schemas() {
  const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
  return service.anthropicToolSchemas();
}

describe('Meri tool registration', () => {
  it('registers exactly the expected tool surface (drop/rename fails loudly)', () => {
    const definedNames = TOOL_DEFINITIONS.map((tool) => tool.name);
    expect([...definedNames].sort()).toEqual([...EXPECTED_TOOLS].sort());
    // No duplicates.
    expect(new Set(definedNames).size).toBe(definedNames.length);
  });

  it('emits one anthropic schema per tool definition (no orphans either way)', () => {
    const toolSchemas = schemas();
    expect(toolSchemas).toHaveLength(TOOL_DEFINITIONS.length);
    expect(toolSchemas.map((schema) => schema.name)).toEqual(
      TOOL_DEFINITIONS.map((tool) => tool.name),
    );
  });

  it('every schema is a typed object schema with a non-empty description', () => {
    for (const schema of schemas()) {
      expect(schema.description.length).toBeGreaterThan(10);
      expect(schema.input_schema.type).toBe('object');
      expect(schema.input_schema.properties).toBeDefined();
      expect(Array.isArray(schema.input_schema.required)).toBe(true);
    }
  });

  it('enforces required inputs for every tool that has them', () => {
    const byName = new Map(schemas().map((schema) => [schema.name, schema]));
    for (const [tool, required] of Object.entries(REQUIRED_INPUTS)) {
      const schema = byName.get(tool);
      expect(schema).toBeDefined();
      expect([...(schema!.input_schema.required as string[])].sort()).toEqual([...required].sort());
      // Every required field must exist in properties.
      const properties = schema!.input_schema.properties as Record<string, unknown>;
      for (const field of required) {
        expect(properties[field]).toBeDefined();
      }
    }
  });

  it('tools without required inputs declare an empty required array', () => {
    for (const schema of schemas()) {
      if (!(schema.name in REQUIRED_INPUTS)) {
        expect(schema.input_schema.required).toEqual([]);
      }
    }
  });
});
