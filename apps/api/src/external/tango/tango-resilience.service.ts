import { Inject, Injectable, Logger } from '@nestjs/common';
import { TangoStoreService } from './tango-store.service.js';
import { TangoError, TangoNotConfiguredError, type TangoRateMetadata } from './tango.errors.js';
import {
  TANGO_GATEWAY,
  type TangoEntity,
  type TangoEntityListOptions,
  type TangoForecast,
  type TangoForecastListOptions,
  type TangoGateway,
  type TangoListOptions,
  type TangoNotice,
  type TangoNoticeListOptions,
  type TangoOpportunity,
  type TangoOpportunityListOptions,
  type TangoPage,
  type TangoVehicle,
  type TangoVehicleAwardee,
  type TangoVehicleListOptions,
} from './tango.types.js';

/**
 * Rate-limit, usage, retry, and health controls (Funding Opportunities P18).
 *
 * ── Why this wraps the gateway rather than changing it ────────────────────────
 *
 * `TangoGatewayService` (P14) deliberately issues each call exactly once and
 * lets the caller decide what "again" means — its own class doc says so
 * ("P18 owns retry, and the SDK retrying underneath it would multiply
 * requests against an account limit invisibly to the ceiling P18 enforces").
 * This is that caller: a second implementation of the SAME `TangoGateway`
 * interface, wrapping the raw one from OUTSIDE, so a consumer that injects
 * `TANGO_RESILIENT_GATEWAY` gets retry/breaker/ceiling/usage-recording
 * transparently and cannot bypass it by calling a method "the wrong way" —
 * there is only one way to call each method on this class.
 *
 * `TANGO_GATEWAY` (the raw one) still exists and is still exported — this
 * class depends on it, constructed the normal way. Nothing currently injects
 * the raw token directly in product code (P19 is the first real consumer, and
 * the plan for it is to inject `TANGO_RESILIENT_GATEWAY` instead); the raw
 * token remains available for a future caller with a specific, documented
 * reason not to want retry/ceiling protection — the two are intentionally
 * different tokens rather than one that changed behavior underneath existing
 * callers.
 *
 * ── Retry: only what tango.errors.ts already says is retryable ────────────────
 *
 * `TangoError.retryable` is `RETRYABLE.has(kind)` — true for exactly
 * `rate_limit` and `transient`, false for everything else (`auth`, `tier`,
 * `validation`, `not_found`, `permanent`). This class reads that flag rather
 * than re-deriving it: a non-retryable error is thrown back to the caller on
 * the FIRST attempt, always — a 400 (`validation`) is a Capiro bug, not a
 * network hiccup, and retrying it three times would triple a bug's blast
 * radius on the account's rate limit for zero chance of success.
 *
 * A `retryAfter` on the failure (the provider's own stated delay) is honored
 * over local backoff, per `TangoRateMetadata`'s own doc comment. Otherwise,
 * backoff is a bounded exponential (500ms, 1s, capped at 8s) — there is no
 * `TANGO_*` config key for this because P16 did not define one; it is a
 * constant, not a knob, the same way `MAX_ATTEMPTS` (3) is.
 *
 * ── The circuit breaker: exactly the semantics P16 already documented ─────────
 *
 * `config.schema.ts`'s own comment on `TANGO_CIRCUIT_BREAKER_THRESHOLD`
 * predates this file: "Consecutive transient/rate-limit failures before the
 * breaker opens, and how long it stays open before allowing a probe
 * request." That sentence IS the spec — this class does not invent different
 * semantics. Concretely: `N` consecutive LOGICAL operations (after each one's
 * own retries are exhausted) that fail with a retryable kind opens the
 * breaker for `TANGO_CIRCUIT_BREAKER_COOLDOWN_MS`; every call attempted while
 * open is refused immediately (no network attempt, no usage row — nothing
 * was tried); once the cooldown elapses, exactly ONE call is let through as a
 * trial (`half_open`) — success closes the breaker and resets the counter,
 * failure reopens it for another full cooldown. A non-retryable failure
 * (auth/tier/validation/not_found/permanent) never counts toward the
 * threshold and never trips the breaker — repeating a rejected key or a
 * malformed request is not evidence the PROVIDER is struggling, which is the
 * only thing this breaker exists to protect against.
 *
 * ── The auth fast-path: the same reasoning P17 already used once ─────────────
 *
 * An `auth`-kind failure is never retryable and never trips the breaker (see
 * above) — so without any special-casing, every subsequent call would
 * already, correctly, throw the same auth error on its own first attempt at
 * minimal cost. The one thing worth adding on top is P17's own optimization,
 * reapplied at this layer: once ONE call has proven the key itself is
 * rejected, every later call in the same process is refused immediately
 * rather than making a full, guaranteed-401 HTTP round trip just to
 * rediscover the same fact. This does not change any outcome — only how many
 * real network calls it costs to reach it.
 *
 * ── The request ceiling: per PROCESS, which is per RUN ────────────────────────
 *
 * `TANGO_REQUEST_CEILING_PER_RUN` caps actual network attempts issued by
 * THIS instance. There is no explicit "reset" method because none is needed:
 * each sync job runs as its own ephemeral ECS task (P16's
 * `ApiSyncJobsTaskDef`) — a fresh process, a fresh singleton instance, a
 * fresh counter at zero. "Per run" and "per process lifetime" are the same
 * thing under that architecture, by construction, not by a decision this
 * class enforces itself.
 *
 * ── Usage: one row per NETWORK ATTEMPT, not per logical operation ─────────────
 *
 * A logical call retried twice is recorded as up to 3 `tango_api_usage` rows
 * (one per attempt) — recording only the final outcome would silently hide
 * the true number of requests sent to the provider, which is exactly the
 * number `tango_api_usage` exists to make visible (its own migration comment:
 * "the shape P18's health check and rate-ceiling logic both need"). A call
 * refused locally — no key configured, breaker open, ceiling reached, or key
 * already known-rejected — is NOT recorded: nothing was attempted, so there
 * is nothing to log as an attempt.
 *
 * ── Health: two different questions, two different answers ───────────────────
 *
 * {@link getHealth} answers "what is THIS process's live breaker/ceiling
 * state right now" — in-memory, instant, only meaningful to the process
 * asking (an ephemeral sync task could log it at the end of its own run).
 * `TangoStoreService.getUsageHealth` (added alongside this class) answers
 * "how has the integration behaved recently" from the PERSISTED usage log —
 * meaningful across process boundaries, which is what an operator running
 * `diag-tango-health` from a shell actually needs, since that shell process
 * shares no memory with whatever sync task ran an hour ago.
 */

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;

export const BREAKER_STATES = ['closed', 'open', 'half_open'] as const;
export type BreakerState = (typeof BREAKER_STATES)[number];

export interface TangoResilienceHealth {
  breakerState: BreakerState;
  consecutiveFailures: number;
  breakerThreshold: number;
  /** ISO timestamp, or null when the breaker has never opened (or has since closed). */
  breakerOpenUntil: string | null;
  requestsIssuedThisRun: number;
  requestCeiling: number;
  /** Set once an auth failure is seen; every later call fails fast without a network attempt. */
  authRejected: boolean;
}

/** Refused locally because the breaker is open. No network attempt was made. */
export class TangoCircuitOpenError extends Error {
  readonly openUntil: string;
  constructor(operation: string, openUntilMs: number) {
    const openUntil = new Date(openUntilMs).toISOString();
    super(
      `Tango circuit breaker is open for "${operation}" until ${openUntil} — refusing to attempt ` +
        'a call that consecutive transient/rate-limit failures already showed would likely fail. ' +
        'Not retryable by the caller; wait for the cooldown or inspect getHealth().',
    );
    this.name = 'TangoCircuitOpenError';
    this.openUntil = openUntil;
  }
}

/** Refused locally because this run already issued its configured ceiling of requests. */
export class TangoRequestCeilingExceededError extends Error {
  constructor(operation: string, ceiling: number) {
    super(
      `Tango request ceiling (${ceiling}) reached before "${operation}" — refusing to issue ` +
        'another call this run. This protects the account\'s quota, not a per-call limit; a new ' +
        'process (a new run) starts with a fresh count.',
    );
    this.name = 'TangoRequestCeilingExceededError';
  }
}

/** Refused locally because an earlier call already proved the configured key is rejected. */
export class TangoAuthRejectedError extends Error {
  constructor(operation: string, cause: TangoError) {
    super(
      `Tango key already known-rejected (proven by an earlier call this run) — refusing to attempt ` +
        `"${operation}" and repeat a guaranteed-401 round trip. Original: ${cause.message}`,
    );
    this.name = 'TangoAuthRejectedError';
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false, writable: false });
  }
}

export interface TangoResilienceOptions {
  requestCeiling?: number;
  breakerThreshold?: number;
  breakerCooldownMs?: number;
  /** Test seam. Defaults to `Date.now`. */
  now?: () => number;
  /** Test seam. Defaults to a real `setTimeout`-based delay. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_REQUEST_CEILING = 5_000;
const DEFAULT_BREAKER_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 60_000;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

@Injectable()
export class TangoResilienceService implements TangoGateway {
  private readonly logger = new Logger(TangoResilienceService.name);
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly requestCeiling: number;
  private readonly breakerThreshold: number;
  private readonly breakerCooldownMs: number;

  private requestsIssuedThisRun = 0;
  private consecutiveFailures = 0;
  private openUntilMs: number | null = null;
  private authRejectedError: TangoError | null = null;

  constructor(
    @Inject(TANGO_GATEWAY) private readonly gateway: TangoGateway,
    private readonly store: TangoStoreService,
    options: TangoResilienceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.requestCeiling = options.requestCeiling ?? DEFAULT_REQUEST_CEILING;
    this.breakerThreshold = options.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
    this.breakerCooldownMs = options.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
  }

  get configured(): boolean {
    return this.gateway.configured;
  }

  get lastRate(): TangoRateMetadata | null {
    return this.gateway.lastRate;
  }

  getVersion(): Promise<Record<string, unknown>> {
    return this.execute('getVersion', () => this.gateway.getVersion());
  }

  getEntity(uei: string): Promise<TangoEntity | null> {
    return this.execute('getEntity', () => this.gateway.getEntity(uei));
  }

  listEntities(options?: TangoEntityListOptions): Promise<TangoPage<TangoEntity>> {
    return this.execute('listEntities', () => this.gateway.listEntities(options));
  }

  listOpportunities(options?: TangoOpportunityListOptions): Promise<TangoPage<TangoOpportunity>> {
    return this.execute('listOpportunities', () => this.gateway.listOpportunities(options));
  }

  listNotices(options?: TangoNoticeListOptions): Promise<TangoPage<TangoNotice>> {
    return this.execute('listNotices', () => this.gateway.listNotices(options));
  }

  listForecasts(options?: TangoForecastListOptions): Promise<TangoPage<TangoForecast>> {
    return this.execute('listForecasts', () => this.gateway.listForecasts(options));
  }

  listVehicles(options?: TangoVehicleListOptions): Promise<TangoPage<TangoVehicle>> {
    return this.execute('listVehicles', () => this.gateway.listVehicles(options));
  }

  listVehicleAwardees(
    vehicleId: string,
    options?: TangoListOptions,
  ): Promise<TangoPage<TangoVehicleAwardee>> {
    return this.execute('listVehicleAwardees', () => this.gateway.listVehicleAwardees(vehicleId, options));
  }

  /** This process's live breaker/ceiling state. See the class doc for why this is not cross-process. */
  getHealth(): TangoResilienceHealth {
    const now = this.now();
    const breakerState: BreakerState =
      this.openUntilMs == null ? 'closed' : now < this.openUntilMs ? 'open' : 'half_open';
    return {
      breakerState,
      consecutiveFailures: this.consecutiveFailures,
      breakerThreshold: this.breakerThreshold,
      breakerOpenUntil: this.openUntilMs == null ? null : new Date(this.openUntilMs).toISOString(),
      requestsIssuedThisRun: this.requestsIssuedThisRun,
      requestCeiling: this.requestCeiling,
      authRejected: this.authRejectedError != null,
    };
  }

  private async execute<T>(callFamily: string, run: () => Promise<T>): Promise<T> {
    // No key at all is a config state, not an incident (same distinction
    // TangoNotConfiguredError's own doc draws) — checked upfront via the
    // gateway's own synchronous `configured` flag so this never enters the
    // loop, never touches the breaker or ceiling, and never even calls
    // `run()` to discover what it already knows.
    if (!this.gateway.configured) {
      throw new TangoNotConfiguredError(callFamily);
    }

    if (this.authRejectedError) {
      throw new TangoAuthRejectedError(callFamily, this.authRejectedError);
    }

    const nowAtEntry = this.now();
    if (this.openUntilMs != null && nowAtEntry < this.openUntilMs) {
      throw new TangoCircuitOpenError(callFamily, this.openUntilMs);
    }

    let attempt = 0;
    for (;;) {
      attempt += 1;

      if (this.requestsIssuedThisRun >= this.requestCeiling) {
        throw new TangoRequestCeilingExceededError(callFamily, this.requestCeiling);
      }
      this.requestsIssuedThisRun += 1;

      const started = this.now();
      try {
        const result = await run();
        await this.recordUsage(callFamily, 'success', started);
        this.registerSuccess();
        return result;
      } catch (error) {
        const durationMs = this.now() - started;

        if (!(error instanceof TangoError)) {
          // Should not happen — every TangoGatewayService method wraps its
          // failures (tango.client.ts's own class doc), and `configured` was
          // already proven true above, ruling out TangoNotConfiguredError.
          // Surfaced as-is rather than guessed at.
          throw error;
        }

        await this.recordUsage(callFamily, error.kind, started, error, durationMs);

        if (error.kind === 'auth') {
          this.authRejectedError = error;
        }

        if (!error.retryable) {
          throw error;
        }

        if (attempt >= MAX_ATTEMPTS) {
          this.registerFailure();
          throw error;
        }

        await this.sleep(this.backoffMs(error, attempt));
      }
    }
  }

  private registerSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntilMs = null;
  }

  /** Called once per LOGICAL operation that exhausted its retries — never per raw attempt. */
  private registerFailure(): void {
    this.consecutiveFailures += 1;
    // `openUntilMs != null` here means this failure was the half-open TRIAL
    // call (the pre-check above already refused anything while genuinely
    // open) — one failed trial reopens immediately, without needing a fresh
    // full threshold's worth of failures.
    const wasHalfOpenTrial = this.openUntilMs != null;
    if (wasHalfOpenTrial || this.consecutiveFailures >= this.breakerThreshold) {
      this.openUntilMs = this.now() + this.breakerCooldownMs;
    }
  }

  private backoffMs(error: TangoError, attempt: number): number {
    const retryAfterSeconds = error.rate?.retryAfter;
    if (retryAfterSeconds != null && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }
    return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  }

  private async recordUsage(
    callFamily: string,
    status: 'success' | TangoError['kind'],
    startedAt: number,
    error?: TangoError,
    durationMsOverride?: number,
  ): Promise<void> {
    try {
      await this.store.recordUsage({
        callFamily,
        status,
        durationMs: durationMsOverride ?? this.now() - startedAt,
        rateLimitRemaining: (error?.rate ?? this.gateway.lastRate)?.remaining ?? null,
        rateLimitLimit: (error?.rate ?? this.gateway.lastRate)?.limit ?? null,
        rateLimitResetIn: (error?.rate ?? this.gateway.lastRate)?.resetIn ?? null,
      });
    } catch (recordError) {
      // A usage-logging failure must never mask the real call outcome, and
      // must never take down a sync run — log and move on.
      this.logger.warn(
        `Failed to record Tango usage for "${callFamily}": ${
          recordError instanceof Error ? recordError.message : String(recordError)
        }`,
      );
    }
  }
}
