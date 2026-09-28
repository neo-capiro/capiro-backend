import { createHash } from 'node:crypto';
import { MeriResearchService } from './meri-research.service';
import { researchToolVersion } from './meri-research-durable-result';
import { readDurableResearchStepReceipts } from './meri-research-durable-step';
import {
  buildResearchReportProvenance,
  certifyResearchProducerInputs,
} from './meri-report-provenance';
import { buildDebriefReadResult, parseDebriefReadInput } from './meri-debrief-read.helpers';

const TOOL_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
};
const TOOL_VERSION = researchToolVersion(TOOL_SCHEMA);
const MAIL_TOOL_SCHEMA = {
  type: 'object',
  properties: { threadId: { type: 'string' } },
  required: ['threadId'],
};
const MAIL_TOOL_VERSION = researchToolVersion(MAIL_TOOL_SCHEMA);
const ctx = { tenantId: 'tenant-1', userId: 'user-1', tenantSlug: 'tenant' } as never;

const DEBRIEF_SCHEMA = {
  type: 'object',
  properties: {
    clientId: { type: 'string' },
    debriefId: { type: 'string' },
    characterLimit: { type: 'integer' },
  },
  required: ['clientId'],
};
const DEBRIEF_VERSION = researchToolVersion(DEBRIEF_SCHEMA);
const DEBRIEF_INPUT = {
  clientId: 'client-1',
  debriefId: 'debrief-1',
  characterLimit: 100,
};

function completeDebriefResult(
  body = 'PRIVATE EXACT DEBRIEF SOURCE',
  updatedAt = '2026-09-21T10:00:00.000Z',
) {
  const selection = parseDebriefReadInput(ctx, DEBRIEF_INPUT, 'client-1');
  return buildDebriefReadResult(ctx, selection, {
    rows: [{
      id: 'debrief-1',
      meetingId: 'meeting-1',
      clientId: 'client-1',
      body,
      status: 'approved',
      authorUserId: 'user-1',
      author: {
        id: 'user-1', email: 'owner@example.com', firstName: 'Owner', lastName: 'One',
      },
      createdAt: new Date('2026-09-20T10:00:00.000Z'),
      updatedAt: new Date(updatedAt),
      meeting: {
        id: 'meeting-1', clientId: 'client-1', subject: 'Client review',
        startsAt: new Date('2026-09-19T14:00:00.000Z'),
      },
    }],
    sourceStatus: 'healthy',
    sourceReason: null,
    nextAfter: null,
  });
}

function completeMemoryResult(id: string, body = `body-${id}`) {
  const contentHash = `hash-${body}`;
  return {
    tool: 'search_memory',
    coverage: {
      complete: true,
      paginationComplete: true,
      sources: [
        {
          domain: 'institutional_knowledge',
          sourceStatus: 'healthy',
          hasMore: false,
          truncated: false,
          paginationComplete: true,
          coverageComplete: true,
        },
      ],
    },
    factContentUnavailableCount: 0,
    contentStatus: 'available',
    contentTruncated: false,
    nextCursor: null,
    results: [{ id, body }],
    records: [{
      domain: 'institutional_knowledge',
      recordId: id,
      updatedAt: '2026-09-28T00:00:00.000Z',
      provenance: { sourceVersion: 'memory-v1', contentHash },
      payload: {
        sourceKind: 'governed_memory', memoryItemId: id, clientId: null,
        content: { hash: contentHash }, value: body,
      },
    }],
  };
}

function completeMailThreadResult(
  body = 'Exact complete canonical mail body.',
  messageUpdatedAt = '2026-09-28T00:01:00.000Z',
) {
  const threadId = '11111111-1111-4111-8111-111111111111';
  const messageId = '22222222-2222-4222-8222-222222222222';
  return {
    threadId,
    subject: 'Canonical source',
    mailbox: 'owner@example.test',
    messageId: null,
    messageOffset: 0,
    totalMessages: 1,
    returned: 1,
    hasMore: false,
    nextMessageOffset: null,
    sourceProof: {
      version: 1,
      threadId,
      mailboxId: 'mailbox-1',
      mailboxStatus: 'connected',
      clientId: null,
      threadUpdatedAt: '2026-09-28T00:00:00.000Z',
    },
    messages: [{
      id: messageId,
      threadId,
      subject: 'Canonical source',
      from: { email: 'sender@example.test', name: 'Sender' },
      to: [{ email: 'owner@example.test', name: 'Owner' }],
      cc: [],
      bodyText: body,
      bodyOffset: 0,
      bodyLength: body.length,
      bodyCompleteness: 'full',
      bodyTruncated: false,
      nextBodyOffset: null,
      sourceProof: {
        version: 1,
        mailboxId: 'mailbox-1',
        threadId,
        messageId,
        messageUpdatedAt,
        bodySha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      },
    }],
  };
}

function harness(options: {
  tool?: 'search_memory' | 'get_email_thread';
  schema?: Record<string, unknown>;
  source?: unknown;
} = {}) {
  const ownerTool = options.tool ?? 'search_memory';
  const ownerSchema = options.schema ?? TOOL_SCHEMA;
  let authorizationAllowed = true;
  let sourceAllowed = true;
  let currentSource: unknown = options.source ?? completeMemoryResult('execution-1');
  const artifacts = new Map<string, Record<string, any>>();
  const session: Record<string, any> = {
    id: 'session-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    clientId: null,
    title: 'Durable replay',
    topic: 'topic',
    status: 'researching',
    reportArtifactId: null,
    metadata: {
      handoff: {
        version: 1,
        conversationId: 'conversation-1',
        clientId: null,
        messages: [],
        attachments: [],
        reasoningMode: 'deep',
        capturedAt: '2026-09-28T00:00:00.000Z',
      },
      run: {
        id: 'run-1',
        leaseEpoch: 1,
        eventSequence: 0,
        phase: 'research',
        status: 'running',
        stage: 'reading',
        startedAt: '2026-09-28T00:00:00.000Z',
        heartbeatAt: new Date().toISOString(),
      },
    },
  };
  let artifactCounter = 0;
  const tx: any = {
    clioResearchSession: {
      findFirst: jest.fn(async () => session),
    },
    clioConversation: {
      findFirst: jest.fn(async () => (authorizationAllowed ? { id: 'conversation-1' } : null)),
      create: jest.fn(async () => ({ id: 'conversation-created' })),
    },
    clioArtifact: {
      create: jest.fn(async ({ data }: any) => {
        const id = `private-result-${++artifactCounter}`;
        artifacts.set(id, { bodyText: data.bodyText });
        return { id };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const value = artifacts.get(where.id);
        return value ?? null;
      }),
    },
    $queryRawUnsafe: jest.fn(async (...args: any[]) => {
      // query text is arg 0; next_metadata_jsonb is positional arg 10.
      session.metadata = JSON.parse(args[10]);
      return [{ metadata_jsonb: session.metadata }];
    }),
  };
  const prisma: any = {
    withTenant: jest.fn(async (_tenantId: string, callback: any) => callback(tx)),
    withTenantUser: jest.fn(async (_tenantId: string, _userId: string, callback: any) =>
      callback(tx),
    ),
  };
  const tools: any = {
    anthropicToolSchemas: jest.fn(() => [
      { name: ownerTool, description: 'search', input_schema: ownerSchema },
    ]),
    isConcurrencySafe: jest.fn((tool: string) => tool === ownerTool),
    isSideEffecting: jest.fn((tool: string) => tool !== ownerTool),
    execute: jest.fn(async (_ctx: unknown, _tool: string, input: Record<string, unknown>) => {
      if (!sourceAllowed) throw new Error('memory source revoked');
      if (ownerTool === 'search_memory' && input.query === 'alpha')
        return completeMemoryResult('execution-a');
      if (ownerTool === 'search_memory' && input.query === 'beta')
        return completeMemoryResult('execution-b');
      return currentSource;
    }),
  };
  const service = new MeriResearchService(
    prisma,
    { get: jest.fn() } as never,
    tools,
    {} as never,
    {} as never,
  );
  return {
    service,
    session,
    tx,
    tools,
    artifacts,
    completeReport: (toolsUsed: unknown = [ownerTool], producerSourceFree = false) => {
      session.reportArtifactId = 'report-1';
      session.status = 'complete';
      session.metadata = {
        ...session.metadata,
        run: { ...session.metadata.run, status: 'complete', stage: 'Report saved' },
      };
      const bodyText = producerSourceFree
        ? 'SOURCE_FREE_REPORT_FROM_KNOWN_PROMPT_ONLY'
        : 'REPORT_CITING_CURRENT_RUN_MEMORY';
      const declaredTools = Array.isArray(toolsUsed) && toolsUsed.every((tool) => typeof tool === 'string')
        ? toolsUsed as string[]
        : null;
      const producerInput = declaredTools
        ? certifyResearchProducerInputs({
            hashMaterial: { bodyText },
            toolsUsed: declaredTools,
            clientContext: null,
            handoffSummaryPresent: false,
            handoffAttachmentCount: 0,
            assistantHandoffTurns: 0,
            inheritedCitationCount: 0,
            inheritedUnavailableCount: 0,
            inheritedOmittedCount: 0,
            contextPacketItemCount: 0,
            unreceiptedLedgerEntryCount: 0,
          })
        : null;
      const canProve = Boolean(
        declaredTools &&
        producerInput &&
        (declaredTools.length === 0
          ? producerSourceFree && readDurableResearchStepReceipts(session.metadata).length === 0
          : readDurableResearchStepReceipts(session.metadata).length > 0),
      );
      const reportProvenance = canProve
        ? buildResearchReportProvenance({
            artifactId: 'report-1',
            messageId: null,
            sessionId: session.id,
            tenantId: session.tenantId,
            userId: session.userId,
            clientId: null,
            conversationId: 'conversation-1',
            runId: 'run-1',
            leaseEpoch: 1,
            body: bodyText,
            receipts: readDurableResearchStepReceipts(session.metadata),
            toolsUsed: declaredTools!,
            producerInputSha256: producerInput!.producerInputSha256,
            producerInputMode: producerInput!.producerInputMode as 'source_free' | 'covered_inputs',
            clientContextSha256: producerInput!.clientContextSha256,
          })
        : null;
      if (reportProvenance) session.metadata = { ...session.metadata, reportProvenance };
      artifacts.set('report-1', {
        id: 'report-1',
        title: 'Durable report',
        kind: 'research_report',
        bodyText,
        metadata: {
          researchSessionId: session.id,
          toolsUsed,
          ...(reportProvenance ? { reportProvenance } : {}),
        },
      });
    },
    revoke: () => {
      authorizationAllowed = false;
    },
    revokeSource: () => {
      sourceAllowed = false;
    },
    replaceSource: (result: unknown) => {
      currentSource = result;
    },
    resume: () => {
      session.metadata = {
        ...session.metadata,
        run: {
          ...session.metadata.run,
          id: 'run-2',
          leaseEpoch: 2,
          status: 'running',
          eventSequence: session.metadata.run.eventSequence,
          heartbeatAt: new Date().toISOString(),
        },
      };
    },
  };
}

function outcome(executionId: string, query: string, result = completeMemoryResult(executionId)) {
  return {
    executionId,
    leaseEpoch: 1,
    providerCallId: `provider-${executionId}`,
    tool: 'search_memory',
    toolVersion: TOOL_VERSION,
    input: { query },
    result,
  };
}

function mailOutcome(result = completeMailThreadResult()) {
  return {
    executionId: 'mail-execution-1',
    leaseEpoch: 1,
    providerCallId: 'provider-mail-execution-1',
    tool: 'get_email_thread',
    toolVersion: MAIL_TOOL_VERSION,
    input: { threadId: result.threadId },
    result,
  };
}

describe('Meri durable safe-read commit and replay', () => {
  it('replays the committed owner result after a crash boundary without another execution', async () => {
    const h = harness();
    const toolExecute = jest.fn(async () => completeMemoryResult('execution-1'));
    const executed = await toolExecute();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-1', 'radar', executed),
    );
    // Simulated crash: no source/result delivery occurs after the commit.
    h.resume();
    const replay = await h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
      leaseEpoch: 2,
      tool: 'search_memory',
      toolVersion: TOOL_VERSION,
      input: { query: 'radar' },
    });

    expect(replay.replayed).toBe(true);
    expect(replay.result).toEqual(executed);
    expect(toolExecute).toHaveBeenCalledTimes(1);
    expect(h.artifacts.size).toBe(1);
  });

  it('rejects an old run epoch and does not match different exact input', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-1', 'radar'),
    );
    h.resume();
    await expect(
      h.service.commitSafeReadOutcome(
        ctx,
        'session-1',
        'run-1',
        outcome('late-execution', 'radar'),
      ),
    ).rejects.toThrow('lease');
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
        leaseEpoch: 1,
        tool: 'search_memory',
        toolVersion: TOOL_VERSION,
        input: { query: 'radar' },
      }),
    ).rejects.toThrow('lease');
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
        leaseEpoch: 2,
        tool: 'search_memory',
        toolVersion: TOOL_VERSION,
        input: { query: 'different' },
      }),
    ).resolves.toEqual({ replayed: false });
  });

  it('fails closed when current conversation visibility is revoked', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-1', 'radar'),
    );
    h.resume();
    h.revoke();
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
        leaseEpoch: 2,
        tool: 'search_memory',
        toolVersion: TOOL_VERSION,
        input: { query: 'radar' },
      }),
    ).rejects.toThrow('conversation');
  });

  it('declines replay when current source authority is revoked or its version changed', async () => {
    const request = {
      leaseEpoch: 2,
      tool: 'search_memory',
      toolVersion: TOOL_VERSION,
      input: { query: 'radar' },
    };
    const revoked = harness();
    await revoked.service.commitSafeReadOutcome(
      ctx, 'session-1', 'run-1', outcome('execution-1', 'radar'),
    );
    revoked.resume();
    revoked.revokeSource();
    await expect(revoked.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request))
      .resolves.toEqual({ replayed: false });

    const changed = harness();
    await changed.service.commitSafeReadOutcome(
      ctx, 'session-1', 'run-1', outcome('execution-1', 'radar'),
    );
    changed.resume();
    changed.replaceSource(completeMemoryResult('execution-1', 'corrected body'));
    await expect(changed.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request))
      .resolves.toEqual({ replayed: false });
  });

  it('treats an absent or corrupt private result as a replay miss', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx, 'session-1', 'run-1', outcome('execution-1', 'radar'),
    );
    h.resume();
    const request = {
      leaseEpoch: 2,
      tool: 'search_memory',
      toolVersion: TOOL_VERSION,
      input: { query: 'radar' },
    };
    h.artifacts.clear();
    await expect(h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request))
      .resolves.toEqual({ replayed: false });
    h.artifacts.set('private-result-1', { bodyText: '{corrupt' });
    await expect(h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request))
      .resolves.toEqual({ replayed: false });
  });

  it('keeps same-name invocations separate by execution ID and exact input', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-a', 'alpha'),
    );
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-b', 'beta'),
    );
    h.resume();
    const replay = await h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
      leaseEpoch: 2,
      tool: 'search_memory',
      toolVersion: TOOL_VERSION,
      input: { query: 'alpha' },
    });

    expect(replay.replayed).toBe(true);
    expect(replay.durableSafeRead?.executionId).toBe('execution-a');
    expect((replay.result as any).records[0].recordId).toBe('execution-a');
    expect(h.artifacts.size).toBe(2);
  });

  it('does not commit HTTP-200 logical errors or partial owner payloads', async () => {
    const h = harness();
    await expect(
      h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', {
        ...outcome('logical-error', 'radar'),
        result: { status: 'error', error: 'upstream logical failure' },
      }),
    ).rejects.toThrow('not a qualified');
    await expect(
      h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', {
        ...outcome('partial', 'radar'),
        result: {
          ...completeMemoryResult('partial'),
          nextCursor: 'next',
          coverage: {
            ...completeMemoryResult('partial').coverage,
            complete: false,
          },
        },
      }),
    ).rejects.toThrow('not a qualified');
    expect(h.artifacts.size).toBe(0);
  });

  it('redacts private refs, hashes, inputs, and owner results from the ordinary session response', async () => {
    const h = harness();
    const privateBody = completeMemoryResult('private', 'never expose this owner body');
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-private', 'private query', privateBody),
    );
    const response = await h.service.getSession(ctx, 'session-1');
    const publicJson = JSON.stringify(response.metadata);

    expect(publicJson).not.toContain('private-result-');
    expect(publicJson).not.toContain('private query');
    expect(publicJson).not.toContain('never expose this owner body');
    expect(publicJson).not.toContain('Sha256');
    expect(publicJson).toContain('execution-private');
  });

  it('returns the actual source-free report shape when no receipt or source declaration exists', async () => {
    const h = harness();
    h.completeReport([], true);

    const response = await h.service.getSession(ctx, 'session-1');
    const markdown = await h.service.getReportMarkdown(ctx, 'session-1');

    expect(response).toMatchObject({
      id: 'session-1',
      report: {
        id: 'report-1',
        bodyText: 'SOURCE_FREE_REPORT_FROM_KNOWN_PROMPT_ONLY',
        metadata: { researchSessionId: 'session-1', toolsUsed: [] },
      },
      reportMetadata: { researchSessionId: 'session-1', toolsUsed: [] },
    });
    expect(markdown).toEqual({
      title: 'Durable report',
      markdown: 'SOURCE_FREE_REPORT_FROM_KNOWN_PROMPT_ONLY',
    });
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('withholds a completed same-run report after current source authority is revoked', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-current-run', 'radar'),
    );
    h.completeReport();
    h.revokeSource();

    const response = await h.service.getSession(ctx, 'session-1');

    expect(response.report?.bodyText).not.toContain('REPORT_CITING_CURRENT_RUN_MEMORY');
    expect(response.report?.bodyText).toContain('current source authorization');
    expect(response.reportMetadata).toMatchObject({
      reportBodyAccess: {
        status: 'withheld',
        recovery: 'research_session',
        researchSessionId: 'session-1',
      },
    });
    expect(h.tools.execute).toHaveBeenCalled();
    await expect(h.service.getReportMarkdown(ctx, 'session-1')).rejects.toThrow(
      'no longer authorized',
    );
  });

  it('does not treat a missing run as report authority for recovery or export', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-current-run', 'radar'),
    );
    h.completeReport();
    delete h.session.metadata.run;
    h.revokeSource();

    const response = await h.service.getSession(ctx, 'session-1');

    expect(response.report?.bodyText).toContain('current source authorization');
    expect(response.reportMetadata).toMatchObject({
      reportBodyAccess: { status: 'withheld', recovery: 'research_session' },
    });
    await expect(h.service.getReportMarkdown(ctx, 'session-1')).rejects.toThrow(
      'producer proof is unavailable',
    );
  });

  it('withholds unsupported missing-receipt reports without calling an unowned adapter', async () => {
    const h = harness();
    h.completeReport();
    h.artifacts.get('report-1')!.metadata.toolsUsed = ['search_emails'];

    const response = await h.service.getSession(ctx, 'session-1');

    expect(response.report?.bodyText).toContain('current source authorization');
    expect(response.reportMetadata).toMatchObject({
      reportBodyAccess: { status: 'withheld', recovery: 'research_session' },
    });
    expect(h.tools.execute).not.toHaveBeenCalled();
    await expect(h.service.getReportMarkdown(ctx, 'session-1')).rejects.toThrow(
      'producer proof is unavailable',
    );
  });

  it('removes report-derived detail and nested bodies from withheld recovery metadata', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-current-run', 'radar'),
    );
    h.completeReport();
    Object.assign(h.artifacts.get('report-1')!.metadata, {
      intent: 'PRIVATE_INTENT',
      trustSteps: [{ tool: 'search_memory', label: 'PRIVATE_LABEL', detail: 'PRIVATE_DETAIL', count: 1 }],
      nested: { body: 'PRIVATE_NESTED_BODY' },
    });
    h.session.metadata.durableStepReceipts[0].summary = 'PRIVATE_RECEIPT_SUMMARY';
    h.revokeSource();

    const response = await h.service.getSession(ctx, 'session-1');
    const json = JSON.stringify(response);

    expect(json).not.toContain('PRIVATE_DETAIL');
    expect(json).not.toContain('PRIVATE_NESTED_BODY');
    expect(json).not.toContain('PRIVATE_LABEL');
    expect(json).not.toContain('PRIVATE_INTENT');
    expect(json).not.toContain('PRIVATE_RECEIPT_SUMMARY');
    expect(response.report?.metadata).toMatchObject({
      trustSteps: [{ tool: 'search_memory', count: 1 }],
      reportBodyAccess: { status: 'withheld' },
    });
    expect(response.reportMetadata).toMatchObject({
      trustSteps: [{ tool: 'search_memory', count: 1 }],
      reportBodyAccess: { status: 'withheld' },
    });
    expect(
      (response.metadata.durableStepReceipts as Array<{ summary: string }>)[0]?.summary,
    ).toBe('Authorized read completed');
  });

  it('projects recovery sources without returning persisted owner prose', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx, 'session-1', 'run-1', outcome('execution-current-run', 'radar'),
    );
    h.completeReport();
    h.session.sources = [{
      tool: 'search_memory',
      label: 'Memory',
      summary: 'private owner result text',
      confidence: 'high',
    }];

    const response = await h.service.getSession(ctx, 'session-1');

    expect(JSON.stringify(response)).not.toContain('private owner result text');
    expect(response.sources).toEqual([{
      tool: 'search_memory',
      label: 'Research source',
      summary: 'Authorized read completed',
      confidence: 'high',
    }]);
  });

  it('binds recovery and export to the delivered report metadata identity', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx, 'session-1', 'run-1', outcome('execution-current-run', 'radar'),
    );
    h.completeReport();
    h.artifacts.get('report-1')!.metadata.researchSessionId = 'different-session';

    const response = await h.service.getSession(ctx, 'session-1');

    expect(response.report?.bodyText).toContain('current source authorization');
    await expect(h.service.getReportMarkdown(ctx, 'session-1')).rejects.toThrow();
  });

  it('omits a malformed private receipt tool identifier from the public DTO', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx, 'session-1', 'run-1', outcome('execution-current-run', 'radar'),
    );
    h.completeReport();
    h.session.metadata.durableStepReceipts[0].tool = 'private_source_detail';

    const response = await h.service.getSession(ctx, 'session-1');
    const receipt = (response.metadata.durableStepReceipts as Array<{ tool: string }>)[0];

    expect(JSON.stringify(response)).not.toContain('private_source_detail');
    expect(receipt?.tool).toBe('research_source');
    expect(response.report?.bodyText).toContain('current source authorization');
  });

  it.each([
    ['empty', []],
    ['missing', undefined],
    ['malformed', ['search_memory', 7]],
  ])('withholds a saved private receipt when toolsUsed is %s', async (_label, toolsUsed) => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-current-run', 'radar'),
    );
    h.completeReport(toolsUsed);
    if (toolsUsed === undefined) delete h.artifacts.get('report-1')!.metadata.toolsUsed;
    h.revokeSource();

    const response = await h.service.getSession(ctx, 'session-1');

    expect(response.report?.bodyText).toContain('current source authorization');
    expect(response.report?.metadata).toMatchObject({
      reportBodyAccess: { status: 'withheld', recovery: 'research_session' },
    });
    await expect(h.service.getReportMarkdown(ctx, 'session-1')).rejects.toThrow();
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('commits the actual debrief owner page and replays an old lease only while current bytes remain exact', async () => {
    const h = harness();
    let current: unknown = completeDebriefResult();
    let revoked = false;
    h.tools.anthropicToolSchemas.mockReturnValue([
      { name: 'query_debriefs', description: 'debriefs', input_schema: DEBRIEF_SCHEMA },
    ]);
    h.tools.isConcurrencySafe.mockImplementation((tool: string) => tool === 'query_debriefs');
    h.tools.execute.mockImplementation(async () => {
      if (revoked) throw new Error('debrief access revoked');
      return current;
    });
    await h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', {
      executionId: 'debrief-execution-1',
      leaseEpoch: 1,
      providerCallId: 'debrief-provider-1',
      tool: 'query_debriefs',
      toolVersion: DEBRIEF_VERSION,
      input: DEBRIEF_INPUT,
      result: current,
    });
    expect(readDurableResearchStepReceipts(h.session.metadata)).toEqual([
      expect.objectContaining({
        version: 2,
        tool: 'query_debriefs',
        classifier: 'complete',
        resultRef: expect.stringMatching(/^private-result-/),
      }),
    ]);

    h.resume();
    const request = {
      leaseEpoch: 2,
      tool: 'query_debriefs',
      toolVersion: DEBRIEF_VERSION,
      input: DEBRIEF_INPUT,
    };
    await expect(h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request))
      .resolves.toMatchObject({
        replayed: true,
        result: {
          tool: 'query_debriefs',
          debriefs: [{ id: 'debrief-1', body: 'PRIVATE EXACT DEBRIEF SOURCE' }],
        },
      });

    current = completeDebriefResult(
      'EDITED PRIVATE DEBRIEF WITH SAME IDS AND COUNT',
      '2026-09-22T10:00:00.000Z',
    );
    await expect(h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request))
      .resolves.toEqual({ replayed: false });
    revoked = true;
    await expect(h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request))
      .resolves.toEqual({ replayed: false });
  });

  it('reauthorizes debrief-backed report read/export and withholds it after edit or revoke', async () => {
    const h = harness();
    let current: unknown = completeDebriefResult();
    let revoked = false;
    h.tools.anthropicToolSchemas.mockReturnValue([
      { name: 'query_debriefs', description: 'debriefs', input_schema: DEBRIEF_SCHEMA },
    ]);
    h.tools.isConcurrencySafe.mockImplementation((tool: string) => tool === 'query_debriefs');
    h.tools.execute.mockImplementation(async () => {
      if (revoked) throw new Error('debrief access revoked');
      return current;
    });
    await h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', {
      executionId: 'debrief-report-execution',
      leaseEpoch: 1,
      providerCallId: 'debrief-report-provider',
      tool: 'query_debriefs',
      toolVersion: DEBRIEF_VERSION,
      input: DEBRIEF_INPUT,
      result: current,
    });
    h.completeReport(['query_debriefs']);

    const allowed = await h.service.getSession(ctx, 'session-1');
    const exported = await h.service.getReportMarkdown(ctx, 'session-1');
    expect(allowed.report?.bodyText).toBe('REPORT_CITING_CURRENT_RUN_MEMORY');
    expect(exported.markdown).toBe('REPORT_CITING_CURRENT_RUN_MEMORY');
    expect(JSON.stringify(allowed)).not.toContain('PRIVATE EXACT DEBRIEF SOURCE');

    current = completeDebriefResult('EDITED PRIVATE DEBRIEF', '2026-09-22T10:00:00.000Z');
    const edited = await h.service.getSession(ctx, 'session-1');
    expect(edited.report?.bodyText).toContain('current source authorization');
    await expect(h.service.getReportMarkdown(ctx, 'session-1')).rejects.toThrow(
      'source version changed',
    );

    revoked = true;
    const denied = await h.service.getSession(ctx, 'session-1');
    expect(denied.report?.bodyText).toContain('current source authorization');
    await expect(h.service.getReportMarkdown(ctx, 'session-1')).rejects.toThrow(
      'no longer authorized',
      );
    });

  it('reauthorizes canonical full mail through retained replay, report read and export, then denies mutation and mailbox revocation', async () => {
    const replay = harness({
      tool: 'get_email_thread',
      schema: MAIL_TOOL_SCHEMA,
      source: completeMailThreadResult(),
    });
    await replay.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      mailOutcome(),
    );
    replay.resume();
    await expect(replay.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
      leaseEpoch: 2,
      tool: 'get_email_thread',
      toolVersion: MAIL_TOOL_VERSION,
      input: { threadId: '11111111-1111-4111-8111-111111111111' },
    })).resolves.toMatchObject({ replayed: true, result: { totalMessages: 1 } });

    const report = harness({
      tool: 'get_email_thread',
      schema: MAIL_TOOL_SCHEMA,
      source: completeMailThreadResult(),
    });
    await report.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      mailOutcome(),
    );
    report.completeReport();
    await expect(report.service.getSession(ctx, 'session-1')).resolves.toMatchObject({
      report: { bodyText: 'REPORT_CITING_CURRENT_RUN_MEMORY' },
    });
    await expect(report.service.getReportMarkdown(ctx, 'session-1')).resolves.toEqual({
      title: 'Durable report',
      markdown: 'REPORT_CITING_CURRENT_RUN_MEMORY',
    });

    report.replaceSource(completeMailThreadResult(
      'Corrected canonical mail body.',
      '2026-09-28T00:02:00.000Z',
    ));
    await expect(report.service.getSession(ctx, 'session-1')).resolves.toMatchObject({
      report: { bodyText: expect.stringContaining('current source authorization') },
      reportMetadata: { reportBodyAccess: { status: 'withheld' } },
    });
    await expect(report.service.getReportMarkdown(ctx, 'session-1')).rejects.toThrow(
      'version changed',
    );

    const revoked = completeMailThreadResult();
    revoked.sourceProof.mailboxStatus = 'needs_configuration';
    report.replaceSource(revoked);
    await expect(report.service.getReportMarkdown(ctx, 'session-1')).rejects.toThrow(
      'version changed',
    );
  });
});
