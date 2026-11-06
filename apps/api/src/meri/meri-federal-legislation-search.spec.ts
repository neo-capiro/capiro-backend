import { MeriFederalLegislationTools } from './meri-federal-legislation-tools.js';

type Fake = Record<string, unknown>;

function svc(prisma: Fake): MeriFederalLegislationTools {
  const s = Object.create(MeriFederalLegislationTools.prototype) as MeriFederalLegislationTools;
  (s as unknown as { prisma: Fake }).prisma = prisma;
  (s as unknown as { ldaIntel: Fake }).ldaIntel = { getCongressBills: prisma.getCongressBills ?? (async () => ({ data: [], total: 0, page: 1, limit: 20 })) };
  return s;
}

const call = (s: MeriFederalLegislationTools, input: Fake) => s.searchCongressBills(input);

describe('search_congress_bills exact bill identity fix', () => {
  test.each(['S. 999999', '119-s-999999', '119 S999999', '119S999999'])('looks up the full absent bill identity before reporting no result: %s', async query => {
    const direct=jest.fn(async()=>null), topic=jest.fn();
    const out=await call(svc({congressBill:{findUnique:direct},getCongressBills:topic}),{query,congress:119});
    expect(direct).toHaveBeenCalledTimes(1);
    expect(direct).toHaveBeenCalledWith({where:{id:'119-s-999999'}});
    expect(topic).not.toHaveBeenCalled();
    expect(out).toMatchObject({data:[],total:0,resolvedBy:'bill-id'});
  });

  test.each(['S. 2809x', 'S. 2809 (118th)', 'S. 1'+' '.repeat(240)+'extra'])('reports an invalid literal without claiming a lookup: %s', async query => {
    const direct=jest.fn(), topic=jest.fn();
    const out=await call(svc({congressBill:{findUnique:direct},getCongressBills:topic}),{query,congress:119});
    expect(direct).not.toHaveBeenCalled(); expect(topic).not.toHaveBeenCalled();
    expect(out).toMatchObject({currentStatus:'invalid_request',data:[],total:0});
    expect(out).not.toHaveProperty('resolvedBy');
  });

  test.each(['119-s-2809', 'transparency in contracting'])('projects the public bill citation for exact and topic reads: %s', async query => {
    const bill = { id: '119-s-2809', title: 'Transparency in Contracting Act of 2025', sponsorName: 'Sen. Warren',
      url: 'https://api.congress.gov/v3/bill/119/s/2809?format=json' };
    const out = await call(svc({ congressBill: { findUnique: async () => bill },
      getCongressBills: async () => ({ data: [bill], total: 1, page: 1, limit: 20 }) }), { query, congress: 119 });
    expect(out).toMatchObject({ data: [{ ...bill, url: 'https://www.congress.gov/bill/119th-congress/senate-bill/2809' }], total: 1 });
    expect(bill.url).toBe('https://api.congress.gov/v3/bill/119/s/2809?format=json');
  });

  test.each(['S. 99999', '119-s-99999', 'S. 999999', '119S999999', '119-s-999999', 'S. 2809x'])(
    'never substitutes a title match or truncates a missing literal: %s', async query => {
      const titleSearch = jest.fn(async () => ({ data: [{ id: '119-s-999', title: 'Unrelated' }], total: 1 }));
      const direct = jest.fn(async () => null);
      const out = await call(svc({ congressBill: { findUnique: direct }, getCongressBills: titleSearch }), { query, congress: 119 });
      expect(out).toMatchObject({ data: [], total: 0 });
      expect(titleSearch).not.toHaveBeenCalled();
      for (const [args] of direct.mock.calls as unknown as Array<[{where:{id:string}}]>) expect(args.where.id).not.toBe('119-s-999');
    });

  test('an embedded designation Congress cannot override a conflicting explicit filter', async () => {
    const direct = jest.fn(async () => ({ id: '119-s-2809', title: 'Wrong Congress' }));
    const topic = jest.fn();
    const out = await call(svc({ congressBill: { findUnique: direct }, getCongressBills: topic }), { query: 'S. 2809 (119th)', congress: 118 });
    expect(out).toMatchObject({ data: [], total: 0 });
    expect(direct).not.toHaveBeenCalled();
    expect(topic).not.toHaveBeenCalled();
  });

  const prismaFound = (id: string): Fake => ({
    congressBill: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === id ? { id, title: 'Test Bill' } : null,
    },
  });

  const prismaNotFound = (): Fake => ({
    congressBill: {
      findUnique: async () => null,
    },
  });

  it('explicit 118 S.2809 selects 118-s-2809 not current 119', async () => {
    const s = svc(prismaFound('118-s-2809'));
    const out = (await call(s, { query: 'S.2809', congress: 118 })) as {
      data: Array<{ id: string }>;
      total: number;
      resolvedBy?: string;
    };
    expect(out.total).toBe(1);
    expect(out.data.map(bill => bill.id)).toEqual(['118-s-2809']);
    expect(out.resolvedBy).toBe('bill-id');
  });

  it('canonical 119-s-2809 preserved when no conflicting filter', async () => {
    const s = svc(prismaFound('119-s-2809'));
    const out = (await call(s, { query: '119-s-2809' })) as {
      data: Array<{ id: string }>;
      total: number;
      resolvedBy?: string;
    };
    expect(out.total).toBe(1);
    expect(out.data.map(bill => bill.id)).toEqual(['119-s-2809']);
    expect(out.resolvedBy).toBe('bill-id');
  });

  it('absent 119S999999 returns empty and never calls lda title fallback', async () => {
    let ldaCalled = false;
    const s = svc({
      congressBill: { findUnique: async () => null },
      getCongressBills: async () => {
        ldaCalled = true;
        return { data: [], total: 0, page: 1, limit: 20 };
      },
    });
    const out = (await call(s, { query: '119S999999' })) as {
      data: Array<unknown>;
      total: number;
      resolvedBy?: string;
    };
    expect(out.total).toBe(0);
    expect(out.data).toHaveLength(0);
    expect(ldaCalled).toBe(false); // never fell back to title search
  });

  it('conflicting canonical congress does not return a different congress bill', async () => {
    const s = svc({
      congressBill: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          if (where.id === '118-s-2809') return { id: '118-s-2809', title: 'Wrong Congress' };
          if (where.id === '119-s-2809') return { id: '119-s-2809', title: 'Correct Congress' };
          return null;
        },
      },
    });
    // Query is canonical with congress 118, but canonical itself says 118
    const out1 = (await call(s, { query: '118-s-2809', congress: 118 })) as {
      data: Array<{ id: string }>;
      total: number;
    };
    expect(out1.total).toBe(1);
    expect(out1.data.map(bill => bill.id)).toEqual(['118-s-2809']);

    // Query is canonical with congress 119, matches 119
    const out2 = (await call(s, { query: '119-s-2809', congress: 118 })) as {
      data: Array<{ id: string }>;
      total: number;
    };
    // When the canonical ID implies a different congress than the explicit filter,
    // we should NOT return a bill from a different congress
    expect(out2.total).toBe(0);
  });

  it('ordinary topic query reaches getCongressBills with filter/page/limit', async () => {
    let capturedInput: Record<string, unknown> = {};
    const s = svc({
      congressBill: { findUnique: async () => null },
    });
    (s as unknown as { ldaIntel: { getCongressBills: any } }).ldaIntel = {
      getCongressBills: async (q?: string, p?: string, c?: number, pg?: number, lim?: number, a?: string) => {
        capturedInput = { q, p, c, pg, lim, a };
        return { data: [], total: 0, page: 1, limit: 20 };
      },
    };
    await call(s, { query: 'infrastructure', congress: 119, limit: 10, page: 2 });
    expect(capturedInput.q).toBe('infrastructure');
    expect(capturedInput.c).toBe(119);
    expect(capturedInput.lim).toBe(10);
    expect(capturedInput.pg).toBe(2);
  });

  it('malformed reference must not be normalized into plausible different number', async () => {
    let ldaCalled = false;
    const s = svc({
      congressBill: { findUnique: async () => null },
      getCongressBills: async () => {
        ldaCalled = true;
        return { data: [], total: 0, page: 1, limit: 20 };
      },
    });
    // Malformed: numbers get mixed up, should not resolve to any bill ID
    const out = (await call(s, { query: 'S. 2809999' })) as {
      data: Array<unknown>;
      total: number;
      resolvedBy?: string;
    };
    expect(out.total).toBe(0);
    // Does not fall back to LDA search because it should not normalize to a plausible bill ID
    expect(ldaCalled).toBe(false);
  });
});
