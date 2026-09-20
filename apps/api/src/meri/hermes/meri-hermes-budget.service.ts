/**
 * S-1 — distributed token/spend budgets with ATOMIC reservations in Postgres.
 *
 * Three declared ceilings (decisions.md §4, carried as configurable defaults in
 * meri-hermes-scaling.config.ts):
 *
 *   • per-run total tokens (in+out), ALL call paths ....... 50 000
 *   • per-tenant tokens per day .......................... 2 000 000
 *   • per-tenant spend per day ........................... USD 25
 *
 * SHAPE: reserve at admission, reconcile at terminal.
 *
 *   ADMISSION. One row is inserted into `meri_agent_run_reservations`, primary
 *   keyed by the run id, holding the run's whole per-run allowance as an
 *   ESTIMATE, and that estimate is committed against the tenant's day counters
 *   by a SINGLE conditional statement:
 *
 *       INSERT INTO meri_agent_budget_periods (...) VALUES (...)
 *       ON CONFLICT (tenant_id, period_date) DO UPDATE
 *          SET committed_* = committed_* + EXCLUDED.committed_*
 *        WHERE committed_* + EXCLUDED.committed_* <= <declared cap>
 *       RETURNING committed_*
 *
 *   Postgres takes a row lock for the conflicting UPDATE, so concurrent
 *   admissions on one tenant serialize and each sees the previous one's
 *   COMMITTED value. A row comes back only when the guard held. With N
 *   concurrent admissions against a budget that fits M, exactly M statements
 *   match and N − M return nothing — the same mechanism `reserveBrokerCall`
 *   already uses for the per-run tool budget, and the reason this is a cap
 *   across replicas rather than a suggestion.
 *
 *   DRAW. Every enabled call path — the turn itself, an HTTP retry, a
 *   reconciliation status poll, compression, a future child run — calls
 *   `drawRunTokens(runId, callPath, tokens)`. There is no per-path allowance to
 *   allocate: the parent reservation is primary-keyed BY THE RUN ID, so a call
 *   path can only ever resolve the one row, and a second allowance for one run
 *   is unrepresentable rather than merely discouraged. The draw is itself one
 *   conditional statement guarded on `drawn_tokens + n <= max_run_tokens`.
 *
 *   TERMINAL. `reconcile()` swaps the estimate out for the actual in one
 *   transaction: the reservation is closed with a guarded
 *   `WHERE state = 'open'` (so a second, racing or replayed finalization is a
 *   no-op rather than a double count), and the tenant day counters move by
 *   `− estimate + actual`. An over-estimate releases headroom for the next
 *   admission; an under-estimate charges the difference.
 *
 * EXHAUSTION. A refused admission throws `MeriHermesBudgetExhaustedError`,
 * which carries an actionable message, which ceiling was hit, the current and
 * cap values, and when the window resets. It refuses NEW admission only:
 * in-flight runs draw against their OWN already-granted parent reservations and
 * are not consulted about the tenant day counters again, so they finish.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
// Value import, not `import type`: Nest reads `design:paramtypes` for
// constructor injection, and a type-only import erases to `Object`.
import { PrismaService } from '../../prisma/prisma.service.js';
import type { MeriHermesUsage } from './hermes-runtime.contracts.js';
import { MeriHermesDbGovernor, meriHermesSharedDbGovernor } from './meri-hermes-db-governor.js';
import {
  meriHermesBudgetPeriodDate,
  meriHermesScalingLimits,
  meriHermesTokensToMicroUsd,
  meriHermesUsdToMicroUsd,
  type MeriHermesScalingLimits,
} from './meri-hermes-scaling.config.js';

export type MeriHermesBudgetCeiling = 'tenant_daily_tokens' | 'tenant_daily_spend' | 'run_tokens';

/**
 * A NEW admission was refused because a declared ceiling is exhausted. Never
 * thrown at an in-flight run: those hold their own parent reservation and are
 * not re-tested against the tenant window.
 */
export class MeriHermesBudgetExhaustedError extends Error {
  readonly code = 'hermes_budget_exhausted';
  constructor(
    readonly ceiling: MeriHermesBudgetCeiling,
    readonly detail: {
      tenantId: string;
      periodDate: string;
      current: number;
      requested: number;
      cap: number;
      unit: 'tokens' | 'micro_usd';
      resetsAt: string;
    },
    message: string,
  ) {
    super(message);
    this.name = 'MeriHermesBudgetExhaustedError';
  }
}

/** The per-run parent reservation was drawn past its cap. The run must end honestly, partial. */
export class MeriHermesRunTokenBudgetExhaustedError extends Error {
  readonly code = 'run_token_budget_exhausted';
  constructor(
    readonly runId: string,
    readonly drawnTokens: number,
    readonly maxRunTokens: number,
    readonly callPath: string,
  ) {
    super(
      `Run ${runId} reached its ${maxRunTokens}-token budget (${drawnTokens} drawn) on call path '${callPath}'. ` +
        'The answer so far is reported as partial rather than silently truncated.',
    );
    this.name = 'MeriHermesRunTokenBudgetExhaustedError';
  }
}

export interface MeriHermesRunReservation {
  runId: string;
  tenantId: string;
  scopeId: string;
  conversationId: string;
  periodDate: string;
  maxRunTokens: number;
  estimatedTokens: number;
  estimatedMicroUsd: number;
  drawnTokens: number;
  draws: number;
  drawPaths: Record<string, number>;
  actualTokens: number | null;
  actualMicroUsd: number | null;
  state: 'open' | 'reconciled';
}

export interface MeriHermesBudgetSnapshot {
  tenantId: string;
  periodDate: string;
  committedTokens: number;
  committedMicroUsd: number;
  settledTokens: number;
  settledMicroUsd: number;
  admittedRuns: number;
  settledRuns: number;
  refusedAdmissions: number;
  capTokens: number;
  capMicroUsd: number;
  remainingTokens: number;
  remainingMicroUsd: number;
}

interface ReservationRow {
  run_id: string;
  tenant_id: string;
  scope_id: string;
  conversation_id: string;
  period_date: Date | string;
  max_run_tokens: number;
  estimated_tokens: number;
  estimated_micro_usd: bigint | number;
  drawn_tokens: number;
  draws: number;
  draw_paths_jsonb: unknown;
  actual_tokens: number | null;
  actual_micro_usd: bigint | number | null;
  state: string;
}

interface PeriodRow {
  committed_tokens: bigint | number;
  committed_micro_usd: bigint | number;
  settled_tokens: bigint | number;
  settled_micro_usd: bigint | number;
  admitted_runs: number;
  settled_runs: number;
  refused_admissions: number;
}

/** A private sentinel used to roll a transaction back after a lost PK race; never escapes this file. */
class ReservationRaceLost extends Error {}

function num(value: bigint | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

function asDateKey(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function toReservation(row: ReservationRow): MeriHermesRunReservation {
  const paths =
    row.draw_paths_jsonb && typeof row.draw_paths_jsonb === 'object' && !Array.isArray(row.draw_paths_jsonb)
      ? (row.draw_paths_jsonb as Record<string, number>)
      : {};
  return {
    runId: row.run_id,
    tenantId: row.tenant_id,
    scopeId: row.scope_id,
    conversationId: row.conversation_id,
    periodDate: asDateKey(row.period_date),
    maxRunTokens: row.max_run_tokens,
    estimatedTokens: row.estimated_tokens,
    estimatedMicroUsd: num(row.estimated_micro_usd),
    drawnTokens: row.drawn_tokens,
    draws: row.draws,
    drawPaths: paths,
    actualTokens: row.actual_tokens,
    actualMicroUsd: row.actual_micro_usd === null ? null : num(row.actual_micro_usd),
    state: row.state === 'reconciled' ? 'reconciled' : 'open',
  };
}

/** Midnight UTC after `periodDate` — when a daily window resets, for the actionable refusal message. */
function resetsAt(periodDate: string): string {
  const next = new Date(`${periodDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

@Injectable()
export class MeriHermesBudgetService {
  private readonly logger = new Logger(MeriHermesBudgetService.name);

  /** Test seam; same convention as the adapter's `env` / the broker's `env`. */
  env: NodeJS.ProcessEnv = process.env;

  /** Assignable so a spec can share one governor (and its counters) across services. */
  governor: MeriHermesDbGovernor;

  constructor(
    private readonly prisma: PrismaService,
    governor?: MeriHermesDbGovernor,
  ) {
    this.governor = governor ?? meriHermesSharedDbGovernor();
  }

  limits(): MeriHermesScalingLimits {
    return meriHermesScalingLimits(this.env);
  }

  /**
   * Reserve the whole per-run allowance against the tenant's day counters.
   *
   * Idempotent by run id: a replayed admission for a run that already holds a
   * reservation returns that reservation and does NOT commit a second estimate.
   * That is the first half of "a retry cannot bypass the parent reservation";
   * the second half is `drawRunTokens`, which has no per-path allowance to give.
   */
  async reserveAdmission(input: {
    runId: string;
    tenantId: string;
    scopeId: string;
    conversationId: string;
    maxRunTokens?: number;
    now?: Date;
  }): Promise<{ reservation: MeriHermesRunReservation; reused: boolean }> {
    const limits = this.limits();
    const periodDate = meriHermesBudgetPeriodDate(input.now ?? new Date());
    const maxRunTokens = Math.max(0, Math.floor(input.maxRunTokens ?? limits.maxRunTokens));
    const estimateTokens = maxRunTokens;
    const estimateMicroUsd = meriHermesTokensToMicroUsd(estimateTokens, limits.usdPerMillionTokens);

    // Not a race: these compare a constant request against a constant cap, and
    // they close the one hole an `ON CONFLICT DO UPDATE ... WHERE` leaves — the
    // INSERT branch (first admission of the day) has no WHERE clause of its own.
    if (estimateTokens > limits.tenantDailyTokens) {
      throw new MeriHermesBudgetExhaustedError(
        'tenant_daily_tokens',
        {
          tenantId: input.tenantId,
          periodDate,
          current: 0,
          requested: estimateTokens,
          cap: limits.tenantDailyTokens,
          unit: 'tokens',
          resetsAt: resetsAt(periodDate),
        },
        `A single Hermes run reserves ${estimateTokens} tokens, which exceeds this tenant's entire ` +
          `${limits.tenantDailyTokens}-token daily allowance. Lower MERI_HERMES_MAX_RUN_TOKENS or raise ` +
          'MERI_HERMES_TENANT_DAILY_TOKENS; no run can be admitted until one of the two changes.',
      );
    }
    if (estimateMicroUsd > limits.tenantDailyMicroUsd) {
      throw new MeriHermesBudgetExhaustedError(
        'tenant_daily_spend',
        {
          tenantId: input.tenantId,
          periodDate,
          current: 0,
          requested: estimateMicroUsd,
          cap: limits.tenantDailyMicroUsd,
          unit: 'micro_usd',
          resetsAt: resetsAt(periodDate),
        },
        `A single Hermes run reserves USD ${(estimateMicroUsd / 1e6).toFixed(2)}, which exceeds this tenant's ` +
          `entire USD ${(limits.tenantDailyMicroUsd / 1e6).toFixed(2)} daily spend allowance.`,
      );
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // The transaction RETURNS a refusal rather than throwing it, because a
        // throw would roll back the `refused_admissions` counter the refusal
        // itself just recorded. The error is thrown by the caller, below, once
        // the transaction has committed.
        const outcome = await this.governor.withTenantTx<
          { reservation: MeriHermesRunReservation; reused: boolean } | { refusal: MeriHermesBudgetExhaustedError }
        >(
          this.prisma,
          'budget.reserveAdmission',
          input.tenantId,
          async (tx) => {
            const existing = await tx.$queryRaw<ReservationRow[]>(Prisma.sql`
              SELECT * FROM meri_agent_run_reservations WHERE run_id = ${input.runId}::uuid
            `);
            if (existing[0]) return { reservation: toReservation(existing[0]), reused: true };

            const committed = await tx.$queryRaw<Array<{ committed_tokens: bigint; committed_micro_usd: bigint }>>(
              Prisma.sql`
                INSERT INTO meri_agent_budget_periods
                  (tenant_id, period_date, committed_tokens, committed_micro_usd, admitted_runs)
                VALUES
                  (${input.tenantId}::uuid, ${periodDate}::date, ${estimateTokens}::bigint,
                   ${estimateMicroUsd}::bigint, 1)
                ON CONFLICT (tenant_id, period_date) DO UPDATE
                  SET committed_tokens    = meri_agent_budget_periods.committed_tokens + EXCLUDED.committed_tokens,
                      committed_micro_usd = meri_agent_budget_periods.committed_micro_usd + EXCLUDED.committed_micro_usd,
                      admitted_runs       = meri_agent_budget_periods.admitted_runs + 1,
                      updated_at          = now()
                  WHERE meri_agent_budget_periods.committed_tokens + EXCLUDED.committed_tokens
                          <= ${limits.tenantDailyTokens}::bigint
                    AND meri_agent_budget_periods.committed_micro_usd + EXCLUDED.committed_micro_usd
                          <= ${limits.tenantDailyMicroUsd}::bigint
                RETURNING committed_tokens, committed_micro_usd
              `,
            );

            if (!committed[0]) {
              // Refused. The failed ON CONFLICT matched zero rows and did NOT
              // abort the transaction, so the refusal itself is still
              // recordable — and is recorded, because a silently refused
              // admission is exactly what decisions.md §4 forbids.
              const snapshot = await this.readPeriod(tx, input.tenantId, periodDate);
              await tx.$executeRaw`
                UPDATE meri_agent_budget_periods
                   SET refused_admissions = refused_admissions + 1, updated_at = now()
                 WHERE tenant_id = ${input.tenantId}::uuid AND period_date = ${periodDate}::date
              `;
              const tokensWouldBe = snapshot.committedTokens + estimateTokens;
              const spendWouldBe = snapshot.committedMicroUsd + estimateMicroUsd;
              const ceiling: MeriHermesBudgetCeiling =
                tokensWouldBe > limits.tenantDailyTokens ? 'tenant_daily_tokens' : 'tenant_daily_spend';
              const isTokens = ceiling === 'tenant_daily_tokens';
              const refusal = new MeriHermesBudgetExhaustedError(
                ceiling,
                {
                  tenantId: input.tenantId,
                  periodDate,
                  current: isTokens ? snapshot.committedTokens : snapshot.committedMicroUsd,
                  requested: isTokens ? estimateTokens : estimateMicroUsd,
                  cap: isTokens ? limits.tenantDailyTokens : limits.tenantDailyMicroUsd,
                  unit: isTokens ? 'tokens' : 'micro_usd',
                  resetsAt: resetsAt(periodDate),
                },
                isTokens
                  ? `This workspace has used ${snapshot.committedTokens.toLocaleString('en-US')} of its ` +
                    `${limits.tenantDailyTokens.toLocaleString('en-US')} Hermes tokens for ${periodDate} (UTC) and a new run ` +
                    `needs ${estimateTokens.toLocaleString('en-US')} more. Runs already in progress will finish normally. ` +
                    `The allowance resets at ${resetsAt(periodDate)}; an administrator can raise ` +
                    'MERI_HERMES_TENANT_DAILY_TOKENS before then.'
                  : `This workspace has committed USD ${(snapshot.committedMicroUsd / 1e6).toFixed(2)} of its ` +
                    `USD ${(limits.tenantDailyMicroUsd / 1e6).toFixed(2)} Hermes spend for ${periodDate} (UTC) and a new run ` +
                    `needs USD ${(spendWouldBe - snapshot.committedMicroUsd) / 1e6} more. Runs already in progress will ` +
                    `finish normally. The allowance resets at ${resetsAt(periodDate)}; an administrator can raise ` +
                    'MERI_HERMES_TENANT_DAILY_SPEND_USD before then.',
              );
              return { refusal };
            }

            const inserted = await tx.$queryRaw<ReservationRow[]>(Prisma.sql`
              INSERT INTO meri_agent_run_reservations
                (run_id, tenant_id, scope_id, conversation_id, period_date, max_run_tokens,
                 estimated_tokens, estimated_micro_usd)
              VALUES
                (${input.runId}::uuid, ${input.tenantId}::uuid, ${input.scopeId}, ${input.conversationId}::uuid,
                 ${periodDate}::date, ${maxRunTokens}, ${estimateTokens}, ${estimateMicroUsd}::bigint)
              ON CONFLICT (run_id) DO NOTHING
              RETURNING *
            `);
            // Lost a PK race with a parallel replay that passed the SELECT
            // above. Roll the whole transaction back — including the day
            // counters — and let the retry find the committed row.
            if (!inserted[0]) throw new ReservationRaceLost();
            return { reservation: toReservation(inserted[0]), reused: false };
          },
        );
        if ('refusal' in outcome) throw outcome.refusal;
        return outcome;
      } catch (error) {
        if (error instanceof ReservationRaceLost && attempt === 0) continue;
        if (error instanceof ReservationRaceLost) {
          const existing = await this.getReservation(input.tenantId, input.runId);
          if (existing) return { reservation: existing, reused: true };
        }
        throw error;
      }
    }
    throw new Error(`Unable to resolve a budget reservation for run ${input.runId}`);
  }

  /**
   * Draw `tokens` from the run's PARENT reservation on behalf of `callPath`.
   *
   * One conditional statement; the guard is on the reservation's own counter,
   * so N concurrent draws against a remaining allowance of M admit exactly the
   * prefix that fits. `callPath` is tallied into `draw_paths_jsonb` purely so a
   * test (and an operator) can see that several paths drew down one counter.
   */
  async drawRunTokens(input: {
    runId: string;
    tenantId: string;
    callPath: string;
    tokens: number;
  }): Promise<{ admitted: boolean; drawnTokens: number; maxRunTokens: number; remaining: number }> {
    const tokens = Number.isFinite(input.tokens) && input.tokens > 0 ? Math.floor(input.tokens) : 0;
    const path = input.callPath.slice(0, 40) || 'unknown';
    return this.governor.withTenantTx(this.prisma, 'budget.drawRunTokens', input.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ drawn_tokens: number; max_run_tokens: number }>>(Prisma.sql`
        UPDATE meri_agent_run_reservations
           SET drawn_tokens = drawn_tokens + ${tokens},
               draws        = draws + 1,
               draw_paths_jsonb = jsonb_set(
                 draw_paths_jsonb,
                 ARRAY[${path}],
                 to_jsonb(COALESCE((draw_paths_jsonb ->> ${path})::int, 0) + 1),
                 true
               )
         WHERE run_id = ${input.runId}::uuid
           AND state = 'open'
           AND drawn_tokens + ${tokens} <= max_run_tokens
        RETURNING drawn_tokens, max_run_tokens
      `);
      const won = rows[0];
      if (won) {
        return {
          admitted: true,
          drawnTokens: won.drawn_tokens,
          maxRunTokens: won.max_run_tokens,
          remaining: Math.max(0, won.max_run_tokens - won.drawn_tokens),
        };
      }
      const current = await tx.$queryRaw<ReservationRow[]>(Prisma.sql`
        SELECT * FROM meri_agent_run_reservations WHERE run_id = ${input.runId}::uuid
      `);
      if (!current[0]) throw new Error(`No Hermes budget reservation for run ${input.runId}`);
      const reservation = toReservation(current[0]);
      return {
        admitted: false,
        drawnTokens: reservation.drawnTokens,
        maxRunTokens: reservation.maxRunTokens,
        remaining: Math.max(0, reservation.maxRunTokens - reservation.drawnTokens),
      };
    });
  }

  /** `drawRunTokens` that throws instead of reporting refusal — for call sites that must stop the run. */
  async drawRunTokensOrThrow(input: {
    runId: string;
    tenantId: string;
    callPath: string;
    tokens: number;
  }): Promise<{ drawnTokens: number; remaining: number }> {
    const result = await this.drawRunTokens(input);
    if (!result.admitted) {
      throw new MeriHermesRunTokenBudgetExhaustedError(
        input.runId,
        result.drawnTokens,
        result.maxRunTokens,
        input.callPath,
      );
    }
    return { drawnTokens: result.drawnTokens, remaining: result.remaining };
  }

  /**
   * Terminal reconciliation: swap the admission ESTIMATE for the ACTUAL.
   *
   * Idempotent. The close is guarded on `state = 'open'`, so a replayed or
   * racing finalization (Phase 1 has several competing terminal paths — normal
   * completion, explicit Stop, revocation fencing, wall-clock expiry) settles
   * the tenant counters exactly once.
   */
  async reconcile(input: {
    runId: string;
    tenantId: string;
    usage: MeriHermesUsage | null;
  }): Promise<{
    reconciled: boolean;
    estimatedTokens: number;
    actualTokens: number;
    estimatedMicroUsd: number;
    actualMicroUsd: number;
    releasedTokens: number;
  }> {
    const limits = this.limits();
    return this.governor.withTenantTx(this.prisma, 'budget.reconcile', input.tenantId, async (tx) => {
      const before = await tx.$queryRaw<ReservationRow[]>(Prisma.sql`
        SELECT * FROM meri_agent_run_reservations WHERE run_id = ${input.runId}::uuid
      `);
      if (!before[0]) {
        return {
          reconciled: false,
          estimatedTokens: 0,
          actualTokens: 0,
          estimatedMicroUsd: 0,
          actualMicroUsd: 0,
          releasedTokens: 0,
        };
      }
      const reservation = toReservation(before[0]);
      // The authoritative actual: provider-reported total tokens when present,
      // otherwise what the run actually drew. Never the estimate.
      const actualTokens = Math.max(
        0,
        Math.floor(
          Number.isFinite(input.usage?.totalTokens) && (input.usage?.totalTokens ?? 0) > 0
            ? (input.usage as MeriHermesUsage).totalTokens
            : reservation.drawnTokens,
        ),
      );
      // Provider cost wins over the configured estimate rate whenever the
      // provider reports one, so a wrong rate can distort an in-flight
      // reservation but never a settled total.
      const actualMicroUsd =
        typeof input.usage?.costUsd === 'number' && Number.isFinite(input.usage.costUsd) && input.usage.costUsd > 0
          ? meriHermesUsdToMicroUsd(input.usage.costUsd)
          : meriHermesTokensToMicroUsd(actualTokens, limits.usdPerMillionTokens);

      const closed = await tx.$queryRaw<
        Array<{ estimated_tokens: number; estimated_micro_usd: bigint; period_date: Date }>
      >(Prisma.sql`
        UPDATE meri_agent_run_reservations
           SET state = 'reconciled',
               actual_tokens = ${actualTokens},
               actual_micro_usd = ${actualMicroUsd}::bigint,
               reconciled_at = now()
         WHERE run_id = ${input.runId}::uuid AND state = 'open'
        RETURNING estimated_tokens, estimated_micro_usd, period_date
      `);
      if (!closed[0]) {
        // Already reconciled by a competing terminal path. Reported, not
        // re-applied: a second settlement would double-charge the tenant.
        return {
          reconciled: false,
          estimatedTokens: reservation.estimatedTokens,
          actualTokens: reservation.actualTokens ?? 0,
          estimatedMicroUsd: reservation.estimatedMicroUsd,
          actualMicroUsd: reservation.actualMicroUsd ?? 0,
          releasedTokens: 0,
        };
      }
      const estimatedTokens = closed[0].estimated_tokens;
      const estimatedMicroUsd = num(closed[0].estimated_micro_usd);
      const periodDate = asDateKey(closed[0].period_date);

      await tx.$executeRaw`
        UPDATE meri_agent_budget_periods
           SET committed_tokens    = GREATEST(0::bigint, committed_tokens - ${estimatedTokens}::bigint + ${actualTokens}::bigint),
               committed_micro_usd = GREATEST(0::bigint, committed_micro_usd - ${estimatedMicroUsd}::bigint + ${actualMicroUsd}::bigint),
               settled_tokens      = settled_tokens + ${actualTokens}::bigint,
               settled_micro_usd   = settled_micro_usd + ${actualMicroUsd}::bigint,
               settled_runs        = settled_runs + 1,
               updated_at          = now()
         WHERE tenant_id = ${input.tenantId}::uuid AND period_date = ${periodDate}::date
      `;
      return {
        reconciled: true,
        estimatedTokens,
        actualTokens,
        estimatedMicroUsd,
        actualMicroUsd,
        releasedTokens: estimatedTokens - actualTokens,
      };
    });
  }

  async getReservation(tenantId: string, runId: string): Promise<MeriHermesRunReservation | null> {
    return this.governor.withTenantTx(this.prisma, 'budget.getReservation', tenantId, async (tx) => {
      const rows = await tx.$queryRaw<ReservationRow[]>(Prisma.sql`
        SELECT * FROM meri_agent_run_reservations WHERE run_id = ${runId}::uuid
      `);
      return rows[0] ? toReservation(rows[0]) : null;
    });
  }

  /** The tenant's live budget position for one UTC day — also what an operator-facing report reads. */
  async snapshot(tenantId: string, now: Date = new Date()): Promise<MeriHermesBudgetSnapshot> {
    const limits = this.limits();
    const periodDate = meriHermesBudgetPeriodDate(now);
    const read = await this.governor.withTenantTx(this.prisma, 'budget.snapshot', tenantId, (tx) =>
      this.readPeriod(tx, tenantId, periodDate),
    );
    return {
      tenantId,
      periodDate,
      ...read,
      capTokens: limits.tenantDailyTokens,
      capMicroUsd: limits.tenantDailyMicroUsd,
      remainingTokens: Math.max(0, limits.tenantDailyTokens - read.committedTokens),
      remainingMicroUsd: Math.max(0, limits.tenantDailyMicroUsd - read.committedMicroUsd),
    };
  }

  /**
   * Close out reservations whose run never reached a terminal path (the replica
   * died between admission and finalization). Without this, an abandoned
   * estimate would ring-fence tenant budget until the UTC day rolled over.
   * Cross-tenant by nature, so it runs through `withSystem` — the same
   * exception the run repository's `sweep()` already documents — and it is
   * bounded by the configured page size rather than scanning without a limit.
   */
  async sweepAbandoned(
    olderThanMs: number,
    now: Date = new Date(),
    opts?: { tenantId?: string },
  ): Promise<number> {
    const limits = this.limits();
    const cutoff = new Date(now.getTime() - Math.max(0, olderThanMs));
    // `opts.tenantId` narrows the scan to one tenant — the same narrowing
    // `listTakeoverCandidates` already offers on the run repository, for the
    // same reason: a caller acting on behalf of one tenant should not reach
    // across tenants it was not asked about. Omitted = the global scan a
    // scheduler wants.
    const tenantFilter = opts?.tenantId
      ? Prisma.sql`AND tenant_id = ${opts.tenantId}::uuid`
      : Prisma.empty;
    const stale = await this.governor.withSystemTx(this.prisma, 'budget.sweepAbandoned.scan', (tx) =>
      tx.$queryRaw<Array<{ run_id: string; tenant_id: string }>>(Prisma.sql`
        SELECT run_id, tenant_id
          FROM meri_agent_run_reservations
         WHERE state = 'open' AND created_at < ${cutoff}
         ${tenantFilter}
         ORDER BY created_at ASC
         LIMIT ${limits.maxPageSize}
      `),
    );
    let closed = 0;
    for (const row of stale) {
      const result = await this.reconcile({ runId: row.run_id, tenantId: row.tenant_id, usage: null }).catch(
        (error) => {
          this.logger.warn(`abandoned reservation ${row.run_id} could not be reconciled: ${String(error)}`);
          return null;
        },
      );
      if (result?.reconciled) closed += 1;
    }
    return closed;
  }

  private async readPeriod(
    tx: Prisma.TransactionClient,
    tenantId: string,
    periodDate: string,
  ): Promise<Omit<MeriHermesBudgetSnapshot, 'tenantId' | 'periodDate' | 'capTokens' | 'capMicroUsd' | 'remainingTokens' | 'remainingMicroUsd'>> {
    const rows = await tx.$queryRaw<PeriodRow[]>(Prisma.sql`
      SELECT committed_tokens, committed_micro_usd, settled_tokens, settled_micro_usd,
             admitted_runs, settled_runs, refused_admissions
        FROM meri_agent_budget_periods
       WHERE tenant_id = ${tenantId}::uuid AND period_date = ${periodDate}::date
    `);
    const row = rows[0];
    return {
      committedTokens: num(row?.committed_tokens),
      committedMicroUsd: num(row?.committed_micro_usd),
      settledTokens: num(row?.settled_tokens),
      settledMicroUsd: num(row?.settled_micro_usd),
      admittedRuns: row?.admitted_runs ?? 0,
      settledRuns: row?.settled_runs ?? 0,
      refusedAdmissions: row?.refused_admissions ?? 0,
    };
  }
}
