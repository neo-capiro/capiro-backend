import { describe, expect, jest, test } from '@jest/globals';
import JSZip from 'jszip';
import {
  applyChunk,
  assertFiltersHonoured,
  buildDateChunks,
  buildDownloadRequest,
  parseCsvRows,
  readChunkZip,
  SERVER_ROW_CAP,
  summaryRowToDetail,
  runBackfill,
  waitForDownload,
  type BulkDownloadClient,
} from './backfill-assistance-awards-bulk.js';
import type { ExistingAssistanceAwardRow } from './enrich-assistance-award-details.js';

/**
 * The CSV below is a VERBATIM CUT from a real
 * `POST /api/v2/download/awards/` response captured 2026-07-28 (VT,
 * action_date 2026-01-01..2026-01-31), reduced to the columns this rail reads
 * plus `prime_award_base_transaction_description`, which is kept precisely
 * BECAUSE it contains commas inside quotes and would break a line-splitting
 * parser.
 *
 * Both rows are real awards that exist in `federal_assistance_award` (the join
 * key was matched 5/5 live). Row 1 has a parent UEI and a real funding
 * opportunity number; row 2 has neither, plus the literal "NOT APPLICABLE"
 * sentinel USAspending returns instead of null — stored verbatim, never
 * filtered.
 */
const REAL_SUMMARY_CSV = [
  'assistance_award_unique_key,award_id_fain,award_id_uri,total_obligated_amount,total_non_federal_funding_amount,recipient_parent_uei,recipient_parent_duns,recipient_parent_name,funding_opportunity_number,prime_award_base_transaction_description',
  'ASST_NON_1LICMS330824_075,1LICMS330824,1LICMS330824-3123184788,39362600.00,0.00,LALMDNWSYKT1,,VERMONT DEPARTMENT OF PUBLIC SAFETY,CMS-1LI-11-001,VERMONT MONEY FOLLOWS THE PERSON PROJECT',
  'ASST_NON_693JJ22230000Y001VT2971001_069,693JJ22230000Y001VT2971001,693JJ22230000Y001VT297100101402500,18064773.03,2921255.12,,,,NOT APPLICABLE,"PROJECT TITLE: WILMINGTON-BRATTLEBORO, VT9, BEGINNING AT MM 7.077; PENG, RESURFACING."',
].join('\n');

const REAL_SUBAWARD_CSV = [
  'prime_award_unique_key,subaward_number,subaward_amount',
  'ASST_NON_1LICMS330824_075,SUB-1,1000.00',
  'ASST_NON_1LICMS330824_075,SUB-2,2000.00',
].join('\n');

async function makeZip(members: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, body] of Object.entries(members)) zip.file(name, body);
  return zip.generateAsync({ type: 'uint8array' });
}

const SUMMARY_MEMBER = 'Assistance_PrimeAwardSummaries_2026-07-28_H13M02S59_1.csv';
const SUBAWARD_MEMBER = 'Assistance_Subawards_2026-07-28_H13M03S03_1.csv';

function emptyRow(overrides: Partial<ExistingAssistanceAwardRow>): ExistingAssistanceAwardRow {
  return {
    id: 'row-1',
    awardUniqueId: 'ASST_NON_1LICMS330824_075',
    fain: null,
    uri: null,
    subawardCount: null,
    nonFederalFundingAmount: null,
    fundingOpportunityNumber: null,
    parentRecipientName: null,
    parentRecipientUei: null,
    ...overrides,
  };
}

function fakePrisma(rows: ExistingAssistanceAwardRow[]) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = [];
  return {
    updates,
    prisma: {
      federalAssistanceAward: {
        findMany: jest.fn(async (args: any) => {
          const wanted: string[] = args.where.awardUniqueId.in;
          return rows.filter((r) => wanted.includes(r.awardUniqueId));
        }),
        update: jest.fn(async (args: { where: { id: string }; data: unknown }) => {
          const data = args.data as Record<string, unknown>;
          updates.push({ id: args.where.id, data });
          // Apply the write to the in-memory row, like a real database would.
          // Without this, a second chunk covering the same award would see it
          // still null and "enrich" it twice, so cross-chunk idempotency could
          // never be observed.
          const row = rows.find((r) => r.id === args.where.id);
          if (row) Object.assign(row, data);
          return {};
        }),
      },
    },
  };
}

describe('buildDateChunks', () => {
  test('month-aligns so a resumed run re-requests identical windows', () => {
    expect(buildDateChunks('2026-01-01', '2026-03-31', 1)).toEqual([
      { startDate: '2026-01-01', endDate: '2026-01-31' },
      { startDate: '2026-02-01', endDate: '2026-02-28' },
      { startDate: '2026-03-01', endDate: '2026-03-31' },
    ]);
  });

  test('clamps the final chunk to --end instead of overrunning it', () => {
    expect(buildDateChunks('2026-01-01', '2026-02-14', 1)).toEqual([
      { startDate: '2026-01-01', endDate: '2026-01-31' },
      { startDate: '2026-02-01', endDate: '2026-02-14' },
    ]);
  });

  test('honours a multi-month chunk size', () => {
    expect(buildDateChunks('2026-01-01', '2026-06-30', 3)).toEqual([
      { startDate: '2026-01-01', endDate: '2026-03-31' },
      { startDate: '2026-04-01', endDate: '2026-06-30' },
    ]);
  });

  test('rejects an inverted range and a bad chunk size', () => {
    expect(() => buildDateChunks('2026-03-01', '2026-01-01', 1)).toThrow(/after/);
    expect(() => buildDateChunks('2026-01-01', '2026-03-01', 0)).toThrow(/chunk-months/);
  });
});

describe('buildDownloadRequest', () => {
  test('uses the /download/awards/ filter schema, not the bulk_download one', () => {
    // The sibling endpoint takes `prime_award_types` + `date_range` and silently
    // drops these keys. Getting this wrong yields an unfiltered transaction-level
    // file, so the exact key names are part of the contract.
    const body = buildDownloadRequest({ startDate: '2026-01-01', endDate: '2026-01-31' }, 100_000);
    expect(body).toEqual({
      filters: {
        award_type_codes: ['02', '03', '04', '05'],
        time_period: [
          { start_date: '2026-01-01', end_date: '2026-01-31', date_type: 'action_date' },
        ],
        award_amounts: [{ lower_bound: 100_000 }],
      },
      columns: [],
      file_format: 'csv',
    });
  });

  test('omits award_amounts entirely when no floor is given', () => {
    const body = buildDownloadRequest({ startDate: '2026-01-01', endDate: '2026-01-31' }, null);
    expect((body.filters as Record<string, unknown>).award_amounts).toBeUndefined();
  });
});

describe('assertFiltersHonoured', () => {
  test('accepts the echoed filters the live API actually returns', () => {
    expect(() =>
      assertFiltersHonoured(
        {
          award_type_codes: ['02', '03', '04', '05'],
          time_period: [{ date_type: 'action_date', start_date: 'x', end_date: 'y' }],
          award_amounts: [{ lower_bound: 100_000 }],
        },
        100_000,
      ),
    ).not.toThrow();
  });

  test('refuses to enrich when the server dropped the time window', () => {
    // Observed live: posting this endpoint's filters to /bulk_download/awards/
    // echoed back NO time_period at all and expanded award_type_codes to every
    // contract type. Silently enriching from that file would attribute data from
    // the wrong window.
    expect(() =>
      assertFiltersHonoured({ award_type_codes: ['02'] }, null),
    ).toThrow(/did not honour filter\(s\) time_period/);
  });

  test('refuses when the amount floor was dropped', () => {
    expect(() =>
      assertFiltersHonoured({ award_type_codes: ['02'], time_period: [] }, 100_000),
    ).toThrow(/award_amounts/);
  });
});

describe('parseCsvRows', () => {
  test('keeps a quoted description containing commas in ONE field', () => {
    const rows = parseCsvRows(REAL_SUMMARY_CSV);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.prime_award_base_transaction_description).toContain(
      'WILMINGTON-BRATTLEBORO, VT9',
    );
    // If commas inside quotes leaked, the later columns would be shifted.
    expect(rows[1]!.funding_opportunity_number).toBe('NOT APPLICABLE');
  });

  test('preserves embedded newlines inside a quoted field', () => {
    const rows = parseCsvRows('a,b\n"line1\nline2",second');
    expect(rows).toEqual([{ a: 'line1\nline2', b: 'second' }]);
  });

  test('unescapes doubled quotes', () => {
    expect(parseCsvRows('a\n"say ""hi"""')).toEqual([{ a: 'say "hi"' }]);
  });
});

describe('summaryRowToDetail', () => {
  const rows = parseCsvRows(REAL_SUMMARY_CSV);

  test('maps the award-level non-federal total, not a transaction-level figure', () => {
    // `total_non_federal_funding_amount` is the only non-federal column in the
    // SUMMARIES file. The transactions file's `non_federal_funding_amount` is
    // per-transaction and would understate a multi-transaction award.
    expect(summaryRowToDetail(rows[1]!).non_federal_funding).toBe(2_921_255.12);
  });

  test('a real 0.00 is zero, not null — the award genuinely has no non-federal share', () => {
    expect(summaryRowToDetail(rows[0]!).non_federal_funding).toBe(0);
  });

  test('carries fain, uri, funding opportunity number and parent identity', () => {
    const detail = summaryRowToDetail(rows[0]!);
    expect(detail.fain).toBe('1LICMS330824');
    expect(detail.uri).toBe('1LICMS330824-3123184788');
    expect(detail.funding_opportunity?.number).toBe('CMS-1LI-11-001');
    expect(detail.recipient?.parent_recipient_name).toBe('VERMONT DEPARTMENT OF PUBLIC SAFETY');
    expect(detail.recipient?.parent_recipient_uei).toBe('LALMDNWSYKT1');
  });

  test('stores the "NOT APPLICABLE" sentinel verbatim rather than nulling it', () => {
    expect(summaryRowToDetail(rows[1]!).funding_opportunity?.number).toBe('NOT APPLICABLE');
  });

  test('empty cells become null, never empty strings', () => {
    const detail = summaryRowToDetail(rows[1]!);
    expect(detail.recipient?.parent_recipient_name).toBeNull();
    expect(detail.recipient?.parent_recipient_uei).toBeNull();
  });

  test('a DUNS in the adjacent column can never reach the UEI field', () => {
    // recipient_parent_duns sits at column 44, recipient_parent_uei at 43.
    // asUei rejects a 9-digit DUNS, so a mis-read yields null, not a fake UEI.
    const detail = summaryRowToDetail({
      assistance_award_unique_key: 'ASST_NON_X_1',
      recipient_parent_uei: '123456789',
    });
    expect(detail.recipient?.parent_recipient_uei).toBeNull();
  });
});

describe('readChunkZip', () => {
  test('reads award summaries and counts subawards per prime award', async () => {
    const zip = await makeZip({
      [SUMMARY_MEMBER]: REAL_SUMMARY_CSV,
      [SUBAWARD_MEMBER]: REAL_SUBAWARD_CSV,
    });
    const contents = await readChunkZip(zip);

    expect(contents.summaryRowCount).toBe(2);
    expect(contents.awards.has('ASST_NON_1LICMS330824_075')).toBe(true);
    expect(contents.subawardCounts.get('ASST_NON_1LICMS330824_075')).toBe(2);
    // An award with no subaward rows is ABSENT from the map — not present as 0.
    expect(contents.subawardCounts.has('ASST_NON_693JJ22230000Y001VT2971001_069')).toBe(false);
  });

  test('a subawards-only or contracts-only zip fails loudly', async () => {
    const zip = await makeZip({ 'Contracts_PrimeAwardSummaries_1.csv': 'a\n1' });
    await expect(readChunkZip(zip)).rejects.toThrow(/No Assistance_PrimeAwardSummaries/);
  });

  test('tolerates a download split across multiple summary parts', async () => {
    const [header, row1, row2] = REAL_SUMMARY_CSV.split('\n');
    const zip = await makeZip({
      'Assistance_PrimeAwardSummaries_x_1.csv': `${header}\n${row1}`,
      'Assistance_PrimeAwardSummaries_x_2.csv': `${header}\n${row2}`,
    });
    const contents = await readChunkZip(zip);
    expect(contents.awards.size).toBe(2);
  });
});

describe('applyChunk', () => {
  test('fills only null fields and stamps detailEnrichedAt', async () => {
    const zip = await makeZip({
      [SUMMARY_MEMBER]: REAL_SUMMARY_CSV,
      [SUBAWARD_MEMBER]: REAL_SUBAWARD_CSV,
    });
    const contents = await readChunkZip(zip);
    const { prisma, updates } = fakePrisma([emptyRow({})]);

    const outcome = await applyChunk(prisma, contents, { commit: true });

    expect(outcome.updated).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.data).toMatchObject({
      uri: '1LICMS330824-3123184788',
      nonFederalFundingAmount: 0,
      fundingOpportunityNumber: 'CMS-1LI-11-001',
      parentRecipientName: 'VERMONT DEPARTMENT OF PUBLIC SAFETY',
      parentRecipientUei: 'LALMDNWSYKT1',
      subawardCount: 2,
    });
    expect(updates[0]!.data.detailEnrichedAt).toBeInstanceOf(Date);
  });

  test('never downgrades a value the row already holds', async () => {
    const zip = await makeZip({ [SUMMARY_MEMBER]: REAL_SUMMARY_CSV });
    const contents = await readChunkZip(zip);
    const { prisma, updates } = fakePrisma([
      emptyRow({ parentRecipientName: 'A MORE PRECISE NAME', uri: 'already-set' }),
    ]);

    await applyChunk(prisma, contents, { commit: true });

    expect(updates[0]!.data).not.toHaveProperty('parentRecipientName');
    expect(updates[0]!.data).not.toHaveProperty('uri');
  });

  test('leaves subawardCount null when the chunk carried no subaward rows for it', async () => {
    // The subaward file is filtered by the same window, so "not in this file"
    // does not mean "has no subawards". Writing 0 would assert something the
    // data does not support.
    const zip = await makeZip({ [SUMMARY_MEMBER]: REAL_SUMMARY_CSV });
    const contents = await readChunkZip(zip);
    const { prisma, updates } = fakePrisma([emptyRow({})]);

    await applyChunk(prisma, contents, { commit: true });

    expect(updates[0]!.data).not.toHaveProperty('subawardCount');
  });

  test('an award we never ingested is counted, not inserted', async () => {
    const zip = await makeZip({ [SUMMARY_MEMBER]: REAL_SUMMARY_CSV });
    const contents = await readChunkZip(zip);
    const { prisma, updates } = fakePrisma([]);

    const outcome = await applyChunk(prisma, contents, { commit: true });

    expect(outcome.notHeld).toBe(2);
    expect(outcome.updated).toBe(0);
    expect(updates).toHaveLength(0);
  });

  test('a dry run reports the same enrichment count but writes nothing', async () => {
    const zip = await makeZip({ [SUMMARY_MEMBER]: REAL_SUMMARY_CSV });
    const contents = await readChunkZip(zip);
    const { prisma, updates } = fakePrisma([emptyRow({})]);

    const outcome = await applyChunk(prisma, contents, { commit: false });

    expect(outcome.updated).toBe(1);
    expect(updates).toHaveLength(0);
    expect(prisma.federalAssistanceAward.update).not.toHaveBeenCalled();
  });

  test('a row already carrying every field counts as skipped, not enriched', async () => {
    const zip = await makeZip({ [SUMMARY_MEMBER]: REAL_SUMMARY_CSV });
    const contents = await readChunkZip(zip);
    const { prisma } = fakePrisma([
      emptyRow({
        fain: 'x',
        uri: 'x',
        nonFederalFundingAmount: 1,
        fundingOpportunityNumber: 'x',
        parentRecipientName: 'x',
        parentRecipientUei: 'ABCDEFGHJKLM',
        subawardCount: 3,
      }),
    ]);

    const outcome = await applyChunk(prisma, contents, { commit: true });

    expect(outcome.updated).toBe(0);
    expect(outcome.skipped).toBe(1);
  });
});

describe('waitForDownload', () => {
  const deps = { sleep: async () => {}, now: () => 0 };

  test('returns once the server reports finished', async () => {
    const statuses = ['running', 'running', 'finished'];
    let i = 0;
    const client = {
      status: jest.fn(async () => ({
        status: statuses[i++]!,
        totalRows: 195,
        totalColumns: 100,
        totalSizeKb: 55.4,
        message: null,
      })),
    };
    await expect(waitForDownload(client, 'f.zip', deps)).resolves.toMatchObject({ totalRows: 195 });
    expect(client.status).toHaveBeenCalledTimes(3);
  });

  test('surfaces a server-reported failure instead of polling forever', async () => {
    const client = {
      status: jest.fn(async () => ({
        status: 'failed',
        totalRows: null,
        totalColumns: null,
        totalSizeKb: null,
        message: 'boom',
      })),
    };
    await expect(waitForDownload(client, 'f.zip', deps)).rejects.toThrow(/failed: boom/);
  });

  test('gives up rather than polling past its deadline', async () => {
    let t = 0;
    const client = {
      status: jest.fn(async () => ({
        status: 'running',
        totalRows: null,
        totalColumns: null,
        totalSizeKb: null,
        message: null,
      })),
    };
    await expect(
      waitForDownload(client, 'f.zip', { sleep: async () => {}, now: () => (t += 10 * 60 * 1000) }),
    ).rejects.toThrow(/still "running" after/);
  });
});

describe('runBackfill', () => {
  async function client(overrides: Partial<BulkDownloadClient> = {}): Promise<BulkDownloadClient> {
    const zip = await makeZip({
      [SUMMARY_MEMBER]: REAL_SUMMARY_CSV,
      [SUBAWARD_MEMBER]: REAL_SUBAWARD_CSV,
    });
    return {
      submit: jest.fn(async () => ({
        fileName: 'f.zip',
        fileUrl: 'https://files.usaspending.gov/f.zip',
        echoedFilters: {
          award_type_codes: ['02', '03', '04', '05'],
          time_period: [{}],
          award_amounts: [{ lower_bound: 100_000 }],
        },
      })),
      status: jest.fn(async () => ({
        status: 'finished',
        totalRows: 2,
        totalColumns: 100,
        totalSizeKb: 1,
        message: null,
      })),
      fetchZip: jest.fn(async () => zip),
      ...overrides,
    } as BulkDownloadClient;
  }

  const deps = { sleep: async () => {}, now: () => 0 };

  test('walks every chunk and aggregates counts', async () => {
    const { prisma } = fakePrisma([emptyRow({})]);
    const c = await client();

    const counts = await runBackfill(
      prisma,
      c,
      {
        chunks: buildDateChunks('2026-01-01', '2026-02-28', 1),
        minAmount: 100_000,
        commit: true,
      },
      deps,
    );

    expect(c.submit).toHaveBeenCalledTimes(2);
    // Cross-chunk idempotency: the second chunk covers the same award and finds
    // every field already filled by the first, so it skips rather than rewriting.
    expect(counts.updated).toBe(1);
    expect(counts.skipped).toBe(1);
  });

  test('a truncated chunk at the server row cap fails the run', async () => {
    // This is the one failure mode that would otherwise be recorded as a
    // successful complete pass while silently dropping rows.
    const { prisma } = fakePrisma([emptyRow({})]);
    const c = await client({
      status: jest.fn(async () => ({
        status: 'finished',
        totalRows: SERVER_ROW_CAP,
        totalColumns: 100,
        totalSizeKb: 1,
        message: null,
      })),
    });

    await expect(
      runBackfill(
        prisma,
        c,
        { chunks: buildDateChunks('2026-01-01', '2026-01-31', 1), minAmount: null, commit: true },
        deps,
      ),
    ).rejects.toThrow(/TRUNCATED/);
    expect(c.fetchZip).not.toHaveBeenCalled();
  });

  test('a dropped server-side filter stops the run before anything is downloaded', async () => {
    const { prisma } = fakePrisma([emptyRow({})]);
    const c = await client({
      submit: jest.fn(async () => ({
        fileName: 'f.zip',
        fileUrl: 'https://files.usaspending.gov/f.zip',
        echoedFilters: { award_type_codes: ['02'] },
      })),
    });

    await expect(
      runBackfill(
        prisma,
        c,
        { chunks: buildDateChunks('2026-01-01', '2026-01-31', 1), minAmount: null, commit: true },
        deps,
      ),
    ).rejects.toThrow(/did not honour/);
    expect(c.fetchZip).not.toHaveBeenCalled();
  });
});
