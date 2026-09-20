/**
 * S-1 — distributed budgets with atomic reservations. Real local Postgres.
 *
 * Runs against the LOCAL fixture database only (container `capiro-postgres`) —
 * never a remote/production database. Every fixture id is a fresh
 * `randomUUID()` and everything is cascade-deleted through its fixture tenant
 * in `afterAll`, so repeated runs are idempotent and safe on a database shared
 * with other local sessions and worktrees.
 *
 * The thing under test is a per-tenant, per-UTC-DAY counter, so the tests are
 * isolated from each other by DAY rather than by tenant: one fixture tenant,
 * and each test passes its own synthetic `now`. That is real isolation (the
 * counter's primary key is `(tenant_id, period_date)`) and it avoids creating a
 * dozen tenants whose cascade deletion dominates the suite's runtime.
 *
 * The limits are driven through the same env variables an operator would use,
 * with small values, so the tests exercise the real code path rather than a
 * test-only branch. That the DEFAULTS are the numbers declared in
 * decisions.md §4 is asserted separately, in the first test.
 */
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  MeriHermesBudgetExhaustedError,
  MeriHermesBudgetService,
  MeriHermesRunTokenBudgetExhaustedError,
} from './meri-hermes-budget.service.js';
import { MeriHermesDbGovernor } from './meri-hermes-db-governor.js';
import { MERI_HERMES_DECLARED_LIMITS } from './meri-hermes-scaling.config.js';
import type { MeriHermesUsage } from './hermes-runtime.contracts.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-scaling-budget.integration.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-scaling-budget.integration.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

const usage = (totalTokens: number, costUsd: number | null = null): MeriHermesUsage => ({
  inputTokens: Math.floor(totalTokens / 2),
  outputTokens: Math.ceil(totalTokens / 2),
  totalTokens,
  costUsd,
});

describe('S-1 distributed budgets with atomic reservations (real local Postgres)', () => {
  let prisma: PrismaService;
  let tenantId: string;
  /** Distinct synthetic UTC day per test — see the file header for why. */
  let dayCounter = 0;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    tenantId = randomUUID();
    await prisma.withSystem((tx) =>
      tx.tenant.create({
        data: {
          id: tenantId,
          slug: `meri-hermes-budget-spec-${tenantId}`,
          name: 'Meri Hermes budget spec fixture',
          status: 'active',
        },
      }),
    );
  });

  afterAll(async () => {
    // Cascades: tenant -> meri_agent_budget_periods / meri_agent_run_reservations.
    await prisma.withSystem((tx) => tx.tenant.delete({ where: { id: tenantId } })).catch(() => undefined);
    await prisma.$disconnect();
  });

  /** A fresh budget window: same tenant, a day nothing else has touched. */
  function nextDay(): Date {
    dayCounter += 1;
    return new Date(Date.UTC(2031, 0, dayCounter, 12, 0, 0));
  }

  /**
   * A budget service whose envelope comes from `overrides`. A fresh governor
   * per service with a generous concurrency so the concurrency tests actually
   * race in Postgres rather than being serialized by S-4's own semaphore —
   * which is a different control, tested in its own spec.
   */
  function budgetService(overrides: Record<string, string>): MeriHermesBudgetService {
    const governor = new MeriHermesDbGovernor();
    governor.env = { ...process.env, MERI_HERMES_DB_MAX_CONCURRENCY: '24', ...overrides };
    const service = new MeriHermesBudgetService(prisma, governor);
    service.env = { ...process.env, ...overrides };
    return service;
  }

  const SMALL = {
    MERI_HERMES_MAX_RUN_TOKENS: '1000',
    MERI_HERMES_TENANT_DAILY_TOKENS: '3000',
  };

  function reserveArgs(now: Date, runId = randomUUID()) {
    return {
      runId,
      tenantId,
      scopeId: `tenant:${tenantId}:user:${randomUUID()}`,
      conversationId: randomUUID(),
      now,
    };
  }

  // -------------------------------------------------------------------------

  test('1. the DEFAULT envelope is exactly the one declared in decisions.md §4 — no invented numbers', () => {
    expect(MERI_HERMES_DECLARED_LIMITS.maxRunTokens).toBe(50_000);
    expect(MERI_HERMES_DECLARED_LIMITS.tenantDailyTokens).toBe(2_000_000);
    expect(MERI_HERMES_DECLARED_LIMITS.tenantDailyMicroUsd).toBe(25_000_000); // USD 25.00
    expect(MERI_HERMES_DECLARED_LIMITS.maxConcurrentRunsGlobal).toBe(8);
    expect(MERI_HERMES_DECLARED_LIMITS.maxConcurrentRunsTenant).toBe(4);
    expect(MERI_HERMES_DECLARED_LIMITS.maxConcurrentRunsScope).toBe(2);
    expect(MERI_HERMES_DECLARED_LIMITS.tenantQueueDepth).toBe(8);
    expect(MERI_HERMES_DECLARED_LIMITS.dbPoolShare).toBe(0.2);
    // The token→money rate is DERIVED from the two declared ceilings so both
    // bind at the same moment, rather than being a price anybody made up.
    expect(
      (MERI_HERMES_DECLARED_LIMITS.tenantDailyMicroUsd / 1_000_000) /
        (MERI_HERMES_DECLARED_LIMITS.tenantDailyTokens / 1_000_000),
    ).toBeCloseTo(MERI_HERMES_DECLARED_LIMITS.usdPerMillionTokens, 6);
  });

  test('2. ATOMIC: 12 concurrent admissions against a daily budget that fits 3 admit exactly 3, and the counter lands on the cap', async () => {
    const day = nextDay();
    const budgets = budgetService(SMALL);
    const attempts = 12;

    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        budgets
          .reserveAdmission(reserveArgs(day))
          .then(() => 'admitted' as const)
          .catch((error) => {
            if (error instanceof MeriHermesBudgetExhaustedError) return 'refused' as const;
            throw error;
          }),
      ),
    );

    expect(results.filter((r) => r === 'admitted')).toHaveLength(3);
    expect(results.filter((r) => r === 'refused')).toHaveLength(attempts - 3);

    const snapshot = await budgets.snapshot(tenantId, day);
    // Exactly at the cap: never over it, and never short of it either — a
    // read-then-write implementation would produce both failure modes.
    expect(snapshot.committedTokens).toBe(3000);
    expect(snapshot.capTokens).toBe(3000);
    expect(snapshot.remainingTokens).toBe(0);
    expect(snapshot.admittedRuns).toBe(3);
    expect(snapshot.refusedAdmissions).toBe(attempts - 3);
  });

  test('3. reconciliation corrects an OVER-estimate at terminal: the released headroom lets a previously-refused admission through', async () => {
    const day = nextDay();
    const budgets = budgetService(SMALL);
    const a = reserveArgs(day);
    const b = reserveArgs(day);
    const c = reserveArgs(day);
    await budgets.reserveAdmission(a);
    await budgets.reserveAdmission(b);
    await budgets.reserveAdmission(c);

    // Full: the next admission is refused.
    await expect(budgets.reserveAdmission(reserveArgs(day))).rejects.toBeInstanceOf(
      MeriHermesBudgetExhaustedError,
    );

    // Two of the three runs finish having used a fraction of their estimate.
    const first = await budgets.reconcile({ runId: a.runId, tenantId, usage: usage(250) });
    expect(first).toMatchObject({ reconciled: true, estimatedTokens: 1000, actualTokens: 250, releasedTokens: 750 });
    await budgets.reconcile({ runId: b.runId, tenantId, usage: usage(250) });

    const afterRelease = await budgets.snapshot(tenantId, day);
    // 3000 committed − 2000 of estimate + 500 of actual.
    expect(afterRelease.committedTokens).toBe(1500);
    expect(afterRelease.settledTokens).toBe(500);
    expect(afterRelease.settledRuns).toBe(2);

    // The admission that was refused a moment ago now fits.
    const admitted = await budgets.reserveAdmission(reserveArgs(day));
    expect(admitted.reused).toBe(false);
    expect((await budgets.snapshot(tenantId, day)).committedTokens).toBe(2500);
  });

  test('4. reconciliation corrects an UNDER-estimate too: a run that reports MORE than it reserved is charged the difference', async () => {
    const day = nextDay();
    const budgets = budgetService(SMALL);
    const a = reserveArgs(day);
    await budgets.reserveAdmission(a);
    expect((await budgets.snapshot(tenantId, day)).committedTokens).toBe(1000);

    // The provider's final usage report exceeds the reservation — the stop is
    // not instantaneous, so this is a real case, not a hypothetical one.
    const result = await budgets.reconcile({ runId: a.runId, tenantId, usage: usage(1750) });
    expect(result).toMatchObject({ reconciled: true, estimatedTokens: 1000, actualTokens: 1750 });
    expect(result.releasedTokens).toBe(-750); // negative = charged, not released

    const snapshot = await budgets.snapshot(tenantId, day);
    expect(snapshot.committedTokens).toBe(1750);
    expect(snapshot.settledTokens).toBe(1750);
  });

  test('5. reconciliation is IDEMPOTENT: the competing terminal paths of one run settle the tenant counters exactly once', async () => {
    const day = nextDay();
    const budgets = budgetService(SMALL);
    const a = reserveArgs(day);
    await budgets.reserveAdmission(a);

    const [first, ...rest] = await Promise.all([
      budgets.reconcile({ runId: a.runId, tenantId, usage: usage(400) }),
      budgets.reconcile({ runId: a.runId, tenantId, usage: usage(400) }),
      budgets.reconcile({ runId: a.runId, tenantId, usage: usage(400) }),
    ]);
    const winners = [first, ...rest].filter((r) => r.reconciled);
    expect(winners).toHaveLength(1);

    const snapshot = await budgets.snapshot(tenantId, day);
    expect(snapshot.committedTokens).toBe(400); // 1000 − 1000 + 400, applied once
    expect(snapshot.settledTokens).toBe(400);
    expect(snapshot.settledRuns).toBe(1);
  });

  test('6. an EXHAUSTED tenant refuses NEW admission with an actionable error, while runs already in flight keep drawing and finish', async () => {
    const day = nextDay();
    const budgets = budgetService(SMALL);
    const inFlight = reserveArgs(day);
    await budgets.reserveAdmission(inFlight);
    await budgets.reserveAdmission(reserveArgs(day));
    await budgets.reserveAdmission(reserveArgs(day));

    // NEW admission: refused, with something a person can act on.
    const refusal = await budgets.reserveAdmission(reserveArgs(day)).catch((e) => e);
    expect(refusal).toBeInstanceOf(MeriHermesBudgetExhaustedError);
    const error = refusal as MeriHermesBudgetExhaustedError;
    expect(error.code).toBe('hermes_budget_exhausted');
    expect(error.ceiling).toBe('tenant_daily_tokens');
    expect(error.detail.cap).toBe(3000);
    expect(error.detail.current).toBe(3000);
    expect(Date.parse(error.detail.resetsAt)).toBeGreaterThan(Date.now() - 24 * 3600_000);
    expect(error.message).toMatch(/Runs already in progress will finish normally/);
    expect(error.message).toMatch(/resets at/);

    // IN-FLIGHT: unaffected. It draws against its own parent reservation, which
    // was granted before the window closed, and is never re-tested against the
    // tenant day counters.
    const draw = await budgets.drawRunTokens({ runId: inFlight.runId, tenantId, callPath: 'turn', tokens: 400 });
    expect(draw).toMatchObject({ admitted: true, drawnTokens: 400 });
    const settled = await budgets.reconcile({ runId: inFlight.runId, tenantId, usage: usage(400) });
    expect(settled.reconciled).toBe(true);
  });

  test('7. the per-run cap is ATOMIC too: 10 concurrent draws of 200 against a 1000-token run admit exactly 5', async () => {
    const day = nextDay();
    const budgets = budgetService(SMALL);
    const a = reserveArgs(day);
    await budgets.reserveAdmission(a);

    const draws = await Promise.all(
      Array.from({ length: 10 }, () =>
        budgets.drawRunTokens({ runId: a.runId, tenantId, callPath: 'turn', tokens: 200 }),
      ),
    );
    expect(draws.filter((d) => d.admitted)).toHaveLength(5);
    expect(draws.filter((d) => !d.admitted)).toHaveLength(5);

    const reservation = await budgets.getReservation(tenantId, a.runId);
    expect(reservation?.drawnTokens).toBe(1000);
    expect(reservation?.drawnTokens).toBeLessThanOrEqual(reservation!.maxRunTokens);
  });

  test('8. EVERY enabled call path draws on the SAME parent reservation — turn, status poll and retry share one counter', async () => {
    const day = nextDay();
    const budgets = budgetService(SMALL);
    const a = reserveArgs(day);
    await budgets.reserveAdmission(a);

    await budgets.drawRunTokens({ runId: a.runId, tenantId, callPath: 'turn', tokens: 400 });
    await budgets.drawRunTokens({ runId: a.runId, tenantId, callPath: 'status_poll', tokens: 300 });
    await budgets.drawRunTokens({ runId: a.runId, tenantId, callPath: 'retry', tokens: 300 });

    const reservation = await budgets.getReservation(tenantId, a.runId);
    expect(reservation?.drawnTokens).toBe(1000);
    expect(reservation?.draws).toBe(3);
    expect(reservation?.drawPaths).toEqual({ turn: 1, status_poll: 1, retry: 1 });

    // A fourth call on ANY path finds the shared counter exhausted — no path
    // has an allowance of its own to fall back on.
    await expect(
      budgets.drawRunTokensOrThrow({ runId: a.runId, tenantId, callPath: 'status_poll', tokens: 1 }),
    ).rejects.toBeInstanceOf(MeriHermesRunTokenBudgetExhaustedError);
  });

  test('9. a RETRY cannot obtain a second allowance: re-reserving the same run id reuses the parent and commits nothing extra', async () => {
    const day = nextDay();
    const budgets = budgetService(SMALL);
    const a = reserveArgs(day);

    const first = await budgets.reserveAdmission(a);
    expect(first.reused).toBe(false);
    expect((await budgets.snapshot(tenantId, day)).committedTokens).toBe(1000);

    // Concurrent replays of the same admission — the shape an HTTP retry takes.
    const replays = await Promise.all([
      budgets.reserveAdmission(a),
      budgets.reserveAdmission(a),
      budgets.reserveAdmission(a),
    ]);
    expect(replays.every((r) => r.reused)).toBe(true);
    expect(replays.every((r) => r.reservation.runId === a.runId)).toBe(true);

    const snapshot = await budgets.snapshot(tenantId, day);
    expect(snapshot.committedTokens).toBe(1000); // NOT 4000
    expect(snapshot.admittedRuns).toBe(1);
  });

  test('10. the daily SPEND ceiling binds independently of the token ceiling', async () => {
    const day = nextDay();
    // Tokens are deliberately generous here so the refusal can only come from
    // money: 1000 tokens costs 12 500 micro-USD at the derived rate, and the
    // spend cap is set to USD 0.02 = 20 000 micro-USD.
    const budgets = budgetService({
      MERI_HERMES_MAX_RUN_TOKENS: '1000',
      MERI_HERMES_TENANT_DAILY_TOKENS: '1000000',
      MERI_HERMES_TENANT_DAILY_SPEND_USD: '0.02',
    });

    await budgets.reserveAdmission(reserveArgs(day));
    const refusal = await budgets.reserveAdmission(reserveArgs(day)).catch((e) => e);
    expect(refusal).toBeInstanceOf(MeriHermesBudgetExhaustedError);
    expect((refusal as MeriHermesBudgetExhaustedError).ceiling).toBe('tenant_daily_spend');

    const snapshot = await budgets.snapshot(tenantId, day);
    expect(snapshot.committedMicroUsd).toBe(12_500);
    expect(snapshot.capMicroUsd).toBe(20_000);
  });

  test("11. a provider-reported cost REPLACES the estimated rate at reconciliation, so a wrong rate never reaches the settled total", async () => {
    const day = nextDay();
    const budgets = budgetService(SMALL);
    const a = reserveArgs(day);
    await budgets.reserveAdmission(a);
    expect((await budgets.snapshot(tenantId, day)).committedMicroUsd).toBe(12_500); // estimate at the configured rate

    // The provider says this run cost USD 0.004 — nothing like the estimate.
    const result = await budgets.reconcile({ runId: a.runId, tenantId, usage: usage(800, 0.004) });
    expect(result.actualMicroUsd).toBe(4_000);
    const snapshot = await budgets.snapshot(tenantId, day);
    expect(snapshot.settledMicroUsd).toBe(4_000);
    expect(snapshot.committedMicroUsd).toBe(4_000);
  });

  test('12. an abandoned reservation (the replica died before any terminal path ran) is swept back into the tenant window', async () => {
    const day = nextDay();
    const budgets = budgetService(SMALL);
    const a = reserveArgs(day);
    await budgets.reserveAdmission(a);
    await budgets.drawRunTokens({ runId: a.runId, tenantId, callPath: 'turn', tokens: 120 });
    expect((await budgets.snapshot(tenantId, day)).committedTokens).toBe(1000);

    // olderThanMs = 0 => everything currently open is past the cutoff.
    const closed = await budgets.sweepAbandoned(0, new Date(Date.now() + 1000), { tenantId });
    expect(closed).toBeGreaterThanOrEqual(1);

    const snapshot = await budgets.snapshot(tenantId, day);
    // Settled at what it actually drew, not at the estimate.
    expect(snapshot.committedTokens).toBe(120);
    expect(snapshot.settledTokens).toBe(120);
    expect((await budgets.getReservation(tenantId, a.runId))?.state).toBe('reconciled');
  });
});
