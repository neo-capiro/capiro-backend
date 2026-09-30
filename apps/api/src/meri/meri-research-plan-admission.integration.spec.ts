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
jest.mock('../memory/memory-wall.helpers.js', () => ({
  clientMemoryAllowed: jest.fn(async () => true),
}));

const ctx = { tenantId: 'tenant-plan', userId: 'user-plan' } as TenantContext;

function validPlan(clientId: string | null = null, capability = 'search_memory') {
  return {
    version: 1,
    title: 'Validated research plan',
    scope: {
      sessionId: 'session-plan',
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      clientId,
      conversationId: null,
    },
    budget: { toolCalls: 2, tokens: 4_000 },
    steps: [
      {
        id: 'verify-current-status',
        objective: 'Verify the current status from authorized evidence.',
        dependsOn: [] as string[],
        requiredEvidenceDomains: ['institutional_memory'],
        allowedCapabilities: [capability],
        effect: 'read',
        completionCondition: 'Current status is supported or the source gap is explicit.',
        budget: { toolCalls: 2, tokens: 4_000 },
      },
    ],
    clarifyingQuestions: [],
  };
}

function fixture(
  options: {
    storedPlan?: unknown;
    providerOutputs?: string[];
    staleBeforeDispatch?: boolean;
    clientId?: string | null;
    switchClientOnRead?: number;
    replaceClientAndPlanOnRead?: number;
    replacePlanDuringEnabled?: unknown;
    removeCapabilityDuringEnabled?: boolean;
  } = {},
) {
  let session: any = {
    id: 'session-plan',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: options.clientId ?? null,
    title: 'Legacy research',
    topic: 'Assess the current authorization outlook',
    status: 'researching',
    plan:
      options.storedPlan &&
      typeof options.storedPlan === 'object' &&
      Array.isArray((options.storedPlan as { steps?: unknown }).steps)
        ? (options.storedPlan as { steps: Array<{ objective?: unknown }> }).steps
            .map((step) => step.objective)
            .filter((objective): objective is string => typeof objective === 'string')
        : ['Legacy status check'],
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
        if (options.switchClientOnRead === findCount) {
          session = { ...session, clientId: 'different-client' };
        }
        if (options.replaceClientAndPlanOnRead === findCount) {
          const clientId = 'replacement-client';
          session = {
            ...session,
            clientId,
            metadata: { ...session.metadata, researchPlan: validPlan(clientId) },
          };
        }
        if (
          !session ||
          where.id !== session.id ||
          where.tenantId !== session.tenantId ||
          where.userId !== session.userId
        )
          return null;
        if (
          options.staleBeforeDispatch &&
          findCount >= 3 &&
          session.metadata.run.status === 'running'
        ) {
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
    client: {
      findFirst: jest.fn(async ({ where }: any) => ({
        name: where.id,
        description: `Private context for ${where.id}`,
        productDescription: null,
      })),
    },
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
  let capabilityNames = ['search_memory', 'get_client_context', 'send_email'];
  const tools = {
    anthropicToolSchemas: jest.fn(() =>
      capabilityNames.map((name) => ({
        name,
        description: name,
        input_schema: { type: 'object' },
      })),
    ),
    isConcurrencySafe: jest.fn((name: string) => name !== 'send_email'),
    isSideEffecting: jest.fn((name: string) => name === 'send_email'),
    execute: jest.fn(),
  };
  const outputs = [...(options.providerOutputs ?? [])];
  const runner = {
    enabled: jest.fn(async () => {
      if (options.removeCapabilityDuringEnabled) capabilityNames = ['send_email'];
      if (options.replacePlanDuringEnabled) {
        session = {
          ...session,
          metadata: { ...session.metadata, researchPlan: options.replacePlanDuringEnabled },
        };
      }
      return true;
    }),
    plan: jest.fn(async () => outputs.shift() ?? JSON.stringify(validPlan(session.clientId))),
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
  const logger = { warn: jest.fn() };
  Object.assign(service as object, { logger });
  const events: any[] = [];
  const sse = {
    write: (data: string) => events.push(JSON.parse(data.replace(/^data: /, '').trim())),
  };
  return {
    service,
    runner,
    logger,
    tools,
    tx,
    events,
    sse,
    getSession: () => session,
  };
}

function duplicateVersionJson(plan: ReturnType<typeof validPlan>): string {
  return JSON.stringify(plan).replace('"version":1', '"version":99,"version":1');
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
      'steps[0].capability_unavailable:invented_capability',
    ],
    [
      'write capability disguised as a read',
      () => {
        const plan = validPlan();
        plan.steps[0]!.allowedCapabilities = ['send_email'];
        return plan;
      },
      'steps[0].write_capability_requires_approval:send_email',
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
      'self_dependency:verify-current-status; dependency_cycle',
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
  it.each(invalidCases())(
    'gates %s before research dispatch with zero tools',
    async (_name, makePlan, issue) => {
      const f = fixture({ storedPlan: makePlan() });
      await f.service.streamResearch(ctx, 'session-plan', f.sse);
      expect(f.runner.run).not.toHaveBeenCalled();
      expect(f.tools.execute).not.toHaveBeenCalled();
      expect(f.events.find((event) => event.type === 'error')?.message).toBe(
        'Research failed before report publication.',
      );
      expect(f.logger.warn).toHaveBeenCalledWith(
        `Research run failed: Saved research plan is not admitted for the current scope and capabilities: ${issue}`,
      );
    },
  );

  it('allows only one provider repair and fails truthfully when the repair is also invalid', async () => {
    const f = fixture({
      providerOutputs: ['not json', JSON.stringify({ version: 1, title: 'still incomplete' })],
    });
    await f.service.streamResearch(ctx, 'session-plan', f.sse);
    expect(f.runner.plan).toHaveBeenCalledTimes(2);
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(f.tools.execute).not.toHaveBeenCalled();
    expect(f.events.find((event) => event.type === 'error')?.message).toBe(
      'Research failed before report publication.',
    );
    expect(f.logger.warn).toHaveBeenCalledWith(
      'Research run failed: Research plan remained invalid after one repair attempt: plan_missing_field:scope; plan_missing_field:budget; plan_missing_field:steps; plan_missing_field:clarifyingQuestions; scope_must_be_object; budget_must_be_object; clarifyingQuestions_must_be_array; steps_must_be_array',
    );
  });

  it('spends the one repair on duplicate-key provider JSON before dispatching the valid repair', async () => {
    const f = fixture({
      providerOutputs: [duplicateVersionJson(validPlan()), JSON.stringify(validPlan())],
    });
    await f.service.streamResearch(ctx, 'session-plan', f.sse);
    expect(f.runner.plan).toHaveBeenCalledTimes(2);
    expect(f.runner.run).toHaveBeenCalledTimes(1);
    expect(f.tools.execute).not.toHaveBeenCalled();
  });

  it('rejects a duplicate-key repair with no dispatch or tool effects', async () => {
    const nestedDuplicate = JSON.stringify(validPlan()).replace(
      '"budget":{"toolCalls":2',
      '"budget":{"toolCalls":99,"toolCalls":2',
    );
    const f = fixture({
      providerOutputs: [duplicateVersionJson(validPlan()), nestedDuplicate],
    });
    await f.service.streamResearch(ctx, 'session-plan', f.sse);
    expect(f.runner.plan).toHaveBeenCalledTimes(2);
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(f.tools.execute).not.toHaveBeenCalled();
    expect(f.events.find((event) => event.type === 'error')?.message).toBe(
      'Research failed before report publication.',
    );
    expect(f.logger.warn).toHaveBeenCalledWith(
      'Research run failed: Research plan remained invalid after one repair attempt: duplicate_object_key:"toolCalls"',
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
    expect(f.events.find((event) => event.type === 'error')?.message).toBe(
      'Research failed before report publication.',
    );
    expect(f.logger.warn).toHaveBeenCalledWith(
      'Research run failed: Research is no longer running.',
    );
  });

  it('uses the unchanged current client row and admitted scope at V3 dispatch', async () => {
    const clientId = 'client-current';
    const f = fixture({ storedPlan: validPlan(clientId), clientId });
    await f.service.streamResearch(ctx, 'session-plan', f.sse);
    expect(f.runner.run).toHaveBeenCalledTimes(1);
    expect(f.runner.run.mock.calls[0]?.[1]).toMatchObject({ clientId });
    expect(f.getSession().metadata.researchPlan.scope.clientId).toBe(clientId);
    expect(f.tools.execute).not.toHaveBeenCalled();
  });

  it('carries a valid same-scope plan revision and current read union into V3 dispatch', async () => {
    const replacement = validPlan(null, 'get_client_context');
    const f = fixture({
      storedPlan: validPlan(),
      replacePlanDuringEnabled: replacement,
    });
    await f.service.streamResearch(ctx, 'session-plan', f.sse);
    expect(f.runner.run).toHaveBeenCalledTimes(1);
    expect(f.runner.run.mock.calls[0]?.[1]).toMatchObject({
      admittedPlanExecution: {
        plan: replacement,
        allowedReadCapabilities: ['get_client_context'],
      },
    });
    expect(f.runner.run.mock.calls[0]?.[1]).toMatchObject({
      user: expect.stringContaining('get_client_context'),
    });
    expect(f.runner.run.mock.calls[0]?.[1]).toMatchObject({
      user: expect.not.stringContaining('\"allowedCapabilities\":[\"search_memory\"]'),
    });
    expect(f.tools.execute).not.toHaveBeenCalled();
  });

  it('rejects the original third-read client mutation with zero V3 or tool calls', async () => {
    const f = fixture({ storedPlan: validPlan(), switchClientOnRead: 3 });
    await f.service.streamResearch(ctx, 'session-plan', f.sse);
    expect(f.getSession().clientId).toBe('different-client');
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(f.tools.execute).not.toHaveBeenCalled();
    expect(f.events.find((event) => event.type === 'error')?.message).toBe(
      'Research failed before report publication.',
    );
    expect(f.logger.warn).toHaveBeenCalledWith(
      'Research run failed: Research plan validation failed: scope_mismatch:clientId',
    );
  });

  it('rejects a matching third-read client and plan rebind before private input dispatch', async () => {
    const f = fixture({
      storedPlan: validPlan('original-client'),
      clientId: 'original-client',
      replaceClientAndPlanOnRead: 3,
    });
    await f.service.streamResearch(ctx, 'session-plan', f.sse);
    expect(f.getSession().clientId).toBe('replacement-client');
    expect(f.getSession().metadata.researchPlan.scope.clientId).toBe('replacement-client');
    expect(f.runner.plan).not.toHaveBeenCalled();
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(f.tools.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(f.events)).not.toContain('Private context for original-client');
    expect(f.events.find((event) => event.type === 'error')?.message).toBe(
      'Research failed before report publication.',
    );
    expect(f.logger.warn).toHaveBeenCalledWith(
      'Research run failed: Research scope changed during dispatch preparation.',
    );
  });

  it('rejects current-catalog removal during asynchronous dispatch preparation', async () => {
    const f = fixture({ storedPlan: validPlan(), removeCapabilityDuringEnabled: true });
    await f.service.streamResearch(ctx, 'session-plan', f.sse);
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(f.tools.execute).not.toHaveBeenCalled();
    expect(f.events.find((event) => event.type === 'error')?.message).toBe(
      'Research failed before report publication.',
    );
    expect(f.logger.warn).toHaveBeenCalledWith(
      'Research run failed: Saved research plan is not admitted for the current scope and capabilities: steps[0].capability_unavailable:search_memory',
    );
  });
});
