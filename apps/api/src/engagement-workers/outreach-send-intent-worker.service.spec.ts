import { OutreachSendIntentWorkerService } from './outreach-send-intent-worker.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';
import { EngagementMailHandoffBarrier } from '../engagement/runtime/engagement-mail-handoff.js';

/** The accepted final API tuple: Core36, not the retired writer posture. */
const FINAL = {
  serviceName: 'api' as const,
  processMode: 'active' as const,
  backgroundOwner: 'api' as const,
  externalActions: 'enabled' as const,
  callbacksEnabled: true,
  recallWebhookEnabled: false,
  backgroundWorkerRestriction: 'integration_sync_scheduler' as const,
};

const V3 = {
  serviceName: 'engagement-api' as const,
  processMode: 'shadow' as const,
  backgroundOwner: 'engagement-api' as const,
  externalActions: 'disabled' as const,
  callbacksEnabled: false,
  recallWebhookEnabled: false,
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

function worker(runtime: EngagementRuntimePolicyService, enabled = true) {
  const intents = { runWorkerSweep: jest.fn(async () => {}) };
  const config = { get: (key: string) => (key === 'ENGAGEMENT_VERSIONED_OUTREACH' ? enabled : 1000) };
  const service = new OutreachSendIntentWorkerService(
    intents as never,
    config as never,
    runtime,
  );
  return { service, intents };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ordinary canonical outreach sender ownership', () => {
  beforeEach(() => {
    process.env.ENGAGEMENT_VERSIONED_OUTREACH = 'true';
    jest.useFakeTimers();
  });
  afterEach(() => {
    delete process.env.ENGAGEMENT_VERSIONED_OUTREACH;
    delete process.env.OUTREACH_V3_STATE_ENABLED;
    delete process.env.OUTREACH_V3_DRAFTS_ENABLED;
    delete process.env.OUTREACH_V3_SEND_ENABLED;
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('starts and sweeps the ordinary queue on the accepted tuple through one predicate', async () => {
    const runtime = policy();
    expect(runtime.ordinaryOutreachSendWorkerEnabled()).toBe(true);
    // The generic scheduler-only selector is unchanged: unnamed admission stays false, and the
    // restriction still admits only the sync scheduler by name.
    expect(runtime.backgroundWorkersEnabled()).toBe(false);
    expect(runtime.backgroundWorkersEnabled('outreach-send-intent-worker')).toBe(false);
    expect(runtime.backgroundWorkersEnabled('engagement-sync-scheduler')).toBe(true);

    const { service, intents } = worker(runtime);
    service.onModuleInit();
    jest.advanceTimersByTime(1000);
    await flush();
    expect(intents.runWorkerSweep).toHaveBeenCalledTimes(1);
    // Ordinary, not V3-only: the sweep must consider canonical intents.
    expect(intents.runWorkerSweep).toHaveBeenCalledWith(false);
    service.onModuleDestroy();
  });

  it('never starts or sweeps while the existing flag is off', async () => {
    delete process.env.ENGAGEMENT_VERSIONED_OUTREACH;
    const runtime = policy();
    expect(runtime.ordinaryOutreachSendWorkerEnabled()).toBe(false);
    expect(runtime.backgroundWorkersEnabled()).toBe(false);

    const { service, intents } = worker(runtime, false);
    service.onModuleInit();
    jest.advanceTimersByTime(5000);
    await flush();
    expect(intents.runWorkerSweep).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('refuses every tuple variant that is not the accepted final API owner', () => {
    const variants: Record<string, unknown>[] = [
      { serviceName: 'engagement-api' },
      { processMode: 'shadow' },
      { backgroundOwner: 'engagement-api' },
      { externalActions: 'integrations_only' },
      { callbacksEnabled: false },
      { recallWebhookEnabled: true },
    ];
    for (const overrides of variants) {
      const runtime = policy(overrides);
      expect({ overrides, enabled: runtime.ordinaryOutreachSendWorkerEnabled() }).toEqual({
        overrides,
        enabled: false,
      });
      const { service, intents } = worker(runtime);
      service.onModuleInit();
      jest.advanceTimersByTime(1000);
      expect(intents.runWorkerSweep).not.toHaveBeenCalled();
      service.onModuleDestroy();
    }
  });

  it('refuses a process whose mail handoff is not open', () => {
    const runtime = policy({}, { phase: 'draining', generation: 'g1', fenceUtc: null });
    expect(runtime.ordinaryOutreachSendWorkerEnabled()).toBe(false);
    const { service, intents } = worker(runtime);
    service.onModuleInit();
    jest.advanceTimersByTime(1000);
    expect(intents.runWorkerSweep).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('keeps the generic background policy exactly as it was on a legacy owner', () => {
    const legacy = policy({ backgroundWorkerRestriction: undefined });
    expect(legacy.backgroundWorkersEnabled()).toBe(true);
    expect(legacy.backgroundWorkersEnabled('outreach-send-intent-worker')).toBe(true);
    // And on the retired writer posture the sender is still not admitted by ownership alone.
    const retired = policy({ serviceName: 'engagement-api', backgroundOwner: 'engagement-api' });
    expect(retired.ordinaryOutreachSendWorkerEnabled()).toBe(false);
  });

  it('retains the existing V3-only selection for a process without ordinary ownership', async () => {
    process.env.OUTREACH_V3_STATE_ENABLED = 'true';
    process.env.OUTREACH_V3_DRAFTS_ENABLED = 'true';
    process.env.OUTREACH_V3_SEND_ENABLED = 'true';
    const runtime = policy(V3);
    expect(runtime.ordinaryOutreachSendWorkerEnabled()).toBe(false);
    expect(runtime.outreachV3SendIntentWorkerEnabled()).toBe(true);

    const { service, intents } = worker(runtime);
    service.onModuleInit();
    jest.advanceTimersByTime(1000);
    await flush();
    expect(intents.runWorkerSweep).toHaveBeenCalledWith(true);
    service.onModuleDestroy();
  });

  it('stops working when ownership is lost after startup and does not fall back to V3', async () => {
    const runtime = policy();
    const { service, intents } = worker(runtime);
    service.onModuleInit();
    delete process.env.ENGAGEMENT_VERSIONED_OUTREACH;
    jest.advanceTimersByTime(1000);
    await flush();
    expect(intents.runWorkerSweep).not.toHaveBeenCalled();
    expect(runtime.ordinaryOutreachSendWorkerEnabled()).toBe(false);
    service.onModuleDestroy();
  });

  it('denies the tick with the stable background refusal contract', () => {
    delete process.env.ENGAGEMENT_VERSIONED_OUTREACH;
    const runtime = policy();
    let response: { status?: number } & Record<string, unknown> = {};
    try {
      runtime.assertOrdinaryOutreachSendWorker();
    } catch (error) {
      const nest = error as { getResponse?: () => Record<string, unknown>; getStatus?: () => number };
      response = { status: nest.getStatus?.(), ...(nest.getResponse?.() ?? {}) };
    }
    expect(response).toMatchObject({
      status: 503,
      code: 'ENGAGEMENT_BACKGROUND_DISABLED',
      worker: 'outreach-send-intent-worker',
    });
  });
});
