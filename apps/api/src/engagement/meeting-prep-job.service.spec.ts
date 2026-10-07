import { MeetingPrepJobService } from './meeting-prep-job.service.js';
import { mondayBoardScopeFromQuery } from '../retrieval/adapters/monday-board-scope.js';

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
});
