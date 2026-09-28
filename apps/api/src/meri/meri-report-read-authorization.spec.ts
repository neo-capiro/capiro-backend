import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service';
import {
  RESEARCH_REPORT_BODY_WITHHELD,
  assertCurrentResearchReportSourcesAuthorized,
} from './meri-research-replay-authorization';
import { researchToolVersion, sealDurableResearchResult } from './meri-research-durable-result';

const ctx = { tenantId: 'tenant-1', userId: 'user-1', tenantSlug: 'tenant' } as TenantContext;
const marker = 'REVOKED_MEMORY_REPORT_BODY';
const schema = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
};

function memory(body = 'authorized memory', version = 'v1') {
  const hash = `hash-${body}`;
  return {
    tool: 'search_memory',
    contentStatus: 'available',
    results: [{ id: 'memory-1' }],
    records: [
      {
        recordId: 'memory-1',
        updatedAt: '2026-09-28T00:00:00.000Z',
        provenance: { sourceVersion: version, contentHash: hash },
        payload: { clientId: null, content: { hash }, value: body },
      },
    ],
  };
}

function harness(options: {
  revoked?: boolean;
  changed?: boolean;
  proof?: boolean;
  toolsUsed?: readonly string[];
  summary?: string | null;
} = {}) {
  const savedResult = memory();
  const sealed = sealDurableResearchResult({
    executionId: 'execution-1',
    providerCallId: 'provider-1',
    runId: 'run-1',
    leaseEpoch: 1,
    tool: 'search_memory',
    toolVersion: researchToolVersion(schema),
    classifier: 'complete',
    input: { query: 'owner query' },
    result: savedResult,
    completedAt: '2026-09-28T00:00:00.000Z',
  });
  const receipt = {
    version: 2,
    receiptId: 'receipt-1',
    runId: 'run-1',
    leaseEpoch: 1,
    sequence: 1,
    effectClass: 'safe_read',
    toolCallId: 'provider-1',
    tool: 'search_memory',
    label: 'Search memory',
    status: 'complete',
    summary: 'Authorized read completed',
    completedAt: '2026-09-28T00:00:00.000Z',
    executionId: 'execution-1',
    providerCallId: 'provider-1',
    toolVersion: sealed.envelope.toolVersion,
    inputSha256: sealed.envelope.inputSha256,
    resultSha256: sealed.envelope.resultSha256,
    resultBodySha256: sealed.bodySha256,
    resultRef: 'safe-result-1',
    resultByteSize: sealed.byteSize,
    classifier: 'complete',
  };
  const session = {
    id: 'session-1',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    reportArtifactId: 'report-1',
    metadata: {
      handoff: {
        version: 1,
        capturedAt: '2026-09-28T00:00:00.000Z',
        conversationId: 'conversation-1',
        clientId: null,
        reasoningMode: 'deep',
        requestedDeliverable: 'Report',
        summary: null,
        summaryUpToMessageId: null,
        messages: [],
        attachments: [],
      },
      run: {
        id: 'run-1',
        leaseEpoch: 1,
        eventSequence: 1,
        phase: 'research',
        status: 'complete',
        stage: 'Report saved',
        startedAt: '2026-09-28T00:00:00.000Z',
        heartbeatAt: '2026-09-28T00:01:00.000Z',
        finishedAt: '2026-09-28T00:01:00.000Z',
      },
      durableStepReceipts: options.proof === false ? [] : [receipt],
    },
  };
  const report = {
    id: 'report-1',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    conversationId: 'conversation-1',
    messageId: 'report-message-1',
    kind: 'research_report',
    title: 'Research report',
    bodyText: marker,
    metadata: {
      researchSessionId: session.id,
      toolsUsed: options.toolsUsed ?? ['search_memory'],
    },
    createdAt: new Date('2026-09-28T00:01:00.000Z'),
  };
  const ordinary = {
    id: 'ordinary-1',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    conversationId: 'conversation-1',
    messageId: 'report-message-1',
    kind: 'artifact_internal_brief',
    title: 'Ordinary artifact',
    bodyText: 'ORDINARY_ARTIFACT_BODY',
    metadata: { version: 1 },
    createdAt: new Date('2026-09-28T00:01:00.000Z'),
  };
  const safeResult = {
    id: 'safe-result-1',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    conversationId: 'conversation-1',
    kind: 'internal_research_safe_read_result',
    bodyText: sealed.body,
    metadata: { serverOnly: true },
  };
  const reportMessage: any = {
    id: 'report-message-1',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    conversationId: 'conversation-1',
    role: 'assistant',
    body: marker,
    metadata: { researchSessionId: session.id, researchReport: true },
    artifacts: [report, ordinary],
    createdAt: new Date('2026-09-28T00:01:00.000Z'),
  };
  const conversation = {
    id: 'conversation-1',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clientId: null,
    archivedAt: null,
    summary: options.summary ?? null,
    messages: [reportMessage],
    artifacts: [report, ordinary],
  };
  const artifacts = new Map<string, typeof report | typeof ordinary | typeof safeResult>([
    [report.id, report],
    [ordinary.id, ordinary],
    [safeResult.id, safeResult],
  ]);
  const tx = {
    clioResearchSession: { findFirst: jest.fn(async () => session) },
    clioConversation: {
      findFirst: jest.fn(async () => conversation),
      findMany: jest.fn(async () => [conversation]),
    },
    clioMessage: { findMany: jest.fn(async () => [reportMessage]) },
    clioArtifact: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => artifacts.get(where.id) ?? null),
      findMany: jest.fn(async () => [report]),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (value: typeof tx) => unknown) => callback(tx)),
  };
  const execute = jest.fn(async () => {
    if (options.revoked) throw new Error('canonical owner revoked memory');
    return options.changed ? memory('corrected memory', 'v2') : savedResult;
  });
  const service = Object.assign(Object.create(MeriService.prototype), {
    prisma,
    tools: { execute },
  }) as MeriService;
  return { service, prisma, tx, execute, reportMessage, report, ordinary, conversation, session };
}

describe('ordinary research report read authorization', () => {
  it('withholds revoked report transcript, linked artifact, preview, and conversation artifact after a current owner check', async () => {
    const h = harness({ revoked: true });

    const messages = await h.service.listMessages(ctx, 'conversation-1');
    const conversations = await h.service.listConversations(ctx);
    const publicJson = JSON.stringify({ messages, conversations });

    expect(publicJson).not.toContain(marker);
    expect(messages[0]!.body).toBe(RESEARCH_REPORT_BODY_WITHHELD);
    expect(messages[0]!.artifacts[0]!.bodyText).toBe(RESEARCH_REPORT_BODY_WITHHELD);
    expect(conversations[0]!.latestMessage!.body).toBe(RESEARCH_REPORT_BODY_WITHHELD);
    expect(conversations[0]!.artifacts[0]!.bodyText).toBe(RESEARCH_REPORT_BODY_WITHHELD);
    expect(messages[0]!.metadata).toMatchObject({
      researchSessionId: 'session-1',
      reportBodyAccess: {
        status: 'withheld',
        recovery: 'research_session',
        researchSessionId: 'session-1',
      },
    });
    expect(h.execute.mock.calls.length).toBeGreaterThan(0);
  });

  it('preserves an authorized ordinary transcript and unrelated artifacts', async () => {
    const h = harness();

    const messages = await h.service.listMessages(ctx, 'conversation-1');
    const conversations = await h.service.listConversations(ctx);

    expect(messages[0]!.body).toBe(marker);
    expect(messages[0]!.artifacts[0]!.bodyText).toBe(marker);
    expect(messages[0]!.artifacts[1]!.bodyText).toBe('ORDINARY_ARTIFACT_BODY');
    expect(conversations[0]!.latestMessage!.body).toBe(marker);
    expect(conversations[0]!.artifacts[1]!.bodyText).toBe('ORDINARY_ARTIFACT_BODY');
    expect(h.execute.mock.calls.length).toBeGreaterThan(0);
  });

  it.each([
    ['absent proof', { proof: false }],
    ['unsupported source without a receipt', { proof: false, toolsUsed: ['search_emails'] }],
    ['changed source version', { changed: true }],
  ] as const)('fails closed with recovery metadata for %s', async (_label, options) => {
    const h = harness(options);

    const messages = await h.service.listMessages(ctx, 'conversation-1');

    expect(JSON.stringify(messages)).not.toContain(marker);
    expect(messages[0]!.body).toBe(RESEARCH_REPORT_BODY_WITHHELD);
    expect(messages[0]!.metadata).toMatchObject({
      researchSessionId: 'session-1',
      reportBodyAccess: { reason: 'current_source_authorization_unavailable' },
    });
    if ('changed' in options) expect(h.execute).toHaveBeenCalled();
  });

  it('reauthorizes evidence from the report current run instead of treating it as publication-only', async () => {
    const h = harness({ revoked: true });

    await expect(
      assertCurrentResearchReportSourcesAuthorized({
        prisma: h.prisma as never,
        tools: { execute: h.execute } as never,
        ctx,
        scope: { sessionId: 'session-1', toolsUsed: ['search_memory'] },
      }),
    ).rejects.toThrow('no longer authorized');
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it('withholds alternate assistant references and report-derived summaries by structured session identity', async () => {
    const h = harness({ revoked: true, summary: `Summary: ${marker}` });
    h.reportMessage.metadata = {
      researchSessionId: 'session-1',
      trustSteps: [
        {
          tool: 'search_memory',
          label: 'Memory',
          detail: marker,
          count: 1,
          status: 'done',
        },
      ],
      nested: { body: marker },
    };

    const messages = await h.service.listMessages(ctx, 'conversation-1');
    const conversations = await h.service.listConversations(ctx);

    expect(messages[0]!.body).toBe(RESEARCH_REPORT_BODY_WITHHELD);
    expect(conversations[0]!.summary).toBeNull();
    expect(JSON.stringify({ messages, conversations })).not.toContain(marker);
    expect(messages[0]!.metadata).toMatchObject({
      researchSessionId: 'session-1',
      trustSteps: [{ tool: 'search_memory', label: 'Memory', count: 1, status: 'done' }],
      reportBodyAccess: { recovery: 'research_session' },
    });
  });

  it('keeps a non-report user handoff message with a research session identity unchanged', async () => {
    const h = harness({ revoked: true });
    h.reportMessage.role = 'user';
    h.reportMessage.body = 'ordinary research request';
    h.reportMessage.metadata = { researchSessionId: 'session-1' };
    h.reportMessage.artifacts = [h.ordinary];

    const messages = await h.service.listMessages(ctx, 'conversation-1');

    expect(messages[0]!.body).toBe('ordinary research request');
    expect(messages[0]!.metadata).toEqual({ researchSessionId: 'session-1' });
  });
});
