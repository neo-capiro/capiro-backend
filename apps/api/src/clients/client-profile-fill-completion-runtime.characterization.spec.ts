import { Logger } from '@nestjs/common';
import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';

type Handle = { unref?: jest.Mock };
interface Timer {
  callback: () => void;
  delay: number | undefined;
  handle: Handle;
}
const timers: Timer[] = [];
const microtasks: Array<() => void> = [];
const timerEvents: string[] = [];
let withUnref = true;
const environment = {
  NODE_ENV: process.env.NODE_ENV,
  HOSTNAME: process.env.HOSTNAME,
  CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED:
    process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED,
  CLIENT_PROFILE_FILL_WORKER_ENABLED: process.env.CLIENT_PROFILE_FILL_WORKER_ENABLED,
};
beforeEach(() => {
  process.env.NODE_ENV = 'production';
  process.env.HOSTNAME = 'runtime-worker';
  delete process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED;
  delete process.env.CLIENT_PROFILE_FILL_WORKER_ENABLED;
  timers.splice(0);
  microtasks.splice(0);
  timerEvents.splice(0);
  withUnref = true;
  jest.spyOn(global, 'setInterval').mockImplementation((callback, delay) => {
    const handle: Handle = withUnref
      ? {
          unref: jest.fn(() => {
            timerEvents.push(`unref:${delay}`);
          }),
        }
      : {};
    timers.push({ callback: callback as () => void, delay, handle });
    timerEvents.push(`interval:${delay}`);
    return handle as unknown as ReturnType<typeof setInterval>;
  });
  jest.spyOn(global, 'clearInterval').mockImplementation(() => undefined);
  jest.spyOn(global, 'queueMicrotask').mockImplementation((callback) => {
    microtasks.push(callback);
    timerEvents.push('queue');
  });
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider calls forbidden'));
});
afterEach(() => {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  jest.restoreAllMocks();
});
interface Options {
  adapter?: unknown;
  recoveryError?: Error;
  scheduleError?: Error;
  holdRecovery?: Promise<number>;
  holdSchedule?: Promise<unknown[]>;
}
function fixture(options: Options = {}) {
  const operations: string[] = [];
  const claimArgs: unknown[][] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const tx = {
    $executeRawUnsafe: jest.fn(async () => {
      operations.push('task-recovery');
      if (options.recoveryError) throw options.recoveryError;
      return options.holdRecovery ?? 1;
    }),
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
      if (sql.includes('WITH due AS')) {
        operations.push('schedule-claim');
        if (options.scheduleError) throw options.scheduleError;
        return options.holdSchedule ?? [];
      }
      if (sql.includes('WITH candidates AS')) {
        operations.push('task-claim');
        claimArgs.push(args);
        return [];
      }
      if (sql.includes('FROM client_profile_fill_run r')) {
        operations.push('task-finalize');
        return [];
      }
      throw new Error(`Unexpected runtime SQL: ${sql}`);
    }),
  };
  const prisma = {
    withSystem: jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
      callback(tx),
    ),
  };
  const adapter = Object.prototype.hasOwnProperty.call(options, 'adapter')
    ? options.adapter
    : { httpAdapter: {} };
  const service = new ClientProfileFillCompletionService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    adapter as never,
    {} as never,
  );
  for (const level of ['log', 'error', 'warn'] as const)
    (
      jest.spyOn(Logger.prototype, level) as jest.SpyInstance<
        void,
        Parameters<typeof Logger.prototype.log>
      >
    ).mockImplementation((message: unknown) => {
      logs.push({ level, message: String(message) });
    });
  return { service, operations, claimArgs, logs, prisma };
}
async function settle() {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

describe('Completion automatic worker guards', () => {
  it('short-circuits NODE_ENV test before evaluating the HTTP adapter', () => {
    process.env.NODE_ENV = 'test';
    const adapter = {
      get httpAdapter(): never {
        throw new Error('adapter must not be read');
      },
    };
    fixture({ adapter }).service.onModuleInit();
    expect(timers).toEqual([]);
    expect(microtasks).toEqual([]);
  });
  it('short-circuits the exact completion false flag before evaluating the adapter', () => {
    process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED = 'false';
    const adapter = {
      get httpAdapter(): never {
        throw new Error('adapter must not be read');
      },
    };
    fixture({ adapter }).service.onModuleInit();
    expect(timers).toEqual([]);
    expect(microtasks).toEqual([]);
  });
  it.each([undefined, {}, { httpAdapter: undefined }])(
    'does not start automatic work with adapter %p',
    (adapter) => {
      const h = fixture({ adapter });
      h.service.onModuleInit();
      expect(timers).toEqual([]);
      expect(microtasks).toEqual([]);
      expect(h.operations).toEqual([]);
      expect(h.logs).toEqual([]);
    },
  );
  it.each(['FALSE', '0'])('preserves exact-string flag behavior for %s', (flag) => {
    process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED = flag;
    const h = fixture();
    h.service.onModuleInit();
    expect(timers).toHaveLength(2);
    h.service.onModuleDestroy();
  });
  it('keeps the legacy workflow-worker flag independent', () => {
    process.env.CLIENT_PROFILE_FILL_WORKER_ENABLED = 'false';
    const h = fixture();
    h.service.onModuleInit();
    expect(timers).toHaveLength(2);
    h.service.onModuleDestroy();
  });
  it('permits the public manual schedule sweep when automatic initialization is disabled', async () => {
    process.env.CLIENT_PROFILE_FILL_COMPLETION_WORKER_ENABLED = 'false';
    const h = fixture();
    h.service.onModuleInit();
    await h.service.sweepSchedulesOnce();
    expect(timers).toEqual([]);
    expect(h.operations).toEqual(['schedule-claim']);
  });
});

describe('Completion timers and initial dispatch', () => {
  it('registers exactly task then schedule intervals, unreferences both and queues one initial kick', () => {
    const h = fixture();
    h.service.onModuleInit();
    expect(timerEvents).toEqual([
      'interval:1500',
      'unref:1500',
      'interval:60000',
      'unref:60000',
      'queue',
    ]);
    expect(timers.map((timer) => timer.delay)).toEqual([1500, 60000]);
    expect(microtasks).toHaveLength(1);
    expect(h.operations).toEqual([]);
    expect(h.logs).toEqual([
      { level: 'log', message: 'Fill with Meri completion worker started (runtime-worker)' },
    ]);
    h.service.onModuleDestroy();
  });
  it('supports timer handles without an unref method', () => {
    withUnref = false;
    const h = fixture();
    expect(() => h.service.onModuleInit()).not.toThrow();
    expect(timerEvents).toEqual(['interval:1500', 'interval:60000', 'queue']);
    h.service.onModuleDestroy();
  });
  it('kicks the actual task sweep before the actual schedule sweep without serializing their promises', async () => {
    const h = fixture();
    h.service.onModuleInit();
    microtasks[0]!();
    expect(h.operations).toEqual(['task-recovery', 'schedule-claim']);
    await settle();
    expect(h.operations).toEqual([
      'task-recovery',
      'schedule-claim',
      'task-claim',
      'task-finalize',
    ]);
    h.service.onModuleDestroy();
  });
  it('dispatches each timer to its own real sweep on every eligible tick', async () => {
    const h = fixture();
    h.service.onModuleInit();
    timers[0]!.callback();
    await settle();
    timers[1]!.callback();
    await settle();
    timers[0]!.callback();
    await settle();
    expect(h.operations).toEqual([
      'task-recovery',
      'task-claim',
      'task-finalize',
      'schedule-claim',
      'task-recovery',
      'task-claim',
      'task-finalize',
    ]);
    h.service.onModuleDestroy();
  });
  it('uses the same constructor-time worker ID for logs and task claims after environment changes', async () => {
    const h = fixture();
    process.env.HOSTNAME = 'changed-after-construction';
    h.service.onModuleInit();
    microtasks[0]!();
    await settle();
    expect(h.logs[0]!.message).toContain('(runtime-worker)');
    const leasePattern =
      /^runtime-worker:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(h.claimArgs[0]![1]).toMatch(leasePattern);
    timers[0]!.callback();
    await settle();
    expect(h.claimArgs).toHaveLength(2);
    expect(h.claimArgs[1]![1]).toMatch(leasePattern);
    expect(h.claimArgs[1]![1]).not.toBe(h.claimArgs[0]![1]);
    h.service.onModuleDestroy();
  });
});

describe('Runtime sweep rejection boundaries', () => {
  it('logs a task rejection at error level with redaction while the schedule sweep proceeds', async () => {
    const h = fixture({ recoveryError: new Error('api_key=private; bearer secret') });
    h.service.onModuleInit();
    expect(microtasks[0]!()).toBeUndefined();
    await settle();
    expect(h.operations).toEqual(['task-recovery', 'schedule-claim']);
    expect(h.logs.filter((entry) => entry.level === 'error')).toEqual([
      {
        level: 'error',
        message: 'Fill completion sweep failed: api_key=[redacted]; bearer=[redacted]',
      },
    ]);
    expect(h.logs.some((entry) => entry.level === 'warn')).toBe(false);
    h.service.onModuleDestroy();
  });
  it('logs a schedule rejection at error level without stopping the task sweep', async () => {
    const h = fixture({ scheduleError: new Error('Authorization: secret unavailable') });
    h.service.onModuleInit();
    microtasks[0]!();
    await settle();
    expect(h.operations).toEqual([
      'task-recovery',
      'schedule-claim',
      'task-claim',
      'task-finalize',
    ]);
    expect(h.logs.filter((entry) => entry.level === 'error')).toEqual([
      {
        level: 'error',
        message: 'Fill refresh schedule sweep failed: Authorization=[redacted] unavailable',
      },
    ]);
    h.service.onModuleDestroy();
  });
  it('keeps timer callbacks fire-and-forget and bounds sanitized rejection text', async () => {
    const h = fixture({ scheduleError: new Error('x'.repeat(900)) });
    h.service.onModuleInit();
    expect(timers[1]!.callback()).toBeUndefined();
    await settle();
    expect(h.logs.find((entry) => entry.level === 'error')!.message).toBe(
      `Fill refresh schedule sweep failed: ${'x'.repeat(800)}`,
    );
    h.service.onModuleDestroy();
  });
  it('keeps schedule work independent while the actual task sweep is pending', async () => {
    let release!: (result: number) => void;
    const holdRecovery = new Promise<number>((resolve) => {
      release = resolve;
    });
    const h = fixture({ holdRecovery });
    h.service.onModuleInit();
    microtasks[0]!();
    await settle();
    expect(h.operations).toEqual(['task-recovery', 'schedule-claim']);
    timers[1]!.callback();
    await settle();
    expect(h.operations.filter((operation) => operation === 'schedule-claim')).toHaveLength(2);
    release(1);
    await settle();
    expect(h.operations).toContain('task-finalize');
    h.service.onModuleDestroy();
  });
});

describe('Completion runtime destruction preserves existing lifecycle behavior', () => {
  it('clears only its task then schedule handles without touching another timer', () => {
    const h = fixture();
    h.service.onModuleInit();
    const external = setInterval(() => undefined, 20);
    h.service.onModuleDestroy();
    expect(jest.mocked(clearInterval).mock.calls).toEqual([
      [timers[0]!.handle],
      [timers[1]!.handle],
    ]);
    expect(clearInterval).not.toHaveBeenCalledWith(external);
  });
  it('does nothing when destroyed before initialization', () => {
    const h = fixture();
    h.service.onModuleDestroy();
    expect(clearInterval).not.toHaveBeenCalled();
    expect(h.prisma.withSystem).not.toHaveBeenCalled();
  });
  it('does not cancel an already-queued initial microtask', async () => {
    const h = fixture();
    h.service.onModuleInit();
    h.service.onModuleDestroy();
    microtasks[0]!();
    await settle();
    expect(h.operations).toEqual([
      'task-recovery',
      'schedule-claim',
      'task-claim',
      'task-finalize',
    ]);
  });
  it('returns synchronously without awaiting or cancelling an in-flight sweep', async () => {
    let release!: (rows: unknown[]) => void;
    const holdSchedule = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    const h = fixture({ holdSchedule });
    h.service.onModuleInit();
    timers[1]!.callback();
    expect(h.service.onModuleDestroy()).toBeUndefined();
    expect(h.operations).toEqual(['schedule-claim']);
    release([]);
    await settle();
    await h.service.sweepSchedulesOnce();
    expect(h.operations).toEqual(['schedule-claim', 'schedule-claim']);
  });
  it('preserves repeated-hook registration behavior and clears the latest handle pair', () => {
    const h = fixture();
    h.service.onModuleInit();
    h.service.onModuleInit();
    expect(timers).toHaveLength(4);
    expect(microtasks).toHaveLength(2);
    h.service.onModuleDestroy();
    expect(jest.mocked(clearInterval).mock.calls).toEqual([
      [timers[2]!.handle],
      [timers[3]!.handle],
    ]);
  });
});
