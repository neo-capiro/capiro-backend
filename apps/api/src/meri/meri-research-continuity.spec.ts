import type { TenantContext } from '@capiro/shared';
import { MERI_GOVERNMENT_AFFAIRS_OUTPUT_CONTRACT } from '@capiro/meriv2-core';
import { MeriResearchService } from './meri-research.service.js';
import { readResearchHandoff } from './meri-research-handoff.js';
import type { ResearchRuntimeAuth } from './meri-v3-research-runner.js';

jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../reviews/reviews.service.js', () => ({ ReviewsService: class {} }));
jest.mock('../engagement/ai-credential-resolver.service.js', () => ({
  AiCredentialResolverService: class {},
}));
jest.mock('./meri-v3-research-runner.js', () => ({ MeriV3ResearchRunner: class {} }));

const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as TenantContext;

function fixture() {
  let session: any;
  let allowed = true;
  let originAvailable = true;
  const conversation = {
    id: 'thread-a',
    clientId: 'client-a',
    metadata: { meriv3: { reasoningMode: 'max' } },
    summary: 'Keep the memo about enacted amounts.',
    summaryUpToMessageId: null,
  };
  const messages: any[] = [
    {
      id: 'early-user',
      role: 'user',
      clientId: 'client-a',
      body: 'Exclude forecasted opportunities.',
      metadata: {
        attachments: [{ id: 'prior-file', filename: 'brief.txt', kind: 'text', status: 'parsed' }],
      },
      createdAt: new Date('2026-09-01'),
    },
  ];
  const attachments = [
    {
      id: 'prior-file',
      messageId: 'early-user',
      filename: 'brief.txt',
      kind: 'text',
      status: 'parsed',
      textContent: 'Client has three sensor manufacturing facilities.',
      reason: null,
      mediaType: 'text/plain',
      byteSize: 50,
      data: null,
    },
  ];
  const artifacts: any[] = [];
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ allowed }]),
    tenant: { findFirst: jest.fn(async () => ({ settings: {} })) },
    client: {
      findFirst: jest.fn(async () => ({
        id: 'client-a',
        name: 'Client A',
        description: null,
        productDescription: null,
      })),
    },
    clioConversation: {
      findFirst: jest.fn(async () => (originAvailable ? conversation : null)),
      create: jest.fn(async () => ({ id: 'unexpected-backing-thread' })),
      update: jest.fn(async () => conversation),
    },
    clioMessage: {
      findFirst: jest.fn(
        async ({ where }: any) => messages.find((message) => message.id === where.id) ?? null,
      ),
      findMany: jest.fn(async () => messages.map((message) => ({ ...message }))),
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, id: `message-${messages.length}`, createdAt: new Date() };
        messages.push(row);
        return row;
      }),
    },
    clioAttachment: {
      findMany: jest.fn(async () => attachments),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    clioResearchSession: {
      findFirst: jest.fn(async ({ where }: any) =>
        session &&
        (!where.id || where.id === session.id) &&
        (!where.tenantId || where.tenantId === session.tenantId) &&
        (!where.userId || where.userId === session.userId)
          ? structuredClone(session)
          : null,
      ),
      create: jest.fn(async ({ data }: any) => {
        session = {
          ...JSON.parse(JSON.stringify(data)),
          id: 'research-a',
          plan: [],
          clarifyingQuestions: [],
          clarifyingAnswers: {},
          reportArtifactId: null,
          createdAt: new Date(),
        };
        return { ...session };
      }),
      update: jest.fn(async ({ data }: any) => {
        session = { ...session, ...JSON.parse(JSON.stringify(data)) };
        return session;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (
          !session ||
          (where.id && where.id !== session.id) ||
          (where.tenantId && where.tenantId !== session.tenantId) ||
          (where.userId && where.userId !== session.userId)
        )
          return { count: 0 };
        if (where.reportArtifactId === null && session.reportArtifactId !== null)
          return { count: 0 };
        if (typeof where.status === 'string' && where.status !== session.status)
          return { count: 0 };
        if (where.status?.in && !where.status.in.includes(session.status)) return { count: 0 };
        if (
          where.metadata &&
          'equals' in where.metadata &&
          !where.metadata.path &&
          JSON.stringify(where.metadata.equals) !== JSON.stringify(session.metadata)
        )
          return { count: 0 };
        if (
          where.metadata?.path &&
          where.metadata.path.reduce((v: any, key: string) => v?.[key], session.metadata) !==
            where.metadata.equals
        )
          return { count: 0 };
        session = { ...session, ...structuredClone(data) };
        return { count: 1 };
      }),
    },
    clioArtifact: {
      findFirst: jest.fn(async () => artifacts[0] ?? null),
      create: jest.fn(async ({ data }: any) => {
        const artifact = { ...data, id: 'artifact-a' };
        artifacts.push(artifact);
        return artifact;
      }),
    },
  };
  const prisma = {
    withTenant: async (_tenant: string, callback: (db: typeof tx) => unknown) => callback(tx),
    withTenantUser: async (_tenant: string, _user: string, callback: (db: typeof tx) => unknown) =>
      callback(tx),
  };
  const credentials = { resolveProvider: jest.fn(), resolveProviderByTenantId: jest.fn() };
  const runner = {
    enabled: jest.fn(async () => true),
    plan: jest.fn(async (_ctx: unknown, _input: unknown) =>
      JSON.stringify({
        title: 'Client briefing',
        plan: ['Review client constraints', 'Check funding status'],
        clarifyingQuestions: ['Who is the audience?'],
      }),
    ),
    run: jest.fn(async (_ctx: unknown, _input: unknown) => ({
      reportBody:
        '# Client briefing\n\nUse the existing manufacturing footprint. [S:get_research_evidence:prior-file]',
      model: 'same-chat-model',
      sources: [],
      toolsUsed: ['get_research_evidence'],
      ledgerEntries: [
        {
          tool: 'get_research_evidence',
          result: {
            records: [
              {
                id: 'prior-file',
                textContent: 'Client has three sensor manufacturing facilities.',
              },
            ],
          },
          serialized: JSON.stringify({
            records: [
              {
                id: 'prior-file',
                textContent: 'Client has three sensor manufacturing facilities.',
              },
            ],
          }),
        },
      ],
      citations: [],
    })),
  };
  const maintenance = { scheduleAfterTurnMaintenance: jest.fn() };
  const service = new MeriResearchService(
    prisma as never,
    { get: () => undefined } as never,
    {} as never,
    credentials as never,
    {} as never,
    runner as never,
    maintenance,
  );
  const events: any[] = [];
  const sse = {
    write: (data: string) => events.push(JSON.parse(data.replace(/^data: /, '').trim())),
  };
  const auth: ResearchRuntimeAuth = {
    bearerToken: 'caller-token',
    governedContext: {
      version: 1,
      operationId: 'meri.research',
      prompt: 'Governed evidence',
      contextPacket: {
        packetId: 'packet-a',
        clientId: 'client-a',
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
          targetHint: 'client-a',
          recipeTool: null,
          requireCompleteCoverage: false,
          requiredDomains: [],
          timeWindow: null,
        },
        coverage: {
          version: 1,
          complete: true,
          requestedDomains: [],
          searchedDomains: [],
          missingDomains: [],
          partialDomains: [],
          requestedEntityCount: 1,
          searchedEntityCount: 1,
          recordsEvaluated: 0,
          recordsReturned: 0,
          paginationComplete: true,
          truncated: false,
          sourceHealth: [],
          unavailableSources: [],
          toolsInvoked: [],
          stopReason: 'complete',
        },
      },
    },
  };
  return {
    service,
    runner,
    maintenance,
    credentials,
    tx,
    conversation,
    messages,
    artifacts,
    events,
    sse,
    auth,
    getSession: () => session,
    archive: () => {
      originAvailable = false;
    },
    replica: () =>
      new MeriResearchService(
        prisma as never,
        { get: () => undefined } as never,
        {} as never,
        credentials as never,
        {} as never,
        runner as never,
        maintenance,
      ),
    revoke: () => {
      allowed = false;
    },
  };
}

describe('Deep Research conversation continuity', () => {
  it('sends the same numbered source objects on completion, replay, and saved report recovery', async () => {
    const f = fixture();
    const citation = {
      n: 7,
      id: 'prior-file',
      title: 'brief.txt',
      type: 'source',
      tool: 'get_research_evidence',
      url: null,
      snippet: 'Client has three sensor manufacturing facilities.',
    };
    const original = await f.runner.run(ctx, {});
    const reconciledRetrieval = {
      ...f.auth.governedContext!.retrieval,
      coverage: {
        ...f.auth.governedContext!.retrieval.coverage,
        phase: 'completed_turn',
        searchedDomains: ['clients'],
        recordsReturned: 3,
        restoredSources: ['clients'],
      },
    };
    f.runner.run.mockResolvedValue({
      ...original,
      reportBody: '# Client briefing\n\nThree sensor facilities. [7]',
      citations: [citation],
      retrieval: reconciledRetrieval,
    } as never);
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    const completed = f.events.find((event) => event.type === 'report');
    expect(completed.body).toContain('[7]');
    expect(completed.reportMetadata.citations).toEqual([citation]);
    expect(completed.reportMetadata.reasoningMode).toBe('max');
    expect(completed.reportMetadata.retrieval).toEqual(reconciledRetrieval);
    const recovered = await f.service.getSession(ctx, 'research-a');
    expect(recovered.reportMetadata).toEqual(completed.reportMetadata);
    const callCount = f.runner.run.mock.calls.length;
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    const replayed = f.events.filter((event) => event.type === 'report').at(-1);
    expect(replayed.reportMetadata).toEqual(completed.reportMetadata);
    expect(replayed.messageId).toBe(completed.messageId);
    expect(f.runner.run).toHaveBeenCalledTimes(callCount);
  });

  it('carries stored context/evidence/effort into both phases and saves the completed report in its originating thread', async () => {
    const f = fixture();
    await f.service.createSession(ctx, {
      topic: 'Write the client briefing',
      conversationId: 'thread-a',
    });
    // Changing live history after creation cannot change the captured handoff.
    f.messages[0].body = 'Later edited instruction';
    await f.service.streamPlan(ctx, 'research-a', f.sse, f.auth);
    const planMessage = f.messages.find((message) => message.role === 'assistant');
    expect(f.events).toContainEqual({ type: 'done', messageId: planMessage.id });
    await f.service.answerClarifications(ctx, 'research-a', { '0': 'The CEO' });
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    const planInput = f.runner.plan.mock.calls[0]?.[1] as any;
    const runInput = f.runner.run.mock.calls[0]?.[1] as any;
    expect(planInput.user).toContain('Exclude forecasted opportunities');
    expect(runInput.user).toContain('prior-file');
    expect(runInput.user).not.toContain('Client has three sensor manufacturing facilities');
    expect(runInput.user).toContain('call get_research_evidence for this session');
    expect(runInput.user).toContain('The CEO');
    expect(runInput.user).toContain('Research sessionId: research-a');
    expect(runInput.handoff.reasoningMode).toBe('max');
    // The shared V3 chat runtime supplies the answer contract once in its
    // cached base; the report addendum preserves report-specific instructions.
    expect(runInput.system).not.toContain(MERI_GOVERNMENT_AFFAIRS_OUTPUT_CONTRACT);
    expect(runInput.system).toContain('REPORT REQUIREMENTS:');
    expect(f.credentials.resolveProviderByTenantId).not.toHaveBeenCalled();
    expect(f.tx.clioConversation.create).not.toHaveBeenCalled();
    expect(f.artifacts[0]).toMatchObject({ conversationId: 'thread-a', kind: 'research_report' });
    const reportMessage = f.messages.find((message) => message.metadata?.researchReport);
    expect(reportMessage.conversationId).toBe('thread-a');
    expect(reportMessage.body).toContain('[S:get_research_evidence:prior-file]');
    expect(f.artifacts[0].messageId).toBe(reportMessage.id);
    expect(f.getSession().status).toBe('complete');
    expect(readResearchHandoff(f.getSession().metadata)?.messages[0]?.body).toContain(
      'Exclude forecasted opportunities',
    );
    expect(
      f.events.some(
        (event) =>
          event.type === 'report' &&
          event.artifactId === 'artifact-a' &&
          event.messageId === reportMessage.id,
      ),
    ).toBe(true);
    expect(f.maintenance.scheduleAfterTurnMaintenance).toHaveBeenCalledWith(ctx, 'thread-a');
    expect(f.tx.clioConversation.update).toHaveBeenCalledTimes(2);
  });

  it('does not mark a failed V3 run complete or switch provider', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    f.runner.run.mockRejectedValue(new Error('V3 provider unavailable'));
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(f.artifacts).toHaveLength(0);
    expect(f.getSession().status).toBe('failed');
    expect(f.events).toContainEqual({ type: 'error', message: 'V3 provider unavailable' });
    expect(f.events.at(-1)).toEqual({ type: 'done' });
    expect(f.credentials.resolveProvider).not.toHaveBeenCalled();
  });

  it('does not substitute a successful deterministic plan for a failed V3 plan', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    f.runner.plan.mockRejectedValue(new Error('V3 provider unavailable'));
    await f.service.streamPlan(ctx, 'research-a', f.sse, f.auth);
    expect(f.getSession().status).toBe('failed');
    expect(f.events.some((event) => event.type === 'plan')).toBe(false);
    expect(f.events).toContainEqual({ type: 'error', message: 'V3 provider unavailable' });
    expect(f.credentials.resolveProviderByTenantId).not.toHaveBeenCalled();
  });

  it('honors a wall revoked after handoff and before research starts', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    f.revoke();
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(f.runner.run).not.toHaveBeenCalled();
    expect(f.artifacts).toHaveLength(0);
    expect(f.events.some((event) => event.type === 'error')).toBe(true);
  });

  it('delivers an already persisted report even if conversation maintenance cannot be scheduled', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    f.maintenance.scheduleAfterTurnMaintenance.mockImplementation(() => {
      throw new Error('Scheduler unavailable');
    });
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(f.getSession().status).toBe('complete');
    expect(f.artifacts).toHaveLength(1);
    expect(f.events.some((event) => event.type === 'report')).toBe(true);
  });

  it('does not manufacture a tool evidence ledger from the attachment prompt snapshot', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    const result = {
      reportBody: 'Client context [S:get_research_evidence:prior-file]',
      model: 'same-chat-model',
      sources: [],
      toolsUsed: [],
      ledgerEntries: [],
      citations: [],
    };
    f.runner.run.mockResolvedValue(result);
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(result.ledgerEntries).toHaveLength(0);
    expect(f.artifacts[0].bodyText).not.toContain('[S:get_research_evidence:prior-file]');
  });
});

describe('Durable research lease and recovery', () => {
  function gate<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('admits only one claimant across API replicas and replays its canonical saved report', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    const ready = gate<void>();
    const release = gate<void>();
    const result = await f.runner.run(ctx, {});
    f.runner.run.mockClear();
    f.runner.run.mockImplementation(async () => {
      ready.resolve();
      await release.promise;
      return result;
    });
    const first = f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    await ready.promise;
    await f.replica().streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(f.runner.run).toHaveBeenCalledTimes(1);
    expect(f.artifacts).toHaveLength(0);
    release.resolve();
    await first;
    await f.replica().streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(f.runner.run).toHaveBeenCalledTimes(1);
    expect(f.artifacts).toHaveLength(1);
    expect(f.events.filter((event) => event.type === 'report')).toHaveLength(2);
    expect(
      f.events.filter((event) => event.type === 'report').map((event) => event.messageId),
    ).toEqual([f.getSession().metadata.reportMessageId, f.getSession().metadata.reportMessageId]);
  });

  it('racing initial compare-and-swap calls admit exactly one provider execution', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    await Promise.all([
      f.service.streamResearch(ctx, 'research-a', f.sse, f.auth),
      f.replica().streamResearch(ctx, 'research-a', f.sse, f.auth),
    ]);
    expect(f.runner.run).toHaveBeenCalledTimes(1);
    expect(f.artifacts).toHaveLength(1);
  });

  it('blocks a cancelled owner from saving even when cancellation lands on another replica', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    const ready = gate<void>();
    const release = gate<void>();
    const result = await f.runner.run(ctx, {});
    f.runner.run.mockClear();
    f.runner.run.mockImplementation(async () => {
      ready.resolve();
      await release.promise;
      return result;
    });
    const first = f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    await ready.promise;
    const runId = f.getSession().metadata.run.id;
    await f.replica().cancelRun(ctx, 'research-a');
    await expect(f.service.assertRunActive(ctx, 'research-a', runId)).rejects.toThrow(
      'no longer running',
    );
    release.resolve();
    await first;
    expect(f.artifacts).toHaveLength(0);
    expect(f.getSession().metadata.run.status).toBe('cancelled');
  });

  it('lets a new authenticated attempt recover a stale lease while fencing the abandoned owner', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    const ready = gate<void>();
    const release = gate<void>();
    const result = await f.runner.run(ctx, {});
    f.runner.run.mockClear();
    f.runner.run.mockImplementationOnce(async () => {
      ready.resolve();
      await release.promise;
      return result;
    });
    const old = f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    await ready.promise;
    f.getSession().metadata.run.heartbeatAt = new Date(Date.now() - 180_000).toISOString();
    expect((await f.service.getSession(ctx, 'research-a')).run?.status).toBe('interrupted');
    await f.replica().streamResearch(ctx, 'research-a', f.sse, {
      ...f.auth,
      resumeRunId: f.getSession().metadata.run.id,
    });
    release.resolve();
    await old;
    expect(f.artifacts).toHaveLength(1);
    expect(f.getSession().metadata.run.status).toBe('complete');
    expect(f.runner.run).toHaveBeenCalledTimes(2);
    const recovered = f.runner.run.mock.calls[1]?.[1] as any;
    expect(recovered.handoff.attachments[0].id).toBe('prior-file');
    expect(recovered.handoff.messages[0].body).toContain('Exclude forecasted');
  });

  it.each(['revoke', 'archive'] as const)(
    'rechecks access after planning when the origin changes: %s',
    async (change) => {
      const f = fixture();
      await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
      const proposal = await f.runner.plan(ctx, {});
      f.runner.plan.mockImplementation(async () => {
        f[change]();
        return proposal;
      });
      await f.service.streamPlan(ctx, 'research-a', f.sse, f.auth);
      expect(f.messages.filter((message) => message.role === 'assistant')).toHaveLength(0);
      expect(f.events.some((event) => event.type === 'plan')).toBe(false);
    },
  );

  it('detaches broken SSE transport while persisting the result for an authorized reload', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    await f.service.streamResearch(
      ctx,
      'research-a',
      {
        write: () => {
          throw new Error('socket closed');
        },
      },
      f.auth,
    );
    expect(f.artifacts).toHaveLength(1);
    expect((await f.service.getSession(ctx, 'research-a')).report?.bodyText).toContain(
      'manufacturing footprint',
    );
  });

  it('keeps incomplete provider output partial and never labels it as a completed report', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    f.runner.run.mockRejectedValue(new Error('Research did not complete (max_output_tokens).'));
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(f.getSession().metadata.run.status).toBe('partial');
    expect(f.artifacts).toHaveLength(0);
    expect(f.events.some((event) => event.type === 'report')).toBe(false);
  });

  it('releases an approved artifact using its canonical review state during reload and export', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    f.getSession().metadata.heldForReview = true;
    f.artifacts[0].metadata.heldForReview = true;
    expect((await f.service.getSession(ctx, 'research-a')).report?.bodyText).toContain(
      'held for review',
    );
    await expect(f.service.getReportMarkdown(ctx, 'research-a')).rejects.toThrow('held for review');
    f.artifacts[0].metadata.heldForReview = false;
    expect((await f.service.getSession(ctx, 'research-a')).report?.bodyText).toContain(
      'manufacturing footprint',
    );
    expect((await f.service.getReportMarkdown(ctx, 'research-a')).markdown).toContain(
      'manufacturing footprint',
    );
  });

  it('prevents two clarification submissions from creating duplicate persisted messages', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    await f.service.streamPlan(ctx, 'research-a', f.sse, f.auth);
    await Promise.allSettled([
      f.service.answerClarifications(ctx, 'research-a', { '0': 'CEO' }),
      f.replica().answerClarifications(ctx, 'research-a', { '0': 'CEO' }),
    ]);
    expect(
      f.messages.filter((message) => message.body.startsWith('Research clarification answers')),
    ).toHaveLength(1);
  });
  it('does not expose a run to another user or tenant', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    const id = f.getSession().metadata.run.id;
    await expect(
      f.service.assertRunActive({ ...ctx, userId: 'other-user' }, 'research-a', id),
    ).rejects.toThrow('not found');
    await expect(
      f.service.getSession({ ...ctx, tenantId: 'other-tenant' }, 'research-a'),
    ).rejects.toThrow('not found');
  });

  it('persists the accepted topic and answers before either provider phase starts', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    expect((await f.service.getSession(ctx, 'research-a')).run).toMatchObject({
      phase: 'plan',
      status: 'interrupted',
      stage: 'Research request saved; planning has not started',
    });
    expect(f.runner.plan).not.toHaveBeenCalled();
    await f.service.streamPlan(ctx, 'research-a', f.sse, f.auth);
    await f.service.answerClarifications(ctx, 'research-a', { '0': 'CEO' });
    expect((await f.service.getSession(ctx, 'research-a')).run).toMatchObject({
      phase: 'research',
      status: 'interrupted',
      stage: 'Clarifications saved; research has not started',
    });
    expect(f.runner.run).not.toHaveBeenCalled();
  });

  it('records a heartbeat outage as interrupted, without claiming the user pressed Stop', async () => {
    jest.useFakeTimers();
    try {
      const f = fixture();
      await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
      const ready = gate<void>();
      f.runner.run.mockImplementation((async (
        _ctx: unknown,
        _input: unknown,
        auth: ResearchRuntimeAuth,
      ) => {
        ready.resolve();
        await new Promise<void>((resolve) =>
          auth.signal!.addEventListener('abort', () => resolve(), { once: true }),
        );
        throw auth.signal!.reason;
      }) as any);
      const running = f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
      await ready.promise;
      f.tx.clioResearchSession.findFirst.mockRejectedValueOnce(
        new Error('Database heartbeat unavailable'),
      );
      await jest.advanceTimersByTimeAsync(10_000);
      await running;
      expect(f.getSession().metadata.run).toMatchObject({
        status: 'interrupted',
        failureReason: 'The worker could not confirm its research lease.',
      });
      expect(f.artifacts).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });
  it('does not restart a cancelled saved request from an older POST that finishes setup late', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    const savedId = f.getSession().metadata.run.id;
    await f.service.cancelRun(ctx, 'research-a');
    await f.service.streamPlan(ctx, 'research-a', f.sse, f.auth);
    expect(f.runner.plan).not.toHaveBeenCalled();
    expect(f.getSession().metadata.run.status).toBe('cancelled');
    await f.service.streamPlan(ctx, 'research-a', f.sse, { ...f.auth, resumeRunId: savedId });
    expect(f.runner.plan).toHaveBeenCalledTimes(1);
    expect(f.getSession().metadata.run.status).toBe('awaiting_clarification');
  });
});
