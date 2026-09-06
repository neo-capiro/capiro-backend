import type { TenantContext } from '@capiro/shared';
import { MeriResearchService } from './meri-research.service.js';
import { readResearchHandoff } from './meri-research-handoff.js';
import type { ResearchRuntimeAuth } from './meri-v3-research-runner.js';

jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../reviews/reviews.service.js', () => ({ ReviewsService: class {} }));
jest.mock('../engagement/ai-credential-resolver.service.js', () => ({ AiCredentialResolverService: class {} }));
jest.mock('./meri-v3-research-runner.js', () => ({ MeriV3ResearchRunner: class {} }));

const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as TenantContext;

function fixture() {
  let session: any;
  let allowed = true;
  const conversation = { id: 'thread-a', clientId: 'client-a', metadata: { meriv3: { reasoningMode: 'max' } }, summary: 'Keep the memo about enacted amounts.', summaryUpToMessageId: null };
  const messages: any[] = [{ id: 'early-user', role: 'user', clientId: 'client-a', body: 'Exclude forecasted opportunities.', metadata: { attachments: [{ id: 'prior-file', filename: 'brief.txt', kind: 'text', status: 'parsed' }] }, createdAt: new Date('2026-09-01') }];
  const attachments = [{ id: 'prior-file', messageId: 'early-user', filename: 'brief.txt', kind: 'text', status: 'parsed', textContent: 'Client has three sensor manufacturing facilities.', reason: null, mediaType: 'text/plain', byteSize: 50, data: null }];
  const artifacts: any[] = [];
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ allowed }]),
    tenant: { findFirst: jest.fn(async () => ({ settings: {} })) },
    client: { findFirst: jest.fn(async () => ({ id: 'client-a', name: 'Client A', description: null, productDescription: null })) },
    clioConversation: {
      findFirst: jest.fn(async () => conversation),
      create: jest.fn(async () => ({ id: 'unexpected-backing-thread' })),
      update: jest.fn(async () => conversation),
    },
    clioMessage: {
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
      findFirst: jest.fn(async () => session),
      create: jest.fn(async ({ data }: any) => {
        session = { ...JSON.parse(JSON.stringify(data)), id: 'research-a', plan: [], clarifyingQuestions: [], clarifyingAnswers: {}, reportArtifactId: null, createdAt: new Date() };
        return { ...session };
      }),
      update: jest.fn(async ({ data }: any) => {
        session = { ...session, ...JSON.parse(JSON.stringify(data)) };
        return session;
      }),
      updateMany: jest.fn(async ({ data }: any) => {
        if (session?.status !== 'complete') session = { ...session, ...data };
        return { count: 1 };
      }),
    },
    clioArtifact: {
      create: jest.fn(async ({ data }: any) => {
        const artifact = { ...data, id: 'artifact-a' };
        artifacts.push(artifact);
        return artifact;
      }),
    },
  };
  const prisma = {
    withTenant: async (_tenant: string, callback: (db: typeof tx) => unknown) => callback(tx),
    withTenantUser: async (_tenant: string, _user: string, callback: (db: typeof tx) => unknown) => callback(tx),
  };
  const credentials = { resolveProvider: jest.fn(), resolveProviderByTenantId: jest.fn() };
  const runner = {
    enabled: jest.fn(async () => true),
    plan: jest.fn(async (_ctx: unknown, _input: unknown) => JSON.stringify({ title: 'Client briefing', plan: ['Review client constraints', 'Check funding status'], clarifyingQuestions: ['Who is the audience?'] })),
    run: jest.fn(async (_ctx: unknown, _input: unknown) => ({ reportBody: '# Client briefing\n\nUse the existing manufacturing footprint. [S:get_research_evidence:prior-file]', model: 'same-chat-model', sources: [], toolsUsed: ['get_research_evidence'], ledgerEntries: [{ tool: 'get_research_evidence', result: { records: [{ id: 'prior-file', textContent: 'Client has three sensor manufacturing facilities.' }] }, serialized: JSON.stringify({ records: [{ id: 'prior-file', textContent: 'Client has three sensor manufacturing facilities.' }] }) }], citations: [] })),
  };
  const maintenance = { scheduleAfterTurnMaintenance: jest.fn() };
  const service = new MeriResearchService(prisma as never, { get: () => undefined } as never, {} as never, credentials as never, {} as never, runner as never, maintenance);
  const events: any[] = [];
  const sse = { write: (data: string) => events.push(JSON.parse(data.replace(/^data: /, '').trim())) };
  const auth = { bearerToken: 'caller-token', governedContext: { prompt: 'Governed evidence' } } as ResearchRuntimeAuth;
  return { service, runner, maintenance, credentials, tx, conversation, messages, artifacts, events, sse, auth, getSession: () => session, revoke: () => { allowed = false; } };
}

describe('Deep Research conversation continuity', () => {
  it('carries stored context/evidence/effort into both phases and saves the completed report in its originating thread', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Write the client briefing', conversationId: 'thread-a' });
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
    expect(runInput.user).toContain('three sensor manufacturing facilities');
    expect(runInput.user).toContain('The CEO');
    expect(runInput.user).toContain('Research sessionId: research-a');
    expect(runInput.handoff.reasoningMode).toBe('max');
    expect(f.credentials.resolveProviderByTenantId).not.toHaveBeenCalled();
    expect(f.tx.clioConversation.create).not.toHaveBeenCalled();
    expect(f.artifacts[0]).toMatchObject({ conversationId: 'thread-a', kind: 'research_report' });
    const reportMessage = f.messages.find((message) => message.metadata?.researchReport);
    expect(reportMessage.conversationId).toBe('thread-a');
    expect(reportMessage.body).toContain('[S:get_research_evidence:prior-file]');
    expect(f.artifacts[0].messageId).toBe(reportMessage.id);
    expect(f.getSession().status).toBe('complete');
    expect(readResearchHandoff(f.getSession().metadata)?.messages[0]?.body).toContain('Exclude forecasted opportunities');
    expect(f.events.some((event) => event.type === 'report' && event.artifactId === 'artifact-a' && event.messageId === reportMessage.id)).toBe(true);
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
    f.maintenance.scheduleAfterTurnMaintenance.mockImplementation(() => { throw new Error('Scheduler unavailable'); });
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(f.getSession().status).toBe('complete');
    expect(f.artifacts).toHaveLength(1);
    expect(f.events.some((event) => event.type === 'report')).toBe(true);
  });

  it('does not manufacture a tool evidence ledger from the attachment prompt snapshot', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    const result = { reportBody: 'Client context [S:get_research_evidence:prior-file]', model: 'same-chat-model', sources: [], toolsUsed: [], ledgerEntries: [], citations: [] };
    f.runner.run.mockResolvedValue(result);
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(result.ledgerEntries).toHaveLength(0);
    expect(f.artifacts[0].bodyText).not.toContain('[S:get_research_evidence:prior-file]');
  });
});
