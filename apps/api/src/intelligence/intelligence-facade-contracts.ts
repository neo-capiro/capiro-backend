import type { PacCoverage } from './fec-pac-coverage.js';

export type ProfileV1Sections = {
  snapshot: Record<string, any>;
  financialFootprint: Record<string, any>;
  legislativeRegulatory: Record<string, any>;
  relationships: Record<string, any>;
};

export type RelevantBillsResult = {
  total: number;
  bills: Array<{
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
  }>;
};

export type ManualMappingInput = {
  source: string;
  externalId: string;
  externalName: string;
  relationshipType?: string | null;
  rollUpAwards?: boolean | null;
  actorUserId: string;
};

export type MappingRejectionInput = {
  source: 'contracting';
  externalId: string;
  externalName: string;
  reason: string | null;
  actorUserId: string;
};

export type MappingConfirmationInput = {
  confirmed: boolean;
  relationshipType?: string;
  rollUpAwards?: boolean;
  rejectionReason?: string;
  actorUserId: string;
};

export type PacGiving = {
  tracked: boolean;
  coverage: PacCoverage;
  committees: Array<{
    committeeId: string;
    committeeName: string | null;
    totalAmount: number;
    disbursementCount: number;
    recipients: Array<{
      recipientName: string;
      candidateName: string | null;
      totalAmount: number;
    }>;
  }>;
  summary: { totalAmount: number; disbursementCount: number; recipientCount: number };
};

export type ClientRelevanceTerms = {
  issueCodes: string[];
  issueNames: string[];
  keywordTermsExpanded: string[];
  embeddingPartsClean: string[];
  hasCapabilitySignal: boolean;
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

export type TrackedBillMatch = {
  total: number;
  bills: Array<{
    identifier: string;
    title: string;
    latestActionDate: Date | null;
    latestActionText: string | null;
    status?: string | null;
    actionTexts?: string[];
    sponsorName: string | null;
    sponsorParty: string | null;
    subjectNames: string[];
  }>;
};

export type ClientBriefInput = {
  title: string;
  body: string;
  sourceAlertId?: string | null;
  sourceType?: string | null;
};

export type KnowledgeGraphOptions = {
  viewerUserId?: string | null;
  envIntelGraphOn?: boolean;
  envTraversalSource?: 'legacy' | 'cache';
};

export type RelevantRegulation = {
  documentNumber: string;
  type: string;
  title: string;
  agencyNames: string[];
  publicationDate: Date;
  commentEndDate: Date | null;
  effectiveDate: Date | null;
  htmlUrl: string | null;
};

export type PortfolioWindow = { from?: string; to?: string };

export type PortfolioAlertsResult = {
  alerts: Array<Record<string, unknown> & { clientId: string; clientName: string }>;
  total: number;
  clientCount: number;
  generatedAt: string;
};

export type PortfolioAlertsOptions = { limit?: number; maxClients?: number };

export type PortfolioRollup = {
  rollup: Record<
    string,
    {
      attentionCount: number;
      intelCount: number;
      nextTouch: { id: string; startsAt: string; subject: string } | null;
      /** Item 5: count of in_progress engagement tasks (work/readiness signal). */
      workCount: number;
    }
  >;
};

export type PortfolioPeSummary = {
  netDeltaPct: number | null;
  peAttribution: Record<string, string[]>;
  watchedCount: number;
};

export type RoiQuarterInput = {
  mappedLdaClientIds: number[];
  lobbyingYearly: Array<{ year: number; amount: number }>;
  obligationsYearly: Array<{ year: number; amount: number }>;
  now: Date;
};

export type RoiQuarterPoint = {
  label: string;
  lobbying: number;
  obligations: number;
};
