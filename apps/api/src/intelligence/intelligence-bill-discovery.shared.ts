export type RelevantBill = {
  id: string;
  congress: number;
  billType: string;
  billNumber: string;
  title: string;
  introducedDate: Date | null;
  sponsorName: string | null;
  sponsorParty: string | null;
  sponsorState: string | null;
  latestActionText: string | null;
  latestActionDate: Date | null;
  policyArea: string | null;
  subjects: string[];
};
export interface RelevantBillsResult {
  total: number;
  bills: RelevantBill[];
}
export type RelevantBillRow = {
  id: string;
  congress: number;
  bill_type: string;
  bill_number: string;
  title: string;
  introduced_date: Date | null;
  sponsor_name: string | null;
  sponsor_party: string | null;
  sponsor_state: string | null;
  latest_action_text: string | null;
  latest_action_date: Date | null;
  policy_area: string | null;
  subjects: string[];
};
export type BillDetail = {
  identifier: string;
  title: string;
  latestActionDate: Date | null;
  latestActionText: string | null;
  status?: string | null;
  actionTexts?: string[];
  sponsorName: string | null;
  sponsorParty: string | null;
  subjectNames: string[];
};
export interface TrackedBillMatch {
  total: number;
  bills: BillDetail[];
}
export interface ManualMergeInput {
  total: number;
  bills: Array<BillDetail & { isManual?: boolean }>;
}
export interface TrackedBillsResult {
  total: number;
  issueCodes: string[];
  bills: Array<BillDetail & { isManual: boolean }>;
}
export type BillDetailRow = {
  id: string;
  title: string;
  latest_action_date: Date | null;
  latest_action_text: string | null;
  status?: string | null;
  action_texts?: string[];
  sponsor_name: string | null;
  sponsor_party: string | null;
  subjects: string[];
};
export type BillRelevanceTerms = {
  issueCodes: string[];
  issueNames: string[];
  keywordTermsExpanded: string[];
  embeddingPartsClean: string[];
  hasCapabilitySignal: boolean;
};
export type BillRegulationRow = {
  id: string;
  document_number: string;
  type: string;
  title: string;
  agency_names: string[];
  topics: string[];
  comment_end_date: Date | null;
  publication_date: Date;
  effective_date: Date | null;
  significant_rule: boolean;
  html_url: string | null;
};
export type BillGaoRow = {
  id: string;
  title: string;
  publish_date: Date | null;
  topics: string[];
  report_type: string | null;
  recommendations: number | null;
  url: string | null;
};
export type BillCrsRow = {
  id: string;
  title: string;
  date: Date | null;
  topics: string[];
  authors: string[];
  html_url: string | null;
};

export interface RelevantBillPorts {
  confirmedLdaIds(clientId: string, tenantId: string): Promise<number[]>;
  issueCodesForLdaIds(ids: number[]): Promise<string[]>;
  findRelevantBills(issueCodes: string[], fallbackTerms?: string[]): Promise<RelevantBillsResult>;
  findRelevantBillsByEmbeddings(terms: string[]): Promise<RelevantBillsResult | null>;
  findRelevantBillsByKeyword(terms: string[]): Promise<RelevantBillsResult>;
  warn(message: string): void;
}
export interface TrackedBillPorts {
  getManualTrackedBillIds(clientId: string, tenantId: string): Promise<string[]>;
  getClientRelevanceTerms(clientId: string, tenantId: string): Promise<BillRelevanceTerms>;
  fetchBillsByIds(ids: string[]): Promise<BillDetail[]>;
  findTrackedBillsByEmbeddings(
    terms: string[],
    similarityFloor?: number,
  ): Promise<TrackedBillMatch | null>;
  findTrackedBillsByKeyword(terms: string[]): Promise<TrackedBillMatch>;
  embeddingSimilarityFloor(hasCapabilitySignal: boolean): number;
  warn(message: string): void;
}
export interface ManualBillPorts {
  fetchBillsByIds(ids: string[]): Promise<BillDetail[]>;
}
export interface BillEnrichmentPorts {
  getTrackedBills(clientId: string, tenantId?: string): Promise<TrackedBillsResult>;
}

export function projectRelevantBill(r: RelevantBillRow): RelevantBill {
  return {
    id: r.id,
    congress: r.congress,
    billType: r.bill_type,
    billNumber: r.bill_number,
    title: r.title,
    introducedDate: r.introduced_date,
    sponsorName: r.sponsor_name,
    sponsorParty: r.sponsor_party,
    sponsorState: r.sponsor_state,
    latestActionText: r.latest_action_text,
    latestActionDate: r.latest_action_date,
    policyArea: r.policy_area,
    subjects: r.subjects ?? [],
  };
}
export function projectBillDetail(b: BillDetailRow): BillDetail {
  return {
    identifier: b.id,
    title: b.title,
    latestActionDate: b.latest_action_date,
    latestActionText: b.latest_action_text,
    status: b.status,
    actionTexts: b.action_texts,
    sponsorName: b.sponsor_name,
    sponsorParty: b.sponsor_party,
    subjectNames: b.subjects ?? [],
  };
}
