import type {
  SourceBillAction,
  SourceBillIdentity,
  SourceBillVote,
  SourceFundingPosition,
  SourceGoverningRule,
  SourceParentPackage,
  SourceBillProvision,
} from '../../../src/sourcedata/source-data.repository.js';
import type {
  SourceStateBill,
  SourceStateVote,
} from '../../../src/sourcedata/state-source-data.repository.js';
import type {
  BillDossierResponse,
  BillKpi,
  BillKpiId,
} from '../../../src/bill-dossier/bill-dossier.types.js';

export const billId = '119-hr-2000';
export const stateId = 'fl-2026-hb100';
export const tenantId = 'tenant-one';
export const clientId = '00000000-0000-0000-0000-000000000010';
export const now = new Date('2026-10-13T12:00:00.000Z');
export const day = 86_400_000;
export function identity(over: Partial<SourceBillIdentity> = {}): SourceBillIdentity {
  return {
    id: billId,
    congress: 119,
    billType: 'hr',
    billNumber: '2000',
    title: 'Official bill',
    originChamber: 'House',
    sponsorName: null,
    introducedDate: now,
    status: 'introduced',
    statusAt: now,
    latestActionText: null,
    latestActionDate: null,
    policyArea: null,
    url: null,
    lastSyncedAt: now,
    updateDate: now,
    updateDateIncludingText: now,
    ...over,
  };
}
export function stateBill(over: Partial<SourceStateBill> = {}): SourceStateBill {
  return {
    id: stateId,
    state: 'FL',
    sessionKey: '2026',
    session: '2026 Regular Session',
    identifier: 'HB 100',
    title: 'State measure',
    status: 'in_committee',
    statusAt: now,
    latestActionText: null,
    latestActionDate: null,
    textDate: null,
    sponsorName: null,
    sponsorParty: null,
    sponsorCount: 0,
    stateUrl: null,
    url: null,
    subjects: [],
    committees: [],
    ...over,
  };
}
export function action(over: Partial<SourceBillAction> = {}): SourceBillAction {
  return {
    id: 'action-one',
    billId,
    date: now,
    text: 'Introduced in House.',
    type: 'IntroReferral',
    chamber: 'House',
    ...over,
  };
}
export function vote(over: Partial<SourceBillVote> = {}): SourceBillVote {
  return {
    id: 'vote-one',
    chamber: 'house',
    billId,
    question: 'On Passage',
    result: 'Passed',
    voteType: null,
    voteDate: now,
    yeas: 230,
    nays: 200,
    present: 1,
    notVoting: 4,
    sourceUrl: null,
    ...over,
  };
}
export function stateVote(over: Partial<SourceStateVote> = {}): SourceStateVote {
  return {
    id: 'state-vote-one',
    billKey: stateId,
    chamber: 'lower',
    motion: 'On Passage',
    yeas: 70,
    nays: 30,
    passed: true,
    date: now,
    sourceUrl: null,
    lastSyncedAt: now,
    ...over,
  };
}
export function rule(over: Partial<SourceGoverningRule> = {}): SourceGoverningRule {
  return {
    ruleBillId: '119-hres-1',
    targetBillId: billId,
    voteId: 'rule-vote',
    chamber: 'house',
    rollNumber: 1,
    result: 'Failed',
    yeas: 100,
    nays: 200,
    question: 'On agreeing to the rule',
    sourceUrl: null,
    voteDate: now,
    ...over,
  };
}
export function position(over: Partial<SourceFundingPosition> = {}): SourceFundingPosition {
  return {
    id: 'position-one',
    packageId: 'package-one',
    packageName: 'FY27 Defense',
    domain: 'defense',
    vehicleId: 'vehicle-one',
    vehicleLabel: 'House appropriations',
    vehicleTrack: 'appropriation',
    vehicleStatus: 'passed',
    fiscalYear: 2027,
    vehicleClass: 'appropriation',
    stage: 'house',
    scope: 'defense_total',
    amountMillions: '120.00',
    effectiveDate: now,
    sourceUrl: 'https://example.invalid/report',
    sourcePage: 2,
    sourceDocumentTitle: 'House report',
    sourceDocumentKey: 'report-one',
    sourceDocumentSha256: 'a'.repeat(64),
    sourceDocumentCurrent: true,
    note: null,
    verificationStatus: 'reviewed',
    ...over,
  };
}
export function parentPackage(over: Partial<SourceParentPackage> = {}): SourceParentPackage {
  return {
    packageId: 'package-one',
    domain: 'defense',
    fiscalYear: 2027,
    name: 'FY27 Defense',
    status: 'open',
    vehicleId: 'vehicle-one',
    vehicleLabel: 'House appropriations',
    vehicleTrack: 'appropriation',
    vehicleStage: 'house',
    vehicleStatus: 'passed',
    vehicleChamber: 'house',
    sourceDocumentTitle: 'House report',
    sourceDocumentKey: 'report-one',
    sourceDocumentSha256: 'a'.repeat(64),
    sourceDocumentUrl: 'https://example.invalid/report',
    sourceDocumentCurrent: true,
    ...over,
  };
}
export function provision(over: Partial<SourceBillProvision> = {}): SourceBillProvision {
  return {
    provisionId: 'provision-one',
    committee: 'HAC',
    fy: 2027,
    heading: 'Official change',
    text: 'Adds funding',
    pageStart: 1,
    pageEnd: 1,
    actionType: 'adds',
    peCode: null,
    matchBasis: null,
    confidence: 1,
    reviewStatus: 'accepted',
    billLinkStatus: 'accepted',
    ...over,
  };
}
export interface TrackingRow {
  position: string | null;
  priority: string | null;
  analystNote: string | null;
  note: string | null;
  stage: string | null;
  trackedAt: Date | null;
  expectedMilestoneType: string | null;
  expectedWindowStart: Date | null;
  expectedWindowEnd: Date | null;
  expectedRationale: string | null;
  expectedConfidence: string | null;
  expectedUpdatedBy: string | null;
  expectedUpdatedAt: Date | null;
}
export function tracking(over: Partial<TrackingRow> = {}): TrackingRow {
  return {
    position: null,
    priority: null,
    analystNote: null,
    note: null,
    stage: null,
    trackedAt: now,
    expectedMilestoneType: null,
    expectedWindowStart: null,
    expectedWindowEnd: null,
    expectedRationale: null,
    expectedConfidence: null,
    expectedUpdatedBy: null,
    expectedUpdatedAt: null,
    ...over,
  };
}
export interface AlertRow {
  id: string;
  severity: string | null;
  createdAt: Date;
  title: string;
  whyItMatters: string | null;
  recommendedAction: string | null;
}
export function alert(over: Partial<AlertRow> = {}): AlertRow {
  return {
    id: 'alert-one',
    severity: 'notable',
    createdAt: now,
    title: 'Official alert',
    whyItMatters: null,
    recommendedAction: null,
    ...over,
  };
}
export function kpi(response: BillDossierResponse, id: BillKpiId): BillKpi {
  const value = response.kpis.find((row) => row.id === id);
  if (!value) throw new Error(`Missing real KPI ${id}`);
  return value;
}
