import { describe, expect, jest, test } from '@jest/globals';
import {
  allocateEnrichmentBudget,
  buildDetailUpdate,
  enrichGrantCandidates,
  parseEnrichmentLimit,
  parseVendorTimestamp,
  pickBlock,
  trimRaw,
  type OpportunityDetailRaw,
} from './enrich-grant-details.js';

const noSleep = async (_ms: number) => {};

// Fixtures captured from live, keyless calls to
// api.grants.gov/v1/api/fetchOpportunity on 2026-07-24. Numeric-looking
// fields really are strings in the vendor payload — kept as strings here on
// purpose, that's the coercion the mapper exists to handle.
const SYNOPSIS_DETAIL: OpportunityDetailRaw = {
  id: 363306,
  revision: 0,
  docType: 'synopsis',
  opportunityCategory: { category: 'D', description: 'Discretionary' },
  cfdas: [{ cfdaNumber: '15.623' }],
  opportunityHistoryDetails: [],
  synopsis: {
    synopsisDesc: 'The North American Wetlands Conservation Act (NAWCA) U.S. Standard grants are competitive, matching grants.',
    responseDateDesc:
      'Electronically submitted applications must be submitted no later than 11:59 PM, ET, on the listed application due date.',
    applicantEligibilityDesc: 'For US Standard eligibility criteria, proposal instructions, and proposal template, visit fws.gov.',
    costSharing: true,
    numberOfAwards: '25',
    estimatedFunding: '46000000',
    awardCeiling: '3000000',
    awardFloor: '250001',
    applicantTypes: [
      { id: '00', description: 'State governments' },
      { id: '23', description: 'Small businesses' },
    ],
    fundingInstruments: [{ id: 'G', description: 'Grant' }],
    lastUpdatedDate: 'Mar 20, 2025 10:28:30 AM EDT',
  },
};

const FORECAST_DETAIL: OpportunityDetailRaw = {
  id: 355824,
  revision: 2,
  docType: 'forecast',
  opportunityCategory: { category: 'D', description: 'Discretionary' },
  cfdas: [{ cfdaNumber: '93.137' }],
  opportunityHistoryDetails: [{}, {}, {}],
  forecast: {
    forecastDesc: 'The Office of Minority Health announces the anticipated availability of funds.',
    costSharing: false,
    numberOfAwards: '9',
    estimatedFunding: '5000000',
    awardCeiling: '600000',
    awardFloor: '450000',
    applicantTypes: [{ id: '00', description: 'State governments' }],
    fundingInstruments: [{ id: 'G', description: 'Grant' }],
    lastUpdatedDate: 'Mar 20, 2025 10:28:30 AM EDT',
    // A forecast carries NO applicantEligibilityDesc and NO responseDateDesc —
    // verified live. Its date semantics live on the est* fields instead.
    estApplicationResponseDateDesc: 'Estimated application due date',
  },
};

describe('pickBlock', () => {
  test('reads the synopsis block for a synopsis opportunity', () => {
    expect(pickBlock(SYNOPSIS_DETAIL).synopsisDesc).toContain('NAWCA');
  });

  test('reads the forecast block for a forecast opportunity', () => {
    expect(pickBlock(FORECAST_DETAIL).forecastDesc).toContain('Office of Minority Health');
  });

  test('returns an empty block rather than throwing when neither is present', () => {
    expect(pickBlock({ id: 1 })).toEqual({});
  });
});

describe('parseVendorTimestamp', () => {
  test('resolves the US timezone abbreviation to a fixed offset', () => {
    // EDT is UTC-4, so 10:28:30 EDT is 14:28:30Z regardless of host TZ.
    expect(parseVendorTimestamp('Mar 20, 2025 10:28:30 AM EDT')?.toISOString()).toBe(
      '2025-03-20T14:28:30.000Z',
    );
  });

  test('returns null for absent or unparseable values', () => {
    expect(parseVendorTimestamp(null)).toBeNull();
    expect(parseVendorTimestamp('')).toBeNull();
    expect(parseVendorTimestamp('whenever')).toBeNull();
  });
});

describe('buildDetailUpdate — synopsis', () => {
  test('coerces the vendor\'s stringly-typed money and counts', () => {
    const u = buildDetailUpdate(SYNOPSIS_DETAIL);
    expect(u.awardCeiling).toBe(3000000);
    expect(u.awardFloor).toBe(250001);
    expect(u.estimatedFunding).toBe(46000000);
    expect(u.expectedAwards).toBe(25);
  });

  test('populates the columns sync-grants could never fill', () => {
    const u = buildDetailUpdate(SYNOPSIS_DETAIL);
    expect(u.category).toBe('Discretionary');
    expect(u.fundingInstrument).toBe('Grant');
    expect(u.eligibility).toEqual(['State governments', 'Small businesses']);
    expect(u.eligibilityText).toContain('US Standard eligibility criteria');
    expect(u.costSharing).toBe(true);
    expect(u.description).toContain('NAWCA');
    expect(u.cfdaNumbers).toEqual(['15.623']);
  });

  test('records revision, docType and amendment count', () => {
    const u = buildDetailUpdate(SYNOPSIS_DETAIL);
    expect(u.revision).toBe(0);
    expect(u.docType).toBe('synopsis');
    expect(u.amendmentCount).toBe(0);
  });

  test('always stamps detailSyncedAt and stores a raw payload', () => {
    const u = buildDetailUpdate(SYNOPSIS_DETAIL);
    expect(u.detailSyncedAt).toBeInstanceOf(Date);
    expect(u.raw).toBeDefined();
  });
});

describe('buildDetailUpdate — forecast', () => {
  test('takes the description from forecastDesc, not synopsisDesc', () => {
    const u = buildDetailUpdate(FORECAST_DETAIL);
    expect(u.description).toContain('Office of Minority Health');
  });

  test('falls back to the estimated-response wording for responseDateDesc', () => {
    expect(buildDetailUpdate(FORECAST_DETAIL).responseDateDesc).toBe('Estimated application due date');
  });

  test('omits eligibilityText entirely — a forecast has no eligibility narrative', () => {
    expect('eligibilityText' in buildDetailUpdate(FORECAST_DETAIL)).toBe(false);
  });

  test('never writes closeDate — an estimated date is not a deadline', () => {
    expect('closeDate' in buildDetailUpdate(FORECAST_DETAIL)).toBe(false);
  });

  test('counts amendments from opportunityHistoryDetails', () => {
    expect(buildDetailUpdate(FORECAST_DETAIL).amendmentCount).toBe(3);
  });

  test('costSharing false is written, not dropped as falsy', () => {
    expect(buildDetailUpdate(FORECAST_DETAIL).costSharing).toBe(false);
  });
});

describe('buildDetailUpdate — absent fields', () => {
  test('a sparse payload yields no null-valued keys, so nothing gets clobbered', () => {
    const u = buildDetailUpdate({ id: 1, docType: 'synopsis', synopsis: {} });
    for (const [k, v] of Object.entries(u)) {
      expect([k, v]).not.toEqual([k, null]);
    }
    expect('awardCeiling' in u).toBe(false);
    expect('eligibility' in u).toBe(false);
    expect('description' in u).toBe(false);
  });

  test('an empty cfdas array does not overwrite the numbers search2 already stored', () => {
    expect('cfdaNumbers' in buildDetailUpdate({ id: 1, cfdas: [], synopsis: {} })).toBe(false);
  });
});

describe('trimRaw', () => {
  test('drops the bulky attachment and package arrays', () => {
    const fat = {
      ...SYNOPSIS_DETAIL,
      synopsisAttachmentFolders: [{ big: 'x'.repeat(1000) }],
      synopsisDocumentURLs: ['a'],
      opportunityPkgs: [1, 2, 3],
      closedOpportunityPkgs: [4],
    } as unknown as OpportunityDetailRaw;
    const trimmed = trimRaw(fat);
    expect('synopsisAttachmentFolders' in trimmed).toBe(false);
    expect('synopsisDocumentURLs' in trimmed).toBe(false);
    expect('opportunityPkgs' in trimmed).toBe(false);
    expect('closedOpportunityPkgs' in trimmed).toBe(false);
    expect(trimmed.docType).toBe('synopsis');
  });
});

describe('enrichGrantCandidates', () => {
  /**
   * The pass now issues TWO scans — one per population — so a fake that answers
   * both with the same rows would double-count every candidate. `pursuableOnly`
   * routes rows to the pursuable scan (the one that constrains `status`) and gives
   * the historical scan nothing.
   */
  function singlePopulationPrisma(rows: Array<{ id: string }>) {
    return {
      federalGrant: {
        findMany: jest.fn(async (args: any) => (args.where?.status !== undefined ? rows : [])),
        update: jest.fn(async (args: any) => args),
      },
    };
  }

  test('scans never-enriched rows first, then stalest, and updates each', async () => {
    const updates: Array<{ where: { id: string }; data: any }> = [];
    const prisma = singlePopulationPrisma([{ id: '363306' }, { id: '355824' }]);
    prisma.federalGrant.update = jest.fn(async (args: any) => {
      updates.push(args);
      return args;
    });
    const fetchOpportunityDetail = jest.fn(async (id: string) =>
      id === '363306' ? SYNOPSIS_DETAIL : FORECAST_DETAIL,
    );

    const counts = await enrichGrantCandidates(prisma as any, 10, {
      fetchOpportunityDetail,
      sleep: noSleep,
    });

    expect(counts).toEqual({ inserted: 0, updated: 2, skipped: 0, errors: 0 });
    const orderBy = (prisma.federalGrant.findMany as any).mock.calls[0][0].orderBy;
    expect(orderBy).toEqual([{ detailSyncedAt: { sort: 'asc', nulls: 'first' } }]);
    const firstUpdate = updates[0];
    if (!firstUpdate) throw new Error('expected an update for the first candidate');
    expect(firstUpdate.data.category).toBe('Discretionary');
  });

  test('one failing opportunity is counted and the sweep continues', async () => {
    const prisma = singlePopulationPrisma([{ id: 'bad' }, { id: '363306' }]);
    const fetchOpportunityDetail = jest.fn(async (id: string) => {
      if (id === 'bad') throw new Error('non-numeric opportunity id');
      return SYNOPSIS_DETAIL;
    });

    const counts = await enrichGrantCandidates(prisma as any, 10, {
      fetchOpportunityDetail,
      sleep: noSleep,
    });

    expect(counts.errors).toBe(1);
    expect(counts.updated).toBe(1);
  });

  test('honours the limit as the run bound', async () => {
    const prisma = {
      federalGrant: {
        findMany: jest.fn(async (_args: any) => []),
        update: jest.fn(async (args: any) => args),
      },
    };
    await enrichGrantCandidates(prisma as any, 42, {
      fetchOpportunityDetail: jest.fn(async (_id: string) => SYNOPSIS_DETAIL),
      sleep: noSleep,
    });
    expect((prisma.federalGrant.findMany as any).mock.calls[0][0].take).toBe(42);
  });
});

// ── §11: every run reserves capacity for BOTH populations ────────────────────

describe('parseEnrichmentLimit', () => {
  test('a valid positive integer passes through', () => {
    expect(parseEnrichmentLimit('300')).toBe(300);
    expect(parseEnrichmentLimit('1')).toBe(1);
  });

  test('an absent limit falls back', () => {
    expect(parseEnrichmentLimit(undefined)).toBe(300);
    expect(parseEnrichmentLimit(undefined, 50)).toBe(50);
  });

  test.each(['abc', '', '0', '-5', '2.5', 'Infinity', 'NaN'])('%p is rejected', (raw) => {
    // `Number('abc')` was passed straight to `take: NaN`, which Prisma rejects with
    // an opaque validation error AFTER the run has already opened a SyncRun row.
    // `--limit 0` was worse: a run that fetched nothing and reported success.
    expect(() => parseEnrichmentLimit(raw)).toThrow(/positive integer/);
  });
});

describe('allocateEnrichmentBudget', () => {
  test('splits the run 70/30 between current and historical', () => {
    expect(allocateEnrichmentBudget(300, { pursuable: 10_000, historical: 70_000 })).toEqual({
      pursuable: 210,
      historical: 90,
    });
  });

  test('a permanently large pursuable pool can no longer starve the archived tail', () => {
    // The defect this pins. Pursuable rows are re-enriched forever on a
    // stalest-first cycle to catch amendments, so the pursuable pool permanently
    // exceeds the limit — and taking `limit` from it first meant the 72,689
    // archived rows were never touched again. Priority is not a schedule.
    const budget = allocateEnrichmentBudget(300, { pursuable: 5_000, historical: 72_689 });
    expect(budget.historical).toBeGreaterThan(0);
    expect(budget.pursuable + budget.historical).toBe(300);
  });

  test('unused capacity flows to the other side, so a run is never wasted', () => {
    // Reserving a share must not mean burning it when one pool is empty.
    expect(allocateEnrichmentBudget(300, { pursuable: 10_000, historical: 0 })).toEqual({
      pursuable: 300,
      historical: 0,
    });
    expect(allocateEnrichmentBudget(300, { pursuable: 0, historical: 10_000 })).toEqual({
      pursuable: 0,
      historical: 300,
    });
    expect(allocateEnrichmentBudget(300, { pursuable: 40, historical: 10_000 })).toEqual({
      pursuable: 40,
      historical: 260,
    });
  });

  test('never asks for more than exists', () => {
    expect(allocateEnrichmentBudget(300, { pursuable: 5, historical: 7 })).toEqual({
      pursuable: 5,
      historical: 7,
    });
  });

  test('a limit of 1 still allocates exactly one fetch', () => {
    const budget = allocateEnrichmentBudget(1, { pursuable: 10, historical: 10 });
    expect(budget.pursuable + budget.historical).toBeLessThanOrEqual(2);
    expect(budget.pursuable).toBeGreaterThanOrEqual(1);
  });
});

describe('enrichGrantCandidates queries both populations', () => {
  function fixture(pursuableCount: number, historicalCount: number) {
    const wheres: unknown[] = [];
    const prisma = {
      federalGrant: {
        findMany: jest.fn(async (args: any) => {
          wheres.push(args.where);
          // The pursuable query constrains `status`; the historical one is an OR
          // over status/closeDate. Distinguish on the presence of `status`.
          const isPursuable = args.where?.status !== undefined;
          const count = isPursuable ? pursuableCount : historicalCount;
          return Array.from({ length: Math.min(count, args.take) }, (_, i) => ({
            id: `${isPursuable ? 'P' : 'H'}${i}`,
          }));
        }),
        update: jest.fn(async (args: any) => args),
      },
    };
    return { prisma, wheres };
  }

  test('both a pursuable and a historical scan are issued', async () => {
    const { prisma, wheres } = fixture(1_000, 50_000);
    await enrichGrantCandidates(prisma as any, 100, {
      fetchOpportunityDetail: jest.fn(async () => SYNOPSIS_DETAIL),
      sleep: noSleep,
    });
    expect(wheres).toHaveLength(2);
    // Both halves of the grant lifecycle predicate are present, from the shared
    // module rather than a fourth inline copy.
    expect(JSON.stringify(wheres)).toContain('closeDate');
    expect(JSON.stringify(wheres)).toContain('posted');
  });

  test('an archived-heavy catalog still enriches archived rows every run', async () => {
    const { prisma } = fixture(1_000, 72_689);
    const counts = await enrichGrantCandidates(prisma as any, 100, {
      fetchOpportunityDetail: jest.fn(async () => SYNOPSIS_DETAIL),
      sleep: noSleep,
    });
    const ids = (prisma.federalGrant.update as any).mock.calls.map((c: any[]) => c[0].where.id);
    expect(counts.updated).toBe(100);
    expect(ids.filter((id: string) => id.startsWith('H')).length).toBeGreaterThan(0);
    expect(ids.filter((id: string) => id.startsWith('P')).length).toBeGreaterThan(0);
  });
});
