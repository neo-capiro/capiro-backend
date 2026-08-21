/**
 * Phase 8 Session 8 — request pacing for live official-source discovery.
 *
 * Two facts about the real registry make naive per-adapter pacing wrong:
 *
 *  1. **Adapters share hosts.** `dod-comptroller` and
 *     `dod-comptroller-reprogramming` both publish on `comptroller.defense.gov`,
 *     and the three GovInfo adapters all publish on `www.govinfo.gov`. Pacing
 *     per adapter would let three concurrent GovInfo runs issue three times the
 *     intended request rate at one publisher. Pacing is therefore keyed by
 *     **host**, not by adapter.
 *
 *  2. **The publisher may be stricter than we are.** congress.gov declares
 *     `Crawl-delay: 2` while the registry declares a 1000 ms minimum interval
 *     for the same publisher. The effective interval is the maximum of the two.
 *
 * Everything here is pure: it computes *when* a request may be issued. Actually
 * waiting, and the atomic cross-worker reservation, live in the adapter layer.
 */

export class InvalidRequestIntervalError extends Error {
  constructor(readonly value: unknown) {
    super(`Invalid minimum request interval: ${String(value)}`);
    this.name = 'InvalidRequestIntervalError';
  }
}

/**
 * The interval a crawler must actually honour for a host.
 *
 * `robotsCrawlDelaySeconds` is the publisher's own declaration and always wins
 * when it is the stricter of the two — a crawler may be politer than the
 * registry asks, never less polite than the publisher asks.
 */
export function effectiveRequestIntervalMs(input: {
  registryMinRequestIntervalMs: number;
  robotsCrawlDelaySeconds: number | null;
}): number {
  const registry = input.registryMinRequestIntervalMs;
  if (!Number.isFinite(registry) || registry < 0) {
    throw new InvalidRequestIntervalError(registry);
  }
  const declared =
    input.robotsCrawlDelaySeconds === null || !Number.isFinite(input.robotsCrawlDelaySeconds)
      ? 0
      : Math.max(0, input.robotsCrawlDelaySeconds) * 1_000;
  return Math.max(registry, declared);
}

export interface HostPacingDecision {
  /** ISO instant at which the request may be issued. */
  readonly earliestNextRequestAt: string;
  /** Milliseconds the caller must wait before issuing. Never negative. */
  readonly waitMs: number;
  readonly intervalMs: number;
}

/**
 * Decide when the next request to a host may go out.
 *
 * `lastRequestAt === null` means this process has never talked to the host, and
 * the request may go immediately — the interval governs the gap *between*
 * requests, not a warm-up delay.
 */
export function nextHostRequestAt(input: {
  nowIso: string;
  lastRequestAt: string | null;
  intervalMs: number;
}): HostPacingDecision {
  const now = new Date(input.nowIso).getTime();
  if (Number.isNaN(now)) throw new RangeError(`Invalid instant: ${input.nowIso}`);
  if (!Number.isFinite(input.intervalMs) || input.intervalMs < 0) {
    throw new InvalidRequestIntervalError(input.intervalMs);
  }

  if (input.lastRequestAt === null) {
    return Object.freeze({
      earliestNextRequestAt: input.nowIso,
      waitMs: 0,
      intervalMs: input.intervalMs,
    });
  }

  const last = new Date(input.lastRequestAt).getTime();
  if (Number.isNaN(last)) throw new RangeError(`Invalid instant: ${input.lastRequestAt}`);

  const earliest = last + input.intervalMs;
  const waitMs = Math.max(0, earliest - now);
  return Object.freeze({
    earliestNextRequestAt: new Date(Math.max(earliest, now)).toISOString(),
    waitMs,
    intervalMs: input.intervalMs,
  });
}

/**
 * Exponential backoff for a publisher that is failing or rate-limiting us.
 *
 * Deterministic: no jitter, because a replay has to reproduce the same schedule.
 * Cross-worker spread comes from the adapter lease, not from randomness.
 */
export function publisherBackoffMs(input: {
  intervalMs: number;
  consecutiveFailures: number;
  maxBackoffMs?: number;
}): number {
  const failures = Math.max(0, Math.trunc(input.consecutiveFailures));
  if (failures === 0) return input.intervalMs;
  const maxBackoffMs = input.maxBackoffMs ?? 15 * 60_000;
  const scaled = input.intervalMs * 2 ** Math.min(failures, 16);
  return Math.min(maxBackoffMs, scaled);
}

/**
 * Honour a publisher `Retry-After`, which may be either delta-seconds or an
 * HTTP-date. A value we cannot parse is ignored rather than guessed at.
 */
export function retryAfterMs(input: { headerValue: string | null; nowIso: string }): number | null {
  const raw = input.headerValue?.trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) return Number(raw) * 1_000;

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  const now = new Date(input.nowIso).getTime();
  if (Number.isNaN(now)) throw new RangeError(`Invalid instant: ${input.nowIso}`);
  return Math.max(0, parsed - now);
}

/**
 * A hard per-run request budget.
 *
 * The first crawl of a collection faces a very large backlog — the real
 * `BILLS_2023` sitemap alone carries 13,354 package URLs. A run must therefore
 * be bounded and resumable rather than attempting the whole backlog: the cursor
 * carries the watermark forward so the next run continues where this one
 * stopped. A silently truncated run would look like "nothing more to find", so
 * exhaustion is reported explicitly.
 */
export interface RequestBudget {
  readonly limit: number;
  readonly spent: number;
}

export function createRequestBudget(limit: number): RequestBudget {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`Invalid request budget: ${String(limit)}`);
  }
  return Object.freeze({ limit, spent: 0 });
}

export function spendRequest(budget: RequestBudget, count = 1): RequestBudget {
  return Object.freeze({ limit: budget.limit, spent: budget.spent + Math.max(0, count) });
}

export function budgetRemaining(budget: RequestBudget): number {
  return Math.max(0, budget.limit - budget.spent);
}

export function budgetExhausted(budget: RequestBudget): boolean {
  return budgetRemaining(budget) === 0;
}
