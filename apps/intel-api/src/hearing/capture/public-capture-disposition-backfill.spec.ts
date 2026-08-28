/**
 * Unit coverage for the historical disposition-backfill's flag/limit
 * validation and the readiness-shaped selection contract, without touching
 * Postgres (that side is proven in the disposable-DB integration spec).
 */
import { runPublicCaptureTask, type DispositionBackfillSummary } from './public-capture-task-runner.js';

function fakePrisma(rows: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    prisma: {
      $queryRawUnsafe: jest.fn(async (sql: string, ...params: unknown[]) => {
        calls.push({ sql, params });
        return rows;
      }),
    } as any,
  };
}

describe('disposition-backfill flag validation (unit, no DB)', () => {
  it('rejects a --limit above the hard operator-safety ceiling', async () => {
    const { prisma } = fakePrisma([]);
    await expect(
      runPublicCaptureTask('disposition-backfill', ['--limit=501'], { prisma, log: () => undefined }),
    ).rejects.toThrow(/limit must be at most/);
  });

  it('rejects a malformed --cursor', async () => {
    const { prisma } = fakePrisma([]);
    await expect(
      runPublicCaptureTask('disposition-backfill', ['--cursor=not-a-valid-cursor'], {
        prisma,
        log: () => undefined,
      }),
    ).rejects.toThrow(/--cursor must be/);
  });

  it('defaults lookback-days to 60 and limit to 25 when unset', async () => {
    const { prisma, calls } = fakePrisma([]);
    const result = await runPublicCaptureTask('disposition-backfill', [], {
      prisma,
      log: () => undefined,
    });
    const summary = result.results[0] as unknown as DispositionBackfillSummary;
    expect(summary.lookbackDays).toBe(60);
    expect(summary.limit).toBe(25);
    // Confirms the selection query actually ran with a bound window (not a
    // silent no-op) even though the fake Prisma returns zero rows.
    expect(calls.length).toBeGreaterThan(0);
  });

  it('scanning zero candidates returns an all-zero summary, not an error', async () => {
    const { prisma } = fakePrisma([]);
    const result = await runPublicCaptureTask('disposition-backfill', ['--lookback-days=30', '--limit=10'], {
      prisma,
      log: () => undefined,
    });
    const summary = result.results[0] as unknown as DispositionBackfillSummary;
    expect(summary.scanned).toBe(0);
    expect(summary.attempted).toBe(0);
    expect(summary.terminallyDispositioned).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(summary.nextCursor).toBeNull();
  });
});
