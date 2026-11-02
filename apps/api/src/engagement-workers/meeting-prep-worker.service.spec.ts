import { MeetingPrepWorkerService } from './meeting-prep-worker.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';
import { EngagementMailHandoffBarrier } from '../engagement/runtime/engagement-mail-handoff.js';

const FINAL = {
  serviceName: 'api' as const,
  processMode: 'active' as const,
  backgroundOwner: 'api' as const,
  externalActions: 'enabled' as const,
  callbacksEnabled: true,
  recallWebhookEnabled: false,
  backgroundWorkerRestriction: 'integration_sync_scheduler' as const,
};

function policy(
  overrides: Record<string, unknown> = {},
  mailHandoff: { phase: string; generation: string | null; fenceUtc: string | null } = {
    phase: 'off',
    generation: null,
    fenceUtc: null,
  },
) {
  return new EngagementRuntimePolicyService(
    { ...FINAL, ...overrides, mailHandoff } as never,
    new EngagementMailHandoffBarrier(),
  );
}

function worker(runtime: EngagementRuntimePolicyService) {
  // the tick path uses the SAME runtime owner predicate as startup
  const jobs = { runWorkerTick: jest.fn(async () => void runtime.assertMeetingPrepWorker()) };
  return { service: new MeetingPrepWorkerService(jobs as never, runtime), jobs };
}

/** The real Nest 503 body of a policy denial, so tests assert the contract and not a string. */
function denial(run: () => void) {
  try {
    run();
  } catch (error) {
    const response = (error as { getResponse?: () => Record<string, unknown> }).getResponse?.();
    return { status: (error as { getStatus?: () => number }).getStatus?.(), ...(response ?? {}) };
  }
  throw new Error('expected a policy denial');
}

describe('comprehensive meeting-prep worker ownership', () => {
  beforeEach(() => {
    process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'true';
    jest.useFakeTimers();
  });
  afterEach(() => {
    delete process.env.MEETING_PREP_COMPREHENSIVE_ENABLED;
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it.each([false, true])(
    'starts exactly one timer on the final tuple with Recall=%s',
    async (recallWebhookEnabled) => {
      const runtime = policy({ recallWebhookEnabled });
      expect(runtime.meetingPrepWorkerEnabled()).toBe(true);
      const { service, jobs } = worker(runtime);
      service.onModuleInit();
      service.onModuleInit();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(jobs.runWorkerTick).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
      // the flag still gates both variants
      process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'false';
      expect(policy({ recallWebhookEnabled }).meetingPrepWorkerEnabled()).toBe(false);
      process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'true';
    },
  );

  it('starts and ticks on the accepted final API tuple through one predicate', async () => {
    const runtime = policy();
    expect(runtime.meetingPrepWorkerEnabled()).toBe(true);
    const { service, jobs } = worker(runtime);
    service.onModuleInit();
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(jobs.runWorkerTick).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(20_000);
    expect(jobs.runWorkerTick).toHaveBeenCalledTimes(1);
  });

  it('starts no timer when the comprehensive-prep flag is off', () => {
    delete process.env.MEETING_PREP_COMPREHENSIVE_ENABLED;
    const runtime = policy();
    expect(runtime.meetingPrepWorkerEnabled()).toBe(false);
    const { service } = worker(runtime);
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('starts no timer in the shadow/disabled owner posture and refuses the tick too', async () => {
    const runtime = policy({
      processMode: 'shadow',
      backgroundOwner: 'disabled',
      externalActions: 'disabled',
      callbacksEnabled: false,
      recallWebhookEnabled: false,
    });
    expect(runtime.meetingPrepWorkerEnabled()).toBe(false);
    expect(denial(() => runtime.assertMeetingPrepWorker())).toMatchObject({
      statusCode: 503,
      code: 'ENGAGEMENT_BACKGROUND_DISABLED',
      worker: 'meeting-prep-worker',
    });
    const { service, jobs } = worker(runtime);
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    await expect(jobs.runWorkerTick()).rejects.toThrow();
  });

  it('never starts from a closed old-writer posture even with the final tuple', () => {
    const runtime = policy({}, {
      phase: 'writers_closed',
      generation: 'mail-app-20261029-01',
      fenceUtc: '2026-10-29T16:49:59Z',
    });
    expect(runtime.meetingPrepWorkerEnabled()).toBe(false);
    const { service } = worker(runtime);
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves the generic scheduler-only restriction unchanged', () => {
    const runtime = policy();
    expect(runtime.backgroundWorkersEnabled()).toBe(false);
    expect(runtime.backgroundWorkersEnabled('engagement-sync-scheduler')).toBe(true);
    expect(runtime.backgroundWorkersEnabled('meeting-prep-worker')).toBe(false);
    expect(runtime.meetingPrepWorkerEnabled()).toBe(true);
    expect(() => runtime.assertBackgroundOwner('meeting-prep-worker')).toThrow();
  });

  describe('legacy generic API owner still honours the feature flag', () => {
    // no restriction, owner === service: the pre-existing named policy alone admits meeting-prep-worker
    const legacy = () => policy({ recallWebhookEnabled: true, backgroundWorkerRestriction: undefined });

    it('starts no timer and never ticks when the flag is absent', () => {
      delete process.env.MEETING_PREP_COMPREHENSIVE_ENABLED;
      const runtime = legacy();
      expect(runtime.backgroundWorkersEnabled('meeting-prep-worker')).toBe(true);
      expect(runtime.meetingPrepWorkerEnabled()).toBe(false);
      const { service, jobs } = worker(runtime);
      service.onModuleInit();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(10_000);
      expect(jobs.runWorkerTick).not.toHaveBeenCalled();
    });

    it('starts no timer when the flag is explicitly false', () => {
      process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'false';
      const runtime = legacy();
      expect(runtime.meetingPrepWorkerEnabled()).toBe(false);
      const { service, jobs } = worker(runtime);
      service.onModuleInit();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(10_000);
      expect(jobs.runWorkerTick).not.toHaveBeenCalled();
    });

    it('keeps the prior valid legacy path when the flag is true', async () => {
      const runtime = legacy();
      expect(runtime.meetingPrepWorkerEnabled()).toBe(true);
      const { service, jobs } = worker(runtime);
      service.onModuleInit();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(jobs.runWorkerTick).toHaveBeenCalledTimes(1);
      service.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
