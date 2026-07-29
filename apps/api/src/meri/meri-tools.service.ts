import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EngagementTaskStatus, Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  formatBillId,
  isValidCanonicalId,
  normalizeCanonicalId,
  parseBillDesignation,
  currentCongress,
  billStatusLabel,
  isStateBillKey,
  parseStateBillDesignation,
  stateBillStatusLabel,
  deriveRuleLifecycleStage,
  RULE_LIFECYCLE_STAGES,
  COMMENT_ACCEPTING_STAGES,
  isRuleCommentOpen,
  resolveCommittee,
  normalizeCommitteeName,
  matchesRole,
  buildSearchRowFundingForModel,
  type CommitteeCandidate,
} from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { IntelligenceService } from '../intelligence/intelligence.service.js';
import { ActionRecommendationReadService } from '../intelligence/actions/action-recommendation-read.service.js';
import type { ActionStatus } from '../intelligence/actions/action-recommendation.types.js';
import {
  ClientCapabilitiesService,
  type CreateCapabilityInput,
} from '../clients/client-capabilities.service.js';
import { ClientPeopleService, type CreatePersonInput } from '../clients/client-people.service.js';
import { MemoryIngestService } from '../memory/memory-ingest.service.js';
import { MemoryCandidateService } from '../memory/memory-candidate.service.js';
import { MemoryStoreService } from '../memory/memory-store.service.js';
import { fetchDeniedClientIds, wallExclusionSql } from '../memory/memory-wall.helpers.js';
import {
  governedRecallSuppressionEnabled,
  governedRecallSuppressionSql,
} from '../memory/memory-recall-suppression.helpers.js';
import { enrichFromKgCache } from '../memory/kg-cache-enrich.helpers.js';
import { pickKgTraversalSource, type KgTraversalSource } from './memory-recall-source.helpers.js';
import {
  ClientFacilitiesService,
  type CreateFacilityInput,
} from '../clients/client-facilities.service.js';
import { ClientsService } from '../clients/clients.service.js';
import { RepresentationResolverService } from '../clients/representation-resolver.service.js';
import { RegulatoryDocketService } from '../regulatory-docket/regulatory-docket.service.js';
import { EngagementMailSender } from '../engagement/mail-sender.service.js';
import { LdaIntelService } from '../lda-intel/lda-intel.service.js';
import { LobbyIntelService } from '../lobby-intel/lobby-intel.service.js';
import { FederalSpendingService } from '../federal-spending/federal-spending.service.js';
import { ProgramElementReadService } from '../program-element/program-element-read.service.js';
import { AcquisitionPersonnelReadService } from '../acquisition-personnel/acquisition-personnel-read.service.js';
import { MeriDocgenService } from './meri-docgen.service.js';
import {
  mimeForFormat,
  normalizeExcelSpec,
  normalizePptxSpec,
  normalizeWordSpec,
  slugifyDocName,
  type DocFormat,
} from './meri-docgen.helpers.js';
import {
  computeNextRunAtAnchored,
  parseTimeOfDayUtc,
  normalizeDeliveryEmail,
  validateScheduleRequest,
} from './meri-schedule.helpers.js';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { MeriFeatureFlagsService } from './meri-feature-flags.service.js';
import {
  validateMeriWriteToolInput,
  type MeriJsonSchema,
} from './meri-write-tool-input.js';
import { buildSavedMemoryRecord } from './meri-memory.helpers.js';
import { budgetExhibitType } from './meri-pe-structural.helpers.js';
import { isValidPeCode, isValidProcurementCode } from '../program-element/jbook/jbook-extract.js';
import { buildWebSearchRequest, normalizeWebResults } from './meri-websearch.helpers.js';
import { looksLikePdf } from './meri-scrape.helpers.js';
import { buildKnowledgeGraph, walkFrom, type FkRelation } from '../memory/memory-graph.helpers.js';
import { embedText, vectorLiteral, normalize } from '../embeddings/embedder.js';
import { ymdInZone } from '../intelligence/time-bounds.js';
import { resolveStateName } from '../common/us-states.js';

const PRODUCT_NAME = 'Meri';

// get_committee_roster (M4.1) title-matching now uses the SHARED matchesRole
// (@capiro/shared, W4.1) — one definition consumed by both this tool and
// chokepoint.service.ts, so both recognize the same Chair/Chairman/Chairwoman/
// Co-Chair/Vice-*/Ranking variants (the old per-site sets missed Chairwoman /
// Co-Chair and could report chair:null when a chair existed).

// Exported for the tool-registration regression spec (meri-tools.registration.spec.ts).
export const TOOL_DEFINITIONS = [
  {
    name: 'get_client_context',
    description:
      'Load authorized Capiro client context: recent meetings, threads, contacts, and tasks, plus the client profile (capabilities, key people, facilities, submission history).',
  },
  {
    name: 'search_research_sources',
    description: 'Search authorized Capiro clients, meetings, mail, notes, and directory notes.',
  },
  {
    name: 'run_analysis',
    description:
      'Execute Python (pandas/numpy/matplotlib) in a locked-down sandbox for real computation: aggregations, year-over-year deltas, joins, and charts over data you already retrieved with other tools. Pass small datasets inline as rows; read them in code from ./data/<name>.csv. print() findings, assign a `results` dict/list/DataFrame for tables, and matplotlib figures are returned as chart artifacts. No network, no filesystem outside the working directory.',
  },
  {
    name: 'search_client_knowledge',
    description:
      'Semantic search over one client\'s knowledge base: profile/overview facts, key people (titles, roles, contact history), facilities (locations, congressional districts, headcount), and uploaded document contents. Use this FIRST for questions about a specific client ("who at X handles Y", "summarize the uploaded doc", "which districts have X facilities"). Returns typed, citable knowledge-base entries.',
  },
  {
    name: 'query_intelligence',
    description:
      'Query federal lobbying intelligence: surging LDA issues, trending topics, recent congressional bills, federal spending data, and counts of available intelligence data sources (SEC filings, FARA registrations, GAO reports, grants, hearings, state bills, CRS reports, news articles, economic data). Optionally filter by a client name for contractor spending.',
  },
  {
    name: 'query_knowledge_graph',
    description:
      "Explore the firm's institutional-memory knowledge graph: the connected web of clients, bills, issues, people, offices, meetings, email threads, and memories. Use for relationship questions like \"what's our full history with this client/office\", \"what is everything connected to bill X\", or \"what do we know around issue Y\". Pass a seed node (e.g. 'client:<id>', 'bill:119-hr-1234', 'issue:SHIP') to get its neighborhood, or omit to get an overview. Edges are tagged fact (from firm data) vs mention (from analyst notes). Tenant + own-private scoped.",
  },
  {
    name: 'find_path_to',
    description:
      "Find the warm-introduction routes from your clients to a target office or person in the knowledge graph (\"who do we already know near the Senate Defense Approps subcommittee?\"). Pass a target node id (e.g. 'office:<id>' or 'person:<id>'); returns the shortest connection paths so you can see which client/person gets you there. Tenant + own-private scoped.",
  },
  {
    name: 'search_memory',
    description:
      'Semantic search over the firm\'s institutional memory (memory items: client hubs, meetings, email threads, distilled Meri sessions, analyst notes). Finds relevant memory by MEANING, not just keywords — use for "what do we know about X", "have we discussed Y before", "find past context on Z". Returns the top matching memory items, each with a relevance score and a `memoryItemId` you can pass to confirm_memory / correct_memory / forget_memory. Tenant + own-private scoped.',
  },
  {
    name: 'confirm_memory',
    description:
      'Re-affirm that a remembered fact is still true and current, resetting its confirmation date. Use when the user verifies something Meri remembers ("yes, that\'s still right"). Pass the memoryItemId from search_memory. Does not change the content.',
  },
  {
    name: 'correct_memory',
    description:
      'Correct a remembered fact: supersede it with new content while preserving the prior version as history. The old memory is retired from recall and the new one takes its place. Use when the user says a remembered fact is wrong or outdated ("actually it\'s X now"). Pass the memoryItemId from search_memory plus the corrected content.',
  },
  {
    name: 'forget_memory',
    description:
      "Forget a remembered fact: stop recalling it immediately and remove it from Meri's memory (a recoverable soft-delete with an audit trail). Use when the user asks Meri to forget something. Pass the memoryItemId from search_memory. Refuses if the item is under a legal hold.",
  },
  {
    name: 'search_congress_bills',
    description:
      'Search congressional bills in the Capiro database (118th and 119th Congress). Filter by keyword, policy area, congress number, or recent activity date. Accepts a bill designation or id ("H.R. 8800", "119-hr-8800") as the query for a direct lookup. Returns bill title, sponsor, latest action, canonical STATUS (e.g. rule_failed, passed_chamber), policy area, and cosponsors count.',
  },
  {
    name: 'get_bill_status',
    description:
      'Get the authoritative legislative status of ONE bill (by id "119-hr-8800" or designation "H.R. 8800"): its canonical status, recent action timeline, roll-call VOTES on the bill (with tallies + party splits), and — critically — the outcome of any RULE that governs its floor consideration. Use this to answer "did it pass / advance / stall / what happened to it". A bill whose latest action is only "rule reported" but whose rule FAILED is reported as stalled, not advancing. Explicitly states when there is NO recorded floor vote — never infer passage.',
  },
  {
    name: 'search_floor_votes',
    description:
      "Search congressional roll-call votes (House + Senate) in the Capiro database. Filter by bill (id/designation), keyword over the vote question/title, chamber, congress, or a specific member (Bioguide id or name). Returns each vote's question, result, yea/nay/present tally, party splits, date, and source link — and the member's own position when a member is given. Explicitly reports when NO matching roll call exists; never infer a vote outcome.",
  },
  {
    name: 'search_cbo_cost_estimates',
    description:
      'Look up CBO cost estimates (budget scores) for congressional bills in the Capiro database. Filter by bill id ("119-hr-8800") or keyword. Returns the estimate title, publication date, and cbo.gov link. Explicitly reports when NO estimate exists for a bill — never guess a score.',
  },
  {
    name: 'resolve_entity',
    description:
      'Resolve a member of Congress, congressional committee, or bill to its CANONICAL identity in the Capiro registry (Bioguide ID, committee systemCode, or bill id like "119-hr-8800"). Accepts a canonical id, an external id (LIS, FEC, OpenSecrets, GovTrack), a bill designation ("H.R. 8800"), or a name. Use this BEFORE citing any member, committee, or bill to ground the reference — it explicitly reports when NO entity matches; never fabricate an identifier.',
  },
  {
    name: 'search_lda_filings',
    description:
      'Search LDA lobbying disclosure filings in the Capiro database. Filter by client name, registrant, issue area, or keyword.',
  },
  {
    name: 'search_sec_filings',
    description:
      'Search SEC EDGAR filings (10-K, 10-Q, 8-K, DEF14A, S-1, etc.) in the Capiro database. Filter by company name, form type, CIK, or date range. Returns company, form type, filing date, and description.',
  },
  {
    name: 'search_fara_registrations',
    description:
      'Search FARA (Foreign Agents Registration Act) registrations. Filter by registrant name, foreign principal, country, or status. Returns registrant, foreign principal, country, and status.',
  },
  {
    name: 'search_federal_grants',
    description:
      'Search federal grant opportunities (NOFOs) from Grants.gov. Filter by agency, keyword, status (posted/closed/forecasted), or date range. Returns title, agency, funding amounts, eligibility, and deadlines.',
  },
  {
    name: 'search_federal_awards',
    description:
      'Search federal contract awards/obligations (USAspending) the firm has synced. Filter by keyword, awarding agency, or Program Element (PE) code. Returns contractor, agency, amount, description, PE code, and place-of-performance — useful for defense-contracting and PE-linked questions.',
  },
  {
    name: 'search_gao_reports',
    description:
      'Search GAO (Government Accountability Office) reports and testimonies. Filter by keyword, report type, topic, or agency. Returns title, report type, date, topics, and recommendations count.',
  },
  {
    name: 'search_state_bills',
    description:
      'Search state legislature bills (LegiScan is the source of record; OpenStates cross-checks). Filter by state (2-letter code), keyword, subject, session, or canonical STATUS. Returns identifier, title, sponsor, latest action, canonical status, sponsor count, and links. Explicitly reports when NO bill matches.',
  },
  {
    name: 'get_state_bill_status',
    description:
      'Get the authoritative legislative status of ONE state bill (by canonical id "tx-2025-hb1234" or a designation like "TX HB 1234" — state required if not embedded in the designation): its canonical status (introduced/committee/reported/floor/passed_chamber/resolving/to_governor/enacted/vetoed/veto_overridden/failed/dead_by_deadline), recent action timeline, roll-call votes, and companion-bill links with their status. Explicitly states when there is NO recorded vote (never infer passage) and when the bill is dead_by_deadline (session adjourned sine die — dead absent a special session).',
  },
  {
    name: 'search_state_floor_votes',
    description:
      "Search state legislature roll-call votes. Filter by bill (canonical id or designation), keyword over the motion text, state, chamber, or limit. Returns each vote's motion, tally, passed/failed result, date, and source link. Member-level filtering is not yet available for state votes (crosswalk hardening in progress) — never promise a member-scoped result. Explicitly reports when NO matching vote exists.",
  },
  {
    name: 'get_state_legislator',
    description:
      'Look up a state legislator by name + state, or by an OpenStates/LegiScan external id. Returns chamber, district, party, and committee memberships. Explicitly reports ambiguous name matches (asks which one) and NO-match cases — never fabricates a legislator.',
  },
  {
    name: 'get_committee_roster',
    description:
      'Get the full roster of ONE committee: chair, vice chair, ranking member, and every member (grouped by side/rank for federal; role for state — state chambers do not share a minority-leadership vocabulary). `jurisdiction` is required (federal and state committees are separate namespaces — never guessed from the committee string alone); `state` is required when jurisdiction=state. Matches by exact systemCode/committee id first, then by name — reports "committee referral unmatched" rather than guessing when the name matches zero or more than one committee.',
  },
  {
    name: 'get_representation',
    description:
      "Who represents a client's facility footprint — the federal House member + both senators and the state upper/lower legislators for each of the client's geocoded facilities (optionally filtered to one state). Deterministic join over the geocoded district (District Impact Engine) — never a language-model guess at which district contains an address. Explicitly reports an ungeocoded facility rather than guessing its representative.",
  },
  {
    name: 'list_members',
    description:
      'List CURRENT members of Congress by state and/or chamber — the direct roster lookup for questions like "who are the senators from Virginia?" or "which representatives are from Florida?". `state` accepts a full name ("Virginia") or 2-letter code ("VA"); `chamber` is "house" or "senate"; at least one of the two is required. Returns each member: name, party, state, district (House only), and chamber. This is the authoritative federal member roster — use it instead of resolve_entity (a name resolver) for by-state or by-chamber listings. Explicitly reports when NO members match; never fabricate a member.',
  },
  {
    name: 'get_state_rule_status',
    description:
      'Look up ONE rule/notice\'s status and lifecycle stage — state agency register or Federal Register, whichever matches. Accepts an exact id ("FL-31100933", or a Federal Register document number like "2026-01234") or a title keyword; `state` scopes a keyword search to that state\'s register (omit to also search federal + other states). Stage (notice/nprm/comment_closed/final/effective) is derived deterministically from the rule\'s type and comment/effective dates — never guessed. Explicitly reports ambiguous keyword matches (asks which one) and NO-match cases — never fabricates a rule\'s status.',
  },
  {
    name: 'search_intel_articles',
    description:
      'Search aggregated policy news and intelligence articles from sources like Roll Call, The Hill, Axios, Politico, Brookings, and agency press. Filter by keyword, source, or topic.',
  },
  {
    name: 'search_committee_hearings',
    description:
      'Search congressional committee hearings, markups, and meetings. Filter by committee name, chamber (House/Senate/Joint), keyword, or date range.',
  },
  {
    name: 'search_crs_reports',
    description:
      'Search Congressional Research Service (CRS) reports and analyses. Filter by keyword, topic, or author.',
  },
  {
    name: 'query_economic_data',
    description:
      'Query economic indicators from BLS (Bureau of Labor Statistics), Census (ACS district demographics), and BEA (Bureau of Economic Analysis GDP/industry data). Specify data source and parameters like state, district, series, or year.',
  },
  {
    name: 'search_public_web',
    description:
      'Search the public web (general results and news) for recent developments. Use this only as supplemental context after Capiro internal data tools for government-affairs answers.',
  },
  {
    name: 'scrape_web_page',
    description:
      'Fetch and extract readable text from a public webpage or PDF URL for grounded analysis (gov sources are PDF-heavy). Blocks localhost/private-network targets.',
  },
  {
    name: 'create_meeting_brief',
    description:
      'Create and persist a deterministic meeting brief artifact from authorized Capiro data.',
  },
  {
    name: 'draft_policy_memo',
    description: 'Create and persist a policy memo artifact from authorized Capiro client context.',
  },
  {
    name: 'save_note',
    description: 'Save a user-scoped Meri note and optionally an encrypted Capiro meeting note.',
  },
  {
    name: 'send_email',
    description:
      "Send an email via the tenant's connected Microsoft 365 account on behalf of Meri.",
  },
  {
    name: 'list_emails',
    description:
      "List the user's MOST RECENT synced email threads (Microsoft 365/Google), newest first, optionally filtered by client. Reaches at most the newest 50 threads — older mail is invisible to this tool; to find a specific message, sender, or topic anywhere in synced mail use search_emails.",
  },
  {
    name: 'search_emails',
    description:
      "Search the user's synced email (Microsoft 365/Google) by content or people — reaches mail of ANY age, unlike list_emails. Provide at least one of: `query` (matched against subject, sender, recipients, and the stored message preview), `from` (sender email or name fragment), `participant` (email or name fragment matched against sender AND to/cc/bcc recipients). Optional: `clientId`, `withinDays` (only messages from the last N days), `limit` (default 20, max 50). Returns matching messages newest-first (subject, from, to/cc, date, folder, preview, threadId — pass threadId to reply_email), the total match count, and a coverage report of every searched mailbox (sync status + date range; a connected-but-never-synced mailbox is called out). IMPORTANT: bodies are stored as short previews and junk/spam, deleted/trash, and drafts folders never sync, so report a miss as 'not found in synced mail' — never as proof the email does not exist.",
  },
  {
    name: 'list_upcoming_meetings',
    description:
      "List the user's upcoming meetings from the connected calendar (synced Microsoft 365/Google events), soonest first — the source of truth for which meetings exist and when. Returns each meeting's id (pass to create_meeting_brief), subject, start/end, attendees, and client. Optionally filter by client or a lookahead window.",
  },
  {
    name: 'reply_email',
    description:
      "Reply to an email thread via the tenant's connected Microsoft 365 account on behalf of Meri.",
  },
  {
    name: 'save_memory',
    description:
      "Persist a durable fact or preference the user shares (a nickname, reporting style, ongoing priority, etc.) to Meri's long-term memory so it is recalled in future conversations. Use this whenever the user asks you to remember something.",
  },
  {
    name: 'search_program_elements',
    description:
      'Search DoD budget lines from the Pentagon J-books. NOTE: this table holds BOTH R-1 RDT&E Program Elements AND P-1 procurement line items — each row\'s `budgetExhibitType` / `appropriationType` tells you which; a procurement line is NOT a "Program Element", so state its exhibit type accordingly. Filter by military service, budget activity, or title keyword. Returns code, title, service, budget activity, appropriation type, exhibit type, and whether it has budget/award/bill data. For near-identical sibling titles (e.g. multiple "Target Systems Development" lines) prefer scoped filters (service + budget activity) over a single keyword sweep, and raise the limit — the default may truncate. Use get_program_element / get_pe_budget_timeline for detail.',
  },
  {
    name: 'get_program_element',
    description:
      "Get a single DoD budget line's full detail by code: title, description, service, appropriation type, `budgetExhibitType` (P-1 procurement line item vs R-1 RDT&E Program Element), status, ACAT level, program of record, source-document URLs, and complete fiscal-year budget history.",
  },
  {
    name: 'get_pe_budget_timeline',
    description:
      "Get a budget line's fiscal-year timeline by code. Returns `budgetExhibitType`, `currentCycleFy` (the live budget-cycle FY), and per-FY: president's request, HASC/SASC/HAC-D/SAC-D marks, conference, enacted, PLUS a `cycle` label ('current' = the live request/markup year; 'outyear' = an FYDP projection you must NOT quote as 'the request'; 'historical' = a prior year) and `current`/`currentStageLabel` (the authoritative value for that FY and which stage it came from). Always cite the 'current'-cycle FY as the request; never present an 'outyear' figure as the current ask.",
  },
  {
    name: 'get_pe_contractors',
    description:
      'Get the top contractors linked to a Program Element over the last ~24 months, by direct PE tag or DoD acquisition-program code. Note: PE-to-contractor linkage is sparse — many PEs return no contractors.',
  },
  {
    name: 'get_pe_bills',
    description:
      'Get congressional bills that reference a Program Element (by PE code), with sponsor, lead committee, and latest action.',
  },
  {
    name: 'get_pe_report_language',
    description:
      "Get the VERBATIM congressional committee report language linked to a budget line (by code): the committee, fiscal year, heading, provision text, action type, and source URL. This is the ONLY source that explains WHY a mark was added/cut. If it returns no provisions, the justification is NOT in Capiro's data — say so; do NOT infer or invent a reason for a mark change from the PE's title or the dollar delta alone.",
  },
  {
    name: 'search_acquisition_personnel',
    description:
      'Search DoD acquisition personnel — the program managers, contracting officers, PEOs, and program leads who run defense programs. Filter by name (query), military service, organization, role, or linked Program Element (peCode). Returns name, service, organization, title, role, linked PE(s), and source count.',
  },
  {
    name: 'get_acquisition_person',
    description:
      "Get a single DoD acquisition person's full detail by id: name, service, organization, title, role, program of record, linked Program Elements, public profile, and the source citations behind each fact.",
  },
  {
    name: 'find_contacts',
    description:
      "Find REAL people the firm actually corresponds with, harvested from the connected Outlook/Gmail mailboxes and calendars — name, email address, organization, when they were last in contact, and how many messages. Use this INSTEAD of reading names out of list_emails / search_emails previews when you need contacts for a client profile: those previews give you display names with no addresses and no history, which is guesswork. Filter by `clientId` (returns everyone whose email domain matches that client's website, plus anyone already linked to them), by `domain`, or by `query` (name/email substring). `onProfile` tells you who is ALREADY on the client's People tab, so you only propose the ones who are missing. Read-only.",
  },
  {
    name: 'create_word',
    description:
      'Generate a downloadable Microsoft Word (.docx) document from a structured spec (title, optional subtitle, and sections with paragraphs, bullets, and tables). Use when the user asks for a Word doc, memo, report, or briefing as a file.',
  },
  {
    name: 'create_excel',
    description:
      'Generate a downloadable Microsoft Excel (.xlsx) workbook from a structured spec (one or more sheets, each with headers and rows). Use when the user asks for a spreadsheet, data export, or table as a file. Numeric-looking cells are stored as numbers.',
  },
  {
    name: 'create_powerpoint',
    description:
      'Generate a downloadable Microsoft PowerPoint (.pptx) deck from a structured spec (title slide plus content slides with bullets and an optional table per slide). Use when the user asks for a slide deck or presentation.',
  },
  {
    name: 'schedule_task',
    description:
      'Schedule a recurring task for Meri to run automatically on a cadence (e.g. a weekly research brief). Requires a name, an instruction prompt, and intervalMinutes (>=60). Scheduled runs are READ-ONLY research only — they cannot send email or write data. Use when the user asks Meri to do something "every week / daily / on a schedule".',
  },
  {
    name: 'list_scheduled_tasks',
    description:
      "List the caller's recurring scheduled Meri tasks (name, cadence, next run, enabled state).",
  },
  {
    name: 'cancel_scheduled_task',
    description: 'Cancel (disable) a recurring scheduled Meri task by its id.',
  },
  {
    name: 'query_tasks',
    description:
      'List engagement tasks/to-dos for the firm or a client — filter by status and due date. Use for "what is due, overdue, or open".',
  },
  {
    name: 'query_action_items',
    description:
      'List the firm\'s "Needs Attention" action recommendations for a client or across all clients — each card says what changed, why it matters, and the recommended action with deadline and priority.',
  },
  {
    name: 'search_tracked_bills',
    description:
      "List the bills the firm is actively tracking for a client, with each bill's latest status and the note attached when it was pinned.",
  },
  {
    name: 'query_regulatory_dockets',
    description:
      'List regulatory dockets / rulemaking documents from Regulations.gov, or upcoming open comment-period deadlines. Filter by agency or document type. Use for "what comment periods are closing soon".',
  },
  {
    name: 'search_sam_opportunities',
    description:
      'Search SAM.gov federal contract opportunities (solicitations, sources sought, presolicitations) by keyword or NAICS code. Active notices by default, newest first, with response deadlines and points of contact.',
  },
  {
    name: 'query_debriefs',
    description:
      'List post-meeting debriefs for a client — outcomes, follow-ups, and commitments captured after meetings. Restricted (confidential) debrief bodies are withheld.',
  },
  {
    name: 'query_outreach',
    description:
      "List outreach campaigns and their status (draft, sent, responses) for the firm or a client, or fetch a single outreach record's full detail by outreachId.",
  },
  {
    name: 'read_client_documents',
    description:
      'List the documents uploaded in a client\'s Documents tab, and (when documentId is given) extract and return the text content of one document so you can read, summarize, or quote it. Supports .txt, .csv, .docx, .pdf, .xlsx, .pptx, and audio/video transcription. Use when the user references "the document/file I uploaded", a contract, a brief, a deck, or asks you to read/summarize an attached file for a client.',
  },
  {
    name: 'lookup_client_registry',
    description:
      "Pre-create check for a prospective client name — ALWAYS call this BEFORE proposing create_client. Reports (1) whether a client with that name already exists in the firm's book of business, (2) the LDA lobbying-disclosure registry's exact match if any (create_client will link it automatically), and (3) close LDA candidates otherwise — relay those to the user and ask which registered entity applies (pass the chosen id as create_client's `ldaClientId`) or none (`skipLdaCheck: true`). Read-only; creates nothing.",
  },
  {
    name: 'create_client',
    description:
      "Create a NEW client record in the firm's book of business. Requires user approval. Call lookup_client_registry FIRST and resolve its findings with the user, then propose this with the resolved inputs: `ldaClientId` for a confirmed LDA registry entity, `skipLdaCheck: true` if the user said none apply, or neither when the name matched exactly / wasn't in the registry. The same checks are re-enforced here as backstops — the action FAILS VISIBLY (creating nothing) on a duplicate client, an unresolved close-match LDA ambiguity, an unknown `ldaClientId`, or the plan's client-slot limit. Required: `name`. Optional: `website`, `description`, `sectorTag`, `primaryContactName`/`primaryContactEmail`/`primaryContactPhone`. When you propose it, ask IN THE SAME MESSAGE whether — once approved — the user also wants the full profile filled via web research and internal data (their website via scrape_web_page, LDA filings, federal awards → update_client_profile).",
  },
  {
    name: 'create_task',
    description:
      'Create an engagement task/follow-up (title, optional client, due date, description). Requires user approval.',
  },
  {
    name: 'update_task',
    description:
      "Update an engagement task's status, due date, or title (e.g. mark done). Requires user approval.",
  },
  {
    name: 'update_client_profile',
    description:
      'Write approved values into a client profile (the Documents/Overview tab fields): ' +
      'name, website, description, productDescription, primaryContactName, primaryContactEmail, ' +
      'primaryContactPhone, sectorTag, issueCodes, uei, cageCode, naicsCodes, pscCodes. ' +
      'You may ALSO append facilities (locations: name, address, city, state, ZIP, ' +
      'congressionalDistrict, employeeCount), capabilities (products/technologies the ' +
      'organization offers: name, type, description, sector), and people (key contacts / ' +
      'personnel: name, title, email, phone, role, lastContact, notes) discovered on the ' +
      "client's website or in filings -- pass them as the facilities[], capabilities[], and " +
      'people[] arrays. These arrays are MERGED, never used to delete existing rows: a person ' +
      'already on the profile (matched on email, else exact name) is updated in place — blank ' +
      'fields are filled and lastContact advances, but values already there are left alone — ' +
      'and a facility/capability whose name is already present is skipped. Re-running enrichment ' +
      'is therefore safe and will NOT duplicate rows; the result reports peopleCreated, ' +
      'peopleUpdated, and skipped separately, so report what actually changed rather than ' +
      'assuming every row you sent was new. Only call this AFTER you have shown the user the ' +
      'proposed values (ideally ' +
      'with a source for each, e.g. from search_public_web / scrape_web_page / LDA filings) and ' +
      'they have approved them. Pass only the fields/rows you are changing. Requires user approval.',
  },
] as const;

type MeriToolName = (typeof TOOL_DEFINITIONS)[number]['name'];

/**
 * Side-effecting (write) tools. These are serialized within a single agentic
 * round so two mutations never race; every other (read-only) tool may run
 * concurrently (P0-2).
 */
const SIDE_EFFECTING_TOOLS: ReadonlySet<string> = new Set<string>([
  'create_meeting_brief',
  'draft_policy_memo',
  'save_note',
  'send_email',
  'reply_email',
  'save_memory',
  'confirm_memory',
  'correct_memory',
  'forget_memory',
  'create_word',
  'create_excel',
  'create_powerpoint',
  'schedule_task',
  'cancel_scheduled_task',
  'create_task',
  'update_task',
  'create_client',
  'update_client_profile',
]);

interface ToolArtifactInput {
  conversationId?: string | null;
  clientId?: string | null;
  title: string;
  kind: string;
  bodyText: string;
  metadata?: Prisma.InputJsonValue;
}

interface MeetingForBrief {
  clientId: string | null;
  subject: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  client: {
    id: string;
    name: string;
    website: string | null;
    productDescription: string | null;
  } | null;
  attendees: Array<{ name: string | null; email: string | null }>;
  preps: Array<{ summary: string | null; talkingPoints: Prisma.JsonValue }>;
  tasks: Array<{ title: string; dueDate: Date | null }>;
}

@Injectable()
export class MeriToolsService {
  private readonly logger = new Logger(MeriToolsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly engagement: EngagementService,
    private readonly mailSender: EngagementMailSender,
    private readonly ldaIntel: LdaIntelService,
    private readonly lobbyIntel: LobbyIntelService,
    private readonly federalSpending: FederalSpendingService,
    private readonly programElement: ProgramElementReadService,
    private readonly acquisitionPersonnel: AcquisitionPersonnelReadService,
    private readonly docgen: MeriDocgenService,
    private readonly actionRecommendations: ActionRecommendationReadService,
    private readonly intelligence: IntelligenceService,
    private readonly regulatoryDockets: RegulatoryDocketService,
    private readonly clientCapabilities: ClientCapabilitiesService,
    private readonly clientPeople: ClientPeopleService,
    private readonly clientFacilities: ClientFacilitiesService,
    private readonly representation: RepresentationResolverService,
    private readonly clientKb: ClientKbService,
    private readonly featureFlags: MeriFeatureFlagsService,
    private readonly clients: ClientsService,
    private readonly memoryIngest: MemoryIngestService,
    private readonly memoryCandidates: MemoryCandidateService,
    private readonly memoryStore: MemoryStoreService,
  ) {}

  manifest() {
    return {
      brand: PRODUCT_NAME,
      tools: TOOL_DEFINITIONS,
    };
  }

  /**
   * Anthropic-native tool definitions for the Meri chat brain. Every tool the
   * model may call on demand during a streamed turn. input_schema is JSON
   * Schema; descriptions come from TOOL_DEFINITIONS so the manifest and the
   * tool-use schemas never drift apart.
   */
  anthropicToolSchemas(): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> {
    const obj = (
      properties: Record<string, unknown>,
      required: string[] = [],
    ): Record<string, unknown> => ({ type: 'object', properties, required });

    const str = (description?: string) =>
      description ? { type: 'string', description } : { type: 'string' };
    const int = (description?: string) =>
      description ? { type: 'integer', description } : { type: 'integer' };

    const schemas: Record<MeriToolName, Record<string, unknown>> = {
      get_client_context: obj({ clientId: str('Client UUID') }, ['clientId']),
      search_research_sources: obj(
        {
          query: str('Free-text search across clients, meetings, mail, notes'),
          clientId: str('Optional client UUID to scope the search'),
          limit: int('Max records (1-25)'),
        },
        ['query'],
      ),
      search_client_knowledge: obj(
        {
          query: str('What to look up in the client knowledge base'),
          clientId: str('Client UUID (defaults to the conversation client)'),
          kind: str(
            'Optional filter: client_profile | client_person | client_facility | client_doc_chunk',
          ),
          limit: int('Max results (1-20)'),
        },
        ['query'],
      ),
      run_analysis: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description:
              'Python to run. Read inline datasets from ./data/<name>.csv; print() findings; assign `results` for a table; matplotlib figures become chart artifacts.',
          },
          datasets: {
            type: 'array',
            description: 'Small datasets to mount read-only (rows from prior tool results).',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'File name (without extension)' },
                rows: {
                  type: 'array',
                  items: { type: 'object' },
                  description: 'Row objects (<=5000)',
                },
              },
              required: ['name', 'rows'],
            },
          },
          purpose: { type: 'string', description: 'One line on what the analysis answers' },
        },
        required: ['code'],
      },
      query_intelligence: obj({
        clientName: str('Optional client name to add federal contracting context'),
      }),
      query_knowledge_graph: obj({
        seed: str(
          "Optional seed node id, e.g. 'client:<uuid>', 'bill:119-hr-1234', 'issue:SHIP'. Omit for a firm-wide overview.",
        ),
        depth: int('How many hops out from the seed (1-4, default 2)'),
      }),
      find_path_to: obj(
        {
          to: str("Target node id, e.g. 'office:<id>' or 'person:<id>'"),
          depth: int('Max search depth (1-5, default 3)'),
        },
        ['to'],
      ),
      search_memory: obj(
        {
          query: str('What to look for in firm memory (natural language)'),
          k: int('Max results (1-15, default 8)'),
        },
        ['query'],
      ),
      confirm_memory: obj(
        {
          memoryItemId: str('The memoryItemId returned by search_memory'),
        },
        ['memoryItemId'],
      ),
      correct_memory: obj(
        {
          memoryItemId: str('The memoryItemId returned by search_memory'),
          newContent: str('The corrected content that should replace the old memory'),
        },
        ['memoryItemId', 'newContent'],
      ),
      forget_memory: obj(
        {
          memoryItemId: str('The memoryItemId returned by search_memory'),
          reason: str('Optional short reason for the audit trail'),
        },
        ['memoryItemId'],
      ),
      search_congress_bills: obj({
        query: str('Keyword search, or a bill designation/id ("H.R. 8800", "119-hr-8800")'),
        policyArea: str('Policy area filter'),
        congress: int('Congress number, e.g. 118 or 119'),
        activeSince: str('ISO date; only bills with action since then'),
        limit: int('Max results (1-50)'),
        page: int('Page number'),
      }),
      get_bill_status: obj(
        {
          billId: str('Bill id ("119-hr-8800") or designation ("H.R. 8800")'),
        },
        ['billId'],
      ),
      search_floor_votes: obj({
        billId: str('Bill id/designation to scope votes to'),
        query: str('Keyword over the vote question/title'),
        member: str('Member Bioguide id ("A000360") or name'),
        chamber: str('"house" or "senate"'),
        congress: int('Congress number filter'),
        limit: int('Max results (1-25, default 10)'),
      }),
      search_cbo_cost_estimates: obj({
        billId: str('Capiro bill id, e.g. "119-hr-8800"'),
        query: str('Keyword search over estimate titles'),
        congress: int('Congress number filter'),
        limit: int('Max results (1-25, default 10)'),
      }),
      resolve_entity: obj(
        {
          query: str(
            'What to resolve: a canonical id ("A000360", "hsag00", "119-hr-8800"), an external id (LIS "S390", FEC, OpenSecrets, GovTrack), a bill designation ("H.R. 8800"), or a person/committee name',
          ),
          type: str('Optional filter: "member", "committee", or "bill"'),
          limit: int('Max matches (1-10, default 5)'),
        },
        ['query'],
      ),
      search_lda_filings: obj({
        clientName: str('Client name filter'),
        registrantName: str('Lobbying registrant filter'),
        issueCode: str('Issue area / code filter'),
        year: int('Filing year'),
        limit: int('Max results (1-50)'),
        page: int('Page number'),
      }),
      search_sec_filings: obj({
        query: str('Company name search'),
        formType: str('Form type, e.g. 10-K, 10-Q, 8-K, DEF 14A, S-1'),
        cik: str('SEC CIK identifier'),
        limit: int('Max results (1-50)'),
      }),
      search_fara_registrations: obj({
        query: str('Search registrant, foreign principal, or description'),
        registrantName: str('Registrant filter'),
        foreignPrincipal: str('Foreign principal filter'),
        country: str('Country filter'),
        status: str('Registration status'),
        limit: int('Max results (1-50)'),
      }),
      search_federal_grants: obj({
        query: str('Keyword search across title/description/agency'),
        agency: str('Agency filter'),
        status: str('posted | closed | forecasted'),
        limit: int('Max results (1-50)'),
      }),
      search_federal_awards: obj({
        query: str('Keyword search across description/contractor/agency'),
        agency: str('Awarding agency filter'),
        peCode: str('Program Element (PE) code filter, e.g. 0604201A'),
        limit: int('Max results (1-50)'),
      }),
      search_gao_reports: obj({
        query: str('Keyword search across title/summary/topics/agencies'),
        reportType: str('Report type filter'),
        limit: int('Max results (1-50)'),
      }),
      search_state_bills: obj({
        query: str('Keyword search'),
        state: str('Two-letter state code'),
        session: str('Legislative session'),
        status: str(
          'Canonical status filter: introduced | committee | reported | floor | passed_chamber | resolving | to_governor | enacted | vetoed | veto_overridden | failed | dead_by_deadline',
        ),
        limit: int('Max results (1-50)'),
      }),
      get_state_bill_status: obj(
        {
          billId: str('Canonical state bill id ("tx-2025-hb1234") or designation ("TX HB 1234")'),
          state: str('Two-letter state code — required if not embedded in the designation'),
        },
        ['billId'],
      ),
      search_state_floor_votes: obj({
        billId: str('Canonical state bill id or designation'),
        query: str('Keyword over the motion text'),
        state: str('Two-letter state code filter'),
        chamber: str('"upper" or "lower"'),
        limit: int('Max results (1-25, default 10)'),
      }),
      get_state_legislator: obj(
        {
          query: str('Legislator name, or an OpenStates/LegiScan external id'),
          state: str('Two-letter state code (recommended when searching by name)'),
          limit: int('Max matches (1-8, default 5)'),
        },
        ['query'],
      ),
      get_committee_roster: obj(
        {
          committee: str('Committee systemCode/id or name, e.g. "Armed Services" or "hsas00"'),
          jurisdiction: str('"federal" or "state" — required, the two are separate namespaces'),
          state: str('Two-letter state code — required when jurisdiction=state'),
          chamber: str('Optional chamber filter: house | senate | upper | lower'),
        },
        ['committee', 'jurisdiction'],
      ),
      get_representation: obj(
        {
          clientId: str('Client UUID'),
          state: str("Optional two-letter state code to filter to that state's facilities"),
        },
        ['clientId'],
      ),
      list_members: obj({
        state: str('State full name ("Virginia") or 2-letter code ("VA")'),
        chamber: str('"house" or "senate"'),
        limit: int('Max members to return (1-100, default 100)'),
      }),
      get_state_rule_status: obj(
        {
          query: str(
            'Rule/notice id ("FL-31100933"), a Federal Register document number ("2026-01234"), or a title keyword',
          ),
          state: str("Two-letter state code — scopes a keyword search to that state's register"),
        },
        ['query'],
      ),
      search_intel_articles: obj({
        query: str('Keyword search'),
        source: str('Source filter, e.g. Roll Call, Politico'),
        limit: int('Max results (1-50)'),
      }),
      search_committee_hearings: obj({
        query: str('Keyword search'),
        chamber: str('House | Senate | Joint'),
        committeeName: str('Committee name filter'),
        limit: int('Max results (1-50)'),
      }),
      search_crs_reports: obj({
        query: str('Keyword search across title/summary/topics/authors'),
        limit: int('Max results (1-50)'),
      }),
      query_economic_data: obj({
        source: str('census | bls | bea'),
        state: str('Two-letter state code'),
        district: str('Congressional district'),
        limit: int('Max results (1-50)'),
      }),
      search_public_web: obj(
        {
          query: str('Search query'),
          limit: int('Max results'),
        },
        ['query'],
      ),
      scrape_web_page: obj(
        {
          url: str('Public http(s) URL to fetch readable text from'),
        },
        ['url'],
      ),
      create_meeting_brief: obj(
        {
          meetingId: str('Meeting UUID'),
          title: str('Optional brief title'),
        },
        ['meetingId'],
      ),
      draft_policy_memo: obj(
        {
          clientId: str('Client UUID'),
          title: str('Memo title'),
          objective: str('Memo objective'),
          body: str('Optional pre-written body'),
        },
        ['clientId'],
      ),
      save_note: obj(
        {
          body: str('Note body'),
          title: str('Optional note title'),
          clientId: str('Optional client UUID'),
          meetingId: str('Optional meeting UUID for an encrypted meeting note'),
          confidential: { type: 'boolean' },
          accessLevel: str('Optional access level'),
        },
        ['body'],
      ),
      send_email: obj(
        {
          to: str('Recipient email address'),
          subject: str('Subject line'),
          body: str('Email body'),
          clientId: str('Optional client UUID to associate with'),
        },
        ['to', 'subject', 'body'],
      ),
      list_emails: obj({
        clientId: str('Optional client UUID filter'),
        limit: int('Max threads (default 15, max 50)'),
      }),
      search_emails: obj({
        query: str(
          'Free-text match over subject, sender, recipients, and the stored message preview',
        ),
        from: str('Sender email or name fragment'),
        participant: str('Email or name fragment matched against sender and to/cc/bcc recipients'),
        clientId: str('Optional client UUID filter'),
        withinDays: int('Only messages from the last N days (default: no limit)'),
        limit: int('Max messages (default 20, max 50)'),
      }),
      list_upcoming_meetings: obj({
        clientId: str('Optional client UUID filter'),
        limit: int('Max meetings (default 10, max 25)'),
        withinDays: int('Only meetings starting within the next N days (default 30, max 365)'),
      }),
      reply_email: obj(
        {
          threadId: str('Mail thread ID to reply to'),
          body: str('Reply body'),
          clientId: str('Optional client UUID'),
        },
        ['threadId', 'body'],
      ),
      save_memory: obj(
        {
          content: str(
            'The fact to remember, as a concise self-contained statement (e.g., "The user prefers to be called Ninja").',
          ),
          key: str('Optional short topic/key, e.g. "nickname" or "reporting-style".'),
          scope: str(
            '"personal" (default — this user only), "firm" (shared across the firm), or "client" (shared for the current client — only valid in a client conversation).',
          ),
          ttlDays: int(
            'Optional: make this EPHEMERAL working memory that expires after N days (1-365) instead of durable memory. Use for task-scoped context ("use once / this week only").',
          ),
        },
        ['content'],
      ),
      search_program_elements: obj({
        query: str('Keyword search on PE title'),
        service: str('Military service filter, e.g. Army, Navy, Air Force, Space Force'),
        budgetActivity: str('Budget activity filter'),
        hasData: {
          type: 'boolean',
          description: 'Only return PEs that have budget/award/bill data',
        },
        limit: int('Max results (1-50)'),
        page: int('Page number'),
      }),
      get_program_element: obj({ peCode: str('Program Element code, e.g. 0604201A') }, ['peCode']),
      get_pe_budget_timeline: obj({ peCode: str('Program Element code') }, ['peCode']),
      get_pe_contractors: obj({ peCode: str('Program Element code') }, ['peCode']),
      get_pe_bills: obj({ peCode: str('Program Element code') }, ['peCode']),
      get_pe_report_language: obj({ peCode: str('Program Element or budget-line code') }, [
        'peCode',
      ]),
      search_acquisition_personnel: obj({
        query: str('Name search (fuzzy)'),
        service: str('Military service filter, e.g. Army, Navy, Air Force, Space Force'),
        organization: str('Organization filter'),
        role: str('Role filter, e.g. PM, KO, PEO'),
        peCode: str('Program Element code the person is linked to'),
        limit: int('Max results (1-50)'),
        page: int('Page number'),
      }),
      get_acquisition_person: obj({ id: str('Acquisition personnel UUID') }, ['id']),
      find_contacts: obj({
        clientId: str('Client UUID (or exact client name) to find correspondents for'),
        domain: str('Email domain filter, e.g. brycetech.com'),
        query: str('Name or email substring'),
        limit: int('Max results (1-100, default 25)'),
      }),
      create_word: obj(
        {
          title: str('Document title'),
          subtitle: str('Optional subtitle'),
          sections: {
            type: 'array',
            description: 'Document sections, each with a heading and content',
            items: obj({
              heading: str('Section heading'),
              paragraphs: {
                type: 'array',
                items: { type: 'string' },
                description: 'Prose paragraphs',
              },
              bullets: {
                type: 'array',
                items: { type: 'string' },
                description: 'Bulleted list items',
              },
              tables: {
                type: 'array',
                description: 'Tables in this section',
                items: obj({
                  headers: { type: 'array', items: { type: 'string' } },
                  rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                }),
              },
            }),
          },
          clientId: str('Optional client UUID to associate'),
        },
        ['title', 'sections'],
      ),
      create_excel: obj(
        {
          title: str('Workbook title'),
          sheets: {
            type: 'array',
            description: 'Worksheets, each with headers and rows',
            items: obj({
              name: str('Sheet name (<=31 chars)'),
              headers: { type: 'array', items: { type: 'string' } },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
            }),
          },
          clientId: str('Optional client UUID to associate'),
        },
        ['title', 'sheets'],
      ),
      create_powerpoint: obj(
        {
          title: str('Deck title'),
          subtitle: str('Optional subtitle for the title slide'),
          slides: {
            type: 'array',
            description: 'Content slides',
            items: obj({
              title: str('Slide title'),
              bullets: { type: 'array', items: { type: 'string' } },
              table: obj({
                headers: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
              }),
            }),
          },
          clientId: str('Optional client UUID to associate'),
        },
        ['title', 'slides'],
      ),
      schedule_task: obj(
        {
          name: str('Short name for the recurring task'),
          prompt: str('The instruction Meri runs each time the task fires'),
          intervalMinutes: int(
            'Minutes between runs (minimum 60). Use 1440 for daily, 10080 for weekly.',
          ),
          dailyAtUtc: str(
            'Optional clock-anchored run time as "HH:MM" in 24h UTC (e.g. "13:00" for 8am ET). When set with intervalMinutes=1440, the task runs every day at that wall-clock time instead of drifting.',
          ),
          clientId: str('Optional client UUID to scope every run to one client'),
          emailBriefing: {
            type: 'boolean',
            description:
              "When true, each finished briefing is ALSO emailed (in addition to the in-app inbox). The email goes to a fixed address set now (deliverEmailTo, or the owner's connected Microsoft 365 address by default) — the task never composes or sends arbitrary email, it only delivers its own briefing to this one pre-set recipient.",
          },
          deliverEmailTo: str(
            "Optional fixed recipient email for the briefing when emailBriefing is true. Defaults to the owner's own connected Microsoft 365 address. Must be a single address the user controls.",
          ),
          toolAllowList: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional read-only research tools the task may call; defaults to all read-only tools. Side-effecting tools are rejected.',
          },
        },
        ['name', 'prompt', 'intervalMinutes'],
      ),
      list_scheduled_tasks: obj({}),
      cancel_scheduled_task: obj({ taskId: str('Scheduled task UUID') }, ['taskId']),
      query_tasks: obj({
        clientId: str('Optional client UUID'),
        status: str('Optional: open | overdue | todo | in_progress | done | blocked | canceled'),
        dueBefore: str('Optional ISO date upper bound on due date'),
        limit: int('Max results (1-50)'),
      }),
      query_action_items: obj({
        clientId: str('Optional client UUID filter'),
        status: str(
          'Optional status: new | triaged | assigned | drafting | ready_for_review | sent_to_client | outreach_completed | monitoring | dismissed | archived',
        ),
        sort: str('Sort order: deadline (default) | priority'),
        limit: int('Max results (1-50)'),
      }),
      search_tracked_bills: obj({ clientId: str('Client UUID') }, ['clientId']),
      query_regulatory_dockets: obj({
        agencyId: str('Optional agency identifier filter, e.g. DOD, EPA'),
        documentType: str('Optional document type filter, e.g. Proposed Rule, Rule, Notice'),
        upcomingOnly: {
          type: 'boolean',
          description: 'Only open comment periods closing within the window (default 30 days)',
        },
        days: int('Window in days for upcomingOnly (1-365, default 30)'),
        limit: int('Max results (1-50)'),
      }),
      search_sam_opportunities: obj({
        query: str('Keyword search across title/description/agency/solicitation number'),
        naics: str('Optional NAICS code prefix filter, e.g. 3364'),
        includeInactive: {
          type: 'boolean',
          description: 'Include archived/inactive notices (default false)',
        },
        limit: int('Max results (1-50)'),
      }),
      query_debriefs: obj({ clientId: str('Client UUID') }, ['clientId']),
      read_client_documents: obj(
        {
          clientId: str('Client UUID whose Documents-tab files to list/read'),
          documentId: str(
            "Optional attachment UUID. When provided, extract and return that document's text content instead of just listing.",
          ),
        },
        ['clientId'],
      ),
      query_outreach: obj({
        outreachId: str('Optional outreach record UUID for full detail'),
        clientId: str('Optional client UUID filter'),
        status: str('Optional status filter, e.g. draft | sent'),
        limit: int('Max results (1-50)'),
      }),
      lookup_client_registry: obj(
        {
          name: str('Prospective client organization name to check'),
        },
        ['name'],
      ),
      create_client: obj(
        {
          name: str('Client organization name'),
          website: str('Client website URL'),
          description: str('What the organization does'),
          sectorTag: str('Sector/industry tag'),
          primaryContactName: str('Primary contact name'),
          primaryContactEmail: str('Primary contact email'),
          primaryContactPhone: str('Primary contact phone'),
          ldaClientId: int(
            'LDA client id the user confirmed from lookup_client_registry candidates',
          ),
          skipLdaCheck: {
            type: 'boolean',
            description:
              'User confirmed none of the LDA candidates apply — create from the provided fields as-is',
          },
        },
        ['name'],
      ),
      create_task: obj(
        {
          title: str('Task title'),
          clientId: str('Optional client UUID'),
          dueDate: str('Optional ISO due date'),
          description: str('Optional task description'),
        },
        ['title'],
      ),
      update_task: obj(
        {
          taskId: str('Task UUID'),
          status: str('Optional new status: todo | in_progress | done | blocked | canceled'),
          dueDate: str('Optional new ISO due date'),
          title: str('Optional new title'),
        },
        ['taskId'],
      ),
      update_client_profile: obj(
        {
          clientId: str('Client UUID to update'),
          name: str('Organization/client name'),
          website: str('Primary website URL'),
          description: str('Short description of the organization'),
          productDescription: str('What the organization makes/does'),
          primaryContactName: str('Primary contact full name'),
          primaryContactEmail: str('Primary contact email'),
          primaryContactPhone: str('Primary contact phone'),
          sectorTag: str('Sector/industry tag'),
          uei: str('SAM.gov Unique Entity ID (12 chars)'),
          cageCode: str('CAGE code (5 chars)'),
          issueCodes: {
            type: 'array',
            items: { type: 'string' },
            description: 'LDA issue codes (replaces the existing list)',
          },
          naicsCodes: {
            type: 'array',
            items: { type: 'string' },
            description: 'NAICS codes (replaces the existing list)',
          },
          pscCodes: {
            type: 'array',
            items: { type: 'string' },
            description: 'PSC codes (replaces the existing list)',
          },
          provenance: {
            type: 'object',
            description:
              'Optional per-field source metadata, e.g. { "website": { "sourceUrl": "https://...", "confidence": "high" } }. ' +
              'Stored on the client for auditability; not shown as a profile field.',
          },
          facilities: {
            type: 'array',
            description:
              'Facilities/locations to APPEND to the client (each becomes a new row on the Facilities tab). ' +
              'Only include what you found and the user approved.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Facility/site name (required)' },
                addressLine: { type: 'string', description: 'Street address' },
                city: { type: 'string', description: 'City' },
                state: { type: 'string', description: 'Two-letter state code, e.g. "TX"' },
                zip: { type: 'string', description: 'ZIP code' },
                congressionalDistrict: {
                  type: 'string',
                  description:
                    'Bare district number, e.g. "12" (state goes in `state`, not "TX-12")',
                },
                employeeCount: {
                  type: 'integer',
                  description: 'Approximate headcount at this site',
                },
                notes: { type: 'string', description: 'Optional notes' },
              },
              required: ['name'],
            },
          },
          capabilities: {
            type: 'array',
            description:
              'Capabilities (products/technologies/services the organization offers) to APPEND ' +
              '(each becomes a new row on the Capabilities tab). Only include what you found and the user approved.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Capability/product name (required)' },
                type: { type: 'string', description: 'e.g. "product", "technology", "service"' },
                description: { type: 'string', description: 'What it is / what it does' },
                sector: { type: 'string', description: 'Sector/domain, e.g. "DEFENSE"' },
                notes: { type: 'string', description: 'Optional notes' },
              },
              required: ['name'],
            },
          },
          people: {
            type: 'array',
            description:
              'Key people / contacts (personnel at the client organization) to APPEND ' +
              '(each becomes a new row on the People tab). Only include what you found and the user approved.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Person full name (required)' },
                title: {
                  type: 'string',
                  description: 'Job title, e.g. "VP of Government Affairs"',
                },
                email: { type: 'string', description: 'Email address' },
                phone: { type: 'string', description: 'Phone number' },
                role: {
                  type: 'string',
                  description: 'Their role relative to the engagement, e.g. "decision-maker"',
                },
                lastContact: {
                  type: 'string',
                  description: 'Date of last contact (ISO date, e.g. "2026-07-01")',
                },
                notes: { type: 'string', description: 'Optional notes' },
              },
              required: ['name'],
            },
          },
        },
        ['clientId'],
      ),
    };

    return TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: schemas[tool.name] ?? obj({}),
    }));
  }

  /**
   * Whether a tool may run concurrently with others in the same agentic round.
   * Read-only tools are safe; side-effecting writes are serialized (P0-2).
   */
  isConcurrencySafe(name: string): boolean {
    return !SIDE_EFFECTING_TOOLS.has(name);
  }

  /**
   * Whether a native tool performs a write / external side effect (send_email,
   * update_client_profile, create_*, save_*, schedule_task, …). The legacy
   * in-process chat uses this to stay READ-ONLY: it must not offer or execute a
   * model-selected write, because — unlike the MeriV2 orchestrator — it has no
   * B1–B4 compliance/approval gate. Writes go through the gated orchestrator or
   * an explicit human action instead.
   */
  isSideEffecting(name: string): boolean {
    return SIDE_EFFECTING_TOOLS.has(name);
  }

  /**
   * Canonical parser shared by proposal creation and actual delegated execution.
   * It rejects unknown/internal authority fields before either persistence or use.
   */
  validateSideEffectingInput(name: string, rawInput: unknown): Record<string, unknown> {
    const normalizedName = normalizeToolName(name);
    if (!this.isSideEffecting(normalizedName)) {
      throw new BadRequestException(`${normalizedName} is not a side-effecting Meri tool`);
    }
    const definition = this.anthropicToolSchemas().find((tool) => tool.name === normalizedName);
    if (!definition) throw new BadRequestException(`Unknown Meri tool: ${normalizedName}`);
    return validateMeriWriteToolInput(
      normalizedName,
      rawInput,
      definition.input_schema as MeriJsonSchema,
    );
  }

  /**
   * Semantic retrieval over one client's knowledge base (F5). Tenant + client
   * scoped; rows come back typed (client_profile / client_person /
   * client_facility / client_doc_chunk) and citable as `client_kb` chips.
   * Fail-soft: an embeddings outage returns an explicit note, never a hang.
   */
  private async searchClientKnowledge(ctx: TenantContext, input: Record<string, unknown>) {
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (!query) throw new BadRequestException('query is required');
    const clientId = typeof input.clientId === 'string' && input.clientId ? input.clientId : null;
    const generatedAt = new Date().toISOString();
    if (!clientId) {
      return {
        tool: 'search_client_knowledge',
        generatedAt,
        results: [],
        note: 'No client is linked to this conversation. Ask the user which client, or pass clientId.',
      };
    }
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true, name: true } }),
    );
    if (!client) throw new NotFoundException('Client not found');
    try {
      const results = await this.clientKb.search(ctx.tenantId, {
        query,
        clientId,
        kind: typeof input.kind === 'string' ? input.kind : undefined,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
      });
      return {
        tool: 'search_client_knowledge',
        generatedAt,
        clientId,
        clientName: client.name,
        query,
        results,
      };
    } catch (err) {
      this.logger.warn(
        `search_client_knowledge failed [${clientId}]: ${err instanceof Error ? err.message : err}`,
      );
      return {
        tool: 'search_client_knowledge',
        generatedAt,
        clientId,
        clientName: client.name,
        query,
        results: [],
        note: 'Knowledge-base search is temporarily unavailable; fall back to get_client_context.',
      };
    }
  }

  // ── run_analysis (F4): sandboxed Python over the no-egress runner ────────

  /** Per-tenant sliding-window rate limit for sandbox runs. */
  private readonly analysisRuns = new Map<string, number[]>();
  private static readonly ANALYSIS_RUNS_PER_HOUR = 20;

  /** Whether run_analysis is live for this tenant (env kill-switch AND
   *  tenant flag; GA default ON — a tenant can opt OUT with
   *  settings_jsonb.clioFeatureFlags.runAnalysis = false). */
  async analysisSandboxEnabled(tenantId: string): Promise<boolean> {
    if (!this.config.get('CLIO_ANALYSIS_SANDBOX_ENABLED', { infer: true })) return false;
    if (!this.config.get('CLIO_SANDBOX_URL', { infer: true })) return false;
    return this.featureFlags.isEnabled(tenantId, 'runAnalysis', true);
  }

  private async runAnalysis(ctx: TenantContext, input: Record<string, unknown>) {
    const generatedAt = new Date().toISOString();
    if (!(await this.analysisSandboxEnabled(ctx.tenantId))) {
      return {
        tool: 'run_analysis',
        generatedAt,
        ok: false,
        error: 'The analysis sandbox is not enabled for this workspace.',
      };
    }
    const code = typeof input.code === 'string' ? input.code : '';
    if (!code.trim()) throw new BadRequestException('code is required');

    // Rate limit (the tool is read-only but compute-expensive).
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;
    const stamps = (this.analysisRuns.get(ctx.tenantId) ?? []).filter((t) => t > windowStart);
    if (stamps.length >= MeriToolsService.ANALYSIS_RUNS_PER_HOUR) {
      return {
        tool: 'run_analysis',
        generatedAt,
        ok: false,
        error: `Analysis rate limit reached (${MeriToolsService.ANALYSIS_RUNS_PER_HOUR}/hour). Try again later.`,
      };
    }
    stamps.push(now);
    this.analysisRuns.set(ctx.tenantId, stamps);

    const codeHash = createHash('sha256').update(code).digest('hex');
    const datasets = Array.isArray(input.datasets)
      ? (input.datasets as Array<Record<string, unknown>>)
          .filter((d) => d && typeof d.name === 'string' && Array.isArray(d.rows))
          .slice(0, 8)
          .map((d) => ({ name: d.name as string, rows: d.rows as Array<Record<string, unknown>> }))
      : [];

    const url = this.config.get('CLIO_SANDBOX_URL', { infer: true });
    const token = this.config.get('CLIO_SANDBOX_TOKEN', { infer: true });
    interface SandboxOutcome {
      ok: boolean;
      exitCode: number | null;
      timedOut: boolean;
      durationMs: number;
      stdout: string;
      stderr: string;
      results: unknown;
      images: Array<{ filename: string; dataBase64: string }>;
    }
    let outcome: SandboxOutcome | null = null;
    let failure: string | null = null;
    try {
      const res = await fetch(`${url}/run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ code, datasets }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        failure = `sandbox HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
      } else {
        outcome = (await res.json()) as SandboxOutcome;
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : 'sandbox unreachable';
    }

    // Audit 100% of runs (success or failure), with the code hash — never the code.
    await this.prisma
      .withTenant(ctx.tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            action: 'clio.run_analysis',
            entityType: 'clio_sandbox_run',
            entityId: null,
            after: {
              codeSha256: codeHash,
              datasetNames: datasets.map((d) => d.name),
              ok: outcome?.ok ?? false,
              timedOut: outcome?.timedOut ?? false,
              durationMs: outcome?.durationMs ?? null,
              failure,
            } as Prisma.InputJsonValue,
          },
        }),
      )
      .catch((err) => this.logger.warn(`run_analysis audit failed: ${(err as Error).message}`));

    if (failure || !outcome) {
      return {
        tool: 'run_analysis',
        generatedAt,
        ok: false,
        error: `The analysis sandbox is unavailable (${failure ?? 'no result'}). Summarize the data without code execution.`,
      };
    }

    const artifacts = outcome.images.map((img, index) => ({
      title: `Analysis chart ${index + 1}`,
      kind: 'analysis_chart',
      contentType: 'image/png',
      metadata: { imageBase64: img.dataBase64, filename: img.filename, codeSha256: codeHash },
    }));
    return {
      tool: 'run_analysis',
      generatedAt,
      ok: outcome.ok,
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
      stdout: outcome.stdout.slice(0, 12_000),
      stderr: outcome.ok ? undefined : outcome.stderr.slice(0, 4_000),
      results: outcome.results,
      chartCount: artifacts.length,
      ...(artifacts.length ? { artifacts } : {}),
    };
  }

  executeFromAuthenticatedUser(ctx: TenantContext, rawName: string, rawInput: unknown) {
    const name = normalizeToolName(rawName);
    const input = this.isSideEffecting(name)
      ? this.validateSideEffectingInput(name, rawInput)
      : objectInput(rawInput);
    return this.execute(ctx, name, input);
  }

  /**
   * Propose-time check for a client-scoped write: can this clientId actually be
   * resolved and written to?
   *
   * The compliance gate WARNs BEFORE the tool ever runs, so an unresolvable
   * client used to render as a perfectly clean "pending approval" card and only
   * blew up after the user clicked — which is how a profile fill was proposed
   * for three clients whose create_client had never been approved, and the user
   * was told all three were in progress. The orchestrator calls this while
   * building the card so the reason can say up front that it cannot run.
   *
   * Read-only and best-effort; it never writes and never throws to the caller.
   */
  async checkClientRef(
    ctx: TenantContext,
    ref: string,
  ): Promise<{ ok: true; clientId: string } | { ok: false; reason: string }> {
    try {
      const clientId = await this.ensureClientVisible(ctx, ref);
      return { ok: true, clientId };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  async execute(ctx: TenantContext, name: MeriToolName, input: Record<string, unknown>) {
    switch (name) {
      case 'get_client_context':
        return this.getClientContext(ctx, input);
      case 'search_research_sources':
        return this.searchResearchSources(ctx, input);
      case 'search_client_knowledge':
        return this.searchClientKnowledge(ctx, input);
      case 'run_analysis':
        return this.runAnalysis(ctx, input);
      case 'query_intelligence':
        return this.queryIntelligence(input);
      case 'query_knowledge_graph':
        return this.queryKnowledgeGraph(ctx, input);
      case 'find_path_to':
        return this.findPathTo(ctx, input);
      case 'search_memory':
        return this.searchMemory(ctx, input);
      case 'search_congress_bills':
        return this.searchCongressBills(input);
      case 'get_bill_status':
        return this.getBillStatus(input);
      case 'search_floor_votes':
        return this.searchFloorVotes(input);
      case 'search_cbo_cost_estimates':
        return this.searchCboCostEstimates(input);
      case 'resolve_entity':
        return this.resolveEntity(input);
      case 'search_lda_filings':
        return this.searchLdaFilings(input);
      case 'search_sec_filings':
        return this.searchSecFilings(input);
      case 'search_fara_registrations':
        return this.searchFaraRegistrations(input);
      case 'search_federal_grants':
        return this.searchFederalGrants(input);
      case 'search_federal_awards':
        return this.searchFederalAwards(input);
      case 'search_gao_reports':
        return this.searchGaoReports(input);
      case 'search_state_bills':
        return this.searchStateBills(input);
      case 'get_state_bill_status':
        return this.getStateBillStatus(input);
      case 'search_state_floor_votes':
        return this.searchStateFloorVotes(input);
      case 'get_state_legislator':
        return this.getStateLegislator(input);
      case 'get_committee_roster':
        return this.getCommitteeRoster(input);
      case 'get_representation':
        return this.getRepresentation(ctx, input);
      case 'list_members':
        return this.listMembers(input);
      case 'get_state_rule_status':
        return this.getStateRuleStatus(input);
      case 'search_intel_articles':
        return this.searchIntelArticles(input);
      case 'search_committee_hearings':
        return this.searchCommitteeHearings(input);
      case 'search_crs_reports':
        return this.searchCrsReports(input);
      case 'query_economic_data':
        return this.queryEconomicData(input);
      case 'search_public_web':
        return this.searchPublicWeb(input);
      case 'scrape_web_page':
        return this.scrapeWebPage(input);
      case 'create_meeting_brief':
        return this.createMeetingBrief(ctx, input);
      case 'draft_policy_memo':
        return this.draftPolicyMemo(ctx, input);
      case 'save_note':
        return this.saveNote(ctx, input);
      case 'send_email':
        return this.sendEmail(ctx, input);
      case 'list_emails':
        return this.listEmails(ctx, input);
      case 'search_emails':
        return this.searchEmails(ctx, input);
      case 'list_upcoming_meetings':
        return this.listUpcomingMeetings(ctx, input);
      case 'reply_email':
        return this.replyEmail(ctx, input);
      case 'save_memory':
        return this.saveMemory(ctx, input);
      case 'confirm_memory':
        return this.confirmMemoryTool(input);
      case 'correct_memory':
        return this.correctMemoryTool(input);
      case 'forget_memory':
        return this.forgetMemoryTool(input);
      case 'search_program_elements':
        return this.searchProgramElements(ctx, input);
      case 'get_program_element':
        return this.getProgramElementDetail(ctx, input);
      case 'get_pe_budget_timeline':
        return this.getPeBudgetTimeline(input);
      case 'get_pe_contractors':
        return this.getPeContractors(input);
      case 'get_pe_bills':
        return this.getPeBills(input);
      case 'get_pe_report_language':
        return this.getPeReportLanguage(input);
      case 'search_acquisition_personnel':
        return this.searchAcquisitionPersonnel(ctx, input);
      case 'get_acquisition_person':
        return this.getAcquisitionPerson(ctx, input);
      case 'find_contacts':
        return this.findContacts(ctx, input);
      case 'create_word':
        return this.createDocument(ctx, input, 'docx');
      case 'create_excel':
        return this.createDocument(ctx, input, 'xlsx');
      case 'create_powerpoint':
        return this.createDocument(ctx, input, 'pptx');
      case 'schedule_task':
        return this.scheduleTask(ctx, input);
      case 'list_scheduled_tasks':
        return this.listScheduledTasks(ctx);
      case 'cancel_scheduled_task':
        return this.cancelScheduledTask(ctx, input);
      case 'query_tasks':
        return this.queryTasks(ctx, input);
      case 'query_action_items':
        return this.queryActionItems(ctx, input);
      case 'search_tracked_bills':
        return this.searchTrackedBills(ctx, input);
      case 'query_regulatory_dockets':
        return this.queryRegulatoryDockets(input);
      case 'search_sam_opportunities':
        return this.searchSamOpportunities(input);
      case 'query_debriefs':
        return this.queryDebriefs(ctx, input);
      case 'read_client_documents':
        return this.readClientDocuments(ctx, input);
      case 'query_outreach':
        return this.queryOutreach(ctx, input);
      case 'lookup_client_registry':
        return this.lookupClientRegistry(ctx, input);
      case 'create_client':
        return this.createClient(ctx, input);
      case 'create_task':
        return this.createEngagementTask(ctx, input);
      case 'update_task':
        return this.updateEngagementTask(ctx, input);
      case 'update_client_profile':
        return this.updateClientProfile(ctx, input);
      default:
        assertNever(name);
    }
  }

  /**
   * Phase 1 (1B): every save now goes through a memory_candidate row first
   * (MemoryCandidateService.proposeSaveMemory). Personal-scope and an
   * admin's own firm-scope save still commit in this same call — same
   * latency/behavior as before 1B. A non-admin's firm-scope save no longer
   * dead-ends in a rejection message; it becomes a real pending candidate
   * any admin can approve via GET/POST /memory/candidates.
   */
  private async saveMemory(ctx: TenantContext, input: Record<string, unknown>) {
    const content = requiredString(input, 'content', 4000);
    const key = optionalString(input, 'key', 120);
    const scope = optionalString(input, 'scope', 20);
    // G2: client scope binds to the CONVERSATION's client (threaded by both
    // chat loops as input.clientId) — never a model-invented id.
    const clientId = optionalString(input, 'clientId', 64);
    const ttlRaw = input.ttlDays;
    const ttlDays = typeof ttlRaw === 'number' && Number.isFinite(ttlRaw) ? ttlRaw : null;
    const record = buildSavedMemoryRecord({
      content,
      key,
      scope,
      userId: ctx.userId,
      clientId: clientId ?? null,
      ttlDays,
    });
    if (!record) throw new BadRequestException('save_memory requires non-empty content');
    if ((scope ?? '').trim().toLowerCase() === 'client' && record.scope !== 'client') {
      // Requested client scope without a client in context: the helper fell
      // back to user-private. Surface that honestly instead of silently
      // narrowing what the user asked for.
      this.logger.log('save_memory: client scope requested with no client in context');
    }

    const isAdmin = ctx.role === 'user_admin' || ctx.role === 'capiro_admin';
    const result = await this.memoryCandidates.proposeSaveMemory(
      ctx.tenantId,
      ctx.userId,
      record,
      isAdmin,
    );

    if (result.status === 'pending') {
      this.logger.log(
        `save_memory: ${record.scope}-scope candidate ${result.candidateId} pending admin approval, tenant ${ctx.tenantId}`,
      );
      const pendingLabel = record.scope === 'client' ? 'client' : 'firm';
      return {
        saved: false,
        scope: pendingLabel,
        candidateId: result.candidateId,
        message: `I've proposed this as ${pendingLabel === 'client' ? 'client-scope' : 'firm-wide'} memory; an admin needs to approve it before it becomes shared truth. I can save it as your personal memory right now instead — just say so.`,
      };
    }

    this.logger.log(
      `save_memory: stored ${record.scope} memory "${record.key}" for tenant ${ctx.tenantId} (candidate ${result.candidateId}, ${result.ruleId})`,
    );
    const scopeLabel =
      record.scope === 'user_private' ? 'personal' : record.scope === 'client' ? 'client' : 'firm';
    return {
      saved: true,
      scope: scopeLabel,
      key: record.key,
      value: record.value,
      ...(record.expiresAt ? { expiresAt: record.expiresAt.toISOString() } : {}),
      message: record.expiresAt
        ? `Saved as ephemeral working memory (expires ${record.expiresAt.toISOString().slice(0, 10)}); it will not become durable operating memory.`
        : 'Saved to long-term memory; I will recall this in future conversations.',
    };
  }

  // ── Phase 1 (1D) memory verbs — thin wrappers over MemoryStoreService.
  // Scoping/RLS/legal-hold/audit all live in the store; these only parse
  // input + shape the model-facing result. Available on both chat surfaces
  // (legacy dispatch + MeriV2 delegated write tool).
  private async confirmMemoryTool(input: Record<string, unknown>) {
    const memoryItemId = requiredString(input, 'memoryItemId', 80);
    const r = await this.memoryStore.confirmMemory(memoryItemId);
    if (!r.found)
      return {
        confirmed: false,
        message: 'No such memory (it may have been forgotten or you may not have access).',
      };
    return { confirmed: true, title: r.title, message: `Confirmed "${r.title}" is still current.` };
  }

  private async correctMemoryTool(input: Record<string, unknown>) {
    const memoryItemId = requiredString(input, 'memoryItemId', 80);
    const newContent = requiredString(input, 'newContent', 4000);
    const r = await this.memoryStore.correctMemory(memoryItemId, newContent);
    if (!r.found) return { corrected: false, message: 'No such memory to correct.' };
    if (r.blockedByLegalHold)
      return {
        corrected: false,
        legalHold: true,
        message: `"${r.title}" is under a legal hold and cannot be changed.`,
      };
    return {
      corrected: true,
      title: r.title,
      newMemoryItemId: r.newItemId,
      message: `Corrected "${r.title}"; the prior version is preserved as history.`,
    };
  }

  private async forgetMemoryTool(input: Record<string, unknown>) {
    const memoryItemId = requiredString(input, 'memoryItemId', 80);
    const reason = optionalString(input, 'reason', 400);
    const r = await this.memoryStore.forgetMemory(memoryItemId, reason ?? undefined);
    if (!r.found)
      return {
        forgotten: false,
        message: 'No such memory (it may already be forgotten or you may not have access).',
      };
    if (r.blockedByLegalHold)
      return {
        forgotten: false,
        legalHold: true,
        message: `"${r.title}" is under a legal hold and cannot be forgotten; it is preserved for compliance.`,
      };
    return {
      forgotten: true,
      title: r.title,
      message: `Forgotten "${r.title}". I will no longer recall it.`,
    };
  }

  private async getClientContext(ctx: TenantContext, input: Record<string, unknown>) {
    let clientId = requiredString(input, 'clientId', 80);
    clientId = await this.ensureClientVisible(ctx, clientId);
    // Profile depth (capabilities/people/facilities/submission history) is
    // additive and best-effort — a failure there never blocks the engagement
    // context that existing consumers (briefs, memos, research) depend on.
    const [context, capabilities, people, facilities, submissionHistory] = await Promise.all([
      this.engagement.clientContext(ctx, clientId),
      this.clientCapabilities.listCapabilities(ctx, clientId).catch(() => []),
      this.clientPeople.listPeople(ctx, clientId).catch(() => []),
      this.clientFacilities.listFacilities(ctx, clientId).catch(() => []),
      this.clientCapabilities.listClientHistory(ctx, clientId).catch(() => []),
    ]);
    return {
      tool: 'get_client_context',
      generatedAt: new Date().toISOString(),
      context,
      profile: {
        capabilities: capabilities.slice(0, 25).map((cap) => ({
          id: cap.id,
          name: cap.name,
          type: cap.type,
          sector: cap.sector,
          description: summarizeText(cap.description, 300),
          trl: cap.trl,
          peNumber: cap.peNumber,
          peNumbers: cap.peNumbers,
          appropriationAccount: cap.appropriationAccount,
          serviceBranch: cap.serviceBranch,
          targetSubcommittee: cap.targetSubcommittee,
          fundingAsk: cap.fundingAsk,
          fundingAskLabel: cap.fundingAskLabel,
          districtNexus: summarizeText(cap.districtNexus, 200),
        })),
        people: people.slice(0, 25).map((person) => ({
          id: person.id,
          name: person.name,
          title: person.title,
          email: person.email,
          phone: person.phone,
          role: person.role,
          lastContact: person.lastContact,
        })),
        facilities: facilities.slice(0, 25).map((facility) => ({
          id: facility.id,
          name: facility.name,
          city: facility.city,
          state: facility.state,
          congressionalDistrict: facility.congressionalDistrict,
          employeeCount: facility.employeeCount,
        })),
        submissionHistory: submissionHistory.slice(0, 25).map((entry) => ({
          id: entry.id,
          capabilityId: entry.capabilityId,
          fiscalYear: entry.fiscalYear,
          title: entry.title,
          outcomeType: entry.outcomeType,
          outcome: summarizeText(entry.outcome, 240),
        })),
      },
    };
  }

  // ── Intelligence tools (global data, no tenant scoping) ────────────

  /**
   * Build the tenant's knowledge graph from memory_items (+ wikilink edges) and
   * DB foreign keys, scoped to the caller (tenant RLS + own-private). Pure
   * builders (buildKnowledgeGraph/walkFrom) do the merge; this just gathers
   * inputs under the passed ctx. Shared by query_knowledge_graph + find_path_to.
   */
  /** Track B: per-tenant traversal source (env + settings override), resolved
   *  before the graph tx so the cache branch gets a larger timeout up front. */
  private async resolveKgTraversalSource(tenantId: string): Promise<KgTraversalSource> {
    const env = (this.config.get('KG_TRAVERSAL_SOURCE', { infer: true }) ??
      'legacy') as KgTraversalSource;
    try {
      const tenant = await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenant.findFirst({ where: { id: tenantId }, select: { settings: true } }),
      );
      return pickKgTraversalSource(env, tenant?.settings ?? null);
    } catch (err) {
      // Fail toward env (house pattern) but make it observable.
      this.logger.warn(
        `kgTraversalSource settings read failed for tenant ${tenantId}; using env='${env}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return env;
    }
  }

  private async loadGraphForCtx(ctx: TenantContext) {
    const kgSource = await this.resolveKgTraversalSource(ctx.tenantId);
    return this.prisma.withTenantUser(
      ctx.tenantId,
      ctx.userId,
      async (tx) => {
        // Ethical wall: memory items + graph edges of walled clients this user is
        // not granted are excluded (fail-closed; empty denied set adds no SQL).
        const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
        const deniedSet = new Set(denied);
        // item nodes the caller may see (RLS: tenant + own-private), plus their wikilink edges
        const items = await tx.$queryRaw<
          Array<{ id: string; type: string; slug: string; title: string; sections: unknown }>
        >`
        SELECT id, type, slug, title, sections_jsonb AS sections
        FROM memory_items
        WHERE (owner_user_id IS NULL OR owner_user_id = ${ctx.userId}::uuid)
          ${Prisma.raw(wallExclusionSql(denied, 'client_id'))}
          -- Pre-existing defect this closes: query_knowledge_graph / find_path_to
          -- filtered NO status at all, so revoked and superseded items still
          -- surfaced to the model as graph nodes. Fixing it WITHHOLDS content that
          -- is visible today, so it rides the same dark switch rather than shipping
          -- armed. The legacy status column is deliberately still not filtered
          -- here: narrowing that is a behaviour change with its own blast radius.
          ${Prisma.raw(governedRecallSuppressionSql(governedRecallSuppressionEnabled()))}
      `;
        const itemNodeById = new Map(
          items.map((i) => [i.id, { type: i.type, slug: i.slug, label: i.title }]),
        );
        const wikiEdges = await tx.$queryRaw<
          Array<{ src_item_id: string; relation: string; dst_type: string; dst_slug: string }>
        >`
        SELECT e.src_item_id, e.relation, e.dst_type, e.dst_slug
        FROM memory_edges e
        JOIN memory_items i ON i.id = e.src_item_id
        WHERE (i.owner_user_id IS NULL OR i.owner_user_id = ${ctx.userId}::uuid)
          ${Prisma.raw(wallExclusionSql(denied, 'i.client_id'))}
          ${Prisma.raw(governedRecallSuppressionSql(governedRecallSuppressionEnabled(), 'i'))}
      `;
        // FK relations (structural backbone): client->bill/issue/person, meeting->client
        const fk: FkRelation[] = [];
        const bills = await tx.$queryRaw<
          Array<{ client_id: string; client_name: string; bill_id: string }>
        >`
        SELECT tb.client_id, c.name AS client_name, tb.bill_id FROM tracked_bill tb JOIN clients c ON c.id = tb.client_id WHERE tb.tenant_id = ${ctx.tenantId}::uuid`;
        for (const b of bills)
          fk.push({
            srcType: 'client',
            srcSlug: b.client_id,
            srcLabel: b.client_name,
            dstType: 'bill',
            dstSlug: b.bill_id,
            dstLabel: b.bill_id,
            relation: 'tracks',
          });
        const people = await tx.$queryRaw<
          Array<{ client_id: string; client_name: string; person_id: string; person_name: string }>
        >`
        SELECT cp.client_id, c.name AS client_name, cp.id AS person_id, cp.name AS person_name FROM client_people cp JOIN clients c ON c.id = cp.client_id WHERE cp.tenant_id = ${ctx.tenantId}::uuid`;
        for (const p of people)
          fk.push({
            srcType: 'client',
            srcSlug: p.client_id,
            srcLabel: p.client_name,
            dstType: 'person',
            dstSlug: p.person_id,
            dstLabel: p.person_name,
            relation: 'contact',
          });
        const wiki = wikiEdges.map((e) => ({
          tenantId: ctx.tenantId,
          srcItemId: e.src_item_id,
          relation: e.relation,
          dstType: e.dst_type,
          dstSlug: e.dst_slug,
        }));
        // Ethical wall: drop FK relations rooted at denied clients so a walled
        // client's bills/people/meetings never appear in this user's graph.
        const fkVisible = deniedSet.size
          ? fk.filter((r) => !(r.srcType === 'client' && deniedSet.has(r.srcSlug)))
          : fk;

        // Track B enrichment: when this tenant is on the cache traversal source,
        // layer the world-class canonical relationships (aggregated FEC money
        // flow, LDA lobbying, intel mappings) around the visible clients via
        // seed-based bounded walks. Fail-safe: enrichment errors degrade to the
        // plain System-A graph — the tools never lose their baseline.
        let fkAll = fkVisible;
        if (kgSource === 'cache') {
          try {
            // Bound the enrichment phase server-side — kg_walk_bounded's fn-scoped
            // statement_timeout is inert, so SET LOCAL is the real RC3 guard.
            await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '8s'`);
            const clients = await tx.$queryRaw<Array<{ id: string; name: string }>>`
            SELECT id, name FROM clients
            WHERE tenant_id = ${ctx.tenantId}::uuid AND status <> 'archived'
            ORDER BY updated_at DESC
          `;
            const enriched = await enrichFromKgCache(tx, {
              tenantId: ctx.tenantId,
              deniedClientIds: denied,
              clients: clients.filter((c) => !deniedSet.has(c.id)),
            });
            fkAll = [...fkVisible, ...enriched.relations];
          } catch {
            // graph tools keep their System-A baseline on any enrichment failure
          }
        }
        return buildKnowledgeGraph(fkAll, wiki, itemNodeById);
      },
      // The cache branch runs bounded walks sequentially; match the intel graph
      // path's 30s ceiling instead of the 5s interactive-tx default.
      kgSource === 'cache' ? { timeoutMs: 30_000 } : undefined,
    );
  }

  private async queryKnowledgeGraph(ctx: TenantContext, input: Record<string, unknown>) {
    const seed = optionalString(input, 'seed', 120);
    const depthRaw =
      typeof input.depth === 'number' ? input.depth : parseInt(String(input.depth ?? ''), 10);
    const depth = Number.isFinite(depthRaw) ? Math.min(4, Math.max(1, depthRaw)) : 2;
    const full = await this.loadGraphForCtx(ctx);
    const g = seed ? walkFrom(full, seed, depth) : full;
    if (!g.nodes.length) {
      return {
        summary:
          'The knowledge graph is empty or has nothing connected to that seed. Run "Populate graph" on the Knowledge Graph page to build it from clients, memories, meetings, and email.',
        nodes: [],
        edges: [],
      };
    }
    // Compact, LLM-friendly projection
    const nodeLabel = new Map(g.nodes.map((n) => [n.id, `${n.label} (${n.type})`]));
    const edgeLines = g.edges
      .slice(0, 120)
      .map(
        (e) =>
          `${nodeLabel.get(e.src) ?? e.src} --${e.relation}[${e.origin}]--> ${nodeLabel.get(e.dst) ?? e.dst}`,
      );
    return {
      summary: `${g.nodes.length} nodes, ${g.edges.length} connections${seed ? ` within ${depth} hop(s) of ${seed}` : ''}. Edges tagged [fact]=from firm data, [mention]=from analyst notes.`,
      nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label })),
      connections: edgeLines,
    };
  }

  private async findPathTo(ctx: TenantContext, input: Record<string, unknown>) {
    const to = optionalString(input, 'to', 120);
    if (!to) return { error: "Provide a target node id, e.g. 'office:<id>' or 'person:<id>'." };
    const depthRaw =
      typeof input.depth === 'number' ? input.depth : parseInt(String(input.depth ?? ''), 10);
    const depth = Number.isFinite(depthRaw) ? Math.min(5, Math.max(1, depthRaw)) : 3;
    const full = await this.loadGraphForCtx(ctx);
    if (!full.nodes.some((n) => n.id === to)) {
      return {
        summary: `No node "${to}" in the knowledge graph. It may not be ingested yet, or the id is off.`,
        paths: [],
      };
    }
    const label = new Map(full.nodes.map((n) => [n.id, `${n.label} (${n.type})`]));
    const clients = full.nodes.filter((n) => n.type === 'client').map((n) => n.id);
    const paths: string[][] = [];
    for (const c of clients) {
      const p = shortestGraphPath(full, c, to, depth);
      if (p) paths.push(p);
    }
    if (!paths.length)
      return {
        summary: `No connection path from any client to ${label.get(to) ?? to} within ${depth} hops.`,
        paths: [],
      };
    return {
      summary: `${paths.length} route(s) from your clients to ${label.get(to) ?? to}:`,
      paths: paths.map((p) => p.map((id) => label.get(id) ?? id).join(' → ')),
    };
  }

  private async searchMemory(ctx: TenantContext, input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 400);
    if (!query) return { error: 'Provide a search query.' };
    const kRaw = typeof input.k === 'number' ? input.k : parseInt(String(input.k ?? ''), 10);
    const k = Number.isFinite(kRaw) ? Math.min(15, Math.max(1, kRaw)) : 8;
    let literal: string;
    try {
      literal = vectorLiteral(await embedText(normalize(query)));
    } catch (err) {
      this.logger.warn(`search_memory embed failed: ${(err as Error).message}`);
      return {
        summary: 'Memory search is temporarily unavailable (embedding service error).',
        results: [],
      };
    }
    type MemoryHit = {
      id: string;
      type: string;
      slug: string;
      title: string;
      client_id: string | null;
      score: number;
    };
    let rows: MemoryHit[];
    try {
      rows = await this.prisma.withTenantUser(
        ctx.tenantId,
        ctx.userId,
        async (tx) => {
          // Ethical wall: results for walled clients this user is not granted are
          // excluded (fail-closed; an empty denied set appends no SQL).
          const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
          return tx.$queryRawUnsafe<MemoryHit[]>(
            // Recall surfaces only ACTIVE memory (excludes superseded corrections
            // and revoked/forgotten items — Phase 1, 1C/1D) and only UNEXPIRED
            // memory (G2 ephemeral class). owner + expiry filters stay as
            // defense-in-depth alongside the RLS predicates.
            //
            // mi.tenant_id is filtered EXPLICITLY as well as ce.tenant_id: without
            // it the join's index scan matches every tenant's memory_items rows and
            // discards the rest, leaning on RLS alone for correctness. Naming the
            // tenant on both sides is both defense-in-depth and a large planner win.
            `SELECT mi.id, mi.type, mi.slug, mi.title, mi.client_id,
                1 - (ce.embedding <=> '${literal}'::vector) AS score
           FROM context_embeddings ce
           JOIN memory_items mi ON mi.id::text = ce.source_id
          WHERE ce.source_type = 'memory_item'
            AND ce.tenant_id = $1::uuid
            AND mi.tenant_id = $1::uuid
            AND (mi.owner_user_id IS NULL OR mi.owner_user_id = $2::uuid)
            AND mi.status = 'active'
            AND (mi.expires_at IS NULL OR mi.expires_at > now())${wallExclusionSql(denied, 'mi.client_id')}${governedRecallSuppressionSql(governedRecallSuppressionEnabled(), 'mi')}
          ORDER BY ce.embedding <=> '${literal}'::vector
          LIMIT ${k}`,
            ctx.tenantId,
            ctx.userId,
          );
        },
        // A cold 1024-dim ANN scan over context_embeddings measured 10.3s live and
        // blew Prisma's DEFAULT 5s interactive-transaction cap -> P2028, which the
        // exception filter does not map, so a READ tool returned HTTP 500 and the
        // Strategy context pack silently dropped a whole grounding section.
        // prisma.service documents passing a higher budget for known-slow paths.
        { timeoutMs: 20_000 },
      );
    } catch (err) {
      // A recall tool must DEGRADE, never 5xx: the embed path above already fails
      // soft this way, and the caller (Meri / the Strategy context pack) treats an
      // empty result as a missing section rather than an error.
      this.logger.warn(`search_memory query failed: ${(err as Error).message}`);
      return {
        summary: 'Memory search is temporarily unavailable.',
        results: [],
      };
    }
    if (!rows.length) {
      return {
        summary:
          'No memory matched — the graph may not be populated yet (run "Populate graph" on the Knowledge Graph page).',
        results: [],
      };
    }
    return {
      summary: `${rows.length} memory item(s) most relevant to "${query}":`,
      results: rows.map((r) => ({
        id: `${r.type}:${r.slug}`,
        memoryItemId: r.id,
        type: r.type,
        title: r.title,
        clientId: r.client_id,
        relevance: Math.round(r.score * 100) / 100,
      })),
    };
  }

  private async queryIntelligence(input: Record<string, unknown>) {
    const clientName = optionalString(input, 'clientName', 200);
    const parts: string[] = [];

    // Lobby intel surging issues & trends
    try {
      const lobbyCtx = await this.lobbyIntel.getAiContext();
      if (lobbyCtx.surgingIssues.length) {
        const surge = lobbyCtx.surgingIssues
          .slice(0, 8)
          .map(
            (s) =>
              `${s.name}${s.surgePct != null ? ' (+' + Math.round(s.surgePct) + '% QoQ)' : ''}`,
          )
          .join(', ');
        parts.push(`Surging LDA lobbying issues: ${surge}`);
      }
      if (lobbyCtx.trendingTopics.length) {
        const trending = lobbyCtx.trendingTopics
          .slice(0, 10)
          .map((t) => t.word)
          .filter(Boolean)
          .join(', ');
        if (trending) parts.push(`Trending terms in lobbying filings: ${trending}`);
      }
      if (lobbyCtx.latestQuarter) parts.push(`Latest LDA quarter: ${lobbyCtx.latestQuarter}`);
    } catch (err) {
      this.logger.warn(`Lobby intel fetch failed: ${(err as Error).message}`);
    }

    // Congress bills, recent activity
    try {
      const bills = await this.ldaIntel.getCongressBills(
        undefined, // search
        undefined, // policyArea
        undefined, // congress
        1, // page
        15, // limit
      );
      const billsAny = bills as unknown as {
        data?: Array<Record<string, unknown>>;
        total?: number;
      };
      if (billsAny.data && billsAny.data.length) {
        const billSummary = billsAny.data
          .slice(0, 12)
          .map(
            (b) =>
              `- ${b.billType ?? ''}${b.billNumber ?? ''}: ${summarizeText(b.title, 120)} [${b.policyArea ?? 'N/A'}] (Sponsor: ${b.sponsorName ?? 'N/A'}, ${b.sponsorParty ?? ''}${b.sponsorState ? '-' + b.sponsorState : ''}) Latest: ${summarizeText(b.latestActionText, 100)} (${b.latestActionDate ?? 'no date'})`,
          )
          .join('\n');
        parts.push(
          `Recent congressional bills (${billsAny.total ?? 0} total in database):\n${billSummary}`,
        );
      }
    } catch (err) {
      this.logger.warn(`Congress bills fetch failed: ${(err as Error).message}`);
    }

    // Federal spending context (if client name provided)
    if (clientName) {
      try {
        const spend = await this.federalSpending.getAiContext(clientName);
        if (spend.matchedContractor) {
          const mc = spend.matchedContractor;
          const amt =
            mc.totalContracts != null ? `$${(mc.totalContracts / 1e9).toFixed(1)}B` : 'unknown';
          parts.push(
            `Federal contracting for ${mc.name}: ${amt} in contracts${mc.rankByContracts ? ' (rank #' + mc.rankByContracts + ' nationally)' : ''}`,
          );
          if (mc.topAgencies.length) {
            const agencies = mc.topAgencies
              .slice(0, 5)
              .map(
                (a: Record<string, unknown>) =>
                  `${a.name} ($${Math.round((a.amount as number) / 1e9)}B)`,
              )
              .join(', ');
            parts.push(`Top awarding agencies: ${agencies}`);
          }
        }
      } catch (err) {
        this.logger.warn(`Federal spending fetch failed: ${(err as Error).message}`);
      }
    }

    // Intelligence data source counts
    try {
      const [
        secCount,
        faraCount,
        gaoCount,
        grantCount,
        stateBillCount,
        intelArticleCount,
        hearingCount,
        crsCount,
      ] = await Promise.all([
        this.prisma.withSystem((tx) => tx.secFiling.count()).catch(() => 0),
        this.prisma.withSystem((tx) => tx.faraRegistration.count()).catch(() => 0),
        this.prisma.withSystem((tx) => tx.gaoReport.count()).catch(() => 0),
        this.prisma.withSystem((tx) => tx.federalGrant.count()).catch(() => 0),
        this.prisma.withSystem((tx) => tx.stateBill.count()).catch(() => 0),
        this.prisma.withSystem((tx) => tx.intelArticle.count()).catch(() => 0),
        this.prisma.withSystem((tx) => tx.committeeHearing.count()).catch(() => 0),
        this.prisma.withSystem((tx) => tx.crsReport.count()).catch(() => 0),
      ]);
      const sourceSummary = [
        secCount && `SEC filings: ${secCount}`,
        faraCount && `FARA registrations: ${faraCount}`,
        gaoCount && `GAO reports: ${gaoCount}`,
        grantCount && `Federal grants: ${grantCount}`,
        stateBillCount && `State bills: ${stateBillCount}`,
        intelArticleCount && `News articles: ${intelArticleCount}`,
        hearingCount && `Committee hearings: ${hearingCount}`,
        crsCount && `CRS reports: ${crsCount}`,
      ]
        .filter(Boolean)
        .join(', ');
      if (sourceSummary) parts.push(`Available intelligence data sources: ${sourceSummary}`);
    } catch (err) {
      this.logger.warn(`Intelligence source counts failed: ${(err as Error).message}`);
    }

    return {
      tool: 'query_intelligence',
      generatedAt: new Date().toISOString(),
      data: parts.join('\n') || 'No intelligence data currently available.',
    };
  }

  /**
   * Resolve a free-form bill reference ("H.R. 8800", "119-hr-8800") to a
   * canonical bill id, or null. Shared by the congress-bill / status / votes
   * tools so a designation query becomes a direct lookup, not a title guess.
   */
  private resolveBillId(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const norm = normalizeCanonicalId('billId', raw);
    if (isValidCanonicalId('billId', norm)) return norm;
    const parsed = parseBillDesignation(raw, currentCongress());
    return parsed ? formatBillId(parsed.congress, parsed.type, parsed.number) : null;
  }

  /**
   * Resolve a free-form state bill reference ("tx-2025-hb1234", "TX HB 1234")
   * to a canonical DD1 key, or an explicit note when it can't be resolved (S6
   * honesty contract — never guess). A bare designation needs a state, either
   * embedded in the text or passed via `stateHint`; once state+billNumber are
   * known, the most-recently-synced matching bill wins when multiple sessions
   * share the same number (the common case: the user means the current one).
   */
  private async resolveStateBillKey(
    raw: string | null | undefined,
    stateHint: string | null | undefined,
  ): Promise<{ key: string | null; note?: string }> {
    if (!raw) {
      return {
        key: null,
        note: 'Provide a state bill id ("tx-2025-hb1234") or designation ("TX HB 1234").',
      };
    }
    const normKey = normalizeCanonicalId('stateBillKey', raw);
    if (isValidCanonicalId('stateBillKey', normKey)) return { key: normKey };

    const parsed = parseStateBillDesignation(raw, stateHint ?? null);
    if (!parsed) {
      return {
        key: null,
        note: stateHint
          ? `Could not parse "${raw}" as a state bill designation.`
          : `Could not parse "${raw}" as a state bill designation — specify the state, e.g. "TX HB 1234".`,
      };
    }
    const candidates = await this.prisma.withSystem((tx) =>
      tx.stateBill.findMany({
        where: { state: parsed.state, billNumber: parsed.billNumber },
        orderBy: { syncedAt: 'desc' },
        select: { id: true },
        take: 1,
      }),
    );
    if (!candidates.length) {
      return { key: null, note: `No bill found matching "${raw}" in ${parsed.state}.` };
    }
    return { key: candidates[0]!.id };
  }

  private async searchCongressBills(input: Record<string, unknown>) {
    const search = optionalString(input, 'query', 240) ?? optionalString(input, 'search', 240);
    const policyArea = optionalString(input, 'policyArea', 120);
    const congressNum = input.congress ? Number(input.congress) : undefined;
    const activeSince = optionalString(input, 'activeSince', 30);
    const limit = clampInt(input.limit, 1, 50, 20);
    const page = clampInt(input.page, 1, 100, 1);

    // Direct lookup when the query is itself a bill designation/id — a title
    // substring search would otherwise miss "H.R. 8800".
    const directId = this.resolveBillId(search);
    if (directId) {
      const bill = await this.prisma.congressBill.findUnique({ where: { id: directId } });
      if (bill) {
        return {
          tool: 'search_congress_bills',
          generatedAt: new Date().toISOString(),
          data: [bill],
          total: 1,
          page: 1,
          limit,
          resolvedBy: 'bill-id',
        };
      }
    }

    const bills = await this.ldaIntel.getCongressBills(
      search ?? undefined,
      policyArea ?? undefined,
      congressNum,
      page,
      limit,
      activeSince ?? undefined,
    );

    return {
      tool: 'search_congress_bills',
      generatedAt: new Date().toISOString(),
      ...bills,
    };
  }

  /**
   * Authoritative single-bill status (LegiWatch A5) — the fix for the H.R. 8800
   * blindness. Returns the canonical status, action timeline, roll-call votes on
   * the bill (tallies + party splits), and the outcome of any RULE governing its
   * floor consideration. Explicit no-vote honesty note; never infers passage.
   */
  private async getBillStatus(input: Record<string, unknown>) {
    const raw = optionalString(input, 'billId', 60) ?? optionalString(input, 'query', 60);
    const billId = this.resolveBillId(raw);
    if (!billId) {
      return {
        tool: 'get_bill_status',
        generatedAt: new Date().toISOString(),
        found: false,
        note: 'Provide a bill id ("119-hr-8800") or designation ("H.R. 8800").',
      };
    }
    const bill = await this.prisma.congressBill.findUnique({
      where: { id: billId },
      select: {
        id: true,
        title: true,
        congress: true,
        status: true,
        statusAt: true,
        latestActionText: true,
        latestActionDate: true,
        sponsorName: true,
        sponsorBioguideId: true,
        cosponsorsCount: true,
        policyArea: true,
      },
    });
    if (!bill) {
      return {
        tool: 'get_bill_status',
        generatedAt: new Date().toISOString(),
        billId,
        found: false,
        note: `No bill ${billId} on record in the Capiro database. Say so explicitly — do not describe its status from memory.`,
      };
    }

    const [actions, votes, ruleLinks] = await Promise.all([
      this.prisma.congressBillAction.findMany({
        where: { billId },
        orderBy: { date: 'desc' },
        take: 15,
        select: { date: true, text: true, type: true, chamber: true },
      }),
      this.prisma.rollCallVote.findMany({
        where: { billId },
        orderBy: { voteDate: 'desc' },
        take: 15,
        select: {
          chamber: true,
          rollNumber: true,
          question: true,
          result: true,
          voteType: true,
          voteDate: true,
          yeas: true,
          nays: true,
          present: true,
          notVoting: true,
          partyTotals: true,
          sourceUrl: true,
        },
      }),
      this.prisma.billRuleLink.findMany({
        where: { targetBillId: billId },
        select: { ruleBillId: true, source: true },
      }),
    ]);

    const governingRules = await Promise.all(
      ruleLinks.map(async (l) => {
        const ruleBill = await this.prisma.congressBill.findUnique({
          where: { id: l.ruleBillId },
          select: { status: true, latestActionText: true, title: true },
        });
        const ruleVotes = await this.prisma.rollCallVote.findMany({
          where: { billId: l.ruleBillId },
          orderBy: { voteDate: 'desc' },
          take: 3,
          select: {
            rollNumber: true,
            result: true,
            yeas: true,
            nays: true,
            voteDate: true,
            question: true,
            sourceUrl: true,
          },
        });
        return {
          ruleBillId: l.ruleBillId,
          ruleTitle: ruleBill?.title ?? null,
          ruleStatus: ruleBill?.status ?? null,
          ruleLatestAction: ruleBill?.latestActionText ?? null,
          ruleVotes,
        };
      }),
    );

    const notes: string[] = [];
    if (votes.length === 0) {
      notes.push(
        'No recorded roll-call vote on this bill itself. Do NOT infer that it passed or failed a chamber from the absence of a vote.',
      );
    }
    if (bill.status === 'rule_failed') {
      notes.push(
        'The rule governing this bill FAILED — the bill did NOT advance to the floor under that rule; it is stalled, not pending passage.',
      );
    }

    return {
      tool: 'get_bill_status',
      generatedAt: new Date().toISOString(),
      billId,
      found: true,
      title: bill.title,
      congress: bill.congress,
      status: bill.status,
      statusLabel: billStatusLabel(bill.status),
      statusAt: bill.statusAt,
      latestAction: { text: bill.latestActionText, date: bill.latestActionDate },
      sponsor: { name: bill.sponsorName, bioguideId: bill.sponsorBioguideId },
      cosponsorsCount: bill.cosponsorsCount,
      recentActions: actions,
      floorVotes: votes,
      governingRules,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  }

  /**
   * Search roll-call votes (LegiWatch A5). Filter by bill/keyword/chamber/
   * congress/member. Explicit no-match note; never infers a vote outcome.
   */
  private async searchFloorVotes(input: Record<string, unknown>) {
    const billId = this.resolveBillId(optionalString(input, 'billId', 60) ?? undefined);
    const query = optionalString(input, 'query', 200);
    const memberRaw = optionalString(input, 'member', 80);
    const chamber = optionalString(input, 'chamber', 10)?.toLowerCase();
    const congress = input.congress ? Number(input.congress) : undefined;
    const limit = clampInt(input.limit, 1, 25, 10);

    const where: Record<string, unknown> = {};
    if (billId) where.billId = billId;
    if (congress) where.congress = congress;
    if (chamber === 'house' || chamber === 'senate') where.chamber = chamber;
    if (query) {
      where.OR = [
        { question: { contains: query, mode: 'insensitive' } },
        { title: { contains: query, mode: 'insensitive' } },
      ];
    }

    // Member filter: accept a Bioguide id directly, else resolve a NAME. Name
    // resolution must never silently mislead — an unresolvable or AMBIGUOUS
    // name short-circuits with an explicit answer rather than returning
    // unscoped or wrong-member votes (adversarial-review fixes).
    let resolvedMember: {
      bioguideId: string;
      lisId: string | null;
      fullName: string;
      chamber: string;
      state: string | null;
    } | null = null;
    if (memberRaw) {
      const norm = normalizeCanonicalId('bioguide', memberRaw);
      if (isValidCanonicalId('bioguide', norm)) {
        const m = await this.prisma.congressMember.findUnique({
          where: { bioguideId: norm },
          select: { bioguideId: true, lisId: true, fullName: true, chamber: true, state: true },
        });
        if (!m) {
          return {
            tool: 'search_floor_votes',
            generatedAt: new Date().toISOString(),
            votesFound: 0,
            votes: [],
            note: `No member with Bioguide id ${norm} is on record. Results are NOT scoped to a member — say so; do not attribute votes.`,
          };
        }
        resolvedMember = m;
      } else {
        const candidates = await this.prisma.congressMember.findMany({
          where: {
            OR: [
              { fullName: { contains: memberRaw, mode: 'insensitive' } },
              { lastName: { contains: memberRaw, mode: 'insensitive' } },
            ],
          },
          orderBy: [{ isCurrent: 'desc' }, { lastName: 'asc' }],
          take: 8,
          select: {
            bioguideId: true,
            lisId: true,
            fullName: true,
            chamber: true,
            state: true,
            party: true,
            isCurrent: true,
          },
        });
        if (candidates.length === 0) {
          return {
            tool: 'search_floor_votes',
            generatedAt: new Date().toISOString(),
            votesFound: 0,
            votes: [],
            note: `Could not resolve a member named "${memberRaw}". Results are NOT scoped to that member — say so explicitly; do not attribute any vote to them.`,
          };
        }
        if (candidates.length > 1) {
          return {
            tool: 'search_floor_votes',
            generatedAt: new Date().toISOString(),
            votesFound: 0,
            votes: [],
            ambiguousMember: candidates.map((c) => ({
              bioguideId: c.bioguideId,
              fullName: c.fullName,
              chamber: c.chamber,
              state: c.state,
              party: c.party,
              isCurrent: c.isCurrent,
            })),
            note: `"${memberRaw}" matches ${candidates.length} members — ask the user which (by state/chamber/full name) before attributing votes. Results are NOT scoped to a member yet.`,
          };
        }
        resolvedMember = candidates[0]!;
      }
      // Match rows keyed by bioguide OR by lisId (Senate rows can carry a null
      // bioguide during crosswalk lag — see sync-senate-votes memberKey).
      const memberOr: Record<string, unknown>[] = [{ bioguideId: resolvedMember.bioguideId }];
      if (resolvedMember.lisId) memberOr.push({ lisId: resolvedMember.lisId });
      where.memberVotes = { some: { OR: memberOr } };
    }

    const memberVoteFilter = resolvedMember
      ? {
          where: {
            OR: [
              { bioguideId: resolvedMember.bioguideId },
              ...(resolvedMember.lisId ? [{ lisId: resolvedMember.lisId }] : []),
            ],
          },
          select: { voteCast: true, party: true, state: true },
        }
      : null;

    const votes = await this.prisma.rollCallVote.findMany({
      where,
      orderBy: { voteDate: 'desc' },
      take: limit,
      select: {
        id: true,
        chamber: true,
        congress: true,
        session: true,
        rollNumber: true,
        billId: true,
        question: true,
        result: true,
        voteType: true,
        voteDate: true,
        yeas: true,
        nays: true,
        present: true,
        notVoting: true,
        partyTotals: true,
        title: true,
        sourceUrl: true,
        ...(memberVoteFilter ? { memberVotes: memberVoteFilter } : {}),
      },
    });

    return {
      tool: 'search_floor_votes',
      generatedAt: new Date().toISOString(),
      votesFound: votes.length,
      ...(resolvedMember
        ? { member: { bioguideId: resolvedMember.bioguideId, fullName: resolvedMember.fullName } }
        : {}),
      votes,
      ...(votes.length === 0
        ? {
            note: resolvedMember
              ? `No roll-call vote on record matches — including none cast by ${resolvedMember.fullName} under these filters. Say so explicitly; do not infer a vote.`
              : 'No roll-call vote on record matches that. Say so explicitly — do not infer a vote outcome or tally.',
          }
        : {}),
    };
  }

  /**
   * CBO cost estimates (SC2.4): bill -> score mapping where one exists, and an
   * EXPLICIT no-estimate answer (never a guess) where none does.
   */
  private async searchCboCostEstimates(input: Record<string, unknown>) {
    const billId = optionalString(input, 'billId', 40);
    const query = optionalString(input, 'query', 200);
    const congress = input.congress ? Number(input.congress) : undefined;
    const limit = clampInt(input.limit, 1, 25, 10);

    const where: Record<string, unknown> = {};
    if (billId) where.billId = billId.toLowerCase().trim();
    if (congress) where.congress = congress;
    if (query) where.title = { contains: query, mode: 'insensitive' };

    const estimates = await this.prisma.cboCostEstimate.findMany({
      where,
      orderBy: { pubDate: 'desc' },
      take: limit,
      select: {
        id: true,
        billId: true,
        congress: true,
        billType: true,
        billNumber: true,
        title: true,
        description: true,
        pubDate: true,
        cboUrl: true,
      },
    });

    return {
      tool: 'search_cbo_cost_estimates',
      generatedAt: new Date().toISOString(),
      estimatesFound: estimates.length,
      estimates,
      ...(estimates.length === 0
        ? {
            note: billId
              ? `No CBO cost estimate on record for ${billId}. Say so explicitly — do not estimate or guess a score.`
              : 'No CBO cost estimates matched. Say so explicitly — do not estimate or guess a score.',
          }
        : {}),
    };
  }

  /**
   * Canonical entity resolution (Bucket-#3 C6.P6.2, SC2.2): id / external-id /
   * designation / name -> canonical registry rows. Zero matches returns an
   * EXPLICIT not-found note — the model must never fabricate an identifier.
   */
  private async resolveEntity(input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 200)?.trim();
    const type = optionalString(input, 'type', 20)?.toLowerCase();
    const limit = clampInt(input.limit, 1, 10, 5);
    if (!query) {
      return {
        tool: 'resolve_entity',
        generatedAt: new Date().toISOString(),
        matchesFound: 0,
        matches: [],
        note: 'resolve_entity requires a query (an id, bill designation, or name).',
      };
    }

    type EntityMatch = Record<string, unknown> & {
      entityType: string;
      canonicalIdType: string;
      canonicalId: string;
      matchedBy: string;
    };
    const matches: EntityMatch[] = [];
    const memberMatch = (
      m: {
        bioguideId: string;
        fullName: string;
        party: string | null;
        state: string | null;
        district: number | null;
        chamber: string;
        lisId: string | null;
        isCurrent: boolean;
      },
      matchedBy: string,
    ): EntityMatch => ({
      entityType: 'member',
      canonicalIdType: 'bioguide',
      canonicalId: m.bioguideId,
      display: m.fullName,
      party: m.party,
      state: m.state,
      district: m.district,
      chamber: m.chamber,
      lisId: m.lisId,
      isCurrent: m.isCurrent,
      matchedBy,
    });
    const committeeMatch = (
      c: {
        systemCode: string;
        name: string;
        chamber: string;
        parentSystemCode: string | null;
        isCurrent: boolean;
      },
      matchedBy: string,
    ): EntityMatch => ({
      entityType: 'committee',
      canonicalIdType: 'committee',
      canonicalId: c.systemCode,
      display: c.name,
      chamber: c.chamber,
      parentSystemCode: c.parentSystemCode,
      isCurrent: c.isCurrent,
      matchedBy,
    });
    const stateLegislatorMatch = (
      m: {
        id: string;
        name: string;
        state: string;
        chamber: string | null;
        district: string | null;
        party: string | null;
        active: boolean;
      },
      matchedBy: string,
    ): EntityMatch => ({
      entityType: 'state_legislator',
      canonicalIdType: 'openstatesPersonId',
      canonicalId: m.id,
      display: m.name,
      state: m.state,
      chamber: m.chamber,
      district: m.district,
      party: m.party,
      isCurrent: m.active,
      matchedBy,
    });

    // 1. Direct canonical-id hits.
    if (!type || type === 'member') {
      const bioguide = normalizeCanonicalId('bioguide', query);
      if (isValidCanonicalId('bioguide', bioguide)) {
        const m = await this.prisma.congressMember.findUnique({ where: { bioguideId: bioguide } });
        if (m) matches.push(memberMatch(m, 'bioguide-id'));
      }
    }
    if (!type || type === 'committee') {
      const systemCode = normalizeCanonicalId('committee', query);
      if (isValidCanonicalId('committee', systemCode)) {
        const c = await this.prisma.congressCommittee.findUnique({ where: { systemCode } });
        if (c) matches.push(committeeMatch(c, 'system-code'));
      }
    }
    if (!type || type === 'bill') {
      const currentCongress = Math.floor((new Date().getUTCFullYear() - 1789) / 2) + 1;
      const norm = normalizeCanonicalId('billId', query);
      let billIdCandidate = isValidCanonicalId('billId', norm) ? norm : null;
      if (!billIdCandidate) {
        const parsed = parseBillDesignation(query, currentCongress);
        if (parsed) billIdCandidate = formatBillId(parsed.congress, parsed.type, parsed.number);
      }
      if (billIdCandidate) {
        const b = await this.prisma.congressBill.findUnique({
          where: { id: billIdCandidate },
          select: {
            id: true,
            title: true,
            congress: true,
            sponsorName: true,
            sponsorBioguideId: true,
            latestActionText: true,
            latestActionDate: true,
          },
        });
        if (b) {
          matches.push({
            entityType: 'bill',
            canonicalIdType: 'billId',
            canonicalId: b.id,
            display: b.title,
            congress: b.congress,
            sponsorName: b.sponsorName,
            sponsorBioguideId: b.sponsorBioguideId,
            latestActionText: b.latestActionText,
            latestActionDate: b.latestActionDate,
            matchedBy: 'bill-id',
          });
        }
      }
    }
    if (!type || type === 'state_bill') {
      const normKey = normalizeCanonicalId('stateBillKey', query);
      let billKeyCandidate = isValidCanonicalId('stateBillKey', normKey) ? normKey : null;
      if (!billKeyCandidate) {
        const parsed = parseStateBillDesignation(query, null);
        if (parsed) {
          const candidates = await this.prisma.withSystem((tx) =>
            tx.stateBill.findMany({
              where: { state: parsed.state, billNumber: parsed.billNumber },
              orderBy: { syncedAt: 'desc' },
              select: { id: true },
              take: 1,
            }),
          );
          billKeyCandidate = candidates[0]?.id ?? null;
        }
      }
      if (billKeyCandidate) {
        const b = await this.prisma.withSystem((tx) =>
          tx.stateBill.findUnique({
            where: { id: billKeyCandidate! },
            select: {
              id: true,
              title: true,
              state: true,
              sessionKey: true,
              sponsorName: true,
              latestActionText: true,
              latestActionDate: true,
            },
          }),
        );
        if (b) {
          matches.push({
            entityType: 'state_bill',
            canonicalIdType: 'stateBillKey',
            canonicalId: b.id,
            display: b.title,
            state: b.state,
            session: b.sessionKey,
            sponsorName: b.sponsorName,
            latestActionText: b.latestActionText,
            latestActionDate: b.latestActionDate,
            matchedBy: 'state-bill-key',
          });
        }
      }
    }

    // 2. External-id crosswalk (LIS, FEC, OpenSecrets, GovTrack, LegiScan, OpenStates...).
    if (matches.length === 0) {
      const crosswalk = await this.prisma.entityCrosswalk.findMany({
        where: { idValue: { equals: query, mode: 'insensitive' } },
        take: limit,
      });
      for (const row of crosswalk) {
        if (row.entityType === 'member' && (!type || type === 'member')) {
          const m = await this.prisma.congressMember.findUnique({
            where: { bioguideId: row.entityKey },
          });
          if (m) matches.push(memberMatch(m, `${row.idType}-crosswalk`));
        }
        if (row.entityType === 'state_bill' && (!type || type === 'state_bill')) {
          const b = await this.prisma.withSystem((tx) =>
            tx.stateBill.findUnique({
              where: { id: row.entityKey },
              select: {
                id: true,
                title: true,
                state: true,
                sessionKey: true,
                sponsorName: true,
                latestActionText: true,
                latestActionDate: true,
              },
            }),
          );
          if (b) {
            matches.push({
              entityType: 'state_bill',
              canonicalIdType: 'stateBillKey',
              canonicalId: b.id,
              display: b.title,
              state: b.state,
              session: b.sessionKey,
              sponsorName: b.sponsorName,
              latestActionText: b.latestActionText,
              latestActionDate: b.latestActionDate,
              matchedBy: `${row.idType}-crosswalk`,
            });
          }
        }
        if (row.entityType === 'state_legislator' && (!type || type === 'state_legislator')) {
          const m = await this.prisma.withSystem((tx) =>
            tx.stateLegislator.findUnique({ where: { id: row.entityKey } }),
          );
          if (m) matches.push(stateLegislatorMatch(m, `${row.idType}-crosswalk`));
        }
      }
    }

    // 3. Name search (members + committees + state legislators; current entities first).
    if (matches.length === 0 && /[a-z]/i.test(query)) {
      if (!type || type === 'member') {
        const members = await this.prisma.congressMember.findMany({
          where: {
            OR: [
              { fullName: { contains: query, mode: 'insensitive' } },
              { lastName: { contains: query, mode: 'insensitive' } },
            ],
          },
          orderBy: [{ isCurrent: 'desc' }, { lastName: 'asc' }],
          take: limit,
        });
        for (const m of members) matches.push(memberMatch(m, 'name-search'));
      }
      if ((!type || type === 'committee') && matches.length < limit) {
        const committeesFound = await this.prisma.congressCommittee.findMany({
          where: { name: { contains: query, mode: 'insensitive' } },
          orderBy: [{ isCurrent: 'desc' }, { systemCode: 'asc' }],
          take: limit - matches.length,
        });
        for (const c of committeesFound) matches.push(committeeMatch(c, 'name-search'));
      }
      if ((!type || type === 'state_legislator') && matches.length < limit) {
        const legislators = await this.prisma.withSystem((tx) =>
          tx.stateLegislator.findMany({
            where: { name: { contains: query, mode: 'insensitive' } },
            orderBy: [{ active: 'desc' }, { name: 'asc' }],
            take: limit - matches.length,
          }),
        );
        for (const m of legislators) matches.push(stateLegislatorMatch(m, 'name-search'));
      }
    }

    const trimmed = matches.slice(0, limit);
    return {
      tool: 'resolve_entity',
      generatedAt: new Date().toISOString(),
      matchesFound: trimmed.length,
      matches: trimmed,
      ...(trimmed.length === 0
        ? {
            note: `No canonical entity matched "${query}". Say so explicitly — do NOT fabricate a member, committee, or bill identifier.`,
          }
        : {}),
    };
  }

  private async searchLdaFilings(input: Record<string, unknown>) {
    const clientName =
      optionalString(input, 'clientName', 200) ?? optionalString(input, 'query', 200);
    const issueCode =
      optionalString(input, 'issueCode', 120) ?? optionalString(input, 'issue', 120);
    const registrantName =
      optionalString(input, 'registrantName', 200) ?? optionalString(input, 'registrant', 200);
    const year = input.year ? Number(input.year) : undefined;
    const limit = clampInt(input.limit, 1, 50, 15);
    const page = clampInt(input.page, 1, 100, 1);

    const filings = await this.ldaIntel.getFilings({
      clientName: clientName ?? undefined,
      issueCode: issueCode ?? undefined,
      registrantName: registrantName ?? undefined,
      year,
      page,
      limit,
    });

    return {
      tool: 'search_lda_filings',
      generatedAt: new Date().toISOString(),
      ...filings,
    };
  }

  // ── New intelligence data source tools ──────────────────────────────

  private async searchSecFilings(input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 240) ?? optionalString(input, 'companyName', 240);
    const formType = optionalString(input, 'formType', 20);
    const cik = optionalString(input, 'cik', 20);
    const limit = clampInt(input.limit, 1, 50, 20);

    const where: Record<string, unknown> = {};
    if (query) where.companyName = { contains: query, mode: 'insensitive' };
    if (formType) where.formType = formType;
    if (cik) where.cik = cik;

    const [data, total] = await Promise.all([
      this.prisma.withSystem((tx) =>
        tx.secFiling.findMany({
          where,
          orderBy: { filingDate: 'desc' },
          take: limit,
        }),
      ),
      this.prisma.withSystem((tx) => tx.secFiling.count({ where })),
    ]);

    return {
      tool: 'search_sec_filings',
      generatedAt: new Date().toISOString(),
      total,
      data: data.map((f) => ({
        id: f.id,
        cik: f.cik,
        companyName: f.companyName,
        formType: f.formType,
        accessionNumber: f.accessionNumber,
        filingDate: f.filingDate,
        description: summarizeText(f.description, 300),
        url: f.url,
      })),
    };
  }

  private async searchFaraRegistrations(input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 240);
    const registrantName =
      optionalString(input, 'registrantName', 240) ?? optionalString(input, 'registrant', 240);
    const foreignPrincipal = optionalString(input, 'foreignPrincipal', 240);
    const country = optionalString(input, 'country', 120);
    const status = optionalString(input, 'status', 20);
    const limit = clampInt(input.limit, 1, 50, 20);

    const where: Record<string, unknown> = {};
    if (query) {
      where.OR = [
        { registrantName: { contains: query, mode: 'insensitive' } },
        { foreignPrincipal: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
      ];
    }
    if (registrantName) where.registrantName = { contains: registrantName, mode: 'insensitive' };
    if (foreignPrincipal)
      where.foreignPrincipal = { contains: foreignPrincipal, mode: 'insensitive' };
    if (country) where.country = { contains: country, mode: 'insensitive' };
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      this.prisma.withSystem((tx) =>
        tx.faraRegistration.findMany({
          where,
          orderBy: { registrationDate: 'desc' },
          take: limit,
        }),
      ),
      this.prisma.withSystem((tx) => tx.faraRegistration.count({ where })),
    ]);

    return {
      tool: 'search_fara_registrations',
      generatedAt: new Date().toISOString(),
      total,
      data: data.map((r) => ({
        id: r.id,
        registrationNumber: r.registrationNumber,
        registrantName: r.registrantName,
        foreignPrincipal: r.foreignPrincipal,
        country: r.country,
        status: r.status,
        registrationDate: r.registrationDate,
        description: summarizeText(r.description, 300),
      })),
    };
  }

  private async searchFederalAwards(input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 240);
    const agency = optionalString(input, 'agency', 240);
    const peCode = optionalString(input, 'peCode', 16);
    const limit = clampInt(input.limit, 1, 50, 20);

    const where: Record<string, unknown> = {};
    if (query) {
      where.OR = [
        { description: { contains: query, mode: 'insensitive' } },
        { contractorName: { contains: query, mode: 'insensitive' } },
        { awardingAgency: { contains: query, mode: 'insensitive' } },
      ];
    }
    if (agency) where.awardingAgency = { contains: agency, mode: 'insensitive' };
    if (peCode) where.peCode = peCode.toUpperCase();

    const [data, total] = await Promise.all([
      this.prisma.withSystem((tx) =>
        tx.federalAward.findMany({ where, orderBy: { actionDate: 'desc' }, take: limit }),
      ),
      this.prisma.withSystem((tx) => tx.federalAward.count({ where })),
    ]);

    return {
      tool: 'search_federal_awards',
      generatedAt: new Date().toISOString(),
      total,
      data: data.map((a) => ({
        id: a.id,
        contractorName: a.contractorName,
        awardingAgency: a.awardingAgency,
        awardingSubTier: a.awardingSubTier,
        amount: a.amount != null ? Number(a.amount) : null,
        description: summarizeText(a.description ?? '', 240),
        peCode: a.peCode,
        recipientState: a.recipientState,
        popCongressionalDistrict: a.popCongressionalDistrict,
        actionDate: a.actionDate,
        piid: a.piid,
      })),
    };
  }

  // ── Program Element (DoD budget) tools ──────────────────────────────

  private async searchProgramElements(ctx: TenantContext, input: Record<string, unknown>) {
    const q = optionalString(input, 'query', 240) ?? optionalString(input, 'q', 240);
    const service = optionalString(input, 'service', 60);
    const budgetActivity = optionalString(input, 'budgetActivity', 120);
    const hasData = optionalBoolean(input, 'hasData');
    const limit = clampInt(input.limit, 1, 50, 20);
    const page = clampInt(input.page, 1, 100, 1);

    const result = await this.programElement.listProgramElements(
      {
        q: q ?? undefined,
        service: service ?? undefined,
        budgetActivity: budgetActivity ?? undefined,
        hasData: hasData ? 'true' : undefined,
        limit,
        page,
      },
      ctx,
    );

    // RC1: the finder row is built for the web UI — it ships a bare, stage-less
    // `spark` array and coalesced money fields whose request/current can be from
    // different fiscal years. Never hand those to the model. Drop `spark` and the
    // raw figures, and replace them with a single labeled `funding` object (FY +
    // stage + authorization/appropriations vehicle + a same-FY-only direction),
    // pointing the model to get_pe_budget_timeline for the mark-by-mark detail.
    type FinderRowForModel = {
      spark?: number[] | null;
      peCode?: string | null;
      appropriationType?: string | null;
      budgetActivity?: string | null;
      latestCurrent: number | null;
      latestCurrentFy: number | null;
      latestCurrentStage: string | null;
      latestRequest: number | null;
      latestRequestFy: number | null;
      latestEnacted: number | null;
      latestEnactedFy: number | null;
      deltaPct: number | null;
      [key: string]: unknown;
    };
    const data = (result.data as FinderRowForModel[]).map((row) => {
      const {
        spark: _spark,
        latestCurrent,
        latestCurrentFy,
        latestCurrentStage,
        latestRequest,
        latestRequestFy,
        latestEnacted,
        latestEnactedFy,
        deltaPct,
        ...rest
      } = row;
      // RC2: the `peCode` field holds BOTH true R-1/R-2 Program Elements AND P-1
      // procurement line items keyed <appropriationCode><lineItemNumber> (e.g.
      // 1507N2280) — the code SHAPE is the authoritative discriminator (the two
      // regexes never collide). Tell the model, per row, which noun applies so it
      // never calls a procurement line a "Program Element" (the S2-1 error) — and
      // so it needn't spend a get_program_element call just to learn the noun.
      const code = typeof row.peCode === 'string' ? row.peCode : '';
      const identifierKind: 'pe' | 'procurement_line_item' | 'other' =
        isValidProcurementCode(code) && !isValidPeCode(code)
          ? 'procurement_line_item'
          : isValidPeCode(code)
            ? 'pe'
            : 'other';
      return {
        ...rest,
        identifierKind,
        budgetExhibitType: budgetExhibitType({
          peCode: code,
          appropriationType:
            typeof row.appropriationType === 'string' ? row.appropriationType : null,
          budgetActivity: typeof row.budgetActivity === 'string' ? row.budgetActivity : null,
        }),
        funding: buildSearchRowFundingForModel({
          latestCurrent,
          latestCurrentFy,
          latestCurrentStage,
          latestRequest,
          latestRequestFy,
          latestEnacted,
          latestEnactedFy,
          deltaPct,
        }),
      };
    });

    return {
      tool: 'search_program_elements',
      generatedAt: new Date().toISOString(),
      ...result,
      data,
    };
  }

  private async getProgramElementDetail(ctx: TenantContext, input: Record<string, unknown>) {
    const peCode = requiredString(input, 'peCode', 32);
    const programElement = (await this.programElement.getProgramElement(peCode, ctx)) as Record<
      string,
      unknown
    >;
    return {
      tool: 'get_program_element',
      generatedAt: new Date().toISOString(),
      // Tell the model the noun to use (P-1 procurement line item vs R-1 PE) so it
      // never calls a procurement line a "Program Element".
      budgetExhibitType: budgetExhibitType({
        peCode,
        appropriationType: (programElement.appropriationType as string | null) ?? null,
        budgetActivity: (programElement.budgetActivity as string | null) ?? null,
      }),
      programElement,
    };
  }

  private async getPeBudgetTimeline(input: Record<string, unknown>) {
    const peCode = requiredString(input, 'peCode', 32);
    const timeline = await this.programElement.getTimeline(peCode);
    return {
      tool: 'get_pe_budget_timeline',
      generatedAt: new Date().toISOString(),
      budgetExhibitType: budgetExhibitType({
        peCode,
        appropriationType: timeline.appropriationType,
        budgetActivity: timeline.budgetActivity,
      }),
      ...timeline,
    };
  }

  private async getPeReportLanguage(input: Record<string, unknown>) {
    const peCode = requiredString(input, 'peCode', 32);
    const provisions = await this.programElement.getProvisionsForPe(peCode);
    // RC7: program-level (program_alias) links may apply to sibling PEs — flag
    // them so the model attributes program-wide language at the program level,
    // not exclusively to this PE. Each such item also carries attributionCaveat.
    const programLevel = provisions.filter((p) => p.matchScope === 'program_level').length;
    return {
      tool: 'get_pe_report_language',
      generatedAt: new Date().toISOString(),
      peCode,
      provisions,
      // Make the "no grounded reason" case explicit so the model states it rather
      // than inventing a justification for a mark from the title / dollar delta.
      note: !provisions.length
        ? "No committee report language is linked to this budget line in Capiro's data. Do NOT infer why a mark changed — state that the justification is not available."
        : programLevel
          ? `${programLevel} of ${provisions.length} linked provision(s) are PROGRAM-LEVEL matches (matched via a program alias, because FY committee reports name programs, not PE codes). They may apply to sibling PEs in the same program — attribute such language at the program level, not exclusively to this PE. Each carries matchScope:"program_level" and an attributionCaveat.`
          : undefined,
    };
  }

  private async getPeContractors(input: Record<string, unknown>) {
    const peCode = requiredString(input, 'peCode', 32);
    const result = await this.programElement.getContractors(peCode);
    return {
      tool: 'get_pe_contractors',
      generatedAt: new Date().toISOString(),
      ...result,
    };
  }

  private async getPeBills(input: Record<string, unknown>) {
    const peCode = requiredString(input, 'peCode', 32);
    const bills = await this.programElement.getBills(peCode);
    return {
      tool: 'get_pe_bills',
      generatedAt: new Date().toISOString(),
      bills,
    };
  }

  // ── Acquisition personnel (DoD program people) tools ────────────────

  private async searchAcquisitionPersonnel(ctx: TenantContext, input: Record<string, unknown>) {
    const q = optionalString(input, 'query', 240) ?? optionalString(input, 'q', 240);
    const service = optionalString(input, 'service', 60);
    const organization = optionalString(input, 'organization', 200);
    const role = optionalString(input, 'role', 60);
    const peCode = optionalString(input, 'peCode', 32);
    const limit = clampInt(input.limit, 1, 50, 20);
    const page = clampInt(input.page, 1, 100, 1);

    const result = await this.acquisitionPersonnel.listPersonnel(
      {
        q: q ?? undefined,
        service: service ?? undefined,
        organization: organization ?? undefined,
        role: role ?? undefined,
        pe_code: peCode ?? undefined,
        page,
        limit,
      },
      ctx,
    );

    return {
      tool: 'search_acquisition_personnel',
      generatedAt: new Date().toISOString(),
      ...result,
    };
  }

  private async getAcquisitionPerson(ctx: TenantContext, input: Record<string, unknown>) {
    const id = requiredString(input, 'id', 80);
    const person = await this.acquisitionPersonnel.getPersonDetail(id, ctx);
    return {
      tool: 'get_acquisition_person',
      generatedAt: new Date().toISOString(),
      person,
    };
  }

  private async searchFederalGrants(input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 240);
    const agency = optionalString(input, 'agency', 240);
    const status = optionalString(input, 'status', 30);
    const limit = clampInt(input.limit, 1, 50, 20);

    const where: Record<string, unknown> = {};
    if (query) {
      where.OR = [
        { title: { contains: query, mode: 'insensitive' } },
        { description: { contains: query, mode: 'insensitive' } },
        { agency: { contains: query, mode: 'insensitive' } },
      ];
    }
    if (agency) where.agency = { contains: agency, mode: 'insensitive' };
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      this.prisma.withSystem((tx) =>
        tx.federalGrant.findMany({
          where,
          orderBy: { closeDate: 'desc' },
          take: limit,
        }),
      ),
      this.prisma.withSystem((tx) => tx.federalGrant.count({ where })),
    ]);

    // GAI-09: derive open/closed from closeDate against a fixed clock instead of
    // trusting the sync-time `status` string (which stays 'posted' after a grant
    // closes). closeDate is a @db.Date (UTC midnight); a grant is treated as open
    // through the END of its ET close day (Grants.gov deadlines are end-of-day
    // ET), so we compare the ET calendar date of "now" to the grant's UTC-read
    // date. The model gets a deterministic deadlineStatus + the as-of anchor
    // (generatedAt) rather than doing its own date math with no clock.
    const nowIso = new Date().toISOString();
    const todayYmdEt = ymdInZone(new Date(), 'America/New_York');
    const deadlineStatus = (closeDate: Date | null): 'open' | 'closed' | 'unknown' => {
      if (!closeDate) return 'unknown';
      const closeYmd = ymdInZone(closeDate, 'UTC');
      return closeYmd >= todayYmdEt ? 'open' : 'closed';
    };

    return {
      tool: 'search_federal_grants',
      generatedAt: nowIso,
      // The stored `status` is sync-time and can be stale; `deadlineStatus` is
      // derived from closeDate vs generatedAt. Prefer deadlineStatus for open/
      // closed decisions; a null closeDate is 'unknown', never assume "no deadline".
      asOf: nowIso,
      total,
      data: data.map((g) => ({
        id: g.id,
        title: summarizeText(g.title, 240),
        agency: g.agency,
        subAgency: g.subAgency,
        opportunityNumber: g.opportunityNumber,
        category: g.category,
        awardCeiling: g.awardCeiling,
        awardFloor: g.awardFloor,
        estimatedFunding: g.estimatedFunding,
        openDate: g.openDate,
        closeDate: g.closeDate,
        deadlineStatus: deadlineStatus(g.closeDate),
        syncedStatus: g.status,
        eligibility: g.eligibility,
        url: g.url,
      })),
    };
  }

  private async searchGaoReports(input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 240);
    const reportType = optionalString(input, 'reportType', 60);
    const limit = clampInt(input.limit, 1, 50, 20);

    const where: Record<string, unknown> = {};
    if (query) {
      where.OR = [
        { title: { contains: query, mode: 'insensitive' } },
        { summary: { contains: query, mode: 'insensitive' } },
        { topics: { hasSome: [query] } },
        { agencies: { hasSome: [query] } },
      ];
    }
    if (reportType) where.reportType = reportType;

    const [data, total] = await Promise.all([
      this.prisma.withSystem((tx) =>
        tx.gaoReport.findMany({
          where,
          orderBy: { publishDate: 'desc' },
          take: limit,
        }),
      ),
      this.prisma.withSystem((tx) => tx.gaoReport.count({ where })),
    ]);

    return {
      tool: 'search_gao_reports',
      generatedAt: new Date().toISOString(),
      total,
      data: data.map((r) => ({
        id: r.id,
        title: summarizeText(r.title, 240),
        url: r.url,
        publishDate: r.publishDate,
        reportType: r.reportType,
        topics: r.topics,
        agencies: r.agencies,
        summary: summarizeText(r.summary, 400),
        recommendations: r.recommendations,
      })),
    };
  }

  private async searchStateBills(input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 240);
    const state = optionalString(input, 'state', 2);
    const session = optionalString(input, 'session', 60);
    const status = optionalString(input, 'status', 30);
    const limit = clampInt(input.limit, 1, 50, 20);

    const where: Record<string, unknown> = {};
    if (query) {
      where.OR = [
        { title: { contains: query, mode: 'insensitive' } },
        { identifier: { contains: query, mode: 'insensitive' } },
        { subjects: { hasSome: [query] } },
      ];
    }
    if (state) where.state = state.toUpperCase();
    if (session) where.session = session;
    if (status) where.status = status;

    const [data, total] = await Promise.all([
      this.prisma.withSystem((tx) =>
        tx.stateBill.findMany({
          where,
          orderBy: { latestActionDate: 'desc' },
          take: limit,
        }),
      ),
      this.prisma.withSystem((tx) => tx.stateBill.count({ where })),
    ]);

    return {
      tool: 'search_state_bills',
      generatedAt: new Date().toISOString(),
      total,
      data: data.map((b) => ({
        id: b.id,
        state: b.state,
        session: b.session,
        identifier: b.identifier,
        title: summarizeText(b.title, 240),
        chamber: b.chamber,
        subjects: b.subjects,
        status: b.status,
        statusLabel: stateBillStatusLabel(b.status),
        sponsorName: b.sponsorName,
        sponsorParty: b.sponsorParty,
        sponsorCount: b.sponsorCount,
        latestActionDate: b.latestActionDate,
        latestActionText: b.latestActionText,
        stateUrl: b.stateUrl,
        url: b.url,
      })),
      ...(total === 0
        ? {
            note: 'No state bill on record matches that. Say so explicitly — do not describe a bill from memory.',
          }
        : {}),
    };
  }

  /**
   * Authoritative state-bill status (S6.1) — mirrors getBillStatus's shape:
   * resolve → look up → honesty note on empty vote history / dead_by_deadline
   * → typed return with companions and their own status.
   */
  private async getStateBillStatus(input: Record<string, unknown>) {
    const raw = optionalString(input, 'billId', 60) ?? optionalString(input, 'query', 60);
    const stateHint = optionalString(input, 'state', 2);
    const resolved = await this.resolveStateBillKey(raw, stateHint);
    if (!resolved.key) {
      return {
        tool: 'get_state_bill_status',
        generatedAt: new Date().toISOString(),
        found: false,
        note: resolved.note,
      };
    }
    const billId = resolved.key;
    const bill = await this.prisma.withSystem((tx) =>
      tx.stateBill.findUnique({
        where: { id: billId },
        select: {
          id: true,
          state: true,
          sessionKey: true,
          identifier: true,
          title: true,
          status: true,
          statusAt: true,
          latestActionText: true,
          latestActionDate: true,
          sponsorName: true,
          sponsorParty: true,
          sponsorCount: true,
          stateUrl: true,
          url: true,
        },
      }),
    );
    if (!bill) {
      return {
        tool: 'get_state_bill_status',
        generatedAt: new Date().toISOString(),
        billId,
        found: false,
        note: `No bill ${billId} on record in the Capiro database. Say so explicitly — do not describe its status from memory.`,
      };
    }

    const [actions, votes, links] = await Promise.all([
      this.prisma.withSystem((tx) =>
        tx.stateBillAction.findMany({
          where: { billKey: billId },
          orderBy: { date: 'desc' },
          take: 15,
          select: { date: true, text: true, chamber: true, importance: true },
        }),
      ),
      this.prisma.withSystem((tx) =>
        tx.stateRollCallVote.findMany({
          where: { billKey: billId },
          orderBy: { date: 'desc' },
          take: 15,
          select: {
            chamber: true,
            motion: true,
            date: true,
            yeas: true,
            nays: true,
            nv: true,
            absent: true,
            passed: true,
            sourceUrl: true,
          },
        }),
      ),
      this.prisma.withSystem((tx) =>
        tx.stateBillLink.findMany({
          where: { billKey: billId },
          select: { relatedBillKey: true, linkType: true },
        }),
      ),
    ]);

    const companions = await Promise.all(
      links
        .filter((l): l is typeof l & { relatedBillKey: string } => !!l.relatedBillKey)
        .map(async (l) => {
          const rb = await this.prisma.withSystem((tx) =>
            tx.stateBill.findUnique({
              where: { id: l.relatedBillKey },
              select: { identifier: true, status: true, title: true },
            }),
          );
          return {
            relatedBillKey: l.relatedBillKey,
            linkType: l.linkType,
            identifier: rb?.identifier ?? null,
            status: rb?.status ?? null,
            statusLabel: rb ? stateBillStatusLabel(rb.status) : null,
          };
        }),
    );

    const notes: string[] = [];
    if (votes.length === 0) {
      notes.push(
        'No recorded roll-call vote on this bill. Do NOT infer that it passed or failed a chamber from the absence of a vote.',
      );
    }
    if (bill.status === 'dead_by_deadline') {
      notes.push(
        'The legislative session adjourned sine die before this bill reached a terminal outcome — it is dead absent a special session, not merely "pending."',
      );
    }

    return {
      tool: 'get_state_bill_status',
      generatedAt: new Date().toISOString(),
      billId,
      found: true,
      state: bill.state,
      session: bill.sessionKey,
      identifier: bill.identifier,
      title: bill.title,
      status: bill.status,
      statusLabel: stateBillStatusLabel(bill.status),
      statusAt: bill.statusAt,
      latestAction: { text: bill.latestActionText, date: bill.latestActionDate },
      sponsor: { name: bill.sponsorName, party: bill.sponsorParty, count: bill.sponsorCount },
      recentActions: actions,
      votes,
      companions,
      url: bill.stateUrl ?? bill.url,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  }

  /**
   * Search state roll-call votes (S6.1). No member-level filter in P0 —
   * per-member votes exist but name-resolution ships with the crosswalk
   * hardening; the tool description says so explicitly.
   */
  private async searchStateFloorVotes(input: Record<string, unknown>) {
    const rawBillId = optionalString(input, 'billId', 60);
    const stateHint = optionalString(input, 'state', 2);
    // 2026-07-10 hot-fix: a SUPPLIED billId that fails to resolve must
    // short-circuit here (mirroring getStateBillStatus's not-found
    // contract) — falling through to the state-prefix branch below would
    // silently return unrelated votes for the whole state instead of
    // honestly reporting that the requested bill wasn't found.
    let billKey: string | null = null;
    if (rawBillId) {
      const resolved = await this.resolveStateBillKey(rawBillId, stateHint);
      if (!resolved.key) {
        return {
          tool: 'search_state_floor_votes',
          generatedAt: new Date().toISOString(),
          votesFound: 0,
          votes: [],
          note: resolved.note,
        };
      }
      billKey = resolved.key;
    }
    const query = optionalString(input, 'query', 200);
    const state = optionalString(input, 'state', 2)?.toUpperCase();
    const chamber = optionalString(input, 'chamber', 10)?.toLowerCase();
    const limit = clampInt(input.limit, 1, 25, 10);

    const where: Record<string, unknown> = {};
    if (billKey) where.billKey = billKey;
    else if (state) where.billKey = { startsWith: `${state.toLowerCase()}-` };
    if (chamber === 'upper' || chamber === 'lower') where.chamber = chamber;
    if (query) where.motion = { contains: query, mode: 'insensitive' };

    const votes = await this.prisma.withSystem((tx) =>
      tx.stateRollCallVote.findMany({
        where,
        orderBy: { date: 'desc' },
        take: limit,
        select: {
          id: true,
          billKey: true,
          chamber: true,
          motion: true,
          date: true,
          yeas: true,
          nays: true,
          nv: true,
          absent: true,
          passed: true,
          sourceUrl: true,
        },
      }),
    );

    return {
      tool: 'search_state_floor_votes',
      generatedAt: new Date().toISOString(),
      votesFound: votes.length,
      votes,
      ...(votes.length === 0
        ? {
            note: 'No state roll-call vote on record matches that. Say so explicitly — do not infer a vote outcome or tally. Member-level filtering is not available for state votes yet.',
          }
        : {}),
    };
  }

  /**
   * List CURRENT federal members of Congress by state and/or chamber. The direct
   * roster lookup resolve_entity (a name matcher) could not express — reads
   * CongressMember {isCurrent, chamber, state}. The `state` column stores the
   * FULL state name ("Virginia"), so a 2-letter code is translated first. At
   * least one filter is required so we never dump the whole 535-member roster.
   */
  private async listMembers(input: Record<string, unknown>) {
    const rawState = optionalString(input, 'state', 40);
    const chamberRaw = optionalString(input, 'chamber', 10)?.toLowerCase();
    const chamber = chamberRaw === 'house' || chamberRaw === 'senate' ? chamberRaw : undefined;
    const limit = clampInt(input.limit, 1, 100, 100);
    const stateName = rawState ? resolveStateName(rawState) : undefined;

    // Check a supplied-but-unrecognized state BEFORE the no-filter case so a
    // typo'd state (with or without a chamber) gets the specific message rather
    // than the generic "provide a filter" one.
    if (rawState && !stateName) {
      return {
        tool: 'list_members',
        generatedAt: new Date().toISOString(),
        matchesFound: 0,
        members: [],
        note: `"${rawState}" is not a recognized US state or territory — say so explicitly, do not guess a roster.`,
      };
    }
    if (!stateName && !chamber) {
      return {
        tool: 'list_members',
        generatedAt: new Date().toISOString(),
        matchesFound: 0,
        members: [],
        note: 'Provide a state (full name or 2-letter code) and/or a chamber ("house"|"senate") — at least one filter is required.',
      };
    }

    const rows = await this.prisma.congressMember.findMany({
      where: {
        isCurrent: true,
        ...(chamber ? { chamber } : {}),
        ...(stateName ? { state: { equals: stateName, mode: 'insensitive' } } : {}),
      },
      select: {
        bioguideId: true,
        fullName: true,
        party: true,
        state: true,
        district: true,
        chamber: true,
      },
      orderBy: [{ state: 'asc' }, { chamber: 'asc' }, { lastName: 'asc' }],
      take: limit,
    });

    const label = stateName ? (chamber ? `${stateName}-${chamber}` : stateName) : (chamber ?? '');
    return {
      tool: 'list_members',
      generatedAt: new Date().toISOString(),
      filter: { state: stateName ?? null, chamber: chamber ?? null },
      matchesFound: rows.length,
      members: rows.map((m) => ({
        id: m.bioguideId,
        name: m.fullName,
        party: m.party,
        state: m.state,
        district: m.chamber === 'house' ? m.district : null,
        chamber: m.chamber,
      })),
      note: rows.length
        ? `Current members from the Capiro congressional roster (congress_member, is_current). Cite as [S:list_members:${label}]. Note every state has exactly 2 senators; if a senate query returns fewer than 2, the roster is incomplete for that state — say so rather than inventing a name.`
        : `No current members found for "${label}" in the Capiro roster — say so explicitly; do not guess names.`,
    };
  }

  /**
   * Look up a state legislator by name+state or an external id (S6.1/S6.2).
   * Ambiguity/no-match contracts mirror searchFloorVotes's member resolution.
   */
  private async getStateLegislator(input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 120);
    const state = optionalString(input, 'state', 2)?.toUpperCase();
    const limit = clampInt(input.limit, 1, 8, 5);
    if (!query) {
      return {
        tool: 'get_state_legislator',
        generatedAt: new Date().toISOString(),
        matchesFound: 0,
        matches: [],
        note: 'Provide a legislator name or an OpenStates/LegiScan id.',
      };
    }

    const crosswalk = await this.prisma.entityCrosswalk.findMany({
      where: {
        idValue: { equals: query, mode: 'insensitive' },
        entityType: 'state_legislator',
      },
      take: 1,
    });
    if (crosswalk.length) {
      const legislator = await this.prisma.withSystem((tx) =>
        tx.stateLegislator.findUnique({ where: { id: crosswalk[0]!.entityKey } }),
      );
      if (legislator) {
        return {
          tool: 'get_state_legislator',
          generatedAt: new Date().toISOString(),
          matchesFound: 1,
          matches: [
            {
              id: legislator.id,
              name: legislator.name,
              state: legislator.state,
              chamber: legislator.chamber,
              district: legislator.district,
              party: legislator.party,
              committees: legislator.committees,
              active: legislator.active,
              matchedBy: `${crosswalk[0]!.idType}-crosswalk`,
            },
          ],
        };
      }
    }

    const where: Record<string, unknown> = { name: { contains: query, mode: 'insensitive' } };
    if (state) where.state = state;
    const candidates = await this.prisma.withSystem((tx) =>
      tx.stateLegislator.findMany({
        where,
        orderBy: [{ active: 'desc' }, { name: 'asc' }],
        take: limit,
      }),
    );
    if (!candidates.length) {
      return {
        tool: 'get_state_legislator',
        generatedAt: new Date().toISOString(),
        matchesFound: 0,
        matches: [],
        note: `No state legislator matched "${query}"${state ? ` in ${state}` : ''}. Say so explicitly — do not fabricate a legislator.`,
      };
    }
    if (candidates.length > 1) {
      return {
        tool: 'get_state_legislator',
        generatedAt: new Date().toISOString(),
        matchesFound: 0,
        matches: [],
        ambiguousLegislator: candidates.map((c) => ({
          id: c.id,
          name: c.name,
          state: c.state,
          chamber: c.chamber,
          district: c.district,
          party: c.party,
        })),
        note: `"${query}" matches ${candidates.length} state legislators — ask the user which (by state/chamber/district) before attributing anything to them.`,
      };
    }
    const m = candidates[0]!;
    return {
      tool: 'get_state_legislator',
      generatedAt: new Date().toISOString(),
      matchesFound: 1,
      matches: [
        {
          id: m.id,
          name: m.name,
          state: m.state,
          chamber: m.chamber,
          district: m.district,
          party: m.party,
          committees: m.committees,
          active: m.active,
          matchedBy: 'name-search',
        },
      ],
    };
  }

  /**
   * M4.1 (PD3) — "who chairs this committee" without guessing. Federal and
   * state are separate namespaces (a "Rules" committee exists in both, with
   * unrelated membership) so `jurisdiction` is required and never inferred
   * from the committee string alone; reuses the same resolver/query shapes
   * as `ChokepointService` (M2.4) so this tool and the Chokepoint UI can
   * never disagree about who a committee's chair is.
   */
  private async getCommitteeRoster(input: Record<string, unknown>) {
    const committeeQuery = optionalString(input, 'committee', 200);
    const jurisdiction = optionalString(input, 'jurisdiction', 10)?.toLowerCase();
    const chamber = optionalString(input, 'chamber', 10)?.toLowerCase();
    const state = optionalString(input, 'state', 2)?.toUpperCase();

    if (!committeeQuery || (jurisdiction !== 'federal' && jurisdiction !== 'state')) {
      return {
        tool: 'get_committee_roster',
        generatedAt: new Date().toISOString(),
        committee: null,
        chair: null,
        viceChair: null,
        rankingMember: null,
        members: [],
        note: 'Provide a committee id/name AND jurisdiction ("federal" or "state") — the two are separate namespaces and cannot be guessed from the name alone.',
      };
    }
    if (jurisdiction === 'state' && !state) {
      return {
        tool: 'get_committee_roster',
        generatedAt: new Date().toISOString(),
        committee: null,
        chair: null,
        viceChair: null,
        rankingMember: null,
        members: [],
        note: 'state is required when jurisdiction=state — state committee ids/names are only unique within a state.',
      };
    }

    return jurisdiction === 'federal'
      ? this.federalCommitteeRoster(committeeQuery, chamber)
      : this.stateCommitteeRoster(committeeQuery, state!, chamber);
  }

  private async federalCommitteeRoster(query: string, chamberFilter: string | null | undefined) {
    const candidates = await this.prisma.congressCommittee.findMany({
      where: { isCurrent: true, ...(chamberFilter ? { chamber: chamberFilter } : {}) },
      select: { systemCode: true, name: true, chamber: true, parentSystemCode: true },
    });
    const match = resolveCommittee(
      { committeeName: query, committeeCode: query, chamber: chamberFilter ?? null },
      candidates as CommitteeCandidate[],
    );
    if (!match) {
      return {
        tool: 'get_committee_roster',
        generatedAt: new Date().toISOString(),
        committee: null,
        chair: null,
        viceChair: null,
        rankingMember: null,
        members: [],
        note: `No federal committee matched "${query}"${chamberFilter ? ` in ${chamberFilter}` : ''} — say so explicitly, do not guess.`,
      };
    }

    const memberships = await this.prisma.congressCommitteeMembership.findMany({
      where: { systemCode: match.systemCode },
      select: { bioguideId: true, side: true, rank: true, title: true },
    });
    const members = memberships.length
      ? await this.prisma.congressMember.findMany({
          where: { bioguideId: { in: memberships.map((m) => m.bioguideId) } },
          select: { bioguideId: true, fullName: true, party: true, state: true },
        })
      : [];
    const memberById = new Map(members.map((m) => [m.bioguideId, m]));
    const roster = memberships
      .map((m) => {
        const person = memberById.get(m.bioguideId);
        if (!person) return null;
        return {
          id: m.bioguideId,
          name: person.fullName,
          party: person.party,
          state: person.state,
          side: m.side,
          rank: m.rank,
          title: m.title,
        };
      })
      .filter((m): m is NonNullable<typeof m> => !!m)
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));

    const chairEntry = roster.find((m) => matchesRole(m.title, 'chair'));
    const viceChairEntry = roster.find((m) => matchesRole(m.title, 'viceChair'));
    const rankingEntry = roster.find((m) => matchesRole(m.title, 'rankingMember'));

    return {
      tool: 'get_committee_roster',
      generatedAt: new Date().toISOString(),
      committee: {
        id: match.systemCode,
        name: match.name,
        chamber: match.chamber,
        jurisdiction: 'federal',
        isSubcommittee: match.parentSystemCode != null,
        matchedBy: match.matchedBy,
      },
      chair: chairEntry ?? null,
      viceChair: viceChairEntry ?? null,
      rankingMember: rankingEntry ?? null,
      members: roster,
      // RC7: this federal roster carries each member's STATE but NOT their
      // congressional district (the S3-1 hazard: a memo inferred a member↔district
      // edge from committee membership). Say so explicitly so the model never
      // fabricates a district here — member↔district must come from
      // get_representation (address→district→member) or resolve_entity.
      note: roster.length
        ? "This roster carries each member's STATE only — it does NOT carry congressional districts. Do NOT infer or state a member's district from committee membership; use get_representation or resolve_entity for any member↔district claim."
        : 'Committee resolved but no roster rows are synced for it yet — say so explicitly, do not guess membership.',
    };
  }

  private async stateCommitteeRoster(
    query: string,
    state: string,
    chamberFilter: string | null | undefined,
  ) {
    const candidates = await this.prisma.stateCommittee.findMany({
      where: { state, ...(chamberFilter ? { chamber: chamberFilter } : {}) },
      select: { id: true, name: true, chamber: true },
    });
    let match: { id: string; name: string; chamber: string | null } | null =
      candidates.find((c) => c.id.toLowerCase() === query.toLowerCase()) ?? null;
    let matchedBy: 'id' | 'name' = 'id';
    if (!match) {
      const needle = normalizeCommitteeName(query);
      const nameMatches = candidates.filter((c) => normalizeCommitteeName(c.name) === needle);
      if (nameMatches.length === 1) {
        match = nameMatches[0]!;
        matchedBy = 'name';
      }
    }
    if (!match) {
      return {
        tool: 'get_committee_roster',
        generatedAt: new Date().toISOString(),
        committee: null,
        chair: null,
        viceChair: null,
        rankingMember: null,
        members: [],
        note: `No ${state} committee matched "${query}"${chamberFilter ? ` in the ${chamberFilter} chamber` : ''} — say so explicitly, do not guess.`,
      };
    }

    const roster = await this.prisma.stateCommitteeMembership.findMany({
      where: { committeeId: match.id },
      select: {
        role: true,
        legislator: {
          select: { id: true, name: true, chamber: true, party: true, district: true },
        },
      },
    });
    const members = roster.map((r) => ({
      id: r.legislator.id,
      name: r.legislator.name,
      party: r.legislator.party,
      chamber: r.legislator.chamber,
      district: r.legislator.district,
      role: r.role,
    }));
    const chairEntry = members.find((m) => matchesRole(m.role, 'chair'));
    const viceChairEntry = members.find((m) => matchesRole(m.role, 'viceChair'));

    return {
      tool: 'get_committee_roster',
      generatedAt: new Date().toISOString(),
      committee: {
        id: match.id,
        name: match.name,
        chamber: match.chamber,
        jurisdiction: 'state',
        matchedBy,
      },
      chair: chairEntry ?? null,
      viceChair: viceChairEntry ?? null,
      // State chambers do not share a common minority-leadership vocabulary
      // (survival-heuristic.ts's own documented limitation) — never guessed.
      rankingMember: null,
      members,
      note: members.length
        ? null
        : 'Committee resolved but no roster rows are synced for it yet — say so explicitly, do not guess membership.',
    };
  }

  /**
   * M4.2 (PD2/PD7) — "who represents this client's footprint," every
   * geocoded facility, federal + state. Thin wrap of the District Impact
   * Engine (M1.3) so Meri and the Client Intelligence "Your representatives"
   * UI can never disagree — same resolver, same join, no LLM guess at which
   * district contains an address.
   */
  private async getRepresentation(ctx: TenantContext, input: Record<string, unknown>) {
    const clientId = optionalString(input, 'clientId', 64);
    const stateFilter = optionalString(input, 'state', 2)?.toUpperCase();
    if (!clientId) {
      return {
        tool: 'get_representation',
        generatedAt: new Date().toISOString(),
        facilities: [],
        note: 'Provide a client UUID.',
      };
    }

    const rows = await this.representation.representationForClient(ctx.tenantId, clientId);
    const filtered = stateFilter ? rows.filter((r) => r.facility.state === stateFilter) : rows;

    return {
      tool: 'get_representation',
      generatedAt: new Date().toISOString(),
      facilities: filtered.map((r) => ({
        facilityId: r.facility.id,
        facilityName: r.facility.name,
        city: r.facility.city,
        state: r.facility.state,
        representation: r.representation.unresolved
          ? { unresolved: true, reason: r.representation.reason }
          : {
              federal: {
                house: r.representation.federal.house,
                senate: r.representation.federal.senate,
              },
              state: { lower: r.representation.state.lower, upper: r.representation.state.upper },
            },
      })),
      note: filtered.length
        ? null
        : `No facilities found for this client${stateFilter ? ` in ${stateFilter}` : ''} — say so explicitly, do not guess a representative.`,
    };
  }

  /**
   * M4.2 (PD5/PD8) — rule/notice status + lifecycle stage, both rails. A
   * `state_rule` id and a `federal_register_document.documentNumber` are
   * disjoint natural-key formats ("<state>-…" vs "<year>-<seq>"), so an
   * exact-id lookup can safely try both without risk of collision. Stage is
   * derived via the SAME `deriveRuleLifecycleStage` the federal Intelligence
   * aggregate's `regulatoryLifecycle` rail uses (M4.2 extraction into
   * `@capiro/shared`) — this tool and that UI rail can never disagree.
   */
  private async getStateRuleStatus(input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 200);
    const state = optionalString(input, 'state', 2)?.toUpperCase();
    if (!query) {
      return {
        tool: 'get_state_rule_status',
        generatedAt: new Date().toISOString(),
        found: false,
        note: 'Provide a rule/notice id ("FL-31100933", a Federal Register document number like "2026-01234"), or a title keyword.',
      };
    }

    if (!state) {
      const fr = await this.prisma.federalRegisterDocument.findUnique({
        where: { documentNumber: query },
      });
      if (fr) return this.formatRuleStatus('federal', fr);
    }
    const sr = await this.prisma.stateRule.findUnique({ where: { id: query } });
    // W4.5: honor the `state` filter on the exact-id path too — a caller who
    // scoped to (say) FL must not get an exact-id hit for a rule in another
    // state. state_rule.id is globally unique, so without this guard a mismatched
    // state param was silently ignored.
    if (sr && (!state || sr.state === state)) return this.formatRuleStatus('state', sr);

    // W4.5: match on abstract as well as title (the header promises a keyword
    // search over the notice text, and many rules carry the substantive keywords
    // only in the abstract).
    const stateMatches = await this.prisma.stateRule.findMany({
      where: {
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { abstract: { contains: query, mode: 'insensitive' } },
        ],
        ...(state ? { state } : {}),
      },
      take: 6,
    });
    const federalMatches = state
      ? []
      : await this.prisma.federalRegisterDocument.findMany({
          where: {
            OR: [
              { title: { contains: query, mode: 'insensitive' } },
              { abstract: { contains: query, mode: 'insensitive' } },
            ],
          },
          take: 6,
        });

    const total = stateMatches.length + federalMatches.length;
    if (total === 0) {
      return {
        tool: 'get_state_rule_status',
        generatedAt: new Date().toISOString(),
        found: false,
        note: `No rule or notice matched "${query}"${state ? ` in ${state}` : ''}. Say so explicitly — do not describe a rule's status from memory.`,
      };
    }
    if (total > 1) {
      return {
        tool: 'get_state_rule_status',
        generatedAt: new Date().toISOString(),
        found: false,
        ambiguousMatches: [
          ...stateMatches.map((r) => ({
            id: r.id,
            title: r.title,
            jurisdiction: 'state' as const,
            state: r.state,
          })),
          ...federalMatches.map((r) => ({
            id: r.documentNumber,
            title: r.title,
            jurisdiction: 'federal' as const,
            state: null,
          })),
        ],
        note: `"${query}" matches ${total} rules/notices — ask which one (by id) before describing its status.`,
      };
    }
    return stateMatches.length
      ? this.formatRuleStatus('state', stateMatches[0]!)
      : this.formatRuleStatus('federal', federalMatches[0]!);
  }

  private formatRuleStatus(jurisdiction: 'federal' | 'state', row: Record<string, unknown>) {
    const ruleType =
      jurisdiction === 'federal' ? (row.type as string) : ((row.ruleType as string) ?? null);
    const commentEndDate = (row.commentEndDate as Date | null) ?? null;
    const commentStartDate =
      jurisdiction === 'state' ? ((row.commentStartDate as Date | null) ?? null) : null;
    const effectiveDate = (row.effectiveDate as Date | null) ?? null;
    const stage = deriveRuleLifecycleStage({
      documentType: ruleType,
      commentEndDate,
      effectiveDate,
    });
    const stageLabel = RULE_LIFECYCLE_STAGES.find((s) => s.key === stage)?.label ?? stage;

    // W4.5: `isOpen` = the comment WINDOW is actually open AND the rule is at a
    // comment-accepting stage — not merely `stage === 'nprm'` (which wrongly
    // reported a notice-stage rule with a live window as closed, and could
    // report `open` for an nprm with no dated window). Never guesses: no
    // end-date → not provably open → false, with an explicit note.
    // W5.6: single source of truth — the isOpen gate is the shared
    // `isRuleCommentOpen` predicate the meriv2-evals mechanism gate pins.
    const commentIsOpen = isRuleCommentOpen({ stage, commentStartDate, commentEndDate });

    const notes: string[] = [];
    if (COMMENT_ACCEPTING_STAGES.includes(stage) && !commentEndDate) {
      notes.push('No comment-end date on record for this open rule — do not assert a deadline.');
    }

    return {
      tool: 'get_state_rule_status',
      generatedAt: new Date().toISOString(),
      found: true,
      jurisdiction,
      id: jurisdiction === 'federal' ? (row.documentNumber as string) : (row.id as string),
      title: row.title as string,
      abstract: (row.abstract as string | null) ?? null,
      agencyNames:
        jurisdiction === 'federal' ? (row.agencyNames as string[]) : [row.agency as string],
      ruleType,
      stage,
      stageLabel,
      publicationDate: row.publicationDate as Date,
      commentPeriod: {
        start: commentStartDate,
        end: commentEndDate,
        isOpen: commentIsOpen,
      },
      effectiveDate,
      docketIds:
        jurisdiction === 'federal'
          ? (row.docketIds as string[])
          : [row.docketId as string | null].filter((d): d is string => !!d),
      sourceUrl:
        jurisdiction === 'federal'
          ? ((row.htmlUrl as string | null) ?? (row.pdfUrl as string | null))
          : (row.sourceUrl as string),
      linkedBillKeys: jurisdiction === 'state' ? (row.linkedBillKeys as string[]) : [],
      ...(notes.length ? { note: notes.join(' ') } : {}),
    };
  }

  private async searchIntelArticles(input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 240);
    const source = optionalString(input, 'source', 60);
    const limit = clampInt(input.limit, 1, 50, 20);

    const where: Record<string, unknown> = {};
    if (query) {
      where.OR = [
        { title: { contains: query, mode: 'insensitive' } },
        { summary: { contains: query, mode: 'insensitive' } },
        { categories: { hasSome: [query] } },
        { topics: { hasSome: [query] } },
      ];
    }
    if (source) where.source = source;

    const [data, total] = await Promise.all([
      this.prisma.withSystem((tx) =>
        tx.intelArticle.findMany({
          where,
          orderBy: { publishedAt: 'desc' },
          take: limit,
        }),
      ),
      this.prisma.withSystem((tx) => tx.intelArticle.count({ where })),
    ]);

    return {
      tool: 'search_intel_articles',
      generatedAt: new Date().toISOString(),
      total,
      data: data.map((a) => ({
        id: a.id,
        source: a.source,
        title: summarizeText(a.title, 240),
        url: a.url,
        author: a.author,
        publishedAt: a.publishedAt,
        summary: summarizeText(a.summary, 400),
        categories: a.categories,
        topics: a.topics,
      })),
    };
  }

  private async searchCommitteeHearings(input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 240);
    const chamber = optionalString(input, 'chamber', 20);
    const committeeName =
      optionalString(input, 'committeeName', 200) ?? optionalString(input, 'committee', 200);
    const limit = clampInt(input.limit, 1, 50, 20);

    const where: Record<string, unknown> = {};
    if (query) {
      where.OR = [
        { title: { contains: query, mode: 'insensitive' } },
        { committeeName: { contains: query, mode: 'insensitive' } },
      ];
    }
    if (chamber) where.chamber = chamber;
    if (committeeName) where.committeeName = { contains: committeeName, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      this.prisma.withSystem((tx) =>
        tx.committeeHearing.findMany({
          where,
          orderBy: { date: 'desc' },
          take: limit,
        }),
      ),
      this.prisma.withSystem((tx) => tx.committeeHearing.count({ where })),
    ]);

    return {
      tool: 'search_committee_hearings',
      generatedAt: new Date().toISOString(),
      total,
      data: data.map((h) => ({
        id: h.id,
        chamber: h.chamber,
        committeeName: h.committeeName,
        committeeCode: h.committeeCode,
        title: summarizeText(h.title, 240),
        date: h.date,
        time: h.time,
        location: h.location,
        type: h.type,
        witnesses: h.witnesses,
        url: h.url,
      })),
    };
  }

  private async searchCrsReports(input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 240);
    const limit = clampInt(input.limit, 1, 50, 20);

    const where: Record<string, unknown> = { active: true };
    if (query) {
      where.OR = [
        { title: { contains: query, mode: 'insensitive' } },
        { summary: { contains: query, mode: 'insensitive' } },
        { topics: { hasSome: [query] } },
        { authors: { hasSome: [query] } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.withSystem((tx) =>
        tx.crsReport.findMany({
          where,
          orderBy: { date: 'desc' },
          take: limit,
        }),
      ),
      this.prisma.withSystem((tx) => tx.crsReport.count({ where })),
    ]);

    return {
      tool: 'search_crs_reports',
      generatedAt: new Date().toISOString(),
      total,
      data: data.map((r) => ({
        id: r.id,
        title: summarizeText(r.title, 240),
        date: r.date,
        authors: r.authors,
        topics: r.topics,
        summary: summarizeText(r.summary, 400),
        pdfUrl: r.pdfUrl,
        htmlUrl: r.htmlUrl,
      })),
    };
  }

  private async queryEconomicData(input: Record<string, unknown>) {
    const source = optionalString(input, 'source', 20) ?? 'census';
    const state = optionalString(input, 'state', 2);
    const district = optionalString(input, 'district', 10);
    const limit = clampInt(input.limit, 1, 50, 20);

    switch (source.toLowerCase()) {
      case 'census': {
        const where: Record<string, unknown> = {};
        if (state) where.state = state.toUpperCase();
        if (district) where.district = district;

        const data = await this.prisma.withSystem((tx) =>
          tx.censusDistrict.findMany({
            where,
            orderBy: { state: 'asc' },
            take: limit,
          }),
        );

        return {
          tool: 'query_economic_data',
          source: 'census',
          generatedAt: new Date().toISOString(),
          data: data.map((d) => ({
            id: d.id,
            state: d.state,
            district: d.district,
            congress: d.congress,
            totalPopulation: d.totalPopulation,
            medianHouseholdIncome: d.medianHouseholdIncome,
            medianAge: d.medianAge,
            percentBachelorPlus: d.percentBachelorPlus,
            percentPoverty: d.percentPoverty,
            unemploymentRate: d.unemploymentRate,
            laborForceSize: d.laborForceSize,
            topIndustries: d.topIndustries,
          })),
        };
      }

      case 'bls': {
        const seriesId = optionalString(input, 'seriesId', 60);
        const query = optionalString(input, 'query', 240);

        const seriesWhere: Record<string, unknown> = {};
        if (seriesId) seriesWhere.id = seriesId;
        if (query) {
          seriesWhere.OR = [
            { title: { contains: query, mode: 'insensitive' } },
            { surveyName: { contains: query, mode: 'insensitive' } },
          ];
        }

        const series = await this.prisma.withSystem((tx) =>
          tx.blsSeries.findMany({
            where: seriesWhere,
            include: {
              dataPoints: {
                orderBy: [{ year: 'desc' }, { period: 'desc' }],
                take: 12,
              },
            },
            take: limit,
          }),
        );

        return {
          tool: 'query_economic_data',
          source: 'bls',
          generatedAt: new Date().toISOString(),
          data: series.map((s) => ({
            seriesId: s.id,
            title: s.title,
            surveyName: s.surveyName,
            periodType: s.periodType,
            recentDataPoints: s.dataPoints.map((dp) => ({
              year: dp.year,
              period: dp.period,
              value: dp.value,
            })),
          })),
        };
      }

      case 'bea': {
        const datasetName =
          optionalString(input, 'datasetName', 60) ?? optionalString(input, 'dataset', 60);
        const query = optionalString(input, 'query', 240);
        const year = input.year ? Number(input.year) : undefined;

        const where: Record<string, unknown> = {};
        if (datasetName) where.datasetName = datasetName;
        if (year) where.year = year;
        if (query) where.description = { contains: query, mode: 'insensitive' };

        const data = await this.prisma.withSystem((tx) =>
          tx.beaData.findMany({
            where,
            orderBy: [{ year: 'desc' }, { period: 'desc' }],
            take: limit,
          }),
        );

        return {
          tool: 'query_economic_data',
          source: 'bea',
          generatedAt: new Date().toISOString(),
          data: data.map((d) => ({
            datasetName: d.datasetName,
            tableName: d.tableName,
            description: summarizeText(d.description, 240),
            year: d.year,
            period: d.period,
            value: d.value,
            units: d.units,
          })),
        };
      }

      default:
        return {
          tool: 'query_economic_data',
          error: `Unknown source "${source}". Use "census", "bls", or "bea".`,
        };
    }
  }

  private async searchPublicWeb(input: Record<string, unknown>) {
    const query = requiredString(input, 'query', 240);
    const limit = clampInt(input.limit, 1, 12, 6);

    // Real provider (Tavily/Serper) when configured; DDG fallback on any
    // failure so the tool keeps today's behavior with no key set.
    const provider = this.config.get('CLIO_WEB_SEARCH_PROVIDER', { infer: true });
    if (provider === 'tavily' || provider === 'serper') {
      const apiKey =
        provider === 'tavily'
          ? this.config.get('TAVILY_API_KEY', { infer: true })
          : this.config.get('SERPER_API_KEY', { infer: true });
      if (apiKey) {
        try {
          const request = buildWebSearchRequest(provider, query, limit, apiKey);
          const response = await fetchWithTimeout(request.url, request.init, 10_000);
          if (!response.ok) {
            throw new Error(`provider responded ${response.status}`);
          }
          const results = normalizeWebResults(provider, await response.json()).slice(0, limit);
          return {
            tool: 'search_public_web',
            generatedAt: new Date().toISOString(),
            provider,
            total: results.length,
            results,
          };
        } catch (err) {
          this.logger.warn(
            `search_public_web via ${provider} failed, falling back to DuckDuckGo: ${(err as Error).message}`,
          );
        }
      }
    }

    const results = await queryDuckDuckGoNews(query, limit);
    return {
      tool: 'search_public_web',
      generatedAt: new Date().toISOString(),
      provider: 'duckduckgo',
      total: results.length,
      results,
    };
  }

  private async scrapeWebPage(input: Record<string, unknown>) {
    const rawUrl = requiredString(input, 'url', 2000);
    const mode = optionalString(input, 'mode', 20) ?? 'summary';
    const maxChars = clampInt(input.maxChars, 500, 20000, mode === 'extract' ? 12000 : 4000);

    const parsed = parseAndValidatePublicUrl(rawUrl);
    const response = await fetchWithTimeout(
      parsed.toString(),
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Capiro-Meri/1.0; +https://capiro.ai)',
          Accept: 'text/html,application/xhtml+xml,application/pdf',
        },
        redirect: 'follow',
      },
      10000,
    );

    if (!response.ok) {
      throw new BadGatewayException(`Web scrape failed (${response.status})`);
    }

    const finalUrl = response.url || parsed.toString();
    const finalParsed = parseAndValidatePublicUrl(finalUrl);

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

    if (looksLikePdf(contentType, finalParsed.toString())) {
      return this.extractPdfText(response, finalParsed.toString(), contentType, maxChars);
    }

    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new BadRequestException(
        `Unsupported content type for scraping: ${contentType || 'unknown'}`,
      );
    }

    const html = await response.text();
    const title = extractHtmlTitle(html);
    const text = extractReadableText(html, maxChars);
    const links = extractTopLinks(html, finalParsed.origin, 8);

    return {
      tool: 'scrape_web_page',
      generatedAt: new Date().toISOString(),
      url: finalParsed.toString(),
      title,
      contentType,
      text,
      totalChars: text.length,
      truncated: text.length >= maxChars,
      links,
    };
  }

  /**
   * PDF branch of scrape_web_page. The response already passed the SSRF guard
   * (parseAndValidatePublicUrl on the original AND final URL) before we get
   * here; this only buffers (size-capped) and extracts text.
   */
  private async extractPdfText(
    response: Response,
    url: string,
    contentType: string,
    maxChars: number,
  ) {
    const MAX_PDF_BYTES = 15 * 1024 * 1024;
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_PDF_BYTES) {
      throw new BadRequestException('PDF too large to extract (limit 15MB)');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_PDF_BYTES) {
      throw new BadRequestException('PDF too large to extract (limit 15MB)');
    }

    // Lazy-loaded: pdf-parse pulls in pdfjs-dist, which is heavy at module
    // load and only needed when a PDF is actually scraped.
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    let rawText: string;
    let pages: number;
    try {
      const parsed = await parser.getText();
      rawText = parsed.text ?? '';
      pages = parsed.total ?? 0;
    } catch (err) {
      throw new BadGatewayException(`PDF text extraction failed: ${(err as Error).message}`);
    } finally {
      await parser.destroy().catch(() => {});
    }

    const text = summarizeText(rawText, maxChars);
    return {
      tool: 'scrape_web_page',
      generatedAt: new Date().toISOString(),
      kind: 'pdf',
      url,
      title: null,
      contentType,
      pages,
      text,
      totalChars: text.length,
      truncated: text.length >= maxChars,
      links: [],
    };
  }

  private async searchResearchSources(ctx: TenantContext, input: Record<string, unknown>) {
    const query = requiredString(input, 'query', 240);
    let clientId = optionalString(input, 'clientId', 80);
    const limit = clampInt(input.limit, 1, 25, 8);
    if (clientId) clientId = await this.ensureClientVisible(ctx, clientId);

    const results = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [clients, meetings, threads, messages, meriNotes, directoryNotes] = await Promise.all([
        tx.client.findMany({
          where: {
            tenantId: ctx.tenantId,
            status: { not: 'archived' },
            ...(clientId ? { id: clientId } : {}),
            OR: [
              { name: { contains: query, mode: 'insensitive' } },
              { description: { contains: query, mode: 'insensitive' } },
              { productDescription: { contains: query, mode: 'insensitive' } },
              { primaryContactName: { contains: query, mode: 'insensitive' } },
              { primaryContactEmail: { contains: query, mode: 'insensitive' } },
            ],
          },
          select: { id: true, name: true, description: true, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
          take: limit,
        }),
        tx.meeting.findMany({
          where: {
            tenantId: ctx.tenantId,
            ...(clientId ? { clientId } : {}),
            ...ownMeetingWhere(ctx.userId),
            OR: [
              { subject: { contains: query, mode: 'insensitive' } },
              { description: { contains: query, mode: 'insensitive' } },
              { location: { contains: query, mode: 'insensitive' } },
              { organizerEmail: { contains: query, mode: 'insensitive' } },
              { organizerName: { contains: query, mode: 'insensitive' } },
            ],
          },
          select: {
            id: true,
            clientId: true,
            subject: true,
            description: true,
            startsAt: true,
            organizerEmail: true,
            organizerName: true,
          },
          orderBy: { startsAt: 'desc' },
          take: limit,
        }),
        tx.mailThread.findMany({
          where: {
            tenantId: ctx.tenantId,
            ...(clientId ? { clientId } : {}),
            ...ownMailThreadWhere(ctx.userId),
            OR: [
              { subject: { contains: query, mode: 'insensitive' } },
              { snippet: { contains: query, mode: 'insensitive' } },
            ],
          },
          select: {
            id: true,
            clientId: true,
            subject: true,
            snippet: true,
            lastMessageAt: true,
            updatedAt: true,
          },
          orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
          take: limit,
        }),
        tx.mailMessage.findMany({
          where: {
            tenantId: ctx.tenantId,
            ...ownMailMessageWhere(ctx.userId),
            ...(clientId ? { thread: { clientId } } : {}),
            OR: [
              { subject: { contains: query, mode: 'insensitive' } },
              { bodyText: { contains: query, mode: 'insensitive' } },
              { fromEmail: { contains: query, mode: 'insensitive' } },
              { fromName: { contains: query, mode: 'insensitive' } },
            ],
          },
          select: {
            id: true,
            threadId: true,
            subject: true,
            bodyText: true,
            fromEmail: true,
            fromName: true,
            receivedAt: true,
            sentAt: true,
            thread: { select: { clientId: true, subject: true } },
          },
          orderBy: [{ receivedAt: 'desc' }, { sentAt: 'desc' }],
          take: limit,
        }),
        tx.clioNote.findMany({
          where: {
            tenantId: ctx.tenantId,
            userId: ctx.userId,
            ...(clientId ? { clientId } : {}),
            OR: [
              { title: { contains: query, mode: 'insensitive' } },
              { body: { contains: query, mode: 'insensitive' } },
            ],
          },
          select: { id: true, clientId: true, title: true, body: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
        tx.directoryContactNote.findMany({
          where: {
            tenantId: ctx.tenantId,
            OR: [
              { body: { contains: query, mode: 'insensitive' } },
              { directoryContactName: { contains: query, mode: 'insensitive' } },
            ],
          },
          select: {
            id: true,
            directoryContactId: true,
            directoryContactName: true,
            body: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        }),
      ]);

      return [
        ...clients.map((client) => ({
          type: 'client',
          id: client.id,
          clientId: client.id,
          title: client.name,
          snippet: summarizeText(client.description, 360),
          occurredAt: client.updatedAt,
        })),
        ...meetings.map((meeting) => ({
          type: 'meeting',
          id: meeting.id,
          clientId: meeting.clientId,
          title: meeting.subject,
          snippet: summarizeText(
            meeting.description || meeting.organizerName || meeting.organizerEmail,
            360,
          ),
          occurredAt: meeting.startsAt,
        })),
        ...threads.map((thread) => ({
          type: 'mail_thread',
          id: thread.id,
          clientId: thread.clientId,
          title: thread.subject,
          snippet: summarizeText(thread.snippet, 360),
          occurredAt: thread.lastMessageAt ?? thread.updatedAt,
        })),
        ...messages.map((message) => ({
          type: 'mail_message',
          id: message.id,
          clientId: message.thread.clientId,
          title: message.subject || message.thread.subject,
          snippet: summarizeText(message.bodyText || message.fromName || message.fromEmail, 360),
          occurredAt: message.receivedAt ?? message.sentAt,
          metadata: { threadId: message.threadId },
        })),
        ...meriNotes.map((note) => ({
          type: 'clio_note',
          id: note.id,
          clientId: note.clientId,
          title: note.title || 'Meri note',
          snippet: summarizeText(note.body, 360),
          occurredAt: note.createdAt,
        })),
        ...directoryNotes.map((note) => ({
          type: 'directory_contact_note',
          id: note.id,
          clientId: null,
          title: note.directoryContactName || note.directoryContactId,
          snippet: summarizeText(note.body, 360),
          occurredAt: note.createdAt,
          metadata: { directoryContactId: note.directoryContactId },
        })),
      ]
        .sort((left, right) => dateMillis(right.occurredAt) - dateMillis(left.occurredAt))
        .slice(0, limit * 3);
    });

    return {
      tool: 'search_research_sources',
      query,
      generatedAt: new Date().toISOString(),
      results,
    };
  }

  private async createMeetingBrief(ctx: TenantContext, input: Record<string, unknown>) {
    const meetingId = requiredString(input, 'meetingId', 80);
    const conversationId = optionalString(input, 'conversationId', 80);
    const titleOverride = optionalString(input, 'title', 160);
    const meeting = await this.meetingForTool(ctx, meetingId);
    const [notes, debriefs, recentThreads] = await Promise.all([
      this.engagement.listMeetingNotes(ctx, meetingId).catch(() => []),
      this.engagement.listMeetingDebriefs(ctx, meetingId).catch(() => []),
      this.recentThreadsForClient(ctx, meeting.clientId),
    ]);

    const bodyText = renderMeetingBrief({
      meeting,
      notes: notes.filter((note) => !note.restricted),
      debriefs: debriefs.filter((debrief) => !debrief.restricted),
      recentThreads,
    });
    const artifact = await this.persistArtifact(ctx, {
      conversationId,
      clientId: meeting.clientId,
      title: titleOverride || `Meeting brief - ${meeting.subject}`,
      kind: 'meeting_brief',
      bodyText,
      metadata: {
        source: 'clio_tool',
        tool: 'create_meeting_brief',
        meetingId,
        generatedAt: new Date().toISOString(),
      },
    });

    return {
      tool: 'create_meeting_brief',
      generatedAt: new Date().toISOString(),
      meetingId,
      artifact,
      bodyText,
    };
  }

  private async draftPolicyMemo(ctx: TenantContext, input: Record<string, unknown>) {
    let clientId = requiredString(input, 'clientId', 80);
    const conversationId = optionalString(input, 'conversationId', 80);
    const title = optionalString(input, 'title', 160) || 'Policy memo draft';
    const objective = optionalString(input, 'objective', 500) || 'Prepare a policy memo.';
    const providedBody = optionalString(input, 'body', 40_000);
    clientId = await this.ensureClientVisible(ctx, clientId);
    const clientContext = await this.engagement.clientContext(ctx, clientId);
    const research =
      objective.length > 3
        ? await this.searchResearchSources(ctx, { query: objective, clientId, limit: 6 }).catch(
            () => ({ results: [] }),
          )
        : { results: [] };
    const bodyText =
      providedBody ||
      renderPolicyMemo({
        title,
        objective,
        clientContext,
        researchResults: Array.isArray(research.results) ? research.results : [],
      });
    const artifact = await this.persistArtifact(ctx, {
      conversationId,
      clientId,
      title,
      kind: 'policy_memo',
      bodyText,
      metadata: {
        source: 'clio_tool',
        tool: 'draft_policy_memo',
        objective,
        generatedAt: new Date().toISOString(),
        mode: providedBody ? 'provided_body' : 'deterministic_capiro_context',
      },
    });

    return {
      tool: 'draft_policy_memo',
      generatedAt: new Date().toISOString(),
      artifact,
      bodyText,
    };
  }

  private async saveNote(ctx: TenantContext, input: Record<string, unknown>) {
    const body = requiredString(input, 'body', 40_000);
    const title = optionalString(input, 'title', 160);
    const conversationId = optionalString(input, 'conversationId', 80);
    const requestedClientId = optionalString(input, 'clientId', 80);
    const meetingId = optionalString(input, 'meetingId', 80);
    const source = optionalString(input, 'source', 80) || 'clio_tool';
    let clientId = requestedClientId ?? null;
    let meetingNote: unknown = null;

    if (meetingId) {
      const meeting = await this.ensureOwnMeeting(ctx, meetingId);
      if (clientId && meeting.clientId && clientId !== meeting.clientId) {
        throw new BadRequestException('clientId does not match the meeting client');
      }
      clientId = clientId ?? meeting.clientId;
      meetingNote = await this.engagement.createMeetingNote(ctx, meetingId, {
        body,
        confidential: optionalBoolean(input, 'confidential') ?? true,
        accessLevel: optionalString(input, 'accessLevel', 80) ?? 'tenant_admins_and_author',
      });
    } else if (clientId) {
      clientId = await this.ensureClientVisible(ctx, clientId);
    }

    if (conversationId) await this.ensureConversationForTool(ctx, conversationId, clientId);

    const clioNote = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioNote.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId,
          conversationId: conversationId ?? null,
          meetingId: meetingId ?? null,
          title: title ?? null,
          body,
          source,
          metadata: {
            tool: 'save_note',
            savedToMeetingNotes: Boolean(meetingNote),
          },
        },
      }),
    );

    return {
      tool: 'save_note',
      generatedAt: new Date().toISOString(),
      note: clioNote,
      meetingNote,
    };
  }

  // ── Email tools ──────────────────────────────────────────────────────

  private async findUserEmailConnection(ctx: TenantContext) {
    // Any connected inbox the user owns can send — Outlook or Gmail. `provider`
    // is selected so EngagementMailSender can route to the right adapter.
    // Order by provider (the enum lists microsoft_365 first) THEN recency: this
    // keeps the sending identity DETERMINISTIC for a user with both inboxes —
    // background token refreshes / syncs bump updatedAt on each connection at
    // independent times, so ordering by updatedAt alone would flip the "from"
    // mailbox unpredictably. Microsoft-preferred also preserves the pre-Gmail
    // behavior of these Meri send tools; a Gmail-only user still gets Gmail.
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.integrationConnection.findFirst({
        where: {
          tenantId: ctx.tenantId,
          createdByUserId: ctx.userId,
          provider: { in: ['microsoft_365', 'google_workspace'] },
          status: 'connected',
          token: { isNot: null },
        },
        orderBy: [{ provider: 'asc' }, { updatedAt: 'desc' }],
        select: { id: true, provider: true, accountEmail: true, displayName: true },
      }),
    );
  }

  /**
   * Deliver a finished scheduled briefing by email to a FIXED, pre-authorized
   * recipient (set at schedule-creation time). Used only by the scheduled-task
   * runner — NOT exposed as a model tool — so the recipient and intent can never
   * be chosen by the LLM at run time. Sends from the task owner's connected
   * Microsoft 365 account. Returns ok + the sender, or an error string; never
   * throws (the runner must continue on email failure).
   */
  async sendScheduledBriefingEmail(
    ctx: TenantContext,
    to: string,
    subject: string,
    body: string,
  ): Promise<{ ok: boolean; sentFrom?: string; error?: string }> {
    const recipient = normalizeDeliveryEmail(to);
    if (!recipient) return { ok: false, error: 'invalid recipient' };
    const connection = await this.findUserEmailConnection(ctx);
    if (!connection) return { ok: false, error: 'no connected email account' };
    try {
      await this.mailSender.sendMail(ctx, connection, {
        subject,
        body,
        toRecipients: [{ email: recipient }],
      });
      return { ok: true, sentFrom: connection.accountEmail ?? undefined };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async sendEmail(ctx: TenantContext, input: Record<string, unknown>) {
    const to = requiredString(input, 'to', 320);
    const subject = requiredString(input, 'subject', 500);
    const body = requiredString(input, 'body', 50_000);
    const clientId = optionalString(input, 'clientId', 36);
    const conversationId = optionalString(input, 'conversationId', 80);

    const connection = await this.findUserEmailConnection(ctx);
    if (!connection) {
      return {
        error:
          'No connected email account found. Please connect Outlook or Gmail in Settings → Integrations.',
      };
    }

    await this.mailSender.sendMail(ctx, connection, {
      subject,
      body,
      toRecipients: [{ email: to }],
    });

    if (conversationId) {
      await this.persistArtifact(ctx, {
        conversationId,
        clientId,
        title: `Email: ${subject}`,
        kind: 'email_sent',
        bodyText: `To: ${to}\nSubject: ${subject}\n\n${body}`,
        metadata: { to, subject, sentFrom: connection.accountEmail },
      });
    }

    return { ok: true, sentFrom: connection.accountEmail, to, subject };
  }

  private async listEmails(ctx: TenantContext, input: Record<string, unknown>) {
    const clientId = optionalString(input, 'clientId', 36);
    const limit = clampInt(input.limit, 1, 50, 15);

    const where: Prisma.MailThreadWhereInput = {
      ...ownMailThreadWhere(ctx.userId),
    };
    if (clientId) where.clientId = clientId;

    const threads = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.mailThread.findMany({
        where,
        orderBy: { lastMessageAt: 'desc' },
        take: limit,
        select: {
          id: true,
          subject: true,
          snippet: true,
          participants: true,
          lastMessageAt: true,
          status: true,
          client: { select: { id: true, name: true } },
          messages: {
            orderBy: { sentAt: 'desc' },
            take: 3,
            select: {
              id: true,
              subject: true,
              fromEmail: true,
              fromName: true,
              bodyText: true,
              sentAt: true,
              receivedAt: true,
            },
          },
        },
      }),
    );

    return { threads, count: threads.length };
  }

  /**
   * Search synced mail by content/people — the lookup counterpart to
   * listEmails (which only pages the newest threads and can never reach older
   * mail). Message-level ILIKE over subject / sender / recipients / stored
   * preview, scoped like every mail tool: tenant + the caller's own
   * connections. Raw SQL (parameterized) because recipients live in jsonb
   * arrays the Prisma builder can't fragment-match; LIKE wildcards in user
   * input are escaped so they match literally. Always returns a per-mailbox
   * coverage report so the model can distinguish "not in synced mail" from
   * "mailbox never synced" instead of asserting the email doesn't exist.
   */
  private async searchEmails(ctx: TenantContext, input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 200);
    const from = optionalString(input, 'from', 200);
    const participant = optionalString(input, 'participant', 200);
    const clientId = optionalString(input, 'clientId', 36);
    const withinDays =
      input.withinDays === undefined || input.withinDays === null
        ? null
        : clampInt(input.withinDays, 1, 3650, 365);
    const limit = clampInt(input.limit, 1, 50, 20);

    if (!query && !from && !participant) {
      return {
        error:
          "Provide at least one of 'query', 'from', or 'participant'. To simply see the newest threads use list_emails instead.",
      };
    }
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (clientId && !UUID_RE.test(clientId)) {
      return { error: 'clientId must be a client UUID — pass the exact id, or omit it.' };
    }

    // Escape LIKE wildcards so model-supplied terms match literally
    // (Postgres treats backslash as the LIKE escape character by default).
    const pattern = (term: string) => `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

    const conds: Prisma.Sql[] = [
      Prisma.sql`m.tenant_id = ${ctx.tenantId}::uuid`,
      Prisma.sql`c.created_by_user_id = ${ctx.userId}::uuid`,
    ];
    if (query) {
      const p = pattern(query);
      conds.push(
        Prisma.sql`(m.subject ILIKE ${p} OR m.body_text ILIKE ${p} OR m.from_email::text ILIKE ${p} OR m.from_name ILIKE ${p} OR m.to_recipients_jsonb::text ILIKE ${p} OR m.cc_recipients_jsonb::text ILIKE ${p})`,
      );
    }
    if (from) {
      const p = pattern(from);
      conds.push(Prisma.sql`(m.from_email::text ILIKE ${p} OR m.from_name ILIKE ${p})`);
    }
    if (participant) {
      const p = pattern(participant);
      conds.push(
        Prisma.sql`(m.from_email::text ILIKE ${p} OR m.from_name ILIKE ${p} OR m.to_recipients_jsonb::text ILIKE ${p} OR m.cc_recipients_jsonb::text ILIKE ${p} OR m.bcc_recipients_jsonb::text ILIKE ${p})`,
      );
    }
    if (clientId) conds.push(Prisma.sql`t.client_id = ${clientId}::uuid`);
    if (withinDays !== null) {
      conds.push(
        // ::int — Prisma binds JS numbers as int8 and make_interval only takes int4.
        Prisma.sql`COALESCE(m.received_at, m.sent_at) >= now() - make_interval(days => ${withinDays}::int)`,
      );
    }
    const where = Prisma.join(conds, ' AND ');

    // The same message can be synced once per folder (inbox + sent copies of a
    // reply), so fetch headroom, count distinct, and dedupe on the RFC message
    // id before trimming to `limit`.
    const fetchLimit = Math.min(limit * 2, 100);

    const { total, rows, coverage } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const counted = await tx.$queryRaw<Array<{ n: number }>>(Prisma.sql`
        SELECT count(DISTINCT COALESCE(m.metadata_jsonb->>'internetMessageId', m.id::text))::int AS n
        FROM mail_messages m
        JOIN engagement_connections c ON c.id = m.connection_id
        JOIN mail_threads t ON t.id = m.thread_id
        WHERE ${where}
      `);
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          thread_id: string;
          subject: string | null;
          from_email: string | null;
          from_name: string | null;
          to_recipients: unknown;
          cc_recipients: unknown;
          sent_at: Date | null;
          received_at: Date | null;
          preview: string | null;
          has_attachments: boolean;
          folder: string | null;
          internet_message_id: string | null;
          client_id: string | null;
          client_name: string | null;
          account_email: string | null;
        }>
      >(Prisma.sql`
        SELECT m.id::text AS id, m.thread_id::text AS thread_id, m.subject,
               m.from_email::text AS from_email, m.from_name,
               m.to_recipients_jsonb AS to_recipients, m.cc_recipients_jsonb AS cc_recipients,
               m.sent_at, m.received_at, left(m.body_text, 400) AS preview,
               m.has_attachments,
               m.metadata_jsonb->>'folder' AS folder,
               m.metadata_jsonb->>'internetMessageId' AS internet_message_id,
               t.client_id::text AS client_id, cl.name AS client_name,
               c.account_email::text AS account_email
        FROM mail_messages m
        JOIN engagement_connections c ON c.id = m.connection_id
        JOIN mail_threads t ON t.id = m.thread_id
        LEFT JOIN clients cl ON cl.id = t.client_id
        WHERE ${where}
        ORDER BY COALESCE(m.received_at, m.sent_at) DESC NULLS LAST
        LIMIT ${fetchLimit}
      `);
      const coverage = await tx.$queryRaw<
        Array<{
          account_email: string | null;
          provider: string;
          status: string;
          last_sync_at: Date | null;
          synced_messages: number;
          oldest_synced: Date | null;
          newest_synced: Date | null;
        }>
      >(Prisma.sql`
        SELECT c.account_email::text AS account_email, c.provider::text AS provider,
               c.status::text AS status, c.last_sync_at,
               count(m.id)::int AS synced_messages,
               min(COALESCE(m.received_at, m.sent_at)) AS oldest_synced,
               max(COALESCE(m.received_at, m.sent_at)) AS newest_synced
        FROM engagement_connections c
        LEFT JOIN mail_messages m ON m.connection_id = c.id AND m.tenant_id = c.tenant_id
        WHERE c.tenant_id = ${ctx.tenantId}::uuid AND c.created_by_user_id = ${ctx.userId}::uuid
        GROUP BY c.id, c.created_at
        ORDER BY c.created_at
      `);
      return { total: counted[0]?.n ?? 0, rows, coverage };
    });

    const searchedMailboxes = coverage.map((c) => ({
      accountEmail: c.account_email,
      provider: c.provider,
      status: c.status,
      lastSyncAt: c.last_sync_at,
      syncedMessages: c.synced_messages,
      syncedRange:
        c.synced_messages > 0 ? { oldest: c.oldest_synced, newest: c.newest_synced } : null,
    }));

    if (searchedMailboxes.length === 0) {
      return {
        totalMatches: 0,
        returned: 0,
        hasMore: false,
        messages: [],
        searchedMailboxes,
        notes: [
          'No connected mailbox exists for this user — nothing was searched. They can connect Microsoft 365 or Google under Settings → Integrations.',
        ],
      };
    }

    const capRecipients = (value: unknown) => {
      const list = Array.isArray(value)
        ? (value as Array<{ email?: unknown; name?: unknown }>)
        : [];
      return list.slice(0, 8).map((r) => ({
        email: typeof r.email === 'string' ? r.email : null,
        name: typeof r.name === 'string' ? r.name : null,
      }));
    };

    const seen = new Set<string>();
    const messages: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const key = row.internet_message_id ?? row.id;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push({
        threadId: row.thread_id,
        subject: row.subject,
        from: { email: row.from_email, name: row.from_name },
        to: capRecipients(row.to_recipients),
        cc: capRecipients(row.cc_recipients),
        sentAt: row.sent_at,
        receivedAt: row.received_at,
        folder: row.folder,
        preview: row.preview,
        hasAttachments: row.has_attachments,
        mailbox: row.account_email,
        client: row.client_id ? { id: row.client_id, name: row.client_name } : null,
      });
      if (messages.length >= limit) break;
    }

    const notes: string[] = [
      'Bodies are stored as short previews, and junk/spam, deleted/trash, and drafts folders never sync — a miss means "not found in synced mail", not proof the email does not exist.',
    ];
    for (const box of searchedMailboxes) {
      if (box.syncedMessages === 0) {
        notes.push(
          `Mailbox ${box.accountEmail ?? '(no address on record)'} (${box.provider}, status: ${box.status}) has NO synced mail — it was not effectively searched.`,
        );
      }
    }

    return {
      totalMatches: total,
      returned: messages.length,
      hasMore: total > messages.length,
      messages,
      searchedMailboxes,
      notes,
    };
  }

  /**
   * Upcoming meetings from the SYNCED CALENDAR (the `meeting` table, populated by
   * the Microsoft 365 / Google calendar integration) — the authoritative source
   * of which meetings exist and when. Meeting prep must start here (then pull
   * email context via list_emails and a brief via create_meeting_brief); memory
   * is background only and must NEVER be treated as the calendar. An empty result
   * means the user genuinely has nothing upcoming (or no calendar connected) — the
   * model reports that rather than surfacing stale "meetings" from memory.
   */
  private async listUpcomingMeetings(ctx: TenantContext, input: Record<string, unknown>) {
    const clientId = optionalString(input, 'clientId', 36);
    const limit = clampInt(input.limit, 1, 25, 10);
    const withinDays = clampInt(input.withinDays, 1, 365, 30);

    const now = new Date();
    const until = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

    const where: Prisma.MeetingWhereInput = {
      tenantId: ctx.tenantId,
      ...ownMeetingWhere(ctx.userId),
      startsAt: { gte: now, lt: until },
      status: { not: 'cancelled' },
    };
    if (clientId) where.clientId = clientId;

    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meeting.findMany({
        where,
        orderBy: { startsAt: 'asc' },
        take: limit,
        select: {
          id: true,
          subject: true,
          startsAt: true,
          endsAt: true,
          location: true,
          isVirtual: true,
          joinLink: true,
          status: true,
          isInternal: true,
          organizerName: true,
          organizerEmail: true,
          client: { select: { id: true, name: true } },
          attendees: {
            orderBy: { createdAt: 'asc' },
            select: { name: true, email: true, role: true, responseStatus: true },
          },
        },
      }),
    );

    const meetings = rows.map((m) => ({
      id: m.id,
      subject: m.subject,
      startsAt: m.startsAt,
      endsAt: m.endsAt,
      location: m.location,
      isVirtual: m.isVirtual,
      joinLink: m.joinLink,
      status: m.status,
      isInternal: m.isInternal,
      organizer: m.organizerName || m.organizerEmail || null,
      client: m.client,
      attendees: m.attendees,
    }));

    return {
      meetings,
      count: meetings.length,
      window: { from: now.toISOString(), to: until.toISOString(), withinDays },
    };
  }

  private async replyEmail(ctx: TenantContext, input: Record<string, unknown>) {
    const threadId = requiredString(input, 'threadId', 80);
    const body = requiredString(input, 'body', 50_000);
    const clientId = optionalString(input, 'clientId', 36);
    const conversationId = optionalString(input, 'conversationId', 80);

    const thread = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.mailThread.findFirst({
        where: { id: threadId, ...ownMailThreadWhere(ctx.userId) },
        select: {
          id: true,
          subject: true,
          messages: {
            orderBy: { sentAt: 'desc' },
            take: 1,
            select: { id: true, fromEmail: true, fromName: true, subject: true },
          },
        },
      }),
    );
    if (!thread) return { error: 'Thread not found.' };

    const lastMsg = thread.messages[0];
    if (!lastMsg?.fromEmail) return { error: 'No messages in thread to reply to.' };

    const connection = await this.findUserEmailConnection(ctx);
    if (!connection) {
      return { error: 'No connected email account found.' };
    }

    const replySubject = thread.subject?.startsWith('Re: ')
      ? thread.subject
      : `Re: ${thread.subject ?? ''}`;

    await this.mailSender.sendMail(ctx, connection, {
      subject: replySubject,
      body,
      toRecipients: [{ email: lastMsg.fromEmail }],
    });

    if (conversationId) {
      await this.persistArtifact(ctx, {
        conversationId,
        clientId,
        title: `Reply: ${replySubject}`,
        kind: 'email_reply',
        bodyText: `Reply to: ${lastMsg.fromEmail}\nSubject: ${replySubject}\n\n${body}`,
        metadata: {
          to: lastMsg.fromEmail,
          subject: replySubject,
          sentFrom: connection.accountEmail,
          threadId,
        },
      });
    }

    return {
      ok: true,
      sentFrom: connection.accountEmail,
      to: lastMsg.fromEmail,
      subject: replySubject,
    };
  }

  // ── Artifact persistence ────────────────────────────────────────────

  // ── Document generation (Word / Excel / PowerPoint) ──

  /**
   * Generate a downloadable Office document. The validated spec is normalized,
   * then a binary is produced ONCE to prove it builds; the spec (JSON) is stored
   * on the artifact so the download endpoint regenerates the binary statelessly
   * (no blob storage needed), mirroring the research-export pattern.
   */
  private async createDocument(
    ctx: TenantContext,
    input: Record<string, unknown>,
    format: DocFormat,
  ) {
    let clientId = optionalString(input, 'clientId', 80) ?? null;
    const conversationId = optionalString(input, 'conversationId', 80);
    if (clientId) clientId = await this.ensureClientVisible(ctx, clientId);

    let title: string;
    let normalized: unknown;
    if (format === 'docx') {
      const spec = normalizeWordSpec(input);
      // Resolve referenced analysis-chart artifacts into embedded PNGs (F4)
      // so the stored spec re-renders identically on download.
      for (const section of spec.sections) {
        section.images = [
          ...section.images,
          ...(await this.resolveChartImages(ctx, section.imageArtifactIds)),
        ];
        section.imageArtifactIds = [];
      }
      title = spec.title;
      normalized = spec;
      await this.docgen.buildDocx(spec);
    } else if (format === 'xlsx') {
      const spec = normalizeExcelSpec(input);
      title = spec.title;
      normalized = spec;
      await this.docgen.buildXlsx(spec);
    } else {
      const spec = normalizePptxSpec(input);
      for (const slide of spec.slides) {
        slide.images = [
          ...slide.images,
          ...(await this.resolveChartImages(ctx, slide.imageArtifactIds)),
        ];
        slide.imageArtifactIds = [];
      }
      title = spec.title;
      normalized = spec;
      await this.docgen.buildPptx(spec);
    }

    const toolName =
      format === 'docx' ? 'create_word' : format === 'xlsx' ? 'create_excel' : 'create_powerpoint';
    const kind =
      format === 'docx'
        ? 'word_document'
        : format === 'xlsx'
          ? 'excel_workbook'
          : 'powerpoint_deck';
    const filename = `${slugifyDocName(title)}.${format}`;
    const artifact = await this.persistArtifact(ctx, {
      conversationId,
      clientId,
      title,
      kind,
      bodyText: JSON.stringify(normalized),
      metadata: {
        source: 'clio_tool',
        tool: toolName,
        docFormat: format,
        mimeType: mimeForFormat(format),
        filename,
        generatedAt: new Date().toISOString(),
      },
    });

    const artifactId =
      artifact && typeof artifact === 'object' && 'id' in artifact
        ? (artifact as { id: string }).id
        : null;

    return {
      tool: toolName,
      format,
      title,
      filename,
      mimeType: mimeForFormat(format),
      artifact,
      downloadUrl: artifactId ? `/api/clio/artifacts/${artifactId}/download` : null,
      note: artifactId
        ? 'Document generated and available for download.'
        : 'Document generated but not persisted (no conversation context); ask the user to retry within a chat.',
    };
  }

  /**
   * Load a generated document artifact (tenant + user scoped) and return the
   * stored spec JSON + format + filename so the controller can regenerate and
   * stream the binary. Returns null when not found / not a document artifact.
   */
  async getDocumentArtifact(
    ctx: TenantContext,
    artifactId: string,
  ): Promise<{ format: DocFormat; specJson: string; filename: string; mimeType: string } | null> {
    const artifact = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.findFirst({
        where: { id: artifactId, tenantId: ctx.tenantId, userId: ctx.userId },
        select: { bodyText: true, metadata: true },
      }),
    );
    if (!artifact || !artifact.bodyText) return null;
    const meta = (artifact.metadata ?? {}) as Record<string, unknown>;
    const format = meta.docFormat;
    if (format !== 'docx' && format !== 'xlsx' && format !== 'pptx') return null;
    const filename = typeof meta.filename === 'string' ? meta.filename : `document.${format}`;
    return {
      format,
      specJson: artifact.bodyText,
      filename,
      mimeType: mimeForFormat(format),
    };
  }

  // ── Scheduled tasks (W3) ────────────────────

  private async scheduleTask(ctx: TenantContext, input: Record<string, unknown>) {
    const existingTaskCount = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioScheduledTask.count({ where: { tenantId: ctx.tenantId, ownerUserId: ctx.userId } }),
    );
    const validation = validateScheduleRequest({
      name: input.name,
      prompt: input.prompt,
      intervalMinutes: input.intervalMinutes,
      toolAllowList: input.toolAllowList,
      existingTaskCount,
    });
    if (!validation.ok) {
      return { tool: 'schedule_task', scheduled: false, error: validation.error };
    }
    const intervalMinutes = validation.intervalMinutes!;
    const allowList = validation.allowList!;
    // Optional clock-anchored time-of-day (UTC) + client scope.
    const runAtMinutesUtc = parseTimeOfDayUtc(input.dailyAtUtc);
    const clientId =
      typeof input.clientId === 'string' && input.clientId.trim()
        ? input.clientId.trim()
        : undefined;
    const metadata: Record<string, string | number> = { createdVia: 'schedule_task_tool' };
    if (runAtMinutesUtc != null) metadata.runAtMinutesUtc = runAtMinutesUtc;
    if (clientId) metadata.clientId = clientId;

    // Optional fixed email delivery of the finished briefing. The recipient is
    // resolved + frozen NOW (not at run time): an explicit deliverEmailTo if
    // valid, else the owner's own connected Microsoft 365 address. The scheduled
    // runner only ever emails its own briefing to this one pre-set address — the
    // model never gets a send tool, so there is no autonomous-send surface.
    let emailDeliveryNote = '';
    if (input.emailBriefing === true) {
      const requested = normalizeDeliveryEmail(input.deliverEmailTo);
      let emailTo = requested;
      if (!emailTo) {
        const conn = await this.findUserEmailConnection(ctx);
        emailTo = conn?.accountEmail ? normalizeDeliveryEmail(conn.accountEmail) : null;
      }
      if (!emailTo) {
        return {
          tool: 'schedule_task',
          scheduled: false,
          error:
            'Email delivery requested but no valid recipient: provide deliverEmailTo, or connect a Microsoft 365 account in Settings → Integrations so the briefing can be sent to your own address.',
        };
      }
      metadata.emailTo = emailTo;
      emailDeliveryNote = ` Each briefing is also emailed to ${emailTo}.`;
    }

    const nextRunAt = computeNextRunAtAnchored(new Date(), intervalMinutes, runAtMinutesUtc);
    const task = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioScheduledTask.create({
        data: {
          tenantId: ctx.tenantId,
          ownerUserId: ctx.userId,
          scope: 'user_private',
          name: String(input.name).slice(0, 200),
          prompt: String(input.prompt).slice(0, 8000),
          intervalMinutes,
          toolAllowList: allowList,
          nextRunAt,
          createdBy: 'meri',
          metadata,
        },
        select: { id: true, name: true, intervalMinutes: true, nextRunAt: true },
      }),
    );
    const cadence =
      runAtMinutesUtc != null
        ? `daily at ${String(Math.floor(runAtMinutesUtc / 60)).padStart(2, '0')}:${String(runAtMinutesUtc % 60).padStart(2, '0')} UTC`
        : `every ${intervalMinutes} minutes`;
    return {
      tool: 'schedule_task',
      scheduled: true,
      task,
      note: `Scheduled as a READ-ONLY recurring research task (${cadence}; no autonomous email/writes). Meri runs it automatically and delivers each briefing to your inbox.${emailDeliveryNote} Use list_scheduled_tasks to review or cancel_scheduled_task to stop it.`,
    };
  }

  private async listScheduledTasks(ctx: TenantContext) {
    const tasks = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioScheduledTask.findMany({
        where: { tenantId: ctx.tenantId, ownerUserId: ctx.userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          name: true,
          intervalMinutes: true,
          enabled: true,
          lastRunAt: true,
          nextRunAt: true,
          lastStatus: true,
          runCount: true,
        },
      }),
    );
    return { tool: 'list_scheduled_tasks', count: tasks.length, tasks };
  }

  private async cancelScheduledTask(ctx: TenantContext, input: Record<string, unknown>) {
    const taskId = requiredString(input, 'taskId', 80);
    const result = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioScheduledTask.updateMany({
        where: { id: taskId, tenantId: ctx.tenantId, ownerUserId: ctx.userId },
        data: { enabled: false, lastStatus: 'canceled' },
      }),
    );
    if (result.count === 0) {
      return { tool: 'cancel_scheduled_task', canceled: false, error: 'Task not found.' };
    }
    return { tool: 'cancel_scheduled_task', canceled: true, taskId };
  }

  // ── Firm operational data (tasks / actions) ──

  private async queryTasks(ctx: TenantContext, input: Record<string, unknown>) {
    let clientId = optionalString(input, 'clientId', 80);
    const statusRaw = optionalString(input, 'status', 30)?.toLowerCase() ?? null;
    const dueBeforeRaw = optionalString(input, 'dueBefore', 40);
    const limit = clampInt(input.limit, 1, 50, 25);
    if (clientId) clientId = await this.ensureClientVisible(ctx, clientId);

    const taskStatuses = Object.values(EngagementTaskStatus) as string[];
    let status: EngagementTaskStatus | undefined;
    let openOnly = false;
    let dueBefore: Date | undefined;
    if (statusRaw === 'open') {
      openOnly = true;
    } else if (statusRaw === 'overdue') {
      openOnly = true;
      dueBefore = new Date();
    } else if (statusRaw && taskStatuses.includes(statusRaw)) {
      status = statusRaw as EngagementTaskStatus;
    } else if (statusRaw) {
      throw new BadRequestException(
        `status must be one of: open, overdue, ${taskStatuses.join(', ')}`,
      );
    }

    if (dueBeforeRaw) {
      const parsed = new Date(dueBeforeRaw);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('dueBefore must be an ISO date');
      }
      dueBefore = parsed;
    }

    const tasks = await this.engagement.listTasks(ctx, {
      clientId: clientId ?? undefined,
      status,
      openOnly,
      dueBefore,
      limit,
    });

    const now = Date.now();
    return {
      tool: 'query_tasks',
      generatedAt: new Date().toISOString(),
      total: tasks.length,
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        dueDate: task.dueDate,
        overdue: Boolean(
          task.dueDate &&
          task.dueDate.getTime() < now &&
          task.status !== EngagementTaskStatus.done &&
          task.status !== EngagementTaskStatus.canceled,
        ),
        clientId: task.clientId,
        clientName: task.client?.name ?? null,
        meeting: task.meeting,
        description: summarizeText(task.description, 240),
        createdAt: task.createdAt,
      })),
    };
  }

  private async queryActionItems(ctx: TenantContext, input: Record<string, unknown>) {
    let clientId = optionalString(input, 'clientId', 80);
    const status = optionalString(input, 'status', 40);
    const sort = optionalString(input, 'sort', 20);
    const limit = clampInt(input.limit, 1, 50, 20);
    if (clientId) clientId = await this.ensureClientVisible(ctx, clientId);

    const result = await this.actionRecommendations.list(ctx, {
      clientId: clientId ?? undefined,
      status: (status as ActionStatus | null) ?? undefined,
      sort: sort === 'priority' ? 'priority' : 'deadline',
      limit,
    });

    return {
      tool: 'query_action_items',
      generatedAt: new Date().toISOString(),
      total: result.total,
      actions: result.data,
    };
  }

  private async searchTrackedBills(ctx: TenantContext, input: Record<string, unknown>) {
    let clientId = requiredString(input, 'clientId', 80);
    clientId = await this.ensureClientVisible(ctx, clientId);
    const bills = await this.intelligence.listTrackedBills(clientId, ctx.tenantId);
    return {
      tool: 'search_tracked_bills',
      generatedAt: new Date().toISOString(),
      clientId,
      total: bills.length,
      bills,
    };
  }

  private async queryRegulatoryDockets(input: Record<string, unknown>) {
    const upcomingOnly = optionalBoolean(input, 'upcomingOnly');
    const limit = clampInt(input.limit, 1, 50, 20);

    if (upcomingOnly) {
      const days = clampInt(input.days, 1, 365, 30);
      const deadlines = await this.regulatoryDockets.getUpcomingDeadlines(days);
      return {
        tool: 'query_regulatory_dockets',
        generatedAt: new Date().toISOString(),
        windowDays: days,
        total: deadlines.length,
        results: deadlines.slice(0, limit),
      };
    }

    const agencyId = optionalString(input, 'agencyId', 40);
    const documentType = optionalString(input, 'documentType', 80);
    const result = await this.regulatoryDockets.listDockets({
      agencyId: agencyId ?? undefined,
      documentType: documentType ?? undefined,
      limit,
    });

    return {
      tool: 'query_regulatory_dockets',
      generatedAt: new Date().toISOString(),
      total: result.total,
      results: result.data,
    };
  }

  private async searchSamOpportunities(input: Record<string, unknown>) {
    const query = optionalString(input, 'query', 240);
    const naics = optionalString(input, 'naics', 12);
    const includeInactive = optionalBoolean(input, 'includeInactive');
    const limit = clampInt(input.limit, 1, 50, 20);

    const result = await this.programElement.listSamOpportunities({
      query: query ?? undefined,
      naics: naics ?? undefined,
      includeInactive: includeInactive ?? undefined,
      limit,
    });

    return {
      tool: 'search_sam_opportunities',
      generatedAt: new Date().toISOString(),
      total: result.total,
      results: result.data.map((opp) => ({
        ...opp,
        description: summarizeText(opp.description, 300),
      })),
    };
  }

  private async queryDebriefs(ctx: TenantContext, input: Record<string, unknown>) {
    let clientId = requiredString(input, 'clientId', 80);
    clientId = await this.ensureClientVisible(ctx, clientId);
    const debriefs = await this.engagement.listClientDebriefs(ctx, { clientId });
    return {
      tool: 'query_debriefs',
      generatedAt: new Date().toISOString(),
      clientId,
      total: debriefs.length,
      debriefs: debriefs.map((debrief) => ({
        id: debrief.id,
        meetingId: debrief.meetingId,
        meeting: debrief.meeting,
        body: debrief.restricted ? null : summarizeText(debrief.body, 1500),
        restricted: debrief.restricted,
        author: debrief.author,
        createdAt: debrief.createdAt,
      })),
    };
  }

  /**
   * Read a client's Documents-tab files. Without documentId: lists the client's
   * attachments (id, filename, type, size, when). With documentId: extracts and
   * returns that document's text so Meri can read/summarize/quote it. Reuses the
   * tenant-scoped engagement attachment service (RLS-safe).
   */
  private async readClientDocuments(ctx: TenantContext, input: Record<string, unknown>) {
    let clientId = requiredString(input, 'clientId', 80);
    clientId = await this.ensureClientVisible(ctx, clientId);
    const documentId = optionalString(input, 'documentId', 80);

    if (documentId) {
      try {
        const extracted = await this.engagement.extractAttachmentText(ctx, documentId);
        return {
          tool: 'read_client_documents',
          generatedAt: new Date().toISOString(),
          clientId,
          document: {
            id: extracted.attachmentId,
            fileName: extracted.fileName,
            contentType: extracted.contentType,
            source: extracted.source,
            text: summarizeText(extracted.text, 12000),
          },
        };
      } catch (err) {
        return {
          tool: 'read_client_documents',
          clientId,
          documentId,
          error: err instanceof Error ? err.message : 'Could not read this document',
        };
      }
    }

    const attachments = await this.engagement.listAttachments(ctx, { clientId });
    return {
      tool: 'read_client_documents',
      generatedAt: new Date().toISOString(),
      clientId,
      total: attachments.length,
      note: "Pass a documentId to read a specific file's contents.",
      documents: attachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        contentType: a.contentType,
        byteSize: a.byteSize,
        createdAt: a.createdAt,
      })),
    };
  }

  private async queryOutreach(ctx: TenantContext, input: Record<string, unknown>) {
    const outreachId = optionalString(input, 'outreachId', 80);
    if (outreachId) {
      const record = await this.engagement.getOutreachRecord(ctx, outreachId);
      return {
        tool: 'query_outreach',
        generatedAt: new Date().toISOString(),
        record: {
          ...record,
          body: summarizeText(record.body, 2000),
        },
      };
    }

    let clientId = optionalString(input, 'clientId', 80);
    const status = optionalString(input, 'status', 40);
    const limit = clampInt(input.limit, 1, 50, 20);
    if (clientId) clientId = await this.ensureClientVisible(ctx, clientId);

    const campaigns = await this.engagement.listCampaigns(ctx, {
      clientId: clientId ?? undefined,
      status: status ?? undefined,
    });

    return {
      tool: 'query_outreach',
      generatedAt: new Date().toISOString(),
      total: campaigns.length,
      campaigns: campaigns.slice(0, limit).map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        type: campaign.type,
        status: campaign.status,
        subject: campaign.subject,
        clientId: campaign.clientId,
        clientName: campaign.client?.name ?? null,
        recipientCount: campaign.recipients.length,
        createdBy: campaign.createdBy?.email ?? null,
        sentAt: campaign.sentAt,
        createdAt: campaign.createdAt,
      })),
    };
  }

  // ── P2 write tools (approval-gated; engagement/workflow domain only) ──

  private async createEngagementTask(ctx: TenantContext, input: Record<string, unknown>) {
    const title = requiredString(input, 'title', 240);
    let clientId = optionalString(input, 'clientId', 80);
    const dueDate = optionalString(input, 'dueDate', 40);
    const description = optionalString(input, 'description', 2000);
    if (clientId) clientId = await this.ensureClientVisible(ctx, clientId);

    const task = await this.engagement.createTask(ctx, {
      title,
      clientId: clientId ?? undefined,
      dueDate: dueDate ?? undefined,
      description: description ?? undefined,
    });

    return {
      tool: 'create_task',
      generatedAt: new Date().toISOString(),
      created: true,
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        dueDate: task.dueDate,
        clientId: task.clientId,
        createdAt: task.createdAt,
      },
    };
  }

  private async updateEngagementTask(ctx: TenantContext, input: Record<string, unknown>) {
    const taskId = requiredString(input, 'taskId', 80);
    const statusRaw = optionalString(input, 'status', 30)?.toLowerCase() ?? null;
    const dueDate = optionalString(input, 'dueDate', 40);
    const title = optionalString(input, 'title', 240);

    const dto: { status?: EngagementTaskStatus; dueDate?: string; title?: string } = {};
    if (statusRaw) {
      const mapped = statusRaw === 'open' ? 'todo' : statusRaw;
      const valid = Object.values(EngagementTaskStatus) as string[];
      if (!valid.includes(mapped)) {
        throw new BadRequestException(`status must be one of: ${valid.join(', ')}`);
      }
      dto.status = mapped as EngagementTaskStatus;
    }
    if (dueDate) dto.dueDate = dueDate;
    if (title) dto.title = title;
    if (!Object.keys(dto).length) {
      throw new BadRequestException('Provide at least one of status, dueDate, or title');
    }

    const task = await this.engagement.updateTask(ctx, taskId, dto);
    return {
      tool: 'update_task',
      generatedAt: new Date().toISOString(),
      updated: true,
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        dueDate: task.dueDate,
        clientId: task.clientId,
        updatedAt: task.updatedAt,
      },
    };
  }

  /**
   * Read-only pre-create check for a prospective client name: the tenant's
   * existing book of business + the LDA lobbying-disclosure registry (exact
   * match and close candidates). This runs BEFORE create_client is proposed —
   * a deliberate split, because the approval gate holds create_client at
   * PROPOSE time and the approve replay's result is not shown to the model or
   * user (useMeriChatController reads only executed/executionError). Identity
   * resolution therefore has to happen here, in conversation, where the model
   * can actually relay candidates and ask the user.
   */
  private async lookupClientRegistry(ctx: TenantContext, input: Record<string, unknown>) {
    const name = requiredString(input, 'name', 300);
    const existing = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: {
          tenantId: ctx.tenantId,
          name: { equals: name, mode: 'insensitive' },
          status: { not: 'archived' },
        },
        select: { id: true, name: true, website: true },
      }),
    );
    const exact = await this.prisma.withSystem((tx) =>
      tx.ldaClient.findFirst({
        where: { name: { equals: name.trim(), mode: 'insensitive' } },
        orderBy: { totalFilings: 'desc' },
        select: LDA_PICK_SELECT,
      }),
    );
    const near = await this.prisma.withSystem((tx) =>
      tx.ldaClient.findMany({
        where: { name: { contains: name.trim(), mode: 'insensitive' } },
        orderBy: { totalFilings: 'desc' },
        take: 5,
        select: LDA_PICK_SELECT,
      }),
    );
    const shape = (c: LdaPick) => ({
      ldaClientId: c.id,
      name: c.name,
      state: c.state,
      description: c.generalDescription ? summarizeText(c.generalDescription, 200) : null,
      totalFilings: c.totalFilings,
      latestFilingYear: c.latestFilingYear,
    });
    const candidates = near.filter((c) => c.id !== exact?.id).map(shape);
    const guidance = existing
      ? `A client named "${existing.name}" already exists (id ${existing.id}) — do NOT propose create_client; use get_client_context or update_client_profile.`
      : exact
        ? `Exact LDA registry match — propose create_client with this name; it will link "${exact.name}" automatically.`
        : candidates.length > 0
          ? 'No exact LDA match, but close registered entities exist. Ask the user whether the client is one of these (then propose create_client with that ldaClientId) or none (skipLdaCheck: true).'
          : 'Not found in the LDA registry — propose create_client with the provided details (manual create).';
    return {
      existingClient: existing ?? null,
      ldaExactMatch: exact ? shape(exact) : null,
      ldaCandidates: candidates,
      guidance,
    };
  }

  /**
   * Create a new client record — the approval-gated write behind "Meri, add
   * <X> as a client" (previously a hard dead end for users). Contract shaped
   * by the approve-replay pipeline: the WARN gate holds this at PROPOSE time,
   * and on approve the replay's result is DISCARDED by the web controller
   * (only executed/executionError surface). So every "nothing was created"
   * outcome must THROW — a throw becomes the visible action-failure banner +
   * regenerate, while a structured return would render as a false "Approved
   * and completed". Identity resolution belongs to lookup_client_registry
   * pre-proposal; the checks here (duplicate, LDA ambiguity, unknown id) are
   * enforcement backstops. Creation goes through ClientsService.create so the
   * billing slot gate (402 propagates for the same reason), resolve-on-create
   * LDA linking, prepopulation cascade, and SAM gov-id enrichment all run
   * exactly as they do for the UI's Add Client path.
   */
  private async createClient(ctx: TenantContext, input: Record<string, unknown>) {
    const name = requiredString(input, 'name', 300);
    const website = optionalString(input, 'website', 500);
    const description = optionalString(input, 'description', 4000);
    const sectorTag = optionalString(input, 'sectorTag', 120);
    const primaryContactName = optionalString(input, 'primaryContactName', 200);
    const primaryContactEmail = optionalString(input, 'primaryContactEmail', 200);
    const primaryContactPhone = optionalString(input, 'primaryContactPhone', 60);
    const skipLdaCheck = input.skipLdaCheck === true;

    // Bound to INT4 (lda_client.id) — an out-of-range hallucinated id would
    // otherwise throw a raw Prisma conversion error instead of this message.
    const ldaClientIdRaw = input.ldaClientId;
    let ldaClientId: number | null = null;
    if (ldaClientIdRaw !== undefined && ldaClientIdRaw !== null) {
      const parsed =
        typeof ldaClientIdRaw === 'number'
          ? ldaClientIdRaw
          : typeof ldaClientIdRaw === 'string' && /^\d+$/.test(ldaClientIdRaw.trim())
            ? Number(ldaClientIdRaw.trim())
            : NaN;
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2147483647) {
        throw new BadRequestException(
          `Nothing was created: ldaClientId must be a positive id from lookup_client_registry (got ${JSON.stringify(ldaClientIdRaw)}). Re-run lookup_client_registry and use a listed id, or pass skipLdaCheck: true.`,
        );
      }
      ldaClientId = parsed;
    }

    // Duplicate guard #1: the literal requested name.
    const existing = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: {
          tenantId: ctx.tenantId,
          name: { equals: name, mode: 'insensitive' },
          status: { not: 'archived' },
        },
        select: { id: true, name: true },
      }),
    );
    if (existing) {
      throw new BadRequestException(
        `Nothing was created: a client named "${existing.name}" already exists (id ${existing.id}). Use get_client_context to review it or update_client_profile to change it.`,
      );
    }

    // LDA identity (global reference data, no tenant scope). ldaClientId means
    // the user already confirmed an entity via lookup_client_registry;
    // skipLdaCheck means they said "none of these".
    let ldaMatch: LdaPick | null = null;
    if (ldaClientId !== null) {
      const picked = await this.prisma.withSystem((tx) =>
        tx.ldaClient.findUnique({ where: { id: ldaClientId }, select: LDA_PICK_SELECT }),
      );
      if (!picked) {
        throw new BadRequestException(
          `Nothing was created: no LDA client with id ${ldaClientId} exists. Re-run lookup_client_registry and use a listed id, or pass skipLdaCheck: true.`,
        );
      }
      ldaMatch = picked;
    } else if (!skipLdaCheck) {
      // Exactness probed with a direct equals query — NOT filtered from a
      // capped contains window, where a generic name's exact row can rank
      // below 5 high-volume substring matches and vanish.
      ldaMatch = await this.prisma.withSystem((tx) =>
        tx.ldaClient.findFirst({
          where: { name: { equals: name.trim(), mode: 'insensitive' } },
          orderBy: { totalFilings: 'desc' },
          select: LDA_PICK_SELECT,
        }),
      );
      if (!ldaMatch) {
        const candidates = await this.prisma.withSystem((tx) =>
          tx.ldaClient.findMany({
            where: { name: { contains: name.trim(), mode: 'insensitive' } },
            orderBy: { totalFilings: 'desc' },
            take: 5,
            select: LDA_PICK_SELECT,
          }),
        );
        if (candidates.length > 0) {
          const list = candidates
            .map(
              (c) =>
                `"${c.name}" (ldaClientId ${c.id}${c.state ? `, ${c.state}` : ''}, ${c.totalFilings} filings)`,
            )
            .join('; ');
          throw new BadRequestException(
            `Nothing was created: close (not exact) LDA registry matches exist for "${name}": ${list}. Confirm with the user which registered entity applies and re-propose with that ldaClientId — or skipLdaCheck: true if none apply.`,
          );
        }
        // Zero candidates: fall through to a manual create.
      }
    }

    // Duplicate guard #2: the RESOLVED entity. "Olivet Univ" confirmed as LDA
    // "OLIVET UNIVERSITY" must not slip past guard #1 when a client already
    // carries the LDA name or a confirmed lda_client_ids link.
    if (ldaMatch) {
      const resolved = ldaMatch;
      const dupByEntity = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({
          where: {
            tenantId: ctx.tenantId,
            status: { not: 'archived' },
            OR: [
              { name: { equals: resolved.name, mode: 'insensitive' } },
              { ldaClientIds: { has: resolved.id } },
            ],
          },
          select: { id: true, name: true },
        }),
      );
      if (dupByEntity) {
        throw new BadRequestException(
          `Nothing was created: "${name}" resolves to LDA entity "${resolved.name}", which is already the existing client "${dupByEntity.name}" (id ${dupByEntity.id}).`,
        );
      }
    }

    // Failures from here (billing slot-limit 402, validation) propagate as
    // HttpExceptions — the approve replay surfaces e.message as the action
    // failure, which is the only channel the user actually sees.
    const client = await this.clients.create(ctx, {
      name,
      website: website ?? undefined,
      description:
        description ??
        (ldaMatch?.generalDescription
          ? summarizeText(ldaMatch.generalDescription, 1000)
          : undefined),
      sectorTag: sectorTag ?? undefined,
      primaryContactName: primaryContactName ?? undefined,
      primaryContactEmail: primaryContactEmail ?? undefined,
      primaryContactPhone: primaryContactPhone ?? undefined,
      // Seed the confirmed LDA identity directly — the async name-based
      // resolution cascade is weakest exactly when the user typed a variant
      // name and confirmed the entity by id, and it must not be the only
      // carrier of that confirmation (LDA-filing reads and the duplicate
      // guard's `has` arm consume lda_client_ids).
      ldaClientIds: ldaMatch ? [ldaMatch.id] : undefined,
      intakeData: {
        __meriCreate: {
          createdVia: 'meri.create_client',
          at: new Date().toISOString(),
          ldaClientId: ldaMatch?.id ?? null,
          ldaName: ldaMatch?.name ?? null,
        },
      },
    });
    return {
      created: true,
      client: { id: client.id, name: client.name, website: client.website },
      ldaMatch: ldaMatch
        ? {
            ldaClientId: ldaMatch.id,
            name: ldaMatch.name,
            totalFilings: ldaMatch.totalFilings,
            latestFilingYear: ldaMatch.latestFilingYear,
          }
        : null,
      note: ldaMatch
        ? `Matched LDA-registered lobbying client "${ldaMatch.name}" (${ldaMatch.totalFilings} filings, latest ${ldaMatch.latestFilingYear ?? 'n/a'}). Background LDA linking and SAM gov-id enrichment are running.`
        : 'No match in the LDA lobbying-disclosure registry — created from the provided details. Background LDA linking and SAM gov-id enrichment are running.',
      followUp:
        "If the user already agreed to a full profile fill, proceed now: scrape_web_page their website, pull search_lda_filings / search_federal_awards background, and propose update_client_profile with sourced values. Otherwise ask whether they'd like that.",
    };
  }

  /**
   * Write approved values into a client profile (the "Meri writes to the web
   * app" path). Only whitelisted scalar/array fields are accepted; anything
   * else is ignored. Per-field provenance (source URL + confidence) is merged
   * into intakeData.__webImport so an auto-populated profile is auditable. The
   * client-visibility gate 404s outside the tenant, and ClientsService.update
   * runs through withTenant, so a write can never cross tenants. The model is
   * instructed to gather + show + get approval before calling this (it's in
   * SIDE_EFFECTING_TOOLS); this method does the persistence only.
   */
  private async updateClientProfile(ctx: TenantContext, input: Record<string, unknown>) {
    let clientId = requiredString(input, 'clientId', 80);
    // Keep THROWING on a missing/invalid clientId — this runs on the
    // approve-replay path where only executed/executionError surface, so a
    // structured return would render as a false "Approved and completed"
    // (meri-approval.service.spec pins the executionError contract). Rethrow
    // with recovery guidance appended: the banner is what the user sees, and
    // the regenerate that follows is what puts the model back in the loop.
    try {
      clientId = await this.ensureClientVisible(ctx, clientId);
    } catch (e) {
      if (e instanceof NotFoundException) {
        throw new NotFoundException(
          `${e.message} If the client does not exist in Capiro yet, use lookup_client_registry + create_client — update_client_profile only edits existing clients.`,
        );
      }
      throw e;
    }

    const update: Record<string, unknown> = {};
    const setStr = (key: string, max: number) => {
      const v = optionalString(input, key, max);
      if (v !== null) update[key] = v;
    };
    setStr('name', 300);
    setStr('website', 500);
    setStr('description', 4000);
    setStr('productDescription', 4000);
    setStr('primaryContactName', 200);
    setStr('primaryContactEmail', 200);
    setStr('primaryContactPhone', 60);
    setStr('sectorTag', 120);
    setStr('uei', 12);
    setStr('cageCode', 5);
    const setArr = (key: string) => {
      const arr = optionalStringArray(input, key, 100, 120);
      if (arr !== null) update[key] = arr;
    };
    setArr('issueCodes');
    setArr('naicsCodes');
    setArr('pscCodes');

    const writtenFields = Object.keys(update);

    // Optional child-record appends (facilities / capabilities / people). These
    // are separate tables from the scalar Client profile, so an import that only
    // adds child records is valid even with no scalar field changes.
    const facilityInputs = parseFacilityInputs(input.facilities);
    const capabilityInputs = parseCapabilityInputs(input.capabilities);
    const peopleInputs = parsePeopleInputs(input.people);

    if (
      writtenFields.length === 0 &&
      facilityInputs.length === 0 &&
      capabilityInputs.length === 0 &&
      peopleInputs.length === 0
    ) {
      throw new BadRequestException(
        'update_client_profile: no recognized profile fields, facilities, capabilities, or people to write',
      );
    }

    // Merge per-field provenance into intakeData.__webImport without clobbering
    // existing intake data or prior provenance.
    const provenance = objectInput(input.provenance);
    if (writtenFields.length > 0 && Object.keys(provenance).length > 0) {
      const current = await this.clients.get(ctx, clientId);
      const intake =
        current.intakeData &&
        typeof current.intakeData === 'object' &&
        !Array.isArray(current.intakeData)
          ? (current.intakeData as Record<string, unknown>)
          : {};
      const priorImport =
        intake.__webImport &&
        typeof intake.__webImport === 'object' &&
        !Array.isArray(intake.__webImport)
          ? (intake.__webImport as Record<string, unknown>)
          : {};
      update.intakeData = {
        ...intake,
        __webImport: {
          ...priorImport,
          updatedAt: new Date().toISOString(),
          fields: { ...(priorImport.fields as object | undefined), ...provenance },
        },
      };
    }

    // Scalar profile fields (skip the round-trip when nothing scalar changed).
    let clientName = '';
    if (writtenFields.length > 0) {
      const updated = await this.clients.update(ctx, clientId, update);
      clientName = updated.name;
    }

    // Merge facilities, then capabilities, then people. Each write is
    // tenant-scoped and 404s outside the tenant, so a bad clientId can't cross
    // tenants. We collect per-row outcomes so a single bad row (e.g. an invalid
    // district) doesn't abort the whole import; the model relays failures back.
    //
    // IDEMPOTENT by design. This used to create unconditionally, and enrichment
    // is re-run constantly (research the client again, re-sync mail), so every
    // re-run duplicated every row — enrich a client twice and Jason Hay appears
    // twice, "Space Analytics" appears twice. Existing rows are matched and
    // either merged (people) or skipped (capabilities/facilities, whose shape is
    // curated by hand and should not be silently rewritten by a scrape).
    const facilitiesCreated: string[] = [];
    const capabilitiesCreated: string[] = [];
    const peopleCreated: string[] = [];
    const peopleUpdated: string[] = [];
    const skipped: string[] = [];
    const rowErrors: string[] = [];

    const norm = (s: string) => s.trim().toLowerCase();
    const [existingFacilities, existingCapabilities] = await this.prisma.withTenant(
      ctx.tenantId,
      async (tx) =>
        Promise.all([
          tx.clientFacility.findMany({
            where: { tenantId: ctx.tenantId, clientId },
            select: { name: true },
          }),
          tx.clientCapability.findMany({
            where: { tenantId: ctx.tenantId, clientId },
            select: { name: true },
          }),
        ]),
    );
    const facilityNames = new Set(existingFacilities.map((r) => norm(r.name)));
    const capabilityNames = new Set(existingCapabilities.map((r) => norm(r.name)));

    for (const f of facilityInputs) {
      if (facilityNames.has(norm(f.name))) {
        skipped.push(`facility "${f.name}" (already on the profile)`);
        continue;
      }
      try {
        const created = await this.clientFacilities.createFacility(ctx, clientId, f);
        facilityNames.add(norm(created.name));
        facilitiesCreated.push(created.name);
      } catch (err) {
        rowErrors.push(`facility "${f.name}": ${(err as Error).message}`);
      }
    }
    for (const c of capabilityInputs) {
      if (capabilityNames.has(norm(c.name))) {
        skipped.push(`capability "${c.name}" (already on the profile)`);
        continue;
      }
      try {
        const created = await this.clientCapabilities.createCapability(ctx, clientId, c);
        capabilityNames.add(norm(created.name));
        capabilitiesCreated.push(created.name);
      } catch (err) {
        rowErrors.push(`capability "${c.name}": ${(err as Error).message}`);
      }
    }
    for (const p of peopleInputs) {
      try {
        const { person, created } = await this.clientPeople.upsertPersonForImport(ctx, clientId, p);
        (created ? peopleCreated : peopleUpdated).push(person.name);
      } catch (err) {
        rowErrors.push(`person "${p.name}": ${(err as Error).message}`);
      }
    }

    return {
      tool: 'update_client_profile',
      generatedAt: new Date().toISOString(),
      updated: true,
      clientId,
      clientName,
      fieldsWritten: writtenFields,
      facilitiesCreated,
      capabilitiesCreated,
      peopleCreated,
      peopleUpdated,
      skipped,
      rowErrors,
    };
  }

  /**
   * find_contacts — real correspondents from the connected mailboxes/calendars.
   *
   * Meri had NO access to engagement_contacts, so when asked to put people on a
   * client profile it read display names out of list_emails previews. That is
   * how a profile ended up with four contacts called "Derek", "Tristin",
   * "Karlin" and "Steve" — no surnames, no addresses, no contact history,
   * nothing anyone could actually email.
   *
   * Client association is mostly domain-derived on purpose: engagement_contacts
   * only carries an explicit clientId when a sync happened to attach one, which
   * for most rows it never did. Matching the client's website domain is the
   * signal that actually finds "the people at BryceTech".
   */
  private async findContacts(ctx: TenantContext, input: Record<string, unknown>) {
    const clientRef = optionalString(input, 'clientId', 200);
    const domainFilter = optionalString(input, 'domain', 200)?.trim().toLowerCase() ?? null;
    const query = optionalString(input, 'query', 200)?.trim() ?? null;
    const limit = clampInt(input.limit, 1, 100, 25);

    let clientId: string | null = null;
    let clientName: string | null = null;
    let clientDomain: string | null = null;
    let existingEmails = new Set<string>();
    let existingNames = new Set<string>();
    if (clientRef) {
      clientId = await this.ensureClientVisible(ctx, clientRef);
      const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: clientId!, tenantId: ctx.tenantId },
          select: { name: true, website: true, people: { select: { email: true, name: true } } },
        }),
      );
      clientName = client?.name ?? null;
      clientDomain = websiteDomain(client?.website ?? null);
      existingEmails = new Set(
        (client?.people ?? [])
          .map((p) => p.email?.trim().toLowerCase())
          .filter((e): e is string => Boolean(e)),
      );
      existingNames = new Set(
        (client?.people ?? []).map((p) => p.name.trim().toLowerCase()).filter(Boolean),
      );
    }

    const domain = domainFilter ?? clientDomain;
    const or: Prisma.EngagementContactWhereInput[] = [];
    if (clientId) or.push({ clientId });
    if (domain) or.push({ email: { endsWith: `@${domain}` } });
    if (query) {
      or.push({ fullName: { contains: query, mode: 'insensitive' } });
      or.push({ email: { contains: query, mode: 'insensitive' } });
    }
    if (or.length === 0) {
      return {
        tool: 'find_contacts',
        generatedAt: new Date().toISOString(),
        contacts: [],
        note: 'Pass a clientId, a domain, or a query — find_contacts will not dump the whole contact table.',
      };
    }

    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementContact.findMany({
        where: { tenantId: ctx.tenantId, OR: or },
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          title: true,
          organization: true,
          clientId: true,
          source: true,
        },
        take: limit,
        orderBy: { updatedAt: 'desc' },
      }),
    );

    // Contact history per address, from data already synced. Both lookups hit a
    // (tenant, email) index and the result set is capped at `limit`, so this
    // stays bounded — it is NOT a scan of the mail store.
    const contacts = await Promise.all(
      rows.map(async (r) => {
        const email = r.email?.trim().toLowerCase() ?? null;
        let lastContact: Date | null = null;
        let messageCount = 0;
        if (email) {
          const [lastFrom, count, lastMeeting] = await this.prisma.withTenant(
            ctx.tenantId,
            async (tx) =>
              Promise.all([
                tx.mailMessage.findFirst({
                  where: { tenantId: ctx.tenantId, fromEmail: email },
                  orderBy: { receivedAt: 'desc' },
                  select: { receivedAt: true },
                }),
                tx.mailMessage.count({ where: { tenantId: ctx.tenantId, fromEmail: email } }),
                tx.meetingAttendee.findFirst({
                  where: { tenantId: ctx.tenantId, email },
                  orderBy: { createdAt: 'desc' },
                  select: { meeting: { select: { startsAt: true } } },
                }),
              ]),
          );
          messageCount = count;
          const meetingAt = lastMeeting?.meeting?.startsAt ?? null;
          const mailAt = lastFrom?.receivedAt ?? null;
          lastContact =
            mailAt && meetingAt ? (mailAt > meetingAt ? mailAt : meetingAt) : (mailAt ?? meetingAt);
        }
        const nameKey = r.fullName?.trim().toLowerCase() ?? '';
        return {
          name: r.fullName,
          email: r.email,
          phone: r.phone,
          title: r.title,
          organization: r.organization ?? (email ? (email.split('@')[1] ?? null) : null),
          lastContact: lastContact ? lastContact.toISOString() : null,
          messageCount,
          source: r.source,
          // Lets the model propose ONLY the people who are missing instead of
          // re-sending the whole roster (which the merge would no-op anyway).
          onProfile: Boolean(
            (email && existingEmails.has(email)) || (nameKey && existingNames.has(nameKey)),
          ),
        };
      }),
    );

    contacts.sort((a, b) => (b.lastContact ?? '').localeCompare(a.lastContact ?? ''));
    const missing = contacts.filter((c) => !c.onProfile);
    return {
      tool: 'find_contacts',
      generatedAt: new Date().toISOString(),
      clientId,
      clientName,
      matchedOn: { domain: domain ?? null, query: query ?? null, linkedClient: Boolean(clientId) },
      contacts,
      note: clientId
        ? `${contacts.length} correspondent(s) found; ${missing.length} not yet on the People tab. These come from synced mail and calendar — cite them as such. Propose only the missing ones via update_client_profile people[].`
        : `${contacts.length} correspondent(s) found from synced mail and calendar.`,
    };
  }

  /** Resolve analysis-chart artifact ids to embedded PNG payloads (F4). */
  private async resolveChartImages(
    ctx: TenantContext,
    artifactIds: string[],
  ): Promise<Array<{ dataBase64: string }>> {
    const out: Array<{ dataBase64: string }> = [];
    for (const id of artifactIds) {
      const artifact = await this.prisma
        .withTenant(ctx.tenantId, (tx) =>
          tx.clioArtifact.findFirst({
            where: { id, tenantId: ctx.tenantId },
            select: { metadata: true },
          }),
        )
        .catch(() => null);
      const meta = artifact?.metadata as Record<string, unknown> | null;
      if (typeof meta?.imageBase64 === 'string') out.push({ dataBase64: meta.imageBase64 });
    }
    return out;
  }

  /** Regenerate a document binary from a stored spec (for the download route). */
  async renderStoredDocument(format: DocFormat, specJson: string): Promise<Buffer> {
    const parsed: unknown = JSON.parse(specJson);
    if (format === 'docx') return this.docgen.buildDocx(normalizeWordSpec(parsed));
    if (format === 'xlsx') return this.docgen.buildXlsx(normalizeExcelSpec(parsed));
    return this.docgen.buildPptx(normalizePptxSpec(parsed));
  }

  private async persistArtifact(ctx: TenantContext, input: ToolArtifactInput) {
    if (!input.conversationId) {
      return {
        persisted: false,
        reason: 'No conversationId was supplied to the tool call.',
      };
    }
    await this.ensureConversationForTool(ctx, input.conversationId, input.clientId ?? null);
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioArtifact.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: input.clientId ?? null,
          conversationId: input.conversationId!,
          title: input.title,
          kind: input.kind,
          contentType: 'text/markdown',
          bodyText: input.bodyText,
          metadata: input.metadata ?? {},
        },
      }),
    );
  }

  private async meetingForTool(ctx: TenantContext, meetingId: string) {
    const meeting = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meeting.findFirst({
        where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
        include: {
          client: { select: { id: true, name: true, website: true, productDescription: true } },
          attendees: { orderBy: { createdAt: 'asc' } },
          preps: { orderBy: { createdAt: 'desc' }, take: 1 },
          tasks: {
            where: {
              status: { notIn: [EngagementTaskStatus.done, EngagementTaskStatus.canceled] },
            },
            orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
            take: 8,
          },
        },
      }),
    );
    if (!meeting) throw new NotFoundException('Meeting not found');
    return meeting;
  }

  private async ensureOwnMeeting(ctx: TenantContext, meetingId: string) {
    const meeting = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meeting.findFirst({
        where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
        select: { id: true, clientId: true },
      }),
    );
    if (!meeting) throw new NotFoundException('Meeting not found');
    return meeting;
  }

  /**
   * Resolve a model-supplied client reference to a real, visible client id.
   *
   * Two failure modes converge here:
   *
   * 1. A non-UUID reaches Postgres and Prisma throws a raw "Error creating UUID"
   *    (P2023), which the user sees as "Action approved but failed to run".
   *    Guarded before the cast since 2026-07-16.
   * 2. The model sends an exact display NAME ("Ballard Partners") because that
   *    is what it has in hand — most often in an UNFOCUSED conversation, where
   *    there is no conversation client to fall back to. That used to be a dead
   *    end. It is now resolved by exact, case-insensitive name match, which is
   *    the follow-up 1be58d95 explicitly deferred.
   *
   * Only an EXACT name match counts. Fuzzy-matching a client name would let a
   * near-miss write one client's data onto another, and these are approved
   * writes — the user has already said yes by the time this runs.
   *
   * Returns the resolved UUID; callers must use the RETURN VALUE, not their
   * original input.
   */
  private async ensureClientVisible(ctx: TenantContext, clientId: string): Promise<string> {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const raw = typeof clientId === 'string' ? clientId.trim() : '';
    if (!raw) {
      throw new NotFoundException(
        'No client is scoped to this conversation. Select the client in Meri (or pass its exact id) and try again.',
      );
    }

    if (UUID_RE.test(raw)) {
      const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: raw, tenantId: ctx.tenantId, status: { not: 'archived' } },
          select: { id: true },
        }),
      );
      if (!client) throw new NotFoundException('Client not found');
      return client.id;
    }

    const matches = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findMany({
        where: {
          tenantId: ctx.tenantId,
          status: { not: 'archived' },
          name: { equals: raw, mode: 'insensitive' },
        },
        select: { id: true, name: true },
        take: 5,
      }),
    );
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1) {
      throw new NotFoundException(
        `"${raw}" matches ${matches.length} clients in the book of business — pass the exact client id instead.`,
      );
    }
    throw new NotFoundException(
      `No client named "${raw}" is in the book of business. Pass the exact client id, or select the client in Meri. If the client does not exist yet, use lookup_client_registry + create_client first.`,
    );
  }

  private async ensureConversationForTool(
    ctx: TenantContext,
    conversationId: string,
    clientId: string | null,
  ) {
    const conversation = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.findFirst({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          archivedAt: null,
        },
        select: { id: true, clientId: true },
      }),
    );
    if (!conversation) throw new NotFoundException('Meri conversation not found');
    if (clientId && conversation.clientId && conversation.clientId !== clientId) {
      throw new BadRequestException('Tool clientId does not match the Meri conversation client');
    }
    return conversation;
  }

  private async recentThreadsForClient(ctx: TenantContext, clientId: string | null) {
    if (!clientId) return [];
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.mailThread.findMany({
        where: { tenantId: ctx.tenantId, clientId, ...ownMailThreadWhere(ctx.userId) },
        select: { id: true, subject: true, snippet: true, lastMessageAt: true },
        orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
        take: 5,
      }),
    );
  }
}

/** BFS shortest path between two node ids over the undirected knowledge graph. */
function shortestGraphPath(
  graph: { nodes: Array<{ id: string }>; edges: Array<{ src: string; dst: string }> },
  from: string,
  to: string,
  maxDepth: number,
): string[] | null {
  if (from === to) return [from];
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    (adj.get(e.src) ?? adj.set(e.src, []).get(e.src)!).push(e.dst);
    (adj.get(e.dst) ?? adj.set(e.dst, []).get(e.dst)!).push(e.src);
  }
  const prev = new Map<string, string>();
  const depthOf = new Map<string, number>([[from, 0]]);
  const visited = new Set<string>([from]);
  let frontier = [from];
  while (frontier.length) {
    const next: string[] = [];
    for (const id of frontier) {
      const d = depthOf.get(id) ?? 0;
      if (d >= maxDepth) continue;
      for (const nb of adj.get(id) ?? []) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        prev.set(nb, id);
        depthOf.set(nb, d + 1);
        if (nb === to) {
          const path = [nb];
          let cur = nb;
          while (prev.has(cur)) {
            cur = prev.get(cur)!;
            path.unshift(cur);
          }
          return path;
        }
        next.push(nb);
      }
    }
    frontier = next;
  }
  return null;
}

function normalizeToolName(value: string): MeriToolName {
  const name = value.trim();
  if (TOOL_DEFINITIONS.some((tool) => tool.name === name)) return name as MeriToolName;
  throw new NotFoundException('Meri tool not found');
}

function objectInput(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

function requiredString(input: Record<string, unknown>, key: string, max: number): string {
  const value = optionalString(input, key, max);
  if (!value) throw new BadRequestException(`${key} is required`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string, max: number): string | null {
  const value = input[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function optionalBoolean(input: Record<string, unknown>, key: string): boolean | null {
  const value = input[key];
  return typeof value === 'boolean' ? value : null;
}

/**
 * Optional array-of-strings input: returns a cleaned string[] (trimmed,
 * empties dropped, each capped, list capped) or null when the key is absent /
 * not an array. Used by update_client_profile for issueCodes/naicsCodes/etc.
 */
function optionalStringArray(
  input: Record<string, unknown>,
  key: string,
  maxItems: number,
  maxLen: number,
): string[] | null {
  const value = input[key];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

/**
 * Registrable domain of a client's website, for matching correspondent
 * addresses against the client they belong to.
 *
 * Strips scheme, path, port and a leading `www.`. Deliberately naive about
 * multi-part public suffixes (`.co.uk`): it compares the whole host, so
 * `foo.co.uk` matches `@foo.co.uk` correctly and never over-broadens to `.co.uk`.
 * Returns null for the free-mail hosts, where a shared domain says nothing about
 * who someone works for — matching those would file every Gmail correspondent
 * in the tenant under whichever client happened to list gmail.com.
 */
const GENERIC_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
]);

export function websiteDomain(website: string | null | undefined): string | null {
  if (!website) return null;
  let host = website.trim().toLowerCase();
  if (!host) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.split('/')[0] ?? '';
  host = host.split('?')[0] ?? '';
  host = host.split('@').pop() ?? '';
  host = host.split(':')[0] ?? '';
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host || !host.includes('.') || host.endsWith('.')) return null;
  if (GENERIC_MAIL_DOMAINS.has(host)) return null;
  return host;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

/**
 * Parse the optional `facilities[]` payload of update_client_profile into
 * CreateFacilityInput rows. Non-objects and rows without a usable `name` are
 * dropped. List capped at 50; each string field trimmed/capped. districtSource
 * is forced to 'web_import' so these are auditable as machine-imported (and
 * distinguishable from 'user'/'geocoded' on the Facilities tab).
 */
function parseFacilityInputs(value: unknown): CreateFacilityInput[] {
  if (!Array.isArray(value)) return [];
  const out: CreateFacilityInput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const name = optionalString(row, 'name', 200);
    if (!name) continue;
    const employee = row.employeeCount;
    const employeeCount =
      typeof employee === 'number' || typeof employee === 'string'
        ? clampInt(employee, 0, 10_000_000, 0)
        : undefined;
    out.push({
      name,
      addressLine: optionalString(row, 'addressLine', 300) ?? undefined,
      city: optionalString(row, 'city', 120) ?? undefined,
      state: optionalString(row, 'state', 2)?.toUpperCase() ?? undefined,
      zip: optionalString(row, 'zip', 10) ?? undefined,
      congressionalDistrict: optionalString(row, 'congressionalDistrict', 4) ?? undefined,
      districtSource: 'web_import',
      employeeCount,
      notes: optionalString(row, 'notes', 2000) ?? undefined,
    });
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Parse the optional `capabilities[]` payload of update_client_profile into
 * CreateCapabilityInput rows. Non-objects and rows without a usable `name` are
 * dropped. List capped at 50.
 */
function parseCapabilityInputs(value: unknown): CreateCapabilityInput[] {
  if (!Array.isArray(value)) return [];
  const out: CreateCapabilityInput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const name = optionalString(row, 'name', 200);
    if (!name) continue;
    out.push({
      name,
      type: optionalString(row, 'type', 60) ?? undefined,
      description: optionalString(row, 'description', 4000) ?? undefined,
      sector: optionalString(row, 'sector', 120) ?? undefined,
      notes: optionalString(row, 'notes', 2000) ?? undefined,
    });
    if (out.length >= 50) break;
  }
  return out;
}

/**
 * Parse the optional `people[]` payload of update_client_profile into
 * CreatePersonInput rows (the People / key-contacts tab). Non-objects and rows
 * without a usable `name` are dropped. List capped at 50; each string field
 * trimmed/capped. `lastContact` is passed through as a string — the service
 * coerces it to a Date (invalid dates become null there).
 */
function parsePeopleInputs(value: unknown): CreatePersonInput[] {
  if (!Array.isArray(value)) return [];
  const out: CreatePersonInput[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const name = optionalString(row, 'name', 200);
    if (!name) continue;
    out.push({
      name,
      title: optionalString(row, 'title', 200) ?? undefined,
      email: optionalString(row, 'email', 200) ?? undefined,
      phone: optionalString(row, 'phone', 60) ?? undefined,
      role: optionalString(row, 'role', 120) ?? undefined,
      lastContact: optionalString(row, 'lastContact', 40) ?? undefined,
      notes: optionalString(row, 'notes', 2000) ?? undefined,
    });
    if (out.length >= 50) break;
  }
  return out;
}

function ownMeetingWhere(userId: string): Prisma.MeetingWhereInput {
  return {
    OR: [{ createdByUserId: userId }, { connection: { createdByUserId: userId } }],
  };
}

function ownMailThreadWhere(userId: string): Prisma.MailThreadWhereInput {
  return {
    connection: { createdByUserId: userId },
  };
}

function ownMailMessageWhere(userId: string): Prisma.MailMessageWhereInput {
  return {
    connection: { createdByUserId: userId },
  };
}

function renderMeetingBrief(input: {
  meeting: MeetingForBrief;
  notes: Array<{ body: string | null; createdAt: Date }>;
  debriefs: Array<{ body: string | null; createdAt: Date }>;
  recentThreads: Array<{ subject: string; snippet: string | null; lastMessageAt: Date | null }>;
}) {
  const { meeting, notes, debriefs, recentThreads } = input;
  const attendees = meeting.attendees
    .map((attendee) => attendee.name || attendee.email)
    .filter(Boolean)
    .join(', ');
  const prep = meeting.preps[0];
  const tasks = meeting.tasks.map(
    (task) => `- ${task.title}${task.dueDate ? ` (due ${formatDate(task.dueDate)})` : ''}`,
  );

  return [
    `# Meeting Brief: ${meeting.subject}`,
    '',
    `Client: ${meeting.client?.name ?? 'Unassigned'}`,
    `When: ${formatDate(meeting.startsAt)} - ${formatDate(meeting.endsAt)}`,
    meeting.location ? `Location: ${meeting.location}` : null,
    attendees ? `Attendees: ${attendees}` : null,
    '',
    '## Context',
    summarizeText(meeting.description, 1200) || 'No meeting description is available in Capiro.',
    '',
    '## Latest Prep',
    prep
      ? [prep.summary, ...jsonStringArray(prep.talkingPoints).map((item) => `- ${item}`)]
          .filter(Boolean)
          .join('\n')
      : 'No saved prep is available for this meeting.',
    '',
    '## Visible Notes',
    notes.length
      ? notes.map((note) => `- ${summarizeText(note.body, 500)}`).join('\n')
      : 'No visible notes.',
    '',
    '## Visible Debriefs',
    debriefs.length
      ? debriefs.map((debrief) => `- ${summarizeText(debrief.body, 500)}`).join('\n')
      : 'No visible debriefs.',
    '',
    '## Open Tasks',
    tasks.length ? tasks.join('\n') : 'No open tasks are attached to this meeting.',
    '',
    '## Recent Client Threads',
    recentThreads.length
      ? recentThreads
          .map((thread) => `- ${thread.subject}: ${summarizeText(thread.snippet, 240)}`)
          .join('\n')
      : 'No recent authorized mail threads are linked to this client.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function renderPolicyMemo(input: {
  title: string;
  objective: string;
  clientContext: unknown;
  researchResults: unknown[];
}) {
  const context = objectInput(input.clientContext);
  const client = objectInput(context.client);
  const clientName = typeof client.name === 'string' ? client.name : 'Selected client';
  const summary = objectInput(context.summary);
  const sources = input.researchResults
    .map((result) => objectInput(result))
    .map(
      (result) =>
        `- ${String(result.title ?? result.id ?? 'Source')}: ${summarizeText(String(result.snippet ?? ''), 280)}`,
    )
    .join('\n');

  return [
    `# ${input.title}`,
    '',
    `Client: ${clientName}`,
    `Objective: ${input.objective}`,
    '',
    '## Current Capiro Context',
    `- Meetings in loaded context: ${summary.meetings ?? 0}`,
    `- Mail threads in loaded context: ${summary.mailThreads ?? 0}`,
    `- Contacts in loaded context: ${summary.contacts ?? 0}`,
    `- Open tasks in loaded context: ${summary.openTasks ?? 0}`,
    '',
    '## Draft Position',
    'Add the policy position, supporting evidence, and requested action here. This draft was assembled from authorized Capiro context and should be reviewed before external use.',
    '',
    '## Supporting Sources',
    sources || 'No matching authorized research sources were found for the objective.',
    '',
    '## Follow-Up',
    '- Confirm factual claims against primary sources.',
    '- Attach client-approved language and citations.',
    '- Save final outreach or memo artifacts in Capiro.',
  ].join('\n');
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** lda_client projection shared by lookup_client_registry and create_client. */
type LdaPick = {
  id: number;
  name: string;
  state: string | null;
  generalDescription: string | null;
  totalFilings: number;
  latestFilingYear: number | null;
};

const LDA_PICK_SELECT = {
  id: true,
  name: true,
  state: true,
  generalDescription: true,
  totalFilings: true,
  latestFilingYear: true,
} as const;

function summarizeText(value: unknown, max = 500): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function parseAndValidatePublicUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException('url must be a valid absolute URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new BadRequestException('Only http/https URLs are allowed');
  }

  const host = (parsed.hostname || '').toLowerCase();
  if (!host) throw new BadRequestException('URL hostname is required');
  if (isPrivateOrLocalHost(host)) {
    throw new BadRequestException('Private/local network URLs are not allowed');
  }

  return parsed;
}

function isPrivateOrLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.local')) return true;

  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1).toLowerCase();
    return (
      inner === '::1' ||
      inner.startsWith('fc') ||
      inner.startsWith('fd') ||
      inner.startsWith('fe80:')
    );
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const parts = host.split('.').map((p) => Number(p));
    if (parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  return false;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new BadGatewayException('Web scrape timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const value = stripHtml(match[1] ?? '').trim();
  return value || null;
}

function extractReadableText(html: string, maxChars: number): string {
  let text = html;
  text = text.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
  text = text.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ');
  text = stripHtml(text);
  text = text.replace(/\s+/g, ' ').trim();
  return summarizeText(text, maxChars);
}

function extractTopLinks(html: string, origin: string, limit: number) {
  const links: Array<{ url: string; text: string | null }> = [];
  const seen = new Set<string>();
  const regex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) && links.length < limit) {
    const href = decodeHtmlEntities((match[1] ?? '').trim());
    if (
      !href ||
      href.startsWith('#') ||
      href.startsWith('javascript:') ||
      href.startsWith('mailto:')
    ) {
      continue;
    }
    let resolved: URL;
    try {
      resolved = new URL(href, origin);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(resolved.protocol)) continue;
    if (isPrivateOrLocalHost(resolved.hostname.toLowerCase())) continue;
    const url = resolved.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const text = summarizeText(stripHtml(match[2] ?? ''), 120) || null;
    links.push({ url, text });
  }
  return links;
}

async function queryDuckDuckGoNews(query: string, limit: number) {
  const q = encodeURIComponent(query);
  const url = `https://duckduckgo.com/html/?q=${q}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Capiro-Meri/1.0; +https://capiro.ai)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!response.ok) {
    throw new BadGatewayException(`Public web search failed (${response.status})`);
  }
  const html = await response.text();

  const results: Array<{ title: string; url: string; snippet: string | null; source: string }> = [];
  const resultRegex =
    /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>|<div[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/div>)?/g;
  let match: RegExpExecArray | null;
  while ((match = resultRegex.exec(html)) && results.length < limit) {
    const rawHref = decodeHtmlEntities(match[1] ?? '').trim();
    const title = stripHtml(match[2] ?? '').trim();
    const snippet = stripHtml(match[3] ?? match[4] ?? '').trim();
    const resolvedUrl = unwrapDuckDuckGoUrl(rawHref);
    if (!title || !resolvedUrl) continue;
    results.push({
      title: summarizeText(title, 180),
      url: resolvedUrl,
      snippet: snippet ? summarizeText(snippet, 320) : null,
      source: 'duckduckgo',
    });
  }

  return results;
}

function unwrapDuckDuckGoUrl(value: string): string {
  try {
    if (value.startsWith('/l/?')) {
      const parsed = new URL(`https://duckduckgo.com${value}`);
      const target = parsed.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
  } catch {
    return value;
  }
  return value;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDate(value: Date): string {
  return value.toISOString();
}

function dateMillis(value: Date | null): number {
  return value ? value.getTime() : 0;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Meri tool: ${value}`);
}
