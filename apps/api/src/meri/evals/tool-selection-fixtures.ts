/**
 * Tool-selection eval fixtures.
 *
 * Each fixture maps a realistic government-affairs ask to the tool Meri SHOULD
 * pick (or `null` when the right move is to answer with no tool call). These
 * drive `scripts/eval-clio-tool-selection.ts`, which presents the production
 * tool schemas to a live model with `tool_choice: auto` and checks the first
 * tool it reaches for. `forbiddenTools` are tempting-but-wrong neighbors that a
 * correct selection must NOT choose (e.g. the recency-capped `list_emails` when
 * the ask is a content search that needs `search_emails`).
 *
 * Every `expectedTool` / `forbiddenTools` entry is asserted to be a real
 * MERI_TOOL_MANIFEST tool by `tool-selection-fixtures.spec.ts`.
 */
export interface ToolSelectionFixture {
  id: string;
  userPrompt: string;
  /** The tool the model should pick, or `null` when it should call no tool. */
  expectedTool: string | null;
  /** Tempting-but-wrong tools a correct selection must not choose. */
  forbiddenTools?: string[];
  note?: string;
}

export const TOOL_SELECTION_FIXTURES: readonly ToolSelectionFixture[] = [
  {
    id: 'bill-status-direct',
    userPrompt: 'What is the current status of H.R. 8800 — did it actually pass the House?',
    expectedTool: 'get_bill_status',
    forbiddenTools: ['search_congress_bills'],
    note: 'A specific bill + "did it pass" is a status lookup, not a keyword search.',
  },
  {
    id: 'bills-keyword-search',
    userPrompt: 'Find recent congressional bills about shipbuilding industrial base.',
    expectedTool: 'search_congress_bills',
    forbiddenTools: ['get_bill_status'],
  },
  {
    id: 'senators-by-state',
    userPrompt: 'Who are the two senators from Virginia?',
    expectedTool: 'list_members',
    forbiddenTools: ['resolve_entity', 'get_state_legislator'],
    note: 'By-state roster listing, not single-entity resolution.',
  },
  {
    id: 'resolve-one-member',
    userPrompt: 'Ground this reference for me: who exactly is Senator Warner?',
    expectedTool: 'resolve_entity',
    forbiddenTools: ['list_members'],
  },
  {
    id: 'committee-roster',
    userPrompt: 'Who sits on the House Armed Services Committee — chair and ranking member?',
    expectedTool: 'get_committee_roster',
  },
  {
    id: 'federal-grants',
    userPrompt:
      'Are there any open federal grant opportunities for cybersecurity workforce programs?',
    expectedTool: 'search_federal_grants',
  },
  {
    id: 'pe-budget-timeline',
    userPrompt: 'Show me the fiscal-year budget timeline for program element 0603270A.',
    expectedTool: 'get_pe_budget_timeline',
    forbiddenTools: ['search_program_elements'],
  },
  {
    id: 'pe-report-language',
    userPrompt:
      'Why was the mark cut for PE 0604270A? What does the committee report language say?',
    expectedTool: 'get_pe_report_language',
    note: 'The "why" behind a mark is only in report language — never inferred from the delta.',
  },
  {
    id: 'state-bills',
    userPrompt: 'Search Texas state bills about consumer data privacy this session.',
    expectedTool: 'search_state_bills',
    forbiddenTools: ['search_congress_bills'],
  },
  {
    id: 'representation',
    userPrompt: "Which members of Congress represent our client's facility footprint?",
    expectedTool: 'get_representation',
  },
  {
    id: 'email-content-search',
    userPrompt: 'Find the email from Jeff Burton about the NDAA amendment from a few weeks ago.',
    expectedTool: 'search_emails',
    forbiddenTools: ['list_emails'],
    note: 'An older, specific message needs the search tool, not the recency-capped list.',
  },
  {
    id: 'upcoming-meetings',
    userPrompt: 'What meetings do I have coming up this week?',
    expectedTool: 'list_upcoming_meetings',
  },
  {
    id: 'lda-filings',
    userPrompt: 'Pull the LDA lobbying disclosure filings for Lockheed Martin.',
    expectedTool: 'search_lda_filings',
  },
  {
    id: 'sam-opportunities',
    userPrompt: 'Search SAM.gov for active contract opportunities in naval shipbuilding.',
    expectedTool: 'search_sam_opportunities',
  },
  {
    id: 'committee-hearings',
    userPrompt: 'Are there any upcoming hearings on defense appropriations?',
    expectedTool: 'search_committee_hearings',
  },
  {
    id: 'save-memory',
    userPrompt: 'Please remember that I always want bullet-point summaries, never prose.',
    expectedTool: 'save_memory',
  },
  {
    id: 'make-word-doc',
    userPrompt: 'Turn that into a downloadable Word memo I can send to the client.',
    expectedTool: 'create_word',
  },
  {
    id: 'no-tool-acknowledgement',
    userPrompt: 'Thanks, that is exactly what I needed — really helpful.',
    expectedTool: null,
    note: 'A pure acknowledgement should elicit a reply, not a tool call.',
  },
];
