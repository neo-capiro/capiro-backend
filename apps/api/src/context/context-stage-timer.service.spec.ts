import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContextStageTimerService, contextStageTimer } from './context-stage-timer.service.js';

const API_ROOT = process.cwd();
const read = (path: string) => readFileSync(join(API_ROOT, path), 'utf8');

describe('ContextStageTimerService', () => {
  test('is inert outside an operation scope', async () => {
    const timer = new ContextStageTimerService();
    expect(timer.snapshot()).toBeNull();
    // A non-governed caller and a directly-constructed unit test must behave
    // exactly as before instrumentation: pass the value through, record nothing.
    await expect(timer.time('provider', async () => 'passthrough')).resolves.toBe('passthrough');
    expect(() => timer.recordProvider({ status: 'ok' })).not.toThrow();
    expect(timer.snapshot()).toBeNull();
  });

  test('a stage that never ran reports null, not zero', async () => {
    const timer = new ContextStageTimerService();
    const snapshot = await timer.run(async () => {
      await timer.time('resolver', async () => undefined);
      return timer.snapshot();
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.resolverMs).not.toBeNull();
    // Zero would read as "ran, was instant". These stages did not run at all,
    // and an un-instrumented path must never look like the fastest path.
    expect(snapshot!.retrievalMs).toBeNull();
    expect(snapshot!.compileMs).toBeNull();
    expect(snapshot!.persistenceMs).toBeNull();
    expect(snapshot!.providerMs).toBeNull();
  });

  test('repeated stages accumulate and report a call count', async () => {
    const timer = new ContextStageTimerService();
    const snapshot = await timer.run(async () => {
      await timer.time('provider', async () => undefined);
      await timer.time('provider', async () => undefined);
      await timer.time('retrieval', async () => undefined);
      return timer.snapshot();
    });
    // Two provider calls must not be reported as one, or a retry storm reads as
    // a single slow call.
    expect(snapshot!.calls.provider).toBe(2);
    expect(snapshot!.calls.retrieval).toBe(1);
    expect(snapshot!.providerMs).toBeGreaterThanOrEqual(0);
  });

  test('a throwing stage is still measured', async () => {
    const timer = new ContextStageTimerService();
    const snapshot = await timer.run(async () => {
      await timer
        .time('retrieval', async () => {
          throw new Error('source down');
        })
        .catch(() => undefined);
      return timer.snapshot();
    });
    // The latency of a FAILING operation is exactly what a latency regression
    // looks like; dropping it would hide the incident.
    expect(snapshot!.retrievalMs).not.toBeNull();
    expect(snapshot!.calls.retrieval).toBe(1);
  });

  test('provider telemetry is merged, and totals cover the whole scope', async () => {
    const timer = new ContextStageTimerService();
    const snapshot = await timer.run(async () => {
      timer.recordProvider({ status: 'http_429', model: 'claude-test' });
      timer.recordProvider({ inputTokens: 11, outputTokens: 5 });
      return timer.snapshot();
    });
    expect(snapshot!.provider).toEqual(
      expect.objectContaining({
        status: 'http_429',
        model: 'claude-test',
        inputTokens: 11,
        outputTokens: 5,
      }),
    );
    expect(snapshot!.totalMs).toBeGreaterThanOrEqual(0);
  });

  test('concurrent operations do not share a scope', async () => {
    const timer = new ContextStageTimerService();
    const [a, b] = await Promise.all([
      timer.run(async () => {
        await timer.time('resolver', async () => undefined);
        timer.recordProvider({ model: 'model-a' });
        return timer.snapshot();
      }),
      timer.run(async () => {
        await timer.time('compile', async () => undefined);
        timer.recordProvider({ model: 'model-b' });
        return timer.snapshot();
      }),
    ]);
    // AsyncLocalStorage keeps two in-flight operations apart. Cross-talk would
    // attribute one tenant's latency to another's audit row.
    expect(a!.resolverMs).not.toBeNull();
    expect(a!.compileMs).toBeNull();
    expect(a!.provider?.model).toBe('model-a');
    expect(b!.compileMs).not.toBeNull();
    expect(b!.resolverMs).toBeNull();
    expect(b!.provider?.model).toBe('model-b');
  });

  test('the shared singleton is what instrumented call sites import', () => {
    // AsyncLocalStorage is process-global and LlmCompletionService is not
    // Nest-injected, so the provider stage and the gateway that opened the scope
    // must resolve to the SAME collector. Separate instances would silently
    // report provider time as null forever.
    expect(contextStageTimer).toBeInstanceOf(ContextStageTimerService);
    for (const path of [
      'src/context/context-plane-gateway.service.ts',
      'src/context/context-resolver.service.ts',
      'src/context/context-compiler.service.ts',
      'src/engagement/llm-completion.service.ts',
    ]) {
      expect(read(path)).toContain('contextStageTimer');
    }
  });
});

describe('Context Plane stage telemetry carries no content', () => {
  const timerSource = read('src/context/context-stage-timer.service.ts');
  const auditSource = read('src/context/context-plane-audit.service.ts');

  test('the collector holds only durations, counts, enums and token counts', () => {
    // The collector is the one place a careless `text`/`prompt` field would make
    // model content queryable in audit_logs forever.
    for (const forbidden of [
      'prompt',
      'completion',
      'bodyText',
      'transcript',
      'snippet',
      'excerpt',
      'apiKey',
      'secret',
    ]) {
      expect(timerSource).not.toContain(`${forbidden}:`);
    }
  });

  test('the audit row keeps its no-content contract', () => {
    expect(auditSource).toContain('stores no prompt');
    for (const forbidden of ['prompt:', 'responseText', 'bodyText:', 'sourceExcerpt:']) {
      expect(auditSource).not.toContain(forbidden);
    }
    // Only lengths and counts of rendered context, never the rendered text.
    expect(auditSource).toContain('packetBlockChars');
  });

  test('the audit row exposes every stage duration Phase 27 needs', () => {
    for (const field of ['resolver', 'retrieval', 'compile', 'persistence', 'provider', 'total']) {
      expect(auditSource).toContain(`${field}:`);
    }
    expect(auditSource).toContain('durationMs');
    expect(auditSource).toContain('coverage');
    expect(auditSource).toContain('traceId');
  });
});
