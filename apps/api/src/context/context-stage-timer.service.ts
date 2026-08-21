import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

/**
 * The stages a governed Context Plane operation spends wall-clock time in.
 *
 * `compile` wraps ContextPacket compilation INCLUDING its persistence write, so
 * `compile` and `persistence` overlap by construction: `persistence` is the
 * nested share of `compile`, not a sibling to be added to it.
 */
export type ContextStage = 'resolver' | 'retrieval' | 'compile' | 'persistence' | 'provider';

export interface ContextProviderTelemetry {
  /** Provider status or transport failure class. Never a message body. */
  status?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
}

export interface ContextStageTimings {
  resolverMs: number | null;
  retrievalMs: number | null;
  compileMs: number | null;
  persistenceMs: number | null;
  providerMs: number | null;
  totalMs: number;
  /** Call counts, so a duration is never read as a single call. */
  calls: Partial<Record<ContextStage, number>>;
  provider: ContextProviderTelemetry | null;
}

interface StageScope {
  startedAt: number;
  durations: Map<ContextStage, number>;
  calls: Map<ContextStage, number>;
  provider: ContextProviderTelemetry | null;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * Per-operation stage timing, collected once and reported through the EXISTING
 * Context Plane audit row.
 *
 * This is deliberately not a second observability platform. There is one
 * collector, it holds nothing but durations, counts, status strings and token
 * counts, and its only sink is `audit_logs.after_jsonb` — the same row the
 * operation gate already writes, so stage latency becomes queryable in
 * production without a new store, agent, or export path.
 *
 * Nothing here may hold a prompt, a completion, a retrieved body, an email or
 * transcript body, a memory body, a secret, or a provider key. Durations,
 * counts, IDs and status enums only.
 *
 * Instrumented call sites are optional consumers: outside an active scope every
 * method is a no-op, so unit tests that construct services directly and
 * background paths that never opened a scope behave exactly as before.
 */
@Injectable()
export class ContextStageTimerService {
  private readonly storage = new AsyncLocalStorage<StageScope>();

  /** Opens one measurement scope for a single governed operation. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const scope: StageScope = {
      startedAt: performance.now(),
      durations: new Map(),
      calls: new Map(),
      provider: null,
    };
    return this.storage.run(scope, fn);
  }

  /**
   * Times one stage. Durations ACCUMULATE: a stage that runs more than once in
   * an operation (retrieval retries, several provider calls) reports total time
   * in that stage plus the call count, never the last call silently.
   *
   * A throwing stage is still recorded, because the latency of a failed
   * operation is exactly what a latency regression looks like.
   */
  async time<T>(stage: ContextStage, fn: () => Promise<T>): Promise<T> {
    const scope = this.storage.getStore();
    if (!scope) return fn();
    const startedAt = performance.now();
    try {
      return await fn();
    } finally {
      const elapsed = performance.now() - startedAt;
      scope.durations.set(stage, (scope.durations.get(stage) ?? 0) + elapsed);
      scope.calls.set(stage, (scope.calls.get(stage) ?? 0) + 1);
    }
  }

  /** Records provider identity/usage already available at the call site. */
  recordProvider(telemetry: ContextProviderTelemetry): void {
    const scope = this.storage.getStore();
    if (!scope) return;
    scope.provider = { ...(scope.provider ?? {}), ...telemetry };
  }

  /**
   * Reads the scope at audit time.
   *
   * A stage that never ran reports `null`, NOT `0`. Zero is a real measurement
   * ("ran, was instant"); null means "did not run / not instrumented on this
   * path". Collapsing them would make an un-instrumented path look fast.
   */
  snapshot(): ContextStageTimings | null {
    const scope = this.storage.getStore();
    if (!scope) return null;
    const at = (stage: ContextStage): number | null => {
      const value = scope.durations.get(stage);
      return value === undefined ? null : round(value);
    };
    return {
      resolverMs: at('resolver'),
      retrievalMs: at('retrieval'),
      compileMs: at('compile'),
      persistenceMs: at('persistence'),
      providerMs: at('provider'),
      totalMs: round(performance.now() - scope.startedAt),
      calls: Object.fromEntries(scope.calls) as ContextStageTimings['calls'],
      provider: scope.provider,
    };
  }
}

/**
 * The single process-wide collector.
 *
 * `AsyncLocalStorage` is already process-global, and the instrumented stages do
 * not all live behind Nest DI — `LlmCompletionService` is constructed with a
 * plain options object, not injected — so a shared singleton is the only shape
 * where the provider call and the gateway that opened the scope can see the
 * same store. Injecting separate instances would silently split the scope and
 * report `null` provider time forever.
 */
export const contextStageTimer = new ContextStageTimerService();
