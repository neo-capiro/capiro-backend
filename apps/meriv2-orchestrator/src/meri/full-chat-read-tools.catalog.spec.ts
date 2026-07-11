import { MERI_TOOL_MANIFEST, MERI_TOOL_NAMES } from '@capiro/shared';
import { FULL_CHAT_READ_TOOLS } from './full-chat-read-tools.catalog';
import { IN_EDITOR_DELEGATED_TOOLS } from './delegated-tools.catalog';
import { WRITE_DELEGATED_TOOLS } from './write-tools.catalog';

/**
 * W4.6 / D-13: the canonical apps/api Meri tool surface is now the checked-in
 * MERI_TOOL_MANIFEST in @capiro/shared (apps/api is not importable here). It is
 * the single source both sides assert against — no more hand-maintained,
 * silently-drifting name list transcribed into this file. Current surface: 63
 * tools.
 */
const ALL_APPS_API_TOOLS = [...MERI_TOOL_NAMES];

describe('FULL_CHAT_READ_TOOLS catalog', () => {
  it('matches the expected 23-tool set, all read-only', () => {
    const expected = [
      'run_analysis',
      'search_memory',
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
      'search_floor_votes',
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
    expect(FULL_CHAT_READ_TOOLS).toHaveLength(23);
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
    expect(combined).toHaveLength(63);
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
