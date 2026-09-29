import { createMeriTelemetryContext } from '@capiro/meriv2-core';
import {
  currentMeriTaskUsage,
  noteMeriProviderUsage,
  noteMeriUnknownProviderUsage,
  runWithMeriOrchestratorTelemetry,
} from './meri-telemetry.runtime.js';

describe('provider usage observations', () => {
  test('retains missing fields and partial subtotals across attempts', async () => {
    await runWithMeriOrchestratorTelemetry(
      createMeriTelemetryContext({ tenantId: 'tenant', actorId: 'actor' }),
      () => {},
      async () => {
        noteMeriProviderUsage({ inputTokens: null, outputTokens: null, estimatedCostUsd: null });
        expect(currentMeriTaskUsage()).toMatchObject({
          status: 'unknown',
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          unknownAttempts: 1,
        });
        noteMeriProviderUsage({ inputTokens: 8, outputTokens: null, estimatedCostUsd: 0 });
        expect(currentMeriTaskUsage()).toMatchObject({
          status: 'partial',
          inputTokens: 8,
          outputTokens: null,
          knownEstimatedCostUsd: null,
          unknownAttempts: 2,
        });
        noteMeriProviderUsage({ inputTokens: 2, outputTokens: 3, estimatedCostUsd: 0.02 });
        expect(currentMeriTaskUsage()).toMatchObject({
          status: 'partial',
          inputTokens: 10,
          outputTokens: 3,
          knownEstimatedCostUsd: 0.02,
          unknownAttempts: 2,
        });
      },
    );
  });
  test('distinguishes reported zero, failed attempts and malformed numbers', async () => {
    await runWithMeriOrchestratorTelemetry(
      createMeriTelemetryContext({ tenantId: 'tenant', actorId: 'actor' }),
      () => {},
      async () => {
        noteMeriProviderUsage({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
        expect(currentMeriTaskUsage()).toMatchObject({
          status: 'known',
          inputTokens: 0,
          outputTokens: 0,
          knownEstimatedCostUsd: 0,
        });
        noteMeriUnknownProviderUsage();
        noteMeriProviderUsage({ inputTokens: NaN, outputTokens: -1, estimatedCostUsd: Infinity });
        expect(currentMeriTaskUsage()).toMatchObject({
          status: 'partial',
          inputTokens: 0,
          outputTokens: 0,
          knownEstimatedCostUsd: 0,
          unknownAttempts: 2,
        });
      },
    );
  });
});
import { createMeriOtelRuntime } from '@capiro/meriv2-core/observability/otel';
import {
  currentMeriOrchestratorTelemetry,
  emitMeriOrchestratorTelemetry,
  meriOrchestratorTelemetryHeaders,
  setMeriOtelRuntime,
  withMeriOrchestratorTelemetrySpan,
} from './meri-telemetry.runtime.js';

describe('orchestrator actual SDK adapter', () => {
  afterEach(async () => {
    await setMeriOtelRuntime(undefined);
  });
  test('parallel actual child spans preserve usage owner and transported IDs', async () => {
    const spans: any[] = [];
    const sdk = createMeriOtelRuntime({
      serviceName: 'orchestrator-test',
      exporter: {
        export: (batch, done) => {
          spans.push(...batch);
          done({ code: 0 });
        },
        shutdown: async () => {},
      },
    });
    await setMeriOtelRuntime(sdk);
    const incoming = createMeriTelemetryContext({ tenantId: 'tenant', actorId: 'actor' });
    let serverId = '';
    const headers: Array<Record<string, string>> = [];
    await runWithMeriOrchestratorTelemetry(
      incoming,
      () => {
        throw new Error('private sink failure');
      },
      async () => {
        serverId = currentMeriOrchestratorTelemetry()!.spanId;
        await Promise.all(
          [1, 2].map((attempt) =>
            withMeriOrchestratorTelemetrySpan(
              { name: 'meri.tool.attempt', boundary: 'orchestrator_tool', attempt },
              async () => {
                await new Promise((resolve) => setTimeout(resolve, attempt));
                headers.push(meriOrchestratorTelemetryHeaders());
                noteMeriProviderUsage({ inputTokens: 2, outputTokens: 3, estimatedCostUsd: 0.01 });
                emitMeriOrchestratorTelemetry({
                  name: 'meri.tool.done',
                  boundary: 'orchestrator_tool',
                  outcome: 'completed',
                });
              },
              'client',
            ),
          ),
        );
        expect(currentMeriTaskUsage()).toMatchObject({
          inputTokens: 4,
          outputTokens: 6,
          knownEstimatedCostUsd: 0.02,
        });
      },
    );
    await sdk.forceFlush();
    expect(spans).toHaveLength(3);
    const server = spans.find((span) => span.spanContext().spanId === serverId);
    expect(server.parentSpanContext.spanId).toBe(incoming.spanId);
    const childIds = headers.map(
      (value) => JSON.parse(decodeURIComponent(value['x-capiro-telemetry-context']!)).spanId,
    );
    expect(new Set(childIds).size).toBe(2);
    for (const id of childIds) {
      const child = spans.find((span) => span.spanContext().spanId === id);
      expect(child.parentSpanContext.spanId).toBe(serverId);
      expect(child.attributes['meri.outcome']).toBe('completed');
      expect(child.spanContext().traceId).toBe(incoming.traceId);
    }
  });
});
