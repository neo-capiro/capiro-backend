import { createMeriOtelRuntime } from '@capiro/meriv2-core/observability/otel';
import { MeriController } from './meri.controller.js';
import {
  createMeriApiTelemetryContext,
  currentMeriApiTelemetry,
  emitMeriApiTelemetry,
  meriApiTelemetryHeaders,
  runWithMeriApiTelemetry,
  setMeriOtelRuntime,
  withMeriApiTelemetrySpan,
} from './meri-telemetry.runtime.js';
import {
  admittedResearchReceiptTelemetry,
  remainingResearchTelemetryBudget,
} from './meri-research-telemetry.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;

describe('research HTTP owners export actual SDK spans', () => {
  let spans: any[];
  let sdk: ReturnType<typeof createMeriOtelRuntime>;
  const originalSecret = process.env.INTERNAL_SERVICE_SECRET;

  beforeEach(async () => {
    spans = [];
    sdk = createMeriOtelRuntime({
      serviceName: 'research-http-test',
      exporter: {
        export: (batch, done) => {
          spans.push(...batch);
          done({ code: 0 });
        },
        shutdown: async () => {},
      },
    });
    await setMeriOtelRuntime(sdk);
    process.env.INTERNAL_SERVICE_SECRET = 'private-service-secret';
  });

  afterEach(async () => {
    await setMeriOtelRuntime(undefined);
    if (originalSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = originalSecret;
  });

  function controller(research: Record<string, unknown>): MeriController {
    return Object.assign(Object.create(MeriController.prototype), {
      research,
      logger: { log: jest.fn() },
    });
  }

  test.each([
    ['streamResearchPlan', 'streamPlan'],
    ['streamResearchRun', 'streamResearch'],
  ])('%s enters a fresh scope and preserves one service call', async (route, operation) => {
    let observed: ReturnType<typeof currentMeriApiTelemetry>;
    const owner = jest.fn(async () => {
      observed = currentMeriApiTelemetry();
      expect(observed).not.toBeNull();
      emitMeriApiTelemetry({ name: 'meri.research.owner', boundary: 'research_run' });
    });
    const instance = controller({ [operation]: owner });
    const req = {
      headers: {
        authorization: 'Bearer private-bearer',
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      },
    } as never;
    const res = { setHeader: jest.fn(), end: jest.fn() } as never;
    await (instance as any)[route](ctx, 'unadmitted-session-label', req, res);
    await sdk.forceFlush();
    expect(owner).toHaveBeenCalledTimes(1);
    expect(observed!.traceId).not.toBe('11111111111111111111111111111111');
    expect(spans).toHaveLength(2);
    expect(spans.some((span) => span.spanContext().spanId === observed!.spanId)).toBe(true);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('private-bearer');
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain(
      'unadmitted-session-label',
    );
  });

  test('an admitted internal carrier joins the actual client span, and owner rejection runs once', async () => {
    const owner = jest.fn(async () => {
      throw new Error('PRIVATE_OWNER_DENIAL');
    });
    const instance = controller({ reserveProviderAttempt: owner });
    const root = createMeriApiTelemetryContext({ headers: {} } as never, ctx, 'conversation-1');
    let clientId = '';
    await runWithMeriApiTelemetry(
      root,
      () => {},
      () =>
        withMeriApiTelemetrySpan(
          { name: 'callback-client', boundary: 'research_budget' },
          async () => {
            clientId = currentMeriApiTelemetry()!.spanId;
            const req = {
              headers: {
                ...meriApiTelemetryHeaders(),
                'x-internal-service-secret': 'private-service-secret',
              },
            } as never;
            await expect(
              instance.reserveResearchProviderAttempt(ctx, 'session-1', 'run-1', {} as never, req),
            ).rejects.toThrow('PRIVATE_OWNER_DENIAL');
          },
          'client',
        ),
    );
    await sdk.forceFlush();
    expect(owner).toHaveBeenCalledTimes(1);
    const receiver = spans.find(
      (span) => span.name === 'meri.browser_api' && span.parentSpanContext?.spanId === clientId,
    );
    const operation = spans.find((span) =>
      span.events.some(
        (event: any) =>
          event.attributes['meri.name'] === 'meri.research.reserveResearchProviderAttempt',
      ),
    );
    expect(receiver).toBeDefined();
    expect(receiver.spanContext().traceId).toBe(root.traceId);
    expect(operation.parentSpanContext.spanId).toBe(receiver.spanContext().spanId);
    expect(operation.status.code).toBe(2);
    const output = JSON.stringify(
      spans.map((span) => ({
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    );
    expect(output).not.toContain('PRIVATE_OWNER_DENIAL');
    expect(output).not.toContain('private-service-secret');
  });

  test('saved receipt completion does not invent upstream coverage or disclose content', () => {
    const projected = admittedResearchReceiptTelemetry('session-1', {
      version: 2,
      receiptId: 'receipt-1',
      runId: 'run-1',
      leaseEpoch: 2,
      sequence: 7,
      effectClass: 'safe_read',
      tool: 'search_memory',
      label: 'PRIVATE_LABEL',
      summary: 'PRIVATE_SUMMARY',
      status: 'complete',
      classifier: 'complete',
      completedAt: new Date().toISOString(),
      resultRef: 'result-1',
      resultSha256: 'a'.repeat(64),
    });
    expect(projected.sourceCoverage).toBe('unknown');
    expect(projected.sourceRefs).toEqual([
      { sourceId: 'result-1', hash: 'a'.repeat(64), tool: 'search_memory' },
    ]);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    expect(
      remainingResearchTelemetryBudget(
        {
          version: 1,
          activation: 'enforced',
          chargedAttempts: 2,
          chargedTokens: 400,
          chargedCostMicros: 50,
          limits: {
            maxAttempts: 3,
            maxTokens: 1000,
            maxCostMicros: 100,
            deadlineAt: '2026-09-29T10:00:00Z',
          },
          attempts: [],
        },
        Date.parse('2026-09-29T09:59:59Z'),
      ),
    ).toEqual({ attempts: 1, tokens: 600, costMicros: 50, timeMs: 1000 });
  });
});
