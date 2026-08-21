/**
 * Phase 8 Session 9 — retry, failure classification and idempotency for the
 * cross-domain providers.
 *
 * Both ports Session 9 wires are documented to DEGRADE, not throw:
 *
 *   EmbeddingPort.embedQuery  -> "Returns null when no embedder is configured or
 *                                 the provider fails"
 *   ClientRelevancePort       -> "a relevance probe failure simply omits this
 *                                 PE's relevance signal"
 *
 * That makes the retry policy unusually consequential. A retry that is too eager
 * turns one slow provider into a stalled read route; a retry that is too shy
 * turns a single throttle response into a silently empty search box. So:
 *
 *  * failures are CLASSIFIED before they are retried — a 400 is never retried, a
 *    429 always is;
 *  * backoff is deterministic with no jitter, because a replay has to reproduce
 *    the same schedule and because these are read-path calls whose total latency
 *    must be predictable, not merely bounded;
 *  * the total wall-clock budget is bounded independently of the attempt count,
 *    so `maxAttempts` can never multiply into an unbounded request;
 *  * exhaustion is an outcome, not an exception. The caller degrades.
 */

import { createHash } from 'node:crypto';

export type ProviderFailureClass =
  | 'timeout'
  | 'throttled'
  | 'unavailable'
  | 'unauthorized'
  | 'invalid_request'
  | 'malformed_response'
  | 'transport'
  | 'unknown';

/** Failure classes worth another attempt. Everything else is terminal. */
const RETRYABLE: readonly ProviderFailureClass[] = Object.freeze([
  'timeout',
  'throttled',
  'unavailable',
  'transport',
]);

export function isRetryableFailure(failure: ProviderFailureClass): boolean {
  return RETRYABLE.includes(failure);
}

/**
 * Classify an HTTP status into a failure class.
 *
 * `401`/`403` are deliberately NOT retryable: a missing or wrong internal secret
 * will be missing or wrong on the next attempt too, and hammering an auth
 * failure is how a service-to-service misconfiguration becomes an incident.
 */
export function classifyHttpStatus(status: number): ProviderFailureClass {
  if (status === 408) return 'timeout';
  if (status === 429) return 'throttled';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status >= 400 && status < 500) return 'invalid_request';
  if (status >= 500) return 'unavailable';
  return 'unknown';
}

export interface RetryPolicy {
  readonly maxAttempts: number;
  /** Per-attempt timeout. */
  readonly timeoutMs: number;
  /** Base backoff, doubled per attempt. */
  readonly baseDelayMs?: number;
  /**
   * Ceiling on total time spent across all attempts including waits. Bounds the
   * read route independently of `maxAttempts`.
   */
  readonly totalBudgetMs?: number;
}

export interface RetryDecision {
  readonly retry: boolean;
  /** Deterministic wait before the next attempt. */
  readonly delayMs: number;
  readonly reason: string;
}

export const DEFAULT_BASE_DELAY_MS = 100;

/**
 * Decide whether to make another attempt.
 *
 * Deterministic: same inputs, same decision and same delay, every time.
 */
export function nextRetryDecision(input: {
  readonly failure: ProviderFailureClass;
  /** 1-based number of attempts already made. */
  readonly attemptsMade: number;
  readonly policy: RetryPolicy;
  /** Milliseconds already spent, including previous waits. */
  readonly elapsedMs: number;
  /** Publisher/provider `Retry-After`, already parsed to ms, when supplied. */
  readonly retryAfterMs?: number | null;
}): RetryDecision {
  const { failure, attemptsMade, policy, elapsedMs } = input;

  if (!isRetryableFailure(failure)) {
    return Object.freeze({ retry: false, delayMs: 0, reason: `${failure} is terminal` });
  }

  if (attemptsMade >= policy.maxAttempts) {
    return Object.freeze({
      retry: false,
      delayMs: 0,
      reason: `attempt budget exhausted after ${attemptsMade} of ${policy.maxAttempts}`,
    });
  }

  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  // Exponential, no jitter: replayable and predictable on a read path.
  const backoffMs = baseDelayMs * 2 ** (attemptsMade - 1);
  // A provider that tells us how long to wait is obeyed when it asks for longer.
  const delayMs = Math.max(backoffMs, Math.max(0, input.retryAfterMs ?? 0));

  const totalBudgetMs = policy.totalBudgetMs ?? policy.timeoutMs * policy.maxAttempts;
  if (elapsedMs + delayMs + policy.timeoutMs > totalBudgetMs) {
    return Object.freeze({
      retry: false,
      delayMs: 0,
      reason: `total budget ${totalBudgetMs}ms would be exceeded; degrading instead of retrying`,
    });
  }

  return Object.freeze({
    retry: true,
    delayMs,
    reason: `${failure} is retryable; attempt ${attemptsMade + 1} of ${policy.maxAttempts}`,
  });
}

/** Total wall-clock a policy can consume, for a readiness/ops report. */
export function worstCaseLatencyMs(policy: RetryPolicy): number {
  const baseDelayMs = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  let total = 0;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    total += policy.timeoutMs;
    if (attempt < policy.maxAttempts) total += baseDelayMs * 2 ** (attempt - 1);
  }
  return Math.min(total, policy.totalBudgetMs ?? total);
}

// ── Idempotency ─────────────────────────────────────────────────────────────

function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((input as Record<string, unknown>)[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(sort(value));
}

/**
 * Idempotency key for one provider invocation.
 *
 * Two properties matter:
 *
 *  * **The payload is HASHED, never carried.** A query string is user text and a
 *    PE-code list is tenant data; neither belongs on an audit row. The key proves
 *    two invocations were the same without recording what they were.
 *  * **The tenant is part of the key.** The same query from two tenants is two
 *    invocations, and collapsing them would let one tenant's result serve
 *    another's request.
 */
export function providerIdempotencyKey(input: {
  readonly provider: string;
  readonly operation: string;
  readonly model: string | null;
  readonly tenantId: string;
  readonly payload: unknown;
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        kind: 'defense_provider_invocation_v1',
        provider: input.provider,
        operation: input.operation,
        model: input.model ?? null,
        tenantId: input.tenantId,
        payload: input.payload,
      }),
    )
    .digest('hex');
}

/** SHA-256 of a payload, so its shape can be compared without being stored. */
export function payloadDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

// ── Concurrency ─────────────────────────────────────────────────────────────

export class ProviderConcurrencyLimitError extends Error {
  constructor(readonly provider: string, readonly limit: number) {
    super(`Provider ${provider} is at its concurrency limit of ${limit}`);
    this.name = 'ProviderConcurrencyLimitError';
  }
}

/**
 * Per-provider in-flight cap.
 *
 * These are called from a read route, so a slow provider under load would
 * otherwise accumulate unbounded in-flight requests inside the HTTP task. The
 * cap is per PROVIDER rather than per request, and refusal is a normal outcome
 * the caller degrades on — never a queue, because queueing on a read path just
 * converts a fast empty result into a slow one.
 */
export class ProviderConcurrencyGate {
  private inFlight = 0;

  constructor(
    readonly provider: string,
    readonly limit: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`Invalid concurrency limit for ${provider}: ${String(limit)}`);
    }
  }

  get active(): number {
    return this.inFlight;
  }

  tryAcquire(): boolean {
    if (this.inFlight >= this.limit) return false;
    this.inFlight += 1;
    return true;
  }

  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }

  /** Runs `fn` if a slot is free, otherwise returns `null` without calling it. */
  async run<T>(fn: () => Promise<T>): Promise<T | null> {
    if (!this.tryAcquire()) return null;
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export const DEFAULT_PROVIDER_CONCURRENCY = 4;
