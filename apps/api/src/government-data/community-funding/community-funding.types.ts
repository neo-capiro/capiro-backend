export type Chamber = 'house' | 'senate';
export type RequestType = 'cpf' | 'cds';

export interface ExtractedFundingRow {
  page: number;
  row: number;
  columns: string[];
}

export interface FundingCandidate {
  chamber: Chamber;
  requestType: RequestType;
  fiscalYear: number;
  requesterName: string;
  requesterState: string | null;
  requesterDistrict: string | null;
  recipientName: string;
  recipientAddress: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  projectTitle: string;
  projectDescription: string | null;
  requestedAmountUsd: string;
  finalAmountUsd: string | null;
  amountStageRaw: 'amount_requested' | 'house_amount' | 'senate_recommendation';
  appropriationsAccountRaw: string | null;
  subcommittee: string | null;
  sourcePage: number | null;
  sourceRow: number;
}

export interface ParseRejection { page: number | null; row: number; reason: string }
export interface ParseResult { candidates: FundingCandidate[]; rejected: ParseRejection[]; warnings: string[] }
