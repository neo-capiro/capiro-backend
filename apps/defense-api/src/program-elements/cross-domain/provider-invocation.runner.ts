/**
 * Phase 8 Session 9 — the one place a provider is actually invoked.
 *
 * Both cross-domain ports share exactly the same operational obligations —
 * bounded deterministic retry, concurrency refusal, idempotency, an audit row
 * whatever happens, and degradation rather than an exception — so they share one
 * runner. Duplicating this per port is how the two would drift until one of them
 * quietly threw on a read path.
 *
 * The single rule the runner enforces above all others: **an invocation always
 * produces an audit row, and never produces an exception.** A provider failure, a
 * concurrency refusal, an unconfigured provider and a malformed response are all
 * outcomes. The caller receives `null` and serves its documented empty result.
 */

import { Logger } from '@nestjs/common';

import {
  ProviderConcurrencyGate,
  buildProviderAudit,
  nextRetryDecision,
  payloadDigest,
  providerIdempotencyKey,
  type ProviderFailureClass,
  type ProviderInvocationAudit,
  type ProviderOperation,
  type ProviderOutcome,
  type RetryPolicy,
} from '@capiro/defense-domain';

import type {
  ProviderAuditSink,
  ProviderClock,
  ProviderHttpResult,
} from './provider-runtime.ports.js';

export interface InvocationRequest<TResult> {
  readonly provider: string;
  readonly operation: ProviderOperation;
  readonly model: string | null;
  readonly tenantId: string;
  /** Hashed for the audit row; never stored or logged in the clear. */
  readonly payload: unknown;
  readonly policy: RetryPolicy;
  /** One attempt. Returns a classified result, never throws. */
  readonly attempt: () => Promise<ProviderHttpResult>;
  /**
   * Interpret a successful body. Returning `null` means the provider answered
   * but the body was not usable, which is a `malformed_response` — not a success
   * with an empty value.
   */
  readonly interpret: (body: unknown) => TResult | null;
  /** Dimension of an embedding result, for the audit row. */
  readonly resultDimension?: (result: TResult) => number | null;
  /** Count of a relevance result, for the audit row. */
  readonly resultCount?: (result: TResult) => number | null;
}

export interface InvocationOutcome<TResult> {
  readonly result: TResult | null;
  readonly audit: ProviderInvocationAudit;
}

export class ProviderInvocationRunner {
  private readonly logger = new Logger(ProviderInvocationRunner.name);

  constructor(
    private readonly audit: ProviderAuditSink,
    private readonly clock: ProviderClock,
    private readonly gates: Map<string, ProviderConcurrencyGate>,
  ) {}

  private gateFor(provider: string, limit: number): ProviderConcurrencyGate {
    let gate = this.gates.get(provider);
    if (!gate) {
      gate = new ProviderConcurrencyGate(provider, limit);
      this.gates.set(provider, gate);
    }
    return gate;
  }

  /**
   * Record an outcome that never reached the provider at all — an unconfigured
   * port, or empty input. Still audited, because "nobody asked" and "the answer
   * was empty" must be distinguishable.
   */
  async recordNonInvocation(input: {
    readonly provider: string;
    readonly operation: ProviderOperation;
    readonly model: string | null;
    readonly tenantId: string;
    readonly payload: unknown;
    readonly outcome: Extract<ProviderOutcome, 'degraded_unconfigured' | 'degraded_empty_input'>;
    readonly reason: string;
  }): Promise<ProviderInvocationAudit> {
    const at = new Date(this.clock.now()).toISOString();
    const record = buildProviderAudit({
      provider: input.provider,
      operation: input.operation,
      outcome: input.outcome,
      model: input.operation === 'embed_query' ? input.model : null,
      tenantId: input.tenantId,
      payloadSha256: payloadDigest(input.payload),
      idempotencyKey: providerIdempotencyKey({
        provider: input.provider,
        operation: input.operation,
        model: input.model,
        tenantId: input.tenantId,
        payload: input.payload,
      }),
      attempts: 0,
      latencyMs: 0,
      failureClass: null,
      reason: input.reason,
      resultDimension: null,
      resultCount: null,
      startedAt: at,
      finishedAt: at,
    });
    await this.persist(record);
    return record;
  }

  async invoke<TResult>(
    request: InvocationRequest<TResult>,
    concurrencyLimit: number,
  ): Promise<InvocationOutcome<TResult>> {
    const gate = this.gateFor(request.provider, concurrencyLimit);
    const startedAtMs = this.clock.now();
    const startedAt = new Date(startedAtMs).toISOString();

    const payloadSha256 = payloadDigest(request.payload);
    const idempotencyKey = providerIdempotencyKey({
      provider: request.provider,
      operation: request.operation,
      model: request.model,
      tenantId: request.tenantId,
      payload: request.payload,
    });

    const finish = async (
      outcome: ProviderOutcome,
      detail: {
        attempts: number;
        failureClass: ProviderFailureClass | null;
        reason: string;
        result: TResult | null;
      },
    ): Promise<InvocationOutcome<TResult>> => {
      const finishedAtMs = this.clock.now();
      const record = buildProviderAudit({
        provider: request.provider,
        operation: request.operation,
        outcome,
        model: request.operation === 'embed_query' ? request.model : null,
        tenantId: request.tenantId,
        payloadSha256,
        idempotencyKey,
        attempts: detail.attempts,
        latencyMs: Math.max(0, finishedAtMs - startedAtMs),
        failureClass: detail.failureClass,
        reason: detail.reason,
        resultDimension:
          detail.result === null ? null : (request.resultDimension?.(detail.result) ?? null),
        resultCount: detail.result === null ? null : (request.resultCount?.(detail.result) ?? null),
        startedAt,
        finishedAt: new Date(finishedAtMs).toISOString(),
      });
      await this.persist(record);
      return { result: detail.result, audit: record };
    };

    // Concurrency is refused, never queued: queueing on a read path converts a
    // fast empty result into a slow one, which is strictly worse.
    if (!gate.tryAcquire()) {
      this.logger.warn(
        `${request.provider} at concurrency limit ${concurrencyLimit}; degrading to the empty result`,
      );
      return finish('degraded_concurrency', {
        attempts: 0,
        failureClass: null,
        reason: `provider at its concurrency limit of ${concurrencyLimit}`,
        result: null,
      });
    }

    try {
      let attempts = 0;
      let lastFailure: ProviderFailureClass | null = null;
      let lastDetail = 'no attempt was made';

      for (;;) {
        attempts += 1;
        const response = await request.attempt();

        if (response.ok) {
          const interpreted = request.interpret(response.body);
          if (interpreted !== null) {
            return finish('succeeded', {
              attempts,
              failureClass: null,
              reason: `provider answered on attempt ${attempts}`,
              result: interpreted,
            });
          }
          // A 200 with a body we cannot use is a failure, not an empty success.
          lastFailure = 'malformed_response';
          lastDetail = 'provider returned a response body that could not be interpreted';
        } else {
          lastFailure = response.failureClass ?? 'unknown';
          lastDetail = response.detail ?? `provider failed with ${lastFailure}`;
        }

        const decision = nextRetryDecision({
          failure: lastFailure,
          attemptsMade: attempts,
          policy: request.policy,
          elapsedMs: this.clock.now() - startedAtMs,
          retryAfterMs: response.retryAfterMs,
        });

        if (!decision.retry) {
          this.logger.warn(
            `${request.provider}/${request.operation} degraded after ${attempts} attempt(s): ` +
              `${lastFailure} — ${decision.reason}`,
          );
          return finish('degraded_failed', {
            attempts,
            failureClass: lastFailure,
            reason: `${lastDetail}; ${decision.reason}`,
            result: null,
          });
        }

        if (decision.delayMs > 0) await this.clock.sleep(decision.delayMs);
      }
    } finally {
      gate.release();
    }
  }

  /**
   * Persisting the audit row must not be able to fail the request. A read route
   * that degrades correctly but 500s because its audit insert failed would be a
   * worse outcome than the degradation it was recording.
   */
  private async persist(record: ProviderInvocationAudit): Promise<void> {
    try {
      const outcome = await this.audit.record(record);
      if (!outcome.persisted) {
        this.logger.warn(
          `provider audit row not persisted (${outcome.reason ?? 'no reason given'})`,
        );
      }
    } catch (error) {
      this.logger.error(
        `provider audit sink threw; continuing so the read path still degrades cleanly: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
