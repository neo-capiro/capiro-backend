import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service';
import {
  RESEARCH_REPORT_BODY_WITHHELD,
  assertCurrentResearchReportSourcesAuthorized,
} from './meri-research-replay-authorization';
import {
  researchJsonSha256,
  researchToolVersion,
  sealDurableResearchResult,
} from './meri-research-durable-result';
import {
  buildResearchReportProvenance,
  certifyResearchProducerInputs,
} from './meri-report-provenance';

const ctx = { tenantId: 'tenant-1', userId: 'user-1', tenantSlug: 'tenant' } as TenantContext;
const marker = 'REVOKED_MEMORY_REPORT_BODY';
const GOVERNED_CONTACT_ID = '88888888-8888-4888-8888-888888888888';
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
  reportArtifactInSummary?: boolean;
  governed?: { contactChanged?: boolean; manifestTampered?: boolean };
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
  if (options.proof !== false && (options.toolsUsed ?? ['search_memory']).every((tool) => tool === 'search_memory')) {
    const producerInput = certifyResearchProducerInputs({
      hashMaterial: { body: report.bodyText },
      toolsUsed: [...(options.toolsUsed ?? ['search_memory'])],
      clientContext: null,
      handoffSummaryPresent: false,
      handoffAttachmentCount: 0,
      assistantHandoffTurns: 0,
      inheritedCitationCount: 0,
      inheritedUnavailableCount: 0,
      inheritedOmittedCount: 0,
      contextPacketItemCount: 0,
      unreceiptedLedgerEntryCount: 0,
    });
    const governedManifest = {
      version: 1,
      packet: null,
      records: [
        {
          domain: 'contacts',
          id: GOVERNED_CONTACT_ID,
          updatedAt: '2026-09-28T00:00:00.000Z',
          versionSha256: null,
        },
      ],
      attachments: [],
      publicToolResults: [],
      failedToolResults: 0,
    };
    const reportProvenance = buildResearchReportProvenance({
      artifactId: report.id,
      messageId: report.messageId,
      sessionId: session.id,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      clientId: null,
      conversationId: 'conversation-1',
      runId: 'run-1',
      leaseEpoch: 1,
      body: report.bodyText,
      receipts: [receipt as never],
      toolsUsed: [...(options.toolsUsed ?? ['search_memory'])],
      producerInputSha256: producerInput.producerInputSha256,
      producerInputMode: options.governed
        ? 'governed_inputs'
        : (producerInput.producerInputMode as 'covered_inputs'),
      clientContextSha256: producerInput.clientContextSha256,
      ...(options.governed
        ? { producerInputManifestSha256: researchJsonSha256(governedManifest) }
        : {}),
    });
    Object.assign(report.metadata, { reportProvenance });
    Object.assign(session.metadata, {
      reportProvenance,
      ...(options.governed
        ? {
            producerInputManifest: options.governed.manifestTampered
              ? { ...governedManifest, failedToolResults: 1 }
              : governedManifest,
          }
        : {}),
    });
  }
  const tx = {
    clioResearchSession: { findFirst: jest.fn(async () => session) },
    clioConversation: {
      findFirst: jest.fn(async () => conversation),
      findMany: jest.fn(async () => [conversation]),
    },
    clioMessage: { findMany: jest.fn(async () => [reportMessage]) },
    $executeRaw: jest.fn(async () => 1),
    engagementContact: {
      findFirst: jest.fn(async () => ({
        clientId: null,
        updatedAt: new Date(
          options.governed?.contactChanged
            ? '2026-09-29T00:00:00.000Z'
            : '2026-09-28T00:00:00.000Z',
        ),
      })),
    },
    clioArtifact: {
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => artifacts.get(where.id) ?? null),
      findMany: jest.fn(async () => options.reportArtifactInSummary === false ? [] : [report]),
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

  it('releases a governed report while every pinned producer input is current', async () => {
    const h = harness({ governed: {} });

    const messages = await h.service.listMessages(ctx, 'conversation-1');

    expect(messages[0]!.body).toBe(marker);
    expect(h.tx.engagementContact.findFirst).toHaveBeenCalled();
  });

  it.each([
    ['a pinned producer input changed', { contactChanged: true }],
    ['the private manifest no longer matches the report provenance', { manifestTampered: true }],
  ] as const)('withholds a governed report when %s', async (_label, governed) => {
    const h = harness({ governed });

    const messages = await h.service.listMessages(ctx, 'conversation-1');

    expect(JSON.stringify(messages)).not.toContain(marker);
    expect(messages[0]!.body).toBe(RESEARCH_REPORT_BODY_WITHHELD);
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
        scope: { sessionId: 'session-1', reportArtifactId: 'report-1' },
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
      trustSteps: [{ tool: 'search_memory', count: 1, status: 'done' }],
      reportBodyAccess: { recovery: 'research_session' },
    });
  });

  it('gates metadata-only linked report summaries without depending on artifact discovery', async () => {
    const revoked = harness({
      revoked: true,
      summary: `Summary: ${marker}`,
      reportArtifactInSummary: false,
    });
    const allowed = harness({ summary: `Summary: ${marker}`, reportArtifactInSummary: false });

    const revokedList = await revoked.service.listConversations(ctx);
    const allowedList = await allowed.service.listConversations(ctx);

    expect(revokedList[0]!.summary).toBeNull();
    expect(allowedList[0]!.summary).toBe(`Summary: ${marker}`);
    expect(revoked.execute).toHaveBeenCalled();
    expect(allowed.execute).toHaveBeenCalled();
  });

  it('drops untrusted primitive strings from withheld structural metadata', async () => {
    const h = harness({ revoked: true });
    h.reportMessage.metadata = {
      researchSessionId: 'session-1',
      researchReport: true,
      intent: marker,
      trustSteps: [{ tool: 'private_source_detail', label: marker, count: 1, status: 'done' }],
    };

    const messages = await h.service.listMessages(ctx, 'conversation-1');

    expect(JSON.stringify(messages)).not.toContain(marker);
    expect(JSON.stringify(messages)).not.toContain('private_source_detail');
    expect(messages[0]!.metadata).toMatchObject({
      researchSessionId: 'session-1',
      trustSteps: [{ count: 1, status: 'done' }],
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
