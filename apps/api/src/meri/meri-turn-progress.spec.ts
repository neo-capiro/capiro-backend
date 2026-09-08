import { contextStageTimer } from '../context/context-stage-timer.service.js';
import { MeriContextPlaneRuntimeService } from './meri-context-plane-runtime.js';
import { withMeriTurnProgress } from './meri-turn-progress.js';
import { runMeriStreamWithSetupGuard } from './meri-stream-preflight.helpers.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Meri progress during governed preparation', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('shows the real canonical stage before start and does not fabricate tools', async () => {
    const held = deferred();
    const frames: string[] = [];
    const run = withMeriTurnProgress(
      { write: (value) => frames.push(value) },
      undefined,
      async (writer) => {
        await contextStageTimer.run(() => contextStageTimer.time('retrieval', () => held.promise));
        writer.write('data: {"type":"start"}\n\n');
        writer.write('data: {"type":"runtime"}\n\n');
        await new Promise((done) => setTimeout(done, 5_000));
        writer.write('data: {"type":"done"}\n\n');
      },
    );
    expect(frames).toEqual([]);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(JSON.parse(frames[0]!.slice(6))).toMatchObject({
      type: 'progress',
      phase: 'retrieval',
      elapsedMs: 1000,
      accepted: false,
    });
    expect(frames.join('')).not.toContain('tool_call');
    held.resolve();
    await jest.advanceTimersByTimeAsync(5_000);
    await run;
    const progress = frames
      .filter((frame) => frame.includes('"type":"progress"'))
      .map((frame) => JSON.parse(frame.slice(6)));
    expect(new Set(progress.map((frame) => frame.runId)).size).toBe(1);
    expect(progress.at(-1)).toMatchObject({ phase: 'provider' });
    expect(progress.at(-1)).not.toHaveProperty('accepted');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('stops progress at cancellation and always cleans up timer/listener state', async () => {
    const held = deferred();
    const writer = { write: jest.fn() };
    const abort = new AbortController();
    const run = withMeriTurnProgress(writer, abort.signal, () => held.promise);
    await jest.advanceTimersByTimeAsync(1_000);
    abort.abort();
    const count = writer.write.mock.calls.length;
    await jest.advanceTimersByTimeAsync(20_000);
    expect(writer.write).toHaveBeenCalledTimes(count);
    held.resolve();
    await run;
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a failed progress write cannot escape a timer or change the canonical stage result', async () => {
    const held = deferred<string>();
    const write = jest.fn(() => {
      throw new Error('Socket closed');
    });
    const run = withMeriTurnProgress({ write }, undefined, () =>
      contextStageTimer.run(() => contextStageTimer.time('retrieval', () => held.promise)),
    );
    await expect(jest.advanceTimersByTimeAsync(1_000)).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    held.resolve('Canonical result');
    await expect(run).resolves.toBe('Canonical result');
    expect(write).toHaveBeenCalledTimes(1);
  });

  test('acknowledges a persisted turn during preparation without claiming the provider started', async () => {
    const held = deferred();
    const frames: string[] = [];
    const run = withMeriTurnProgress(
      { write: (frame) => frames.push(frame) },
      undefined,
      async (writer) => {
        writer.write('data: {"type":"turn_accepted","messageId":"saved-user"}\n\n');
        await held.promise;
      },
    );
    await jest.advanceTimersByTimeAsync(1_000);
    const progress = frames
      .filter((frame) => frame.includes('"type":"progress"'))
      .map((frame) => JSON.parse(frame.slice(6)));
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({
      phase: 'preparing',
      note: 'Your message is saved. Preparing Meri’s response.',
    });
    expect(progress[0]).not.toHaveProperty('accepted');
    expect(frames.join('')).not.toContain('"type":"start"');
    held.resolve();
    await run;
    expect(jest.getTimerCount()).toBe(0);
  });

  test('preserves deferred JSON setup errors and marks progress-only failures unaccepted', async () => {
    const makeResponse = () => {
      const response = {
        write: jest.fn(),
        setHeader: jest.fn(),
        end: jest.fn(),
        json: jest.fn(),
        status: jest.fn(),
      };
      response.status.mockReturnValue(response);
      return response;
    };
    const fast = makeResponse();
    await runMeriStreamWithSetupGuard({
      res: fast,
      stream: (writer) =>
        withMeriTurnProgress(writer, undefined, async () => {
          throw new Error('preflight');
        }),
    });
    expect(fast.json).toHaveBeenCalled();
    expect(fast.setHeader).not.toHaveBeenCalled();

    const held = deferred();
    const slow = makeResponse();
    const run = runMeriStreamWithSetupGuard({
      res: slow,
      stream: (writer) =>
        withMeriTurnProgress(writer, undefined, async () => {
          await held.promise;
          throw new Error('preflight');
        }),
    });
    await jest.advanceTimersByTimeAsync(1_000);
    held.resolve();
    await run;
    const error = slow.write.mock.calls
      .map(([value]) => String(value))
      .find((value) => value.includes('"type":"error"'))!;
    expect(JSON.parse(error.slice(6))).toMatchObject({ accepted: false, message: 'preflight' });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a failure after the durable acceptance receipt cannot tell the UI to restore an unsent draft', async () => {
    const held = deferred();
    const response = {
      write: jest.fn(),
      setHeader: jest.fn(),
      end: jest.fn(),
      json: jest.fn(),
      status: jest.fn(),
    };
    response.status.mockReturnValue(response);
    const run = runMeriStreamWithSetupGuard({
      res: response,
      stream: (writer) =>
        withMeriTurnProgress(writer, undefined, async (observed) => {
          await held.promise;
          observed.write('data: {"type":"turn_accepted","messageId":"saved-user"}\n\n');
          throw new Error('Provider configuration unavailable');
        }),
    });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(JSON.parse(String(response.write.mock.calls[0]![0]).slice(6))).toMatchObject({
      type: 'progress',
      accepted: false,
    });
    held.resolve();
    await run;
    const frames = response.write.mock.calls.map(([value]) => JSON.parse(String(value).slice(6)));
    expect(frames.find((frame) => frame.type === 'turn_accepted')).toMatchObject({
      messageId: 'saved-user',
    });
    const error = frames.find((frame) => frame.type === 'error');
    expect(error).toMatchObject({
      message: 'Meri is missing a usable AI provider configuration for this tenant.',
    });
    expect(error).not.toHaveProperty('accepted');
    expect(frames.filter((frame) => frame.type === 'progress').at(-1)).not.toHaveProperty(
      'accepted',
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  test('final telemetry after answer text does not claim a new provider wait', async () => {
    const held = deferred();
    const frames: string[] = [];
    const run = withMeriTurnProgress(
      { write: (frame) => frames.push(frame) },
      undefined,
      async (writer) => {
        writer.write('data: {"type":"start"}\n\n');
        writer.write('data: {"type":"text","text":"The answer."}\n\n');
        writer.write('data: {"type":"runtime","model":"provider-model"}\n\n');
        await held.promise;
      },
    );
    await jest.advanceTimersByTimeAsync(1_000);
    const progress = frames
      .filter((frame) => frame.includes('"type":"progress"'))
      .map((frame) => JSON.parse(frame.slice(6)));
    expect(progress.at(-1)).toMatchObject({ phase: 'answer', note: 'Finishing the response.' });
    held.resolve();
    await run;
  });

  test('does not start a provider after a cancelled context read completes', async () => {
    const held = deferred<any>();
    const started = deferred();
    const prisma = {
      withTenant: jest.fn(async (_tenant, read) =>
        read({
          clioConversation: { findFirst: async () => ({ client: null }) },
        }),
      ),
    };
    const context = {
      resolveChat: jest.fn(() => {
        started.resolve();
        return held.promise;
      }),
    };
    const runtime = new MeriContextPlaneRuntimeService(prisma as never, context as never);
    const abort = new AbortController();
    const provider = jest.fn();
    const run = runtime.runChatTurn(
      { tenantId: 't', userId: 'u' } as never,
      {
        conversationId: 'conversation',
        body: 'hello',
        mode: 'new',
        signal: abort.signal,
      },
      provider,
    );
    const rejection = expect(run).rejects.toHaveProperty('name', 'AbortError');
    await started.promise;
    abort.abort();
    held.resolve({ retrieval: { plan: { subjectScope: 'general' } } });
    await rejection;
    expect(provider).not.toHaveBeenCalled();
  });

  test('keeps concurrent canonical stages isolated between conversations', async () => {
    const held = deferred();
    const a: string[] = [];
    const b: string[] = [];
    const run = (frames: string[], stage: 'retrieval' | 'compile') =>
      withMeriTurnProgress({ write: (frame) => frames.push(frame) }, undefined, () =>
        contextStageTimer.run(() => contextStageTimer.time(stage, () => held.promise)),
      );
    const one = run(a, 'retrieval');
    const two = run(b, 'compile');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(JSON.parse(a[0]!.slice(6)).phase).toBe('retrieval');
    expect(JSON.parse(b[0]!.slice(6)).phase).toBe('compile');
    expect(JSON.parse(a[0]!.slice(6)).runId).not.toBe(JSON.parse(b[0]!.slice(6)).runId);
    held.resolve();
    await Promise.all([one, two]);
  });
});
