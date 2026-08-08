import { OutreachJobWorkerService } from './outreach-job-worker.service.js';
import { OutreachSendIntentWorkerService } from './outreach-send-intent-worker.service.js';
import { NotetakerReconcileWorkerService } from './notetaker-reconcile-worker.service.js';

function runtime(enabled: boolean) {
  return {
    backgroundWorkersEnabled: jest.fn(() => enabled),
    assertBackgroundOwner: jest.fn(),
  };
}

function config(values: Record<string, unknown>) {
  return { get: jest.fn((key: string) => values[key]) };
}

describe('explicit Engagement worker shells', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('current/future owner starts one outreach-generation timer and repeat init is idempotent', () => {
    const service = new OutreachJobWorkerService(
      { runWorkerTick: jest.fn().mockResolvedValue(undefined) } as never,
      config({ OUTREACH_ASYNC_GEN: true, OUTREACH_ASYNC_SEND: false, OUTREACH_JOB_SWEEP_MS: 1000 }) as never,
      runtime(true) as never,
    );
    service.onModuleInit();
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('owner mismatch starts zero outreach-generation timers', () => {
    const service = new OutreachJobWorkerService(
      { runWorkerTick: jest.fn() } as never,
      config({ OUTREACH_ASYNC_GEN: true, OUTREACH_ASYNC_SEND: false, OUTREACH_JOB_SWEEP_MS: 1000 }) as never,
      runtime(false) as never,
    );
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('send-intent flag off starts zero timers', () => {
    const service = new OutreachSendIntentWorkerService(
      { runWorkerSweep: jest.fn() } as never,
      config({ ENGAGEMENT_VERSIONED_OUTREACH: false, OUTREACH_JOB_SWEEP_MS: 1000 }) as never,
      runtime(true) as never,
    );
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('Notetaker reconcile starts exactly one owner timer and clears it', () => {
    const service = new NotetakerReconcileWorkerService(
      { runReconcileSweep: jest.fn().mockResolvedValue(undefined) } as never,
      runtime(true) as never,
    );
    service.onModuleInit();
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
  });
});
