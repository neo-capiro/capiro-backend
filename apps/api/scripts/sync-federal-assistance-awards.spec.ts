import { describe, expect, jest, test } from '@jest/globals';
import {
  awardTypeCodeFromLabel,
  syncAssistanceAwardsWindow,
  toAwardData,
  type AssistanceAwardRaw,
  type FetchPageArgs,
  type PageMetadata,
} from './sync-federal-assistance-awards.js';

const noSleep = async (_ms: number) => {};

// Fixtures captured from a live, keyless call to USAspending's
// spending_by_award (award_type_codes 02/03/04/05) on 2026-07-24 — see the
// script's header comment. Trimmed to the fields the sync actually requests.
const MEDICAID_BLOCK_GRANT: AssistanceAwardRaw = {
  generated_internal_id: 'ASST_NON_2605CA5MAP_075',
  internal_id: 352819133,
  'Award ID': '2605CA5MAP',
  'Recipient Name': 'HEALTH CARE SERVICES, CALIFORNIA DEPARTMENT OF',
  'Recipient UEI': 'JE73CDQUAPA7',
  'Award Amount': 111733918965,
  'Total Outlays': 70507176124.05,
  Description: 'MEDICAID ENTITLEMENT FOR 7 - FY 2026 - T19',
  'Awarding Agency': 'Department of Health and Human Services',
  'Awarding Sub Agency': 'Centers for Medicare and Medicaid Services',
  'Funding Agency': 'Department of Health and Human Services',
  'Funding Sub Agency': 'Centers for Medicare and Medicaid Services',
  'Start Date': '2025-10-01',
  'End Date': '2026-09-30',
  'Last Modified Date': '2026-07-20 19:04:23',
  'Assistance Listings': [{ cfda_number: '93.778', cfda_program_title: 'GRANTS TO STATES FOR MEDICAID' }],
  'CFDA Number': '93.778',
  'SAI Number': 'SAI UNAVAILABLE',
  'Award Type': 'BLOCK GRANT (A)',
  // congressional_code "90" here is the REAL, live-verified sentinel for a
  // statewide/multi-district place of performance — not a fabricated test value.
  'Primary Place of Performance': {
    location_country_code: 'USA',
    state_code: 'CA',
    city_name: null,
    congressional_code: '90',
    zip5: null,
  },
  'Recipient Location': {
    location_country_code: 'USA',
    state_code: 'CA',
    city_name: 'SACRAMENTO',
    congressional_code: '07',
    zip5: '95814',
  },
};

const NAWCA_COOPERATIVE_AGREEMENT: AssistanceAwardRaw = {
  generated_internal_id: 'ASST_NON_F27AS00008_0100',
  'Award ID': 'F27AS00008',
  'Recipient Name': 'STATE OF EXAMPLE WILDLIFE AGENCY',
  'Recipient UEI': 'ABCDEFGH1234',
  'Award Amount': 500000,
  'Total Outlays': 0,
  'Awarding Agency': 'Department of the Interior',
  'Award Type': 'COOPERATIVE AGREEMENT (05)',
  'Assistance Listings': [{ cfda_number: '15.623', cfda_program_title: 'North American Wetlands Conservation Fund' }],
  'CFDA Number': '15.623',
  'Primary Place of Performance': { state_code: 'MT', congressional_code: '00' },
  'Recipient Location': { state_code: 'MT', congressional_code: '00' },
};

function makePrismaMock(existingIds: Set<string> = new Set()) {
  const upsertCalls: Array<{ where: unknown; create: unknown; update: unknown }> = [];
  return {
    upsertCalls,
    federalAssistanceAward: {
      findUnique: jest.fn(async ({ where }: { where: { awardUniqueId: string } }) =>
        existingIds.has(where.awardUniqueId) ? { id: `db-${where.awardUniqueId}` } : null,
      ),
      upsert: jest.fn(async (args: { where: unknown; create: unknown; update: unknown }) => {
        upsertCalls.push(args);
        return args.create;
      }),
    },
  };
}

describe('awardTypeCodeFromLabel', () => {
  test.each([
    ['BLOCK GRANT (A)', '02'],
    ['FORMULA GRANT (A)', '03'],
    ['PROJECT GRANT (B)', '04'],
    ['COOPERATIVE AGREEMENT (05)', '05'],
    ['SOMETHING UNRECOGNIZED', null],
    [null, null],
    [undefined, null],
  ])('normalizes %p -> %p', (label, expected) => {
    expect(awardTypeCodeFromLabel(label as string | null)).toBe(expected);
  });
});

describe('toAwardData', () => {
  test('maps a verified live fixture without fabricating fields', () => {
    const data = toAwardData(MEDICAID_BLOCK_GRANT);
    expect(data.fain).toBe('2605CA5MAP');
    expect(data.awardTypeCode).toBe('02');
    expect(data.awardTypeLabel).toBe('BLOCK GRANT (A)');
    expect(data.recipientUei).toBe('JE73CDQUAPA7');
    expect(data.assistanceListingNumber).toBe('93.778');
    expect(data.assistanceListingTitle).toBe('GRANTS TO STATES FOR MEDICAID');
    expect(data.totalObligatedAmount).toBe(111733918965);
    expect(data.totalOutlayedAmount).toBe(70507176124.05);
    expect(data.saiNumber).toBe('SAI UNAVAILABLE');
  });

  test('preserves the statewide "90" sentinel verbatim — never coerced to a district', () => {
    const data = toAwardData(MEDICAID_BLOCK_GRANT);
    expect(data.popCongressionalDistrictRaw).toBe('90');
    expect(data.popCongressionalDistrict).toBe('90');
    expect(data.popCdVintage).toBe('original');
  });

  test('recipient location is captured separately from place of performance', () => {
    const data = toAwardData(MEDICAID_BLOCK_GRANT);
    expect(data.popState).toBe('CA');
    expect(data.recipientState).toBe('CA');
    expect(data.recipientCity).toBe('SACRAMENTO');
    expect(data.recipientCongressionalDistrict).toBe('07');
    // Place of performance and recipient location must never be conflated.
    expect(data.popCity).toBeNull();
  });

  test('preserves at-large "00" without guessing a district number', () => {
    const data = toAwardData(NAWCA_COOPERATIVE_AGREEMENT);
    expect(data.popCongressionalDistrict).toBe('00');
    expect(data.awardTypeCode).toBe('05');
  });

  test('stores the vendor payload verbatim in raw, not a re-derived object', () => {
    const data = toAwardData(MEDICAID_BLOCK_GRANT);
    expect(data.raw).toBe(MEDICAID_BLOCK_GRANT);
  });

  test('never fabricates non-federal funding — column stays absent from the mapped object entirely', () => {
    const data = toAwardData(MEDICAID_BLOCK_GRANT);
    expect('nonFederalFundingAmount' in data).toBe(false);
  });
});

describe('syncAssistanceAwardsWindow', () => {
  test('upserts each result and classifies insert vs update correctly', async () => {
    const prisma = makePrismaMock(new Set(['ASST_NON_F27AS00008_0100']));
    const fetchPage = jest.fn(async (_args: FetchPageArgs) => ({
      results: [MEDICAID_BLOCK_GRANT, NAWCA_COOPERATIVE_AGREEMENT],
      pageMetadata: { hasNext: false } as PageMetadata,
    }));

    const counts = await syncAssistanceAwardsWindow(
      prisma,
      { startDate: '2025-10-01', endDate: '2026-07-24', maxPages: 5 },
      { fetchPage, sleep: noSleep },
    );

    expect(counts).toEqual({ inserted: 1, updated: 1, skipped: 0, errors: 0 });
    expect(prisma.upsertCalls).toHaveLength(2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  test('follows the keyset cursor across pages and stops when hasNext is false', async () => {
    const prisma = makePrismaMock();
    const fetchPage = jest
      .fn<typeof import('./sync-federal-assistance-awards.js').fetchPage>()
      .mockResolvedValueOnce({
        results: [MEDICAID_BLOCK_GRANT],
        pageMetadata: { hasNext: true, last_record_unique_id: 352819133, last_record_sort_value: '11173391896500' },
      })
      .mockResolvedValueOnce({
        results: [NAWCA_COOPERATIVE_AGREEMENT],
        pageMetadata: { hasNext: false },
      });

    const counts = await syncAssistanceAwardsWindow(
      prisma,
      { startDate: '2025-10-01', endDate: '2026-07-24', maxPages: 5 },
      { fetchPage, sleep: noSleep },
    );

    expect(counts.inserted).toBe(2);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    // Second call must carry the cursor from the first page's page_metadata,
    // and must NOT also send `page` (keyset pagination replaces it entirely).
    const secondCallArgs = fetchPage.mock.calls[1]?.[0];
    if (!secondCallArgs) throw new Error('expected a second fetchPage call');
    expect(secondCallArgs.cursor).toEqual({
      lastRecordUniqueId: 352819133,
      lastRecordSortValue: '11173391896500',
    });
  });

  test('stops immediately on an empty page without erroring', async () => {
    const prisma = makePrismaMock();
    const fetchPage = jest.fn(async (_args: FetchPageArgs) => ({
      results: [],
      pageMetadata: { hasNext: false } as PageMetadata,
    }));

    const counts = await syncAssistanceAwardsWindow(
      prisma,
      { startDate: '2025-10-01', endDate: '2026-07-24', maxPages: 5 },
      { fetchPage, sleep: noSleep },
    );

    expect(counts).toEqual({ inserted: 0, updated: 0, skipped: 0, errors: 0 });
  });

  test('counts a row with no generated_internal_id as an error, not a fabricated upsert', async () => {
    const prisma = makePrismaMock();
    const malformed: AssistanceAwardRaw = { ...MEDICAID_BLOCK_GRANT, generated_internal_id: undefined };
    const fetchPage = jest.fn(async (_args: FetchPageArgs) => ({
      results: [malformed],
      pageMetadata: { hasNext: false } as PageMetadata,
    }));

    const counts = await syncAssistanceAwardsWindow(
      prisma,
      { startDate: '2025-10-01', endDate: '2026-07-24', maxPages: 5 },
      { fetchPage, sleep: noSleep },
    );

    expect(counts.errors).toBe(1);
    expect(prisma.upsertCalls).toHaveLength(0);
  });

  test('respects maxPages as a circuit breaker even if the API keeps saying hasNext', async () => {
    const prisma = makePrismaMock();
    const fetchPage = jest.fn(async (_args: FetchPageArgs) => ({
      results: [MEDICAID_BLOCK_GRANT],
      pageMetadata: { hasNext: true, last_record_unique_id: 1, last_record_sort_value: '1' } as PageMetadata,
    }));

    await syncAssistanceAwardsWindow(
      prisma,
      { startDate: '2025-10-01', endDate: '2026-07-24', maxPages: 3 },
      { fetchPage, sleep: noSleep },
    );

    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  test('forwards agency and minAmount filters to fetchPage unchanged', async () => {
    const prisma = makePrismaMock();
    const fetchPage = jest.fn(async (_args: FetchPageArgs) => ({
      results: [],
      pageMetadata: { hasNext: false } as PageMetadata,
    }));

    await syncAssistanceAwardsWindow(
      prisma,
      { startDate: '2025-10-01', endDate: '2026-07-24', maxPages: 1, agency: 'Department of the Interior', minAmount: 100000 },
      { fetchPage, sleep: noSleep },
    );

    expect(fetchPage).toHaveBeenCalledWith(
      expect.objectContaining({ agency: 'Department of the Interior', minAmount: 100000 }),
    );
  });
});
