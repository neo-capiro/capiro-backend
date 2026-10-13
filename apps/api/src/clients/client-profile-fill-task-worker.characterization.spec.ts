import type { TenantContext } from '@capiro/shared';
import {
  deferred,
  harness,
  now,
  task,
  type Options,
} from '../../test/fixtures/client-profile-fill-task-worker.js';

let priorRegulatoryKey: string | undefined;
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(now);
  priorRegulatoryKey = process.env.REGULATIONS_GOV_API_KEY;
  delete process.env.REGULATIONS_GOV_API_KEY;
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Provider calls forbidden by characterization');
  });
});
afterEach(() => {
  if (priorRegulatoryKey === undefined) delete process.env.REGULATIONS_GOV_API_KEY;
  else process.env.REGULATIONS_GOV_API_KEY = priorRegulatoryKey;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('sweeps recovery, claim, actual task execution and finalization in order', async () => {
  const h = harness({ tasks: [task()] });
  await h.service.sweepOnce();
  expect(h.phases).toEqual([
    'recover',
    'claim',
    'actor',
    'facility-read',
    'cursor',
    'finish',
    'finalize',
  ]);
  expect(h.callsOf('finish')[0]!.args).toEqual([
    'task-one',
    'run-one',
    'tenant-one',
    'completed',
    '{"count":0}',
    'worker:lease-one',
  ]);
});

it('excludes overlapping sweeps and runs claimed tasks concurrently before finalization', async () => {
  const stalled = deferred<unknown>();
  const h = harness({
    tasks: [
      task({ taskType: 'federal_market' }),
      task({ id: 'task-two', clientId: 'client-two', taskType: 'federal_market' }),
    ],
    profilePromise: stalled.promise,
  });
  const sweep = h.service.sweepOnce();
  await jest.advanceTimersByTimeAsync(0);
  expect(h.intelligence.getClientProfile).toHaveBeenCalledTimes(2);
  await h.service.sweepOnce();
  expect(h.callsOf('claim')).toHaveLength(1);
  expect(h.callsOf('finalize')).toEqual([]);
  stalled.resolve({});
  await sweep;
  expect(h.callsOf('finish')).toHaveLength(2);
  expect(h.phases.at(-1)).toBe('finalize');
  expect(jest.getTimerCount()).toBe(0);
});

it.each(['recoverError', 'claimError', 'finalizeError'] as const)(
  'resets sweep exclusion after %s propagates',
  async (errorKey) => {
    const options: Options = { [errorKey]: new Error(errorKey) };
    const h = harness(options);
    await expect(h.service.sweepOnce()).rejects.toThrow(errorKey);
    delete options[errorKey];
    await expect(h.service.sweepOnce()).resolves.toBeUndefined();
    expect(h.callsOf('recover')).toHaveLength(2);
  },
);

it.each([null, { status: 'cancelled', createdByUserId: 'actor-one' }])(
  'cancels a missing/cancelled run before actor execution: %j',
  async (run) => {
    const h = harness({ run });
    await h.worker.executeClaimedTask(task());
    expect(h.callsOf('actor')[0]!.args).toEqual(['run-one', 'tenant-one', 'client-one']);
    expect(h.phases).toEqual(['actor', 'finish']);
    expect(h.callsOf('finish')[0]!.args.slice(3)).toEqual([
      'cancelled',
      '{"count":0}',
      'worker:lease-one',
    ]);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it('fails a run without an actor before creating heartbeats or specialist effects', async () => {
  const h = harness({ run: { status: 'running', createdByUserId: null } });
  await h.worker.executeClaimedTask(task());
  expect(h.phases).toEqual(['actor', 'fail']);
  expect(h.callsOf('fail')[0]!.args).toEqual([
    'task-one',
    'run-one',
    'tenant-one',
    'queued',
    'Fill run has no actor for governed execution',
    'worker:lease-one',
  ]);
  expect(jest.getTimerCount()).toBe(0);
});

it('reconstructs the standard-user context from the persisted actor and passes it into the actual specialist boundary', async () => {
  const h = harness({ facilityRows: [{ id: 'facility-one', name: 'HQ' }] });
  await h.worker.executeClaimedTask(task());
  expect(h.facilities.resolveFacilityDistrict).toHaveBeenCalledWith(
    {
      tenantId: 'tenant-one',
      tenantSlug: '',
      userId: 'actor-one',
      clerkUserId: '',
      role: 'standard_user',
    },
    'client-one',
    'facility-one',
  );
  expect(h.callsOf('finish')[0]!.args[4]).toBe('{"count":1}');
  expect(h.callsOf('finding')).toHaveLength(1);
});

it('defers the original task identity when real core dependencies are pending', async () => {
  const h = harness({ pending: 1 });
  await h.worker.executeClaimedTask(task({ taskType: 'federal_market', attempt: 2 }));
  expect(h.phases).toEqual(['actor', 'dependencies', 'defer']);
  expect(h.callsOf('defer')[0]!.args).toEqual([
    'task-one',
    'run-one',
    'tenant-one',
    'Waiting for prerequisite Fill specialists',
    'worker:lease-one',
  ]);
  expect(h.intelligence.getClientProfile).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

it('retries a thrown specialist error using the original lease and sanitized message', async () => {
  const h = harness({ profileError: new Error('api_key=secret unavailable') });
  await h.worker.executeClaimedTask(task({ taskType: 'federal_market', attempt: 2 }));
  expect(h.callsOf('fail')[0]!.args).toEqual([
    'task-one',
    'run-one',
    'tenant-one',
    'failed',
    'api_key=[redacted] unavailable',
    'worker:lease-one',
  ]);
  expect(h.callsOf('finish')).toEqual([]);
  expect(jest.getTimerCount()).toBe(0);
});

it('treats completion-write failure as task failure and still clears both timers', async () => {
  const h = harness({ finishError: new Error('completion write failed') });
  await h.worker.executeClaimedTask(task());
  expect(h.phases.slice(-2)).toEqual(['finish', 'fail']);
  expect(h.callsOf('fail')[0]!.args[4]).toBe('completion write failed');
  expect(jest.getTimerCount()).toBe(0);
});

it('heartbeats every fifteen seconds, ignores heartbeat failure and cleans up after successful completion', async () => {
  const stalled = deferred<unknown>();
  const h = harness({
    profilePromise: stalled.promise,
    heartbeatError: new Error('heartbeat unavailable'),
  });
  const work = h.worker.executeClaimedTask(task({ taskType: 'federal_market' }));
  await jest.advanceTimersByTimeAsync(0);
  await jest.advanceTimersByTimeAsync(14_999);
  expect(h.callsOf('heartbeat')).toEqual([]);
  await jest.advanceTimersByTimeAsync(1);
  expect(h.callsOf('heartbeat')[0]!.args).toEqual(['task-one', 'worker:lease-one']);
  await jest.advanceTimersByTimeAsync(15_000);
  expect(h.callsOf('heartbeat')).toHaveLength(2);
  stalled.resolve({});
  await work;
  expect(h.callsOf('finish')).toHaveLength(1);
  expect(h.callsOf('fail')).toEqual([]);
  expect(jest.getTimerCount()).toBe(0);
});

it('times out at five minutes and preserves the existing non-cancelling behavior of the raced specialist promise', async () => {
  const stalled = deferred<unknown>();
  const h = harness({ profilePromise: stalled.promise });
  const work = h.worker.executeClaimedTask(task({ taskType: 'federal_market' }));
  await jest.advanceTimersByTimeAsync(0);
  await jest.advanceTimersByTimeAsync(299_999);
  expect(h.callsOf('fail')).toEqual([]);
  await jest.advanceTimersByTimeAsync(1);
  await work;
  expect(h.callsOf('fail')[0]!.args[4]).toBe('Fill completion specialist exceeded its task budget');
  expect(h.callsOf('finish')).toEqual([]);
  expect(jest.getTimerCount()).toBe(0);
  stalled.resolve({});
  await jest.advanceTimersByTimeAsync(0);
  expect(h.callsOf('cursor')).toHaveLength(1);
  expect(h.callsOf('finish')).toEqual([]);
});

it('clears a timeout timer after an immediately rejected promise and preserves error identity', async () => {
  const h = harness();
  const error = new Error('same identity');
  await expect(h.worker.withTaskTimeout(Promise.reject(error))).rejects.toBe(error);
  expect(jest.getTimerCount()).toBe(0);
});

it('rejects unsupported task types after the real dependency gate with no specialist writes', async () => {
  const h = harness();
  const ctx = {
    tenantId: 'tenant-one',
    userId: 'actor-one',
    role: 'standard_user',
  } as unknown as TenantContext;
  await expect(h.worker.executeTask(ctx, task({ taskType: 'unknown_type' }))).rejects.toThrow(
    'Unsupported completion task unknown_type',
  );
  expect(h.calls).toEqual([]);
});

it.each([
  ['federal_market', ['federal_market']],
  ['facility_resolution', ['facility_resolution']],
  ['district_nexus', ['district_nexus']],
  ['advocacy_history', ['advocacy_history']],
  ['lifecycle_outcomes', ['lifecycle_outcomes']],
  ['reconciliation', []],
  ['completion_audit', []],
] as const)(
  'dispatches %s through its real empty-input capability path',
  async (taskType, cursors) => {
    const h = harness();
    const ctx = {
      tenantId: 'tenant-one',
      userId: 'actor-one',
      role: 'standard_user',
    } as unknown as TenantContext;
    const result = await h.worker.executeTask(ctx, task({ taskType }));
    if (taskType === 'advocacy_history')
      expect(result).toMatchObject({ count: 0, overallStatus: 'backfill_partial' });
    else expect(result).toBe(0);
    expect(h.callsOf('cursor').map((call) => call.args[2])).toEqual(cursors);
  },
);

it.each([false, true])(
  'treats a message-compatible foreign error as failure, including matching constructor name=%s',
  async (matchingName) => {
    const message = 'Waiting for prerequisite Fill specialists';
    const error = matchingName
      ? new (class TaskDeferredError extends Error {})(message)
      : new Error(message);
    const h = harness({ profileError: error });
    await h.worker.executeClaimedTask(task({ taskType: 'federal_market' }));
    expect(h.callsOf('defer')).toEqual([]);
    expect(h.callsOf('fail')[0]!.args[4]).toBe(message);
    expect(jest.getTimerCount()).toBe(0);
  },
);

it('propagates actor-read failure outside the task failure handler before creating timers', async () => {
  const error = new Error('actor read failed');
  const h = harness({ actorError: error });
  await expect(h.worker.executeClaimedTask(task())).rejects.toBe(error);
  expect(h.phases).toEqual(['actor']);
  expect(jest.getTimerCount()).toBe(0);
});

it('propagates heartbeat timer creation failure before entering the specialist try/finally', async () => {
  const h = harness();
  const error = new Error('timer unavailable');
  jest.spyOn(globalThis, 'setInterval').mockImplementation(() => {
    throw error;
  });
  await expect(h.worker.executeClaimedTask(task())).rejects.toBe(error);
  expect(h.phases).toEqual(['actor']);
  expect(h.callsOf('fail')).toEqual([]);
  expect(jest.getTimerCount()).toBe(0);
});
