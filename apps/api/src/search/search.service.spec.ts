import { describe, expect, it, jest } from '@jest/globals';
import { SearchService } from './search.service.js';

/**
 * Unit tests for the global keyword SearchService. The prisma client is mocked
 * per-model; we assert the fan-out shape, normalization, min-query guard, and
 * fail-soft behavior (one source throwing must not blank the whole search).
 */

function makePrisma(overrides: Record<string, unknown> = {}) {
  const emptyModel = () => ({ findMany: jest.fn(async () => [] as unknown[]) });
  const base: Record<string, unknown> = {
    congressBill: emptyModel(),
    federalAward: emptyModel(),
    ldaFiling: emptyModel(),
    committeeHearing: emptyModel(),
    secFiling: emptyModel(),
    faraRegistration: emptyModel(),
    gaoReport: emptyModel(),
    crsReport: emptyModel(),
    regulatoryDocket: emptyModel(),
    intelArticle: emptyModel(),
    stateBill: emptyModel(),
    federalRegisterDocument: emptyModel(),
    programElement: emptyModel(),
  };
  return { ...base, ...overrides } as never;
}

describe('SearchService', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns empty for a query shorter than the minimum length', async () => {
    const svc = new SearchService(makePrisma());
    const res = await svc.search('a');
    expect(res.total).toBe(0);
    expect(res.results).toEqual([]);
  });

  it('normalizes bill rows into the uniform result shape', async () => {
    const prisma = makePrisma({
      congressBill: {
        findMany: jest.fn(async () => [
          { id: 'b1', billNumber: 'HR 1234', title: 'Defense Authorization Act', sponsorName: 'Rep. Smith', latestActionDate: new Date('2026-05-01') },
        ]),
      },
    });
    const svc = new SearchService(prisma);
    const res = await svc.search('defense');
    const bill = res.results.find((r) => r.category === 'bill');
    expect(bill).toBeDefined();
    expect(bill!.id).toBe('b1');
    expect(bill!.title).toContain('HR 1234');
    expect(bill!.subtitle).toContain('Rep. Smith');
    expect(bill!.date).toBe('2026-05-01');
    expect(res.byCategory.bill).toBe(1);
  });

  it('aggregates results across multiple sources and counts byCategory', async () => {
    const prisma = makePrisma({
      congressBill: { findMany: jest.fn(async () => [{ id: 'b1', billNumber: 'HR 1', title: 'X', sponsorName: null, latestActionDate: null }]) },
      ldaFiling: { findMany: jest.fn(async () => [{ id: 'l1', clientName: 'Acme', registrantName: 'Firm LLC', dtPosted: new Date('2026-06-15') }]) },
    });
    const svc = new SearchService(prisma);
    const res = await svc.search('acme');
    expect(res.total).toBe(2);
    expect(res.byCategory.bill).toBe(1);
    expect(res.byCategory.lda_filing).toBe(1);
    const lda = res.results.find((r) => r.category === 'lda_filing');
    expect(lda!.title).toBe('Acme');
  });

  it('is fail-soft: one source throwing does not blank the whole search', async () => {
    const prisma = makePrisma({
      congressBill: { findMany: jest.fn(async () => { throw new Error('column renamed'); }) },
      ldaFiling: { findMany: jest.fn(async () => [{ id: 'l1', clientName: 'Acme', registrantName: 'Firm', dtPosted: new Date('2026-06-15') }]) },
    });
    const svc = new SearchService(prisma);
    const res = await svc.search('acme');
    // bill source threw -> 0 bills; lda still returns
    expect(res.byCategory.bill).toBeUndefined();
    expect(res.byCategory.lda_filing).toBe(1);
    expect(res.total).toBe(1);
  });

  it('clamps perSource to the [1,20] take passed to prisma', async () => {
    const findMany = jest.fn(async () => [] as unknown[]);
    const prisma = makePrisma({ congressBill: { findMany } });
    const svc = new SearchService(prisma);
    await svc.search('test', 999);
    const firstCall = findMany.mock.calls[0] as unknown[] | undefined;
    const arg = (firstCall?.[0] ?? {}) as { take?: number };
    expect(arg.take).toBe(20);
  });

  it('normalizes program element rows and excludes them from no other categories', async () => {
    const prisma = makePrisma({
      programElement: {
        findMany: jest.fn(async () => [
          {
            peCode: '0604645A',
            title: 'Ground Robotics',
            service: 'Army',
            budgetActivity: '02',
            budgetActivityName: 'Applied Research',
            lastSyncedAt: new Date('2026-07-01'),
          },
        ]),
      },
    });
    const svc = new SearchService(prisma);
    const res = await svc.search('robotics');
    const pe = res.results.find((r) => r.category === 'program_element');
    expect(pe).toBeDefined();
    expect(pe!.id).toBe('0604645A');
    expect(pe!.title).toContain('0604645A');
    expect(pe!.title).toContain('Ground Robotics');
    expect(pe!.subtitle).toContain('Army');
    expect(pe!.href).toBe('/program-elements/0604645A');
    expect(res.byCategory.program_element).toBe(1);
  });

  it('keeps award output legacy-identical off and labels date meaning under enforce', async () => {
    const award = {
      id: 'a1',
      contractorName: 'Acme',
      awardingAgency: 'Army',
      awardedAt: new Date('2026-02-01'),
      baseAwardSignedDate: new Date('2025-12-01'),
      latestActionDate: new Date('2026-01-15'),
    };
    const prisma = makePrisma({ federalAward: { findMany: jest.fn(async () => [award]) } });
    const svc = new SearchService(prisma);

    process.env = { ...originalEnv };
    const offAward = (await svc.search('acme')).results.find((row) => row.category === 'award');
    expect(offAward).toEqual({
      category: 'award',
      id: 'a1',
      title: 'Acme',
      subtitle: 'Agency: Army',
      date: '2026-02-01',
      href: '/explorer/contractors?q=Acme',
    });

    const tenantId = '17b63099-bc0f-4ac5-b596-496161e9481e';
    process.env = {
      ...originalEnv,
      MERI_EVIDENCE_ACCURACY_MODE: 'enforce',
      MERI_EVIDENCE_ACCURACY_TENANTS: tenantId,
      MERI_EVIDENCE_ACCURACY_SURFACES: 'chat',
    };
    const enforcedAward = (await svc.search('acme', 5, tenantId)).results.find(
      (row) => row.category === 'award',
    );
    expect(enforcedAward).toEqual(
      expect.objectContaining({
        date: '2026-02-01',
        dateSemantics: 'base_award_signed',
        baseAwardSignedDate: '2025-12-01',
      }),
    );
  });
});
