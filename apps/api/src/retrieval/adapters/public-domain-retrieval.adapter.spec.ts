jest.mock('../../program-element/program-element-read.service.js', () => ({
  ProgramElementReadService: class ProgramElementReadService {},
}));
jest.mock('../../funding-opportunities/funding-opportunities.service.js', () => ({
  FundingOpportunitiesService: class FundingOpportunitiesService {},
}));
jest.mock('../../federal-spending/federal-market.service.js', () => ({
  FederalMarketService: class FederalMarketService {},
}));
jest.mock('../../directory/directory.service.js', () => ({
  DirectoryService: class DirectoryService {},
}));
jest.mock('../../prisma/prisma.service.js', () => ({ PrismaService: class PrismaService {} }), {
  virtual: true,
});

import {
  PublicDomainRetrievalAdapter,
  PUBLIC_RETRIEVAL_SERVICE_CONTRACTS,
} from './public-domain-retrieval.adapter.js';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PublicBillReadService } from './public-bill-read.service.js';
import { encodePublicCursor } from './public-domain-retrieval.helpers.js';
import type {
  RetrievalDomain,
  RetrievalRequest,
  SemanticDatasetDescriptor,
} from '../retrieval-v2.types.js';

const sync = '2026-09-06T10:00:00.000Z';
const dataset = (domain: RetrievalDomain) => ({ domain }) as SemanticDatasetDescriptor;
const request = (
  domain: RetrievalDomain,
  overrides: Partial<RetrievalRequest> = {},
): RetrievalRequest => ({
  queryClass: 'lookup',
  requestedDomains: [domain],
  pageSize: 2,
  caller: { tenantId: 'tenant-1', userId: 'user-1' },
  ...overrides,
});

function setup() {
  const pe = {
    listProgramElements: jest.fn().mockResolvedValue({
      data: [
        {
          peCode: '0601102A',
          title: 'Research',
          lastSyncedAt: new Date(sync),
          currentClaim: { fiscalYear: 2027, stage: 'request', value: 15 },
        },
      ],
      total: 1,
    }),
  };
  const funding = {
    listOpportunities: jest.fn().mockImplementation(async (_tenant, query) => ({
      opportunities: [
        {
          id: `${query.source}:1`,
          sourceRecordId: '1',
          sourceUrl: 'https://example.gov/1',
          title: 'Robotics',
          sourceUpdatedAt: sync,
          postedDate: sync,
          eligibility: { state: 'needs_review' },
        },
      ],
      total: 1,
      totalIsCapped: false,
      missingProfileFields: [],
      freshness: [
        {
          source: query.source,
          lastSyncedAt: sync,
          neverSynced: false,
          countsUnavailable: false,
          lastRunDegraded: false,
          enrichment: null,
        },
      ],
    })),
  };
  const awards = {
    listContracts: jest.fn().mockResolvedValue({
      items: [
        {
          id: 'award1',
          actionDate: sync,
          sourceUpdatedAt: sync,
          amount: 123,
        },
      ],
      total: 1,
      asOf: sync,
      source: 'USAspending',
    }),
  };
  const directory = {
    getPeople: jest.fn().mockResolvedValue({
      people: [{ id: 'member-1', fullName: 'Member', personType: 'member' }],
      total: 1,
    }),
  };
  const services = {
    ProgramElementReadService: pe,
    FundingOpportunitiesService: funding,
    FederalMarketService: awards,
    DirectoryService: directory,
  };
  const moduleRef = {
    get: jest.fn((token: { name: keyof typeof services }) => services[token.name]),
  };
  const clientRead = jest.fn().mockResolvedValue([{ id: 'client1' }]);
  const membershipRead = jest.fn().mockResolvedValue({ id: 'membership1' });
  const flagRead = jest.fn().mockResolvedValue([{ ok: 1 }]);
  const prisma = {
    withSystem: jest.fn((fn) => fn({ $queryRaw: flagRead })),
    withTenantUser: jest.fn((_tenant, _user, fn) =>
      fn({
        client: { findMany: clientRead },
        tenantMembership: { findFirst: membershipRead },
      }),
    ),
  };
  const bills = {
    readPage: jest.fn().mockImplementation(async (family) => ({
      records: [
        {
          domain: 'legiwatch_bills',
          recordId: family ? 'state:FL-2026-HB1' : 'federal:119-hr-1',
          payload: { title: 'Robotics' },
        },
      ],
      total: 1,
      lastSyncAt: new Date(sync),
    })),
  };
  const adapter = new PublicDomainRetrievalAdapter(
    prisma as never,
    moduleRef as never,
    bills as never,
  );
  return {
    adapter,
    pe,
    funding,
    awards,
    directory,
    bills,
    prisma,
    clientRead,
    moduleRef,
    flagRead,
    membershipRead,
  };
}

describe('public source retrieval through canonical read services', () => {
  it('resolves the explicit production service class tokens across sibling Nest modules', async () => {
    const { prisma, bills, moduleRef } = setup();
    class DomainReadsModule {}
    Module({
      providers: PUBLIC_RETRIEVAL_SERVICE_CONTRACTS.map(({ token }) => ({
        provide: token, useValue: moduleRef.get(token as never),
      })),
      exports: PUBLIC_RETRIEVAL_SERVICE_CONTRACTS.map(({ token }) => token),
    })(DomainReadsModule);
    class RetrievalReadsModule {}
    Module({
      providers: [PublicDomainRetrievalAdapter, { provide: PrismaService, useValue: prisma }, { provide: PublicBillReadService, useValue: bills }],
      exports: [PublicDomainRetrievalAdapter],
    })(RetrievalReadsModule);
    const application = await Test.createTestingModule({ imports: [DomainReadsModule, RetrievalReadsModule] }).compile();
    try {
      const adapter = application.get(PublicDomainRetrievalAdapter);
      for (const domain of ['program_elements', 'grants', 'federal_awards', 'directory'] as const) {
        expect((await adapter.retrieve(dataset(domain), request(domain))).returned).toBe(1);
      }
    } finally {
      await application.close();
    }
  });

  it('keeps explicit callable provider contracts for all service boundaries', () => {
    const { moduleRef } = setup();
    for (const contract of PUBLIC_RETRIEVAL_SERVICE_CONTRACTS) {
      const service = moduleRef.get(contract.token as never) as unknown as Record<string, unknown>;
      expect(typeof service[contract.method]).toBe('function');
    }
  });

  it.each([
    'program_elements',
    'legiwatch_bills',
    'grants',
    'contracts_opportunities',
    'federal_awards',
    'directory',
  ] as const)('retrieves actual %s records', async (domain) => {
    const { adapter } = setup();
    const result = await adapter.retrieve(dataset(domain), request(domain));
    expect(result.returned).toBe(1);
    expect(result.records[0]?.domain).toBe(domain);
    expect(result.pagesRead).toBe(1);
    expect(result.sourceStatus).not.toBe('unavailable');
  });

  it('preserves canonical funding claims instead of recalculating budget amounts', async () => {
    const { adapter, pe } = setup();
    const result = await adapter.retrieve(dataset('program_elements'), request('program_elements'));
    expect(result.records[0]?.payload.currentClaim).toEqual({
      fiscalYear: 2027,
      stage: 'request',
      value: 15,
    });
    expect(pe.listProgramElements).toHaveBeenCalledWith({
      q: undefined,
      page: 1,
      limit: 2,
    });
  });

  it('walks federal and state bill catalogs with distinct record identity', async () => {
    const { adapter, bills } = setup();
    const input = request('legiwatch_bills', {
      queryClass: 'exhaustive_search',
    });
    const first = await adapter.retrieve(dataset('legiwatch_bills'), input);
    const second = await adapter.retrieve(dataset('legiwatch_bills'), input, first.nextCursor);
    expect(first.hasMore).toBe(true);
    expect(second.records[0]?.recordId).toBe('state:FL-2026-HB1');
    expect(second.coverageComplete).toBe(true);
    expect(bills.readPage.mock.calls.map(([family]) => family)).toEqual([0, 1]);
    expect(first.total).toBeUndefined();
  });

  it('does not report healthy empty results when a public bill source never synced', async () => {
    const { adapter, bills } = setup();
    bills.readPage.mockResolvedValue({
      records: [],
      total: 0,
      lastSyncAt: null,
    });
    const result = await adapter.retrieve(dataset('legiwatch_bills'), request('legiwatch_bills'));
    expect(result.sourceStatus).toBe('unavailable');
    expect(result.coverageComplete).toBe(false);
    expect(result.nextCursor).toBeDefined();
  });

  it('passes source-specific date filters to canonical funding and award services', async () => {
    const { adapter, funding, awards } = setup();
    const dates = {
      windowStart: new Date('2026-09-01T00:00:00Z'),
      windowEnd: new Date('2026-09-07T23:59:59Z'),
    };
    await adapter.retrieve(dataset('grants'), request('grants', dates));
    await adapter.retrieve(dataset('federal_awards'), request('federal_awards', dates));
    expect(funding.listOpportunities.mock.calls[0][1]).toMatchObject({
      deadlineFrom: dates.windowStart.toISOString(),
      deadlineTo: dates.windowEnd.toISOString(),
      source: 'grants_gov',
    });
    expect(awards.listContracts.mock.calls[0][1]).toMatchObject({
      dateFrom: dates.windowStart.toISOString(),
      dateTo: dates.windowEnd.toISOString(),
    });
  });

  it('revalidates walls before retrieving client scoring and preserves eligibility provenance', async () => {
    const { adapter, funding, clientRead } = setup();
    const input = request('contracts_opportunities', {
      caller: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        clientIds: ['client1'],
        authorizedClientIds: ['client1'],
      },
    });
    const result = await adapter.retrieve(dataset('contracts_opportunities'), input);
    expect(clientRead.mock.calls[0][0].where.OR).toEqual([
      { memoryWall: false },
      { memoryAccessGrants: { some: { userId: 'user-1' } } },
    ]);
    expect(funding.listOpportunities.mock.calls[0][1]).toMatchObject({
      source: 'sam_gov',
      clientId: 'client1',
    });
    expect(result.records[0]?.payload.eligibility).toEqual({
      state: 'needs_review',
    });
    expect(result.records[0]?.provenance?.clientScopeApplied).toBe(true);
  });

  it('fails closed for forged authorization and for a revoked client wall', async () => {
    const { adapter, clientRead, funding } = setup();
    const input = request('grants', {
      caller: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        clientIds: ['client1'],
        authorizedClientIds: [],
      },
    });
    expect((await adapter.retrieve(dataset('grants'), input)).sourceStatus).toBe('unauthorized');
    clientRead.mockResolvedValue([]);
    expect(
      (
        await adapter.retrieve(dataset('grants'), {
          ...input,
          caller: { ...input.caller, authorizedClientIds: ['client1'] },
        })
      ).sourceStatus,
    ).toBe('unauthorized');
    expect(funding.listOpportunities).not.toHaveBeenCalled();
  });

  it('walks each explicitly authorized client without pretending the first total covers all clients', async () => {
    const { adapter, clientRead, funding } = setup();
    clientRead.mockResolvedValue([{ id: 'client1' }, { id: 'client2' }]);
    const input = request('grants', {
      queryClass: 'comparison',
      caller: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        clientIds: ['client1', 'client2'],
        authorizedClientIds: ['client1', 'client2'],
      },
    });
    const first = await adapter.retrieve(dataset('grants'), input);
    const second = await adapter.retrieve(dataset('grants'), input, first.nextCursor);
    expect(funding.listOpportunities.mock.calls.map((call) => call[1].clientId)).toEqual([
      'client1',
      'client2',
    ]);
    expect(first.total).toBeUndefined();
    expect(second.hasMore).toBe(false);
    expect(second.searchedEntityCount).toBe(2);
  });

  it.each(['master_off', 'meri_off', 'portal_user', 'flag_error'] as const)(
    'fails closed on %s before opportunity or client reads',
    async (kind) => {
      const { adapter, flagRead, membershipRead, clientRead, funding } = setup();
      if (kind === 'master_off') flagRead.mockResolvedValue([]);
      if (kind === 'meri_off') flagRead.mockResolvedValueOnce([{ ok: 1 }]).mockResolvedValue([]);
      if (kind === 'portal_user') membershipRead.mockResolvedValue(null);
      if (kind === 'flag_error') flagRead.mockRejectedValue(new Error('flags offline'));
      const result = await adapter.retrieve(dataset('grants'), request('grants'));
      expect(result.sourceStatus).toBe(kind === 'flag_error' ? 'unavailable' : 'unauthorized');
      expect(result.coverageComplete).toBe(false);
      expect(funding.listOpportunities).not.toHaveBeenCalled();
      expect(clientRead).not.toHaveBeenCalled();
    },
  );

  it.each(['cap', 'degraded', 'never_synced'] as const)(
    'preserves %s source coverage instead of claiming a complete scan',
    async (kind) => {
      const { adapter, funding } = setup();
      funding.listOpportunities.mockResolvedValue({
        opportunities: [],
        total: 0,
        totalIsCapped: kind === 'cap',
        missingProfileFields: [],
        freshness: [
          {
            source: 'grants_gov',
            lastSyncedAt: kind === 'never_synced' ? null : sync,
            neverSynced: kind === 'never_synced',
            countsUnavailable: false,
            lastRunDegraded: kind === 'degraded',
          },
        ],
      });
      const result = await adapter.retrieve(dataset('grants'), request('grants'));
      expect(result.coverageComplete).toBe(false);
      expect(result.sourceStatus).not.toBe('healthy');
      if (kind === 'cap') expect(result.paginationComplete).toBe(false);
    },
  );

  it('rejects a cursor reused with a different query or tenant', async () => {
    const { adapter, pe } = setup();
    const input = request('program_elements');
    const cursor = encodePublicCursor('program_elements', input, {
      page: 2,
      subject: 0,
      family: 0,
    });
    const result = await adapter.retrieve(
      dataset('program_elements'),
      { ...input, query: 'changed' },
      cursor,
    );
    expect(result.stopReason).toBe('invalid_or_mismatched_cursor');
    expect(pe.listProgramElements).not.toHaveBeenCalled();
  });

  it('returns partial directory scope and unknown freshness explicitly', async () => {
    const { adapter } = setup();
    const result = await adapter.retrieve(dataset('directory'), request('directory'));
    expect(result.coverageComplete).toBe(false);
    expect(result.stopReason).toContain('congressional_people_only');
    expect(result.lastSyncAt).toBeUndefined();
  });

  it('does not silently ignore historical, canonical-entity, or unsupported date filters', async () => {
    const { adapter, pe } = setup();
    for (const override of [
      { asOf: new Date(sync) },
      { canonicalEntityIds: ['entity1'] },
      { windowStart: new Date(sync) },
    ]) {
      const result = await adapter.retrieve(
        dataset('program_elements'),
        request('program_elements', override),
      );
      expect(result.sourceStatus).toBe('unsupported');
    }
    expect(pe.listProgramElements).not.toHaveBeenCalled();
  });

  it('distinguishes missing providers from a complete empty source', async () => {
    const { adapter, moduleRef } = setup();
    moduleRef.get.mockImplementation(() => {
      throw new Error('provider absent');
    });
    const result = await adapter.retrieve(dataset('directory'), request('directory'));
    expect(result.sourceStatus).toBe('unavailable');
    expect(result.stopReason).toBe('domain_provider_not_registered:DirectoryService');
  });
});
