import { ServiceUnavailableException } from '@nestjs/common';
import { NotetakerReconcileWorkerService } from './notetaker-reconcile-worker.service.js';
import { guardNotetakerService } from '../engagement/runtime/engagement-notetaker-runtime.boundary.js';
import { EngagementRuntimePolicyService } from '../engagement/runtime/engagement-runtime-policy.service.js';
import { resolveEngagementRuntimeEnvironment } from '../engagement/runtime/engagement-runtime-env.js';
import { EngagementMailHandoffBarrier } from '../engagement/runtime/engagement-mail-handoff.js';
import { NotetakerService } from '../engagement/notetaker/notetaker.service.js';

/**
 * Final note-taker owner through the REAL stack: real environment parsing, real policy, the real
 * guarded service proxy, the real `NotetakerService.runReconcileSweep` and the real inner
 * `reconcileClientMeetings`, driven by the real worker tick.
 *
 * Two deliberate properties of the harness:
 *  - database calls are recorded MODEL-QUALIFIED (`clientNotetakerPreference.findMany`), because a
 *    method-name-only log cannot tell the inner client duty apart from the later recovery reads that
 *    `runReconcileSweep` performs after swallowing an inner failure;
 *  - the provider exposes the real port surface (`dispatchBot` / `leaveCall`), and the cleanup case
 *    drives a synthetic revoked preference plus one existing session, so "no dispatch" and "actual
 *    pullback" are observable facts rather than absent ports.
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

type Call = { model: string; method: string; args: unknown[] };

/** Inert Prisma boundary with explicit rows; records every model-qualified call. */
function fakeDatabase(rows: Record<string, Record<string, unknown>> = {}) {
  const calls: Call[] = [];
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async (...args: unknown[]) => {
          calls.push({ model: name, method, args });
          const configured = rows[name]?.[method];
          if (typeof configured === 'function') {
            return (configured as (...a: unknown[]) => unknown)(...args);
          }
          if (configured !== undefined) return configured;
          if (method === 'findMany' || method === 'groupBy') return [];
          if (method === 'findFirst' || method === 'findUnique' || method === 'findUniqueOrThrow') {
            return null;
          }
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
        return model(property);
      },
    },
  );
  const prisma = {
    withSystem: async (fn: (t: unknown) => unknown) => fn(tx),
    withTenant: async (_tenant: string, fn: (t: unknown) => unknown) => fn(tx),
  };
  const reached = (name: string, method: string) =>
    calls.some((call) => call.model === name && call.method === method);
  return { prisma, calls, reached };
}

function stack(
  env: Record<string, string | undefined>,
  rows: Record<string, Record<string, unknown>> = {},
) {
  const resolved = resolveEngagementRuntimeEnvironment(env);
  const runtime = new EngagementRuntimePolicyService(resolved, new EngagementMailHandoffBarrier());
  const { prisma, calls, reached } = fakeDatabase(rows);
  const bot = { dispatchBot: jest.fn(), leaveCall: jest.fn(async () => undefined) };
  const service = new NotetakerService(
    prisma as never,
    bot as never,
    { clientMeetingAssociationWhere: async () => ({}) } as never,
    { get: () => undefined, getOrThrow: () => undefined } as never,
    runtime,
  );
  const guarded = guardNotetakerService(service, runtime);
  const worker = new NotetakerReconcileWorkerService(guarded, runtime);
  return { resolved, runtime, service, guarded, worker, bot, calls, reached };
}

const preference = {
  id: 'p1',
  tenantId: 't1',
  userId: 'u1',
  clientId: 'c1',
  revision: 1,
  enabled: true,
  consent: { authorizedToRecord: true, allPartiesWillBeNotified: true },
};

/** One existing automatic session whose standing preference has been revoked. */
const revokedRows = {
  clientNotetakerPreference: {
    findMany: [preference],
    findFirst: { ...preference, enabled: false },
  },
  tenantMembership: { findFirst: { status: 'active' } },
  client: { findFirst: { id: 'c1', status: 'active' } },
  tenant: { findFirst: { settings: {} } },
  meetingBotSession: {
    findMany: [
      {
        id: 's1',
        meetingId: 'm1',
        tenantId: 't1',
        externalBotId: 'bot_1',
        status: 'recording',
        joinUrl: 'https://us02web.zoom.us/j/123',
        metadata: { path: ['clientNotetakerPreferenceId'], equals: 'p1' },
      },
    ],
    updateMany: { count: 1 },
  },
};

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
    delete process.env.MEETING_PREP_COMPREHENSIVE_ENABLED;
  });

  it('admits exactly the two duties and reaches the inner client scan on the real tick', async () => {
    const { runtime, worker, bot, reached } = stack(FINAL);
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

    // Model-qualified: the inner client duty actually ran, not merely a later recovery read.
    expect(reached('clientNotetakerPreference', 'findMany')).toBe(true);
    expect(reached('meetingBotSession', 'findMany')).toBe(true);
    expect(bot.dispatchBot).not.toHaveBeenCalled();
    expect(bot.leaveCall).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(1);
  });

  it('refuses before the inner client scan when only that duty is denied', async () => {
    // Focused negative control over the real chain: the outer sweep still runs and still performs
    // later recovery reads, so only a model-qualified assertion can catch a reverted inner gate.
    const { runtime, worker, reached } = stack(FINAL);
    jest.spyOn(runtime, 'assertFinalNotetakerWorker').mockImplementation(((name: string) => {
      if (name === 'client-notetaker') {
        throw new ServiceUnavailableException({
          statusCode: 503,
          code: 'ENGAGEMENT_BACKGROUND_DISABLED',
        });
      }
    }) as never);
    worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(reached('clientNotetakerPreference', 'findMany')).toBe(false);
    expect(reached('meetingBotSession', 'findMany')).toBe(true);
  });

  it('pulls back one existing revoked session with capture disabled and dispatches nothing', async () => {
    process.env.NOTETAKER_ENABLED = 'false';
    const { worker, bot, reached, calls } = stack(FINAL, revokedRows);
    worker.onModuleInit();
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(60_000);

    expect(reached('clientNotetakerPreference', 'findMany')).toBe(true);
    expect(bot.leaveCall).toHaveBeenCalledWith('bot_1');
    const update = calls.find(
      (call) => call.model === 'meetingBotSession' && call.method === 'updateMany',
    );
    expect(update?.args[0]).toMatchObject({ data: { status: 'removed' } });
    expect(bot.dispatchBot).not.toHaveBeenCalled();
  });

  it('admits the raw client gate directly on the final tuple', async () => {
    const { service, reached } = stack(FINAL);
    await service.reconcileClientMeetings();
    expect(reached('clientNotetakerPreference', 'findMany')).toBe(true);
  });

  it.each(['initiation_fenced', 'callback_fenced', 'writers_closed'] as const)(
    'refuses sender and both duties under the real %s selection',
    (phase) => {
      const resolved = resolveEngagementRuntimeEnvironment({
        ...FINAL,
        ENGAGEMENT_MAIL_HANDOFF_PHASE: phase,
        ENGAGEMENT_MAIL_HANDOFF_GENERATION: 'g1',
        ENGAGEMENT_MAIL_HANDOFF_FENCE_UTC: '2026-10-30T05:00:00Z',
      });
      expect(resolved.mailHandoff).toMatchObject({ phase, generation: 'g1' });
      const runtime = new EngagementRuntimePolicyService(
        resolved,
        new EngagementMailHandoffBarrier(),
      );
      expect(runtime.mailHandoffPhase()).toBe(phase);
      process.env.ENGAGEMENT_VERSIONED_OUTREACH = 'true';
      expect(runtime.ordinaryOutreachSendWorkerEnabled()).toBe(false);
      expect(runtime.finalNotetakerWorkerEnabled('notetaker-reconcile')).toBe(false);
      expect(runtime.finalNotetakerWorkerEnabled('client-notetaker')).toBe(false);
    },
  );

  it.each(['draining', 'applied', 'fenced'])(
    'keeps refusing the unsupported phase name %p at the real parser',
    (phase) => {
      expect(() =>
        resolveEngagementRuntimeEnvironment({
          ...FINAL,
          ENGAGEMENT_MAIL_HANDOFF_PHASE: phase,
          ENGAGEMENT_MAIL_HANDOFF_GENERATION: 'g1',
        }),
      ).toThrow(/ENGAGEMENT_MAIL_HANDOFF_PHASE/);
    },
  );

  it.each([
    ['a shadow process', { ...FINAL, ENGAGEMENT_PROCESS_MODE: 'shadow' }],
    ['a foreign owner', { ...FINAL, ENGAGEMENT_BACKGROUND_OWNER: 'disabled' }],
    ['the legacy notification service', { ...FINAL, CAPIRO_SERVICE_NAME: 'engagement-api' }],
    ['integrations_only', { ...FINAL, ENGAGEMENT_EXTERNAL_ACTIONS: 'integrations_only' }],
  ])('refuses %s at the real preflight, before any policy exists', (_label, env) => {
    // These tuples are rejected outright by the resolver with the scheduler restriction, so no
    // worker, policy or sweep is ever constructed for them.
    expect(() => resolveEngagementRuntimeEnvironment(env as Record<string, string>)).toThrow(
      /ENGAGEMENT_/,
    );
  });

  it('denies startup and raw work on the sender/prep Recall=false stage', async () => {
    // This tuple IS admitted by the resolver (it is today's deployable stage) but must not open the
    // capture receiver's note-taker owner.
    const { runtime, worker, service, reached } = stack({
      ...FINAL,
      ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'false',
    });
    expect(runtime.finalNotetakerWorkerEnabled('notetaker-reconcile')).toBe(false);
    expect(runtime.finalNotetakerWorkerEnabled('client-notetaker')).toBe(false);
    worker.onModuleInit();
    expect(jest.getTimerCount()).toBe(0);
    await expect(service.runReconcileSweep()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ENGAGEMENT_BACKGROUND_DISABLED' }),
    });
    await expect(service.reconcileClientMeetings()).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ENGAGEMENT_BACKGROUND_DISABLED' }),
    });
    expect(reached('clientNotetakerPreference', 'findMany')).toBe(false);
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
  beforeEach(() => {
    process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.ENGAGEMENT_VERSIONED_OUTREACH;
    delete process.env.MEETING_PREP_COMPREHENSIVE_ENABLED;
  });

  it.each(['true', 'false'] as const)('prep and sender under Recall=%s', (recall) => {
    const resolved = resolveEngagementRuntimeEnvironment({
      ...FINAL,
      ENGAGEMENT_RECALL_WEBHOOK_ENABLED: recall,
    });
    const runtime = new EngagementRuntimePolicyService(
      resolved,
      new EngagementMailHandoffBarrier(),
    );
    process.env.ENGAGEMENT_VERSIONED_OUTREACH = 'true';
    expect(() => runtime.assertMeetingPrepWorker()).not.toThrow();
    expect(runtime.ordinaryOutreachSendWorkerEnabled()).toBe(true);
    // Only the capture stage opens the note-taker owner.
    expect(runtime.finalNotetakerWorkerEnabled('notetaker-reconcile')).toBe(recall === 'true');
  });

  it('keeps the ordinary sender off when the versioned flag is absent', () => {
    const runtime = new EngagementRuntimePolicyService(
      resolveEngagementRuntimeEnvironment(FINAL),
      new EngagementMailHandoffBarrier(),
    );
    expect(runtime.ordinaryOutreachSendWorkerEnabled()).toBe(false);
  });
});
