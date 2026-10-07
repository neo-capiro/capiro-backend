import { MeriResearchService } from './meri-research.service';
import {
  admitDurableResearchCoordinator,
  readDurableResearchCoordinator,
  recordDurableResearchApprovalProposal,
} from './meri-research-coordinator';
import type { ResearchPlanV1 } from './meri-research-plan';
import type { ResearchRunState } from './meri-research-run-state';

const ctx = { tenantId: 'tenant-1', userId: 'user-1', tenantSlug: 'tenant' } as never;

const plan: ResearchPlanV1 = {
  version: 1,
  title: 'Email me today’s items',
  scope: {
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    actorId: 'user-1',
    clientId: null,
    conversationId: 'conversation-1',
  },
  budget: { toolCalls: 2, tokens: 4_000 },
  steps: [
    {
      id: 'read-items',
      objective: 'Read today’s items.',
      dependsOn: [],
      requiredEvidenceDomains: ['institutional_memory'],
      allowedCapabilities: ['search_memory'],
      effect: 'read',
      completionCondition: 'Items read.',
      budget: { toolCalls: 1, tokens: 2_000 },
    },
    {
      id: 'propose-summary-email',
      objective: 'Email the summary to the requester only.',
      dependsOn: ['read-items'],
      requiredEvidenceDomains: ['institutional_memory'],
      allowedCapabilities: ['send_email'],
      effect: 'approval_required',
      completionCondition: 'A proposal exists; nothing is sent before approval.',
      budget: { toolCalls: 1, tokens: 2_000 },
    },
  ],
  clarifyingQuestions: [],
};

function metadataWithReadDone(runStatus: ResearchRunState['status']) {
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
  const admitted = admitDurableResearchCoordinator({
    metadata: { run, handoff: undefined },
    plan,
    objective: 'Email me today’s items',
    run,
  }).metadata as Record<string, any>;
  return {
    ...admitted,
    run: { ...admitted.run, status: runStatus },
    durableCoordinator: {
      ...admitted.durableCoordinator,
      steps: admitted.durableCoordinator.steps.map((step: any) =>
        step.id === 'read-items' ? { ...step, outcome: 'completed' } : step,
      ),
    },
  };
}

function fixture(options: { kind?: string; metadata: Record<string, unknown>; proposalStatus?: string }) {
  let session: Record<string, any> = {
    id: 'session-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    clientId: null,
    topic: 'Email me today’s items',
    title: plan.title,
    status: 'complete',
    kind: options.kind ?? 'research',
    goalRevision: 0,
    deliverables: null,
    plan: [],
    clarifyingQuestions: [],
    clarifyingAnswers: {},
    reportArtifactId: null,
    sources: null,
    metadata: options.metadata,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const tx: any = {
    clioResearchSession: {
      findFirst: jest.fn(async () => structuredClone(session)),
      findMany: jest.fn(async () => [structuredClone(session)]),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (JSON.stringify(where.metadata?.equals) !== JSON.stringify(session.metadata))
          return { count: 0 };
        session = { ...session, ...structuredClone(data) };
        return { count: 1 };
      }),
    },
    meriActionProposal: {
      findFirst: jest.fn(async () =>
        options.proposalStatus ? { status: options.proposalStatus } : null,
      ),
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
      anthropicToolSchemas: jest.fn(() => [
        { name: 'send_email', description: 'Send', input_schema: { type: 'object' } },
      ]),
      isConcurrencySafe: jest.fn(() => true),
      isSideEffecting: jest.fn((name: string) => name === 'send_email'),
    } as never,
    {} as never,
    {} as never,
  );
  const proposals = {
    create: jest.fn(async () => ({
      disposition: 'pending_approval',
      proposal: { proposalId: 'proposal-1' },
    })),
  };
  service.attachJobApprovalProposals(proposals as never);
  const internal = service as unknown as {
    postJobApprovalProposals: (...args: unknown[]) => Promise<unknown>;
    completeStructured: jest.Mock;
  };
  internal.completeStructured = jest.fn(async () =>
    JSON.stringify({ to: 'tester@example.com', subject: 'Today', body: 'Summary' }),
  );
  return { service, internal, proposals, getSession: () => session };
}

const auth = { run: { id: 'run-1', leaseEpoch: 1 } } as never;

describe('Release D: job approval cards', () => {
  it('posts one card for a job’s final approval step after its reads, never executing it', async () => {
    const f = fixture({ kind: 'deliverable', metadata: metadataWithReadDone('running') });
    const posted = await f.internal.postJobApprovalProposals(ctx, f.getSession(), auth, 'Report');
    expect(posted).toEqual([{ stepId: 'propose-summary-email', proposalId: 'proposal-1' }]);
    expect(f.proposals.create).toHaveBeenCalledWith(ctx, {
      tool: 'send_email',
      input: { to: 'tester@example.com', subject: 'Today', body: 'Summary' },
      surface: 'job',
      requireApproval: true,
    });
  });

  it('never posts for a plain research run', async () => {
    const f = fixture({ kind: 'research', metadata: metadataWithReadDone('running') });
    expect(await f.internal.postJobApprovalProposals(ctx, f.getSession(), auth, 'Report')).toEqual(
      [],
    );
    expect(f.internal.completeStructured).not.toHaveBeenCalled();
    expect(f.proposals.create).not.toHaveBeenCalled();
  });

  it('posts nothing when the draft is not one JSON object', async () => {
    const f = fixture({ kind: 'deliverable', metadata: metadataWithReadDone('running') });
    f.internal.completeStructured.mockResolvedValueOnce('Here is the email: {"to":"x"}');
    expect(await f.internal.postJobApprovalProposals(ctx, f.getSession(), auth, 'Report')).toEqual(
      [],
    );
    expect(f.proposals.create).not.toHaveBeenCalled();
  });

  it.each([
    ['proposed', 'waiting_for_user', 'waiting_for_approval'],
    ['succeeded', 'completed', 'completed'],
    ['dismissed', 'completed', 'cancelled'],
  ])(
    'a %s proposal reads as %s and settles the step (%s)',
    async (proposalStatus, jobStatus, stepOutcome) => {
      const recorded = recordDurableResearchApprovalProposal({
        metadata: metadataWithReadDone('complete'),
        stepId: 'propose-summary-email',
        proposalId: 'proposal-1',
      }).metadata;
      const f = fixture({ kind: 'deliverable', metadata: recorded, proposalStatus });
      const [listed] = (await f.service.listSessions(ctx)) as Array<{ job: { status: string } }>;
      expect(listed!.job.status).toBe(jobStatus);
      const stored = readDurableResearchCoordinator(f.getSession().metadata);
      expect(stored?.steps.find((step) => step.id === 'propose-summary-email')?.outcome).toBe(
        stepOutcome,
      );
    },
  );
});
