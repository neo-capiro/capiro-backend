import type { ClientIntelMapping, LdaFiling, Prisma } from '@prisma/client';
import type { RelevantBillsResult } from './intelligence-bill-discovery.shared.js';

export type ClientIdentityCrmClient = Prisma.ClientGetPayload<{ include: { capabilities: true } }>;
export type ClientIdentityMapping = ClientIntelMapping;
export type ClientIdentityCapability = { name: string; sector: string | null; tags: string[] };
export type ClientIdentityLda = {
  matched: boolean;
  ldaClientId: number;
  ldaClientIds: number[];
  confidence: number;
  totalFilings: number;
  totalSpending: number | null;
  issueCodes: string[];
  recentFilings: LdaFiling[];
  yearlySpend: Array<{ year: number; amount: number }>;
};
export type ClientIdentityContractor = {
  matched: boolean;
  contractorName: string;
  totalContracts: number | null;
  rankByContracts: number | null;
  noBidTotal: number | null;
  topAgencies: Array<{ name: string; amount: number }>;
  yearlySpend: Array<{ year: number; amount: number }>;
};
export type ClientIdentityLobbyIntel = {
  matched: boolean;
  trajectory: string | null;
  growthRate: number | null;
  totalSpending: number | null;
};
export type ClientIdentityCompetitors = {
  topBySpend: Array<{ name: string; totalSpending: number; sharedIssues: string[] }>;
  newEntrants: Array<{ name: string; firstFilingDate: string; issues: string[] }>;
};
export type ClientIdentityRegulations = {
  total: number;
  documents: Array<{
    id: string;
    documentNumber: string;
    type: string;
    title: string;
    agencyNames: string[];
    topics: string[];
    commentEndDate: Date | null;
    publicationDate: Date;
    significantRule: boolean;
    htmlUrl: string | null;
  }>;
};
export type ClientIdentityProfilePorts = {
  pickLdaClientIds(cached: number[] | null | undefined, confirmedExternalIds: string[]): number[];
  fetchLdaByIds(ids: number[]): Promise<ClientIdentityLda | null>;
  fuzzyMatchLda(name: string): Promise<ClientIdentityLda | null>;
  fetchContractorById(id: string): Promise<ClientIdentityContractor | null>;
  fuzzyMatchContractor(name: string): Promise<ClientIdentityContractor | null>;
  fetchLobbyIntelById(id: string): Promise<ClientIdentityLobbyIntel | null>;
  fuzzyMatchLobbyIntel(name: string): Promise<ClientIdentityLobbyIntel | null>;
  capabilityFallbackTerms(tenantId: string, clientId: string): Promise<string[]>;
  findRelevantBills(issueCodes: string[], fallbackTerms: string[]): Promise<RelevantBillsResult>;
  findActiveRegulations(
    issueCodes: string[],
    fallbackTerms: string[],
  ): Promise<ClientIdentityRegulations>;
  findCompetitors(
    name: string,
    issueCodes: string[],
    ids: number[],
  ): Promise<ClientIdentityCompetitors>;
};
export type ClientIdentityLdaPorts = {
  pickLdaClientIds(cached: number[] | null | undefined, confirmedExternalIds: string[]): number[];
};
export type ClientIdentityFilingsPorts = {
  resolveLdaClientIds(clientId: string, tenantId: string): Promise<number[]>;
};
export type ClientIdentityCatalogPorts = {
  isUuid(id: string): boolean;
};
export type ClientIdentityFilingRow = Pick<
  LdaFiling,
  | 'filingUuid'
  | 'registrantId'
  | 'clientId'
  | 'filingType'
  | 'filingYear'
  | 'filingPeriod'
  | 'income'
  | 'expenses'
  | 'dtPosted'
  | 'registrantName'
  | 'clientName'
  | 'issueCodes'
  | 'governmentEntities'
  | 'lobbyists'
  | 'lobbyingActivities'
  | 'filingDocumentUrl'
>;
