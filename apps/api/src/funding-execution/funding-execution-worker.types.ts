import type { FundingExecutionFact } from '../program-element/funding-execution/funding-execution-read.service.js';

export interface FundingExecutionCheckpoint {
  version: 1;
  cursor: string | null;
  throughId: string | null;
  complete: boolean;
}

export interface FundingExecutionWorkerPage {
  rows: FundingExecutionFact[];
  throughId: string | null;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface CertifiedFundingExecutionPublication {
  factId: string;
  authorityState: 'enacted';
  accountId: string;
  amountUsd: string;
  certification: 'certified';
  verification: 'verified';
  exactAccountLevel: true;
  sourceNativeIds: string[];
}

/** Narrow, idempotent persistence capability used by the bounded worker. */
export interface FundingExecutionPublicationPort {
  loadCheckpoint(): Promise<FundingExecutionCheckpoint | null>;
  readBoundedPage(input: {
    cursor: string | null;
    throughId: string | null;
    take: number;
  }): Promise<FundingExecutionWorkerPage>;
  publishCertified(
    rows: readonly CertifiedFundingExecutionPublication[],
  ): Promise<{ published: number }>;
  saveCheckpoint(checkpoint: FundingExecutionCheckpoint): Promise<void>;
}
