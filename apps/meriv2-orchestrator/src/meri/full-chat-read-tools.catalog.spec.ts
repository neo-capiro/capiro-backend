import { MERI_TOOL_MANIFEST, MERI_TOOL_NAMES } from '@capiro/shared';
import { FULL_CHAT_READ_TOOLS } from './full-chat-read-tools.catalog';
import { IN_EDITOR_DELEGATED_TOOLS } from './delegated-tools.catalog';
import { WRITE_DELEGATED_TOOLS } from './write-tools.catalog';

/**
 * W4.6 / D-13: the canonical apps/api Meri tool surface is now the checked-in
 * MERI_TOOL_MANIFEST in @capiro/shared (apps/api is not importable here). It is
 * the single source both sides assert against — no more hand-maintained,
 * silently-drifting name list transcribed into this file.
 */
const ALL_APPS_API_TOOLS = [...MERI_TOOL_NAMES];

describe('FULL_CHAT_READ_TOOLS catalog', () => {
  it('matches the intended full-chat read tool set', () => {
    const expected = [
      'search_legiwatch_news',
      'get_florida_budget_project',
      'compare_florida_budget_amounts',
      'search_legislative_research',
      'get_legal_reference',
      'compare_legislative_versions',
      'get_legiwatch_review',
      'preview_legiwatch_relevance',
      'run_analysis',
      'search_state_bills',
      'get_state_bill_status',
      'search_capiro_data',
      'get_research_evidence',
      'read_chat_attachments',
      'get_research_portfolio',
      'get_research_portfolio_analytics',
      'get_research_portfolio_bookmarks',
      'get_research_portfolio_changes',
      'get_research_portfolio_fit',
      'get_research_portfolio_imports',
      'get_research_portfolio_operations',
      'get_research_portfolio_reviews',
      'get_research_portfolio_rules',
      'prepare_research_portfolio_brief',
      'prepare_research_portfolio_meeting',
      'search_memory',
      // Global-data analytics (structured aggregate queries over the
      // ingested reference datasets — LDA, grants, SAM/USAspending, SEC,
      // FARA, bills, GAO/CRS, FEC, news).
      'list_global_datasets',
      'query_global_data',
      'search_sec_filings',
      'search_fara_registrations',
      'search_federal_grants',
      'search_state_floor_votes',
      'get_state_legislator',
      'get_committee_roster',
      'get_representation',
      'get_state_rule_status',
      'search_cbo_cost_estimates',
      'resolve_entity',
      'get_bill_status',
      'get_certification_status',
      'search_floor_votes',
      'search_public_web',
      'scrape_web_page',
      'list_emails',
      'search_emails',
      'get_email_thread',
      'lookup_client_registry',
      'list_upcoming_meetings',
      'list_scheduled_tasks',
      'query_tasks',
      'query_action_items',
      'search_sam_opportunities',
      'query_debriefs',
      'read_client_meetings',
      'query_outreach',
      'get_pe_report_language',
      'list_members',
      'find_contacts',
      // Funding Opportunities (P37). Read-only, and delegated to full chat
      // rather than in-editor for the same reason search_sam_opportunities is.
      'get_funding_opportunity',
      'search_funding_opportunities',
      'get_funding_opportunity_requirements',
      'explain_opportunity_match',
      'get_opportunity_client_context',
      'get_opportunity_government_landscape',
      'compare_funding_opportunities',
      'build_opportunity_action_plan',
      'search_federal_contract_awards',
      'search_federal_subawards',
      'search_contract_vehicles',
      'search_procurement_forecasts',
      'get_district_federal_market',
      'get_district_nexus_context',
      'get_district_nexus_changes',
      'get_business_development_context',
      'get_business_development_evidence',
      'get_business_development_recent_changes',
      'get_business_development_brief',
      'resolve_business_development_source',
    ].sort();
    expect(FULL_CHAT_READ_TOOLS.map((t) => t.name).sort()).toEqual(expected);
    expect(FULL_CHAT_READ_TOOLS).toHaveLength(78);
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
    expect(combined).toHaveLength(134);
  });

  it('W4.6 / D-13: the three catalogs match the canonical MERI_TOOL_MANIFEST VERBATIM (name AND description) — catches description drift the name-only check missed', () => {
    const combined: Record<string, string> = {};
    for (const t of [
      ...IN_EDITOR_DELEGATED_TOOLS,
      ...WRITE_DELEGATED_TOOLS,
      ...FULL_CHAT_READ_TOOLS,
    ]) {
      combined[t.name] = t.description;
    }
    expect(combined).toEqual({ ...MERI_TOOL_MANIFEST });
  });
});
