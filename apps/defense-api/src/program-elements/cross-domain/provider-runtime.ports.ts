/**
 * Phase 8 Session 9 — provider runtime seams.
 *
 * The transport and the audit sink are behind interfaces for the same reason
 * Sessions 7 and 8 put discovery and retrieval behind them: the parts that can
 * fail silently — selection, retry classification, degradation, idempotency,
 * concurrency refusal and what gets written down — must be testable against
 * recorded provider responses with no network and no database.
 *
 * There is no `execute()` that throws. Every seam returns an outcome, because
 * both ports Session 9 wires are documented to degrade rather than raise, and a
 * seam that could throw would put that contract at the mercy of a `catch`.
 */

import type { ProviderFailureClass, ProviderInvocationAudit } from '@capiro/defense-domain';

/** One provider HTTP exchange, already classified. */
export interface ProviderHttpResult {
  readonly ok: boolean;
  readonly statusCode: number | null;
  /** Parsed JSON body on success. */
  readonly body: unknown;
  readonly failureClass: ProviderFailureClass | null;
  /** Provider `Retry-After`, parsed to milliseconds when present. */
  readonly retryAfterMs: number | null;
  readonly detail: string | null;
}

export interface ProviderHttpPort {
  /**
   * Issue one attempt. Implementations must apply the per-attempt timeout and
   * must never follow a redirect to a different origin.
   */
  post(input: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
    readonly timeoutMs: number;
  }): Promise<ProviderHttpResult>;
}

export const PROVIDER_HTTP_PORT = Symbol('PROVIDER_HTTP_PORT');

/**
 * Append-only audit sink.
 *
 * `record` must never throw into the caller: failing to WRITE an audit row must
 * not turn a degraded-but-working read route into a 500. It reports instead.
 */
export interface ProviderAuditSink {
  record(audit: ProviderInvocationAudit): Promise<{ persisted: boolean; reason: string | null }>;
}

export const PROVIDER_AUDIT_SINK = Symbol('PROVIDER_AUDIT_SINK');

/** Injected so tests are deterministic and never actually sleep. */
export interface ProviderClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const PROVIDER_CLOCK = Symbol('PROVIDER_CLOCK');

export const systemProviderClock: ProviderClock = Object.freeze({
  now: () => Date.now(),
  sleep: (ms: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
});
