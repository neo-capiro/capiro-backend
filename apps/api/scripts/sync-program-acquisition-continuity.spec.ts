import {
  decodeContinuityCursor,
  projectProgramAcquisitionContinuity,
  readBoundedContinuityPage,
  readProjectorCheckpoint,
  projectFiniteAwardEnrichment,
  runProgramAcquisitionContinuityCli,
  writesEnabled,
} from './sync-program-acquisition-continuity.js';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ID_1 = '00000000-0000-4000-8000-000000000001';
const ID_2 = '00000000-0000-4000-8000-000000000002';
const ID_3 = '00000000-0000-4000-8000-000000000003';

describe('finite award producer adapter and CLI ownership', () => {
  const awardId = 'CONT_AWD_0001_9700_-NONE-_-NONE-';
  test('binds only full IDs and keys in two bounded read queries, preserving exact clocks', async () => {
    const $queryRaw = jest.fn().mockResolvedValueOnce([{
      awardUniqueId: awardId, piid: '0001', sourceObservedAt: '2026-10-31T12:00:00.000000Z',
      sourceRecord: { generated_internal_id: awardId, 'Award ID': '0001', 'Recipient UEI': null },
    }]).mockResolvedValueOnce([]);
    const $executeRaw = jest.fn(async (_sql: TemplateStringsArray, ..._values: unknown[]) => 0);
    const tx = { $queryRaw, $executeRaw };
    const $transaction = jest.fn(async (work) => work(tx));
    const receipt = await projectFiniteAwardEnrichment({ $queryRaw, $transaction } as never, { awardIds: [awardId], commit: false });
    expect(receipt).toMatchObject({ status: 'VALIDATED', inserted: 0 });
    expect($queryRaw).toHaveBeenCalledTimes(2);
    expect($queryRaw.mock.calls[0]![1]).toEqual([awardId]);
    expect($queryRaw.mock.calls[1]![1]).toEqual([`usaspending|award|${awardId}`]);
    expect($queryRaw.mock.calls[0]![0].join('')).toContain('SS.US');
    expect($queryRaw.mock.calls[1]![0].join('')).toContain("identity_key = 'usaspending|award|' || source_record_id");
    expect($executeRaw.mock.calls[0]![0].join('')).toBe('SET TRANSACTION READ ONLY');
    expect($executeRaw.mock.calls.some(([sql]) => sql.join('').includes('LOCK TABLE'))).toBe(false);
  });

  test('finite CLI disconnects its owned client when the read fails', async () => {
    const priorArgv = process.argv, priorUrl = process.env.DATABASE_URL, priorExit = process.exitCode;
    const directory = mkdtempSync(join(tmpdir(), 'capiro-award-enrichment-fixture-'));
    const file = join(directory, 'cohort.json'); writeFileSync(file, JSON.stringify([awardId]));
    const tx = { $executeRaw: jest.fn(async () => 0), $queryRaw: jest.fn(async () => { throw new Error('synthetic read denied'); }) };
    const client = { $connect: jest.fn(async () => {}), $disconnect: jest.fn(async () => {}),
      $transaction: jest.fn(async (work) => work(tx)) };
    try {
      process.argv = ['node', 'synthetic', '--award-ids-file', file]; process.env.DATABASE_URL = 'synthetic-unused';
      await expect(runProgramAcquisitionContinuityCli(() => client as never)).rejects.toThrow('synthetic read denied');
      expect(client.$connect).toHaveBeenCalledTimes(1); expect(client.$disconnect).toHaveBeenCalledTimes(1);
    } finally {
      process.argv = priorArgv; process.exitCode = priorExit;
      if (priorUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorUrl;
      unlinkSync(file); rmdirSync(directory);
    }
  });

  test('malformed finite CLI arguments refuse before client construction', async () => {
    const prior = process.argv, create = jest.fn();
    try {
      process.argv = ['node', 'synthetic', '--award-ids-file', '--commit'];
      await expect(runProgramAcquisitionContinuityCli(create)).rejects.toThrow(/only/);
      expect(create).not.toHaveBeenCalled();
    } finally { process.argv = prior; }
  });

  test('commit acquires the standard writer lock before its first snapshot read; commit loss reports unknown totals', async () => {
    const events: string[] = [];
    const $executeRaw = jest.fn(async (sql) => { events.push(sql.join('').includes('LOCK TABLE') ? 'writer-lock' : 'setup'); return 0; });
    const $queryRaw = jest.fn().mockImplementationOnce(async () => {
      events.push('source-read'); return [{ awardUniqueId: awardId, piid: '0001', sourceObservedAt: '2026-10-31T12:00:00.000000Z',
        sourceRecord: { generated_internal_id: awardId, 'Award ID': '0001', 'Recipient UEI': null } }];
    }).mockImplementationOnce(async () => { events.push('head-read'); return []; });
    const tx = { $executeRaw, $queryRaw, acquisitionRecordRevision: {
      findUnique: jest.fn(async () => null), create: jest.fn(async () => ({ id: 'synthetic-revision' })),
    } };
    const $transaction = jest.fn(async (work, _options?: { isolationLevel?: string; timeout?: number; maxWait?: number }) => {
      await work(tx); throw new Error('synthetic commit acknowledgement lost');
    });
    const receipt = await projectFiniteAwardEnrichment({ $queryRaw, $transaction } as never,
      { awardIds: [awardId], commit: true, env: { PROGRAM_ACQUISITION_CONTINUITY_ENABLED: 'true' } });
    expect(events.indexOf('writer-lock')).toBeLessThan(events.indexOf('source-read'));
    expect(receipt).toMatchObject({ status: 'TRANSACTION_OUTCOME_UNRESOLVED', inserted: null, existing: null });
    expect(receipt.outcomes[0]?.state).toBe('write_outcome_unresolved');
    expect($transaction).toHaveBeenCalledTimes(1);
    expect($transaction.mock.calls[0]![1]).toMatchObject({ isolationLevel: 'ReadCommitted' });
    const engine = $transaction.mock.calls[0]![1]!;
    expect(engine.timeout! + engine.maxWait!).toBeLessThanOrEqual(15000);
  });

  test('missing lock privilege refuses before reads or writes, never escalating to an owner credential', async () => {
    const tx = { $executeRaw: jest.fn(async (sql) => {
      if (sql.join('').includes('LOCK TABLE')) throw new Error('synthetic lock denied'); return 0;
    }), $queryRaw: jest.fn() };
    const $transaction = jest.fn(async (work) => work(tx));
    await expect(projectFiniteAwardEnrichment({ $transaction } as never,
      { awardIds: [awardId], commit: true, env: { PROGRAM_ACQUISITION_CONTINUITY_ENABLED: 'true' } })).rejects.toThrow('synthetic lock denied');
    expect(tx.$queryRaw).not.toHaveBeenCalled(); expect($transaction).toHaveBeenCalledTimes(1);
  });
});

describe('bounded program acquisition projector', () => {
  test('uses deterministic ID order, cap+1 lookahead, and reports continuation evidence', async () => {
    const findPage = jest.fn(async () => [{ id: ID_1 }, { id: ID_2 }, { id: ID_3 }]);
    const readHighWater = jest.fn(async () => ID_3);
    const page = await readBoundedContinuityPage({
      stream: 'sam', cap: 2, findPage, readHighWater,
    });

    expect(readHighWater).toHaveBeenCalledTimes(1);
    expect(findPage).toHaveBeenCalledWith({ lte: ID_3 }, 3);
    expect(page.items.map((row) => row.id)).toEqual([ID_1, ID_2]);
    expect(page.continuation).toMatchObject({
      hasMore: true,
      afterId: null,
      throughId: ID_3,
      firstId: ID_1,
      lastId: ID_2,
    });
    expect(decodeContinuityCursor(page.continuation.nextCursor!, 'sam')).toEqual({
      v: 1, stream: 'sam', afterId: ID_2, throughId: ID_3,
    });
  });

  test('resumes after the last ID within the original high-water boundary', async () => {
    const first = await readBoundedContinuityPage({
      stream: 'awards', cap: 1, readHighWater: async () => ID_3,
      findPage: async () => [{ id: ID_1 }, { id: ID_2 }],
    });
    const findPage = jest.fn(async () => [{ id: ID_3 }]);
    const readHighWater = jest.fn(async () => { throw new Error('resume must retain original high-water ID'); });
    const resumed = await readBoundedContinuityPage({
      stream: 'awards', cap: 1, cursor: first.continuation.nextCursor!, findPage, readHighWater,
    });

    expect(findPage).toHaveBeenCalledWith({ gt: ID_1, lte: ID_3 }, 2);
    expect(readHighWater).not.toHaveBeenCalled();
    expect(resumed.items.map((row) => row.id)).toEqual([ID_3]);
    expect(resumed.continuation.hasMore).toBe(false);
    expect(resumed.continuation.nextCursor).toBeNull();
  });

  test('rejects a cursor used on the wrong source stream', async () => {
    const page = await readBoundedContinuityPage({
      stream: 'sam', cap: 1, readHighWater: async () => ID_2,
      findPage: async () => [{ id: ID_1 }, { id: ID_2 }],
    });
    await expect(readBoundedContinuityPage({
      stream: 'awards', cap: 1, cursor: page.continuation.nextCursor!,
      readHighWater: async () => ID_2, findPage: async () => [],
    })).rejects.toThrow(/stream-mismatched/);
  });

  test('an empty source is complete and a bounded non-overflow page has no next cursor', async () => {
    const empty = await readBoundedContinuityPage({
      stream: 'sam', cap: 1, readHighWater: async () => null, findPage: async () => [],
    });
    const finalPage = await readBoundedContinuityPage({
      stream: 'awards', cap: 2, readHighWater: async () => ID_2,
      findPage: async () => [{ id: ID_1 }, { id: ID_2 }],
    });
    expect(empty.continuation.hasMore).toBe(false);
    expect(finalPage.items).toHaveLength(2);
    expect(finalPage.continuation).toMatchObject({ hasMore: false, nextCursor: null, throughId: ID_2 });
  });

  test('stores and reads per-source durable checkpoints, and only exact commit+flag enables writes', () => {
    const checkpoint = {
      version: 1,
      sam: { complete: true, cursor: null, throughId: ID_2 },
      awards: { complete: false, cursor: 'encoded-award-cursor', throughId: ID_3 },
    };
    expect(readProjectorCheckpoint({ continuationCheckpoint: checkpoint })).toEqual(checkpoint);
    expect(readProjectorCheckpoint({ continuationCheckpoint: { version: 2 } })).toBeNull();
    expect(writesEnabled(false, { PROGRAM_ACQUISITION_CONTINUITY_ENABLED: 'true' })).toBe(false);
    expect(writesEnabled(true, { PROGRAM_ACQUISITION_CONTINUITY_ENABLED: 'TRUE' })).toBe(false);
    expect(writesEnabled(true, { PROGRAM_ACQUISITION_CONTINUITY_ENABLED: 'true' })).toBe(true);
  });

  test('resumes an incomplete stream from its checkpoint while skipping the completed stream', async () => {
    const awardCursor = Buffer.from(JSON.stringify({
      v: 1, stream: 'awards', afterId: ID_1, throughId: ID_3,
    })).toString('base64url');
    const samFindMany = jest.fn();
    const awardFindMany = jest.fn(async () => []);
    const prisma = {
      syncRun: {
        findFirst: jest.fn().mockResolvedValue({
          stats: {
            continuationCheckpoint: {
              version: 1,
              sam: { complete: true, cursor: null, throughId: ID_2 },
              awards: { complete: false, cursor: awardCursor, throughId: ID_3 },
            },
          },
        }),
        create: jest.fn(),
      },
      samOpportunity: {
        findFirst: jest.fn(),
        findMany: samFindMany,
      },
      federalAward: {
        findFirst: jest.fn(),
        findMany: awardFindMany,
      },
      program: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const summary = await projectProgramAcquisitionContinuity(prisma as never, { commit: false, cap: 10 });

    expect(samFindMany).not.toHaveBeenCalled();
    expect(awardFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { gt: ID_1, lte: ID_3 } },
      take: 11,
      orderBy: [{ id: 'asc' }],
    }));
    expect(summary.sam.continuation).toMatchObject({ hasMore: false, throughId: ID_2 });
    expect(summary.awards.continuation).toMatchObject({ hasMore: false, afterId: ID_1, throughId: ID_3 });
    expect(summary.mode).toBe('DRY_RUN');
    expect(prisma.syncRun.create).not.toHaveBeenCalled();
  });
});
