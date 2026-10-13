import type { PacCoverage } from './fec-pac-coverage.js';

export type ClientPacGiving = {
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

export type ClientFinancialLobbyingPorts = {
  pickLdaClientIds(cached: number[] | null | undefined, confirmedExternalIds: string[]): number[];
};
export type ClientFinancialMoneyFlowPorts = {
  getPacGiving(clientId: string, tenantId: string): Promise<ClientPacGiving>;
};
export type ClientRoiQuarterInput = {
  mappedLdaClientIds: number[];
  lobbyingYearly: Array<{ year: number; amount: number }>;
  obligationsYearly: Array<{ year: number; amount: number }>;
  now: Date;
};
export type ClientRoiQuarterPoint = { label: string; lobbying: number; obligations: number };
export type ClientPacCommittee = ClientPacGiving['committees'][number];
export type ClientPacGivingRow = {
  committee_id: string;
  committee_name: string | null;
  recipient_name: string | null;
  candidate_name: string | null;
  total_amount: number;
  disbursement_count: number;
};
export type ClientMoneyFlowRow = {
  committee_id: string;
  committee_name: string | null;
  candidate_id: string | null;
  candidate_name: string | null;
  contribution_count: number;
  total_amount: number;
  latest_contribution_date: Date | null;
};
export type ClientMoneyFlowMemberRow = {
  candidate_name: string;
  member_name: string;
  bill_count: number;
};
export type ClientMoneyFlowBillRow = {
  sponsor_name: string;
  bill_id: string;
  bill_title: string;
};
export type ClientMoneyFlowMember = { memberName: string; billCount: number };
export type ClientMoneyFlowBill = { billId: string; billTitle: string; sponsorName: string | null };
export type ClientMoneyFlowCommittee = {
  committeeId: string;
  committeeName: string;
  totalAmount: number;
  contributionCount: number;
  latestContributionDate: Date | null;
  candidates: Array<{
    candidateId: string | null;
    candidateName: string;
    totalAmount: number;
    contributionCount: number;
    linkedMembers: ClientMoneyFlowMember[];
  }>;
};
export type ClientMoneyFlowCommitteeWithBills = ClientMoneyFlowCommittee & {
  bills: ClientMoneyFlowBill[];
};
