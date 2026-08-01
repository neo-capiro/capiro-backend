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

  test('incomplete run records partial and persists its bounded reason even with zero errors', async () => {
    const { prisma, calls } = makePrisma();
    await runWithSyncRun(prisma, 'sync-sam-opportunities', async () => ({
      inserted: 5000,
      updated: 0,
      skipped: 0,
      errors: 0,
      complete: false,
      incompleteReason: 'SAM.gov single-day window 07/01/2026 exceeded capacity',
    }));
    expect(calls.update[0].data).toMatchObject({
      status: 'partial',
      errorCount: 0,
      errorMessage: 'SAM.gov single-day window 07/01/2026 exceeded capacity',
    });
  });

  test('lastSuccessfulWatermark ignores newer partial and success_with_errors rows', async () => {
    const successAt = new Date('2026-07-01T00:00:00.000Z');
    const partialAt = new Date('2026-07-02T00:00:00.000Z');
    const warningAt = new Date('2026-07-03T00:00:00.000Z');
    const rows = [
      { status: 'success', startedAt: successAt },
      { status: 'partial', startedAt: partialAt },
      { status: 'success_with_errors', startedAt: warningAt },
    ];
    const prisma: SyncRunCapablePrisma = {
      syncRun: {
        async findFirst(args: unknown) {
          const where = (args as { where?: { status?: string } }).where;
          const candidates = rows
            .filter((row) => row.status === where?.status)
            .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
          return candidates[0] ?? null;
        },
        async create() {
          return { id: 'unused' };
        },
        async update() {
          return {};
        },
      },
    };
    expect(await lastSuccessfulWatermark(prisma, 'sync-sam-opportunities')).toEqual(successAt);
  });

  test('success_with_errors persists operator errorMessage when complete', async () => {
    const { prisma, calls } = makePrisma();
    await runWithSyncRun(prisma, 'geocode-facilities', async () => ({
      inserted: 1,
      updated: 0,
      skipped: 0,
      errors: 2,
      errorMessage: 'Census 503 on facility X',
    }));
    expect(calls.update[0].data).toMatchObject({
      status: 'success_with_errors',
      errorCount: 2,
      errorMessage: 'Census 503 on facility X',
    });
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

describe('runWithSyncRun observability (W4.3 / M5-G — pageable failures)', () => {
  function captureMetrics() {
    const lines: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      if (typeof msg === 'string') lines.push(msg);
    });
    return {
      restore: () => spy.mockRestore(),
      metrics: () => lines.filter((l) => l.startsWith('INGESTION_METRIC ')).map((l) => JSON.parse(l.slice('INGESTION_METRIC '.length))),
      skips: () => lines.filter((l) => l.startsWith('INGESTION_SKIP ')),
    };
  }

  test('REGRESSION: a SETUP-phase failure (SyncRun.create throws) emits exactly ONE error metric and rethrows (previously emitted none → never paged)', async () => {
    const cap = captureMetrics();
    const prisma: SyncRunCapablePrisma = {
      syncRun: {
        async findFirst() {
          return null;
        },
        async create() {
          throw new Error('db down at create');
        },
        async update() {
          return {};
        },
      },
    };
    try {
      await expect(
        runWithSyncRun(prisma, 'sync-x', async () => emptyCounts()),
      ).rejects.toThrow('db down at create');
      const m = cap.metrics();
      expect(m).toHaveLength(1);
      expect(m[0].error_count).toBeGreaterThanOrEqual(1);
      expect(m[0].source).toBe('sync-x');
    } finally {
      cap.restore();
    }
  });

  test('an incomplete run emits exactly one metric with complete=false', async () => {
    const cap = captureMetrics();
    const { prisma } = makePrisma();
    try {
      await runWithSyncRun(prisma, 'sync-sam-opportunities', async () => ({
        inserted: 4,
        updated: 0,
        skipped: 0,
        errors: 0,
        complete: false,
        incompleteReason: 'single-day overflow',
      }));
      const metrics = cap.metrics();
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        source: 'sync-sam-opportunities',
        error_count: 0,
        complete: false,
      });
    } finally {
      cap.restore();
    }
  });

  test('an in-fn failure still emits exactly ONE error metric (the nested try must not double-count)', async () => {
    const cap = captureMetrics();
    const { prisma } = makePrisma();
    try {
      await expect(
        runWithSyncRun(prisma, 'sync-x', async () => {
          throw new Error('upstream 503');
        }),
      ).rejects.toThrow('upstream 503');
      const m = cap.metrics();
      expect(m).toHaveLength(1);
      expect(m[0].error_count).toBeGreaterThanOrEqual(1);
    } finally {
      cap.restore();
    }
  });

  test('the success path is byte-identical: exactly ONE non-error metric, no skip line', async () => {
    const cap = captureMetrics();
    const { prisma } = makePrisma();
    try {
      await runWithSyncRun(prisma, 'sync-x', async () => ({
        inserted: 4,
        updated: 1,
        skipped: 0,
        errors: 0,
      }));
      const m = cap.metrics();
      expect(m).toHaveLength(1);
      expect(m[0].error_count).toBe(0);
      expect(m[0].rows_inserted).toBe(4);
      expect(cap.skips()).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });

  test('a skip emits INGESTION_SKIP and NO metric line (byte-identical skip path)', async () => {
    const cap = captureMetrics();
    const { prisma } = makePrisma({ activeRun: new Date() });
    try {
      await runWithSyncRun(prisma, 'sync-x', async () => emptyCounts());
      expect(cap.metrics()).toHaveLength(0);
      expect(cap.skips()).toHaveLength(1);
    } finally {
      cap.restore();
    }
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
