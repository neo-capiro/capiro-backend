import { describe, expect, it, jest } from '@jest/globals';
import { HillDayJobWorkerService } from './hillday-job-worker.service.js';

/**
 * Focused witnesses for the durable worker's own boundaries: the claim/renew SQL
 * must be parameter-safe, the claim must also match a legacy `running` row with
 * no lease, and the poller must bound its own concurrency and stop on teardown.
 *
 * Prisma is replaced by a stub that records the statements, so these assertions
 * run without a database. The real statements are additionally exercised against
 * PostgreSQL by the (Release-executed) PG spec.
 */
type Statement = { sql: string; values: unknown[]; kind: 'query' | 'execute' };

function captured() {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const statements: Statement[] = [];
  const prisma = {
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('$PARAM');
      queries.push({ sql, values });
      statements.push({ sql, values, kind: 'query' });
      if (sql.includes('SELECT id FROM ws_hillday_job')) return [{ id: 'job-1' }];
      if (sql.includes('UPDATE ws_hillday_job')) return [{ attempt_count: 7 }];
      return [];
    }),
    $executeRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('$PARAM');
      statements.push({ sql, values, kind: 'execute' });
      return 1;
    }),
  };
  return { prisma, queries, statements };
}

function worker(generation: Record<string, unknown> = {}) {
  const { prisma, queries, statements } = captured();
  const gen = { runClaimedJob: jest.fn(async () => 'complete'), ...generation };
  const service = new HillDayJobWorkerService(prisma as never, gen as never);
  return { service, gen, prisma, queries, statements };
}

describe('WS-10 worker — parameter-safe lease SQL (finding 1)', () => {
  /** Drives the run loop's renew closure so the renewal statement is emitted. */
  const runsRenew = {
    runClaimedJob: jest.fn(async (_id: string, _claim: unknown, renew: () => Promise<boolean>) => {
      await renew();
      return 'complete';
    }),
  };
  const claimStatement = (statements: Statement[]): Statement | undefined =>
    statements.find((s) => /UPDATE ws_hillday_job[\s\S]*attempt_count\s+=\s+attempt_count \+ 1/.test(s.sql));

  it('binds the interval as a number multiplied by a literal interval, not inside a quoted literal', async () => {
    const { service, statements } = worker();
    await service.claim('job-1');
    const claim = claimStatement(statements);
    expect(claim).toBeDefined();
    // The value is a real bound parameter...
    expect(claim!.values).toContain(300);
    // ...and it is NOT sitting inside the quoted interval literal, which would
    // leave `INTERVAL '$1 seconds'` in the real SQL and fail on PostgreSQL.
    expect(claim!.sql).not.toMatch(/INTERVAL\s*'\$PARAM/);
    expect(claim!.sql).toContain("INTERVAL '1 second'");
  });

  it('binds the renewal interval the same way', async () => {
    const { service, statements } = worker(runsRenew);
    await service.claim('job-1');
    const renew = statements.find((s) => s.kind === 'execute' && s.sql.includes('SET lease_expires_at'))!;
    expect(renew).toBeDefined();
    expect(renew.values).toContain(300);
    expect(renew.sql).not.toMatch(/INTERVAL\s*'\$PARAM/);
    expect(renew.sql).toContain("INTERVAL '1 second'");
  });
});

describe('WS-10 worker — legacy null-lease recovery (finding 5)', () => {
  it('discovers a pre-migration running row that has no lease at all', async () => {
    const { service, queries } = worker();
    await service.poll();
    const discovery = queries.find((q) => q.sql.includes('SELECT id FROM ws_hillday_job'))!;
    expect(discovery.sql).toContain('lease_expires_at IS NULL');
  });

  it('claims a pre-migration running row that has no lease at all', async () => {
    const { service, statements } = worker();
    await service.claim('job-1');
    const claim = statements.find((s) => /attempt_count\s+=\s+attempt_count \+ 1/.test(s.sql))!;
    expect(claim.sql).toContain('lease_expires_at IS NULL');
  });
});

describe('WS-10 worker — claim identity (finding 2)', () => {
  it('hands the claim generation returned by the claim statement to the run loop', async () => {
    const { service, gen } = worker();
    await service.claim('job-1');
    const [, claim] = gen.runClaimedJob.mock.calls[0] as unknown as [string, { holder: string; attempt: number }, unknown];
    expect(claim.attempt).toBe(7);
    expect(typeof claim.holder).toBe('string');
  });

  it('reports busy when the claim statement wins no row', async () => {
    const { prisma } = captured();
    prisma.$queryRaw = jest.fn(async (parts: TemplateStringsArray) =>
      (parts.join('$PARAM').includes('SELECT id FROM ws_hillday_job') ? [{ id: 'job-1' }] : [])) as never;
    const gen = { runClaimedJob: jest.fn(async () => 'complete') };
    const service = new HillDayJobWorkerService(prisma as never, gen as never);
    expect(await service.claim('job-1')).toBe('busy');
    expect(gen.runClaimedJob).not.toHaveBeenCalled();
  });
});

describe('WS-10 worker — bounded polling and teardown (finding 6)', () => {
  it('never runs two polls at once, so the real in-flight lanes stay bounded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { service, queries } = worker({
      runClaimedJob: jest.fn(async () => { await gate; return 'complete'; }),
    });
    const first = service.poll();
    const second = service.poll(); // fires while the first is still in flight
    release();
    await Promise.all([first, second]);
    expect(queries.filter((q) => q.sql.includes('SELECT id FROM ws_hillday_job'))).toHaveLength(1);
  });

  it('stops discovering and claiming after teardown', async () => {
    const { service, queries, gen } = worker();
    service.stopPoller();
    await service.poll();
    expect(queries).toHaveLength(0);
    expect(await service.claim('job-1')).toBe('busy');
    expect(gen.runClaimedJob).not.toHaveBeenCalled();
  });

  it('clears its own timer on teardown', () => {
    jest.useFakeTimers();
    try {
      const { service } = worker();
      service.startPoller(5_000);
      expect(jest.getTimerCount()).toBe(1);
      service.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
