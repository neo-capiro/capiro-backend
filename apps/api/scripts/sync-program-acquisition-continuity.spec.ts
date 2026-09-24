import {
  decodeContinuityCursor,
  projectProgramAcquisitionContinuity,
  readBoundedContinuityPage,
  readProjectorCheckpoint,
  writesEnabled,
} from './sync-program-acquisition-continuity.js';

const ID_1 = '00000000-0000-4000-8000-000000000001';
const ID_2 = '00000000-0000-4000-8000-000000000002';
const ID_3 = '00000000-0000-4000-8000-000000000003';

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
