/**
 * S-4 — bounded database and tool usage, plus the shared scaling envelope.
 *
 * Mostly a pure unit spec (the semaphore, the deadline, the pagination clamp
 * and the env resolution need no database), with one small real-Postgres
 * section: `SET LOCAL statement_timeout` is the mechanism that makes the slot
 * cap real, and a claim that it is applied is only worth as much as a query
 * that actually hits it.
 */
import { RequestTimeoutException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { MeriHermesDbGovernor, meriHermesSharedDbGovernor } from './meri-hermes-db-governor.js';
import { MeriHermesBrokerService } from './meri-hermes-broker.service.js';
import { MeriHermesBudgetService } from './meri-hermes-budget.service.js';
import { MeriHermesAdmissionControlService } from './meri-hermes-admission-control.service.js';
import { MeriHermesProfileLeaseService } from './meri-hermes-profile-lease.service.js';
import {
  MERI_HERMES_DECLARED_LIMITS,
  meriHermesApiPoolSize,
  meriHermesBoundedPage,
  meriHermesBudgetPeriodDate,
  meriHermesScalingLimits,
  meriHermesTokensToMicroUsd,
  meriHermesUsdToMicroUsd,
} from './meri-hermes-scaling.config.js';

const FIXTURE_URL = 'postgresql://capiro:capiro@localhost:5432/capiro?schema=public&connection_limit=33&pool_timeout=30';

describe('S-4 bounded database and tool usage, and the scaling envelope', () => {
  // =========================================================================
  // The envelope
  // =========================================================================

  describe('configured envelope', () => {
    test('defaults are the decisions.md §4 numbers, and the resolved envelope uses them when nothing is set', () => {
      const limits = meriHermesScalingLimits({});
      expect(limits.maxRunTokens).toBe(50_000);
      expect(limits.tenantDailyTokens).toBe(2_000_000);
      expect(limits.tenantDailyMicroUsd).toBe(25_000_000);
      expect(limits.maxConcurrentRunsGlobal).toBe(8);
      expect(limits.maxConcurrentRunsTenant).toBe(4);
      expect(limits.maxConcurrentRunsScope).toBe(2);
      expect(limits.tenantQueueDepth).toBe(8);
      expect(limits.dbPoolShare).toBe(0.2);
    });

    test('every limit is operator-overridable through its own environment variable', () => {
      const limits = meriHermesScalingLimits({
        MERI_HERMES_MAX_RUN_TOKENS: '1234',
        MERI_HERMES_TENANT_DAILY_TOKENS: '99999',
        MERI_HERMES_TENANT_DAILY_SPEND_USD: '7.5',
        MERI_HERMES_MAX_CONCURRENT_RUNS_GLOBAL: '3',
        MERI_HERMES_MAX_CONCURRENT_RUNS_TENANT: '2',
        MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE: '1',
        MERI_HERMES_TENANT_QUEUE_DEPTH: '5',
        MERI_HERMES_TOOL_DEADLINE_MS: '4321',
        MERI_HERMES_MAX_PAGE_SIZE: '42',
      });
      expect(limits.maxRunTokens).toBe(1234);
      expect(limits.tenantDailyTokens).toBe(99_999);
      expect(limits.tenantDailyMicroUsd).toBe(7_500_000);
      expect(limits.maxConcurrentRunsGlobal).toBe(3);
      expect(limits.maxConcurrentRunsTenant).toBe(2);
      expect(limits.maxConcurrentRunsScope).toBe(1);
      expect(limits.tenantQueueDepth).toBe(5);
      expect(limits.toolDeadlineMs).toBe(4321);
      expect(limits.maxPageSize).toBe(42);
    });

    test('a blank, non-numeric, zero or negative value falls back to the DECLARED default — a typo never removes a cap', () => {
      for (const bad of ['', '   ', 'eight', '0', '-4', 'NaN']) {
        const limits = meriHermesScalingLimits({
          MERI_HERMES_MAX_CONCURRENT_RUNS_GLOBAL: bad,
          MERI_HERMES_TENANT_DAILY_TOKENS: bad,
          MERI_HERMES_DB_POOL_SHARE: bad,
        });
        expect(limits.maxConcurrentRunsGlobal).toBe(MERI_HERMES_DECLARED_LIMITS.maxConcurrentRunsGlobal);
        expect(limits.tenantDailyTokens).toBe(MERI_HERMES_DECLARED_LIMITS.tenantDailyTokens);
        expect(limits.dbPoolShare).toBe(MERI_HERMES_DECLARED_LIMITS.dbPoolShare);
      }
      // A share above 1 is nonsense (more than the whole pool) and is refused too.
      expect(meriHermesScalingLimits({ MERI_HERMES_DB_POOL_SHARE: '2' }).dbPoolShare).toBe(0.2);
    });

    test('money is integer micro-USD throughout, rounded UP, so a partial cent is never free', () => {
      expect(meriHermesUsdToMicroUsd(25)).toBe(25_000_000);
      expect(meriHermesUsdToMicroUsd(0.0000004)).toBe(1);
      expect(meriHermesUsdToMicroUsd(0)).toBe(0);
      expect(meriHermesUsdToMicroUsd(-3)).toBe(0);
      // 50 000 tokens at the derived USD 12.50 / Mtok = USD 0.625.
      expect(meriHermesTokensToMicroUsd(50_000, 12.5)).toBe(625_000);
      expect(Number.isInteger(meriHermesTokensToMicroUsd(37, 12.5))).toBe(true);
    });

    test('the budget period is a UTC day, so replicas in different regions agree on which window they are in', () => {
      // 23:30 in New York on 2026-03-01 is already 2026-03-02 in UTC.
      expect(meriHermesBudgetPeriodDate(new Date('2026-03-02T04:30:00Z'))).toBe('2026-03-02');
      expect(meriHermesBudgetPeriodDate(new Date('2026-03-01T23:59:59Z'))).toBe('2026-03-01');
    });
  });

  // =========================================================================
  // Pool share
  // =========================================================================

  describe('bounded database concurrency — the configured numbers', () => {
    test("the pool size comes from DATABASE_URL's connection_limit, the same number Prisma sizes its pool from", () => {
      expect(meriHermesApiPoolSize({ DATABASE_URL: FIXTURE_URL })).toBe(33);
      expect(meriHermesApiPoolSize({ DATABASE_URL: 'postgresql://u:p@localhost:5432/db' })).toBe(
        MERI_HERMES_DECLARED_LIMITS.dbPoolSize,
      );
      expect(meriHermesApiPoolSize({ DATABASE_URL: 'not a url' })).toBe(MERI_HERMES_DECLARED_LIMITS.dbPoolSize);
      expect(meriHermesApiPoolSize({ MERI_HERMES_DB_POOL_SIZE: '80', DATABASE_URL: FIXTURE_URL })).toBe(80);
    });

    test('20 % of this host’s 33-connection pool is 6 concurrent Hermes operations, leaving 27 of application headroom', () => {
      const limits = meriHermesScalingLimits({ DATABASE_URL: FIXTURE_URL });
      expect(limits.dbPoolSize).toBe(33);
      expect(limits.dbMaxConcurrency).toBe(6);
      expect(limits.dbPoolSize - limits.dbMaxConcurrency).toBe(27);
    });

    test('the share can never floor to zero (which would deadlock) nor exceed the pool', () => {
      expect(meriHermesScalingLimits({ MERI_HERMES_DB_POOL_SIZE: '2', MERI_HERMES_DB_POOL_SHARE: '0.1' }).dbMaxConcurrency).toBe(1);
      expect(meriHermesScalingLimits({ MERI_HERMES_DB_POOL_SIZE: '4', MERI_HERMES_DB_POOL_SHARE: '1' }).dbMaxConcurrency).toBe(4);
    });
  });

  // =========================================================================
  // The semaphore
  // =========================================================================

  describe('MeriHermesDbGovernor semaphore', () => {
    function governor(env: Record<string, string>): MeriHermesDbGovernor {
      const g = new MeriHermesDbGovernor();
      g.env = env;
      g.reset();
      return g;
    }

    test('never more than the configured number of operations are in flight at once', async () => {
      const g = governor({ MERI_HERMES_DB_MAX_CONCURRENCY: '3' });
      let inFlight = 0;
      let observedPeak = 0;
      await Promise.all(
        Array.from({ length: 20 }, () =>
          g.run('probe', async () => {
            inFlight += 1;
            observedPeak = Math.max(observedPeak, inFlight);
            await new Promise((r) => setTimeout(r, 10));
            inFlight -= 1;
          }),
        ),
      );
      expect(observedPeak).toBe(3);
      expect(g.stats()).toMatchObject({ maxConcurrency: 3, inFlight: 0, waiting: 0, peakInFlight: 3, admitted: 20 });
      expect(g.stats().queued).toBe(17);
    });

    test('a slot is released even when the operation throws, so one failure cannot leak capacity', async () => {
      const g = governor({ MERI_HERMES_DB_MAX_CONCURRENCY: '1' });
      await expect(g.run('boom', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(g.stats().inFlight).toBe(0);
      await expect(g.run('fine', async () => 'ok')).resolves.toBe('ok');
    });

    test('waiting is BOUNDED: a waiter that cannot get a slot in time is refused with an actionable error, not queued forever', async () => {
      const g = governor({ MERI_HERMES_DB_MAX_CONCURRENCY: '1', MERI_HERMES_DB_ACQUIRE_TIMEOUT_MS: '60' });
      let releaseHolder: (() => void) | undefined;
      const holder = g.run('holder', () => new Promise<void>((resolve) => { releaseHolder = resolve; }));

      const refused = await g.run('waiter', async () => 'never').catch((e) => e);
      expect(refused).toBeInstanceOf(ServiceUnavailableException);
      const body = (refused as ServiceUnavailableException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('hermes_db_capacity_exhausted');
      expect(String(body.message)).toMatch(/application traffic is deliberately given the remaining headroom/);
      expect(g.stats().refused).toBe(1);

      releaseHolder?.();
      await holder;
    });

    test('waiters are served FIFO, so a burst cannot starve whoever asked first', async () => {
      const g = governor({ MERI_HERMES_DB_MAX_CONCURRENCY: '1', MERI_HERMES_DB_ACQUIRE_TIMEOUT_MS: '5000' });
      const order: string[] = [];
      let releaseHolder: (() => void) | undefined;
      const holder = g.run('holder', () => new Promise<void>((resolve) => { releaseHolder = resolve; }));
      // Let the holder take the only slot before the waiters queue up.
      await new Promise((r) => setImmediate(r));

      const waiters = ['first', 'second', 'third'].map((name) =>
        g.run(name, async () => { order.push(name); }),
      );
      releaseHolder?.();
      await holder;
      await Promise.all(waiters);
      expect(order).toEqual(['first', 'second', 'third']);
    });
  });

  // =========================================================================
  // Deadlines
  // =========================================================================

  describe('tool-call deadlines', () => {
    test('an operation that outlives its deadline is abandoned with an actionable timeout naming the tool', async () => {
      const g = new MeriHermesDbGovernor();
      g.env = { MERI_HERMES_TOOL_DEADLINE_MS: '50' };
      g.reset();
      const error = await g
        .withDeadline('meri_memory_search', () => new Promise((r) => setTimeout(r, 5000)))
        .catch((e) => e);
      expect(error).toBeInstanceOf(RequestTimeoutException);
      const body = (error as RequestTimeoutException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('hermes_tool_deadline_exceeded');
      expect(body.tool).toBe('meri_memory_search');
      expect(body.deadlineMs).toBe(50);
      expect(g.stats().deadlineExceeded).toBe(1);
    });

    test('an operation that finishes inside its deadline is untouched', async () => {
      const g = new MeriHermesDbGovernor();
      g.env = { MERI_HERMES_TOOL_DEADLINE_MS: '2000' };
      g.reset();
      await expect(g.guard('meri_record_turn', async () => 'done')).resolves.toBe('done');
      expect(g.stats().deadlineExceeded).toBe(0);
      expect(g.stats().inFlight).toBe(0);
    });
  });

  // =========================================================================
  // Every broker tool is actually behind the governor
  // =========================================================================

  describe('broker wiring', () => {
    /**
     * Structural, and deliberately so: the point is that NO broker tool reaches
     * the database outside the governor. Spying on `guard` without calling
     * through proves the delegation for every one of the six tools without
     * needing six fully-wired dependency graphs.
     */
    test.each([
      ['recall', 'meri_memory_search', (b: MeriHermesBrokerService, a: never) => b.recall(a, { query: 'q' })],
      ['getAttachment', 'meri_fetch_attachment', (b: MeriHermesBrokerService, a: never) => b.getAttachment(a, 'id')],
      ['recordTurn', 'meri_record_turn', (b: MeriHermesBrokerService, a: never) => b.recordTurn(a, {})],
      [
        'proposeMemory',
        'meri_memory_propose',
        (b: MeriHermesBrokerService, a: never) => b.proposeMemory(a, { key: 'k', value: 'v', scope: 'user_private' }),
      ],
      [
        'publishArtifact',
        'meri_publish_artifact',
        (b: MeriHermesBrokerService, a: never) => b.publishArtifact(a, { title: 't', kind: 'k', bodyText: 'b' }),
      ],
      [
        'requestClarification',
        'meri_request_clarification',
        (b: MeriHermesBrokerService, a: never) => b.requestClarification(a, { question: 'why?' }),
      ],
    ])('%s runs inside the governor as tool %s', async (_method, toolLabel, invoke) => {
      const broker = new MeriHermesBrokerService(
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined as never,
      );
      // A fresh governor for the spy: `dbGovernor` defaults to the PROCESS-WIDE
      // instance (see `meriHermesSharedDbGovernor`), and stubbing a method on
      // that would leak into every other consumer in this worker.
      broker.dbGovernor = new MeriHermesDbGovernor();
      const guard = jest
        .spyOn(broker.dbGovernor, 'guard')
        .mockImplementation(async () => 'guarded' as never);
      await expect(invoke(broker, undefined as never)).resolves.toBe('guarded');
      expect(guard).toHaveBeenCalledWith(toolLabel, expect.any(Function));
      guard.mockRestore();
    });
  });

  // =========================================================================
  // Nest can actually construct these
  // =========================================================================

  describe('dependency-injection metadata', () => {
    /**
     * A REGRESSION GUARD for a failure mode that no other test in this repo
     * would catch. Nest resolves constructor dependencies from the
     * `design:paramtypes` metadata TypeScript emits, and a `import type { X }`
     * erases to `Object` — so a service written with a type-only import of
     * `PrismaService` compiles, typechecks, passes every spec that constructs
     * it by hand, and then fails at APPLICATION BOOT with "Nest can't resolve
     * dependencies". The repo's own DI smoke test (`src/app.module.spec.ts`) is
     * currently unable to run, so nothing else would notice.
     */
    test.each([
      ['MeriHermesBudgetService', MeriHermesBudgetService],
      ['MeriHermesAdmissionControlService', MeriHermesAdmissionControlService],
      ['MeriHermesProfileLeaseService', MeriHermesProfileLeaseService],
    ])('%s declares injectable constructor parameter types, not erased `Object`', (_name, target) => {
      const paramTypes = Reflect.getMetadata('design:paramtypes', target) as unknown[] | undefined;
      expect(paramTypes).toBeDefined();
      expect(paramTypes![0]).toBe(PrismaService);
      expect(paramTypes![1]).toBe(MeriHermesDbGovernor);
      expect(paramTypes).not.toContain(Object);
    });

    test('every consumer shares ONE process-wide governor — a per-consumer semaphore would bound nothing', () => {
      expect(meriHermesSharedDbGovernor()).toBe(meriHermesSharedDbGovernor());
      const shared = meriHermesSharedDbGovernor();
      expect(new MeriHermesBudgetService(undefined as never).governor).toBe(shared);
      expect(new MeriHermesAdmissionControlService(undefined as never).governor).toBe(shared);
      expect(new MeriHermesProfileLeaseService(undefined as never).governor).toBe(shared);
    });
  });

  // =========================================================================
  // Pagination
  // =========================================================================

  describe('explicit query/result limits and pagination', () => {
    const limits = { defaultPageSize: 25, maxPageSize: 100 };

    test('a caller that names no limit gets the configured default rather than an unbounded read', () => {
      expect(meriHermesBoundedPage(undefined, limits)).toMatchObject({ limit: 25, probe: 26, clamped: false });
      expect(meriHermesBoundedPage({}, limits).limit).toBe(25);
      expect(meriHermesBoundedPage({ limit: null }, limits).limit).toBe(25);
    });

    test('a caller that asks for more than the ceiling is CLAMPED, and told it was', () => {
      expect(meriHermesBoundedPage({ limit: 10_000 }, limits)).toMatchObject({ limit: 100, clamped: true });
      expect(meriHermesBoundedPage({ limit: 100 }, limits).clamped).toBe(false);
    });

    test('a nonsense limit falls back to the default instead of erroring or reading everything', () => {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(meriHermesBoundedPage({ limit: bad }, limits).limit).toBe(25);
      }
    });

    test('`probe` is limit + 1, so a caller learns there is a next page without a second COUNT query', () => {
      expect(meriHermesBoundedPage({ limit: 7 }, limits).probe).toBe(8);
    });

    test('a cursor is carried through, and a blank one is normalised to null', () => {
      expect(meriHermesBoundedPage({ cursor: 'abc' }, limits).cursor).toBe('abc');
      expect(meriHermesBoundedPage({ cursor: '   ' }, limits).cursor).toBeNull();
    });
  });

  // =========================================================================
  // statement_timeout — the part that must be proved against a real database
  // =========================================================================

  describe('Postgres statement_timeout (real local fixture database)', () => {
    let prisma: PrismaService;

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
    });
    afterAll(async () => {
      await prisma.$disconnect();
    });

    test('a governed transaction really carries the configured statement_timeout, and a query that outlives it is killed by the database', async () => {
      const g = new MeriHermesDbGovernor();
      g.env = { ...process.env, MERI_HERMES_DB_STATEMENT_TIMEOUT_MS: '300' };
      g.reset();

      const shown = await g.withSystemTx(prisma, 'probe.show', (tx) =>
        tx.$queryRaw<Array<{ statement_timeout: string }>>`SHOW statement_timeout`,
      );
      expect(shown[0]!.statement_timeout).toBe('300ms');

      // Not a claim about patience: Postgres itself aborts this.
      await expect(
        g.withSystemTx(prisma, 'probe.sleep', (tx) => tx.$queryRaw`SELECT pg_sleep(3)`),
      ).rejects.toThrow(/statement timeout|canceling statement/i);

      // And the slot is back — a killed query does not leak capacity.
      expect(g.stats().inFlight).toBe(0);
    });
  });
});
