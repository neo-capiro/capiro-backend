import { createMeriTelemetryContext } from '@capiro/meriv2-core';
import { createMeriOtelRuntime } from '@capiro/meriv2-core/observability/otel';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import {
  runWithMeriOrchestratorTelemetry,
  setMeriOtelRuntime,
} from '../../telemetry/meri-telemetry.runtime.js';
import { MeriV3AssistantService } from './meriv3-assistant.service.js';

describe('research callback SDK spans', () => {
  const originalFetch = global.fetch;
  let spans: any[];
  let sdk: ReturnType<typeof createMeriOtelRuntime>;
  beforeEach(async () => {
    spans = [];
    sdk = createMeriOtelRuntime({
      serviceName: 'research-callback-test',
      exporter: {
        export: (batch, done) => {
          spans.push(...batch);
          done({ code: 0 });
        },
        shutdown: async () => {},
      },
    });
    await setMeriOtelRuntime(sdk);
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    await setMeriOtelRuntime(undefined);
  });

  test.each(['budget', 'source', 'active'])(
    '%s transports its actual SDK client identity and unchanged authority',
    async (kind) => {
      const instance = Object.assign(Object.create(MeriV3AssistantService.prototype), {
        apiBaseUrl: 'http://owned-api.invalid',
        serviceSecret: 'PRIVATE_SECRET',
      });
      const calls: Array<{ headers: Record<string, string>; body?: string }> = [];
      global.fetch = jest.fn(async (_url, init) => {
        calls.push(init as never);
        return {
          ok: true,
          status: 200,
          json: async () => ({ active: true, reserved: true }),
        } as Response;
      });
      const root = createMeriTelemetryContext({ tenantId: 'tenant-1', actorId: 'actor-1' });
      const run = { sessionId: 'session-1', runId: 'run-1', leaseEpoch: 4 };
      await RequestCredentialsStore.run(
        { bearerToken: 'PRIVATE_BEARER', impersonateTenantId: 'effective-tenant' },
        () =>
          runWithMeriOrchestratorTelemetry(
            root,
            () => {},
            async () => {
              if (kind === 'budget')
                await instance.researchProviderBudgetRequest(run, 'reservations', {
                  attemptId: 'attempt-1',
                });
              else if (kind === 'source')
                await instance.researchSafeReadRequest(run, 'outcomes', {
                  result: 'PRIVATE_RESULT',
                });
              else await instance.assertResearchRunActive({ researchRun: run });
            },
          ),
      );
      await sdk.forceFlush();
      expect(calls).toHaveLength(1);
      const headers = calls[0]!.headers;
      expect(headers['x-capiro-telemetry-context']).toBeDefined();
      const carrier = JSON.parse(decodeURIComponent(headers['x-capiro-telemetry-context']!));
      const client = spans.find((span) => span.spanContext().spanId === carrier.spanId);
      expect(client).toBeDefined();
      expect(client.kind).toBe(2);
      expect(client.spanContext().traceId).toBe(root.traceId);
      expect(headers.traceparent).toBe(`00-${root.traceId}-${client.spanContext().spanId}-01`);
      expect(headers.authorization).toBe('Bearer PRIVATE_BEARER');
      expect(headers['x-internal-service-secret']).toBe('PRIVATE_SECRET');
      expect(headers['x-capiro-impersonate-tenant']).toBe('effective-tenant');
      if (kind !== 'active') expect(JSON.parse(calls[0]!.body!)).toMatchObject({ leaseEpoch: 4 });
      const exported = JSON.stringify(
        spans.map((span) => ({ attributes: span.attributes, events: span.events })),
      );
      for (const value of [
        'PRIVATE_SECRET',
        'PRIVATE_BEARER',
        'PRIVATE_RESULT',
        'owned-api.invalid',
      ])
        expect(exported).not.toContain(value);
    },
  );

  test('lease loss marks the active-check span failed and never retries the callback', async () => {
    const instance = Object.assign(Object.create(MeriV3AssistantService.prototype), {
      apiBaseUrl: 'http://owned-api.invalid',
      serviceSecret: 'PRIVATE_SECRET',
    });
    const fetchMock = jest.fn(async () => ({ ok: false, status: 409 }) as Response);
    global.fetch = fetchMock;
    await expect(
      RequestCredentialsStore.run({ bearerToken: 'PRIVATE_BEARER' }, () =>
        runWithMeriOrchestratorTelemetry(
          createMeriTelemetryContext({ tenantId: 'tenant-1', actorId: 'actor-1' }),
          () => {},
          () =>
            instance.assertResearchRunActive({
              researchRun: { sessionId: 'session-1', runId: 'run-1' },
            }),
        ),
      ),
    ).rejects.toMatchObject({ name: 'ResearchRunInactiveError' });
    await sdk.forceFlush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const client = spans.find((span) => span.name === 'meri.research_checkpoint');
    expect(client.status.code).toBe(2);
  });
});
