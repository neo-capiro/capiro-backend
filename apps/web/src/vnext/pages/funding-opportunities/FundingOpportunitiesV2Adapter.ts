import type { AxiosInstance } from 'axios';
import type {
  OpportunitySearchCriteriaV2,
  OpportunitySearchResponseV2,
  OpportunitySourceV2,
  SavedSearchSummaryV2,
  FundingOpportunityV2DetailResponse,
  FundingOpportunityV2SourceClickResponse,
} from '@capiro/shared';
import { criteriaToApiParams } from './funding-opportunities-v2-state.js';

export function v2SearchPath(criteria: OpportunitySearchCriteriaV2): string {
  return `/api/intelligence/opportunities/v2/search?${criteriaToApiParams(criteria).toString()}`;
}
export function v2SearchesPath(clientId: string | null): string {
  return `/api/intelligence/opportunities/v2/searches${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`;
}
export type SavedSearchRecordV2 = SavedSearchSummaryV2 & {
  isTenantWide?: boolean;
  ownerId?: string;
  createdAt?: string;
  createdByUserId?: string;
  clientName?: string | null;
  lastAppliedAt?: string | null;
  lastRunResultCount?: number | null;
  originalCriteriaJson?: unknown;
  alerts?: { enabled: boolean; cadence: string | null; channels: string[]; deadlineThreshold: number | null; newVsChanged: boolean };
};
export type SavedSearchInput = { name: string; description?: string; visibility: 'private' | 'tenant'; clientId: string | null; criteria: OpportunitySearchCriteriaV2 };
export type SavedSearchPatch = Partial<Pick<SavedSearchInput, 'name' | 'description' | 'visibility' | 'clientId' | 'criteria'>> & { archived?: boolean };
export type SavedSearchListResponse = { searches: SavedSearchRecordV2[] };
export type SavedSearchApplyResponse = OpportunitySearchResponseV2 & { search: SavedSearchRecordV2; criteria: OpportunitySearchCriteriaV2 };
export type { FundingOpportunityV2DetailResponse, FundingOpportunityV2SourceClickResponse } from '@capiro/shared';
export type FundingOpportunityV2SourceHealthResponse = { sources: Array<OpportunitySearchResponseV2['freshness'][number]>; generatedAt: string };
export interface FundingOpportunityV2Api {
  search(criteria: OpportunitySearchCriteriaV2, signal?: AbortSignal): Promise<OpportunitySearchResponseV2>;
  sourceHealth(): Promise<FundingOpportunityV2SourceHealthResponse>;
  saveOpportunity(input: { clientId: string | null; source: OpportunitySourceV2; sourceRecordId: string }): Promise<unknown>;
  unsaveOpportunity(input: { clientId: string | null; source: OpportunitySourceV2; sourceRecordId: string }): Promise<unknown>;
  listSavedSearches(clientId: string | null): Promise<SavedSearchListResponse>;
  getSavedSearch(id: string): Promise<SavedSearchRecordV2>;
  saveSearch(input: SavedSearchInput): Promise<SavedSearchRecordV2>;
  updateSearch(id: string, input: SavedSearchPatch): Promise<SavedSearchRecordV2>;
  deleteSearch(id: string): Promise<{ deleted: boolean; id: string }>;
  duplicateSearch(id: string, name?: string): Promise<SavedSearchRecordV2>;
  applySearch(id: string): Promise<SavedSearchApplyResponse>;
  recordNotFit(input: { clientId: string; source: OpportunitySourceV2; sourceRecordId: string; reason: string; note: string | null }): Promise<unknown>;
  getDetail(source: OpportunitySourceV2, sourceRecordId: string, clientId: string | null, mode?: 'matched' | 'all', signal?: AbortSignal): Promise<FundingOpportunityV2DetailResponse>;
  auditSourceClick(input: { source: OpportunitySourceV2; sourceRecordId: string; clientId: string | null; destinationKind: string }): Promise<FundingOpportunityV2SourceClickResponse>;
  patchWorkflow(input: { clientId: string; source: OpportunitySourceV2; sourceRecordId: string; patch: { ownerUserId?: string | null; notes?: string | null; nextAction?: string | null; nextActionDueAt?: string | null } }): Promise<unknown>;
}
export function createFundingOpportunityV2Api(api: Pick<AxiosInstance, 'get' | 'post' | 'patch' | 'delete'>): FundingOpportunityV2Api {
  return {
    async search(criteria, signal) { return (await api.get<OpportunitySearchResponseV2>(v2SearchPath(criteria), { signal })).data; },
    async sourceHealth() { return (await api.get<FundingOpportunityV2SourceHealthResponse>('/api/intelligence/opportunities/v2/sources')).data; },
    async saveOpportunity(input) {
      const prefix = input.clientId ? `/api/intelligence/clients/${encodeURIComponent(input.clientId)}` : '/api/intelligence';
      return (await api.post(`${prefix}/opportunities/${input.source}/${encodeURIComponent(input.sourceRecordId)}/save`, { status: 'saved' })).data;
    },
    async unsaveOpportunity(input) {
      const prefix = input.clientId ? `/api/intelligence/clients/${encodeURIComponent(input.clientId)}` : '/api/intelligence';
      return (await api.delete(`${prefix}/opportunities/${input.source}/${encodeURIComponent(input.sourceRecordId)}/save`)).data;
    },
    async listSavedSearches(clientId) { return (await api.get<{ searches: SavedSearchRecordV2[] }>(v2SearchesPath(clientId))).data; },
    async getSavedSearch(id) { return (await api.get<SavedSearchRecordV2>(`/api/intelligence/opportunities/v2/searches/${encodeURIComponent(id)}`)).data; },
    async saveSearch(input) { return (await api.post<SavedSearchRecordV2>('/api/intelligence/opportunities/v2/searches', input)).data; },
    async updateSearch(id, input) { return (await api.patch<SavedSearchRecordV2>(`/api/intelligence/opportunities/v2/searches/${encodeURIComponent(id)}`, input)).data; },
    async deleteSearch(id) { return (await api.delete<{ deleted: boolean; id: string }>(`/api/intelligence/opportunities/v2/searches/${encodeURIComponent(id)}`)).data; },
    async duplicateSearch(id, name) { return (await api.post<SavedSearchRecordV2>(`/api/intelligence/opportunities/v2/searches/${encodeURIComponent(id)}/duplicate`, name ? { name } : {})).data; },
    async applySearch(id) { return (await api.post<OpportunitySearchResponseV2 & { search: SavedSearchRecordV2; criteria: OpportunitySearchCriteriaV2 }>(`/api/intelligence/opportunities/v2/searches/${encodeURIComponent(id)}/apply`)).data; },
    async getDetail(source, sourceRecordId, clientId, mode = 'all', signal) {
      const params = new URLSearchParams({ mode });
      if (clientId) params.set('clientId', clientId);
      return (await api.get<FundingOpportunityV2DetailResponse>(`/api/intelligence/opportunities/v2/detail/${encodeURIComponent(source)}/${encodeURIComponent(sourceRecordId)}?${params.toString()}`, { signal })).data;
    },
    async auditSourceClick(input) { return (await api.post<FundingOpportunityV2SourceClickResponse>('/api/intelligence/opportunities/v2/source-clicks', input)).data; },
    async patchWorkflow(input) { return (await api.patch(`/api/intelligence/clients/${encodeURIComponent(input.clientId)}/opportunities/${input.source}/${encodeURIComponent(input.sourceRecordId)}`, input.patch)).data; },
    async recordNotFit(input) {
      const { clientId, source, sourceRecordId, reason, note } = input;
      return (await api.post(`/api/intelligence/clients/${encodeURIComponent(clientId)}/opportunities/${source}/${encodeURIComponent(sourceRecordId)}/not-fit`, { reason, note })).data;
    },
  };
}
