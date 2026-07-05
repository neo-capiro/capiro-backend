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
import type { AppConfig } from '../config/config.schema.js';
import { EngagementService } from '../engagement/engagement.service.js';
import { IntelligenceService } from '../intelligence/intelligence.service.js';
import { ActionRecommendationReadService } from '../intelligence/actions/action-recommendation-read.service.js';
import type { ActionStatus } from '../intelligence/actions/action-recommendation.types.js';
import {
  ClientCapabilitiesService,
  type CreateCapabilityInput,
} from '../clients/client-capabilities.service.js';
import { ClientPeopleService } from '../clients/client-people.service.js';
import { MemoryIngestService } from '../memory/memory-ingest.service.js';
import {
  ClientFacilitiesService,
  type CreateFacilityInput,
} from '../clients/client-facilities.service.js';
import { ClientsService } from '../clients/clients.service.js';
import { RegulatoryDocketService } from '../regulatory-docket/regulatory-docket.service.js';
import { MicrosoftGraphSyncService } from '../engagement/microsoft/microsoft-graph-sync.service.js';
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
import { buildSavedMemoryRecord } from './meri-memory.helpers.js';
import { buildWebSearchRequest, normalizeWebResults } from './meri-websearch.helpers.js';
import { looksLikePdf } from './meri-scrape.helpers.js';
import { buildKnowledgeGraph, walkFrom, type FkRelation } from '../memory/memory-graph.helpers.js';
import { embedText, vectorLiteral, normalize } from '../embeddings/embedder.js';

const PRODUCT_NAME = 'Meri';

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
      'Semantic search over the firm\'s institutional memory (memory items: client hubs, meetings, email threads, distilled Meri sessions, analyst notes). Finds relevant memory by MEANING, not just keywords — use for "what do we know about X", "have we discussed Y before", "find past context on Z". Returns the top matching memory items with a relevance score. Tenant + own-private scoped.',
  },
  {
    name: 'search_congress_bills',
    description:
      'Search congressional bills in the Capiro database (118th and 119th Congress). Filter by keyword, policy area, congress number, or recent activity date. Returns bill title, sponsor, latest action, policy area, and cosponsors count.',
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
      'Search state legislature bills via OpenStates data. Filter by state (2-letter code), keyword, subject, or session. Returns identifier, title, sponsor, latest action, and subjects.',
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
      "List recent email threads from the tenant's connected Microsoft 365 inbox, optionally filtered by client.",
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
      'Search DoD Program Elements (PEs) — the RDT&E/procurement budget lines from the Pentagon J-books. Filter by military service, budget activity, or title keyword. Returns PE code, title, service, budget activity, appropriation type, status, and whether the PE has budget/award/bill data. Use get_program_element / get_pe_budget_timeline for detail.',
  },
  {
    name: 'get_program_element',
    description:
      "Get a single DoD Program Element's full detail by PE code: title, description, service, appropriation type, status, ACAT level, program of record, source-document URLs, and complete fiscal-year budget history.",
  },
  {
    name: 'get_pe_budget_timeline',
    description:
      "Get a Program Element's fiscal-year budget timeline by PE code: per-FY president's request, House/Senate authorization and appropriations marks (HASC/SASC/HAC-D/SAC-D), conference, and enacted amounts, plus milestones and conference-probability predictions.",
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
      'congressionalDistrict, employeeCount) and capabilities (products/technologies the ' +
      "organization offers: name, type, description, sector) discovered on the client's " +
      'website or in filings -- pass them as the facilities[] and capabilities[] arrays. ' +
      'Each facility/capability in those arrays is APPENDED (new rows), never used to delete ' +
      'existing ones. Only call this AFTER you have shown the user the proposed values (ideally ' +
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
  'create_word',
  'create_excel',
  'create_powerpoint',
  'schedule_task',
  'cancel_scheduled_task',
  'create_task',
  'update_task',
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
    private readonly microsoftGraph: MicrosoftGraphSyncService,
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
    private readonly clientKb: ClientKbService,
    private readonly featureFlags: MeriFeatureFlagsService,
    private readonly clients: ClientsService,
    private readonly memoryIngest: MemoryIngestService,
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
      search_congress_bills: obj({
        query: str('Keyword search'),
        policyArea: str('Policy area filter'),
        congress: int('Congress number, e.g. 118 or 119'),
        activeSince: str('ISO date; only bills with action since then'),
        limit: int('Max results (1-50)'),
        page: int('Page number'),
      }),
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
        limit: int('Max results (1-50)'),
      }),
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
          scope: str('"personal" (default — this user only) or "firm" (shared across the firm).'),
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
    return this.execute(ctx, normalizeToolName(rawName), objectInput(rawInput));
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
      case 'reply_email':
        return this.replyEmail(ctx, input);
      case 'save_memory':
        return this.saveMemory(ctx, input);
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
      case 'search_acquisition_personnel':
        return this.searchAcquisitionPersonnel(ctx, input);
      case 'get_acquisition_person':
        return this.getAcquisitionPerson(ctx, input);
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

  private async saveMemory(ctx: TenantContext, input: Record<string, unknown>) {
    const content = requiredString(input, 'content', 4000);
    const key = optionalString(input, 'key', 120);
    const scope = optionalString(input, 'scope', 20);
    const record = buildSavedMemoryRecord({ content, key, scope, userId: ctx.userId });
    if (!record) throw new BadRequestException('save_memory requires non-empty content');

    // Governance (Phase 4a): only admins may write firm-wide memory. A non-admin
    // firm request is refused (not silently downgraded) so the user knows it did
    // not become firm-wide truth; they can re-save it as personal instead.
    const isAdmin = ctx.role === 'user_admin' || ctx.role === 'capiro_admin';
    if (record.scope === 'firm' && !isAdmin) {
      return {
        saved: false,
        scope: 'firm' as const,
        message:
          'Firm-wide memory can only be saved by an admin. I can save this as your personal memory instead — just say so.',
      };
    }

    const metadata = {
      tool: 'save_memory',
      createdBy: 'user-requested',
      userId: ctx.userId,
      visibility: record.scope,
    };

    // Concurrency-safe upsert. We can't use prisma.upsert() on the
    // (tenant, scope, owner, key) compound unique because firm memory has
    // owner_user_id = NULL (SQL NULLs aren't matchable through a compound-unique
    // where), and firm-scope uniqueness is enforced by a partial index Prisma
    // doesn't model (migration 20260705120000). So: find→update, else create,
    // and if a concurrent save wins the insert race (P2002), re-find + update.
    // Mirrors the ActionRecommendationService P2002 idiom.
    const findExisting = () =>
      this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioMemory.findFirst({
          where: {
            tenantId: ctx.tenantId,
            scope: record.scope,
            ownerUserId: record.ownerUserId,
            key: record.key,
          },
          select: { id: true },
        }),
      );
    const updateExisting = (id: string) =>
      this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioMemory.update({
          where: { id },
          data: { value: record.value, source: record.source, metadata },
        }),
      );

    let memoryId: string | undefined;
    const existing = await findExisting();
    if (existing) {
      await updateExisting(existing.id);
      memoryId = existing.id;
    } else {
      try {
        const created = await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.clioMemory.create({
            data: {
              tenantId: ctx.tenantId,
              scope: record.scope,
              ownerUserId: record.ownerUserId,
              key: record.key,
              value: record.value,
              source: record.source,
              metadata,
            },
            select: { id: true },
          }),
        );
        memoryId = created.id;
      } catch (err) {
        // A concurrent save created the same (tenant, scope, owner, key) first.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const raced = await findExisting();
          if (!raced) throw err;
          await updateExisting(raced.id);
          memoryId = raced.id;
        } else {
          throw err;
        }
      }
    }

    // Embed for semantic recall (best-effort; never blocks the tool result).
    void this.embedMemory(ctx.tenantId, record.key, record.value).catch(() => {});
    // Write-through: project into the institutional-memory graph + index so the
    // fact is retrievable via search_memory without waiting for the nightly
    // refresh. Fire-and-forget + non-fatal (projectClioMemory never throws).
    if (memoryId) void this.memoryIngest.projectClioMemory(ctx.tenantId, memoryId);

    this.logger.log(
      `save_memory: stored ${record.scope} memory "${record.key}" for tenant ${ctx.tenantId}`,
    );
    return {
      saved: true,
      scope: record.scope === 'user_private' ? 'personal' : 'firm',
      key: record.key,
      value: record.value,
      message: 'Saved to long-term memory; I will recall this in future conversations.',
    };
  }

  /**
   * Embed a memory value (OpenAI text-embedding-3-small, 1536-dim) into pgvector
   * so it is retrievable by semantic search. Best-effort; mirrors
   * MeriService.embedAndStoreMemory. No-op without OPENAI_API_KEY. The UPDATE is
   * tenant-scoped and the key is tenant-unique, so it targets exactly one row.
   */
  private async embedMemory(tenantId: string, key: string, value: string): Promise<void> {
    const openaiKey = this.config.get('OPENAI_API_KEY', { infer: true });
    if (!openaiKey) return;
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: `${key}: ${value}` }),
    });
    if (!res.ok) return;
    const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
    const embedding = json.data?.[0]?.embedding;
    if (!embedding || embedding.length !== 1536) return;
    const vecStr = `[${embedding.join(',')}]`;
    // withTenant: clio_memory is RLS-protected; a bare write matches 0 rows under
    // FORCE ROW LEVEL SECURITY and silently drops the embedding.
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE clio_memory SET embedding = $1::vector WHERE tenant_id = $2::uuid AND key = $3`,
        vecStr,
        tenantId,
        key,
      ),
    );
  }

  private async getClientContext(ctx: TenantContext, input: Record<string, unknown>) {
    const clientId = requiredString(input, 'clientId', 80);
    await this.ensureClientVisible(ctx, clientId);
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
  private async loadGraphForCtx(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // item nodes the caller may see (RLS: tenant + own-private), plus their wikilink edges
      const items = await tx.$queryRaw<
        Array<{ id: string; type: string; slug: string; title: string; sections: unknown }>
      >`
        SELECT id, type, slug, title, sections_jsonb AS sections
        FROM memory_items
        WHERE owner_user_id IS NULL OR owner_user_id = ${ctx.userId}::uuid
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
        WHERE i.owner_user_id IS NULL OR i.owner_user_id = ${ctx.userId}::uuid
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
      return buildKnowledgeGraph(fk, wiki, itemNodeById);
    });
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
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRawUnsafe<
        Array<{
          type: string;
          slug: string;
          title: string;
          client_id: string | null;
          score: number;
        }>
      >(
        `SELECT mi.type, mi.slug, mi.title, mi.client_id,
                1 - (ce.embedding <=> '${literal}'::vector) AS score
           FROM context_embeddings ce
           JOIN memory_items mi ON mi.id::text = ce.source_id
          WHERE ce.source_type = 'memory_item'
            AND ce.tenant_id = $1::uuid
            AND (mi.owner_user_id IS NULL OR mi.owner_user_id = $2::uuid)
          ORDER BY ce.embedding <=> '${literal}'::vector
          LIMIT ${k}`,
        ctx.tenantId,
        ctx.userId,
      ),
    );
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

  private async searchCongressBills(input: Record<string, unknown>) {
    const search = optionalString(input, 'query', 240) ?? optionalString(input, 'search', 240);
    const policyArea = optionalString(input, 'policyArea', 120);
    const congressNum = input.congress ? Number(input.congress) : undefined;
    const activeSince = optionalString(input, 'activeSince', 30);
    const limit = clampInt(input.limit, 1, 50, 20);
    const page = clampInt(input.page, 1, 100, 1);

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

    return {
      tool: 'search_program_elements',
      generatedAt: new Date().toISOString(),
      ...result,
    };
  }

  private async getProgramElementDetail(ctx: TenantContext, input: Record<string, unknown>) {
    const peCode = requiredString(input, 'peCode', 32);
    const programElement = await this.programElement.getProgramElement(peCode, ctx);
    return {
      tool: 'get_program_element',
      generatedAt: new Date().toISOString(),
      programElement,
    };
  }

  private async getPeBudgetTimeline(input: Record<string, unknown>) {
    const peCode = requiredString(input, 'peCode', 32);
    const timeline = await this.programElement.getTimeline(peCode);
    return {
      tool: 'get_pe_budget_timeline',
      generatedAt: new Date().toISOString(),
      ...timeline,
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

    return {
      tool: 'search_federal_grants',
      generatedAt: new Date().toISOString(),
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
        status: g.status,
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
        sponsorName: b.sponsorName,
        sponsorParty: b.sponsorParty,
        latestActionDate: b.latestActionDate,
        latestActionText: b.latestActionText,
        url: b.url,
      })),
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
    const clientId = optionalString(input, 'clientId', 80);
    const limit = clampInt(input.limit, 1, 25, 8);
    if (clientId) await this.ensureClientVisible(ctx, clientId);

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
    const clientId = requiredString(input, 'clientId', 80);
    const conversationId = optionalString(input, 'conversationId', 80);
    const title = optionalString(input, 'title', 160) || 'Policy memo draft';
    const objective = optionalString(input, 'objective', 500) || 'Prepare a policy memo.';
    const providedBody = optionalString(input, 'body', 40_000);
    await this.ensureClientVisible(ctx, clientId);
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
      await this.ensureClientVisible(ctx, clientId);
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
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.integrationConnection.findFirst({
        where: {
          tenantId: ctx.tenantId,
          createdByUserId: ctx.userId,
          provider: 'microsoft_365',
          status: 'connected',
          token: { isNot: null },
        },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, accountEmail: true, displayName: true },
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
    if (!connection) return { ok: false, error: 'no connected Microsoft 365 account' };
    try {
      await this.microsoftGraph.sendMail(ctx, connection.id, {
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
          'No connected Microsoft 365 account found. Please connect one in Settings → Integrations.',
      };
    }

    await this.microsoftGraph.sendMail(ctx, connection.id, {
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
      return { error: 'No connected Microsoft 365 account found.' };
    }

    const replySubject = thread.subject?.startsWith('Re: ')
      ? thread.subject
      : `Re: ${thread.subject ?? ''}`;

    await this.microsoftGraph.sendMail(ctx, connection.id, {
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
    const clientId = optionalString(input, 'clientId', 80) ?? null;
    const conversationId = optionalString(input, 'conversationId', 80);
    if (clientId) await this.ensureClientVisible(ctx, clientId);

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
    const clientId = optionalString(input, 'clientId', 80);
    const statusRaw = optionalString(input, 'status', 30)?.toLowerCase() ?? null;
    const dueBeforeRaw = optionalString(input, 'dueBefore', 40);
    const limit = clampInt(input.limit, 1, 50, 25);
    if (clientId) await this.ensureClientVisible(ctx, clientId);

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
    const clientId = optionalString(input, 'clientId', 80);
    const status = optionalString(input, 'status', 40);
    const sort = optionalString(input, 'sort', 20);
    const limit = clampInt(input.limit, 1, 50, 20);
    if (clientId) await this.ensureClientVisible(ctx, clientId);

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
    const clientId = requiredString(input, 'clientId', 80);
    await this.ensureClientVisible(ctx, clientId);
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
    const clientId = requiredString(input, 'clientId', 80);
    await this.ensureClientVisible(ctx, clientId);
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
    const clientId = requiredString(input, 'clientId', 80);
    await this.ensureClientVisible(ctx, clientId);
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

    const clientId = optionalString(input, 'clientId', 80);
    const status = optionalString(input, 'status', 40);
    const limit = clampInt(input.limit, 1, 50, 20);
    if (clientId) await this.ensureClientVisible(ctx, clientId);

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
    const clientId = optionalString(input, 'clientId', 80);
    const dueDate = optionalString(input, 'dueDate', 40);
    const description = optionalString(input, 'description', 2000);
    if (clientId) await this.ensureClientVisible(ctx, clientId);

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
    const clientId = requiredString(input, 'clientId', 80);
    await this.ensureClientVisible(ctx, clientId);

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

    // Optional child-record appends (facilities / capabilities). These are
    // separate tables from the scalar Client profile, so an import that only
    // adds facilities/capabilities is valid even with no scalar field changes.
    const facilityInputs = parseFacilityInputs(input.facilities);
    const capabilityInputs = parseCapabilityInputs(input.capabilities);

    if (
      writtenFields.length === 0 &&
      facilityInputs.length === 0 &&
      capabilityInputs.length === 0
    ) {
      throw new BadRequestException(
        'update_client_profile: no recognized profile fields, facilities, or capabilities to write',
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

    // Append facilities, then capabilities. Each create is tenant-scoped and
    // 404s outside the tenant, so a bad clientId can't cross tenants. We collect
    // per-row outcomes so a single bad row (e.g. invalid district) doesn't abort
    // the whole import; the model can relay failures back to the user.
    const facilitiesCreated: string[] = [];
    const capabilitiesCreated: string[] = [];
    const rowErrors: string[] = [];
    for (const f of facilityInputs) {
      try {
        const created = await this.clientFacilities.createFacility(ctx, clientId, f);
        facilitiesCreated.push(created.name);
      } catch (err) {
        rowErrors.push(`facility "${f.name}": ${(err as Error).message}`);
      }
    }
    for (const c of capabilityInputs) {
      try {
        const created = await this.clientCapabilities.createCapability(ctx, clientId, c);
        capabilitiesCreated.push(created.name);
      } catch (err) {
        rowErrors.push(`capability "${c.name}": ${(err as Error).message}`);
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
      rowErrors,
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

  private async ensureClientVisible(ctx: TenantContext, clientId: string) {
    const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
        select: { id: true },
      }),
    );
    if (!client) throw new NotFoundException('Client not found');
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
