import { describe, expect, jest, test } from '@jest/globals';
import {
  buildDetailUpdate,
  enrichGrantCandidates,
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
  test('scans never-enriched rows first, then stalest, and updates each', async () => {
    const updates: Array<{ where: { id: string }; data: any }> = [];
    const prisma = {
      federalGrant: {
        findMany: jest.fn(async (_args: any) => [{ id: '363306' }, { id: '355824' }]),
        update: jest.fn(async (args: any) => {
          updates.push(args);
          return args;
        }),
      },
    };
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
    const prisma = {
      federalGrant: {
        findMany: jest.fn(async (_args: any) => [{ id: 'bad' }, { id: '363306' }]),
        update: jest.fn(async (args: any) => args),
      },
    };
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
