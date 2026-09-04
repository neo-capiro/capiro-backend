/**
 * The allowlist for Meri's `query_global_data` / `list_global_datasets` tools.
 *
 * This is the actual safety boundary for that capability, not the compiler.
 * A dataset that isn't listed here cannot be queried, and a column that isn't
 * listed on a dataset's `fields` cannot be selected, filtered, grouped, or
 * ordered by — the compiler (`query-spec-compiler.ts`) refuses anything not
 * found here before any SQL is built. Every table referenced below is a
 * GLOBAL, no-tenant_id, ingested-fact table (see `schema.prisma`'s "GLOBAL
 * tables" sections) — this registry must never grow a tenant-scoped table.
 * Internal pipeline/audit/outbox tables (SyncRun, *Quarantine, *Outbox,
 * GovInfoCache, the Defense Budget promotion-ledger cluster, Tango sync
 * plumbing) are deliberately excluded: only reviewed, ask-a-real-question
 * "fact" tables belong here.
 *
 * Adding a dataset means reading its Prisma model, picking the columns worth
 * exposing, and — for anything with a status derived from a raw code field
 * rather than an explicit boolean (the LDA lesson this tool exists because
 * of) — writing that derivation once, here, as a reviewed `derived` field,
 * instead of leaving it to be reconstructed per chat turn.
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'timestamp' | 'string[]';

export interface RawFieldDef {
  /** Physical column name in the dataset's `table`/subquery. */
  column: string;
  type: FieldType;
  description: string;
  /** Default true. Set false to expose a column for select only, e.g. a free-text blob unsafe to group by. */
  filterable?: boolean;
  groupable?: boolean;
}

export interface DerivedFieldDef {
  /**
   * A fixed, reviewed SQL expression (no caller input) evaluated in the
   * dataset's `table`/subquery scope, e.g. a CASE over known filing-type
   * codes. Never built from spec input.
   */
  expression: string;
  type: FieldType;
  description: string;
  filterable?: boolean;
  groupable?: boolean;
}

export type FieldDef = RawFieldDef | DerivedFieldDef;

export function isDerivedField(f: FieldDef): f is DerivedFieldDef {
  return (f as DerivedFieldDef).expression !== undefined;
}

export interface GlobalDatasetDef {
  key: string;
  description: string;
  /**
   * The FROM-clause source: a bare table name, or a parenthesized derived
   * subquery aliased at the end (e.g. `(SELECT ... ) lda_reg`). Never built
   * from caller input. May contain the literal token `$ASOF_DATE$` exactly
   * once when `supportsAsOf` is true; the compiler substitutes it with a
   * bound timestamp parameter (the caller's `asOfDate`, or now()).
   */
  table: string;
  /**
   * When true, callers may pass `asOfDate` (an ISO date/timestamp) to ask
   * "what did this look like as of that date" instead of "right now" —
   * requires `table` to embed `$ASOF_DATE$`.
   */
  supportsAsOf?: boolean;
  fields: Record<string, FieldDef>;
  /** Hard ceiling on `limit`, regardless of what the caller asks for. */
  maxLimit: number;
  /** limit used when the caller omits one. */
  defaultLimit: number;
}

const TERMINATION_ONLY_CODE = 'LDA_TERMINATION_TYPES';

/**
 * Official Senate LDA filing_type codes whose most recent occurrence for a
 * (registrant, client) pair means that registration is no longer active.
 * Source of truth: https://lda.gov/api/v1/constants/filing/filingtypes/
 * (verified 2026-09-03 against the live endpoint). Encoded once, here — see
 * the module doc comment for why this must not be left to the model.
 */
const LDA_TERMINATION_CODES_SQL = `ARRAY[
  '1T','1TY','1@','1@Y',
  '2T','2TY','2@','2@Y',
  '3T','3TY','3@','3@Y',
  '4T','4TY','4@','4@Y',
  'MT','MTY','M@','M@Y',
  'YT','YTY','Y@','Y@Y'
]`;

export const GLOBAL_DATASET_REGISTRY: Record<string, GlobalDatasetDef> = {
  lda_registrations: {
    key: 'lda_registrations',
    description:
      'Senate LDA lobbying registrations: one row per (registrant, client) relationship, derived from the latest filing on record for that pair as of `asOfDate` (default: now). `status` is derived from the official LDA filing-type code of that latest filing, not a raw code. `is_in_house` flags a registrant that appears to be registering itself as its own client (name match) rather than an outside firm. Does not cover relationships whose LAST filing predates the ingestion window (2021-present) — a true-inactive-since-before-2021 relationship simply will not appear.',
    table: `(
      SELECT DISTINCT ON (registrant_id, client_id)
        registrant_id, client_id, registrant_name, client_name, client_state, filing_type, filing_year, dt_posted
      FROM lda_filing
      WHERE registrant_id IS NOT NULL AND client_id IS NOT NULL
        AND dt_posted <= $ASOF_DATE$
      ORDER BY registrant_id, client_id, dt_posted DESC
    ) lda_reg`,
    supportsAsOf: true,
    maxLimit: 2000,
    defaultLimit: 200,
    fields: {
      registrant_id: { column: 'registrant_id', type: 'number', description: 'LDA registrant id (a lobbying firm or in-house registrant).' },
      registrant_name: { column: 'registrant_name', type: 'string', description: 'Registrant (firm) name as filed.' },
      client_id: { column: 'client_id', type: 'number', description: 'LDA client id. NOTE: this id is scoped to the registration, not a stable per-company identifier — the same real company represented by two firms gets two different client_ids. Prefer client_name for entity-level questions, and expect it to be an overcount of distinct real organizations.' },
      client_name: { column: 'client_name', type: 'string', description: 'Client name as filed on this registration.' },
      client_state: { column: 'client_state', type: 'string', description: "Client's registered state." },
      filing_year: { column: 'filing_year', type: 'number', description: 'Year of the latest filing considered (bounded by asOfDate).' },
      dt_posted: { column: 'dt_posted', type: 'timestamp', description: 'When the latest considered filing was posted.' },
      status: {
        expression: `CASE WHEN filing_type = ANY(${LDA_TERMINATION_CODES_SQL}) THEN 'terminated' ELSE 'active' END`,
        type: 'string',
        description: `Derived from the latest filing's official LDA filing-type code (see ${TERMINATION_ONLY_CODE} in source) — 'active' or 'terminated'. This is the field to filter on for "how many active registrations."`,
      },
      is_in_house: {
        expression: `(upper(trim(registrant_name)) = upper(trim(client_name)))`,
        type: 'boolean',
        description: 'True when the registrant appears to be registering itself as its own client (in-house lobbying) rather than representing an outside client. Name-match heuristic — undercounts when the two name strings differ even slightly.',
      },
    },
  },

  federal_grants: {
    key: 'federal_grants',
    description: 'Grants.gov federal grant opportunities (NOFOs).',
    table: 'federal_grant',
    maxLimit: 1000,
    defaultLimit: 200,
    fields: {
      id: { column: 'id', type: 'string', description: 'Grants.gov opportunity id.' },
      agency: { column: 'agency', type: 'string', description: 'Awarding agency.' },
      sub_agency: { column: 'sub_agency', type: 'string', description: 'Awarding sub-agency.' },
      category: { column: 'category', type: 'string', description: 'Discretionary, Mandatory, etc.' },
      funding_instrument: { column: 'funding_instrument', type: 'string', description: 'Grant, Cooperative Agreement, etc.' },
      status: { column: 'status', type: 'string', description: 'posted | closed | archived | forecasted.' },
      doc_type: { column: 'doc_type', type: 'string', description: "'synopsis' or 'forecast'." },
      award_ceiling: { column: 'award_ceiling', type: 'number', description: 'Maximum award amount.' },
      award_floor: { column: 'award_floor', type: 'number', description: 'Minimum award amount.' },
      estimated_funding: { column: 'estimated_funding', type: 'number', description: 'Total estimated program funding.' },
      expected_awards: { column: 'expected_awards', type: 'number', description: 'Expected number of awards.' },
      open_date: { column: 'open_date', type: 'date', description: 'Posting open date.' },
      close_date: { column: 'close_date', type: 'date', description: 'Application close date.' },
    },
  },

  sam_opportunities: {
    key: 'sam_opportunities',
    description: 'SAM.gov federal contract opportunity notices.',
    table: 'sam_opportunity',
    maxLimit: 1000,
    defaultLimit: 200,
    fields: {
      notice_id: { column: 'notice_id', type: 'string', description: 'SAM.gov notice id.' },
      notice_type: { column: 'notice_type', type: 'string', description: "e.g. Solicitation, Presolicitation, Sources Sought, Award Notice." },
      agency: { column: 'agency', type: 'string', description: 'Agency.' },
      sub_agency: { column: 'sub_agency', type: 'string', description: 'Sub-agency/component.' },
      set_aside: { column: 'set_aside', type: 'string', description: 'Human-readable set-aside description; null = full and open.' },
      naics_code: { column: 'naics_code', type: 'string', description: 'NAICS code.' },
      psc_code: { column: 'psc_code', type: 'string', description: 'Product/Service code.' },
      posted_date: { column: 'posted_date', type: 'timestamp', description: 'When posted.' },
      response_deadline: { column: 'response_deadline', type: 'timestamp', description: 'Response due date.' },
      active: { column: 'active', type: 'boolean', description: 'False once the archive date has passed.' },
    },
  },

  federal_awards: {
    key: 'federal_awards',
    description: 'USAspending federal contract awards/obligations synced by Capiro.',
    table: 'federal_award',
    maxLimit: 1000,
    defaultLimit: 200,
    fields: {
      awarding_agency: { column: 'awarding_agency', type: 'string', description: 'Awarding agency.' },
      contractor_name: { column: 'contractor_name', type: 'string', description: 'Contractor/recipient name.' },
      amount: { column: 'amount', type: 'number', description: 'Award amount.' },
      pe_code: { column: 'pe_code', type: 'string', description: 'Linked DoD Program Element code, if resolved.' },
      dod_acq_program_code: { column: 'dod_acq_program_code', type: 'string', description: 'DoD Major Defense Acquisition Program code.' },
      dod_acq_program_name: { column: 'dod_acq_program_name', type: 'string', description: 'DoD MDAP name, e.g. F-35.' },
      pop_state: { column: 'pop_state', type: 'string', description: 'Place-of-performance state.' },
      action_date: { column: 'action_date', type: 'date', description: 'Contract action date.' },
      awarded_at: { column: 'awarded_at', type: 'timestamp', description: 'Award timestamp.' },
    },
  },

  sec_filings: {
    key: 'sec_filings',
    description: 'SEC EDGAR filings. NOTE: only ~150 curated CIKs are ingested (defense/pharma/energy/tech/finance/telecom/ag) — this is not a comprehensive mirror of EDGAR.',
    table: 'sec_filing',
    maxLimit: 1000,
    defaultLimit: 200,
    fields: {
      cik: { column: 'cik', type: 'string', description: 'Central Index Key.' },
      company_name: { column: 'company_name', type: 'string', description: 'Company name.' },
      form_type: { column: 'form_type', type: 'string', description: '10-K, 10-Q, 8-K, DEF14A, S-1, etc.' },
      filing_date: { column: 'filing_date', type: 'date', description: 'Filing date.' },
      sic: { column: 'sic', type: 'string', description: 'Standard Industrial Classification code.' },
      state_of_incorp: { column: 'state_of_incorp', type: 'string', description: 'State of incorporation.' },
    },
  },

  fara_registrations: {
    key: 'fara_registrations',
    description: 'DOJ FARA (Foreign Agents Registration Act) registrations. NOTE: the base feed is directory-only — foreign-principal/country/termination fields are only populated when a separate enrichment source is configured; treat nulls there as "unknown", not "none".',
    table: 'fara_registration',
    maxLimit: 1000,
    defaultLimit: 200,
    fields: {
      registrant_name: { column: 'registrant_name', type: 'string', description: 'Registrant name.' },
      foreign_principal: { column: 'foreign_principal', type: 'string', description: 'Foreign principal represented.' },
      country: { column: 'country', type: 'string', description: "Foreign principal's country." },
      status: { column: 'status', type: 'string', description: 'Active or Terminated, when known.' },
      registration_date: { column: 'registration_date', type: 'date', description: 'Registration date.' },
      termination_date: { column: 'termination_date', type: 'date', description: 'Termination date, when known.' },
      state: { column: 'state', type: 'string', description: "Registrant's state." },
    },
  },

  congress_bills: {
    key: 'congress_bills',
    description: 'Congress.gov federal bills (118th/119th Congress) with Capiro-derived canonical status.',
    table: 'congress_bill',
    maxLimit: 1000,
    defaultLimit: 200,
    fields: {
      congress: { column: 'congress', type: 'number', description: 'Congress number, e.g. 119.' },
      bill_type: { column: 'bill_type', type: 'string', description: 'hr, s, hjres, etc.' },
      policy_area: { column: 'policy_area', type: 'string', description: 'Congress.gov policy area.' },
      status: { column: 'status', type: 'string', description: 'Canonical derived stage, e.g. introduced, committee, passed_chamber, enacted, rule_failed.' },
      sponsor_state: { column: 'sponsor_state', type: 'string', description: "Sponsor's state." },
      sponsor_party: { column: 'sponsor_party', type: 'string', description: "Sponsor's party." },
      cosponsors_count: { column: 'cosponsors_count', type: 'number', description: 'Number of cosponsors.' },
      origin_chamber: { column: 'origin_chamber', type: 'string', description: 'House or Senate.' },
      introduced_date: { column: 'introduced_date', type: 'date', description: 'Introduction date.' },
      latest_action_date: { column: 'latest_action_date', type: 'date', description: 'Most recent action date.' },
    },
  },

  state_bills: {
    key: 'state_bills',
    description: 'State legislature bills (LegiScan primary, OpenStates cross-check) with Capiro-derived canonical status.',
    table: 'state_bill',
    maxLimit: 1000,
    defaultLimit: 200,
    fields: {
      state: { column: 'state', type: 'string', description: 'Two-letter state code.' },
      session: { column: 'session', type: 'string', description: 'Legislative session display name.' },
      chamber: { column: 'chamber', type: 'string', description: 'upper or lower.' },
      status: { column: 'status', type: 'string', description: 'Canonical derived status.' },
      sponsor_party: { column: 'sponsor_party', type: 'string', description: "Sponsor's party." },
      sponsor_count: { column: 'sponsor_count', type: 'number', description: 'Number of sponsors.' },
      latest_action_date: { column: 'latest_action_date', type: 'date', description: 'Most recent action date.' },
    },
  },

  gao_reports: {
    key: 'gao_reports',
    description: 'GAO reports and testimonies.',
    table: 'gao_report',
    maxLimit: 1000,
    defaultLimit: 200,
    fields: {
      report_type: { column: 'report_type', type: 'string', description: 'Report, Testimony, Correspondence.' },
      publish_date: { column: 'publish_date', type: 'date', description: 'Publish date.' },
      recommendations: { column: 'recommendations', type: 'number', description: 'Number of recommendations.' },
    },
  },

  crs_reports: {
    key: 'crs_reports',
    description: 'Congressional Research Service reports.',
    table: 'crs_report',
    maxLimit: 1000,
    defaultLimit: 200,
    fields: {
      date: { column: 'date', type: 'date', description: 'Publication date.' },
      active: { column: 'active', type: 'boolean', description: 'False if archived/withdrawn.' },
    },
  },

  fec_committees: {
    key: 'fec_committees',
    description: 'FEC-registered PACs and campaign committees.',
    table: 'fec_committee',
    maxLimit: 1000,
    defaultLimit: 200,
    fields: {
      committee_type: { column: 'committee_type', type: 'string', description: 'FEC committee type code.' },
      party: { column: 'party', type: 'string', description: 'Affiliated party, if any.' },
      state: { column: 'state', type: 'string', description: 'State.' },
      total_receipts: { column: 'total_receipts', type: 'number', description: 'Total receipts.' },
      total_disbursements: { column: 'total_disbursements', type: 'number', description: 'Total disbursements.' },
      cash_on_hand: { column: 'cash_on_hand', type: 'number', description: 'Cash on hand.' },
    },
  },

  news_articles: {
    key: 'news_articles',
    description: 'Aggregated policy/news RSS (Roll Call, The Hill, Politico, Axios, Reuters, agency press, think tanks).',
    table: 'intel_article',
    maxLimit: 1000,
    defaultLimit: 200,
    fields: {
      source: { column: 'source', type: 'string', description: 'Feed source, e.g. roll_call, the_hill, brookings.' },
      published_at: { column: 'published_at', type: 'timestamp', description: 'Publish timestamp.' },
      author: { column: 'author', type: 'string', description: 'Byline, when present.' },
      // Array columns: selectable for display, but not filterable/groupable —
      // none of the scalar filter ops (eq/contains/in/...) apply meaningfully
      // to a Postgres array without a dedicated array operator this compiler
      // does not implement.
      categories: { column: 'categories', type: 'string[]', description: 'Assigned categories.', groupable: false, filterable: false },
      agencies: { column: 'agencies', type: 'string[]', description: 'Extracted agency names.', groupable: false, filterable: false },
      topics: { column: 'topics', type: 'string[]', description: 'Extracted topic keywords.', groupable: false, filterable: false },
    },
  },
};

export function getDataset(key: string): GlobalDatasetDef | undefined {
  return GLOBAL_DATASET_REGISTRY[key];
}

export function listDatasetSummaries() {
  return Object.values(GLOBAL_DATASET_REGISTRY).map((d) => ({
    key: d.key,
    description: d.description,
    supportsAsOf: d.supportsAsOf ?? false,
    fields: Object.entries(d.fields).map(([name, def]) => ({
      name,
      type: def.type,
      description: def.description,
      filterable: def.filterable ?? true,
      groupable: def.groupable ?? true,
      aggregatable: def.type === 'number',
    })),
  }));
}
