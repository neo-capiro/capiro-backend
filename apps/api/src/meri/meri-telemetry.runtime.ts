import type { MeriOtelRuntime } from '@capiro/meriv2-core/observability/otel';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import {
  admitMeriTelemetryContext,
  buildMeriTelemetryEvent,
  createMeriTelemetryContext,
  meriTelemetryChildSpanId,
  meriTelemetryTraceparent,
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

interface MeriTelemetryRuntimeState {
  context: MeriTelemetryContext;
  emit: (line: string) => void;
}

const runtime = new AsyncLocalStorage<MeriTelemetryRuntimeState>();

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : typeof value === 'string' ? value : undefined;
}

function releaseIdentity(): string | null {
  return process.env.RELEASE_SHA ?? process.env.GIT_SHA ?? process.env.IMAGE_TAG ?? null;
}

export function createMeriApiTelemetryContext(
  req: Request,
  ctx: TenantContext,
  conversationId: string,
): MeriTelemetryContext {
  return createMeriTelemetryContext({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    conversationId,
    browserRequestId: header(req, 'x-capiro-browser-request-id'),
    callerTraceparent: header(req, 'traceparent'),
    release: releaseIdentity(),
  });
}

export function runWithMeriApiTelemetry<T>(
  context: MeriTelemetryContext,
  emit: (line: string) => void,
  fn: () => Promise<T>,
): Promise<T> {
  if (!runtimeInstance?.isEnabled()) return runtime.run({ context, emit }, fn);
  return runtimeInstance.withSpan(
    context,
    { name: 'meri.api.request', boundary: 'browser_api' },
    (spanContext) => runtime.run({ context: spanContext, emit }, fn),
    { kind: 'server', preserveSpanIdentity: true },
  );
}

export function withMeriApiTelemetrySpan<T>(
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

export function currentMeriApiTelemetry(): MeriTelemetryContext | null {
  return runtime.getStore()?.context ?? null;
}

export function emitMeriApiTelemetry(input: MeriTelemetryEventInput): void {
  const state = runtime.getStore();
  if (!state) return;
  try {
    state.emit(JSON.stringify(buildMeriTelemetryEvent(state.context, input)));
  } catch {
    // Observability is never an authorization or effect boundary.
  }
  try {
    runtimeInstance?.recordEvent(state.context, input);
  } catch {
    /* Independent sink. */
  }
}

export function meriApiTelemetryHeaders(): Record<string, string> {
  const context = currentMeriApiTelemetry();
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

function secretsMatch(provided: string, expected: string): boolean {
  const left = createHash('sha256').update(provided).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

/**
 * Internal telemetry linkage is admitted only with service identity and an exact
 * authenticated tenant/actor match. In observe-mode routes, missing identity
 * produces a fresh isolated trace rather than trusting caller metadata.
 */
export function admitMeriInternalTelemetry(
  req: Request,
  ctx: TenantContext,
  conversationId?: string | null,
): MeriTelemetryContext {
  const expected = process.env.INTERNAL_SERVICE_SECRET;
  const provided = header(req, 'x-internal-service-secret');
  const encoded = header(req, 'x-capiro-telemetry-context');
  if (expected && provided && encoded && secretsMatch(provided, expected)) {
    try {
      const parsed = JSON.parse(decodeURIComponent(encoded)) as { conversationId?: unknown };
      const admitted = admitMeriTelemetryContext(parsed, {
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        conversationId:
          conversationId ??
          (typeof parsed.conversationId === 'string' ? parsed.conversationId : null),
      });
      if (admitted)
        return runtimeInstance?.isEnabled()
          ? { ...admitted, spanId: meriTelemetryChildSpanId(), parentSpanId: admitted.spanId }
          : admitted;
    } catch {
      // A malformed carrier is untrusted linkage, never an authorization failure.
    }
  }
  return createMeriTelemetryContext({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    conversationId: conversationId ?? null,
    callerTraceparent: header(req, 'traceparent'),
    release: releaseIdentity(),
  });
}
