import { NotetakerReconcileWorkerService } from './notetaker-reconcile-worker.service.js';
import { guardNotetakerService } from '../engagement/runtime/engagement-notetaker-runtime.boundary.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';
import { resolveEngagementRuntimeEnvironment } from '../engagement/runtime/engagement-runtime-env.js';
import { NotetakerService } from '../engagement/notetaker/notetaker.service.js';
import { ServiceUnavailableException } from '@nestjs/common';
import { EngagementMailHandoffBarrier } from '../engagement/runtime/engagement-mail-handoff.js';

/**
 * Final note-taker owner, exercised through the REAL stack: real environment resolution, real
 * policy, the real guarded service proxy, the real `NotetakerService` sweep and its inner client
 * reconciliation, driven by the real worker tick. The database is an inert empty-queue fake and the
 * recording provider is a spy, so no provider call, capture dispatch, removal or effect can occur.
 *
 * A mocked `runReconcileSweep` would not prove any of this: the ownership assertions live inside the
 * proxy, the sweep and the inner reconciliation, not in the worker.
 */

const FINAL = {
  CAPIRO_SERVICE_NAME: 'api',
  ENGAGEMENT_PROCESS_MODE: 'active',
  ENGAGEMENT_BACKGROUND_OWNER: 'api',
  ENGAGEMENT_EXTERNAL_ACTIONS: 'enabled',
  ENGAGEMENT_CALLBACKS_ENABLED: 'true',
  ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'true',
  ENGAGEMENT_BACKGROUND_WORKER_RESTRICTION: 'integration_sync_scheduler',
};

/** Empty, inert Prisma boundary: every model returns an empty page and records the access. */
function inertDatabase() {
  const reached: string[] = [];
  const model = () =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async () => {
          reached.push(method);
          if (method === 'findMany' || method === 'groupBy') return [];
          if (method === 'findFirst' || method === 'findUnique' || method === 'findUniqueOrThrow')
            return null;
          if (method === 'count') return 0;
          if (method === 'updateMany' || method === 'deleteMany') return { count: 0 };
          return {};
        },
      },
    );
  const tx = new Proxy(
    {},
    {
      get: (_t, property: string) => {
        if (property === '$queryRaw' || property === '$executeRaw') return async () => [];
        return model();
      },
    },
  );
  const prisma = { withSystem: async (fn: (t: unknown) => unknown) => fn(tx) };
  return { prisma, reached };
}

function stack(env: Record<string, string | undefined>, overrides: Record<string, unknown> = {}) {
  const runtime = new EngagementRuntimePolicyService(
    resolveEngagementRuntimeEnvironment(env),
    new EngagementMailHandoffBarrier(),
  );
  const { prisma, reached } = inertDatabase();
  const bot = {
    getTranscriptStatus: jest.fn(async () => 'processing'),
    startCapture: jest.fn(),
    stopCapture: jest.fn(),
    removeCapture: jest.fn(),
  };
  const service = new NotetakerService(
    prisma as never,
    bot as never,
    { effect: jest.fn() } as never,
    { get: () => undefined, getOrThrow: () => undefined } as never,
    runtime,
  );
  const guarded = guardNotetakerService(service, runtime);
  const worker = new NotetakerReconcileWorkerService(guarded, runtime);
  return { runtime, service, guarded, worker, reached, bot, ...overrides };
}

describe('final note-taker owner through the production stack', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    delete process.env.NOTETAKER_ENABLED;
    delete process.env.ENGAGEMENT_VERSIONED_OUTREACH;
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete process.env.NOTETAKER_ENABLED;
    delete process.env.ENGAGEMENT_VERSIONED_OUTREACH;
  });

  it('admits exactly the two note-taker duties on the final Recall-enabled tuple', async () => {
    const { runtime, worker, reached, bot } = stack(FINAL);
    expect(runtime.backgroundWorkersEnabled()).toBe(false);
    expect(runtime.backgroundWorkersEnabled('notetaker-reconcile')).toBe(false);
    expect(runtime.finalNotetakerWorkerEnabled('notetaker-reconcile')).toBe(true);
    expect(runtime.finalNotetakerWorkerEnabled('client-notetaker')).toBe(true);
    expect(runtime.finalNotetakerWorkerEnabled('outreach-job')).toBe(false);
    expect(runtime.finalNotetakerWorkerEnabled('meeting-prep')).toBe(false);
    expect(runtime.finalNotetakerWorkerEnabled()).toBe(false);

    worker.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(60_000);

    // The real sweep and inner client reconciliation reached the real database boundary.
    expect(reached).toContain('findMany');
    expect(bot.getTranscriptStatus).not.toHaveBeenCalled();
    expect(bot.startCapture).not.toHaveBeenCalled();
    expect(bot.stopCapture).not.toHaveBeenCalled();
    expect(bot.removeCapture).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
  });

  it('keeps existing cleanup working when NEW capture is disabled', async () => {
    process.env.NOTETAKER_ENABLED = 'false';
    const { worker, reached } = stack(FINAL);
    worker.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(60_000);
    // Recovery/removal/expiry must survive capture being switched off.
    expect(reached.length).toBeGreaterThan(0);
  });

  it.each([
    ['the accepted sender/prep stage (Recall=false)', { ...FINAL, ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false' }],
    ['a shadow process', { ...FINAL, ENGAGEMENT_PROCESS_MODE: 'shadow' }],
    ['a foreign owner', { ...FINAL, ENGAGEMENT_BACKGROUND_OWNER: 'disabled' }],
    ['the legacy notification service', { ...FINAL, CAPIRO_SERVICE_NAME: 'engagement-api' }],
    ['integrations_only', { ...FINAL, ENGAGEMENT_EXTERNAL_ACTIONS: 'integrations_only' }],
  ])('refuses startup and work on %s', async (_label, env) => {
    const resolved = { ...env };
    let runtime: EngagementRuntimePolicyService;
    try {
      runtime = new EngagementRuntimePolicyService(resolveEngagementRuntimeEnvironment(resolved));
    } catch {
      // A tuple the resolver already refuses is refused even earlier: nothing to sweep.
      return;
    }
    const { prisma, reached } = inertDatabase();
    const service = new NotetakerService(
      prisma as never,
      { getTranscriptStatus: jest.fn() } as never,
      {} as never,
      { get: () => undefined } as never,
      runtime,
    );
    const guarded = guardNotetakerService(service, runtime);
    const worker = new NotetakerReconcileWorkerService(guarded, runtime);
    worker.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    // The guarded proxy refuses synchronously; the raw async gates reject.
    expect(() => guarded.runReconcileSweep()).toThrow(ServiceUnavailableException);
    for (const work of [() => service.runReconcileSweep(), () => service.reconcileClientMeetings()]) {
      await expect(work()).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'ENGAGEMENT_BACKGROUND_DISABLED' }),
      });
    }
    expect(reached).toEqual([]);
  });

  it('starts one timer across duplicate startup and clears it on destroy', () => {
    const { worker } = stack(FINAL);
    worker.onModuleInit();
    worker.onModuleInit();
    worker.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    worker.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('both final Recall stages keep prep and the ordinary sender admitted', () => {
  afterEach(() => {
    delete process.env.ENGAGEMENT_VERSIONED_OUTREACH;
    delete process.env.MEETING_PREP_COMPREHENSIVE_ENABLED;
  });

  it.each(['true', 'false'] as const)('prep and sender under Recall=%s', (recall) => {
    process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'true';
    const runtime = new EngagementRuntimePolicyService(
      resolveEngagementRuntimeEnvironment({
        ...FINAL,
        ENGAGEMENT_RECALL_WEBHOOK_ENABLED: recall,
      }),
    );
    process.env.ENGAGEMENT_VERSIONED_OUTREACH = 'true';
    expect(() => runtime.assertMeetingPrepWorker()).not.toThrow();
    expect(runtime.ordinaryOutreachSendWorkerEnabled()).toBe(true);
    // The capture-receiving note-taker owner needs Recall enabled; the sender/prep stage does not
    // open it.
    expect(runtime.finalNotetakerWorkerEnabled('notetaker-reconcile')).toBe(recall === 'true');
  });

  it('keeps the ordinary sender off when the versioned flag is absent', () => {
    const runtime = new EngagementRuntimePolicyService(
      resolveEngagementRuntimeEnvironment(FINAL),
    );
    expect(runtime.ordinaryOutreachSendWorkerEnabled()).toBe(false);
  });

  it.each([
    ['a draining mail handoff', { phase: 'draining', generation: 'g1', fenceUtc: null }],
    ['an applied mail fence', { phase: 'applied', generation: 'g1', fenceUtc: '2026-10-30T04:00:00Z' }],
  ])('refuses the sender and the note-taker owner on %s', (_label, mailHandoff) => {
    const runtime = new EngagementRuntimePolicyService(
      { ...resolveEngagementRuntimeEnvironment(FINAL), mailHandoff } as never,
      new EngagementMailHandoffBarrier(),
    );
    process.env.ENGAGEMENT_VERSIONED_OUTREACH = 'true';
    expect(runtime.ordinaryOutreachSendWorkerEnabled()).toBe(false);
    expect(runtime.finalNotetakerWorkerEnabled('notetaker-reconcile')).toBe(false);
    expect(runtime.finalNotetakerWorkerEnabled('client-notetaker')).toBe(false);
  });
});
