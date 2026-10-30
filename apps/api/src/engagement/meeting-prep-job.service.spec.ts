import { MeetingPrepJobService } from './meeting-prep-job.service.js';
import { mondayBoardScopeFromQuery } from '../retrieval/adapters/monday-board-scope.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';
import { EngagementMailHandoffBarrier } from './runtime/engagement-mail-handoff.js';

describe('durable meeting prep jobs', () => {
  const ctx = {
    tenantId: 'tenant',
    userId: 'actor',
    role: 'standard_user',
    tenantSlug: 'firm',
    clerkUserId: 'clerk',
  };
  beforeEach(() => {
    process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.MEETING_PREP_COMPREHENSIVE_ENABLED;
  });
  test('extracts explicit monday board scope without treating unrelated task numbers as boards', () => {
    expect(
      mondayBoardScopeFromQuery(
        'Use https://firm.monday.com/boards/18431248553/pulses/13088410202 and ORBIT-4729.',
      ),
    ).toEqual({ explicit: true, invalid: false, boardIds: ['18431248553'] });
    expect(mondayBoardScopeFromQuery('Focus on FY27 task 13088410202.')).toEqual({
      explicit: false,
      invalid: false,
      boardIds: [],
    });
  });
  function harness() {
    let row: Record<string, unknown> | null = null;
    const tx = {
      tenantMembership: { findFirst: jest.fn().mockResolvedValue({ role: 'standard_user' }) },
      meeting: {
        findFirst: jest.fn().mockResolvedValue({
          clientId: null,
          isInternal: true,
          associationSignals: {},
          status: 'confirmed',
        }),
      },
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'client' }) },
      meetingPrepJob: {
        findUnique: jest.fn(async () => row),
        findFirst: jest.fn(async () => row),
        create: jest.fn(
          async ({ data }) =>
            (row = {
              ...data,
              id: 'job',
              status: 'queued',
              stage: 'queued',
              createdAt: new Date(),
              updatedAt: new Date(),
              prepId: null,
              errorCode: null,
            }),
        ),
        updateMany: jest.fn(async ({ data }) => {
          if (row) Object.assign(row, data);
          return { count: row ? 1 : 0 };
        }),
      },
    };
    const prisma = { withTenantUser: jest.fn(async (_tenant, _actor, run) => run(tx)) };
    const crypto = {
      encrypt: jest.fn((text) => ({
        bodyCiphertext: 'encrypted:' + text,
        iv: 'iv',
        authTag: 'tag',
      })),
    };
    const runtime = { assertExternalAction: jest.fn() };
    const service = new MeetingPrepJobService(
      prisma as never,
      {} as never,
      crypto as never,
      runtime as never,
    );
    return { service, tx, prisma, crypto, runtime };
  }
  test('same request key creates exactly one encrypted actor-scoped job', async () => {
    const h = harness();
    const first = await h.service.submit(ctx as never, 'meeting', {
      requestKey: 'stable-key-123',
      additionalContext: 'Sensitive focus',
    });
    const second = await h.service.submit(ctx as never, 'meeting', {
      requestKey: 'stable-key-123',
      additionalContext: 'Sensitive focus',
    });
    expect(first.jobId).toBe(second.jobId);
    expect(h.tx.meetingPrepJob.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain('Sensitive');
    expect(h.crypto.encrypt).toHaveBeenCalledTimes(1);
    expect(h.prisma.withTenantUser).toHaveBeenCalledWith('tenant', 'actor', expect.any(Function));
  });
  test('rejects reuse of an idempotency key with different input', async () => {
    const h = harness();
    await h.service.submit(ctx as never, 'meeting', { requestKey: 'stable-key-123' });
    await expect(
      h.service.submit(ctx as never, 'meeting', { requestKey: 'stable-key-123', depth: 'deep' }),
    ).rejects.toThrow('different preparation settings');
  });
  test('cancellation is actor scoped and never deletes a previous briefing', async () => {
    const h = harness();
    await h.service.submit(ctx as never, 'meeting', {});
    const cancelled = await h.service.cancel(ctx as never, 'meeting', 'job');
    expect(cancelled?.status).toBe('cancelled');
    expect(h.tx.meetingPrepJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant',
          userId: 'actor',
          meetingId: 'meeting',
          status: { in: ['queued', 'running'] },
        }),
      }),
    );
  });
  test.each(['false', undefined])(
    'returns the persisted cancellation receipt after the generation flag becomes %s',
    async (flag) => {
      const h = harness();
      await h.service.submit(ctx as never, 'meeting', {});
      if (flag === undefined) delete process.env.MEETING_PREP_COMPREHENSIVE_ENABLED;
      else process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = flag;

      const cancelled = await h.service.cancel(ctx as never, 'meeting', 'job');

      expect(cancelled).toMatchObject({
        jobId: 'job',
        meetingId: 'meeting',
        status: 'cancelled',
        stage: 'cancelled',
      });
      expect(cancelled).not.toHaveProperty('input');
      expect(await h.tx.meetingPrepJob.findFirst()).toMatchObject({
        status: 'cancelled',
        leaseToken: null,
        leaseUntil: null,
      });
      expect(h.tx.meetingPrepJob.findFirst).toHaveBeenCalledWith({
        where: { tenantId: 'tenant', userId: 'actor', meetingId: 'meeting', id: 'job' },
        orderBy: { createdAt: 'desc' },
      });
    },
  );
  test.each(['membership', 'meeting', 'client wall'])(
    'refuses cancellation before writing after loss of %s access',
    async (boundary) => {
      const h = harness();
      await h.service.submit(ctx as never, 'meeting', {});
      process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'false';
      if (boundary === 'membership') h.tx.tenantMembership.findFirst.mockResolvedValue(null);
      else if (boundary === 'meeting') h.tx.meeting.findFirst.mockResolvedValue(null);
      else {
        h.tx.meeting.findFirst.mockResolvedValue({ clientId: 'client', isInternal: false });
        h.tx.client.findFirst.mockResolvedValue(null);
      }

      await expect(h.service.cancel(ctx as never, 'meeting', 'job')).rejects.toThrow();

      expect(h.tx.meetingPrepJob.updateMany).not.toHaveBeenCalled();
      expect(await h.tx.meetingPrepJob.findFirst()).toMatchObject({ status: 'queued' });
    },
  );
  test.each(['membership', 'meeting', 'client wall'])(
    'withholds the committed cancellation receipt after loss of %s access',
    async (boundary) => {
      const h = harness();
      await h.service.submit(ctx as never, 'meeting', {});
      process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'false';
      if (boundary === 'membership') {
        h.tx.tenantMembership.findFirst
          .mockResolvedValueOnce({ role: 'standard_user' })
          .mockResolvedValue(null);
      } else if (boundary === 'meeting') {
        h.tx.meeting.findFirst
          .mockResolvedValueOnce({ clientId: null, isInternal: true })
          .mockResolvedValue(null);
      } else {
        h.tx.meeting.findFirst.mockResolvedValue({ clientId: 'client', isInternal: false });
        h.tx.client.findFirst.mockResolvedValueOnce({ id: 'client' }).mockResolvedValue(null);
      }

      await expect(h.service.cancel(ctx as never, 'meeting', 'job')).rejects.toThrow();

      expect(h.tx.meetingPrepJob.findFirst).not.toHaveBeenCalled();
      expect(await h.tx.meetingPrepJob.findFirst()).toMatchObject({ status: 'cancelled' });
    },
  );
  test('does not fabricate cancellation when the persisted job is already terminal', async () => {
    const h = harness();
    await h.service.submit(ctx as never, 'meeting', {});
    await h.tx.meetingPrepJob.updateMany({ data: { status: 'completed', prepId: 'saved-prep' } });
    h.tx.meetingPrepJob.updateMany.mockResolvedValue({ count: 0 });
    process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'false';

    expect(await h.service.cancel(ctx as never, 'meeting', 'job')).toMatchObject({
      status: 'completed',
      prepId: 'saved-prep',
    });
  });
  test('does not return a receipt after a cancellation commit failure', async () => {
    const h = harness();
    await h.service.submit(ctx as never, 'meeting', {});
    h.prisma.withTenantUser.mockImplementationOnce(async (_tenant, _actor, run) => {
      await run(h.tx);
      throw new Error('commit failed');
    });
    process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'false';

    await expect(h.service.cancel(ctx as never, 'meeting', 'job')).rejects.toThrow('commit failed');

    expect(h.tx.meetingPrepJob.findFirst).not.toHaveBeenCalled();
  });
  test('preserves an unknown outcome when post-commit readback fails', async () => {
    const h = harness();
    await h.service.submit(ctx as never, 'meeting', {});
    h.tx.meetingPrepJob.findFirst.mockRejectedValueOnce(new Error('readback unavailable'));
    process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'false';

    await expect(h.service.cancel(ctx as never, 'meeting', 'job')).rejects.toThrow(
      'readback unavailable',
    );

    expect(await h.tx.meetingPrepJob.findFirst()).toMatchObject({ status: 'cancelled' });
  });
  test('revoked membership cannot start or inspect jobs', async () => {
    const h = harness();
    h.tx.tenantMembership.findFirst.mockResolvedValue(null);
    await expect(h.service.submit(ctx as never, 'meeting', {})).rejects.toThrow('access changed');
    expect(h.tx.meetingPrepJob.create).not.toHaveBeenCalled();
  });
  test('disabled release gate does not touch an unmigrated jobs table', async () => {
    const h = harness();
    delete process.env.MEETING_PREP_COMPREHENSIVE_ENABLED;
    expect(await h.service.get(ctx as never, 'meeting')).toBeNull();
    expect(h.prisma.withTenantUser).not.toHaveBeenCalled();
  });

  test.each([
    ['meeting_prep_model_context_budget_exceeded', 'PREP_INPUT_TOO_LARGE'],
    ['meeting_prep_deadline_exceeded', 'PREP_DEADLINE_EXCEEDED'],
  ])('reports the actual failure without exposing provider data: %s', async (message, code) => {
    const h = harness();
    await h.service.submit(ctx as never, 'meeting', {});
    const internal = h.service as unknown as {
      crypto: { decrypt: () => string };
      process: (job: unknown, token: string) => Promise<void>;
    };
    internal.crypto.decrypt = () => {
      throw new Error(message);
    };
    await internal.process(
      {
        id: 'job',
        tenantId: 'tenant',
        userId: 'actor',
        meetingId: 'meeting',
        deadlineAt: new Date(Date.now() + 3600000),
        input: {},
      },
      'lease',
    );
    expect(h.tx.meetingPrepJob.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'job',
        tenantId: 'tenant',
        userId: 'actor',
        leaseToken: 'lease',
        status: 'running',
      },
      data: {
        status: 'failed',
        stage: 'failed',
        errorCode: code,
        leaseToken: null,
        leaseUntil: null,
      },
    });
  });

  describe('background worker tick ownership', () => {
    function workerHarness(assertMeetingPrepWorker: () => void) {
      const tx = { meetingPrepJob: { updateMany: jest.fn(async () => ({ count: 0 })),
                                     findFirst: jest.fn(async () => null) } };
      const prisma = {
        withSystem: jest.fn(async (run: (tx: unknown) => unknown) => run(tx)),
        withTenantUser: jest.fn(),
      };
      const runtime = { assertMeetingPrepWorker: jest.fn(assertMeetingPrepWorker),
                        assertExternalAction: jest.fn() };
      const service = new MeetingPrepJobService(
        prisma as never,
        {} as never,
        { encrypt: jest.fn(), decrypt: jest.fn() } as never,
        runtime as never,
      );
      return { service, prisma, runtime, tx };
    }

    test('allowed tick consults the prep owner and reaches the existing system claim', async () => {
      const h = workerHarness(() => {});
      await h.service.runWorkerTick();
      expect(h.runtime.assertMeetingPrepWorker).toHaveBeenCalledTimes(1);
      expect(h.runtime.assertExternalAction).toHaveBeenCalledWith('meeting_prep_generate');
      expect(h.prisma.withSystem).toHaveBeenCalledTimes(1);
      expect(h.tx.meetingPrepJob.findFirst).toHaveBeenCalledTimes(1);
    });

    test('denied tick refuses before any database or provider work', async () => {
      const h = workerHarness(() => {
        throw new Error('MEETING_PREP_WORKER_DISABLED');
      });
      await expect(h.service.runWorkerTick()).rejects.toThrow('MEETING_PREP_WORKER_DISABLED');
      expect(h.prisma.withSystem).not.toHaveBeenCalled();
      expect(h.tx.meetingPrepJob.updateMany).not.toHaveBeenCalled();
      expect(h.runtime.assertExternalAction).not.toHaveBeenCalled();
    });

    describe('through the real runtime policy', () => {
      const realRuntime = (
        overrides: Record<string, unknown> = {},
        mailHandoff = { phase: 'off', generation: null, fenceUtc: null },
      ) =>
        new EngagementRuntimePolicyService(
          {
            serviceName: 'api',
            processMode: 'active',
            backgroundOwner: 'api',
            externalActions: 'enabled',
            callbacksEnabled: true,
            recallWebhookEnabled: false,
            backgroundWorkerRestriction: 'integration_sync_scheduler',
            ...overrides,
            mailHandoff,
          } as never,
          new EngagementMailHandoffBarrier(),
        );

      /** The same wiring as workerHarness, but the assertion is the real policy method. */
      const realHarness = (runtime: EngagementRuntimePolicyService) => {
        const tx = {
          meetingPrepJob: {
            updateMany: jest.fn(async () => ({ count: 0 })),
            findFirst: jest.fn(async () => null),
          },
        };
        const prisma = {
          withSystem: jest.fn(async (run: (tx: unknown) => unknown) => run(tx)),
          withTenantUser: jest.fn(),
        };
        return {
          service: new MeetingPrepJobService(
            prisma as never,
            {} as never,
            { encrypt: jest.fn(), decrypt: jest.fn() } as never,
            runtime,
          ),
          prisma,
          tx,
        };
      };

      test.each([false, true])(
        'the tick reaches the existing system claim with Recall=%s',
        async (recallWebhookEnabled) => {
          const h = realHarness(realRuntime({ recallWebhookEnabled }));
          await h.service.runWorkerTick();
          expect(h.prisma.withSystem).toHaveBeenCalledTimes(1);
          expect(h.tx.meetingPrepJob.findFirst).toHaveBeenCalledTimes(1);
        },
      );

      test.each([
        ['callbacks disabled', { callbacksEnabled: false }],
        ['wrong process mode', { processMode: 'shadow' }],
        ['wrong background owner', { backgroundOwner: 'disabled' }],
      ])('refuses on %s before any claim or provider work', async (_label, overrides) => {
        const h = realHarness(realRuntime(overrides));
        let body: Record<string, unknown> | undefined;
        try {
          await h.service.runWorkerTick();
        } catch (error) {
          body = (error as { getResponse?: () => Record<string, unknown> }).getResponse?.();
          expect((error as { getStatus?: () => number }).getStatus?.()).toBe(503);
        }
        expect(body).toMatchObject({
          statusCode: 503,
          code: 'ENGAGEMENT_BACKGROUND_DISABLED',
          worker: 'meeting-prep-worker',
        });
        expect(h.prisma.withSystem).not.toHaveBeenCalled();
        expect(h.tx.meetingPrepJob.updateMany).not.toHaveBeenCalled();
      });

      test('refuses a non-open mail-handoff phase with Recall enabled', async () => {
        const h = realHarness(
          realRuntime({ recallWebhookEnabled: true }, {
            phase: 'writers_closed',
            generation: 'mail-app-20261029-01',
            fenceUtc: '2026-10-29T16:49:59Z',
          }),
        );
        await expect(h.service.runWorkerTick()).rejects.toThrow();
        expect(h.prisma.withSystem).not.toHaveBeenCalled();
      });

      test('the comprehensive-prep flag off short-circuits the real policy too', async () => {
        process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'false';
        const h = realHarness(realRuntime({ recallWebhookEnabled: true }));
        await h.service.runWorkerTick();
        expect(h.prisma.withSystem).not.toHaveBeenCalled();
      });
    });

    test('the comprehensive-prep flag off short-circuits the tick', async () => {
      process.env.MEETING_PREP_COMPREHENSIVE_ENABLED = 'false';
      const h = workerHarness(() => {});
      await h.service.runWorkerTick();
      expect(h.runtime.assertMeetingPrepWorker).not.toHaveBeenCalled();
      expect(h.prisma.withSystem).not.toHaveBeenCalled();
    });
  });
});
