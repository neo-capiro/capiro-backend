import { ASSISTANT_TOOLS } from './in-editor-prompt.js';

/**
 * Read-only government-affairs parity with full chat. The exported value is
 * typed ReadonlySet to consumers, but its runtime registry is deliberately a
 * Set; this module extends it once during controller startup without opening the
 * surface to future tools automatically.
 */
const tools = ASSISTANT_TOOLS as Set<string>;
for (const name of [
  'get_bill_status',
  'search_floor_votes',
  'resolve_entity',
  'search_state_bills',
  'get_state_bill_status',
  'search_state_floor_votes',
  'get_state_legislator',
  'get_committee_roster',
  'get_representation',
  'list_members',
  'get_state_rule_status',
]) {
  tools.add(name);
}
