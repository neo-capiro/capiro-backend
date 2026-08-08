import type { TangoSubawardGateway } from '../src/external/tango/tango-subaward.types.js';
import { parseArgs, runSubawardSync, type SubawardCheckpoint } from './sync-tango-subawards.js';

function checkpoint(): SubawardCheckpoint {
  return {
    windowStart: null,
    windowEnd: new Date('2026-08-08T00:00:00.000Z'),
    nextPage: 1,
    completeness: 'complete',
    rowsProcessed: 0n,
  };
}

describe('sync-tango-subawards', () => {
  it('is dry-run by default', () => {
    expect(parseArgs([]).commit).toBe(false);
  });

  it('requires an explicit acknowledgement for a first unbounded commit', async () => {
    const gateway: TangoSubawardGateway = {
      configured: true,
      listSubawards: jest.fn(),
    };
    await expect(
      runSubawardSync(
        {
          gateway,
          readCheckpoint: async () => null,
          writeCheckpoint: async () => undefined,
          upsert: async () => 'written',
        },
        parseArgs(['--commit']),
      ),
    ).rejects.toThrow('--allow-full');
    expect(gateway.listSubawards).not.toHaveBeenCalled();
  });

  it('walks every page and writes a complete checkpoint', async () => {
    const gateway: TangoSubawardGateway = {
      configured: true,
      listSubawards: jest
        .fn()
        .mockResolvedValueOnce({ items: [{ key: 'a' }], totalCount: 2, nextPage: 2, rate: null })
        .mockResolvedValueOnce({
          items: [{ key: 'b' }],
          totalCount: 2,
          nextPage: null,
          rate: null,
        }),
    };
    const checkpoints: Array<{ completeness: string; nextPage: number }> = [];
    const summary = await runSubawardSync(
      {
        gateway,
        readCheckpoint: async () => checkpoint(),
        writeCheckpoint: async (_key, state) => {
          checkpoints.push({ completeness: state.completeness, nextPage: state.nextPage });
        },
        upsert: async () => 'written',
        now: () => new Date('2026-08-09T00:00:00.000Z'),
      },
      parseArgs(['--commit']),
    );
    expect(summary).toMatchObject({
      processed: 2,
      mapped: 2,
      written: 2,
      completeness: 'complete',
    });
    expect(checkpoints).toEqual([
      { completeness: 'in_progress', nextPage: 2 },
      { completeness: 'complete', nextPage: 1 },
    ]);
  });

  it('does not write rows or checkpoints during a dry run', async () => {
    const writes = jest.fn();
    const upserts = jest.fn();
    const summary = await runSubawardSync(
      {
        gateway: {
          configured: true,
          listSubawards: async () => ({
            items: [{ key: 'a' }],
            totalCount: 1,
            nextPage: null,
            rate: null,
          }),
        },
        readCheckpoint: async () => null,
        writeCheckpoint: writes,
        upsert: upserts,
      },
      parseArgs([]),
    );
    expect(summary).toMatchObject({ mapped: 1, written: 0, commit: false });
    expect(writes).not.toHaveBeenCalled();
    expect(upserts).not.toHaveBeenCalled();
  });
});
