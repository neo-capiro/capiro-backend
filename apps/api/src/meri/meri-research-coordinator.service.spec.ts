import { MeriResearchService } from './meri-research.service';
import { admitDurableResearchCoordinator } from './meri-research-coordinator';
import {
  admitResearchToolBudget,
  readResearchProviderBudget,
  reserveResearchProviderAttempt,
} from './meri-research-tool-budget';
import type { ResearchPlanV1 } from './meri-research-plan';
import type { ResearchRunState } from './meri-research-run-state';
import { createMeriOtelRuntime } from '@capiro/meriv2-core/observability/otel';
import {
  createMeriApiTelemetryContext,
  runWithMeriApiTelemetry,
  setMeriOtelRuntime,
} from './meri-telemetry.runtime';

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

function fixture(withMetadata: (metadata: Record<string, unknown>) => Record<string, unknown> = (m) => m) {
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
    metadata: withMetadata(admitted.metadata),
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
  afterEach(async () => {
    await setMeriOtelRuntime(undefined);
  });
  it('gives an accepted steer its own provider-attempt allowance, never more tokens or cost', async () => {
    // Session 0b61fbff (2026-10-07): the revised run inherited the first run's
    // spent attempts and ended partial with tokens and cost far from spent.
    const limits = {
      maxAttempts: 2,
      maxTokens: 10_000,
      maxCostMicros: 1_000_000,
      deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    const f = fixture((metadata) => {
      let next: unknown = metadata;
      for (const attemptId of ['attempt-1', 'attempt-2']) {
        next = reserveResearchProviderAttempt({
          metadata: next,
          run: { id: 'run-1', leaseEpoch: 1 },
          limits,
          binding: {
            logicalOperationId: attemptId,
            attemptId,
            retryOfAttemptId: null,
            kind: 'openai_responses',
            phase: 'acquisition',
            provider: 'openai',
            model: 'gpt-4.1',
            maxInputTokens: 100,
            maxOutputTokens: 200,
          },
          price: { inputPerM: 2, outputPerM: 8 },
          reservationId: `reservation-${attemptId}`,
        }).metadata;
      }
      return next as Record<string, unknown>;
    });
    await f.service.steerRun(ctx, 'session-1', {
      version: 1,
      requestId: 'steer-house-only',
      expectedGoalRevision: 0,
      message: 'Use the House version only.',
    });
    // The configured default allowance (23) on top of the 2 attempts charged.
    expect(readResearchProviderBudget(f.getSession().metadata)).toMatchObject({
      chargedAttempts: 2,
      limits: { ...limits, maxAttempts: 25 },
    });
  });

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
    // The job column mirrors the accepted goal revision (Stage 2 §5.1).
    expect(f.getSession().goalRevision).toBe(1);

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
    const spans: any[] = [];
    const sdk = createMeriOtelRuntime({
      serviceName: 'cancel-owner-test',
      exporter: {
        export: (batch, done) => {
          spans.push(...batch);
          done({ code: 0 });
        },
        shutdown: async () => {},
      },
    });
    await setMeriOtelRuntime(sdk);
    const trace = createMeriApiTelemetryContext({ headers: {} } as never, ctx, '');
    const stopped = await runWithMeriApiTelemetry(
      trace,
      () => {},
      () =>
        f.service.cancelRun(ctx, 'session-1', {
          version: 1,
          requestId: 'stop-1',
          reason: 'PRIVATE_CANCELLATION_REASON',
        }),
    );
    await sdk.forceFlush();
    const event = spans
      .flatMap((span) => span.events)
      .find((entry) => entry.attributes['meri.name'] === 'meri.research.cancelled');
    expect(event).toBeDefined();
    expect(event.attributes).toMatchObject({
      'meri.terminalReason': 'cancelled',
      'meri.cancellationIssuer': 'user',
      'meri.leaseEpoch': 1,
    });
    expect(
      JSON.stringify(spans.map((span) => ({ attributes: span.attributes, events: span.events }))),
    ).not.toContain('PRIVATE_CANCELLATION_REASON');
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
