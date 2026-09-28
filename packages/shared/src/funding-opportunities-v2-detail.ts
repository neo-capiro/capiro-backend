import type {
  OpportunitySearchRecordV2,
  OpportunitySourceV2,
  OpportunityTypeV2,
} from './funding-opportunities-v2.js';
import type { OpportunityRecordDecorationV2 } from './funding-opportunities-v2-workflow.js';

export type FundingOpportunityV2DatePrecision = 'date' | 'timestamp' | 'raw';

export interface FundingOpportunityV2DateFact {
  value: string | null;
  precision: FundingOpportunityV2DatePrecision | null;
  timezone: string | null;
  sourceRaw: string | null;
  unavailableReason: string | null;
}

export interface FundingOpportunityV2SourceReference {
  source: OpportunitySourceV2;
  recordType: string;
  sourceRecordId: string;
  providerRecordId: string | null;
  sourceUpdatedAt: string | null;
  ingestedAt: string | null;
  sourceUpdatedPrecision: FundingOpportunityV2DatePrecision | null;
  sourceUpdatedRaw: string | null;
}

export interface FundingOpportunityV2DisplayReference {
  label: string;
  value: string;
  sourceField: string;
}

export interface FundingOpportunityV2Fact<T> {
  value: T | null;
  unavailableReason: string | null;
}

export interface FundingOpportunityV2SemanticEvidence {
  kind: string;
  statement: string;
  sourceExcerpt: string | null;
  sourceDocument: string | null;
  sourceField: string | null;
  sourcePage: number | null;
  reviewStatus: 'pending' | 'accepted' | 'rejected' | null;
  supersededAt: string | null;
}

export interface FundingOpportunityV2ScopeContent extends FundingOpportunityV2SemanticEvidence {
  label: string;
}

export interface FundingOpportunityV2Scope {
  agencies: string[];
  geography: string[];
  naicsCodes: string[];
  pscCodes: string[];
  sectors: string[];
  setAside: string | null;
  content: FundingOpportunityV2ScopeContent[];
  unavailableReason: string | null;
}

export interface FundingOpportunityV2ForecastDates {
  anticipatedAwardDate: FundingOpportunityV2DateFact;
  estimatedPeriod: string | null;
  unavailableReason: string | null;
}

export interface FundingOpportunityV2Eligibility {
  applicantTypes: string[];
  restrictions: string[];
  sourceText: string | null;
  clientState: 'eligible' | 'ineligible' | 'needs_review' | 'unknown' | null;
  clientReason: string | null;
  unavailableReason: string | null;
}

export interface FundingOpportunityV2Evaluation {
  criteria: string | null;
  costShare: string[];
  prerequisites: string[];
  awardCategory: string | null;
  unavailableReason: string | null;
}

/** Source-backed response instructions, kept separate from eligibility prerequisites. */
export interface FundingOpportunityV2ResponseInstruction extends FundingOpportunityV2SemanticEvidence {
  label: string;
}

export interface FundingOpportunityV2ResponseInstructions {
  steps: string[];
  details: FundingOpportunityV2ResponseInstruction[];
  unavailableReason: string | null;
}

export type FundingOpportunityV2DestinationKind =
  'source_page' | `document:${string}` | `application:${string}` | `contact_email:${string}`;

export interface FundingOpportunityV2Destination {
  kind: FundingOpportunityV2DestinationKind;
  label: string;
  authoritativeUrl: string;
}

export interface FundingOpportunityV2Document {
  key: string;
  label: string;
  url: string;
  documentType: string | null;
}

export interface FundingOpportunityV2Contact {
  key: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  description: string | null;
}

export interface FundingOpportunityV2ChangeNote {
  key: string;
  text: string;
  occurredAt: string | null;
}

export interface FundingOpportunityV2Provenance {
  sourceModel: string;
  cached: true;
  sourceFacts: Record<string, unknown>;
  unavailableReason: string | null;
}

export interface FundingOpportunityV2SimilarOpportunity {
  source: OpportunitySourceV2;
  sourceRecordId: string;
  title: string;
  agency: string | null;
  sourceUrl: string | null;
  /** Canonical metadata from the search row; absent fields remain unavailable. */
  type?: OpportunityTypeV2 | null;
  deadline?: string | null;
  similarity: 'strong' | 'moderate' | 'weak';
  matchedOn: string[];
}

export interface FundingOpportunityV2Workflow {
  available: boolean;
  status: string | null;
  humanDecision: string | null;
  unavailableReason: string | null;
}

export interface FundingOpportunityV2ActionCapability {
  allowed: boolean;
  reason: string;
}

export interface FundingOpportunityV2ActionCapabilities {
  view: FundingOpportunityV2ActionCapability;
  sourceClick: FundingOpportunityV2ActionCapability;
  pursue: FundingOpportunityV2ActionCapability;
  save: FundingOpportunityV2ActionCapability;
  submit: FundingOpportunityV2ActionCapability;
}

export interface FundingOpportunityV2ActivityEvent extends FundingOpportunityV2SemanticEvidence {
  occurredAt: string | null;
  title: string | null;
  severity: 'critical' | 'significant' | 'informational' | null;
  changedDimensions: string[];
  sourceUrl: string | null;
}

export interface FundingOpportunityV2DetailRecord extends OpportunitySearchRecordV2 {
  decoration: OpportunityRecordDecorationV2;

  sourceReference: FundingOpportunityV2SourceReference;
  displayReference: FundingOpportunityV2DisplayReference | null;
  dates: {
    posted: FundingOpportunityV2DateFact;
    responseDeadline: FundingOpportunityV2DateFact;
    closeOrArchive: FundingOpportunityV2DateFact;
    forecast: FundingOpportunityV2ForecastDates;
  };
  scope: FundingOpportunityV2Scope;
  eligibilityDetail: FundingOpportunityV2Eligibility;
  evaluation: FundingOpportunityV2Evaluation;
  responseInstructions: FundingOpportunityV2ResponseInstructions;
  activity: FundingOpportunityV2ActivityEvent[];
  activityCoverage: string | null;
  destinations: FundingOpportunityV2Destination[];
  documents: FundingOpportunityV2Document[];
  contacts: FundingOpportunityV2Contact[];
  changeNotes: FundingOpportunityV2ChangeNote[];
  provenance: FundingOpportunityV2Provenance;
  similarOpportunities: FundingOpportunityV2SimilarOpportunity[];
  similarOpportunitiesUnavailableReason: string | null;
  workflow: FundingOpportunityV2Workflow;
  capabilities: FundingOpportunityV2ActionCapabilities;
}

export interface FundingOpportunityV2DetailResponse {
  opportunity: FundingOpportunityV2DetailRecord;
  generatedAt: string;
  source: OpportunitySourceV2;
  sourceRecordId: string;
  authoritativeSourceUrl: string | null;
}

export interface FundingOpportunityV2SourceClickResponse {
  audited: true;
  authoritativeUrl: string;
}

export interface FundingOpportunityV2SourceClickRequest {
  source: OpportunitySourceV2;
  sourceRecordId: string;
  clientId: string | null;
  destinationKind: string;
}
