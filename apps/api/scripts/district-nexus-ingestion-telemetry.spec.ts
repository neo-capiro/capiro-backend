import { PrismaClient } from '@prisma/client';
import { main as acs } from './sync-district-economic-acs.js';
import { main as cbp } from './sync-district-economic-cbp.js';
import { main as lodes } from './sync-district-economic-lodes.js';
import {
  main as tango,
  parseArgs,
  runSubawardSync,
  type SubawardCheckpoint,
} from './sync-tango-subawards.js';
import { writeEconomicFacts, recordEconomicSourceUnavailable } from './district-economic-source.js';
import { TangoSubawardClient } from '../src/external/tango/tango-subaward.client.js';

jest.mock('@prisma/client', () => ({
  ...jest.requireActual('@prisma/client'),
  PrismaClient: jest.fn(),
}));
jest.mock('./district-economic-source.js', () => ({
  ...jest.requireActual('./district-economic-source.js'),
  writeEconomicFacts: jest.fn(),
  recordEconomicSourceUnavailable: jest.fn(),
}));
jest.mock('../src/external/tango/tango-subaward.client.js', () => ({
  TangoSubawardClient: jest.fn(),
}));

const prisma = {
  syncRun: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  $queryRaw: jest.fn(),
  $disconnect: jest.fn(),
};
const env = { ...process.env };
const argv = process.argv;
let log: jest.SpyInstance;
let fetchMock: jest.SpyInstance;
function metrics() {
  return log.mock.calls.flatMap(([line]) => {
    if (typeof line !== 'string' || !line.startsWith('{')) return [];
    const parsed = JSON.parse(line);
    return parsed.event === 'INGESTION_METRIC' ? [parsed] : [];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...env, DRY_RUN: 'false', TANGO_API_KEY: 'test-secret' };
  process.argv = ['node', 'test'];
  delete process.env.LODES_DISTRICT_AGGREGATE;
  prisma.syncRun.findFirst.mockResolvedValue(null);
  prisma.syncRun.create.mockResolvedValue({ id: 'run-1' });
  prisma.syncRun.update.mockResolvedValue({});
  prisma.$disconnect.mockResolvedValue(undefined);
  prisma.$queryRaw.mockResolvedValue([]);
  jest.mocked(PrismaClient).mockImplementation(() => prisma as never);
  jest.mocked(writeEconomicFacts).mockResolvedValue({
    runId: 'economic-1',
    rowsSeen: 3,
    rowsWritten: 3,
    rowsRejected: 0,
    status: 'success',
  });
  jest.mocked(recordEconomicSourceUnavailable).mockResolvedValue({
    runId: 'economic-1',
    rowsSeen: 0,
    rowsWritten: 0,
    rowsRejected: 0,
    status: 'unavailable',
  });
  log = jest.spyOn(console, 'log').mockImplementation(() => {});
  fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => [
      ['state', 'congressional district'],
      ['12', '08'],
    ],
  } as Response);
});
afterEach(() => {
  log.mockRestore();
  fetchMock.mockRestore();
  process.env = { ...env };
  process.argv = argv;
});

describe('real entrypoint → shared SyncRun → INGESTION_METRIC', () => {
  test.each([
    ['acs', acs],
    ['cbp', cbp],
  ] as const)('%s reports committed counts', async (source, main) => {
    await main();
    expect(metrics()).toEqual([
      expect.objectContaining({
        source: `sync-district-economic-${source}`,
        rows_updated: 3,
        error_count: 0,
        complete: true,
      }),
    ]);
    expect(prisma.syncRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'success' }),
      }),
    );
  });
  test.each([
    ['acs', acs],
    ['cbp', cbp],
    ['lodes', lodes],
  ] as const)(
    '%s fetch failure before writing still emits one error metric',
    async (source, main) => {
      process.env.LODES_DISTRICT_AGGREGATE = 'https://example.test/lodes.csv';
      fetchMock.mockRejectedValue(new Error('network unavailable'));
      await expect(main()).rejects.toThrow('network unavailable');
      expect(metrics()).toEqual([
        expect.objectContaining({
          source: `sync-district-economic-${source}`,
          error_count: 1,
        }),
      ]);
      expect(writeEconomicFacts).not.toHaveBeenCalled();
      expect(prisma.$disconnect).toHaveBeenCalled();
    },
  );
  test('parser rejections are reported as errors without pretending the commit failed', async () => {
    jest.mocked(writeEconomicFacts).mockResolvedValue({
      runId: 'r',
      rowsSeen: 3,
      rowsWritten: 2,
      rowsRejected: 1,
      status: 'success_with_errors',
    });
    await acs();
    expect(metrics()[0]).toMatchObject({ rows_updated: 2, error_count: 1 });
    expect(prisma.syncRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'success_with_errors',
          errorCount: 1,
        }),
      }),
    );
  });
  test('missing LODES configuration reports unavailable with an error metric, never success', async () => {
    await lodes();
    expect(recordEconomicSourceUnavailable).toHaveBeenCalled();
    expect(metrics()).toEqual([
      expect.objectContaining({
        source: 'sync-district-economic-lodes',
        error_count: 1,
        complete: false,
      }),
    ]);
    expect(writeEconomicFacts).not.toHaveBeenCalled();
  });
  test('dry-run counts and SyncRun cannot advance the committed source watermark', async () => {
    delete process.env.DRY_RUN;
    jest.mocked(writeEconomicFacts).mockResolvedValue({
      runId: 'r',
      rowsSeen: 3,
      rowsWritten: 0,
      rowsRejected: 0,
      status: 'success',
    });
    await acs();
    expect(metrics()[0]).toMatchObject({
      source: 'sync-district-economic-acs:dry-run',
      rows_updated: 0,
      rows_inserted: 0,
      complete: false,
    });
    expect(writeEconomicFacts).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ dryRun: true }),
      expect.any(Array),
    );
  });
  test('DB setup failure reports one metric even before a SyncRun can be created', async () => {
    prisma.syncRun.findFirst.mockRejectedValue(new Error('database unavailable'));
    await expect(acs()).rejects.toThrow('database unavailable');
    expect(metrics()).toHaveLength(1);
    expect(metrics()[0].error_count).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('Tango 429 is rethrown and emits exactly one error metric', async () => {
    process.argv.push('--commit', '--limit=500');
    jest.mocked(TangoSubawardClient).mockImplementation(
      () =>
        ({
          listSubawards: jest.fn().mockRejectedValue(new Error('Tango 429: daily limit')),
        }) as never,
    );
    await expect(tango()).rejects.toThrow('429');
    expect(metrics()).toEqual([
      expect.objectContaining({
        source: 'sync-tango-subawards',
        error_count: 1,
      }),
    ]);
  });
  test('Tango missing credentials is observable before contacting the provider', async () => {
    delete process.env.TANGO_API_KEY;
    await expect(tango()).rejects.toThrow('No TANGO_API_KEY');
    expect(metrics()[0]).toMatchObject({
      source: 'sync-tango-subawards:dry-run',
      error_count: 1,
    });
    expect(TangoSubawardClient).not.toHaveBeenCalled();
  });
  test('Tango incomplete bounded dry run stays partial and writes no checkpoint', async () => {
    process.argv.push('--limit=1');
    jest.mocked(TangoSubawardClient).mockImplementation(
      () =>
        ({
          listSubawards: jest.fn().mockResolvedValue({
            items: [{ key: 'a' }],
            nextPage: 2,
            totalCount: 10,
            rate: null,
          }),
        }) as never,
    );
    await tango();
    expect(metrics()[0]).toMatchObject({
      source: 'sync-tango-subawards:dry-run',
      rows_updated: 0,
      rows_inserted: 0,
      complete: false,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1); // checkpoint read only
  });
});

test("a committed page survives the next page's 429 and resumes there without repeating page one", async () => {
  let checkpoint: SubawardCheckpoint | null = null;
  const listSubawards = jest
    .fn()
    .mockResolvedValueOnce({
      items: [{ key: 'a' }],
      nextPage: 2,
      totalCount: 2,
      rate: null,
    })
    .mockRejectedValueOnce(new Error('429'));
  const deps = {
    gateway: { configured: true, listSubawards },
    readCheckpoint: async () => checkpoint,
    writeCheckpoint: async (
      _key: string,
      next: Omit<SubawardCheckpoint, 'rowsProcessed'> & {
        rowsProcessed: number;
      },
    ) => {
      checkpoint = { ...next, rowsProcessed: BigInt(next.rowsProcessed) };
    },
    upsert: jest.fn(async () => 'written' as const),
  };
  await expect(runSubawardSync(deps, parseArgs(['--commit', '--limit=500']))).rejects.toThrow(
    '429',
  );
  expect(checkpoint).toMatchObject({
    nextPage: 2,
    completeness: 'in_progress',
  });
  listSubawards.mockClear().mockResolvedValue({
    items: [{ key: 'b' }],
    nextPage: null,
    totalCount: 2,
    rate: null,
  });
  await runSubawardSync(deps, parseArgs(['--commit', '--limit=500']));
  expect(listSubawards.mock.calls[0][0]).toMatchObject({ page: 2 });
  expect(deps.upsert).toHaveBeenCalledTimes(2);
});
