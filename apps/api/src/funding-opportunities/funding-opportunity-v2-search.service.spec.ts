import { describe, expect, jest, test } from '@jest/globals';
import {
  normalizeOpportunitySearchCriteria,
  type OpportunitySearchCriteriaV2,
  type OpportunitySourceV2,
} from '@capiro/shared';
import {
  FundingOpportunityV2SearchService,
  type CatalogOpportunityRecord,
  type OpportunityCatalogAdapter,
  type OpportunityClientProfile,
  type OpportunitySearchContext,
} from './funding-opportunity-v2-search.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { readEnabledFundingSources } from './funding-opportunity-source-access.js';
import { FundingOpportunityV2DecoratorService } from './funding-opportunity-v2-decorator.service.js';

jest.mock('./funding-opportunity-source-access.js', () => ({
  readEnabledFundingSources: jest.fn(),
}));

const TENANT = 'tenant-a';
const ACTOR = 'actor-a';
const CLIENT = 'client-a';
const OTHER_TENANT_CLIENT = 'client-other-tenant';

function criteria(input: Record<string, unknown> = {}): OpportunitySearchCriteriaV2 {
  return normalizeOpportunitySearchCriteria({
    mode: 'all',
    lifecycle: ['active', 'forecast', 'closed'],
    page: 1,
    pageSize: 20,
    ...input,
  }).criteria;
}

function record(
  source: OpportunitySourceV2,
  sourceRecordId: string,
  overrides: Partial<CatalogOpportunityRecord> = {},
): CatalogOpportunityRecord {
  return {
    source,
    id: `${source}:${sourceRecordId}`,
    sourceRecordId,
    title: `${source} ${sourceRecordId}`,
    agency: 'Department of Defense',
    sourceUrl: `https://example.invalid/${source}/${sourceRecordId}`,
    type: source === 'grants_gov' || source === 'sbir_sttr' ? 'grant' : 'solicitation',
    lifecycle: 'active',
    postedDate: '2026-09-10T00:00:00.000Z',
    deadline: '2026-10-10T00:00:00.000Z',
    closeOrArchiveDate: '2026-10-20T00:00:00.000Z',
    isPursuable: true,
    summary: 'aircraft propulsion research',
    naicsCodes: ['336411'],
    pscCodes: ['1560'],
    setAside: null,
    applicantTypes: ['Small businesses'],
    geography: ['TX'],
    sectors: ['defense'],
    funding: ['competitive'],
    costShare: ['not_required'],
    methods: ['competitive'],
    disbursement: [],
    grantPrerequisites: [],
    codes: ['336411', '1560'],
    value: null,
    valueBasis: 'not_stated_by_source',
    sourceFacts: { provenance: 'test fixture' },
    relevanceScore: null,
    matchedSignals: [],
    eligibility: null,
    clientId: null,
    internalEligibility: 'unknown',
    internalEligibilityReason: 'The source did not provide a client-specific determination.',
    syncedAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

function adapter(
  source: OpportunitySourceV2,
  records: CatalogOpportunityRecord[],
  options: Partial<OpportunityCatalogAdapter> = {},
): OpportunityCatalogAdapter {
  return {
    source,
    search: async () => ({ records, count: records.length }),
    health: async () => ({
      recordCount: records.length,
      activeRecordCount: records.filter((r) => r.lifecycle === 'active').length,
      lastSyncedAt: '2026-09-15T00:00:00.000Z',
      state: 'current',
    }),
    ...options,
  };
}

function makeService(
  adapters: OpportunityCatalogAdapter[],
  visibleClientIds: string[] = [CLIENT],
  profiles: Record<string, OpportunityClientProfile> = {
    [CLIENT]: { clientId: CLIENT, naicsCodes: ['336411'], pscCodes: ['1560'], agencies: ['Department of Defense'], sectors: ['defense'], applicantTypes: ['Small businesses'] },
  },
  enabledSources: OpportunitySourceV2[] = adapters.map((item) => item.source),
) {
  const profileReader = {
    visibleClientIds: async (_context: OpportunitySearchContext) => visibleClientIds,
    read: async (_context: OpportunitySearchContext, clientId: string) => profiles[clientId] ?? null,
  };
  jest.mocked(readEnabledFundingSources).mockResolvedValue(enabledSources);
  return new FundingOpportunityV2SearchService(
    adapters,
    profileReader,
    {} as PrismaService,
    { decorate: async (records: CatalogOpportunityRecord[]) => records } as unknown as FundingOpportunityV2DecoratorService,
  );
}

const context = { tenantId: TENANT, userId: ACTOR };

describe('FundingOpportunityV2SearchService', () => {
  test('searches the complete multi-source catalog before stable cross-source pagination', async () => {
    const grants = Array.from({ length: 101 }, (_, i) =>
      record('grants_gov', `grant-${String(i).padStart(3, '0')}`, {
        title: `Grant ${String(i).padStart(3, '0')}`,
        deadline: `2026-10-${String((i % 9) + 1).padStart(2, '0')}T00:00:00.000Z`,
      }),
    );
    const sam = record('sam_gov', 'sam-late', { title: 'Late contract', deadline: '2026-09-01T00:00:00.000Z' });
    const service = makeService([adapter('grants_gov', grants), adapter('sam_gov', [sam])]);

    const result = await service.search(context, criteria({ pageSize: 10, sort: 'deadline', direction: 'asc', sources: ['grants_gov', 'sam_gov'] }));

    expect(result.total).toBe(102);
    expect(result.opportunities).toHaveLength(10);
    expect(result.opportunities.map((row) => row.sourceRecordId)).toContain('sam-late');
    expect(result.opportunities.every((row, i, rows) => i === 0 || `${row.deadline}|${row.id}` >= `${rows[i - 1]!.deadline}|${rows[i - 1]!.id}`)).toBe(true);
  });

  test('applies OR within groups and unions all selected lifecycle values', async () => {
    const rows = [
      record('sam_gov', 'active-grant', { lifecycle: 'active', naicsCodes: ['111111'] }),
      record('sam_gov', 'closed-grant', { lifecycle: 'closed', naicsCodes: ['222222'], isPursuable: false }),
      record('sam_gov', 'forecast-grant', { lifecycle: 'forecast', naicsCodes: ['333333'], isPursuable: false }),
      record('sam_gov', 'wrong-grant', { lifecycle: 'active', naicsCodes: ['999999'] }),
    ];
    const service = makeService([adapter('grants_gov', rows, {
      search: async (requested) => ({ records: rows.filter((row) => requested.lifecycle.includes(row.lifecycle) && (!requested.naicsCodes.length || requested.naicsCodes.some((code) => row.naicsCodes.includes(code))) && (!requested.pscCodes.length || requested.pscCodes.some((code) => row.pscCodes.includes(code)))), count: 2 }),
    })]);

    const result = await service.search(context, criteria({
      lifecycle: ['active', 'closed'],
      naicsCodes: ['111111', '222222'],
    }));

    expect(result.opportunities.map((row) => row.sourceRecordId).sort()).toEqual(['active-grant', 'closed-grant']);
  });

  test('keeps client selection independent from all mode and suppresses match output', async () => {
    const service = makeService([adapter('grants_gov', [record('grants_gov', 'g1')])]);

    const result = await service.search(context, criteria({ mode: 'all', clientId: CLIENT }));

    expect(result.clientId).toBe(CLIENT);
    expect(result.mode).toBe('all');
    expect(result.opportunities[0]).toMatchObject({ clientId: CLIENT, relevanceScore: null, matchedSignals: [], eligibility: null });
  });

  test('requires matched client access from the visible-client allow-list, not tenant membership', async () => {
    const service = makeService([adapter('grants_gov', [record('grants_gov', 'g1')])], []);

    await expect(service.search(context, criteria({ mode: 'matched', clientId: CLIENT }))).rejects.toMatchObject({ status: 404 });
  });

  test('does not disclose a client from another tenant in all mode', async () => {
    const service = makeService([adapter('grants_gov', [record('grants_gov', 'g1')])], []);

    await expect(service.search({ tenantId: TENANT, userId: ACTOR }, criteria({ mode: 'all', clientId: OTHER_TENANT_CLIENT }))).rejects.toMatchObject({ status: 404 });
  });

  test('query and structured filters change eligibility, while weak topical evidence stays weak', async () => {
    const weak = record('grants_gov', 'weak', {
      summary: 'aircraft technology support',
      agency: null,
      naicsCodes: [],
      pscCodes: [],
      relevanceScore: 10,
      matchedSignals: [{ signal: 'topical', strength: 'weak', matchedOn: 'aircraft' }],
    });
    const strong = record('sam_gov', 'strong', { naicsCodes: ['336411'], pscCodes: ['1560'], summary: 'unrelated' });
    const service = makeService([
      adapter('grants_gov', [weak]),
      adapter('sam_gov', [strong], {
        search: async (requested) => ({
          records: requested.naicsCodes.length
            ? requested.naicsCodes.includes('336411') ? [strong] : []
            : requested.pscCodes.includes('1560') ? [strong] : [],
          count: requested.naicsCodes.includes('336411') || requested.pscCodes.includes('1560') ? 1 : 0,
        }),
      }),
    ]);

    const matched = await service.search(context, criteria({ mode: 'matched', clientId: CLIENT, query: 'aircraft' }));
    expect(matched.opportunities.find((row) => row.sourceRecordId === 'weak')?.matchedSignals.every((signal) => signal.strength === 'weak')).toBe(true);
    expect(matched.opportunities.find((row) => row.sourceRecordId === 'weak')?.relevanceScore).toBe(10);

    const naicsMatch = await service.search(context, criteria({ mode: 'all', naicsCodes: ['336411'], sources: ['sam_gov'] }));
    expect(naicsMatch.opportunities.map((row) => row.sourceRecordId)).toEqual(['strong']);
    const naicsMismatch = await service.search(context, criteria({ mode: 'all', naicsCodes: ['1560'], sources: ['sam_gov'] }));
    expect(naicsMismatch.opportunities).toHaveLength(0);
    const pscMatch = await service.search(context, criteria({ mode: 'all', pscCodes: ['1560'], sources: ['sam_gov'] }));
    expect(pscMatch.opportunities.map((row) => row.sourceRecordId)).toEqual(['strong']);
  });

  test('returns partial source failures with honest null totals and errors when every source fails', async () => {
    const failed = new Error('sam database unavailable');
    const partial = makeService([
      adapter('grants_gov', [record('grants_gov', 'g1')]),
      adapter('sam_gov', [], { search: async () => { throw failed; }, health: async () => { throw failed; } }),
    ]);
    const partialResult = await partial.search(context, criteria());
    expect(partialResult.opportunities.map((row) => row.sourceRecordId)).toEqual(['g1']);
    expect(partialResult.total).toBeNull();
    expect(partialResult.provenance.find((p) => p.source === 'sam_gov')).toMatchObject({ queried: false, count: null });

    const allFailed = makeService([
      adapter('grants_gov', [], { search: async () => { throw failed; }, health: async () => { throw failed; } }),
      adapter('sam_gov', [], { search: async () => { throw failed; }, health: async () => { throw failed; } }),
    ]);
    await expect(allFailed.search(context, criteria())).rejects.toMatchObject({ status: 503 });
  });

  test('does not query a tenant-disabled source and keeps enabled-source totals exact', async () => {
    const disabledSearch = jest.fn(async () => ({ records: [record('sam_gov', 'disabled')], count: 1 }));
    const disabledHealth = jest.fn(async () => ({ recordCount: 1, activeRecordCount: 1, lastSyncedAt: null, state: 'current' as const }));
    const service = makeService([
      adapter('grants_gov', [record('grants_gov', 'enabled')]),
      adapter('sam_gov', [], { search: disabledSearch, health: disabledHealth }),
    ], [CLIENT], undefined, ['grants_gov']);

    const result = await service.search(context, criteria({ sources: ['grants_gov', 'sam_gov'] }));

    expect(disabledSearch).not.toHaveBeenCalled();
    expect(disabledHealth).not.toHaveBeenCalled();
    expect(result.total).toBe(1);
    expect(result.catalogComplete).toBe(true);
    expect(result.freshness.find((item) => item.source === 'sam_gov')).toMatchObject({ state: 'not_enabled' });
    expect(result.provenance.find((item) => item.source === 'sam_gov')).toMatchObject({ queried: false, count: null });
  });

  test('reports source health from adapters instead of calling a successful query current', async () => {
    const service = makeService([adapter('grants_gov', [record('grants_gov', 'g1')], {
      health: async () => ({ recordCount: 1, activeRecordCount: 1, lastSyncedAt: '2026-01-01T00:00:00.000Z', state: 'stale' }),
    })]);
    const result = await service.search(context, criteria({ sources: ['grants_gov'] }));
    expect(result.freshness).toEqual([expect.objectContaining({ source: 'grants_gov', state: 'stale', lastSyncedAt: '2026-01-01T00:00:00.000Z' })]);
  });

  test('preserves a comma in query text and accepts current singular URL aliases', async () => {
    const service = makeService([adapter('grants_gov', [record('grants_gov', 'comma', { summary: 'radar, antenna', grantPrerequisites: ['registration'] })], {
      search: async (requested) => ({ records: requested.grantPrerequisites.length ? [record('grants_gov', 'comma', { summary: 'radar, antenna', grantPrerequisites: ['registration'] })] : [], count: requested.grantPrerequisites.length ? 1 : 0 }),
    })]);
    const { normalizeOpportunitySearchQuery } = await import('./funding-opportunity-v2-search.service.js');
    const parsed = normalizeOpportunitySearchQuery({ query: 'radar, antenna', sector: 'defense', grantPrerequisite: 'registration' });
    expect(parsed.query).toBe('radar, antenna');
    expect(parsed.sectors).toEqual(['defense']);
    expect(parsed.grantPrerequisites).toEqual(['registration']);
    const multi = normalizeOpportunitySearchQuery({ keyword: ['Robot', 'battery storage', 'robot'] });
    expect(multi.keywordTerms).toEqual(['Robot', 'battery storage']);
    const parsedMany = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [String(i), `term-${i}`]));
    expect(normalizeOpportunitySearchQuery({ keyword: parsedMany }).keywordTerms).toHaveLength(100);
    expect(() => normalizeOpportunitySearchQuery({ keyword: { ...parsedMany, 100: 'too-many' } })).toThrow();
    expect(() => normalizeOpportunitySearchQuery({ keyword: { 0: 'valid', unexpected: 'invalid' } })).toThrow();
    const result = await service.search(context, parsed);
    expect(result.opportunities).toHaveLength(1);

    const missingPrerequisite = makeService([adapter('grants_gov', [record('grants_gov', 'missing', { summary: 'radar, antenna' })], {
      search: async () => ({ records: [], count: 0 }),
    })]);
    const missingResult = await missingPrerequisite.search(context, parsed);
    expect(missingResult.opportunities).toHaveLength(0);
  });
});
