export interface ExplorerResponse<T> {
  rows: T[];
  total: number;
}

export interface ExplorerLdaFilingRow {
  id: string;
  filingUuid: string;
  filingType: string;
  filingYear: number;
  filingPeriod: string | null;
  income: number | null;
  expenses: number | null;
  dtPosted: string | null;
  registrantName: string;
  clientName: string;
  clientState: string | null;
  issueCodes: string[];
}

export interface LdaFacets {
  issueCodes: Array<{ code: string; name: string }>;
  years: number[];
  filingTypes: string[];
  states: string[];
  periods: string[];
}

export interface ExplorerContractorRow {
  id: string;
  name: string;
  uei: string | null;
  category: string | null;
  totalContracts: number | null;
  pctOfAllContracts: number | null;
  rankByContracts: number | null;
  noBidTotal: number | null;
  subsidiaries: number | null;
}

export interface ContractorFacets {
  categories: string[];
}

export interface ExplorerBillRow {
  id: string;
  congress: number;
  billType: string;
  billNumber: string;
  title: string;
  introducedDate: string | null;
  sponsorName: string | null;
  sponsorState: string | null;
  sponsorParty: string | null;
  latestActionText: string | null;
  latestActionDate: string | null;
  policyArea: string | null;
  cosponsorsCount: number;
  originChamber: string | null;
  url: string | null;
}

export interface BillFacets {
  congresses: number[];
  subjects: string[];
  chambers: string[];
  parties: string[];
  policyAreas: string[];
}

export interface ExplorerFedRegRow {
  id: string;
  documentNumber: string;
  type: string;
  title: string;
  agencyNames: string[];
  publicationDate: string;
  commentEndDate: string | null;
  effectiveDate: string | null;
  topics: string[];
  significantRule: boolean;
  htmlUrl: string | null;
}

export interface FedRegFacets {
  types: string[];
  agencies: string[];
  topics: string[];
}

export interface ExplorerHearingRow {
  id: string;
  chamber: string;
  committeeName: string;
  committeeCode: string | null;
  title: string;
  date: string;
  time: string | null;
  location: string | null;
  type: string | null;
  witnesses: string[];
  url: string | null;
}
export interface HearingFacets {
  chambers: string[];
  committees: string[];
  types: string[];
}

export interface ExplorerGaoRow {
  id: string;
  title: string;
  url: string | null;
  publishDate: string | null;
  reportType: string | null;
  topics: string[];
  agencies: string[];
  summary: string | null;
  recommendations: number | null;
}
export interface GaoFacets {
  reportTypes: string[];
  topics: string[];
  agencies: string[];
}

export interface ExplorerCrsRow {
  id: string;
  title: string;
  date: string | null;
  authors: string[];
  topics: string[];
  summary: string | null;
  pdfUrl: string | null;
  htmlUrl: string | null;
  active: boolean;
}
export interface CrsFacets {
  topics: string[];
}

export interface ExplorerFecRow {
  id: string;
  committeeId: string;
  committeeName: string | null;
  candidateId: string | null;
  candidateName: string | null;
  contributorName: string | null;
  contributorEmployer: string | null;
  contributorOccupation: string | null;
  amount: number;
  contributionDate: string | null;
  receiptType: string | null;
  state: string | null;
  cycle: number;
}
export interface FecFacets {
  cycles: number[];
  states: string[];
}

export interface ExplorerFaraRow {
  id: string;
  registrationNumber: string;
  registrantName: string;
  foreignPrincipal: string;
  country: string | null;
  status: string | null;
  registrationDate: string | null;
  terminationDate: string | null;
  state: string | null;
  description: string | null;
}
export interface FaraFacets {
  countries: string[];
  statuses: string[];
  states: string[];
}

export interface ExplorerSecRow {
  id: string;
  cik: string;
  companyName: string;
  formType: string;
  accessionNumber: string;
  filingDate: string;
  reportDate: string | null;
  description: string | null;
  sic: string | null;
  url: string | null;
}
export interface SecFacets {
  formTypes: string[];
}

export interface ExplorerSamOppRow {
  id: string;
  noticeId: string;
  solicitationNumber: string | null;
  title: string;
  noticeType: string;
  agency: string | null;
  office: string | null;
  pscCode: string | null;
  naicsCode: string | null;
  postedDate: string | null;
  responseDeadline: string | null;
  active: boolean;
  url: string | null;
}
export interface SamOppFacets {
  noticeTypes: string[];
  agencies: string[];
}

export interface ExplorerFederalAwardRow {
  id: string;
  piid: string | null;
  contractorName: string | null;
  awardingAgency: string | null;
  awardingSubTier: string | null;
  amount: number | null;
  description: string | null;
  peCode: string | null;
  dodAcqProgramName: string | null;
  popState: string | null;
  fundingFy: number | null;
  actionDate: string | null;
  url: string | null;
}
export interface FederalAwardFacets {
  agencies: string[];
  states: string[];
  fiscalYears: number[];
}

export interface ExplorerFederalGrantRow {
  id: string;
  title: string;
  agency: string;
  subAgency: string | null;
  opportunityNumber: string | null;
  category: string | null;
  fundingInstrument: string | null;
  awardCeiling: number | null;
  estimatedFunding: number | null;
  openDate: string | null;
  closeDate: string | null;
  status: string | null;
  url: string | null;
}
export interface FederalGrantFacets {
  agencies: string[];
  statuses: string[];
}

export interface ExplorerStateLegislatorRow {
  id: string;
  name: string;
  state: string;
  chamber: string | null;
  district: string | null;
  party: string | null;
  email: string | null;
  url: string | null;
}
export interface StateLegislatorFacets {
  states: string[];
  chambers: string[];
  parties: string[];
}

export interface ExplorerIntelArticleRow {
  id: string;
  source: string;
  title: string;
  url: string;
  author: string | null;
  publishedAt: string;
  summary: string | null;
  topics: string[];
  agencies: string[];
}
export interface IntelArticleFacets {
  sources: string[];
  topics: string[];
  agencies: string[];
}

export interface ExplorerStateBillRow {
  id: string;
  state: string;
  session: string;
  identifier: string;
  title: string;
  chamber: string | null;
  classification: string[];
  subjects: string[];
  sponsorName: string | null;
  sponsorParty: string | null;
  latestActionDate: string | null;
  latestActionText: string | null;
  url: string | null;
  /** State Legislation Platform (S7.4) — canonical derived status (S3); null on a not-yet-derived row. */
  status?: string | null;
}
export interface StateBillFacets {
  states: string[];
  subjects: string[];
  parties: string[];
  chambers: string[];
}

/* ── Drill-in detail shapes ───────────────────────────────────────────── */

export interface LdaFilingDetail {
  filing: ExplorerLdaFilingRow & {
    expenses: number | null;
    clientId: number | null;
    registrantId: number | null;
  };
  registrantRecent: Array<{
    id: string;
    filingYear: number;
    filingPeriod: string | null;
    clientName: string;
    income: number | null;
  }>;
  clientRecent: Array<{
    id: string;
    filingYear: number;
    filingPeriod: string | null;
    registrantName: string;
    income: number | null;
  }>;
  issueCodes: Array<{ code: string; name: string }>;
}

export interface BillDetail {
  bill: ExplorerBillRow & {
    updateDate: string | null;
    subjects: string[];
    actions: Array<{ id: string; date: string; text: string; type: string | null; chamber: string | null }>;
  };
}

export interface ContractorDetail {
  contractor: ExplorerContractorRow & {
    slug: string | null;
    costPerTaxpayer: number | null;
    yearlySpend: Array<{ year: number; amount: number }>;
    topAgencies: Array<{ name: string; amount: number }>;
    topAwards: Array<{ awardId: string; recipient: string; amount: number; agency: string }>;
    noBidAwards: Array<{ awardId: string; recipient: string; amount: number; agency: string }>;
  };
}

export interface FedRegDetail {
  document: ExplorerFedRegRow & {
    abstract: string | null;
    docketIds: string[];
    cfrReferences: string[];
    pdfUrl: string | null;
  };
}

/* Detail shapes for the 8 newer sources. Backend returns the full row from
   each table, these types pick up extra (non-list-column) fields from the
   schema (e.g. SEC `description`, `sic`, `primaryDoc`; FEC `transactionId`,
   `memoText`; FARA `services`, `address`; intel article `content`) where
   they exist. Unknown fields read as undefined and the views just skip them. */

export interface HearingDetail {
  hearing: ExplorerHearingRow & {
    syncedAt?: string | null;
  };
}

export interface GaoDetail {
  report: ExplorerGaoRow & {
    syncedAt?: string | null;
  };
}

export interface CrsDetail {
  report: ExplorerCrsRow & {
    syncedAt?: string | null;
  };
}

export interface FecDetail {
  contribution: ExplorerFecRow & {
    transactionId?: string | null;
    memoText?: string | null;
    image?: string | null;
  };
}

export interface FaraDetail {
  registration: ExplorerFaraRow & {
    address?: string | null;
    services?: string | null;
  };
}

export interface SecDetail {
  filing: ExplorerSecRow & {
    primaryDoc?: string | null;
    stateOfIncorp?: string | null;
    fiscalYearEnd?: string | null;
  };
}

export interface IntelArticleDetail {
  article: ExplorerIntelArticleRow & {
    content?: string | null;
    feedUrl?: string | null;
  };
}

export interface StateBillDetail {
  bill: ExplorerStateBillRow & {
    abstract?: string | null;
    /** S3 canonical status (already on the base row for the list; repeated here so the drill-in doesn't depend on it). */
    status?: string | null;
    statusAt?: string | null;
    /** State Legislation Platform (S7.4) — additive drill-in fields, newest-first. */
    actions: Array<{ id: string; date: string; text: string; chamber: string | null }>;
    votes: Array<{
      id: string;
      date: string;
      motion: string | null;
      chamber: string | null;
      yeas: number;
      nays: number;
      nv: number;
      absent: number;
      passed: boolean | null;
      sourceUrl: string | null;
    }>;
    versions: Array<{ id: string; versionType: string; date: string; stateUrl: string | null }>;
    links: Array<{ id: string; linkType: string; relatedBillKey: string | null }>;
    stateUrl?: string | null;
  };
}
