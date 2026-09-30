import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { InMemorySpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace';
import {
  createMeriTelemetryContext,
  meriTelemetryUsage,
  meriTelemetryIdentifier,
} from './meri-joined-telemetry.js';
import { createMeriOtelRuntime } from './meri-otel.js';

const rootInput = { name: 'meri.request', boundary: 'browser_api' as const };
const childInput = {
  name: 'meri.provider.attempt',
  boundary: 'orchestrator_provider' as const,
  provider: 'openai',
};
function context(tenant = 'tenant-a') {
  return createMeriTelemetryContext({ tenantId: tenant, actorId: 'actor-a' });
}

describe('Meri actual SDK export', () => {
  test.each([
    'research_run',
    'research_child',
    'research_budget',
    'research_source',
    'research_checkpoint',
  ] as const)(
    'exports projected durable metadata on actual %s spans and events',
    async (boundary) => {
      const exporter = new InMemorySpanExporter();
      const runtime = createMeriOtelRuntime({ serviceName: 'api', exporter });
      const root = context();
      try {
        await runtime.withSpan(
          root,
          rootInput,
          async (parent) => {
            await runtime.withSpan(
              parent,
              { name: 'meri.research.owner', boundary, durableRunId: 'private-run', leaseEpoch: 3 },
              async (child) => {
                runtime.recordEvent(child, {
                  name: 'meri.research.result',
                  boundary,
                  checkpointSequence: 4,
                  remainingBudget: {
                    attempts: 0,
                    tokens: 12,
                    costMicros: null,
                    timeMs: -1,
                    privatePayload: 'PRIVATE',
                  },
                  sourceCoverage: 'partial',
                  terminalReason: 'completed',
                  verificationVerdict: 'pass',
                  cancellationIssuer: 'user',
                  modelEffort: 'low',
                  promptVersion: 'private-prompt',
                  toolVersion: 'private-tool',
                  skillVersion: 'private-skill',
                  artifactVersion: 'private-artifact',
                  researchSessionId: 'private-session',
                  authorizedConversationId: 'private-conversation',
                  rawPrompt: 'PRIVATE',
                } as never);
              },
            );
          },
          { preserveSpanIdentity: true },
        );
        await runtime.forceFlush();
        const spans = exporter.getFinishedSpans();
        expect(spans).toHaveLength(2);
        const child = spans.find((span) => span.name === `meri.${boundary}`)!;
        expect(child.parentSpanContext?.spanId).toBe(root.spanId);
        expect(child.attributes).toMatchObject({
          'meri.durableRunId': meriTelemetryIdentifier('private-run'),
          'meri.leaseEpoch': 3,
          'meri.checkpointSequence': 4,
          'meri.remainingBudget.attempts': 0,
          'meri.remainingBudget.tokens': 12,
          'meri.sourceCoverage': 'partial',
          'meri.verificationVerdict': 'pass',
          'meri.terminalReason': 'completed',
          'meri.promptVersion': meriTelemetryIdentifier('private-prompt'),
          'meri.modelEffort': 'low',
        });
        expect(child.attributes['meri.remainingBudget.costMicros']).toBeUndefined();
        expect(child.attributes['meri.remainingBudget.timeMs']).toBeUndefined();
        expect(
          child.events.some((event) => event.attributes?.['meri.checkpointSequence'] === 4),
        ).toBe(true);
        expect(
          child.events.every((event) => event.attributes?.['meri.boundary'] === boundary),
        ).toBe(true);
        const exported = JSON.stringify(
          spans.map((span) => ({ attributes: span.attributes, events: span.events })),
        );
        for (const secret of [
          'PRIVATE',
          'private-run',
          'private-prompt',
          'private-tool',
          'private-skill',
          'private-artifact',
          'private-session',
          'private-conversation',
        ])
          expect(exported).not.toContain(secret);
      } finally {
        await runtime.shutdown();
      }
    },
  );
  test('disabled preserves the exact context and callback outcome once', async () => {
    const runtime = createMeriOtelRuntime({ serviceName: 'api' });
    const root = context();
    const callback = jest.fn(async (received) => {
      expect(received).toBe(root);
      return 'served';
    });
    expect(runtime.isEnabled()).toBe(false);
    await expect(runtime.withSpan(root, rootInput, callback)).resolves.toBe('served');
    expect(callback).toHaveBeenCalledTimes(1);
    await runtime.forceFlush();
    await runtime.shutdown();
    await runtime.shutdown();
  });

  test('exports real preserved roots and isolated concurrent parent-child spans', async () => {
    const exporter = new InMemorySpanExporter();
    const runtime = createMeriOtelRuntime({ serviceName: 'api', exporter });
    const roots = [context('tenant-a'), context('tenant-b')];
    try {
      await Promise.all(
        roots.map((root) =>
          runtime.withSpan(
            root,
            rootInput,
            async (parent) => {
              expect(parent.spanId).toBe(root.spanId);
              await Promise.all(
                [1, 2].map(async (attempt) =>
                  runtime.withSpan(
                    parent,
                    { ...childInput, attempt },
                    async (child) => {
                      await new Promise((resolve) => setTimeout(resolve, attempt));
                      runtime.recordEvent(child, { ...childInput, attempt, outcome: 'completed' });
                      runtime.recordEvent(
                        { ...child, tenantId: 'forged' },
                        { ...childInput, outcome: 'forged_event' },
                      );
                    },
                    { kind: 'client' },
                  ),
                ),
              );
            },
            { kind: 'server', preserveSpanIdentity: true },
          ),
        ),
      );
      await runtime.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(6);
      for (const root of roots) {
        const owned = spans.filter((span) => span.spanContext().traceId === root.traceId);
        expect(owned).toHaveLength(3);
        expect(new Set(owned.map((span) => span.spanContext().spanId)).size).toBe(3);
        const rootSpan = owned.find((span) => span.spanContext().spanId === root.spanId)!;
        expect(rootSpan.parentSpanContext).toBeUndefined();
        expect(rootSpan.attributes['meri.tenantId']).toBe(root.tenantId);
        for (const child of owned.filter((span) => span !== rootSpan)) {
          expect(child.parentSpanContext?.spanId).toBe(root.spanId);
          expect(child.attributes['meri.tenantId']).toBe(root.tenantId);
          expect(child.attributes['meri.outcome']).toBe('completed');
        }
      }
      expect(
        JSON.stringify(
          spans.map((span) => ({
            attributes: span.attributes,
            events: span.events,
            status: span.status,
          })),
        ),
      ).not.toContain('forged_event');
    } finally {
      await runtime.shutdown();
    }
  });

  test('throwing callback runs once, ends an error span and never exports its private error', async () => {
    const exporter = new InMemorySpanExporter();
    const runtime = createMeriOtelRuntime({ serviceName: 'api', exporter });
    const error = new Error('PRIVATE_DOCUMENT_SECRET');
    const callback = jest.fn(async () => {
      throw error;
    });
    try {
      await expect(
        runtime.withSpan(context(), rootInput, callback, { preserveSpanIdentity: true }),
      ).rejects.toBe(error);
      expect(callback).toHaveBeenCalledTimes(1);
      await runtime.forceFlush();
      expect(exporter.getFinishedSpans()).toHaveLength(1);
      expect(exporter.getFinishedSpans()[0]!.status.code).toBe(2);
      expect(
        JSON.stringify(
          exporter.getFinishedSpans().map((span) => ({
            attributes: span.attributes,
            events: span.events,
            status: span.status,
          })),
        ),
      ).not.toContain(error.message);
    } finally {
      await runtime.shutdown();
    }
  });

  test('actual OTLP HTTP JSON payload preserves IDs and excludes raw payloads and unknown costs', async () => {
    // The SDK HTTP transport uses dynamic import; run the actual source in Node
    // rather than requiring Jest's experimental VM module mode globally.
    const result = execFileSync(
      process.execPath,
      ['--require', require.resolve('tsx/cjs'), join(__dirname, 'meri-otel-http.fixture.cjs')],
      { encoding: 'utf8', timeout: 10000 },
    );
    const { root, bodies } = JSON.parse(result) as {
      root: { traceId: string; spanId: string };
      bodies: Array<{ path: string; contentType: string; body: any }>;
    };
    expect(bodies.length).toBeGreaterThan(0);
    const spans = bodies.flatMap((p) =>
      p.body.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)),
    );
    expect(spans).toHaveLength(2);
    expect(spans.every((s: any) => s.traceId === root.traceId)).toBe(true);
    expect(spans.find((s: any) => s.name === 'meri.orchestrator_provider').parentSpanId).toBe(
      root.spanId,
    );
    const serialized = JSON.stringify(bodies);
    for (const secret of [
      'PRIVATE_DOCUMENT_SECRET',
      'PRIVATE_VERSION_SECRET',
      'PRIVATE_PROMPT_SECRET',
      'PRIVATE_AUTH_SECRET',
      'PRIVATE_TOOL_SECRET',
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).toContain('capiro-api');
    expect(serialized).not.toContain('meri.usage.knownEstimatedCostUsd');
    expect(serialized).toContain('unknown');
    expect(
      bodies.every((p) => p.path === '/v1/traces' && p.contentType === 'application/json'),
    ).toBe(true);
  });

  test.each(['throw', 'hang'] as const)(
    'exporter %s cannot fail work or make lifecycle unbounded',
    async (mode) => {
      const exporter: SpanExporter = {
        export: () => {
          if (mode === 'throw') throw new Error('private exporter failure');
        },
        shutdown: () =>
          mode === 'throw'
            ? Promise.reject(new Error('private shutdown failure'))
            : new Promise(() => {}),
      };
      const runtime = createMeriOtelRuntime({
        serviceName: 'api',
        exporter,
        timeoutMillis: 25,
        maxQueueSize: 2,
      });
      const callback = jest.fn(async () => 'served');
      for (let i = 0; i < 5; i++)
        await expect(runtime.withSpan(context(), rootInput, callback)).resolves.toBe('served');
      expect(callback).toHaveBeenCalledTimes(5);
      const started = Date.now();
      await runtime.forceFlush();
      await runtime.shutdown();
      await runtime.shutdown();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(runtime.isEnabled()).toBe(false);
    },
  );

  test('invalid exporter setup and malformed IDs fail open without leaking config or duplicating work', async () => {
    const invalid = createMeriOtelRuntime({
      serviceName: 'api',
      tracesEndpoint: 'http://private:secret@example.test',
    });
    expect(invalid.isEnabled()).toBe(false);
    const exporter = new InMemorySpanExporter();
    const runtime = createMeriOtelRuntime({ serviceName: 'api', exporter });
    const callback = jest.fn(async () => 'served');
    await runtime.withSpan({ ...context(), traceId: 'invalid' }, rootInput, callback);
    await runtime.forceFlush();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    await runtime.shutdown();
  });
});
