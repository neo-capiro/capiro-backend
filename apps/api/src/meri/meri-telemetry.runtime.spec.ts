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
