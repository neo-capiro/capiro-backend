import { describe, expect, test } from 'vitest';
import type { OpportunitySearchResponseV2 } from '@capiro/shared';
import type { FundingOpportunityResultRow } from '../../pages/funding-opportunities/FundingOpportunityV2ResultCard.js';
import { createFundingOpportunityV2Api } from '../../pages/funding-opportunities/FundingOpportunitiesV2Adapter.js';
import { opportunityQueryKeys } from '../../pages/funding-opportunities/opportunity-query-cache.js';
import { DEFAULT_V2_CRITERIA } from '../../pages/funding-opportunities/funding-opportunities-v2-state.js';
import {
  createReferenceFixtureApi,
  fundingOpportunitiesV2FixtureUser,
  fundingOpportunitiesV2PreviewTarget,
  referenceFixtureAuditEvents,
  referenceFixtureInventory,
  referenceFixtureMapping,
  resetReferenceFixtureState,
} from './funding-opportunities-v2-fixture-api.js';
import { referenceOpportunityRows, referenceProfileGaps, referenceSavedSearches, referenceSourceHealth } from './funding-opportunities-v2-reference-data.js';

function identityFor(rowId: string) {
  return referenceFixtureMapping.rowIdsByReferenceId[rowId]!;
}

describe('Funding Opportunities v2 visual transport', () => {
  test('preview entry uses the deterministic default only without supplied route state', () => {
    expect(fundingOpportunitiesV2PreviewTarget('')).toContain('client=overland');
    expect(fundingOpportunitiesV2PreviewTarget('?mode=all&client=overland&query=probe')).toBe('/intelligence/opportunities?mode=all&client=overland&query=probe');
  });

  test('maps the six catalog rows to the public pursuit identities without hand-copied records', async () => {
    const api = createReferenceFixtureApi();
    const result = await api.get<OpportunitySearchResponseV2 & { profileGaps?: { actualUnscoredCount: number; items: Array<{ body: string }> } }>('/api/intelligence/opportunities/v2/search?clientId=overland&mode=matched');
    expect(result.data.opportunities).toHaveLength(referenceFixtureInventory.opportunities);
    expect(result.data.opportunities.map((row) => row.title)).toEqual(referenceOpportunityRows.map((row) => row.title));
    expect(result.data.opportunities.map((row) => `${row.source}:${row.sourceRecordId}`)).toContain(`sam_gov:${identityFor('r1')}`);
    expect(result.data.counts).toEqual({ grants: 1284, contracts: 3914, active: 5198, closed: 4 });
    expect(result.data.profileGaps?.actualUnscoredCount).toBe(41);
    expect(result.data.profileGaps?.items.map((item) => item.body)).toEqual(referenceProfileGaps.map((item) => item.text));
    expect(fundingOpportunitiesV2FixtureUser.id).not.toBe(fundingOpportunitiesV2FixtureUser.clerkUserId);
  });

  test('exposes all six independent source health rows, including the not-enabled SBIR row', async () => {
    const api = createReferenceFixtureApi();
    const response = await api.get<{ sources: Array<{ source: string; state: string }>; generatedAt: string }>('/api/intelligence/opportunities/v2/sources');
    expect(response.data.sources).toHaveLength(referenceSourceHealth.length);
    expect(response.data.sources.find((row) => row.source === 'sbir_sttr')).toMatchObject({ state: 'not_enabled' });
    expect(response.data.generatedAt).toBe('2026-09-16T12:00:00.000Z');
  });

  test('keeps saved CRUD stateful and preserves the initial thirteen-card pursuit board', async () => {
    resetReferenceFixtureState();
    const transport = createReferenceFixtureApi();
    const api = createFundingOpportunityV2Api(transport as never);
    const initialBoard = await transport.get<{ cards: unknown[] }>('/api/intelligence/clients/overland/pipeline');
    expect(initialBoard.data.cards).toHaveLength(referenceFixtureInventory.pursuitCards);
    const initialSaved = await api.listSavedSearches('overland');
    expect(initialSaved.searches).toHaveLength(referenceSavedSearches.length);
    expect(initialSaved.searches.find((search) => search.id === 's4')?.clientId).toBeNull();
    expect((await api.listSavedSearches('aperture')).searches.every((search) => search.clientId === null)).toBe(true);
    expect((await api.listSavedSearches(null)).searches.map((search) => search.id)).toEqual(['s4']);

    const saved = await api.saveSearch({ name: 'Harness search', visibility: 'private', clientId: 'overland', criteria: { ...DEFAULT_V2_CRITERIA, clientId: 'overland', query: 'harness identity' } });
    expect(saved.name).toBe('Harness search');
    const afterSave = await api.listSavedSearches('overland');
    expect(afterSave.searches.map((search) => search.id)).toContain(saved.id);
    const applied = await api.applySearch(saved.id);
    expect(applied.criteria.query).toBe('harness identity');

    const rowIdentity = identityFor('r1');
    await api.saveOpportunity({ clientId: 'overland', source: 'sam_gov', sourceRecordId: rowIdentity });
    const search = await api.search({ ...DEFAULT_V2_CRITERIA, clientId: 'overland', mode: 'matched' });
    expect((search.opportunities.find((row) => row.sourceRecordId === rowIdentity) as FundingOpportunityResultRow | undefined)?.decoration?.bookmark.saved).toBe(true);
    const workspaceSearch = await api.search(DEFAULT_V2_CRITERIA);
    expect((workspaceSearch.opportunities.find((row) => row.sourceRecordId === rowIdentity) as FundingOpportunityResultRow | undefined)?.decoration?.bookmark.saved).toBe(false);
    await api.unsaveOpportunity({ clientId: 'overland', source: 'sam_gov', sourceRecordId: rowIdentity });
    const afterUnsave = await api.search({ ...DEFAULT_V2_CRITERIA, clientId: 'overland', mode: 'matched' });
    expect((afterUnsave.opportunities.find((row) => row.sourceRecordId === rowIdentity) as FundingOpportunityResultRow | undefined)?.decoration?.bookmark.saved).toBe(false);
    const otherClient = await api.search({ ...DEFAULT_V2_CRITERIA, clientId: 'aperture', mode: 'matched' });
    expect((otherClient.opportunities.find((row) => row.sourceRecordId === rowIdentity) as FundingOpportunityResultRow | undefined)?.decoration?.bookmark.saved).toBe(false);
    const boardAfterWrites = await transport.get<{ cards: unknown[] }>('/api/intelligence/clients/overland/pipeline');
    expect(boardAfterWrites.data.cards).toHaveLength(referenceFixtureInventory.pursuitCards);
  });

  test('audits only an allowlisted destination and rejects unexpected fixture requests', async () => {
    resetReferenceFixtureState();
    const transport = createReferenceFixtureApi();
    const sourceRecordId = identityFor('r1');
    const detail = await transport.get<{ authoritativeSourceUrl: string }>('/api/intelligence/opportunities/v2/detail/sam_gov/' + encodeURIComponent(sourceRecordId));
    const extra = referenceOpportunityRows[0]!;
    const audited = await transport.post<{ audited: true; authoritativeUrl: string }>('/api/intelligence/opportunities/v2/source-clicks', { source: 'sam_gov', sourceRecordId, destinationKind: 'source_page' });
    expect(detail.data.authoritativeSourceUrl).toBe(extra.href);
    expect(audited.data).toEqual({ audited: true, authoritativeUrl: extra.href });
    expect(referenceFixtureAuditEvents).toHaveLength(1);
    await expect(transport.get('/api/fixture/not-a-real-route')).rejects.toMatchObject({ response: { status: 404 } });
    await expect(transport.post('/api/intelligence/opportunities/v2/source-clicks', { source: 'sam_gov', sourceRecordId, destinationKind: 'wrong' })).rejects.toMatchObject({ response: { status: 404 } });
  });

  test('detail transport keeps matched and all scopes distinct and sends mode', async () => {
    const requests: string[] = [];
    const transport = createReferenceFixtureApi();
    const api = createFundingOpportunityV2Api({
      ...transport,
      get: async <T>(url: string, config?: { signal?: AbortSignal }) => {
        void config;
        requests.push(url);
        return transport.get<T>(url);
      },
    } as never);
    const id = identityFor('r1');
    await api.getDetail('sam_gov', id, 'overland', 'matched');
    await api.getDetail('sam_gov', id, 'overland', 'all');
    expect(requests[0]).toContain('mode=matched');
    expect(requests[1]).toContain('mode=all');
    expect(requests[0]).not.toBe(requests[1]);
    expect(opportunityQueryKeys.detail('sam_gov', id, 'overland', 'matched')).not.toEqual(opportunityQueryKeys.detail('sam_gov', id, 'overland', 'all'));
  });
});


describe('forecast fixture source truth', () => {
  test('keeps quarter period raw and does not invent an exact award date', async () => {
    const api = createReferenceFixtureApi();
    const search = await api.get<OpportunitySearchResponseV2>('/api/intelligence/opportunities/v2/search?clientId=overland&mode=matched');
    const forecast = search.data.opportunities.find((row) => row.source === 'agency_forecast');
    expect(forecast?.deadline).toBeNull();
    expect(forecast?.sourceFacts.anticipatedAwardDate).toBeNull();
    expect(forecast?.sourceFacts.estimatedPeriod).toBe('Q2 FY27');
    const detail = await api.get<import('@capiro/shared').FundingOpportunityV2DetailResponse>(`/api/intelligence/opportunities/v2/detail/agency_forecast/${forecast?.sourceRecordId}?clientId=overland&mode=matched`);
    expect(detail.data.opportunity.dates.forecast.anticipatedAwardDate).toMatchObject({ value: null, sourceRaw: 'Q2 FY27', precision: 'raw' });
    expect(detail.data.opportunity.dates.forecast.estimatedPeriod).toBe('Q2 FY27');
  });
});
