import { AsyncLocalStorage } from 'node:async_hooks';
import {
  buildMeriTelemetryEvent,
  meriTelemetryChildSpanId,
  meriTelemetryTraceparent,
  meriTelemetryUsage,
  type MeriTelemetryContext,
  type MeriTelemetryEventInput,
} from '@capiro/meriv2-core';

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
  return runtime.run(
    {
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
    },
    fn,
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
  const spanId = meriTelemetryChildSpanId();
  return {
    traceparent: meriTelemetryTraceparent(context, spanId),
    'x-request-id': context.requestId,
    'x-capiro-telemetry-context': encodeURIComponent(
      JSON.stringify({
        ...context,
        spanId,
        parentSpanId: context.spanId,
      }),
    ),
  };
}
