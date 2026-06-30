import {
  runWithSyncRun,
  lastSuccessfulWatermark,
  activeRunStartedAt,
  emptyCounts,
  type SyncRunCapablePrisma,
} from './sync-run.helper.js';

type FindFirstArgs = {
  where?: { status?: string; startedAt?: { gte?: Date } };
};

/**
 * Minimal in-memory mock of the SyncRun prisma surface. Routes `findFirst` by
 * `where.status` so the watermark query (status='success') and the
 * concurrency-guard query (status='running') are answered independently — and
 * honours the guard's `startedAt: { gte }` filter so a stale (zombie) running
 * run correctly does NOT match.
 */
function makePrisma(opts: { lastSuccess?: Date | null; activeRun?: Date | null } = {}) {
  const calls: { create: any[]; update: any[]; findFirst: any[] } = {
    create: [],
    update: [],
    findFirst: [],
  };
  let seq = 0;
  const prisma: SyncRunCapablePrisma = {
    syncRun: {
      async findFirst(args: unknown) {
        calls.findFirst.push(args);
        const where = (args as FindFirstArgs).where ?? {};
        if (where.status === 'running') {
          if (!opts.activeRun) return null;
          const gte = where.startedAt?.gte;
          if (gte && opts.activeRun < gte) return null; // zombie: older than TTL
          return { startedAt: opts.activeRun };
        }
        // watermark query (status='success')
        return opts.lastSuccess ? { startedAt: opts.lastSuccess } : null;
      },
      async create(args: unknown) {
        calls.create.push(args);
        return { id: `run-${++seq}` };
      },
      async update(args: unknown) {
        calls.update.push(args);
        return {};
      },
    },
  };
  return { prisma, calls };
}

describe('runWithSyncRun (Phase 0 shared watermark)', () => {
  test('passes the last successful run startedAt as the incremental since', async () => {
    const wm = new Date('2026-05-30T08:00:00.000Z');
    const { prisma } = makePrisma({ lastSuccess: wm });
    let seenSince: Date | null = null;
    let seenSinceDate: string | null = null;

    await runWithSyncRun(prisma, 'sync-congress', async (ctx) => {
      seenSince = ctx.since;
      seenSinceDate = ctx.sinceDate;
      return { inserted: 5, updated: 2, skipped: 0, errors: 0 };
    });

    expect(seenSince).toEqual(wm);
    expect(seenSinceDate).toBe('2026-05-30');
  });

  test('first-ever run has null since (full pull)', async () => {
    const { prisma } = makePrisma({ lastSuccess: null });
    let seenSince: Date | null = new Date();
    await runWithSyncRun(prisma, 'sync-new', async (ctx) => {
      seenSince = ctx.since;
      return emptyCounts();
    });
    expect(seenSince).toBeNull();
  });

  test('overrideSince wins over the watermark', async () => {
    const wm = new Date('2026-05-30T00:00:00.000Z');
    const { prisma } = makePrisma({ lastSuccess: wm });
    let seenSinceDate: string | null = null;
    await runWithSyncRun(
      prisma,
      'sync-congress',
      async (ctx) => {
        seenSinceDate = ctx.sinceDate;
        return emptyCounts();
      },
      { overrideSince: '2020-01-01' },
    );
    expect(seenSinceDate).toBe('2020-01-01');
  });

  test('records success with row counts', async () => {
    const { prisma, calls } = makePrisma();
    await runWithSyncRun(prisma, 'sync-x', async () => ({
      inserted: 10,
      updated: 3,
      skipped: 1,
      errors: 0,
    }));
    expect(calls.create[0].data).toMatchObject({ source: 'sync-x', status: 'running' });
    expect(calls.update[0].data).toMatchObject({
      status: 'success',
      rowsInserted: 10,
      rowsUpdated: 3,
      errorCount: 0,
    });
  });

  test('partial errors downgrade to success_with_errors', async () => {
    const { prisma, calls } = makePrisma();
    await runWithSyncRun(prisma, 'sync-x', async () => ({
      inserted: 10,
      updated: 0,
      skipped: 0,
      errors: 2,
    }));
    expect(calls.update[0].data.status).toBe('success_with_errors');
    expect(calls.update[0].data.errorCount).toBe(2);
  });

  test('throwing fn records status=error and rethrows', async () => {
    const { prisma, calls } = makePrisma();
    await expect(
      runWithSyncRun(prisma, 'sync-x', async () => {
        throw new Error('upstream 503');
      }),
    ).rejects.toThrow('upstream 503');
    expect(calls.update[0].data.status).toBe('error');
    expect(calls.update[0].data.errorMessage).toContain('upstream 503');
  });
});

describe('runWithSyncRun concurrency guard (P0-T8)', () => {
  test('skips (no-op, no new run) when a recent run is already running', async () => {
    const { prisma, calls } = makePrisma({ activeRun: new Date() });
    let ran = false;
    const counts = await runWithSyncRun(prisma, 'sync-congress', async () => {
      ran = true;
      return { inserted: 9, updated: 9, skipped: 0, errors: 0 };
    });
    expect(ran).toBe(false);
    expect(counts).toEqual(emptyCounts());
    expect(calls.create).toHaveLength(0); // no new SyncRun row opened
  });

  test('proceeds when the only running run is a stale zombie (older than TTL)', async () => {
    const zombie = new Date(Date.now() - 7 * 60 * 60 * 1000); // 7h > default 6h TTL
    const { prisma, calls } = makePrisma({ activeRun: zombie });
    let ran = false;
    await runWithSyncRun(prisma, 'sync-congress', async () => {
      ran = true;
      return emptyCounts();
    });
    expect(ran).toBe(true);
    expect(calls.create).toHaveLength(1);
  });

  test('skipIfRunning:false bypasses the guard and runs anyway', async () => {
    const { prisma, calls } = makePrisma({ activeRun: new Date() });
    let ran = false;
    await runWithSyncRun(
      prisma,
      'sync-congress',
      async () => {
        ran = true;
        return emptyCounts();
      },
      { skipIfRunning: false },
    );
    expect(ran).toBe(true);
    expect(calls.create).toHaveLength(1);
  });
});

describe('activeRunStartedAt', () => {
  test('returns the running run startedAt when within TTL', async () => {
    const at = new Date();
    const { prisma } = makePrisma({ activeRun: at });
    expect(await activeRunStartedAt(prisma, 'sync-x')).toEqual(at);
  });
  test('returns null when no running run', async () => {
    const { prisma } = makePrisma({});
    expect(await activeRunStartedAt(prisma, 'sync-x')).toBeNull();
  });
});

describe('lastSuccessfulWatermark', () => {
  test('returns null when no successful run', async () => {
    const { prisma } = makePrisma({ lastSuccess: null });
    expect(await lastSuccessfulWatermark(prisma, 'sync-x')).toBeNull();
  });
  test('returns the startedAt when present', async () => {
    const wm = new Date('2026-01-15T00:00:00.000Z');
    const { prisma } = makePrisma({ lastSuccess: wm });
    expect(await lastSuccessfulWatermark(prisma, 'sync-x')).toEqual(wm);
  });
});
