import { RaceSafeOutreachSendIntentService } from '../engagement/race-safe-outreach-send-intent.service.js';
import { OutreachSendIntentWorkerService } from './outreach-send-intent-worker.service.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';
import { EngagementMailHandoffBarrier } from '../engagement/runtime/engagement-mail-handoff.js';

/**
 * Production-path regression: the ACTUAL RaceSafe wrapper, the ACTUAL base sweep, driven by the
 * ACTUAL worker tick. The database boundary is a fake that returns an empty controlled queue, so no
 * provider or database effect can occur. This closes the gap the mocked-jest.fn worker spec left
 * open: that test could not see that the real ordinary sweep refused before touching the database.
 */
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

/** Empty controlled queue at the existing Prisma boundary; records which selections were reached. */
function database() {
  const reached: string[] = [];
  const tx = {
    outreachDelivery: {
      findMany: async () => {
        reached.push('outreachDelivery.findMany');
        return [];
      },
      updateMany: async () => {
        reached.push('outreachDelivery.updateMany');
        return { count: 0 };
      },
    },
    outreachSendIntent: {
      findMany: async () => {
        reached.push('outreachSendIntent.findMany');
        return [];
      },
      findFirst: async () => {
        reached.push('outreachSendIntent.findFirst');
        return null;
      },
    },
    $queryRaw: async () => {
      reached.push('$queryRaw');
      return [];
    },
  };
  return { prisma: { withSystem: async (fn: (t: unknown) => unknown) => fn(tx) }, reached };
}

function production(runtime: EngagementRuntimePolicyService) {
  const { prisma, reached } = database();
  const mailSender = { send: jest.fn() };
  const config = {
    get: (key: string) => {
      if (key === 'OUTREACH_JOB_SWEEP_MS' || key === 'OUTREACH_JOB_STALE_MS') return 1000;
      if (key === 'ENGAGEMENT_VERSIONED_OUTREACH') return true;
      if (key === 'ENGAGEMENT_EXTERNAL_SEND_V2_REQUIRED') return false;
      return undefined;
    },
  };
  const intents = new RaceSafeOutreachSendIntentService(
    prisma as never,
    {} as never,
    mailSender as never,
    {} as never,
    {} as never,
    config as never,
    runtime,
  );
  const service = new OutreachSendIntentWorkerService(intents as never, config as never, runtime);
  return { service, intents, reached, mailSender, prisma };
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe('ordinary sender through the production RaceSafe sweep', () => {
  beforeEach(() => {
    process.env.ENGAGEMENT_VERSIONED_OUTREACH = 'true';
    jest.useFakeTimers();
  });
  afterEach(() => {
    delete process.env.ENGAGEMENT_VERSIONED_OUTREACH;
    delete process.env.OUTREACH_V3_STATE_ENABLED;
    delete process.env.OUTREACH_V3_DRAFTS_ENABLED;
    delete process.env.OUTREACH_V3_SEND_ENABLED;
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reaches the existing queue selection on the accepted tuple instead of refusing', async () => {
    const runtime = policy();
    const { service, reached, mailSender, prisma } = production(runtime);
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(1000);
    await flush();
    // The real base sweep reached its database boundary in ordinary (not V3-only) mode.
    expect(reached).toContain('outreachDelivery.findMany');
    expect(reached).toContain('outreachSendIntent.findMany');
    // Nothing was mutated, no provider effect, no replay.
    expect(reached).not.toContain('outreachDelivery.updateMany');
    expect(reached).not.toContain('outreachSendIntent.findFirst');
    expect(mailSender.send).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('refuses before the database boundary when the flag is off', async () => {
    delete process.env.ENGAGEMENT_VERSIONED_OUTREACH;
    const runtime = policy();
    const { service, reached } = production(runtime);
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    await flush();
    expect(reached).toEqual([]);
    service.onModuleDestroy();
  });

  it.each([
    ['a fenced mail handoff', policy({}, { phase: 'draining', generation: 'g1', fenceUtc: null })],
    ['a non-API service', policy({ serviceName: 'engagement-api', backgroundOwner: 'engagement-api' })],
    ['a shadow process', policy({ processMode: 'shadow' })],
  ])('refuses without sweeping on %s', async (_label, runtime) => {
    const { service, reached } = production(runtime);
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(1000);
    await flush();
    expect(reached).toEqual([]);
    service.onModuleDestroy();
  });

  it('keeps the V3-only selection filtered on the V3 path', async () => {
    process.env.OUTREACH_V3_STATE_ENABLED = 'true';
    process.env.OUTREACH_V3_DRAFTS_ENABLED = 'true';
    process.env.OUTREACH_V3_SEND_ENABLED = 'true';
    const runtime = policy(V3);
    expect(runtime.ordinaryOutreachSendWorkerEnabled()).toBe(false);
    const { service, reached } = production(runtime);
    service.onModuleInit();
    jest.advanceTimersByTime(1000);
    await flush();
    // V3-only branch reached the same selection boundary and did not fall through to refusal.
    expect(reached).toContain('outreachSendIntent.findMany');
    service.onModuleDestroy();
  });

  it('starts exactly one timer and never a base-class timer', async () => {
    const runtime = policy();
    const { service } = production(runtime);
    service.onModuleInit();
    service.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    service.onModuleDestroy();
  });
});
