import type { TenantContext } from '@capiro/shared';
import { MERI_GOVERNMENT_AFFAIRS_OUTPUT_CONTRACT } from '@capiro/meriv2-core';
import { MeriResearchService } from './meri-research.service.js';
import { readResearchHandoff } from './meri-research-handoff.js';
import type { ResearchRuntimeAuth } from './meri-v3-research-runner.js';
import { researchToolVersion, sealDurableResearchResult } from './meri-research-durable-result.js';
import { certifyResearchProducerInputs } from './meri-report-provenance.js';
import {
  RESEARCH_PARTIAL,
  RESEARCH_PROVIDER_FAILURE,
  RESEARCH_RUN_FAILURE,
  ResearchTerminalError,
} from './research-observer-projection.js';
import {
  completeResearchToolAttempt,
  reserveResearchToolAttempt,
} from './meri-research-tool-budget.js';
import {
  completeDurableResearchStep,
  readDurableResearchCoordinator,
  reserveDurableResearchStep,
} from './meri-research-coordinator.js';
import type { ResearchPlanV1 } from './meri-research-plan.js';

jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../reviews/reviews.service.js', () => ({ ReviewsService: class {} }));
jest.mock('../engagement/ai-credential-resolver.service.js', () => ({
  AiCredentialResolverService: class {},
}));
jest.mock('./meri-v3-research-runner.js', () => ({ MeriV3ResearchRunner: class {} }));

const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as TenantContext;
const DOCUMENT_TOOL_SCHEMA = {
  type: 'object',
  properties: { documentId: { type: 'string' } },
};

function completeDocumentResult() {
  return {
    tool: 'read_client_documents',
    clientId: 'client-a',
    document: { id: 'prior-file', contentHash: 'a'.repeat(64) },
    coverage: {
      complete: true,
      truncated: false,
      extractedSectionEmpty: false,
      continuationBlocked: false,
      matched: null,
      nextCursor: null,
    },
    records: [
      {
        recordId: 'prior-file',
        provenance: {
          sectionHash: 'b'.repeat(64),
          section: 1,
          characterStart: 0,
          characterEnd: 50,
        },
      },
    ],
  };
}

function providerBody(events: Array<Record<string, unknown>>): AsyncIterable<Uint8Array> {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  );
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

function providerResponse(events: Array<Record<string, unknown>>): Response {
  return {
    ok: true,
    status: 200,
    body: providerBody(events) as unknown as ReadableStream<Uint8Array>,
    text: async () => '',
  } as unknown as Response;
}

function rawProviderResponse(chunks: Uint8Array[]): Response {
  return {
    ok: true,
    status: 200,
    body: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    } as unknown as ReadableStream<Uint8Array>,
    text: async () => '',
  } as unknown as Response;
}

function fixture(
  options: {
    privateInheritedInputs?: boolean;
    legacyConfig?: Record<string, unknown>;
    tenantSettings?: Record<string, unknown>;
  } = {},
) {
  const privateInheritedInputs = options.privateInheritedInputs === true;
  let session: any;
  let allowed = true;
  let originAvailable = true;
  let failReceiptWrites = false;
  let afterReceiptCommit: (() => void) | undefined;
  let receiptBarrier: Promise<void> | undefined;
  let receiptBarrierEntered: (() => void) | undefined;
  const conversation = {
    id: 'thread-a',
    clientId: 'client-a',
    metadata: { meriv3: { reasoningMode: 'max' } },
    summary: privateInheritedInputs ? 'Keep the memo about enacted amounts.' : null,
    summaryUpToMessageId: null,
  };
  const messages: any[] = [
    {
      id: 'early-user',
      role: 'user',
      clientId: 'client-a',
      body: 'Exclude forecasted opportunities.',
      metadata: privateInheritedInputs
        ? {
            attachments: [
              { id: 'prior-file', filename: 'brief.txt', kind: 'text', status: 'parsed' },
            ],
          }
        : {},
      createdAt: new Date('2026-09-01'),
    },
  ];
  const attachments = privateInheritedInputs
    ? [
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
      ]
    : [];
  const artifacts: any[] = [];
  let safeResultArtifact: any = null;
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql: string, ...values: unknown[]) => {
      if (sql.includes('UPDATE clio_research_sessions')) {
        const run = session?.metadata?.run;
        const matches =
          session &&
          values[0] === session.id &&
          values[1] === session.tenantId &&
          values[2] === session.userId &&
          values[3] === session.status &&
          values[4] === run?.id &&
          String(values[5]) === String(run?.leaseEpoch) &&
          values[6] === run?.phase &&
          run?.status === 'running' &&
          Date.parse(run?.heartbeatAt ?? '') >= new Date(values[7] as string | Date).getTime();
        if (!matches) return [];
        if (sql.includes('SET metadata_jsonb')) {
          if (JSON.stringify(session.metadata) !== String(values[8])) return [];
          const nextMetadata = JSON.parse(String(values[9]));
          const addsReceipt =
            (nextMetadata.durableStepReceipts?.length ?? 0) >
            (session.metadata?.durableStepReceipts?.length ?? 0);
          if (addsReceipt && receiptBarrier) {
            receiptBarrierEntered?.();
            await receiptBarrier;
          }
          if (addsReceipt && failReceiptWrites) throw new Error('Receipt database unavailable');
          session = {
            ...session,
            metadata: nextMetadata,
            status: values[10],
            updatedAt: new Date(values[11] as string | Date),
          };
          if (addsReceipt) afterReceiptCommit?.();
        } else {
          session = { ...session, updatedAt: new Date(values[8] as string | Date) };
        }
        return [{ metadata_jsonb: structuredClone(session.metadata) }];
      }
      return [{ allowed }];
    }),
    tenant: { findFirst: jest.fn(async () => ({ settings: options.tenantSettings ?? {} })) },
    client: {
      findFirst: jest.fn(async () => ({
        id: 'client-a',
        name: 'Client A',
        description: null,
        productDescription: null,
      })),
    },
    clioConversation: {
      findFirst: jest.fn(async ({ where }: any) =>
        originAvailable &&
        (!where?.id || where.id === conversation.id) &&
        (!('clientId' in (where ?? {})) || where.clientId === conversation.clientId)
          ? conversation
          : null,
      ),
      create: jest.fn(async () => ({ id: 'unexpected-backing-thread' })),
      update: jest.fn(async () => conversation),
    },
    clioMessage: {
      findFirst: jest.fn(
        async ({ where }: any) => messages.find((message) => message.id === where.id) ?? null,
      ),
      findMany: jest.fn(async () => messages.map((message) => ({ ...message }))),
      create: jest.fn(async ({ data }: any) => {
        const row = { ...data, id: data.id ?? `message-${messages.length}`, createdAt: new Date() };
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
      findFirst: jest.fn(
        async ({ where }: any) =>
          (where?.id === safeResultArtifact?.id
            ? safeResultArtifact
            : artifacts.find((artifact) => !where?.id || artifact.id === where.id)) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const artifact = { ...data, id: data.id ?? `artifact-${artifacts.length + 1}` };
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
  const tools = {
    anthropicToolSchemas: jest.fn(() => [
      {
        name: 'search_memory',
        description: 'Search governed memory',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      },
      {
        name: 'read_client_documents',
        description: 'Read a governed client document',
        input_schema: DOCUMENT_TOOL_SCHEMA,
      },
    ]),
    isConcurrencySafe: jest.fn(() => true),
    isSideEffecting: jest.fn(() => false),
    execute: jest.fn(),
  };
  const runner = {
    enabled: jest.fn(async () => true),
    plan: jest.fn(async (_ctx: unknown, _input: unknown) =>
      JSON.stringify({
        version: 1,
        title: 'Client briefing',
        scope: {
          sessionId: 'research-a',
          tenantId: 'tenant-a',
          actorId: 'user-a',
          clientId: 'client-a',
          conversationId: 'thread-a',
        },
        budget: { toolCalls: 2, tokens: 4_000 },
        steps: [
          {
            id: 'review-client-constraints',
            objective: 'Review client constraints',
            dependsOn: [],
            requiredEvidenceDomains: ['client_context'],
            allowedCapabilities: ['search_memory'],
            effect: 'read',
            completionCondition:
              'Current client constraints are supported or reported unavailable.',
            budget: { toolCalls: 1, tokens: 2_000 },
          },
          {
            id: 'check-funding-status',
            objective: 'Check funding status',
            dependsOn: ['review-client-constraints'],
            requiredEvidenceDomains: ['documents'],
            allowedCapabilities: ['read_client_documents'],
            effect: 'read',
            completionCondition: 'Current funding status is supported by authorized evidence.',
            budget: { toolCalls: 1, tokens: 2_000 },
          },
        ],
        clarifyingQuestions: ['Who is the audience?'],
      }),
    ),
    run: jest.fn(async (_ctx?: unknown, input?: any, auth?: ResearchRuntimeAuth) => {
      const run = session.metadata.run;
      const result = completeDocumentResult();
      const sealed = sealDurableResearchResult({
        executionId: 'execution-prior-file',
        providerCallId: 'provider-prior-file',
        runId: run.id,
        leaseEpoch: run.leaseEpoch,
        tool: 'read_client_documents',
        toolVersion: researchToolVersion(DOCUMENT_TOOL_SCHEMA),
        classifier: 'complete',
        input: { documentId: 'prior-file' },
        result,
        completedAt: '2026-09-28T00:00:00.000Z',
      });
      const receipt = {
        version: 2,
        receiptId: 'receipt-prior-file',
        runId: run.id,
        leaseEpoch: run.leaseEpoch,
        sequence: 1,
        effectClass: 'safe_read',
        toolCallId: 'provider-prior-file',
        tool: 'read_client_documents',
        label: 'Read client document',
        status: 'complete',
        summary: 'Authorized read completed',
        completedAt: '2026-09-28T00:00:00.000Z',
        executionId: 'execution-prior-file',
        providerCallId: 'provider-prior-file',
        toolVersion: sealed.envelope.toolVersion,
        inputSha256: sealed.envelope.inputSha256,
        resultSha256: sealed.envelope.resultSha256,
        resultBodySha256: sealed.bodySha256,
        resultRef: 'safe-result-prior-file',
        resultByteSize: sealed.byteSize,
        classifier: 'complete',
      };
      session.metadata = { ...session.metadata, durableStepReceipts: [receipt] };
      safeResultArtifact = {
        id: 'safe-result-prior-file',
        tenantId: session.tenantId,
        userId: session.userId,
        clientId: session.clientId,
        conversationId: 'thread-a',
        kind: 'internal_research_safe_read_result',
        bodyText: sealed.body,
        metadata: { serverOnly: true },
      };
      tools.execute.mockResolvedValue(result);
      const producerInput = certifyResearchProducerInputs({
        hashMaterial: input,
        toolsUsed: ['read_client_documents'],
        clientContext: input?.clientContext,
        handoffSummaryPresent: Boolean(input?.handoff?.summary),
        handoffAttachmentCount: input?.handoff?.attachments?.length ?? 0,
        assistantHandoffTurns:
          input?.handoff?.messages?.filter((message: any) => message.role === 'assistant').length ??
          0,
        inheritedCitationCount: 0,
        inheritedUnavailableCount: 0,
        inheritedOmittedCount: 0,
        contextPacketItemCount: auth?.governedContext?.contextPacket.items.length ?? 0,
        unreceiptedLedgerEntryCount: 0,
      });
      return {
        reportBody:
          '# Client briefing\n\nUse the existing manufacturing footprint. [S:read_client_documents:prior-file]',
        model: 'same-chat-model',
        sources: [
          {
            tool: 'read_client_documents',
            label: 'Read client document',
            summary: 'Authorized read completed',
            confidence: 'high',
          },
        ],
        toolsUsed: ['read_client_documents'],
        ledgerEntries: [
          { tool: 'read_client_documents', result, serialized: JSON.stringify(result) },
        ],
        citations: [],
        producerInputEvaluated: true,
        ...producerInput,
      };
    }),
  };
  const maintenance = { scheduleAfterTurnMaintenance: jest.fn() };
  const service = new MeriResearchService(
    prisma as never,
    {
      get: (key: string) =>
        ({
          CLIO_RESEARCH_MODEL: 'claude-sonnet-5',
          CLIO_RESEARCH_MAX_TOKENS: 2_000,
          CLIO_RESEARCH_TIMEOUT_MS: 30_000,
          CLIO_RESEARCH_MAX_TOOL_ROUNDS: 1,
          CLIO_RESEARCH_TOTAL_BUDGET_MS: 60_000,
          CLIO_RESEARCH_SYNTHESIS_RESERVE_MS: 10_000,
          CLIO_RESEARCH_PROGRESS_INTERVAL_MS: 5_000,
          ...options.legacyConfig,
        })[key],
    } as never,
    tools as never,
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
    tools,
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
    changeClient: () => {
      conversation.clientId = 'client-b';
    },
    replica: () =>
      new MeriResearchService(
        prisma as never,
        { get: () => undefined } as never,
        tools as never,
        credentials as never,
        {} as never,
        runner as never,
        maintenance,
      ),
    revoke: () => {
      allowed = false;
    },
    failReceipts: () => {
      failReceiptWrites = true;
    },
    holdReceipts: () => {
      let release!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      receiptBarrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      receiptBarrierEntered = entered;
      return { entered: enteredPromise, release };
    },
    afterReceipt: (callback: () => void) => {
      afterReceiptCommit = callback;
    },
    durableDocumentRead: (toolCallId: string) => {
      const run = session.metadata.run;
      const toolVersion = researchToolVersion(DOCUMENT_TOOL_SCHEMA);
      const coordinator = readDurableResearchCoordinator(session.metadata);
      if (coordinator?.steps[0]?.outcome !== 'completed') {
        const prerequisiteBinding = {
          providerCallId: `prerequisite-${toolCallId}`,
          kind: 'dispatch' as const,
          tool: 'search_memory',
          toolVersion: researchToolVersion({ type: 'object', properties: {} }),
          input: {},
        };
        const prerequisiteBudget = reserveResearchToolAttempt({
          metadata: session.metadata,
          run,
          plan: session.metadata.researchPlan as ResearchPlanV1,
          binding: prerequisiteBinding,
        });
        if (!prerequisiteBudget.dispatchAllowed)
          throw new Error('continuity prerequisite reservation was not admitted');
        const prerequisiteStep = reserveDurableResearchStep({
          metadata: prerequisiteBudget.metadata,
          run,
          reservationId: prerequisiteBudget.reservation.reservationId,
          providerCallId: prerequisiteBinding.providerCallId,
          kind: 'dispatch',
          tool: prerequisiteBinding.tool,
          toolVersion: prerequisiteBinding.toolVersion,
          toolInput: prerequisiteBinding.input,
        });
        const prerequisiteSpent = completeResearchToolAttempt({
          metadata: prerequisiteStep.metadata,
          run,
          reservationId: prerequisiteBudget.reservation.reservationId,
          binding: prerequisiteBinding,
          outcome: 'result_committed',
        });
        session.metadata = completeDurableResearchStep({
          metadata: prerequisiteSpent.metadata,
          run,
          reservationId: prerequisiteBudget.reservation.reservationId,
          receiptId: `fixture-prerequisite-${toolCallId}`,
          resultRef: `fixture-prerequisite-${toolCallId}`,
        }).metadata;
      }
      const binding = {
        providerCallId: toolCallId,
        kind: 'dispatch' as const,
        tool: 'read_client_documents',
        toolVersion,
        input: { documentId: 'prior-file' },
      };
      const reserved = reserveResearchToolAttempt({
        metadata: session.metadata,
        run,
        plan: session.metadata.researchPlan as ResearchPlanV1,
        binding,
      });
      if (!reserved.dispatchAllowed)
        throw new Error('continuity fixture reservation was not admitted');
      const coordinated = reserveDurableResearchStep({
        metadata: reserved.metadata,
        run,
        reservationId: reserved.reservation.reservationId,
        providerCallId: toolCallId,
        kind: 'dispatch',
        tool: binding.tool,
        toolVersion,
        toolInput: binding.input,
      });
      session.metadata = coordinated.metadata;
      return {
        outcome: 'complete' as const,
        executionId: reserved.reservation.reservationId,
        toolCallId,
        tool: binding.tool,
        toolVersion,
        input: binding.input,
        result: completeDocumentResult(),
        recordsReturned: 1,
      };
    },
  };
}

describe('Deep Research conversation continuity', () => {
  it.each(['goal', 'plan'] as const)(
    'withholds child findings from parent dispatch after a newer %s arrives',
    async (change) => {
      const f = fixture();
      await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
      jest.spyOn(f.service as any, 'runBoundedResearchChildren').mockImplementation(async () => {
        const session = f.getSession();
        session.metadata = {
          ...session.metadata,
          ...(change === 'goal'
            ? {
                durableCoordinator: {
                  ...session.metadata.durableCoordinator,
                  goalRevision: session.metadata.durableCoordinator.goalRevision + 1,
                },
              }
            : {
                researchPlan: { ...session.metadata.researchPlan, title: 'A newer approved goal' },
              }),
        };
        return [];
      });
      await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
      expect(f.runner.run).not.toHaveBeenCalled();
      expect(f.artifacts).toHaveLength(0);
    },
  );

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
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    const original = await f.runner.run(ctx, {}, f.auth);
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

  it('carries stored context/evidence/effort into both phases and withholds unsupported inherited private inputs', async () => {
    const f = fixture({ privateInheritedInputs: true });
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
    expect(runInput.user).toContain('three sensor manufacturing facilities');
    expect(runInput.user).toContain('The CEO');
    expect(runInput.user).toContain('Research sessionId: research-a');
    expect(runInput.handoff.reasoningMode).toBe('max');
    // The shared V3 chat runtime supplies the answer contract once in its
    // cached base; the report addendum preserves report-specific instructions.
    expect(runInput.system).not.toContain(MERI_GOVERNMENT_AFFAIRS_OUTPUT_CONTRACT);
    expect(runInput.system).toContain('REPORT REQUIREMENTS:');
    expect(f.credentials.resolveProviderByTenantId).not.toHaveBeenCalled();
    expect(f.tx.clioConversation.create).not.toHaveBeenCalled();
    expect(f.artifacts).toHaveLength(0);
    expect(f.getSession().status).toBe('failed');
    expect(readResearchHandoff(f.getSession().metadata)?.messages[0]?.body).toContain(
      'Exclude forecasted opportunities',
    );
    expect(f.events).toContainEqual({
      type: 'error',
      message: 'Research failed before report publication.',
    });
    expect(f.maintenance.scheduleAfterTurnMaintenance).not.toHaveBeenCalled();
  });

  it('does not mark a failed V3 run complete or switch provider', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    f.runner.run.mockRejectedValue(new Error('V3 provider unavailable'));
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(f.artifacts).toHaveLength(0);
    expect(f.getSession().status).toBe('failed');
    expect(f.events).toContainEqual({
      type: 'error',
      message: 'Research failed before report publication.',
    });
    expect(f.events.at(-1)).toEqual({ type: 'done' });
    expect(f.credentials.resolveProvider).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'partial', 'lease'])(
    'persists ordinary provider prose containing %s as a generic failed run',
    async (word) => {
      const privateError = `Unrelated provider ${word} prose PRIVATE_FAILURE_DETAIL`;
      const f = fixture();
      await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
      f.runner.run.mockRejectedValue(new Error(privateError));

      await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);

      expect(f.getSession().metadata.run.status).toBe('failed');
      expect(f.getSession().metadata.run.failureReason).toBe(RESEARCH_RUN_FAILURE);
      expect(f.events).toContainEqual({ type: 'error', message: RESEARCH_RUN_FAILURE });
      expect(JSON.stringify(f.events)).not.toContain(privateError);
      expect(f.artifacts).toHaveLength(0);
      expect(f.messages.some((message) => message.role === 'assistant')).toBe(false);
    },
  );

  it('does not substitute a successful deterministic plan for a failed V3 plan', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    f.runner.plan.mockRejectedValue(new Error('V3 provider unavailable'));
    await f.service.streamPlan(ctx, 'research-a', f.sse, f.auth);
    expect(f.getSession().status).toBe('failed');
    expect(f.events.some((event) => event.type === 'plan')).toBe(false);
    expect(f.events).toContainEqual({
      type: 'error',
      message: 'Research failed before report publication.',
    });
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
    const f = fixture({ privateInheritedInputs: true });
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    const result = {
      reportBody: 'Client context [S:get_research_evidence:prior-file]',
      model: 'same-chat-model',
      sources: [],
      toolsUsed: [],
      ledgerEntries: [],
      citations: [],
    };
    f.runner.run.mockResolvedValue(result as never);
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(result.ledgerEntries).toHaveLength(0);
    expect(f.artifacts).toHaveLength(0);
    expect(f.events.some((event) => event.type === 'report')).toBe(false);
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
    const result = await f.runner.run(ctx, {}, f.auth);
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
    const result = await f.runner.run(ctx, {}, f.auth);
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
    const result = await f.runner.run(ctx, {}, f.auth);
    f.runner.run.mockClear();
    f.runner.run.mockImplementationOnce(async () => {
      ready.resolve();
      await release.promise;
      return result;
    });
    const old = f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    await ready.promise;
    expect(f.getSession().metadata.run.leaseEpoch).toBe(1);
    f.getSession().metadata.run.heartbeatAt = new Date(Date.now() - 180_000).toISOString();
    expect((await f.service.getSession(ctx, 'research-a')).run?.status).toBe('interrupted');
    await f.replica().streamResearch(ctx, 'research-a', f.sse, {
      ...f.auth,
      resumeRunId: f.getSession().metadata.run.id,
    });
    release.resolve();
    await old;
    expect(f.artifacts).toHaveLength(1);
    expect(f.getSession().metadata.run).toMatchObject({ status: 'complete', leaseEpoch: 2 });
    expect(f.runner.run).toHaveBeenCalledTimes(2);
    const recovered = f.runner.run.mock.calls[1]?.[1] as any;
    expect(recovered.handoff.attachments).toEqual([]);
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
    const recoveredBody = (await f.service.getSession(ctx, 'research-a')).report?.bodyText;
    expect(recoveredBody).toContain('manufacturing footprint');
    expect(recoveredBody).toContain('[S:read_client_documents:prior-file]');
  });

  it('persists a fenced safe-read receipt before notifying the observer and preserves it at terminal replay', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    const result = await f.runner.run(ctx, {}, f.auth);
    delete f.getSession().metadata.durableStepReceipts;
    f.runner.run.mockClear();
    f.runner.run.mockImplementation(async (...args: any[]) => {
      const onEvent = args[3] as (event: Record<string, unknown>) => void;
      onEvent({
        type: 'source',
        source: {
          tool: 'read_client_documents',
          label: 'Read client document',
          summary: 'SECRET_ROW_LABEL: raw client result',
          confidence: 'high',
        },
        durableSafeRead: f.durableDocumentRead('call-client-context-1'),
      });
      return result;
    });
    let persistedBeforeWrite = false;
    const observed: any[] = [];
    await f.service.streamResearch(
      ctx,
      'research-a',
      {
        write: (data: string) => {
          const event = JSON.parse(data.replace(/^data: /, '').trim());
          observed.push(event);
          if (event.type === 'source') {
            persistedBeforeWrite = f.getSession().metadata.durableStepReceipts?.length === 1;
          }
        },
      },
      f.auth,
    );

    expect(persistedBeforeWrite).toBe(true);
    const sourceSequence = observed.find((event) => event.type === 'source')?.sequence;
    expect(sourceSequence).toEqual(expect.any(Number));
    expect(sourceSequence).toBeGreaterThan(0);
    expect(f.getSession().metadata.durableStepReceipts).toEqual([
      expect.objectContaining({
        leaseEpoch: 1,
        sequence: sourceSequence,
        effectClass: 'safe_read',
        toolCallId: 'call-client-context-1',
        tool: 'read_client_documents',
        status: 'complete',
        summary: 'Authorized read completed',
      }),
    ]);
    expect(JSON.stringify(f.getSession().metadata.durableStepReceipts)).not.toContain(
      'SECRET_ROW_LABEL',
    );
    expect(f.getSession().metadata.run).toMatchObject({
      status: 'complete',
      leaseEpoch: 1,
    });
    expect(f.getSession().metadata.run.eventSequence).toBeGreaterThanOrEqual(sourceSequence);

    await f.replica().streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(f.runner.run).toHaveBeenCalledTimes(1);
    expect(f.events.at(-1)).toEqual({ type: 'done' });
  });

  it.each(['revoke', 'archive', 'changeClient'] as const)(
    'rechecks %s after receipt commit and before publishing its source frame',
    async (change) => {
      const f = fixture();
      await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
      const result = await f.runner.run(ctx, {}, f.auth);
      delete f.getSession().metadata.durableStepReceipts;
      f.runner.run.mockImplementation(async (...args: any[]) => {
        const onEvent = args[3] as (event: Record<string, unknown>) => void;
        onEvent({
          type: 'source',
          source: {
            tool: 'read_client_documents',
            label: 'Read client document',
            summary: 'private row label',
            confidence: 'high',
          },
          durableSafeRead: f.durableDocumentRead(`call-${change}`),
        });
        return result;
      });
      f.afterReceipt(() => f[change]());
      await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
      expect(f.getSession().metadata.durableStepReceipts).toHaveLength(1);
      expect(f.events.some((event) => event.type === 'source')).toBe(false);
      expect(f.events.some((event) => event.type === 'error')).toBe(true);
      expect(f.events.at(-1)).toEqual({ type: 'done' });
    },
  );

  it('keeps terminal error and done notifications honest when receipt persistence fails', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    const result = await f.runner.run(ctx, {}, f.auth);
    delete f.getSession().metadata.durableStepReceipts;
    f.runner.run.mockImplementation(async (...args: any[]) => {
      const onEvent = args[3] as (event: Record<string, unknown>) => void;
      onEvent({
        type: 'source',
        source: {
          tool: 'read_client_documents',
          label: 'Read client document',
          summary: 'sensitive result',
          confidence: 'high',
        },
        durableSafeRead: f.durableDocumentRead('call-outage'),
      });
      return result;
    });
    f.failReceipts();
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(f.getSession().metadata.durableStepReceipts).toBeUndefined();
    expect(f.getSession().metadata.run.status).toBe('interrupted');
    expect(f.events).toContainEqual({
      type: 'error',
      message: 'Research lease is no longer active.',
    });
    expect(f.events.at(-1)).toEqual({ type: 'done' });
  });

  it('orders direct outer-catch terminal frames behind an outstanding receipt', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    await f.service.streamPlan(ctx, 'research-a', f.sse, f.auth);
    const barrier = f.holdReceipts();
    const observed: Array<Record<string, unknown>> = [];
    const output = {
      write: (data: string) => observed.push(JSON.parse(data.replace(/^data: /, '').trim())),
    };
    const run = (f.service as any).withResearchRun(
      ctx,
      'research-a',
      'research',
      output,
      f.auth,
      async (sink: { writeReceiptCandidate: (event: Record<string, unknown>) => void }) => {
        sink.writeReceiptCandidate({
          type: 'source',
          source: {
            tool: 'read_client_documents',
            label: 'Research source',
            summary: 'Authorized read completed',
            confidence: 'high',
          },
          durableSafeRead: f.durableDocumentRead('call-outer-catch'),
        });
        throw new Error('Outer execute failed');
      },
    );

    await barrier.entered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const terminalReleasedWhileReceiptPending = observed.some(
      (event) => event.type === 'error' || event.type === 'done',
    );
    barrier.release();
    await run;
    expect(terminalReleasedWhileReceiptPending).toBe(false);
    const sourceIndex = observed.findIndex((event) => event.type === 'source');
    const errorIndex = observed.findIndex((event) => event.type === 'error');
    expect(errorIndex).toBeGreaterThan(sourceIndex);
    expect(observed.at(-1)).toEqual({ type: 'done' });
  });

  it('publishes a canonical legacy source only after its durable owner receipt and report save', async () => {
    const originalFetch = global.fetch;
    const f = fixture();
    f.runner.enabled.mockResolvedValue(false);
    f.credentials.resolveProvider.mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'local-placeholder',
      model: 'claude-sonnet-5',
    });
    f.tools.execute.mockResolvedValue(completeDocumentResult());
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        providerResponse([
          {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call-document-success',
              name: 'read_client_documents',
            },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'input_json_delta',
              partial_json: '{"documentId":"prior-file"}',
            },
          },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        ]),
      )
      .mockResolvedValueOnce(
        providerResponse([
          {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: '# Report\n\nAuthorized legacy evidence. [S:read_client_documents:prior-file]',
            },
          },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]),
      ) as unknown as typeof fetch;

    try {
      await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
      const admitted = JSON.parse(await f.runner.plan(ctx, {}));
      admitted.steps = [{ ...admitted.steps[1], dependsOn: [], budget: { ...admitted.budget } }];
      f.getSession().metadata.researchPlan = admitted;
      f.getSession().plan = admitted.steps.map((step: any) => step.objective);
      await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);

      expect(f.tools.execute).toHaveBeenCalled();
      expect(f.getSession().metadata.durableStepReceipts).toHaveLength(1);
      const source = f.events.find((event) => event.type === 'source');
      expect(source?.source).toEqual({
        tool: 'read_client_documents',
        label: 'Research source',
        summary: 'Authorized read completed',
        confidence: 'high',
      });
      expect(source?.durableSafeRead).toMatchObject({
        persisted: true,
        tool: 'read_client_documents',
        status: 'complete',
      });
      expect(source?.durableSafeRead).not.toHaveProperty('input');
      expect(source?.durableSafeRead).not.toHaveProperty('result');
      expect(f.events.find((event) => event.type === 'report')?.body).toContain(
        'Authorized legacy evidence',
      );
      const reportArtifact = f.artifacts.find((artifact) => artifact.kind === 'research_report');
      expect(reportArtifact?.bodyText).toContain('Authorized legacy evidence');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it.each([
    {
      name: 'logical SSE error followed by text and end_turn',
      stream:
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PRIVATE_REPORT_BODY"}}\n\n' +
        'data: {"type":"error","error":{"message":"PRIVATE_PROVIDER_ERROR"}}\n\n' +
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      loseResponse: false,
      expectedMessage: RESEARCH_PROVIDER_FAILURE,
      expectedStatus: 'failed',
    },
    {
      name: 'HTTP 200 logical error body without SSE framing',
      stream: '{"type":"error","error":{"message":"PRIVATE_HTTP_200_ERROR"}}',
      loseResponse: false,
      expectedMessage: RESEARCH_PROVIDER_FAILURE,
      expectedStatus: 'failed',
    },
    {
      name: 'malformed trailing provider frame after end_turn',
      stream:
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PRIVATE_REPORT_BODY"}}\n\n' +
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
        'data: {"type":"content_block_delta"',
      loseResponse: false,
      expectedMessage: RESEARCH_PARTIAL,
      expectedStatus: 'partial',
    },
    {
      name: 'response loss after end_turn',
      stream:
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PRIVATE_REPORT_BODY"}}\n\n' +
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      loseResponse: true,
      expectedMessage: RESEARCH_PARTIAL,
      expectedStatus: 'partial',
    },
  ])(
    'does not save or publish a legacy report after $name',
    async ({ stream, loseResponse, expectedMessage, expectedStatus }) => {
      const originalFetch = global.fetch;
      const f = fixture();
      f.runner.enabled.mockResolvedValue(false);
      f.credentials.resolveProvider.mockResolvedValue({
        provider: 'anthropic',
        apiKey: 'local-provider-key',
      });
      const bytes = new TextEncoder().encode(stream);
      global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '',
        body: {
          async *[Symbol.asyncIterator]() {
            yield bytes;
            if (loseResponse) throw new Error('PRIVATE_RESPONSE_LOSS');
          },
        },
      })) as unknown as typeof fetch;

      try {
        await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
        const admitted = JSON.parse(await f.runner.plan(ctx, {}));
        f.getSession().metadata.researchPlan = admitted;
        f.getSession().plan = admitted.steps.map((step: any) => step.objective);
        await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(f.getSession().metadata.run.status).toBe(expectedStatus);
        expect(f.getSession().metadata.run.failureReason).toBe(expectedMessage);
        expect(f.artifacts).toHaveLength(0);
        expect(f.messages.some((message) => message.role === 'assistant')).toBe(false);
        expect(f.events.some((event) => event.type === 'text' || event.type === 'report')).toBe(
          false,
        );
        expect(f.events).toContainEqual({ type: 'error', message: expectedMessage });
        expect(f.events.at(-1)).toEqual({ type: 'done' });
        expect(JSON.stringify(f.events)).not.toContain('PRIVATE_');
      } finally {
        global.fetch = originalFetch;
      }
    },
  );

  it('does not authorize forced synthesis for a name-only AbortError from the provider', async () => {
    const originalFetch = global.fetch;
    const f = fixture();
    f.runner.enabled.mockResolvedValue(false);
    f.credentials.resolveProvider.mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'local-provider-key',
      model: 'claude-sonnet-5',
    });
    const providerError = new Error('PRIVATE_ABORT_NAMED_PROVIDER_FAILURE');
    providerError.name = 'AbortError';
    global.fetch = jest
      .fn()
      .mockRejectedValueOnce(providerError)
      .mockResolvedValueOnce(
        providerResponse([
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: '# Unauthorized synthesis' },
          },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]),
      ) as unknown as typeof fetch;

    try {
      await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
      const admitted = JSON.parse(await f.runner.plan(ctx, {}));
      f.getSession().metadata.researchPlan = admitted;
      f.getSession().plan = admitted.steps.map((step: any) => step.objective);
      await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(f.getSession().status).toBe('failed');
      expect(f.getSession().metadata.run).toMatchObject({
        status: 'failed',
        failureReason: RESEARCH_PROVIDER_FAILURE,
      });
      expect(f.artifacts).toHaveLength(0);
      expect(f.messages.some((message) => message.role === 'assistant')).toBe(false);
      expect(f.events.some((event) => event.type === 'text' || event.type === 'report')).toBe(
        false,
      );
      expect(f.events).toContainEqual({ type: 'error', message: RESEARCH_PROVIDER_FAILURE });
      expect(JSON.stringify(f.events)).not.toContain('PRIVATE_');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it.each([
    {
      name: 'invalid UTF-8 inside an otherwise valid JSON event',
      chunks: () => [
        new TextEncoder().encode(
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"bad',
        ),
        Uint8Array.of(0xff),
        new TextEncoder().encode(
          'bytes"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        ),
      ],
    },
    {
      name: 'an over-limit SSE line',
      chunks: () => [new TextEncoder().encode(`data: ${'x'.repeat(1024 * 1024)}\n`)],
    },
    {
      name: 'an over-limit total response made of bounded lines',
      chunks: () =>
        Array.from({ length: 17 }, () =>
          new TextEncoder().encode(`:${'x'.repeat(512 * 1024 - 2)}\n`),
        ),
    },
  ])('does not save or publish after $name', async ({ chunks }) => {
    const originalFetch = global.fetch;
    const f = fixture();
    f.runner.enabled.mockResolvedValue(false);
    f.credentials.resolveProvider.mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'local-provider-key',
      model: 'claude-sonnet-5',
    });
    global.fetch = jest.fn(async () => rawProviderResponse(chunks())) as unknown as typeof fetch;

    try {
      await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
      const admitted = JSON.parse(await f.runner.plan(ctx, {}));
      f.getSession().metadata.researchPlan = admitted;
      f.getSession().plan = admitted.steps.map((step: any) => step.objective);
      await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(f.getSession().status).toBe('failed');
      expect(f.getSession().metadata.run).toMatchObject({
        status: 'partial',
        failureReason: RESEARCH_PARTIAL,
      });
      expect(f.artifacts).toHaveLength(0);
      expect(f.messages.some((message) => message.role === 'assistant')).toBe(false);
      expect(f.events.some((event) => event.type === 'text' || event.type === 'report')).toBe(
        false,
      );
      expect(f.events).toContainEqual({ type: 'error', message: RESEARCH_PARTIAL });
      expect(f.events.at(-1)).toEqual({ type: 'done' });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('forces synthesis only after the gather controller actually times out', async () => {
    const originalFetch = global.fetch;
    const f = fixture({ legacyConfig: { CLIO_RESEARCH_TIMEOUT_MS: 10 } });
    f.runner.enabled.mockResolvedValue(false);
    f.credentials.resolveProvider.mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'local-provider-key',
      model: 'claude-sonnet-5',
    });
    const report = '# Report\n\nAuthorized synthesis after a real gather timeout.';
    global.fetch = jest
      .fn()
      .mockImplementationOnce(
        async (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return reject(new Error('Missing gather signal'));
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      )
      .mockResolvedValueOnce(
        providerResponse([
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: report },
          },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]),
      ) as unknown as typeof fetch;

    try {
      await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
      const admitted = JSON.parse(await f.runner.plan(ctx, {}));
      f.getSession().metadata.researchPlan = admitted;
      f.getSession().plan = admitted.steps.map((step: any) => step.objective);
      await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(f.getSession().status).toBe('complete');
      expect(f.getSession().metadata.run.status).toBe('complete');
      expect(f.artifacts).toHaveLength(1);
      expect(f.artifacts[0]?.bodyText).toContain(report);
      expect(f.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
      expect(f.events.find((event) => event.type === 'text')?.text).toContain(report);
      expect(f.events.find((event) => event.type === 'report')?.body).toContain(report);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('persists intact fragmented UTF-8 with Anthropic metadata, pings, CRLF, and end marker', async () => {
    const originalFetch = global.fetch;
    const f = fixture();
    f.runner.enabled.mockResolvedValue(false);
    f.credentials.resolveProvider.mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'local-provider-key',
      model: 'claude-sonnet-5',
    });
    const report = '# Report\n\nCafé evidence.';
    const wire =
      'event: message_start\r\ndata: {"type":"message_start","message":{"id":"msg-1"}}\r\n\r\n' +
      'event: ping\r\ndata: {"type":"ping"}\r\n\r\n' +
      `event: content_block_delta\r\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: report } })}\r\n\r\n` +
      'event: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\r\n\r\n' +
      'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes = new TextEncoder().encode(wire);
    const split = bytes.indexOf(0xc3) + 1;
    global.fetch = jest.fn(async () =>
      rawProviderResponse([
        bytes.subarray(0, split),
        bytes.subarray(split, split + 1),
        bytes.subarray(split + 1),
      ]),
    ) as unknown as typeof fetch;

    try {
      await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
      const admitted = JSON.parse(await f.runner.plan(ctx, {}));
      f.getSession().metadata.researchPlan = admitted;
      f.getSession().plan = admitted.steps.map((step: any) => step.objective);
      await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(f.getSession().status).toBe('complete');
      expect(f.getSession().metadata.run.status).toBe('complete');
      expect(f.artifacts).toHaveLength(1);
      expect(f.artifacts[0]?.bodyText).toContain(report);
      expect(f.artifacts[0]?.bodyText).not.toContain('\ufffd');
      expect(f.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
      expect(f.events.find((event) => event.type === 'text')?.text).toContain(report);
      expect(f.events.find((event) => event.type === 'report')?.body).toContain(report);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not save or publish when the forced-synthesis stream returns a logical error', async () => {
    const originalFetch = global.fetch;
    const f = fixture();
    f.runner.enabled.mockResolvedValue(false);
    f.credentials.resolveProvider.mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'local-provider-key',
    });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        providerResponse([{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }]),
      )
      .mockResolvedValueOnce(
        providerResponse([
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'PRIVATE_SYNTHESIS_REPORT' },
          },
          { type: 'error', error: { message: 'PRIVATE_SYNTHESIS_ERROR' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]),
      ) as unknown as typeof fetch;

    try {
      await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
      const admitted = JSON.parse(await f.runner.plan(ctx, {}));
      f.getSession().metadata.researchPlan = admitted;
      f.getSession().plan = admitted.steps.map((step: any) => step.objective);
      await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(f.getSession().metadata.run).toMatchObject({
        status: 'failed',
        failureReason: RESEARCH_PROVIDER_FAILURE,
      });
      expect(f.artifacts).toHaveLength(0);
      expect(f.messages.some((message) => message.role === 'assistant')).toBe(false);
      expect(f.events.some((event) => event.type === 'text' || event.type === 'report')).toBe(
        false,
      );
      expect(f.events).toContainEqual({ type: 'error', message: RESEARCH_PROVIDER_FAILURE });
      expect(JSON.stringify(f.events)).not.toContain('PRIVATE_');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not mint a durable receipt or archived source from a resolved search_memory error', async () => {
    const originalFetch = global.fetch;
    const f = fixture();
    f.runner.enabled.mockResolvedValue(false);
    f.credentials.resolveProvider.mockResolvedValue({
      provider: 'anthropic',
      apiKey: 'test-key',
      model: 'claude-sonnet-5',
    });
    f.tools.execute.mockResolvedValue({ error: 'Provide a search query.' });
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        providerResponse([
          {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'call-memory-error',
              name: 'search_memory',
            },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{}' },
          },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        ]),
      )
      .mockResolvedValueOnce(
        providerResponse([
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: '# Report\n\nNo memory evidence was available.' },
          },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ]),
      ) as unknown as typeof fetch;

    try {
      await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
      // This legacy-runtime outcome test begins at gather. Seed an already admitted
      // v1 contract so the new pre-dispatch boundary does not consume its two
      // provider responses as legacy-plan migration calls.
      const admitted = JSON.parse(await f.runner.plan(ctx, {}));
      f.getSession().metadata.researchPlan = admitted;
      f.getSession().plan = admitted.steps.map((step: any) => step.objective);
      await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);

      expect(f.getSession().metadata.durableStepReceipts).toBeUndefined();
      expect(f.getSession().sources).toEqual([]);
      expect(f.artifacts[0]?.metadata).toMatchObject({ sourceCount: 0, toolsUsed: [] });
      expect(f.events.some((event) => event.type === 'source')).toBe(false);
      expect(JSON.stringify(f.events)).not.toContain('Provide a search query.');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not let an expired owner write failure state before any successor exists', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    f.runner.run.mockImplementation(async () => {
      f.getSession().metadata.run.heartbeatAt = new Date(Date.now() - 180_000).toISOString();
      throw new Error('Provider failed after suspension');
    });
    await f.service.streamResearch(ctx, 'research-a', f.sse, f.auth);
    expect(f.getSession().status).toBe('researching');
    expect(f.getSession().metadata.run.status).toBe('running');
    expect((await f.service.getSession(ctx, 'research-a')).run?.status).toBe('interrupted');
    expect(f.events).toContainEqual({
      type: 'error',
      message: 'Research failed before report publication.',
    });
    expect(f.events.at(-1)).toEqual({ type: 'done' });
  });

  it('keeps incomplete provider output partial and never labels it as a completed report', async () => {
    const f = fixture();
    await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    f.runner.run.mockRejectedValue(
      new ResearchTerminalError('partial', 'Research did not complete (max_output_tokens).'),
    );
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
        failureReason: 'Research lease is no longer active.',
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

describe('Stage 2 job kinds stay dark behind meri.jobs', () => {
  it('research is the default kind and needs no flag', async () => {
    const f = fixture();
    const created = await f.service.createSession(ctx, { topic: 'Briefing', conversationId: 'thread-a' });
    expect(created).toMatchObject({ kind: 'research' });
    expect(f.getSession().kind).toBe('research');
  });

  it('refuses a non-research kind while the tenant flag is off, and creates nothing', async () => {
    const f = fixture();
    await expect(
      f.service.createSession(ctx, { topic: 'Office brief', conversationId: 'thread-a', kind: 'deliverable' }),
    ).rejects.toThrow('meri_jobs_disabled');
    expect(f.getSession()).toBeUndefined();
  });

  it('creates a deliverable job when the tenant flag is on and reports it as queued', async () => {
    const f = fixture({ tenantSettings: { clioFeatureFlags: { 'meri.jobs': true } } });
    await f.service.createSession(ctx, {
      topic: 'Office brief',
      conversationId: 'thread-a',
      kind: 'deliverable',
    });
    expect(f.getSession().kind).toBe('deliverable');
    const view = await f.service.getSession(ctx, 'research-a');
    expect(view.job).toMatchObject({ kind: 'deliverable', status: 'queued', awaitingStart: true });
  });

  it('records one Word deliverable for a deliverable job, titled by the request', async () => {
    const f = fixture({ tenantSettings: { clioFeatureFlags: { 'meri.jobs': true } } });
    await f.service.createSession(ctx, {
      topic: 'Office brief on HR 1',
      conversationId: 'thread-a',
      kind: 'deliverable',
      deliverables: [{ format: 'docx', title: 'HR 1 office brief' }],
    });
    expect(f.getSession().deliverables).toEqual([
      { format: 'docx', title: 'HR 1 office brief', artifactId: null },
    ]);
    const view = await f.service.getSession(ctx, 'research-a');
    expect(view.job?.deliverables).toEqual([
      { format: 'docx', title: 'HR 1 office brief', artifactId: null },
    ]);
  });

  it.each([
    ['deliverables on a research job', { kind: 'research', deliverables: [{ format: 'docx' }] }],
    ['an unsupported format', { kind: 'deliverable', deliverables: [{ format: 'xlsx' }] }],
  ] as const)('refuses %s and creates nothing', async (_label, request) => {
    const f = fixture({ tenantSettings: { clioFeatureFlags: { 'meri.jobs': true } } });
    await expect(
      f.service.createSession(ctx, {
        topic: 'Office brief',
        conversationId: 'thread-a',
        ...request,
      } as never),
    ).rejects.toThrow(/deliverable/i);
    expect(f.getSession()).toBeUndefined();
  });
});
