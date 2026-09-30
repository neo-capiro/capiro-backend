import type { MeriOtelRuntime } from '@capiro/meriv2-core/observability/otel';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  buildMeriTelemetryEvent,
  meriTelemetryChildSpanId,
  meriTelemetryTraceparent,
  meriTelemetryUsage,
  type MeriTelemetryContext,
  type MeriTelemetryEventInput,
} from '@capiro/meriv2-core';

let runtimeInstance: MeriOtelRuntime | undefined;

/** Lifecycle/test replacement owns shutdown; no global OTel state is changed. */
export async function setMeriOtelRuntime(next: MeriOtelRuntime | undefined): Promise<void> {
  const previous = runtimeInstance;
  runtimeInstance = next;
  if (previous && previous !== next) await previous.shutdown();
}

export function getMeriOtelRuntime(): MeriOtelRuntime | undefined {
  return runtimeInstance;
}

interface KnownUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
  observedFields: Set<string>;
  knownCostAttempts: number;
  unknownAttempts: number;
}

interface RuntimeState {
  context: MeriTelemetryContext;
  emit: (line: string) => void;
  usage: KnownUsage;
  configIdentity: string | null;
}

const runtime = new AsyncLocalStorage<RuntimeState>();

export function runWithMeriOrchestratorTelemetry<T>(
  context: MeriTelemetryContext,
  emit: (line: string) => void,
  fn: () => Promise<T>,
): Promise<T> {
  const state: RuntimeState = {
    context,
    emit,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: 0,
      observedFields: new Set(),
      knownCostAttempts: 0,
      unknownAttempts: 0,
    },
    configIdentity: null,
  };
  if (!runtimeInstance?.isEnabled()) return runtime.run(state, fn);
  return runtimeInstance.withSpan(
    context,
    { name: 'meri.orchestrator.request', boundary: 'api_orchestrator' },
    (spanContext) => runtime.run({ ...state, context: spanContext }, fn),
    { kind: 'server' },
  );
}

export function withMeriOrchestratorTelemetrySpan<T>(
  input: MeriTelemetryEventInput,
  fn: () => Promise<T>,
  kind: 'server' | 'client' | 'internal' = 'internal',
): Promise<T> {
  const state = runtime.getStore();
  if (!state || !runtimeInstance?.isEnabled()) return fn();
  return runtimeInstance.withSpan(
    state.context,
    input,
    (spanContext) => runtime.run({ ...state, context: spanContext }, fn),
    { kind },
  );
}

export function currentMeriOrchestratorTelemetry(): MeriTelemetryContext | null {
  return runtime.getStore()?.context ?? null;
}

export function setMeriTelemetryConfigIdentity(value: string): void {
  const state = runtime.getStore();
  if (state) state.configIdentity = value;
}

export function meriTelemetryConfigIdentityForCurrent(): string | null {
  return runtime.getStore()?.configIdentity ?? null;
}

export function emitMeriOrchestratorTelemetry(input: MeriTelemetryEventInput): void {
  const state = runtime.getStore();
  if (!state) return;
  try {
    state.emit(
      JSON.stringify(
        buildMeriTelemetryEvent(state.context, {
          ...input,
          configIdentity: input.configIdentity ?? state.configIdentity,
        }),
      ),
    );
  } catch {
    // Telemetry sink failures cannot block model, tool, proposal, or artifact work.
  }
  try {
    runtimeInstance?.recordEvent(state.context, {
      ...input,
      configIdentity: input.configIdentity ?? state.configIdentity,
    });
  } catch {
    /* Independent sink. */
  }
}

export function noteMeriProviderUsage(input: {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  estimatedCostUsd: number | null;
}): void {
  const usage = runtime.getStore()?.usage;
  if (!usage) return;
  const tokens = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  for (const field of [
    'inputTokens',
    'outputTokens',
    'cacheReadTokens',
    'cacheCreationTokens',
  ] as const) {
    const value = input[field];
    if (tokens(value)) {
      usage[field] += value;
      usage.observedFields.add(field);
    }
  }
  const cost = input.estimatedCostUsd;
  if (
    !tokens(input.inputTokens) ||
    !tokens(input.outputTokens) ||
    typeof cost !== 'number' ||
    !Number.isFinite(cost) ||
    cost < 0
  ) {
    usage.unknownAttempts += 1;
  } else {
    usage.estimatedCostUsd += cost;
    usage.knownCostAttempts += 1;
  }
}

export function noteMeriUnknownProviderUsage(): void {
  const usage = runtime.getStore()?.usage;
  if (usage) usage.unknownAttempts += 1;
}

export function currentMeriTaskUsage() {
  const usage = runtime.getStore()?.usage;
  if (!usage) return meriTelemetryUsage();
  return meriTelemetryUsage({
    inputTokens: usage.observedFields.has('inputTokens') ? usage.inputTokens : null,
    outputTokens: usage.observedFields.has('outputTokens') ? usage.outputTokens : null,
    cacheReadTokens: usage.observedFields.has('cacheReadTokens') ? usage.cacheReadTokens : null,
    cacheCreationTokens: usage.observedFields.has('cacheCreationTokens')
      ? usage.cacheCreationTokens
      : null,
    knownEstimatedCostUsd: usage.knownCostAttempts ? usage.estimatedCostUsd : null,
    unknownAttempts: usage.unknownAttempts,
  });
}

export function meriOrchestratorTelemetryHeaders(): Record<string, string> {
  const context = currentMeriOrchestratorTelemetry();
  if (!context) return {};
  const exporting = runtimeInstance?.isEnabled() === true;
  const spanId = exporting ? context.spanId : meriTelemetryChildSpanId();
  return {
    traceparent: meriTelemetryTraceparent(context, spanId),
    'x-request-id': context.requestId,
    'x-capiro-telemetry-context': encodeURIComponent(
      JSON.stringify({
        ...context,
        spanId,
        parentSpanId: exporting ? context.parentSpanId : context.spanId,
      }),
    ),
  };
}
