import { AsyncLocalStorage } from 'node:async_hooks';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Attributes,
  type Span,
} from '@opentelemetry/api';
import {
  BatchSpanProcessor,
  RandomIdGenerator,
  TracerProvider,
  type SpanExporter,
} from '@opentelemetry/sdk-trace';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  buildMeriTelemetryEvent,
  type MeriTelemetryContext,
  type MeriTelemetryEvent,
  type MeriTelemetryEventInput,
} from './meri-joined-telemetry.js';

export interface MeriOtelRuntimeOptions {
  serviceName: string;
  release?: string;
  tracesEndpoint?: string;
  exporter?: SpanExporter;
  timeoutMillis?: number;
  maxQueueSize?: number;
  maxExportBatchSize?: number;
  scheduledDelayMillis?: number;
}
export interface MeriOtelSpanOptions {
  kind?: 'server' | 'client' | 'internal';
  /** Only for server-authored identities, after carrier admission at the boundary. */
  preserveSpanIdentity?: boolean;
}
export interface MeriOtelRuntime {
  isEnabled(): boolean;
  withSpan<T>(
    context: MeriTelemetryContext,
    input: MeriTelemetryEventInput,
    fn: (context: MeriTelemetryContext) => Promise<T>,
    options?: MeriOtelSpanOptions,
  ): Promise<T>;
  recordEvent(context: MeriTelemetryContext, input: MeriTelemetryEventInput): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

const identities = [
  'requestId',
  'browserRequestId',
  'callerTraceId',
  'tenantId',
  'actorId',
  'conversationId',
  'serverTurnId',
  'runId',
  'release',
  'stepId',
  'childRunId',
  'goalRevision',
  'clientId',
  'runtime',
  'provider',
  'configIdentity',
  'requestedModel',
  'effectiveModel',
  'proposalId',
  'operationId',
  'attempt',
  'retry',
  'outcome',
  'durationMs',
  'recordTruncated',
] as const;
const lists = [
  'selectedTools',
  'exposedTools',
  'invokedTools',
  'artifactIds',
  'integrationDependencies',
] as const;
const boundaries = new Set([
  'browser_api',
  'api_orchestrator',
  'orchestrator_provider',
  'orchestrator_tool',
  'api_tool',
  'api_proposal',
  'turn',
]);

/** OTel attributes cannot contain nested objects. Only projected, bounded fields enter export. */
function attributes(event: MeriTelemetryEvent): Attributes {
  const result: Attributes = {};
  for (const key of identities) {
    const value = event[key];
    if (
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      result[`meri.${key}`] = value;
  }
  for (const key of lists) {
    const value = event[key];
    if (Array.isArray(value))
      result[`meri.${key}`] = value
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 64);
  }
  if (Array.isArray(event.sourceRefs)) result['meri.sourceRefs'] = JSON.stringify(event.sourceRefs);
  if (event.usage && typeof event.usage === 'object') {
    const usage = event.usage as Record<string, unknown>;
    for (const key of [
      'status',
      'owner',
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheCreationTokens',
      'knownEstimatedCostUsd',
      'unknownAttempts',
    ]) {
      const value = usage[key];
      if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
        result[`meri.usage.${key}`] = value;
    }
  }
  return result;
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(maximum, Math.max(1, Math.floor(value)))
    : fallback;
}
function validHex(value: string, length: number): boolean {
  return (
    typeof value === 'string' &&
    new RegExp(`^[0-9a-f]{${length}}$`).test(value) &&
    !/^0+$/.test(value)
  );
}
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    /* Observability never owns the application outcome. */
  }
}
async function boundedWait(work: () => Promise<unknown>, timeoutMillis: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve()
        .then(work)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMillis);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Private SDK provider: no global registration, baggage, automatic instrumentation or payload capture. */
export function createMeriOtelRuntime(options: MeriOtelRuntimeOptions): MeriOtelRuntime {
  const timeoutMillis = bounded(options.timeoutMillis, 3000, 10000);
  const maxQueueSize = bounded(options.maxQueueSize, 512, 2048);
  const reservation = new AsyncLocalStorage<{ traceId: string; spanId?: string }>();
  const active = new AsyncLocalStorage<{ context: MeriTelemetryContext; span: Span }>();
  const random = new RandomIdGenerator();
  let provider: TracerProvider | undefined;
  let closed = false;
  let shutdown: Promise<void> | undefined;
  if (options.exporter || options.tracesEndpoint?.trim()) {
    try {
      if (!options.serviceName || options.serviceName.length > 120)
        throw new Error('invalid_service_name');
      if (!options.exporter) {
        const endpoint = new URL(options.tracesEndpoint!);
        if (
          !['http:', 'https:'].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password
        )
          throw new Error('invalid_trace_endpoint');
      }
      const exporter =
        options.exporter ??
        new OTLPTraceExporter({ url: options.tracesEndpoint!.trim(), timeoutMillis });
      provider = new TracerProvider({
        resource: resourceFromAttributes({
          'service.name': options.serviceName,
          ...(options.release ? { 'service.version': options.release.slice(0, 256) } : {}),
        }),
        idGenerator: {
          generateTraceId: () => reservation.getStore()?.traceId ?? random.generateTraceId(),
          generateSpanId: () => reservation.getStore()?.spanId ?? random.generateSpanId(),
        },
        spanLimits: {
          attributeCountLimit: 80,
          attributeValueLengthLimit: 16384,
          eventCountLimit: 64,
          attributePerEventCountLimit: 80,
          linkCountLimit: 8,
        },
        spanProcessors: [
          new BatchSpanProcessor({
            exporter,
            maxQueueSize,
            maxExportBatchSize: Math.min(
              maxQueueSize,
              bounded(options.maxExportBatchSize, 64, 512),
            ),
            scheduledDelayMillis: bounded(options.scheduledDelayMillis, 1000, 10000),
            exportTimeoutMillis: timeoutMillis,
          }),
        ],
      });
    } catch {
      /* Invalid exporter setup disables export without preventing service startup. */
    }
  }
  const recordEvent = (context: MeriTelemetryContext, input: MeriTelemetryEventInput): void => {
    if (!provider || closed) return;
    const current = active.getStore();
    if (
      !current ||
      ['traceId', 'spanId', 'tenantId', 'actorId', 'runId'].some(
        (key) =>
          current.context[key as keyof MeriTelemetryContext] !==
          context[key as keyof MeriTelemetryContext],
      )
    )
      return;
    safely(() => {
      const event = buildMeriTelemetryEvent(context, {
        ...input,
        spanId: context.spanId,
        parentSpanId: context.parentSpanId,
      });
      const projected = attributes(event);
      current.span.setAttributes(projected);
      current.span.addEvent('meri.telemetry', {
        ...projected,
        'meri.name': event.name,
        'meri.boundary': event.boundary,
      });
    });
  };
  return {
    isEnabled: () => Boolean(provider) && !closed,
    async withSpan<T>(
      context: MeriTelemetryContext,
      input: MeriTelemetryEventInput,
      fn: (context: MeriTelemetryContext) => Promise<T>,
      scope: MeriOtelSpanOptions = {},
    ): Promise<T> {
      if (!provider || closed || !validHex(context.traceId, 32) || !validHex(context.spanId, 16))
        return fn(context);
      let span: Span;
      let child: MeriTelemetryContext;
      try {
        const parentId = scope.preserveSpanIdentity ? context.parentSpanId : context.spanId;
        const parent =
          parentId && validHex(parentId, 16)
            ? trace.setSpanContext(ROOT_CONTEXT, {
                traceId: context.traceId,
                spanId: parentId,
                traceFlags: TraceFlags.SAMPLED,
              })
            : ROOT_CONTEXT;
        span = reservation.run(
          {
            traceId: context.traceId,
            ...(scope.preserveSpanIdentity ? { spanId: context.spanId } : {}),
          },
          () =>
            provider!.getTracer('capiro.meri', '1').startSpan(
              `meri.${boundaries.has(input.boundary) ? input.boundary : 'turn'}`,
              {
                kind:
                  scope.kind === 'server'
                    ? SpanKind.SERVER
                    : scope.kind === 'client'
                      ? SpanKind.CLIENT
                      : SpanKind.INTERNAL,
              },
              parent,
            ),
        );
        child = {
          ...context,
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          parentSpanId: parentId,
        };
      } catch {
        return fn(context);
      }
      // Callback execution is outside the setup catch: a failing callback must never run twice.
      return active.run({ context: child, span }, async () => {
        recordEvent(child, input);
        try {
          const result = await fn(child);
          safely(() => span.setStatus({ code: SpanStatusCode.OK }));
          return result;
        } catch (error) {
          safely(() => span.setStatus({ code: SpanStatusCode.ERROR }));
          throw error;
        } finally {
          safely(() => span.end());
        }
      });
    },
    recordEvent,
    async forceFlush() {
      if (provider && !closed)
        await boundedWait(() => provider!.forceFlush({ timeoutMillis }), timeoutMillis);
    },
    shutdown() {
      if (!shutdown) {
        closed = true;
        shutdown = provider
          ? boundedWait(() => provider!.shutdown(), timeoutMillis)
          : Promise.resolve();
      }
      return shutdown;
    },
  };
}
