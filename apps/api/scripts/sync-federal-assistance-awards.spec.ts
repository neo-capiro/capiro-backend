import { describe, expect, jest, test } from '@jest/globals';
import {
  awardTypeCodeFromLabel,
  fetchPage,
  fetchPageWithRetry,
  isTransientFetchError,
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

/**
 * These assert on the REQUEST BODY, which no response-mapping test can see.
 *
 * Two properties of this sync are invisible to every other test in this file
 * and would regress silently:
 *   - all-agency scope: omitting `agency` must send NO agencies filter. A
 *     stray default would quietly shrink the corpus to one agency while every
 *     mapping test still passed.
 *   - keyset pagination: past ~50,000 rows USAspending rejects page*limit
 *     depth, so subsequent pages must send last_record_* and must NOT send
 *     `page`. Sending both is the failure mode that silently caps ingestion.
 */
describe('fetchPage request body', () => {
  function captureBody(): { first: () => Record<string, unknown> } {
    const calls: Array<Record<string, unknown>> = [];
    global.fetch = jest.fn(async (_url: unknown, init: unknown) => {
      calls.push(JSON.parse((init as { body: string }).body) as Record<string, unknown>);
      return {
        ok: true,
        json: async () => ({ results: [], page_metadata: { hasNext: false } }),
      } as never;
    }) as never;
    return {
      first: () => {
        const body = calls[0];
        if (!body) throw new Error('fetchPage never issued a request');
        return body;
      },
    };
  }

  const BASE: FetchPageArgs = { startDate: '2026-01-01', endDate: '2026-03-31' };

  test('omitting agency sends no agencies filter at all — the scope is all agencies', async () => {
    const { first } = captureBody();
    await fetchPage(BASE);
    const filters = first().filters as Record<string, unknown>;
    expect(filters).not.toHaveProperty('agencies');
    // The scope-defining filters must still be present.
    expect(filters).toHaveProperty('time_period');
    expect(filters).toHaveProperty('award_type_codes');
  });

  test('an explicit agency narrows to a toptier awarding filter', async () => {
    const { first } = captureBody();
    await fetchPage({ ...BASE, agency: 'Department of Health and Human Services' });
    expect((first().filters as Record<string, unknown>).agencies).toEqual([
      { type: 'awarding', tier: 'toptier', name: 'Department of Health and Human Services' },
    ]);
  });

  test('the first page uses page:1 and sends no keyset cursor', async () => {
    const { first } = captureBody();
    await fetchPage(BASE);
    expect(first().page).toBe(1);
    expect(first()).not.toHaveProperty('last_record_unique_id');
    expect(first()).not.toHaveProperty('last_record_sort_value');
  });

  test('a cursor switches to keyset and drops page entirely', async () => {
    const { first } = captureBody();
    await fetchPage({
      ...BASE,
      cursor: { lastRecordUniqueId: 352819133, lastRecordSortValue: '1000000.00' },
    });
    expect(first().last_record_unique_id).toBe(352819133);
    expect(first().last_record_sort_value).toBe('1000000.00');
    // Sending `page` alongside the keyset is the depth-cap regression.
    expect(first()).not.toHaveProperty('page');
  });

  test('sort and order stay pinned to the field the cursor sorts on', async () => {
    const { first } = captureBody();
    await fetchPage(BASE);
    // last_record_sort_value is only meaningful against this exact sort.
    expect(first().sort).toBe('Award Amount');
    expect(first().order).toBe('desc');
  });
});

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

/**
 * Regression cover for the first live canary (2026-07-26): a bounded backfill
 * wrote 51,000 real rows, then USAspending hung up mid-stream
 * (`SocketError: other side closed`) at page ~510. With no retry the whole
 * walk died, and because the counts were only returned on success the
 * ingestion ledger recorded `rows_inserted: 0` — flatly contradicting the
 * 51,000 rows sitting in the table.
 */
describe('transient-failure handling', () => {
  const socketError = () => new Error('fetch failed'); // undici: no .status

  function httpError(status: number): Error & { status: number } {
    const e = new Error(`USAspending ${status}`) as Error & { status: number };
    e.status = status;
    return e;
  }

  describe('isTransientFetchError', () => {
    test('a socket/network failure carries no status and IS retried', () => {
      expect(isTransientFetchError(socketError())).toBe(true);
    });

    test('429 and 5xx are the server asking us to come back later', () => {
      expect(isTransientFetchError(httpError(429))).toBe(true);
      expect(isTransientFetchError(httpError(500))).toBe(true);
      expect(isTransientFetchError(httpError(503))).toBe(true);
    });

    test('a non-429 4xx is a request defect and must NOT be retried', () => {
      // Retrying a malformed filter just burns the backoff before failing
      // identically. 422 is what USAspending returns for a bad filter body.
      expect(isTransientFetchError(httpError(400))).toBe(false);
      expect(isTransientFetchError(httpError(422))).toBe(false);
    });
  });

  describe('fetchPageWithRetry', () => {
    const ARGS: FetchPageArgs = { startDate: '2025-10-01', endDate: '2026-07-24' };

    test('retries a socket drop and succeeds on a later attempt', async () => {
      const fetchPage = jest
        .fn<typeof import('./sync-federal-assistance-awards.js').fetchPage>()
        .mockRejectedValueOnce(socketError())
        .mockRejectedValueOnce(socketError())
        .mockResolvedValueOnce({ results: [MEDICAID_BLOCK_GRANT], pageMetadata: { hasNext: false } });

      const out = await fetchPageWithRetry(ARGS, { fetchPage, sleep: noSleep });

      expect(out.results).toHaveLength(1);
      expect(fetchPage).toHaveBeenCalledTimes(3);
    });

    test('gives up after the attempt budget and rethrows the last error', async () => {
      const fetchPage = jest
        .fn<typeof import('./sync-federal-assistance-awards.js').fetchPage>()
        .mockRejectedValue(socketError());

      await expect(fetchPageWithRetry(ARGS, { fetchPage, sleep: noSleep })).rejects.toThrow('fetch failed');
      expect(fetchPage).toHaveBeenCalledTimes(4); // FETCH_MAX_ATTEMPTS
    });

    test('a permanent 4xx fails immediately without burning retries', async () => {
      const fetchPage = jest
        .fn<typeof import('./sync-federal-assistance-awards.js').fetchPage>()
        .mockRejectedValue(httpError(422));

      await expect(fetchPageWithRetry(ARGS, { fetchPage, sleep: noSleep })).rejects.toThrow('422');
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    test('backs off between attempts rather than hammering', async () => {
      const waits: number[] = [];
      const fetchPage = jest
        .fn<typeof import('./sync-federal-assistance-awards.js').fetchPage>()
        .mockRejectedValueOnce(socketError())
        .mockResolvedValueOnce({ results: [], pageMetadata: { hasNext: false } });

      await fetchPageWithRetry(ARGS, {
        fetchPage,
        sleep: async (ms: number) => {
          waits.push(ms);
        },
      });

      expect(waits).toEqual([1000]);
    });
  });

  describe('syncAssistanceAwardsWindow partial-failure accounting', () => {
    test('reports rows already committed when retries are exhausted, instead of discarding them', async () => {
      const prisma = makePrismaMock();
      const fetchPage = jest
        .fn<typeof import('./sync-federal-assistance-awards.js').fetchPage>()
        // Page 1 lands two rows...
        .mockResolvedValueOnce({
          results: [MEDICAID_BLOCK_GRANT, NAWCA_COOPERATIVE_AGREEMENT],
          pageMetadata: { hasNext: true, last_record_unique_id: 352819133, last_record_sort_value: 'x' },
        })
        // ...then the far end hangs up, permanently.
        .mockRejectedValue(socketError());

      const counts = await syncAssistanceAwardsWindow(
        prisma,
        { startDate: '2025-10-01', endDate: '2026-07-24', maxPages: 50 },
        { fetchPage, sleep: noSleep },
      );

      // The two rows are REAL and already committed — the ledger must say so.
      expect(counts.inserted).toBe(2);
      expect(prisma.upsertCalls).toHaveLength(2);
      // errors > 0 is what makes runWithSyncRun record `success_with_errors`
      // rather than a clean `success` for an incomplete window.
      expect(counts.errors).toBeGreaterThan(0);
    });

    test('does not throw on exhausted retries — a partial window is reported, not lost', async () => {
      const prisma = makePrismaMock();
      const fetchPage = jest
        .fn<typeof import('./sync-federal-assistance-awards.js').fetchPage>()
        .mockRejectedValue(socketError());

      await expect(
        syncAssistanceAwardsWindow(
          prisma,
          { startDate: '2025-10-01', endDate: '2026-07-24', maxPages: 50 },
          { fetchPage, sleep: noSleep },
        ),
      ).resolves.toEqual({ inserted: 0, updated: 0, skipped: 0, errors: 1 });
    });
  });
});
