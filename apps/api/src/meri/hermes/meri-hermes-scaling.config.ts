/**
 * Phase 1 scaling envelope (S-1..S-4) as CONFIGURABLE DEFAULTS.
 *
 * Every default in this file is a number that was DECLARED, before any
 * acceptance run, in `docs/meri/hermes/phase-1/decisions.md` §4 ("Declared
 * pilot envelope"). Nothing here is measured, inferred from an AWS quota, or
 * invented. The one derived value (`usdPerMillionTokens`) is derived from two
 * numbers that ARE declared there, and says so at its definition.
 *
 * decisions.md §4, verbatim, and where each row is enforced:
 *
 *   | Control                                   | Declared | Enforced by |
 *   |-------------------------------------------|----------|-------------|
 *   | Concurrent Hermes runs, global            | 8        | S-2 MeriHermesAdmissionControlService |
 *   | Concurrent runs per tenant                | 4        | S-2 same |
 *   | Concurrent runs per execution scope       | 2        | S-2 same |
 *   | Queue depth per tenant                    | 8        | S-2 same |
 *   | Per-run tool calls                        | 40       | already live: envelope.budget.maxToolCalls + repo.reserveBrokerCall() |
 *   | Per-run output tokens                     | 8 000    | already live: envelope.budget.maxOutputTokens |
 *   | Per-run wall clock                        | 600 s    | already live: envelope.budget.maxWallClockMs |
 *   | Per-run total tokens, ALL call paths      | 50 000   | S-1 MeriHermesBudgetService (parent reservation) |
 *   | Per-tenant tokens per day                 | 2 000 000| S-1 same (daily period counters) |
 *   | Per-tenant spend per day                  | USD 25   | S-1 same |
 *   | Hermes DB connections ≤ 20 % of API pool  | 20 %     | S-4 MeriHermesDbGovernor |
 *
 * Each value is overridable by an environment variable so an operator can
 * tighten (or, deliberately, widen) the envelope without a deploy of new code.
 * An unset, blank, non-numeric or out-of-range variable falls back to the
 * declared default rather than to something permissive: a typo in an env var
 * must never silently remove a cap.
 */

/** UTC day key `YYYY-MM-DD` — the budget period. UTC, not host-local, so replicas in different regions agree. */
export function meriHermesBudgetPeriodDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface MeriHermesScalingLimits {
  // --- S-1 budgets ---
  /** decisions.md §4: per-run total tokens (in+out), across ALL call paths. */
  maxRunTokens: number;
  /** decisions.md §4: per-tenant tokens per day. */
  tenantDailyTokens: number;
  /** decisions.md §4: per-tenant spend per day, carried in micro-USD (1e-6 USD). */
  tenantDailyMicroUsd: number;
  /**
   * Token → money conversion used for the ADMISSION-TIME estimate only.
   *
   * DERIVED, not invented and not a price quote: decisions.md §4 declares BOTH
   * a 2 000 000 token/day ceiling and a USD 25/day ceiling for the same tenant.
   * 25 USD / 2 000 000 tokens = USD 12.50 per million tokens is the single rate
   * at which those two declared ceilings bind at exactly the same moment. Any
   * other rate would make one of the two declared limits unreachable and the
   * other one the real limit, which would misreport the envelope.
   *
   * At reconciliation the provider's own reported cost (`MeriHermesUsage.costUsd`)
   * REPLACES this estimate whenever the provider supplies one, so a wrong rate
   * can only ever distort the in-flight reservation, never the settled total.
   * The pinned build's model pricing has not been measured here; see the
   * reporting note in the S-1 spec.
   */
  usdPerMillionTokens: number;

  // --- S-2 fairness ---
  /** decisions.md §4: concurrent Hermes runs, global. */
  maxConcurrentRunsGlobal: number;
  /** decisions.md §4: concurrent runs per tenant. */
  maxConcurrentRunsTenant: number;
  /** decisions.md §4: concurrent runs per execution scope. */
  maxConcurrentRunsScope: number;
  /** decisions.md §4: queue depth per tenant. Beyond it, admission is refused with a conflict. */
  tenantQueueDepth: number;
  /** How long a queued admission waits for a slot before it is refused. Not in §4 — an implementation choice, stated. */
  queueWaitMs: number;
  /** Poll interval while waiting for promotion. Implementation choice. */
  queuePollMs: number;
  /** A slot whose holder stopped heart-beating for this long is reaped so capacity is not leaked by a dead replica. */
  slotStaleMs: number;

  // --- S-3 profile-write coordination ---
  /** Writable-profile lease TTL. A holder must renew inside this window or be treated as a stale writer. */
  profileLeaseTtlMs: number;
  /** How long a writer waits for a busy profile lease before giving up with an actionable conflict. */
  profileLeaseWaitMs: number;
  /** Poll interval while waiting for the profile lease. */
  profileLeasePollMs: number;

  // --- S-4 bounded database and tool usage ---
  /** Fraction of the API connection pool Hermes broker work may occupy. decisions.md §4: ≤ 20 %. */
  dbPoolShare: number;
  /** Resolved maximum number of concurrent Hermes-attributable DB operations. */
  dbMaxConcurrency: number;
  /** The API pool size this share was computed from (parsed from DATABASE_URL `connection_limit`). */
  dbPoolSize: number;
  /** How long a broker DB operation may wait for a governor slot before it is refused. */
  dbAcquireTimeoutMs: number;
  /** Postgres `statement_timeout` applied to Hermes-attributable transactions. */
  dbStatementTimeoutMs: number;
  /** Deadline on a single broker tool call. */
  toolDeadlineMs: number;
  /** Default page size for a broker read that does not name one. */
  defaultPageSize: number;
  /** Hard ceiling on any broker read's page size, whatever the caller asks for. */
  maxPageSize: number;
}

/** decisions.md §4 defaults. Referenced by the specs so a drift in either direction fails a test. */
export const MERI_HERMES_DECLARED_LIMITS: Readonly<MeriHermesScalingLimits> = Object.freeze({
  maxRunTokens: 50_000,
  tenantDailyTokens: 2_000_000,
  tenantDailyMicroUsd: 25_000_000,
  usdPerMillionTokens: 12.5,

  maxConcurrentRunsGlobal: 8,
  maxConcurrentRunsTenant: 4,
  maxConcurrentRunsScope: 2,
  tenantQueueDepth: 8,
  queueWaitMs: 60_000,
  queuePollMs: 150,
  slotStaleMs: 15 * 60_000,

  profileLeaseTtlMs: 30_000,
  profileLeaseWaitMs: 15_000,
  profileLeasePollMs: 50,

  dbPoolShare: 0.2,
  dbMaxConcurrency: 6,
  dbPoolSize: 33,
  dbAcquireTimeoutMs: 5_000,
  dbStatementTimeoutMs: 10_000,
  toolDeadlineMs: 30_000,
  defaultPageSize: 25,
  maxPageSize: 100,
});

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? '');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function fraction(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? '');
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

/**
 * The API connection pool this process is configured for, read from
 * DATABASE_URL's `connection_limit`. That is the number decisions.md §4's
 * "≤ 20 % of the API pool" is a share OF, so it must come from the same place
 * Prisma gets it rather than being restated. When the URL does not name one
 * (Prisma's own default is derived from CPU count and is not knowable here) the
 * declared default stands and the caller can override it explicitly.
 */
export function meriHermesApiPoolSize(env: NodeJS.ProcessEnv = process.env): number {
  const explicit = Number(env.MERI_HERMES_DB_POOL_SIZE ?? '');
  if (Number.isFinite(explicit) && explicit > 0) return Math.floor(explicit);
  const url = env.DATABASE_URL;
  if (!url) return MERI_HERMES_DECLARED_LIMITS.dbPoolSize;
  try {
    const limit = Number(new URL(url).searchParams.get('connection_limit') ?? '');
    return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MERI_HERMES_DECLARED_LIMITS.dbPoolSize;
  } catch {
    return MERI_HERMES_DECLARED_LIMITS.dbPoolSize;
  }
}

/** Resolve the effective envelope. Pure; every value is env-overridable and every fallback is the declared one. */
export function meriHermesScalingLimits(env: NodeJS.ProcessEnv = process.env): MeriHermesScalingLimits {
  const d = MERI_HERMES_DECLARED_LIMITS;
  const poolSize = meriHermesApiPoolSize(env);
  const poolShare = fraction(env.MERI_HERMES_DB_POOL_SHARE, d.dbPoolShare);
  // At least one: a share that floors to zero would deadlock every broker read
  // rather than bounding it. Bounded above by the pool so a misconfigured share
  // cannot claim more connections than exist.
  const derivedConcurrency = Math.max(1, Math.min(poolSize, Math.floor(poolSize * poolShare)));
  return {
    maxRunTokens: positiveInt(env.MERI_HERMES_MAX_RUN_TOKENS, d.maxRunTokens),
    tenantDailyTokens: positiveInt(env.MERI_HERMES_TENANT_DAILY_TOKENS, d.tenantDailyTokens),
    tenantDailyMicroUsd: Math.floor(
      positiveNumber(env.MERI_HERMES_TENANT_DAILY_SPEND_USD, d.tenantDailyMicroUsd / 1_000_000) * 1_000_000,
    ),
    usdPerMillionTokens: positiveNumber(env.MERI_HERMES_USD_PER_MILLION_TOKENS, d.usdPerMillionTokens),

    maxConcurrentRunsGlobal: positiveInt(env.MERI_HERMES_MAX_CONCURRENT_RUNS_GLOBAL, d.maxConcurrentRunsGlobal),
    maxConcurrentRunsTenant: positiveInt(env.MERI_HERMES_MAX_CONCURRENT_RUNS_TENANT, d.maxConcurrentRunsTenant),
    maxConcurrentRunsScope: positiveInt(env.MERI_HERMES_MAX_CONCURRENT_RUNS_SCOPE, d.maxConcurrentRunsScope),
    tenantQueueDepth: positiveInt(env.MERI_HERMES_TENANT_QUEUE_DEPTH, d.tenantQueueDepth),
    queueWaitMs: positiveInt(env.MERI_HERMES_QUEUE_WAIT_MS, d.queueWaitMs),
    queuePollMs: positiveInt(env.MERI_HERMES_QUEUE_POLL_MS, d.queuePollMs),
    slotStaleMs: positiveInt(env.MERI_HERMES_SLOT_STALE_MS, d.slotStaleMs),

    profileLeaseTtlMs: positiveInt(env.MERI_HERMES_PROFILE_LEASE_TTL_MS, d.profileLeaseTtlMs),
    profileLeaseWaitMs: positiveInt(env.MERI_HERMES_PROFILE_LEASE_WAIT_MS, d.profileLeaseWaitMs),
    profileLeasePollMs: positiveInt(env.MERI_HERMES_PROFILE_LEASE_POLL_MS, d.profileLeasePollMs),

    dbPoolShare: poolShare,
    dbPoolSize: poolSize,
    dbMaxConcurrency: positiveInt(env.MERI_HERMES_DB_MAX_CONCURRENCY, derivedConcurrency),
    dbAcquireTimeoutMs: positiveInt(env.MERI_HERMES_DB_ACQUIRE_TIMEOUT_MS, d.dbAcquireTimeoutMs),
    dbStatementTimeoutMs: positiveInt(env.MERI_HERMES_DB_STATEMENT_TIMEOUT_MS, d.dbStatementTimeoutMs),
    toolDeadlineMs: positiveInt(env.MERI_HERMES_TOOL_DEADLINE_MS, d.toolDeadlineMs),
    defaultPageSize: positiveInt(env.MERI_HERMES_DEFAULT_PAGE_SIZE, d.defaultPageSize),
    maxPageSize: positiveInt(env.MERI_HERMES_MAX_PAGE_SIZE, d.maxPageSize),
  };
}

/** Whole micro-USD for `tokens` at the configured estimate rate. Integer arithmetic: money never becomes a float. */
export function meriHermesTokensToMicroUsd(tokens: number, usdPerMillionTokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.ceil((tokens * usdPerMillionTokens) / 1_000_000 * 1_000_000);
}

/** USD (a float from a provider) to whole micro-USD, rounded up so a partial cent is never free. */
export function meriHermesUsdToMicroUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.ceil(usd * 1_000_000);
}

/**
 * S-4 pagination. Every broker read that could otherwise return an unbounded
 * result set resolves its page through here: a caller that names no limit gets
 * `defaultPageSize`, a caller that names a huge one is clamped to `maxPageSize`,
 * and a caller that names a nonsense one gets the default rather than an error.
 * `take` is deliberately `limit + 1` capable via `probe`, which is how a caller
 * learns there is a next page without a second COUNT query.
 */
export function meriHermesBoundedPage(
  requested: { limit?: number | null; cursor?: string | null } | undefined,
  limits: Pick<MeriHermesScalingLimits, 'defaultPageSize' | 'maxPageSize'>,
): { limit: number; probe: number; cursor: string | null; clamped: boolean } {
  const raw = requested?.limit;
  const asked = Number.isFinite(raw) && (raw as number) > 0 ? Math.floor(raw as number) : limits.defaultPageSize;
  const limit = Math.min(asked, limits.maxPageSize);
  return {
    limit,
    probe: limit + 1,
    cursor: requested?.cursor?.trim() || null,
    clamped: asked > limits.maxPageSize,
  };
}
