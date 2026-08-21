/**
 * Phase 8 Session 9 — provider runtime test doubles.
 *
 * A scripted transport, an in-memory audit sink that enforces the same
 * invariants the database CHECKs do, and a deterministic clock that never really
 * sleeps. Same reason Sessions 7 and 8 shipped fixture ports: the parts that can
 * fail silently — retry classification, degradation, idempotency, concurrency
 * refusal and what is written down — have to be testable without a network, a
 * credential or a database.
 */

import {
  assertProviderAuditCarriesNoSecrets,
  isDegradedOutcome,
  type ProviderFailureClass,
  type ProviderInvocationAudit,
} from '@capiro/defense-domain';

import type {
  ProviderAuditSink,
  ProviderClock,
  ProviderHttpPort,
  ProviderHttpResult,
} from '../provider-runtime.ports.js';

export interface ScriptedResponse {
  readonly ok?: boolean;
  readonly statusCode?: number | null;
  readonly body?: unknown;
  readonly failureClass?: ProviderFailureClass | null;
  readonly retryAfterMs?: number | null;
  readonly detail?: string | null;
}

/**
 * Serves a scripted sequence of responses, one per attempt.
 *
 * Running past the end of the script is a hard failure rather than a repeat of
 * the last entry: a test that silently got an extra attempt would pass for the
 * wrong reason.
 */
export class ScriptedProviderHttp implements ProviderHttpPort {
  readonly calls: Array<{
    url: string;
    headers: Readonly<Record<string, string>>;
    body: unknown;
    timeoutMs: number;
  }> = [];

  private index = 0;

  constructor(private readonly script: readonly ScriptedResponse[]) {}

  get attempts(): number {
    return this.index;
  }

  async post(input: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: unknown;
    timeoutMs: number;
  }): Promise<ProviderHttpResult> {
    this.calls.push(input);
    const scripted = this.script[this.index];
    this.index += 1;
    if (!scripted) {
      throw new Error(
        `ScriptedProviderHttp exhausted after ${this.script.length} response(s); ` +
          'the code under test made more attempts than the script allows',
      );
    }
    const ok = scripted.ok ?? true;
    return Object.freeze({
      ok,
      statusCode: scripted.statusCode ?? (ok ? 200 : 500),
      body: ok ? (scripted.body ?? {}) : null,
      failureClass: ok ? null : (scripted.failureClass ?? 'unavailable'),
      retryAfterMs: scripted.retryAfterMs ?? null,
      detail: scripted.detail ?? null,
    });
  }
}

/**
 * In-memory audit sink that mirrors the database's own constraints, so a row the
 * real table would refuse fails here too.
 */
export class InMemoryProviderAuditSink implements ProviderAuditSink {
  readonly rows: ProviderInvocationAudit[] = [];

  /** Set to make the sink report a write failure, for the degrade-path test. */
  failNext = false;

  async record(
    audit: ProviderInvocationAudit,
  ): Promise<{ persisted: boolean; reason: string | null }> {
    if (this.failNext) {
      this.failNext = false;
      return { persisted: false, reason: 'simulated audit write failure' };
    }

    assertProviderAuditCarriesNoSecrets(audit);

    // Mirrors dpi_failure_class_chk.
    if ((audit.outcome === 'degraded_failed') !== (audit.failureClass !== null)) {
      throw new Error(
        `audit row violates the failure-class invariant: outcome=${audit.outcome} ` +
          `failureClass=${String(audit.failureClass)}`,
      );
    }
    // Mirrors dpi_degraded_no_dimension_chk.
    if (isDegradedOutcome(audit.outcome) && audit.resultDimension !== null) {
      throw new Error('a degraded invocation cannot report an embedding dimension');
    }
    // Mirrors dpi_model_only_for_embedding_chk.
    if (audit.operation !== 'embed_query' && audit.model !== null) {
      throw new Error('only an embedding invocation may carry a model id');
    }
    // Mirrors dpi_count_only_for_relevance_chk.
    if (audit.operation !== 'relevant_pe_codes' && audit.resultCount !== null) {
      throw new Error('only a relevance invocation may carry a result count');
    }

    this.rows.push(audit);
    return { persisted: true, reason: null };
  }

  byOutcome(outcome: string): ProviderInvocationAudit[] {
    return this.rows.filter((row) => row.outcome === outcome);
  }
}

/**
 * Deterministic clock. `sleep` advances virtual time instead of waiting, so a
 * retry schedule is asserted exactly rather than approximately.
 */
export class FakeProviderClock implements ProviderClock {
  readonly slept: number[] = [];

  constructor(private current = 1_760_000_000_000) {}

  now(): number {
    return this.current;
  }

  /** Advance without sleeping, for simulating provider latency. */
  advance(ms: number): void {
    this.current += ms;
  }

  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.current += ms;
  }
}
