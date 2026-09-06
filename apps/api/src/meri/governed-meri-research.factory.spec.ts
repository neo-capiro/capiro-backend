import type { TenantContext } from '@capiro/shared';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { createGovernedMeriResearchService } from './governed-meri-research.factory.js';
import { MeriResearchService } from './meri-research.service.js';

jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../reviews/reviews.service.js', () => ({ ReviewsService: class {} }));
jest.mock('../engagement/ai-credential-resolver.service.js', () => ({ AiCredentialResolverService: class {} }));
jest.mock('./meri-v3-research-runner.js', () => ({ MeriV3ResearchRunner: class {} }));
jest.mock('./meri-context-plane.service.js', () => ({ MeriContextPlaneService: class {} }));

const ctx = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as TenantContext;

const governed = (operationId: MeriGovernedTurnContext['operationId']): MeriGovernedTurnContext => ({
  version: 1,
  operationId,
  prompt: `Governed prompt for ${operationId}`,
  contextPacket: {
    packetId: 'packet-1',
    persisted: true,
    items: [],
    exclusions: [],
    unauthorizedCount: 0,
    degraded: false,
  },
  retrieval: {
    plan: {
      version: 1,
      queryClass: 'lookup',
      subjectScope: 'client',
      targetHint: null,
      recipeTool: null,
      requireCompleteCoverage: false,
      requiredDomains: ['clients'],
      timeWindow: null,
    },
    coverage: {
      version: 1,
      complete: true,
      requestedDomains: ['clients'],
      searchedDomains: ['clients'],
      missingDomains: [],
      partialDomains: [],
      requestedEntityCount: 1,
      searchedEntityCount: 1,
      recordsEvaluated: 1,
      recordsReturned: 1,
      paginationComplete: true,
      truncated: false,
      sourceHealth: [{ source: 'clients', status: 'complete' }],
      unavailableSources: [],
      toolsInvoked: ['retrieval-v2:clients'],
      stopReason: 'complete',
    },
  },
});

function makeHarness(opts: { evaluation?: { recordDecision: jest.Mock } } = {}) {
  let promptObservedInsidePlan: string | null = null;
  let promptObservedInsideResearch: string | null = null;

  const originalPlan = jest
    .spyOn(MeriResearchService.prototype, 'streamPlan')
    .mockImplementation(async function (this: MeriResearchService, valueCtx: TenantContext) {
      promptObservedInsidePlan = await (
        this as unknown as {
          clientContext: (innerCtx: TenantContext, clientId: string | null) => Promise<string | null>;
        }
      ).clientContext(valueCtx, 'client-1');
    });
  const originalResearch = jest
    .spyOn(MeriResearchService.prototype, 'streamResearch')
    .mockImplementation(async function (this: MeriResearchService, valueCtx: TenantContext) {
      promptObservedInsideResearch = await (
        this as unknown as {
          clientContext: (innerCtx: TenantContext, clientId: string | null) => Promise<string | null>;
        }
      ).clientContext(valueCtx, 'client-1');
    });

  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    clioResearchSession: {
      findFirst: jest.fn().mockResolvedValue({
        topic: 'RTX federal market strategy',
        clientId: 'client-1',
      }),
    },
    client: {
      findFirst: jest.fn().mockResolvedValue({
        name: 'Acme',
        description: 'Legacy client description',
        productDescription: null,
      }),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, fn: (client: typeof tx) => unknown) => fn(tx)),
    withTenantUser: jest.fn(async (_tenantId: string, _userId: string, fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const contextPlane = {
    resolveResearch: jest.fn(
      async (
        _valueCtx: TenantContext,
        input: { operationId: MeriGovernedTurnContext['operationId'] },
      ) => governed(input.operationId),
    ),
  };
  const service = createGovernedMeriResearchService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    contextPlane as never,
    opts.evaluation as never,
  );

  return {
    service,
    contextPlane,
    originalPlan,
    originalResearch,
    tx,
    get promptObservedInsidePlan() {
      return promptObservedInsidePlan;
    },
    get promptObservedInsideResearch() {
      return promptObservedInsideResearch;
    },
  };
}

describe('createGovernedMeriResearchService Phase 19', () => {
  afterEach(() => jest.restoreAllMocks());

  it('routes research planning through the meri.research Context Plane operation', async () => {
    const h = makeHarness();

    await h.service.streamPlan(ctx, 'research-1', {} as never);

    expect(h.contextPlane.resolveResearch).toHaveBeenCalledWith(ctx, {
      task: 'RTX federal market strategy',
      clientId: 'client-1',
      operationId: 'meri.research',
      sessionId: 'research-1',
    });
    expect(h.originalPlan).toHaveBeenCalled();
    expect(h.promptObservedInsidePlan).toBe('Governed prompt for meri.research');
  });

  it('routes gather and synthesis through research.generate-report', async () => {
    const h = makeHarness();

    await h.service.streamResearch(ctx, 'research-1', {} as never);

    expect(h.contextPlane.resolveResearch).toHaveBeenCalledWith(ctx, {
      task: 'RTX federal market strategy',
      clientId: 'client-1',
      operationId: 'research.generate-report',
      sessionId: 'research-1',
    });
    expect(h.originalResearch).toHaveBeenCalled();
    expect(h.promptObservedInsideResearch).toBe(
      'Governed prompt for research.generate-report',
    );
  });

  it('does not invoke the legacy client lookup inside a governed run', async () => {
    const h = makeHarness();

    await h.service.streamPlan(ctx, 'research-1', {} as never);

    expect(h.tx.client.findFirst).not.toHaveBeenCalled();
  });

  it('Phase 27F: records a real (skipped, unsupported_operation) evaluation decision for streamResearch, without affecting the real turn', async () => {
    const priorFlag = process.env.LEARNING_EVALUATION;
    process.env.LEARNING_EVALUATION = 'enabled';
    const recordDecision = jest.fn(async (_input: Record<string, unknown>) => ({ status: 'recorded' as const, id: 'eval-1' }));
    const h = makeHarness({ evaluation: { recordDecision } });

    await h.service.streamResearch(ctx, 'research-1', {} as never);
    // considerMeriResearchEvaluation is fire-and-forget — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(recordDecision).toHaveBeenCalledTimes(1);
    const call = recordDecision.mock.calls[0]?.[0] as { status: string; skipReason: string; treatmentArtifactId: string };
    expect(call.status).toBe('skipped');
    expect(call.skipReason).toBe('unsupported_operation');
    expect(call.treatmentArtifactId).toBe('research-1');
    expect(h.originalResearch).toHaveBeenCalled();
    if (priorFlag === undefined) delete process.env.LEARNING_EVALUATION;
    else process.env.LEARNING_EVALUATION = priorFlag;
  });

  it('Phase 27F: streamResearch behaves identically with no evaluation dependency provided', async () => {
    const h = makeHarness();
    await expect(h.service.streamResearch(ctx, 'research-1', {} as never)).resolves.toBeUndefined();
    expect(h.originalResearch).toHaveBeenCalled();
  });
});
