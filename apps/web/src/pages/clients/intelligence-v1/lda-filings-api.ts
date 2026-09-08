import type { AxiosInstance } from 'axios';

/**
 * Web API for a client's LDA lobbying-disclosure filings.
 *
 * Mirrors apps/api/src/intelligence/intelligence.controller.ts
 * (GET /api/intelligence/clients/:clientId/lda-filings). Powers the Financial
 * Footprint section, which now lists the client's LDA filings in detail rather
 * than the old ROI / FEC / district-nexus panels.
 */

export interface LdaFilingRow {
  filingUuid: string;
  registrantId?: number | null;
  ldaClientId?: number | null;
  filingType: string;
  filingYear: number;
  filingPeriod: string | null;
  income: number;
  expenses: number;
  /** Headline figure to show per row (income, else expenses). */
  amount: number;
  postedAt: string | null;
  registrantName: string;
  clientName: string;
  issueCodes: string[];
  governmentEntities: string[];
  lobbyists: string[];
  documentUrl: string | null;
}

export interface ClientLdaFilings {
  truncated?: boolean;
  matched: boolean;
  ldaClientIds: number[];
  totalFilings: number;
  totalIncome: number;
  totalExpenses: number;
  firstFilingYear: number | null;
  latestFilingYear: number | null;
  registrants: Array<{ name: string; filings: number; income: number }>;
  byYear: Array<{ year: number; income: number; expenses: number; filings: number }>;
  filings: LdaFilingRow[];
}

export async function getClientLdaFilings(
  api: AxiosInstance,
  clientId: string,
): Promise<ClientLdaFilings> {
  return (
    await api.get<ClientLdaFilings>(
      `/api/intelligence/clients/${encodeURIComponent(clientId)}/lda-filings`,
    )
  ).data;
}
