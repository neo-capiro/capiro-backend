import type { Request } from 'express';
import {
  admitMeriInternalTelemetry,
  createMeriApiTelemetryContext,
  currentMeriApiTelemetry,
  emitMeriApiTelemetry,
  meriApiTelemetryHeaders,
  runWithMeriApiTelemetry,
} from './meri-telemetry.runtime.js';

const ctx = { tenantId: 'tenant-a', userId: 'actor-a' } as never;

function request(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

describe('Meri API telemetry runtime', () => {
  const originalSecret = process.env.INTERNAL_SERVICE_SECRET;

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
  });

  test('joins trusted internal boundaries but isolates a changed actor or forged carrier', async () => {
    process.env.INTERNAL_SERVICE_SECRET = 'service-secret';
    const root = createMeriApiTelemetryContext(
      request({
        'x-capiro-browser-request-id': 'browser-1',
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      }),
      ctx,
      'conversation-a',
    );
    let headers: Record<string, string> = {};
    await runWithMeriApiTelemetry(
      root,
      () => {},
      async () => {
        expect(currentMeriApiTelemetry()?.traceId).toBe(root.traceId);
        headers = meriApiTelemetryHeaders();
      },
    );

    const joined = admitMeriInternalTelemetry(
      request({ ...headers, 'x-internal-service-secret': 'service-secret' }),
      ctx,
      'conversation-a',
    );
    const changedActor = admitMeriInternalTelemetry(
      request({ ...headers, 'x-internal-service-secret': 'service-secret' }),
      { tenantId: 'tenant-a', userId: 'actor-b' } as never,
      'conversation-a',
    );
    const forged = admitMeriInternalTelemetry(
      request({ ...headers, 'x-internal-service-secret': 'wrong-secret' }),
      ctx,
      'conversation-a',
    );

    expect(joined.traceId).toBe(root.traceId);
    expect(joined.requestId).toBe(root.requestId);
    expect(joined.parentSpanId).toBe(root.spanId);
    expect(changedActor.traceId).not.toBe(root.traceId);
    expect(changedActor.actorId).toBe(
      createMeriApiTelemetryContext(
        request(),
        { tenantId: 'tenant-a', userId: 'actor-b' } as never,
        'conversation-a',
      ).actorId,
    );
    expect(forged.traceId).not.toBe(root.traceId);
    expect(JSON.stringify(joined)).not.toContain('service-secret');
  });

  test('does not let a telemetry sink failure block served work', async () => {
    const root = createMeriApiTelemetryContext(request(), ctx, 'conversation-a');
    await expect(
      runWithMeriApiTelemetry(
        root,
        () => {
          throw new Error('sink unavailable');
        },
        async () => {
          emitMeriApiTelemetry({
            name: 'meri.api.request.received',
            boundary: 'browser_api',
          });
          return 'served';
        },
      ),
    ).resolves.toBe('served');
  });
});
import { createMeriOtelRuntime } from '@capiro/meriv2-core/observability/otel';
import { MeriOtelLifecycleProvider } from './meri-otel-lifecycle.provider.js';
import {
  getMeriOtelRuntime,
  setMeriOtelRuntime,
  withMeriApiTelemetrySpan,
} from './meri-telemetry.runtime.js';

describe('API SDK adapter and lifecycle', () => {
  afterEach(async () => {
    await setMeriOtelRuntime(undefined);
  });

  test('actual exported server/client IDs match transported headers despite failing log sink', async () => {
    const spans: any[] = [];
    const sdk = createMeriOtelRuntime({
      serviceName: 'api-test',
      exporter: {
        export: (batch, done) => {
          spans.push(...batch);
          done({ code: 0 });
        },
        shutdown: async () => {},
      },
    });
    await setMeriOtelRuntime(sdk);
    const root = createMeriApiTelemetryContext(request(), ctx, 'conversation-a');
    let headers: Record<string, string> = {};
    await runWithMeriApiTelemetry(
      root,
      () => {
        throw new Error('private sink exception');
      },
      async () => {
        await withMeriApiTelemetrySpan(
          { name: 'meri.api.orchestrator', boundary: 'api_orchestrator' },
          async () => {
            headers = meriApiTelemetryHeaders();
            emitMeriApiTelemetry({
              name: 'meri.api.sent',
              boundary: 'api_orchestrator',
              outcome: 'completed',
            });
          },
          'client',
        );
      },
    );
    await sdk.forceFlush();
    expect(spans).toHaveLength(2);
    const carrier = JSON.parse(decodeURIComponent(headers['x-capiro-telemetry-context']!));
    const child = spans.find((span) => span.spanContext().spanId === carrier.spanId);
    expect(child).toBeDefined();
    expect(child.parentSpanContext.spanId).toBe(root.spanId);
    expect(child.attributes['meri.outcome']).toBe('completed');
    expect(headers.traceparent).toBe(`00-${root.traceId}-${child.spanContext().spanId}-01`);
    process.env.INTERNAL_SERVICE_SECRET = 'secret';
    try {
      const admitted = admitMeriInternalTelemetry(
        request({ ...headers, 'x-internal-service-secret': 'secret' }),
        ctx,
        'conversation-a',
      );
      expect(admitted.parentSpanId).toBe(carrier.spanId);
      expect(admitted.spanId).not.toBe(carrier.spanId);
      expect(admitted.traceId).toBe(root.traceId);
    } finally {
      delete process.env.INTERNAL_SERVICE_SECRET;
    }
  });

  test('SDK lifecycle is endpoint opt-in, initializes once and shuts down idempotently', async () => {
    const originalEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    try {
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      const disabled = new MeriOtelLifecycleProvider();
      await disabled.onModuleInit();
      expect(getMeriOtelRuntime()).toBeUndefined();
      await disabled.onApplicationShutdown();
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = 'http://127.0.0.1:4318/v1/traces';
      const lifecycle = new MeriOtelLifecycleProvider();
      await lifecycle.onModuleInit();
      const runtime = getMeriOtelRuntime()!;
      expect(runtime.isEnabled()).toBe(true);
      await lifecycle.onModuleInit();
      expect(getMeriOtelRuntime()).toBe(runtime);
      const shutdown = jest.spyOn(runtime, 'shutdown');
      await lifecycle.onApplicationShutdown();
      await lifecycle.onApplicationShutdown();
      expect(shutdown).toHaveBeenCalledTimes(1);
      expect(getMeriOtelRuntime()).toBeUndefined();
    } finally {
      if (originalEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = originalEndpoint;
    }
  });
});
