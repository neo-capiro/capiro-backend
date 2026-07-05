import type { DelegatedToolSpec } from '@capiro/meriv2-core';

/**
 * The read-only tool catalog the orchestrator registers as DELEGATED tools
 * (executed via apps/api's /api/clio/tools/:name). Names + descriptions are
 * transcribed verbatim from apps/api's TOOL_DEFINITIONS (meri-tools.service.ts)
 * so the model sees identical descriptions on either surface; a drift test
 * (delegated-tools.catalog.spec.ts) asserts the set matches the in-editor
 * allowlist.
 *
 * Scope: exactly the 24 read-only tools the in-editor assistant allows
 * (workspace-assistant.service.ts ASSISTANT_TOOLS). All readOnly:true — no write
 * tool is delegated here (writes must go through the compliance gate before any
 * delegated call, added deliberately when write surfaces are ported).
 */
export const IN_EDITOR_DELEGATED_TOOLS: readonly DelegatedToolSpec[] = [
  {
    name: 'get_client_context',
    description:
      'Load authorized Capiro client context: recent meetings, threads, contacts, and tasks, plus the client profile (capabilities, key people, facilities, submission history).',
    readOnly: true,
  },
  {
    name: 'search_client_knowledge',
    description:
      'Semantic search over one client\'s knowledge base: profile/overview facts, key people (titles, roles, contact history), facilities (locations, congressional districts, headcount), and uploaded document contents. Use this FIRST for questions about a specific client ("who at X handles Y", "summarize the uploaded doc", "which districts have X facilities"). Returns typed, citable knowledge-base entries.',
    readOnly: true,
  },
  {
    name: 'search_research_sources',
    description: 'Search authorized Capiro clients, meetings, mail, notes, and directory notes.',
    readOnly: true,
  },
  {
    name: 'read_client_documents',
    description:
      'List the documents uploaded in a client\'s Documents tab, and (when documentId is given) extract and return the text content of one document so you can read, summarize, or quote it. Supports .txt, .csv, .docx, .pdf, .xlsx, .pptx, and audio/video transcription. Use when the user references "the document/file I uploaded", a contract, a brief, a deck, or asks you to read/summarize an attached file for a client.',
    readOnly: true,
  },
  {
    name: 'query_intelligence',
    description:
      'Query federal lobbying intelligence: surging LDA issues, trending topics, recent congressional bills, federal spending data, and counts of available intelligence data sources (SEC filings, FARA registrations, GAO reports, grants, hearings, state bills, CRS reports, news articles, economic data). Optionally filter by a client name for contractor spending.',
    readOnly: true,
  },
  {
    name: 'query_knowledge_graph',
    description:
      "Explore the firm's institutional-memory knowledge graph: the connected web of clients, bills, issues, people, offices, meetings, email threads, and memories. Use for relationship questions like \"what's our full history with this client/office\", \"what is everything connected to bill X\", or \"what do we know around issue Y\". Pass a seed node (e.g. 'client:<id>', 'bill:119-hr-1234', 'issue:SHIP') to get its neighborhood, or omit to get an overview. Edges are tagged fact (from firm data) vs mention (from analyst notes). Tenant + own-private scoped.",
    readOnly: true,
  },
  {
    name: 'find_path_to',
    description:
      "Find the warm-introduction routes from your clients to a target office or person in the knowledge graph (\"who do we already know near the Senate Defense Approps subcommittee?\"). Pass a target node id (e.g. 'office:<id>' or 'person:<id>'); returns the shortest connection paths so you can see which client/person gets you there. Tenant + own-private scoped.",
    readOnly: true,
  },
  {
    name: 'search_intel_articles',
    description:
      'Search aggregated policy news and intelligence articles from sources like Roll Call, The Hill, Axios, Politico, Brookings, and agency press. Filter by keyword, source, or topic.',
    readOnly: true,
  },
  {
    name: 'search_congress_bills',
    description:
      'Search congressional bills in the Capiro database (118th and 119th Congress). Filter by keyword, policy area, congress number, or recent activity date. Returns bill title, sponsor, latest action, policy area, and cosponsors count.',
    readOnly: true,
  },
  {
    name: 'search_tracked_bills',
    description:
      "List the bills the firm is actively tracking for a client, with each bill's latest status and the note attached when it was pinned.",
    readOnly: true,
  },
  {
    name: 'search_lda_filings',
    description:
      'Search LDA lobbying disclosure filings in the Capiro database. Filter by client name, registrant, issue area, or keyword.',
    readOnly: true,
  },
  {
    name: 'search_committee_hearings',
    description:
      'Search congressional committee hearings, markups, and meetings. Filter by committee name, chamber (House/Senate/Joint), keyword, or date range.',
    readOnly: true,
  },
  {
    name: 'search_crs_reports',
    description:
      'Search Congressional Research Service (CRS) reports and analyses. Filter by keyword, topic, or author.',
    readOnly: true,
  },
  {
    name: 'search_gao_reports',
    description:
      'Search GAO (Government Accountability Office) reports and testimonies. Filter by keyword, report type, topic, or agency. Returns title, report type, date, topics, and recommendations count.',
    readOnly: true,
  },
  {
    name: 'query_regulatory_dockets',
    description:
      'List regulatory dockets / rulemaking documents from Regulations.gov, or upcoming open comment-period deadlines. Filter by agency or document type. Use for "what comment periods are closing soon".',
    readOnly: true,
  },
  {
    name: 'search_federal_awards',
    description:
      'Search federal contract awards/obligations (USAspending) the firm has synced. Filter by keyword, awarding agency, or Program Element (PE) code. Returns contractor, agency, amount, description, PE code, and place-of-performance — useful for defense-contracting and PE-linked questions.',
    readOnly: true,
  },
  {
    name: 'search_program_elements',
    description:
      'Search DoD Program Elements (PEs) — the RDT&E/procurement budget lines from the Pentagon J-books. Filter by military service, budget activity, or title keyword. Returns PE code, title, service, budget activity, appropriation type, status, and whether the PE has budget/award/bill data. Use get_program_element / get_pe_budget_timeline for detail.',
    readOnly: true,
  },
  {
    name: 'get_program_element',
    description:
      "Get a single DoD Program Element's full detail by PE code: title, description, service, appropriation type, status, ACAT level, program of record, source-document URLs, and complete fiscal-year budget history.",
    readOnly: true,
  },
  {
    name: 'get_pe_budget_timeline',
    description:
      "Get a Program Element's fiscal-year budget timeline by PE code: per-FY president's request, House/Senate authorization and appropriations marks (HASC/SASC/HAC-D/SAC-D), conference, and enacted amounts, plus milestones and conference-probability predictions.",
    readOnly: true,
  },
  {
    name: 'get_pe_contractors',
    description:
      'Get the top contractors linked to a Program Element over the last ~24 months, by direct PE tag or DoD acquisition-program code. Note: PE-to-contractor linkage is sparse — many PEs return no contractors.',
    readOnly: true,
  },
  {
    name: 'get_pe_bills',
    description:
      'Get congressional bills that reference a Program Element (by PE code), with sponsor, lead committee, and latest action.',
    readOnly: true,
  },
  {
    name: 'search_acquisition_personnel',
    description:
      'Search DoD acquisition personnel — the program managers, contracting officers, PEOs, and program leads who run defense programs. Filter by name (query), military service, organization, role, or linked Program Element (peCode). Returns name, service, organization, title, role, linked PE(s), and source count.',
    readOnly: true,
  },
  {
    name: 'get_acquisition_person',
    description:
      "Get a single DoD acquisition person's full detail by id: name, service, organization, title, role, program of record, linked Program Elements, public profile, and the source citations behind each fact.",
    readOnly: true,
  },
  {
    name: 'query_economic_data',
    description:
      'Query economic indicators from BLS (Bureau of Labor Statistics), Census (ACS district demographics), and BEA (Bureau of Economic Analysis GDP/industry data). Specify data source and parameters like state, district, series, or year.',
    readOnly: true,
  },
] as const;
