import { describe, expect, jest, test } from '@jest/globals';
import {
  buildOpportunityFields,
  parseGrantsDate,
  syncOpportunities,
  type Search2Hit,
} from './sync-grants.js';

const noSleep = async (_ms: number) => {};

// Fixtures captured from live, keyless calls to api.grants.gov/v1/api/search2
// on 2026-07-24. Reproduced verbatim, including the empty-string closeDate a
// forecast carries.
const POSTED_SYNOPSIS: Search2Hit = {
  id: '363306',
  number: 'F27AS00008',
  title: 'F27AS00008-NAWCA 2027-1 US Standard Grants',
  agencyCode: 'DOI-FWS',
  agency: 'Fish and Wildlife Service',
  openDate: '07/24/2026',
  closeDate: '09/25/2026',
  oppStatus: 'posted',
  docType: 'synopsis',
  cfdaList: ['15.623'],
};

const FORECAST: Search2Hit = {
  id: '355824',
  number: 'MP-CPI-25-001',
  title: 'Making America Healthy Again by Addressing Dementia Disparities',
  agencyCode: 'HHS-OPHS',
  agency: 'Office of the Assistant Secretary for Health',
  openDate: '08/01/2024',
  closeDate: '',
  oppStatus: 'forecasted',
  docType: 'forecast',
  cfdaList: ['93.137'],
};

function makePrismaMock() {
  const upsertCalls: Array<{ where: { id: string }; create: any; update: any }> = [];
  return {
    upsertCalls,
    expireCalls: [] as string[],
    federalGrant: {
      upsert: jest.fn(async (args: any) => {
        upsertCalls.push(args);
        return args.create;
      }),
    },
    $executeRawUnsafe: jest.fn(async function (this: any, sql: string) {
      return 0;
    }),
  };
}

describe('parseGrantsDate', () => {
  test('parses MM/DD/YYYY at UTC midnight, not local midnight', () => {
    // Local-midnight parsing would slide to 07/23 on any host east of UTC.
    expect(parseGrantsDate('07/24/2026')?.toISOString()).toBe('2026-07-24T00:00:00.000Z');
  });

  test('treats a forecast\'s empty closeDate as absent, not epoch', () => {
    expect(parseGrantsDate('')).toBeNull();
    expect(parseGrantsDate(null)).toBeNull();
    expect(parseGrantsDate(undefined)).toBeNull();
  });

  test('returns null for an unparseable value rather than an Invalid Date', () => {
    expect(parseGrantsDate('not a date')).toBeNull();
  });
});

describe('buildOpportunityFields', () => {
  test('maps the ten fields search2 actually returns', () => {
    const f = buildOpportunityFields(POSTED_SYNOPSIS);
    expect(f.title).toBe('F27AS00008-NAWCA 2027-1 US Standard Grants');
    expect(f.agency).toBe('Fish and Wildlife Service');
    expect(f.opportunityNumber).toBe('F27AS00008');
    expect(f.status).toBe('posted');
    expect(f.docType).toBe('synopsis');
    expect(f.cfdaNumbers).toEqual(['15.623']);
    expect(f.url).toBe('https://www.grants.gov/search-results-detail/363306');
  });

  test('never emits the detail-owned columns, so a daily run cannot wipe enrichment', () => {
    const f = buildOpportunityFields(POSTED_SYNOPSIS) as Record<string, unknown>;
    for (const owned of [
      'category',
      'fundingInstrument',
      'awardCeiling',
      'awardFloor',
      'estimatedFunding',
      'description',
      'eligibility',
      'expectedAwards',
      'eligibilityText',
      'costSharing',
      'raw',
    ]) {
      expect(owned in f).toBe(false);
    }
  });

  test('falls back to the agency code only when the agency name is missing', () => {
    expect(buildOpportunityFields({ ...POSTED_SYNOPSIS, agency: null }).agency).toBe('DOI-FWS');
    expect(buildOpportunityFields({ id: '1' }).agency).toBe('Unknown');
  });

  test('a forecast keeps a null closeDate instead of inventing a deadline', () => {
    const f = buildOpportunityFields(FORECAST);
    expect(f.closeDate).toBeNull();
    expect(f.docType).toBe('forecast');
    expect(f.status).toBe('forecasted');
  });

  test('tolerates a missing cfdaList without producing [undefined]', () => {
    expect(buildOpportunityFields({ id: '1', cfdaList: null }).cfdaNumbers).toEqual([]);
  });
});

describe('syncOpportunities', () => {
  test('upserts every hit and stops when a short page arrives', async () => {
    const prisma = makePrismaMock();
    const fetchSearchPage = jest.fn(async (_s: string, _p: number) => ({
      hits: [POSTED_SYNOPSIS, FORECAST],
      hitCount: 2,
    }));

    const counts = await syncOpportunities(prisma as any, { allStatuses: false }, {
      fetchSearchPage,
      sleep: noSleep,
    });

    expect(counts.inserted).toBe(2);
    expect(counts.errors).toBe(0);
    expect(prisma.upsertCalls).toHaveLength(2);
    expect(fetchSearchPage).toHaveBeenCalledTimes(1);
  });

  test('requests posted|forecasted by default and all four statuses on reconcile', async () => {
    const prisma = makePrismaMock();
    const fetchSearchPage = jest.fn(async (_s: string, _p: number) => ({ hits: [], hitCount: 0 }));

    await syncOpportunities(prisma as any, { allStatuses: false }, { fetchSearchPage, sleep: noSleep });
    expect(fetchSearchPage).toHaveBeenLastCalledWith('posted|forecasted', 0);

    await syncOpportunities(prisma as any, { allStatuses: true }, { fetchSearchPage, sleep: noSleep });
    expect(fetchSearchPage).toHaveBeenLastCalledWith('forecasted|posted|closed|archived', 0);
  });

  test('runs the past-deadline expiry pass and reports how many rows it closed', async () => {
    const prisma = makePrismaMock();
    prisma.$executeRawUnsafe = jest.fn(async (_sql: string) => 7) as any;
    const fetchSearchPage = jest.fn(async (_s: string, _p: number) => ({ hits: [], hitCount: 0 }));

    const counts = await syncOpportunities(prisma as any, { allStatuses: false }, {
      fetchSearchPage,
      sleep: noSleep,
    });

    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const sql = (prisma.$executeRawUnsafe as any).mock.calls[0][0] as string;
    // Forecasts must be excluded — an estimated date is not a deadline.
    expect(sql).toMatch(/doc_type IS DISTINCT FROM 'forecast'/);
    expect(sql).toMatch(/close_date < CURRENT_DATE/);
    expect(counts.updated).toBe(7);
  });

  test('skips a hit with no usable id instead of upserting the string "undefined"', async () => {
    const prisma = makePrismaMock();
    const fetchSearchPage = jest.fn(async (_s: string, _p: number) => ({
      hits: [{ title: 'orphan' } as Search2Hit],
      hitCount: 1,
    }));

    const counts = await syncOpportunities(prisma as any, { allStatuses: false }, {
      fetchSearchPage,
      sleep: noSleep,
    });

    expect(prisma.upsertCalls).toHaveLength(0);
    expect(counts.inserted).toBe(0);
  });

  test('stops once the reported hitCount is covered, despite full pages continuing', async () => {
    const prisma = makePrismaMock();
    const page = Array.from({ length: 100 }, (_v, i) => ({ ...POSTED_SYNOPSIS, id: String(i) }));
    const fetchSearchPage = jest.fn(async (_s: string, _p: number) => ({ hits: page, hitCount: 100 }));

    await syncOpportunities(prisma as any, { allStatuses: false }, { fetchSearchPage, sleep: noSleep });

    expect(fetchSearchPage).toHaveBeenCalledTimes(1);
    expect(prisma.upsertCalls).toHaveLength(100);
  });

  test('an upsert failure is counted, not fatal to the rest of the page', async () => {
    const prisma = makePrismaMock();
    prisma.federalGrant.upsert = jest.fn(async (args: any) => {
      if (args.where.id === '363306') throw new Error('boom');
      prisma.upsertCalls.push(args);
      return args.create;
    }) as any;
    const fetchSearchPage = jest.fn(async (_s: string, _p: number) => ({
      hits: [POSTED_SYNOPSIS, FORECAST],
      hitCount: 2,
    }));

    const counts = await syncOpportunities(prisma as any, { allStatuses: false }, {
      fetchSearchPage,
      sleep: noSleep,
    });

    expect(counts.errors).toBe(1);
    expect(counts.inserted).toBe(1);
  });
});

/**
 * Audit F6 / phase i2: hitting the MAX_PAGES circuit breaker while the corpus
 * is demonstrably NOT exhausted must never read as a clean success. Before
 * this, the loop simply fell out of its `page < MAX_PAGES` condition and
 * returned `errors: 0`, so runWithSyncRun recorded `success` and the
 * ingestion ledger claimed a complete run over a truncated one.
 */
describe('syncOpportunities — page-cap exhaustion is never a clean success', () => {
  /** A always-full page of unique ids, so neither exhaustion signal can fire. */
  function fullPageFetcher() {
    return jest.fn(async (_s: string, page: number) => ({
      hits: Array.from({ length: 100 }, (_v, i) => ({
        ...POSTED_SYNOPSIS,
        id: `p${page}-${i}`,
      })),
      // Far beyond anything 100 pages x 100 rows can cover, so the
      // `total >= hitCount` break never fires either.
      hitCount: 999_999,
    }));
  }

  test('a run that hits MAX_PAGES without proving exhaustion reports errors > 0 and capExhausted', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const prisma = makePrismaMock();
      const fetchSearchPage = fullPageFetcher();

      const counts = await syncOpportunities(prisma as any, { allStatuses: false }, {
        fetchSearchPage,
        sleep: noSleep,
      });

      // Walked the full bound and stopped only because of it.
      expect(fetchSearchPage).toHaveBeenCalledTimes(100);
      expect(counts.capExhausted).toBe(true);
      // errors > 0 is what downgrades the SyncRun to success_with_errors.
      expect(counts.errors).toBeGreaterThan(0);
      // The real rows are still reported — a truncated walk is incomplete, not void.
      expect(counts.inserted).toBe(10_000);
      // Resume point is the page after the last one attempted.
      expect(counts.resumeFromPage).toBe(100);
      expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/CAP EXHAUSTED/);
    } finally {
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  test('a run that stops on a short page reports errors === 0 and no cap exhaustion', async () => {
    const prisma = makePrismaMock();
    // 40 < PAGE_SIZE, so the short-page break fires on page 0.
    const fetchSearchPage = jest.fn(async (_s: string, _p: number) => ({
      hits: Array.from({ length: 40 }, (_v, i) => ({ ...POSTED_SYNOPSIS, id: `s${i}` })),
      hitCount: 40,
    }));

    const counts = await syncOpportunities(prisma as any, { allStatuses: false }, {
      fetchSearchPage,
      sleep: noSleep,
    });

    expect(fetchSearchPage).toHaveBeenCalledTimes(1);
    expect(counts.capExhausted).toBe(false);
    expect(counts.errors).toBe(0);
    expect(counts.resumeFromPage).toBeNull();
  });

  test('a run that stops because hitCount is covered is also not cap-exhausted', async () => {
    const prisma = makePrismaMock();
    const page = Array.from({ length: 100 }, (_v, i) => ({ ...POSTED_SYNOPSIS, id: String(i) }));
    const fetchSearchPage = jest.fn(async (_s: string, _p: number) => ({ hits: page, hitCount: 100 }));

    const counts = await syncOpportunities(prisma as any, { allStatuses: false }, {
      fetchSearchPage,
      sleep: noSleep,
    });

    expect(counts.capExhausted).toBe(false);
    expect(counts.errors).toBe(0);
    expect(counts.resumeFromPage).toBeNull();
  });
});
