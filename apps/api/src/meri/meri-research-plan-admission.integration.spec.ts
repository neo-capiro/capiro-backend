import { describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { MeriResearchService } from './meri-research.service.js';

jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../reviews/reviews.service.js', () => ({ ReviewsService: class {} }));
jest.mock('../engagement/ai-credential-resolver.service.js', () => ({
  AiCredentialResolverService: class {},
}));
jest.mock('./meri-v3-research-runner.js', () => ({ MeriV3ResearchRunner: class {} }));

const ctx = { tenantId: 'tenant-plan', userId: 'user-plan' } as TenantContext;

function validPlan() {
  return {
    version: 1,
    title: 'Validated research plan',
    scope: {
      sessionId: 'session-plan',
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      clientId: null,
      conversationId: null,
    },
    budget: { toolCalls: 2, tokens: 4_000 },
    steps: [
      {
        id: 'verify-current-status',
        objective: 'Verify the current status from authorized evidence.',
        dependsOn: [] as string[],
        requiredEvidenceDomains: ['institutional_memory'],
        allowedCapabilities: ['search_memory'],
        effect: 'read',
        completionCondition: 'Current status is supported or the source gap is explicit.',
        budget: { toolCalls: 2, tokens: 4_000 },
      },
    ],
    clarifyingQuestions: [],
  };
}

function fixture(options: {
  storedPlan?: unknown;
  providerOutputs?: string[];
  staleBeforeDispatch?: boolean;
} = {}) {
  let session: any = {
    id: 'session-plan',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    title: 'Legacy research',
    topic: 'Assess the current authorization outlook',
    status: 'researching',
    plan: ['Legacy status check'],
    clarifyingQuestions: [],
    clarifyingAnswers: {},
    sources: null,
    reportArtifactId: null,
    metadata: {
      ...(options.storedPlan === undefined ? {} : { researchPlan: options.storedPlan }),
      run: {
        id: 'saved-run',
        leaseEpoch: 0,
        eventSequence: 0,
        phase: 'research',
        status: 'interrupted',
        readyToStart: true,
        stage: 'Saved research is ready',
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      },
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  let findCount = 0;
  const tx: any = {
    $queryRawUnsafe: jest.fn(async (sql: string, ...values: unknown[]) => {
      if (!sql.includes('UPDATE clio_research_sessions')) return [{ allowed: true }];
      const run = session.metadata.run;
      const matches =
        values[0] === session.id &&
        values[1] === session.tenantId &&
        values[2] === session.userId &&
        values[3] === session.status &&
        values[4] === run.id &&
        String(values[5]) === String(run.leaseEpoch) &&
        values[6] === run.phase &&
        run.status === 'running';
      if (!matches) return [];
      if (sql.includes('SET metadata_jsonb')) {
        if (JSON.stringify(session.metadata) !== String(values[8])) return [];
        session = {
          ...session,
          metadata: JSON.parse(String(values[9])),
          status: values[10],
          updatedAt: new Date(values[11] as string | Date),
        };
      } else {
        session.updatedAt = new Date(values[8] as string | Date);
      }
      return [{ metadata_jsonb: structuredClone(session.metadata) }];
    }),
    clioResearchSession: {
      findFirst: jest.fn(async ({ where }: any) => {
        findCount += 1;
        if (
          !session ||
          where.id !== session.id ||
          where.tenantId !== session.tenantId ||
          where.userId !== session.userId
        )
          return null;
        if (options.staleBeforeDispatch && findCount >= 3 && session.metadata.run.status === 'running') {
          session.metadata.run = {
            ...session.metadata.run,
            status: 'interrupted',
            stage: 'Ownership changed',
          };
        }
        return structuredClone(session);
      }),
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
      update: jest.fn(async ({ where, data }: any) => {
        if (where.id !== session.id) throw new Error('wrong session');
        session = { ...session, ...structuredClone(data) };
        return structuredClone(session);
      }),
    },
    client: { findFirst: jest.fn(async () => null) },
    clioConversation: { findFirst: jest.fn(async () => null) },
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
  const tools = {
    anthropicToolSchemas: jest.fn(() => [
      { name: 'search_memory', description: 'Search memory', input_schema: { type: 'object' } },
      { name: 'send_email', description: 'Send email', input_schema: { type: 'object' } },
    ]),
    isConcurrencySafe: jest.fn((name: string) => name !== 'send_email'),
    isSideEffecting: jest.fn((name: string) => name === 'send_email'),
    execute: jest.fn(),
  };
  const outputs = [...(options.providerOutputs ?? [])];
  const runner = {
    enabled: jest.fn(async () => true),
    plan: jest.fn(async () => outputs.shift() ?? JSON.stringify(validPlan())),
    run: jest.fn(async (..._args: unknown[]) => {
      expect(session.metadata.researchPlan).toMatchObject({ version: 1 });
      expect(session.plan).toEqual(['Verify the current status from authorized evidence.']);
      expect(tools.execute).not.toHaveBeenCalled();
      throw new Error('dispatch sentinel');
    }),
  };
  const service = new MeriResearchService(
    prisma as never,
    {
      get: (key: string) =>
        ({
          CLIO_RESEARCH_PROGRESS_INTERVAL_MS: 5_000,
          CLIO_RESEARCH_TOTAL_BUDGET_MS: 60_000,
          CLIO_REQUEST_TIMEOUT_MS: 30_000,
        })[key],
    } as never,
    tools as never,
    {
      resolveProvider: jest.fn(),
      resolveProviderByTenantId: jest.fn(),
    } as never,
    {} as never,
    runner as never,
  );
  const events: any[] = [];
  const sse = {
    write: (data: string) => events.push(JSON.parse(data.replace(/^data: /, '').trim())),
  };
  return { service, runner, tools, tx, events, sse, getSession: () => session };
}

function invalidCases(): Array<[string, () => unknown, string]> {
  return [
    [
      'unknown capability',
      () => {
        const plan = validPlan();
        plan.steps[0]!.allowedCapabilities = ['invented_capability'];
        return plan;
      },
      'capability_unavailable',
    ],
    [
      'write capability disguised as a read',
      () => {
        const plan = validPlan();
        plan.steps[0]!.allowedCapabilities = ['send_email'];
        return plan;
      },
      'write_capability_requires_approval',
    ],
    [
      'scope mismatch',
      () => {
        const plan = validPlan();
        plan.scope.tenantId = 'other-tenant';
        return plan;
      },
      'scope_mismatch:tenantId',
    ],
    [
      'cyclic dependencies',
      () => {
        const plan = validPlan();
        plan.steps[0]!.dependsOn = ['verify-current-status'];
        return plan;
      },
      'self_dependency',
    ],
    [
      'overallocated budget',
      () => {
        const plan = validPlan();
        plan.steps[0]!.budget.tokens = 120_001;
        plan.budget.tokens = 120_001;
        return plan;
      },
      'budget_tokens_exceeds_120000',
    ],
  ];
}

describe('MeriResearchService typed-plan admission', () => {
  it.each(invalidCases())('gates %s before research dispatch with zero tools', async (_name, makePlan, issue) => {
    const f = fixture({ storedPlan: makePlan() });
    await f.service.streamResearch(ctx, 'session-plan', f.sse);
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(f.tools.execute).not.toHaveBeenCalled();
    expect(f.events.find((event) => event.type === 'error')?.message).toContain(issue);
  });

  it('allows only one provider repair and fails truthfully when the repair is also invalid', async () => {
    const f = fixture({
      providerOutputs: ['not json', JSON.stringify({ version: 1, title: 'still incomplete' })],
    });
    await f.service.streamResearch(ctx, 'session-plan', f.sse);
    expect(f.runner.plan).toHaveBeenCalledTimes(2);
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(f.tools.execute).not.toHaveBeenCalled();
    expect(f.events.find((event) => event.type === 'error')?.message).toContain(
      'remained invalid after one repair attempt',
    );
  });

  it('migrates a legacy string plan through planning, persists v1 and its UI projection, then dispatches', async () => {
    const f = fixture({ providerOutputs: [JSON.stringify(validPlan())] });
    await f.service.streamResearch(ctx, 'session-plan', f.sse);
    expect(f.runner.plan).toHaveBeenCalledTimes(1);
    expect(f.runner.run).toHaveBeenCalledTimes(1);
    expect(f.getSession().metadata.researchPlan).toMatchObject({ version: 1 });
    expect(f.getSession().plan).toEqual(['Verify the current status from authorized evidence.']);
    expect(f.runner.run.mock.calls[0]?.[1]).toMatchObject({
      admittedPlanExecution: {
        plan: { version: 1 },
        allowedReadCapabilities: ['search_memory'],
      },
    });
    expect(f.tools.execute).not.toHaveBeenCalled();
  });

  it('rechecks the active run fence after admission and dispatches nothing for a stale owner', async () => {
    const f = fixture({ storedPlan: validPlan(), staleBeforeDispatch: true });
    await f.service.streamResearch(ctx, 'session-plan', f.sse);
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(f.tools.execute).not.toHaveBeenCalled();
    expect(f.events.find((event) => event.type === 'error')?.message).toContain(
      'no longer running',
    );
  });
});
