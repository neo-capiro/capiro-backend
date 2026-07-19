import type { DelegatedToolSpec } from '@capiro/meriv2-core';

/**
 * The remaining read-only apps/api Meri tools NOT in the in-editor allowlist
 * (delegated-tools.catalog.ts's 26) — the full chat surface's (C4, live since
 * #298) extra read set. Names + descriptions transcribed verbatim from
 * apps/api's TOOL_DEFINITIONS (meri-tools.service.ts); a drift test
 * (full-chat-read-tools.catalog.spec.ts) asserts, together with the other two
 * catalogs, exact name+description coverage of apps/api's full 64-tool surface
 * against the canonical @capiro/shared MERI_TOOL_MANIFEST (W4.6/D-13). State
 * Legislation Platform (Phase 0 S6) added 2 tools HERE (search_state_floor_votes,
 * get_state_legislator); get_state_bill_status and the upgraded search_state_bills
 * moved to the in-editor catalog instead (still reachable from full-chat, which
 * is a superset — in-editor's tools + this file's — not duplicated here, per
 * the strict-disjointness contract the coverage spec enforces). Phase 1 M4.1/
 * M4.2 (50-state analyst) added 3 more HERE (get_committee_roster,
 * get_representation, get_state_rule_status) — all thin reads over
 * already-existing tables/resolvers, no new write surface.
 *
 * All 25 are absent from apps/api's SIDE_EFFECTING_TOOLS set, so all are
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
      'Semantic search over the firm\'s institutional memory (memory items: client hubs, meetings, email threads, distilled Meri sessions, analyst notes). Finds relevant memory by MEANING, not just keywords — use for "what do we know about X", "have we discussed Y before", "find past context on Z". Returns the top matching memory items, each with a relevance score and a `memoryItemId` you can pass to confirm_memory / correct_memory / forget_memory. Tenant + own-private scoped.',
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
    name: 'search_state_floor_votes',
    description:
      "Search state legislature roll-call votes. Filter by bill (canonical id or designation), keyword over the motion text, state, chamber, or limit. Returns each vote's motion, tally, passed/failed result, date, and source link. Member-level filtering is not yet available for state votes (crosswalk hardening in progress) — never promise a member-scoped result. Explicitly reports when NO matching vote exists.",
    readOnly: true,
  },
  {
    name: 'get_state_legislator',
    description:
      'Look up a state legislator by name + state, or by an OpenStates/LegiScan external id. Returns chamber, district, party, and committee memberships. Explicitly reports ambiguous name matches (asks which one) and NO-match cases — never fabricates a legislator.',
    readOnly: true,
  },
  {
    name: 'get_committee_roster',
    description:
      'Get the full roster of ONE committee: chair, vice chair, ranking member, and every member (grouped by side/rank for federal; role for state — state chambers do not share a minority-leadership vocabulary). `jurisdiction` is required (federal and state committees are separate namespaces — never guessed from the committee string alone); `state` is required when jurisdiction=state. Matches by exact systemCode/committee id first, then by name — reports "committee referral unmatched" rather than guessing when the name matches zero or more than one committee.',
    readOnly: true,
  },
  {
    name: 'get_representation',
    description:
      "Who represents a client's facility footprint — the federal House member + both senators and the state upper/lower legislators for each of the client's geocoded facilities (optionally filtered to one state). Deterministic join over the geocoded district (District Impact Engine) — never a language-model guess at which district contains an address. Explicitly reports an ungeocoded facility rather than guessing its representative.",
    readOnly: true,
  },
  {
    name: 'list_members',
    description:
      'List CURRENT members of Congress by state and/or chamber — the direct roster lookup for questions like "who are the senators from Virginia?" or "which representatives are from Florida?". `state` accepts a full name ("Virginia") or 2-letter code ("VA"); `chamber` is "house" or "senate"; at least one of the two is required. Returns each member: name, party, state, district (House only), and chamber. This is the authoritative federal member roster — use it instead of resolve_entity (a name resolver) for by-state or by-chamber listings. Explicitly reports when NO members match; never fabricate a member.',
    readOnly: true,
  },
  {
    name: 'get_state_rule_status',
    description:
      'Look up ONE rule/notice\'s status and lifecycle stage — state agency register or Federal Register, whichever matches. Accepts an exact id ("FL-31100933", or a Federal Register document number like "2026-01234") or a title keyword; `state` scopes a keyword search to that state\'s register (omit to also search federal + other states). Stage (notice/nprm/comment_closed/final/effective) is derived deterministically from the rule\'s type and comment/effective dates — never guessed. Explicitly reports ambiguous keyword matches (asks which one) and NO-match cases — never fabricates a rule\'s status.',
    readOnly: true,
  },
  {
    name: 'search_cbo_cost_estimates',
    description:
      'Look up CBO cost estimates (budget scores) for congressional bills in the Capiro database. Filter by bill id ("119-hr-8800") or keyword. Returns the estimate title, publication date, and cbo.gov link. Explicitly reports when NO estimate exists for a bill — never guess a score.',
    readOnly: true,
  },
  {
    name: 'resolve_entity',
    description:
      'Resolve a member of Congress, congressional committee, or bill to its CANONICAL identity in the Capiro registry (Bioguide ID, committee systemCode, or bill id like "119-hr-8800"). Accepts a canonical id, an external id (LIS, FEC, OpenSecrets, GovTrack), a bill designation ("H.R. 8800"), or a name. Use this BEFORE citing any member, committee, or bill to ground the reference — it explicitly reports when NO entity matches; never fabricate an identifier.',
    readOnly: true,
  },
  {
    name: 'get_bill_status',
    description:
      'Get the authoritative legislative status of ONE bill (by id "119-hr-8800" or designation "H.R. 8800"): its canonical status, recent action timeline, roll-call VOTES on the bill (with tallies + party splits), and — critically — the outcome of any RULE that governs its floor consideration. Use this to answer "did it pass / advance / stall / what happened to it". A bill whose latest action is only "rule reported" but whose rule FAILED is reported as stalled, not advancing. Explicitly states when there is NO recorded floor vote — never infer passage.',
    readOnly: true,
  },
  {
    name: 'search_floor_votes',
    description:
      "Search congressional roll-call votes (House + Senate) in the Capiro database. Filter by bill (id/designation), keyword over the vote question/title, chamber, congress, or a specific member (Bioguide id or name). Returns each vote's question, result, yea/nay/present tally, party splits, date, and source link — and the member's own position when a member is given. Explicitly reports when NO matching roll call exists; never infer a vote outcome.",
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
      "List the user's MOST RECENT synced email threads (Microsoft 365/Google), newest first, optionally filtered by client. Reaches at most the newest 50 threads — older mail is invisible to this tool; to find a specific message, sender, or topic anywhere in synced mail use search_emails.",
    readOnly: true,
  },
  {
    name: 'lookup_client_registry',
    description:
      "Pre-create check for a prospective client name — ALWAYS call this BEFORE proposing create_client. Reports (1) whether a client with that name already exists in the firm's book of business, (2) the LDA lobbying-disclosure registry's exact match if any (create_client will link it automatically), and (3) close LDA candidates otherwise — relay those to the user and ask which registered entity applies (pass the chosen id as create_client's `ldaClientId`) or none (`skipLdaCheck: true`). Read-only; creates nothing.",
    readOnly: true,
  },
  {
    name: 'search_emails',
    description:
      "Search the user's synced email (Microsoft 365/Google) by content or people — reaches mail of ANY age, unlike list_emails. Provide at least one of: `query` (matched against subject, sender, recipients, and the stored message preview), `from` (sender email or name fragment), `participant` (email or name fragment matched against sender AND to/cc/bcc recipients). Optional: `clientId`, `withinDays` (only messages from the last N days), `limit` (default 20, max 50). Returns matching messages newest-first (subject, from, to/cc, date, folder, preview, threadId — pass threadId to reply_email), the total match count, and a coverage report of every searched mailbox (sync status + date range; a connected-but-never-synced mailbox is called out). IMPORTANT: bodies are stored as short previews and some folders never sync (junk/deleted/drafts on Microsoft 365; Google currently syncs only inbox and sent labels), so report a miss as 'not found in synced mail' — never as proof the email does not exist.",
    readOnly: true,
  },
  {
    name: 'list_upcoming_meetings',
    description:
      "List the user's upcoming meetings from the connected calendar (synced Microsoft 365/Google events), soonest first — the source of truth for which meetings exist and when. Returns each meeting's id (pass to create_meeting_brief), subject, start/end, attendees, and client. Optionally filter by client or a lookahead window.",
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
  {
    name: 'get_pe_report_language',
    description:
      "Get the VERBATIM congressional committee report language linked to a budget line (by code): the committee, fiscal year, heading, provision text, action type, and source URL. This is the ONLY source that explains WHY a mark was added/cut. If it returns no provisions, the justification is NOT in Capiro's data — say so; do NOT infer or invent a reason for a mark change from the PE's title or the dollar delta alone.",
    readOnly: true,
  },
] as const;
