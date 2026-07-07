import type { DelegatedToolSpec } from '@capiro/meriv2-core';

/**
 * The remaining read-only apps/api Meri tools NOT in the in-editor allowlist
 * (delegated-tools.catalog.ts's 24) — the full chat surface's (C4, live since
 * #298) extra read set. Names + descriptions transcribed verbatim from
 * apps/api's TOOL_DEFINITIONS (meri-tools.service.ts); a drift test
 * (full-chat-read-tools.catalog.spec.ts) asserts, together with the other two
 * catalogs, exact coverage of apps/api's full 55-tool surface.
 *
 * All 17 are absent from apps/api's SIDE_EFFECTING_TOOLS set, so all are
 * readOnly:true here too (the C-workstream rule: this classification MUST
 * match apps/api's, since a delegated write registered readOnly would bypass
 * the B1 gate).
 */
export const FULL_CHAT_READ_TOOLS: readonly DelegatedToolSpec[] = [
  {
    name: 'run_analysis',
    description:
      'Execute Python (pandas/numpy/matplotlib) in a locked-down sandbox for real computation: aggregations, year-over-year deltas, joins, and charts over data you already retrieved with other tools. Pass small datasets inline as rows; read them in code from ./data/<name>.csv. print() findings, assign a `results` dict/list/DataFrame for tables, and matplotlib figures are returned as chart artifacts. No network, no filesystem outside the working directory.',
    readOnly: true,
  },
  {
    name: 'search_memory',
    description:
      'Semantic search over the firm\'s institutional memory (memory items: client hubs, meetings, email threads, distilled Meri sessions, analyst notes). Finds relevant memory by MEANING, not just keywords — use for "what do we know about X", "have we discussed Y before", "find past context on Z". Returns the top matching memory items with a relevance score. Tenant + own-private scoped.',
    readOnly: true,
  },
  {
    name: 'search_sec_filings',
    description:
      'Search SEC EDGAR filings (10-K, 10-Q, 8-K, DEF14A, S-1, etc.) in the Capiro database. Filter by company name, form type, CIK, or date range. Returns company, form type, filing date, and description.',
    readOnly: true,
  },
  {
    name: 'search_fara_registrations',
    description:
      'Search FARA (Foreign Agents Registration Act) registrations. Filter by registrant name, foreign principal, country, or status. Returns registrant, foreign principal, country, and status.',
    readOnly: true,
  },
  {
    name: 'search_federal_grants',
    description:
      'Search federal grant opportunities (NOFOs) from Grants.gov. Filter by agency, keyword, status (posted/closed/forecasted), or date range. Returns title, agency, funding amounts, eligibility, and deadlines.',
    readOnly: true,
  },
  {
    name: 'search_state_bills',
    description:
      'Search state legislature bills via OpenStates data. Filter by state (2-letter code), keyword, subject, or session. Returns identifier, title, sponsor, latest action, and subjects.',
    readOnly: true,
  },
  {
    name: 'search_cbo_cost_estimates',
    description:
      'Look up CBO cost estimates (budget scores) for congressional bills. Filter by bill id ("119-hr-8800") or keyword. Explicitly reports when NO estimate exists — never guess a score.',
    readOnly: true,
  },
  {
    name: 'resolve_entity',
    description:
      'Resolve a member of Congress, congressional committee, or bill to its CANONICAL identity in the Capiro registry (Bioguide ID, committee systemCode, or bill id like "119-hr-8800"). Accepts a canonical id, an external id (LIS, FEC, OpenSecrets, GovTrack), a bill designation ("H.R. 8800"), or a name. Use this BEFORE citing any member, committee, or bill to ground the reference — it explicitly reports when NO entity matches; never fabricate an identifier.',
    readOnly: true,
  },
  {
    name: 'search_public_web',
    description:
      'Search the public web (general results and news) for recent developments. Use this only as supplemental context after Capiro internal data tools for government-affairs answers.',
    readOnly: true,
  },
  {
    name: 'scrape_web_page',
    description:
      'Fetch and extract readable text from a public webpage or PDF URL for grounded analysis (gov sources are PDF-heavy). Blocks localhost/private-network targets.',
    readOnly: true,
  },
  {
    name: 'list_emails',
    description:
      "List recent email threads from the tenant's connected Microsoft 365 inbox, optionally filtered by client.",
    readOnly: true,
  },
  {
    name: 'list_scheduled_tasks',
    description:
      "List the caller's recurring scheduled Meri tasks (name, cadence, next run, enabled state).",
    readOnly: true,
  },
  {
    name: 'query_tasks',
    description:
      'List engagement tasks/to-dos for the firm or a client — filter by status and due date. Use for "what is due, overdue, or open".',
    readOnly: true,
  },
  {
    name: 'query_action_items',
    description:
      'List the firm\'s "Needs Attention" action recommendations for a client or across all clients — each card says what changed, why it matters, and the recommended action with deadline and priority.',
    readOnly: true,
  },
  {
    name: 'search_sam_opportunities',
    description:
      'Search SAM.gov federal contract opportunities (solicitations, sources sought, presolicitations) by keyword or NAICS code. Active notices by default, newest first, with response deadlines and points of contact.',
    readOnly: true,
  },
  {
    name: 'query_debriefs',
    description:
      'List post-meeting debriefs for a client — outcomes, follow-ups, and commitments captured after meetings. Restricted (confidential) debrief bodies are withheld.',
    readOnly: true,
  },
  {
    name: 'query_outreach',
    description:
      "List outreach campaigns and their status (draft, sent, responses) for the firm or a client, or fetch a single outreach record's full detail by outreachId.",
    readOnly: true,
  },
] as const;
