import { MeriResearchService } from './meri-research.service';
import { admitDurableResearchCoordinator } from './meri-research-coordinator';
import { admitResearchToolBudget } from './meri-research-tool-budget';
import type { ResearchPlanV1 } from './meri-research-plan';
import type { ResearchRunState } from './meri-research-run-state';

const ctx = { tenantId: 'tenant-1', userId: 'user-1', tenantSlug: 'tenant' } as never;

const plan: ResearchPlanV1 = {
  version: 1,
  title: 'Coordinator service contract',
  scope: {
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    actorId: 'user-1',
    clientId: null,
    conversationId: null,
  },
  budget: { toolCalls: 2, tokens: 4_000 },
  steps: [
    {
      id: 'read-current-record',
      objective: 'Read the current canonical record.',
      dependsOn: [],
      requiredEvidenceDomains: ['institutional_memory'],
      allowedCapabilities: ['search_memory'],
      effect: 'read',
      completionCondition: 'A qualified owner receipt is saved.',
      budget: { toolCalls: 1, tokens: 2_000 },
    },
    {
      id: 'read-current-status',
      objective: 'Read status after the record.',
      dependsOn: ['read-current-record'],
      requiredEvidenceDomains: ['institutional_memory'],
      allowedCapabilities: ['search_memory'],
      effect: 'read',
      completionCondition: 'A qualified status receipt is saved.',
      budget: { toolCalls: 1, tokens: 2_000 },
    },
  ],
  clarifyingQuestions: [],
};

function fixture() {
  const run: ResearchRunState = {
    id: 'run-1',
    leaseEpoch: 1,
    eventSequence: 0,
    phase: 'research',
    status: 'running',
    stage: 'Gathering evidence',
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  const budgeted = admitResearchToolBudget(
    { run, unrelatedFutureProviderBudget: { kept: true } },
    2,
  );
  const admitted = admitDurableResearchCoordinator({
    metadata: budgeted.metadata,
    plan,
    objective: 'Assess the current status',
    run,
  });
  let session: Record<string, any> = {
    id: 'session-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    clientId: null,
    topic: 'Assess the current status',
    title: plan.title,
    status: 'researching',
    plan: plan.steps.map((step) => step.objective),
    clarifyingQuestions: [],
    clarifyingAnswers: {},
    reportArtifactId: null,
    sources: null,
    metadata: admitted.metadata,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const tx: any = {
    clioResearchSession: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === session.id &&
        where.tenantId === session.tenantId &&
        where.userId === session.userId
          ? structuredClone(session)
          : null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (
          where.id !== session.id ||
          where.tenantId !== session.tenantId ||
          where.userId !== session.userId ||
          JSON.stringify(where.metadata?.equals) !== JSON.stringify(session.metadata)
        )
          return { count: 0 };
        session = { ...session, ...structuredClone(data) };
        return { count: 1 };
      }),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (db: typeof tx) => unknown) =>
      callback(tx),
    ),
    withTenantUser: jest.fn(
      async (_tenantId: string, _userId: string, callback: (db: typeof tx) => unknown) =>
        callback(tx),
    ),
  };
  const service = new MeriResearchService(
    prisma as never,
    { get: jest.fn() } as never,
    {
      anthropicToolSchemas: jest.fn(() => []),
      isConcurrencySafe: jest.fn(() => true),
      isSideEffecting: jest.fn(() => false),
    } as never,
    {} as never,
    {} as never,
  );
  return { service, tx, getSession: () => session };
}

describe('MeriResearchService coordinator HTTP contract', () => {
  it('persists one ordered steering receipt, fences the old run, and resumes the event cursor', async () => {
    const f = fixture();
    const accepted = await f.service.steerRun(ctx, 'session-1', {
      version: 1,
      requestId: 'steer-house-only',
      expectedGoalRevision: 0,
      message: 'Use the House version only.',
    });
    expect(accepted).toMatchObject({
      version: 1,
      accepted: true,
      idempotentReplay: false,
      receipt: { sequence: 1, goalRevision: 1, state: 'pending_safe_boundary' },
    });
    expect(f.getSession().metadata.unrelatedFutureProviderBudget).toEqual({ kept: true });
    expect(f.getSession().metadata.run).toMatchObject({
      id: 'run-1',
      leaseEpoch: 1,
      status: 'interrupted',
      readyToStart: true,
    });

    const replay = await f.service.steerRun(ctx, 'session-1', {
      version: 1,
      requestId: 'steer-house-only',
      expectedGoalRevision: 0,
      message: 'Use the House version only.',
    });
    expect(replay).toMatchObject({ idempotentReplay: true, receipt: accepted.receipt });
    await expect(
      f.service.steerRun(ctx, 'session-1', {
        version: 1,
        requestId: 'steer-stale',
        expectedGoalRevision: 0,
        message: 'Use the Senate version.',
      }),
    ).rejects.toThrow('research_goal_revision_conflict:1');

    const all = await f.service.getCoordinatorSnapshot(ctx, 'session-1', '0');
    expect(all).toMatchObject({
      version: 1,
      researchId: 'session-1',
      coordinator: { goalRevision: 1 },
    });
    const cursor = all.events.at(-1)!.sequence - 1;
    const resumed = await f.service.getCoordinatorSnapshot(ctx, 'session-1', String(cursor));
    expect(resumed.events.every((event: any) => event.sequence > cursor)).toBe(true);
    expect(resumed.nextSequence).toBe(all.nextSequence);
  });

  it('commits cancel_requested before observed cancellation and retains prior state', async () => {
    const f = fixture();
    const stopped = await f.service.cancelRun(ctx, 'session-1', {
      version: 1,
      requestId: 'stop-1',
      reason: 'User pressed Stop',
    });
    expect(stopped).toMatchObject({
      version: 1,
      ok: true,
      idempotentReplay: false,
      run: { status: 'cancel_requested' },
    });
    expect(f.tx.clioResearchSession.updateMany).toHaveBeenCalledTimes(2);
    const snapshot = await f.service.getCoordinatorSnapshot(ctx, 'session-1');
    expect(snapshot.run).toMatchObject({ status: 'cancelled' });
    expect(snapshot.coordinator).toMatchObject({
      cancellation: { state: 'observed', requestId: 'stop-1' },
    });
    expect(f.getSession().metadata.unrelatedFutureProviderBudget).toEqual({ kept: true });
  });
});
