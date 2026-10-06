import { createHash } from 'node:crypto';
import { EngagementService } from '../engagement/engagement.service';
import { MeriResearchService } from './meri-research.service';
import { researchToolVersion } from './meri-research-durable-result';
import { readDurableResearchStepReceipts } from './meri-research-durable-step';
import { MeriToolsService } from './meri-tools.service';
import { readResearchToolBudget, reserveResearchToolAttempt } from './meri-research-tool-budget';
import {
  readDurableResearchCoordinator,
  reserveDurableResearchStep,
} from './meri-research-coordinator';
import {
  buildResearchReportProvenance,
  certifyResearchProducerInputs,
} from './meri-report-provenance';
import { buildDebriefReadResult, parseDebriefReadInput } from './meri-debrief-read.helpers';
import {
  buildMeetingSourceResult,
  parseMeetingReadInput,
  type ExactMeetingSource,
  type MeetingReadRow,
} from './meri-meeting-read.helpers';

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
const MAIL_SEARCH_TOOL_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' }, asOf: { type: 'string' } },
};
const MAIL_SEARCH_TOOL_VERSION = researchToolVersion(MAIL_SEARCH_TOOL_SCHEMA);
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

const MEETING_CLIENT_ID = '33333333-3333-4333-8333-333333333333';
const MEETING_SCHEMA = {
  type: 'object',
  properties: {
    clientId: { type: 'string' },
    meetingId: { type: 'string' },
    sourceKind: { type: 'string' },
    sourceId: { type: 'string' },
    characterLimit: { type: 'integer' },
  },
  required: ['clientId'],
};
const MEETING_VERSION = researchToolVersion(MEETING_SCHEMA);
const MEETING_INPUT = {
  clientId: MEETING_CLIENT_ID,
  meetingId: 'meeting-1',
  sourceKind: 'transcript',
  sourceId: 'transcript-1',
  characterLimit: 6_000,
};

function completeMeetingSourceResult(
  body = 'PRIVATE EXACT AUTHORIZED TRANSCRIPT SOURCE',
  sourceVersion = 'version-1',
) {
  const contentHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const selection = parseMeetingReadInput(ctx, MEETING_INPUT, MEETING_CLIENT_ID);
  const meeting: MeetingReadRow = {
    id: 'meeting-1',
    clientId: MEETING_CLIENT_ID,
    subject: 'Client review',
    startsAt: '2026-09-19T14:00:00.000Z',
    endsAt: '2026-09-19T15:00:00.000Z',
    status: 'completed',
    updatedAt: '2026-09-19T16:00:00.000Z',
    sources: [],
    sourceAvailability: { notes: 'empty', transcript: 'available', transcriptReason: null },
  };
  const source: ExactMeetingSource = {
    sourceKind: 'transcript',
    sourceId: 'transcript-1',
    meetingId: 'meeting-1',
    clientId: MEETING_CLIENT_ID,
    lifecycleStatus: 'ready',
    availability: 'available',
    availabilityReason: null,
    body,
    contentHash,
    sourceVersion,
    createdAt: '2026-09-19T16:00:00.000Z',
    updatedAt: '2026-09-19T16:00:00.000Z',
  };
  return buildMeetingSourceResult(ctx, selection, meeting, source);
}

function completeDebriefResult(
  body = 'PRIVATE EXACT DEBRIEF SOURCE',
  updatedAt = '2026-09-21T10:00:00.000Z',
) {
  const selection = parseDebriefReadInput(ctx, DEBRIEF_INPUT, 'client-1');
  return buildDebriefReadResult(ctx, selection, {
    rows: [
      {
        id: 'debrief-1',
        meetingId: 'meeting-1',
        clientId: 'client-1',
        body,
        status: 'approved',
        authorUserId: 'user-1',
        author: {
          id: 'user-1',
          email: 'owner@example.com',
          firstName: 'Owner',
          lastName: 'One',
        },
        createdAt: new Date('2026-09-20T10:00:00.000Z'),
        updatedAt: new Date(updatedAt),
        meeting: {
          id: 'meeting-1',
          clientId: 'client-1',
          subject: 'Client review',
          startsAt: new Date('2026-09-19T14:00:00.000Z'),
        },
      },
    ],
    sourceStatus: 'healthy',
    sourceReason: null,
    nextAfter: null,
  });
}

function emptyMemoryResult() {
  return { ...completeMemoryResult('memory-1'), contentStatus: 'empty', results: [], records: [] };
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
    records: [
      {
        domain: 'institutional_knowledge',
        recordId: id,
        updatedAt: '2026-09-28T00:00:00.000Z',
        provenance: { sourceVersion: 'memory-v1', contentHash },
        payload: {
          sourceKind: 'governed_memory',
          memoryItemId: id,
          clientId: null,
          content: { hash: contentHash },
          value: body,
        },
      },
    ],
  };
}

function completeMailThreadResult(
  body = 'Exact complete canonical mail body.',
  messageUpdatedAt = '2026-09-28T00:01:00.000Z',
  clientId: string | null = null,
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
      clientId,
      threadUpdatedAt: '2026-09-28T00:00:00.000Z',
    },
    messages: [
      {
        id: messageId,
        threadId,
        subject: 'Canonical source',
        from: { email: 'sender@example.test', name: 'Sender' },
        to: [{ email: 'owner@example.test', name: 'Owner' }],
        cc: [],
        sentAt: '2026-09-27T12:00:00.000Z',
        receivedAt: null,
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
      },
    ],
  };
}

function completeMailSearchResult(asOf = '2026-09-28T00:00:00.000Z') {
  return {
    totalMatches: 0,
    returned: 0,
    hasMore: false,
    offset: 0,
    nextOffset: null,
    asOf,
    queryScope: {
      query: 'Report',
      from: null,
      participant: null,
      clientId: null,
      folder: 'all',
      withinDays: null,
      asOf,
    },
    timeWindow: { start: null, end: asOf },
    folder: 'all',
    clientId: null,
    messages: [],
    searchedMailboxes: [
      {
        accountEmail: 'owner@example.test',
        sourceProof: { version: 1, mailboxId: 'mailbox-1' },
        provider: 'google_workspace',
        status: 'connected',
        lastSyncAt: '2026-09-28T00:00:00.000Z',
        connectionLastSyncAt: '2026-09-28T00:00:00.000Z',
        syncedMessages: 0,
        syncedRange: null,
        mailCoverage: {
          sourceStatus: 'healthy',
          reason: null,
          lastMailSyncAt: '2026-09-28T00:00:00.000Z',
          lastConnectionSyncAt: '2026-09-28T00:00:00.000Z',
          backfillComplete: true,
          hasMore: false,
          captureRepair: 'complete',
        },
      },
    ],
    notes: ['Canonical bounded mail result.'],
  };
}

const MAILBOX_ID = '44444444-4444-4444-8444-444444444444';
const MAPPED_AS_OF = new Date('2026-09-28T12:00:00.000Z');

async function mappedMailThread(clientId: string | null) {
  const threadId = '11111111-1111-4111-8111-111111111111';
  const engagement = Object.create(EngagementService.prototype) as any;
  engagement.prisma = {
    withTenant: async (_tenantId: string, callback: any) =>
      callback({
        mailThread: {
          findFirst: jest.fn(async () => ({
            id: threadId,
            connectionId: MAILBOX_ID,
            clientId,
            subject: 'Mapped canonical source',
            updatedAt: new Date('2026-09-28T00:00:00.000Z'),
            connection: { accountEmail: 'owner@example.test', status: 'connected' },
            messages: [
              {
                id: '22222222-2222-4222-8222-222222222222',
                connectionId: MAILBOX_ID,
                subject: 'Mapped canonical source',
                bodyText: 'ACTUAL_MAPPED_MAIL_BODY',
                updatedAt: new Date('2026-09-28T00:01:00.000Z'),
                metadata: { bodyCompleteness: 'full' },
                fromEmail: 'sender@example.test',
                fromName: 'Sender',
                toRecipients: [],
                ccRecipients: [],
                sentAt: new Date('2026-09-27T12:00:00.000Z'),
                receivedAt: null,
              },
            ],
          })),
        },
      }),
  };
  const tools = Object.create(MeriToolsService.prototype) as any;
  tools.engagement = engagement;
  return tools.getEmailThread(ctx, { threadId });
}

function mappedMailRow(index: number, clientId: string | null) {
  return {
    id: `22222222-2222-4222-8222-22222222222${index}`,
    thread_id: `11111111-1111-4111-8111-11111111111${index}`,
    connection_id: MAILBOX_ID,
    message_updated_at: MAPPED_AS_OF,
    subject: `Mapped source ${index}`,
    from_email: 'sender@example.test',
    from_name: 'Sender',
    to_recipients: [],
    cc_recipients: [],
    sent_at: new Date(`2026-09-28T0${index}:00:00.000Z`),
    received_at: null,
    preview: `Mapped preview ${index}`,
    has_attachments: false,
    folder: 'inbox',
    internet_message_id: `<mapped-${index}@example.test>`,
    client_id: clientId,
    client_name: clientId ? `Client ${index}` : null,
    account_email: 'owner@example.test',
  };
}

async function mappedMailSearch(
  tool: 'search_emails' | 'list_emails',
  clientIds: Array<string | null>,
) {
  const rows = clientIds.map((clientId, index) => mappedMailRow(index + 1, clientId));
  const coverage = [
    {
      connection_id: MAILBOX_ID,
      account_email: 'owner@example.test',
      provider: 'google_workspace',
      status: 'connected',
      last_sync_at: MAPPED_AS_OF,
      sync_state: {
        mail: {
          captureVersion: 1,
          updatedAt: MAPPED_AS_OF.toISOString(),
          historyId: 'history-1',
          labels: { ALL: { backfillDone: true } },
        },
      },
      synced_messages: rows.length,
      oldest_synced: MAPPED_AS_OF,
      newest_synced: MAPPED_AS_OF,
    },
  ];
  const queries = jest
    .fn()
    .mockResolvedValueOnce([{ n: rows.length }])
    .mockResolvedValueOnce(rows)
    .mockResolvedValueOnce(coverage);
  const engagement = Object.create(EngagementService.prototype) as any;
  engagement.prisma = {
    withTenant: async (_tenantId: string, callback: any) => callback({ $queryRaw: queries }),
  };
  const tools = Object.create(MeriToolsService.prototype) as any;
  tools.engagement = engagement;
  const input = { query: 'Report', asOf: MAPPED_AS_OF.toISOString() };
  return tool === 'list_emails' ? tools.listEmails(ctx, input) : tools.searchEmails(ctx, input);
}

function harness(
  options: {
    tool?:
      | 'search_memory'
      | 'get_email_thread'
      | 'search_emails'
      | 'list_emails'
      | 'read_client_meetings'
      | 'query_debriefs';
    schema?: Record<string, unknown>;
    source?: unknown;
    clientId?: string | null;
    wallAllowed?: boolean;
  } = {},
) {
  const ownerTool = options.tool ?? 'search_memory';
  const ownerSchema = options.schema ?? TOOL_SCHEMA;
  let authorizationAllowed = true;
  let wallAllowed = options.wallAllowed !== false;
  let sourceAllowed = true;
  let clientDuringExecute: string | null | undefined;
  let currentSource: unknown = options.source ?? completeMemoryResult('execution-1');
  const artifacts = new Map<string, Record<string, any>>();
  const session: Record<string, any> = {
    id: 'session-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    clientId: options.clientId ?? null,
    title: 'Durable replay',
    topic: 'topic',
    status: 'researching',
    reportArtifactId: null,
    metadata: {
      researchPlan: {
        version: 1,
        title: 'Durable replay test',
        scope: {
          sessionId: 'session-1',
          tenantId: 'tenant-1',
          actorId: 'user-1',
          clientId: options.clientId ?? null,
          conversationId: 'conversation-1',
        },
        budget: { toolCalls: 48, tokens: 1_000 },
        steps: [
          {
            id: 'read',
            objective: 'Read memory',
            dependsOn: [],
            requiredEvidenceDomains: ['institutional_memory'],
            allowedCapabilities: [ownerTool],
            effect: 'read',
            completionCondition: 'Evidence captured',
            budget: { toolCalls: 48, tokens: 1_000 },
          },
        ],
        clarifyingQuestions: [],
      },
      handoff: {
        version: 1,
        conversationId: 'conversation-1',
        clientId: options.clientId ?? null,
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
      findMany: jest.fn(async () => (artifacts.has('report-1') ? [artifacts.get('report-1')] : [])),
    },
    $queryRawUnsafe: jest.fn(async (...args: any[]) => {
      if (String(args[0]).startsWith('SELECT (NOT c.memory_wall'))
        return [{ allowed: wallAllowed }];
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
      if (clientDuringExecute !== undefined) session.clientId = clientDuringExecute;
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
  const commit = service.commitSafeReadOutcome.bind(service);
  service.commitSafeReadOutcome = (async (
    actor: typeof ctx,
    sessionId: string,
    runId: string,
    input: Parameters<typeof commit>[3],
  ) => {
    const currentRun = session.metadata.run;
    if (
      currentRun?.id === runId &&
      currentRun?.leaseEpoch === input.leaseEpoch &&
      currentRun?.status === 'running'
    ) {
      const reserved = reserveResearchToolAttempt({
        metadata: session.metadata,
        run: currentRun,
        plan: session.metadata.researchPlan,
        binding: {
          providerCallId: input.providerCallId,
          kind: 'dispatch',
          tool: input.tool,
          toolVersion: input.toolVersion,
          input: input.input,
        },
        reservationId: input.executionId,
      });
      const coordinator = readDurableResearchCoordinator(reserved.metadata);
      session.metadata = coordinator
        ? reserveDurableResearchStep({
            metadata: reserved.metadata,
            run: currentRun,
            reservationId: input.executionId,
            providerCallId: input.providerCallId,
            kind: 'dispatch',
            tool: input.tool,
            toolVersion: input.toolVersion,
            toolInput: input.input,
          }).metadata
        : reserved.metadata;
    }
    return commit(actor, sessionId, runId, { ...input, reservationId: input.executionId });
  }) as typeof service.commitSafeReadOutcome;
  const replay = service.replaySafeReadOutcome.bind(service);
  let replayAttempt = 0;
  service.replaySafeReadOutcome = (async (
    actor: typeof ctx,
    sessionId: string,
    runId: string,
    input: Parameters<typeof replay>[3],
  ) => {
    const hadIdentity = typeof input.providerCallId === 'string';
    const result = await replay(actor, sessionId, runId, {
      ...input,
      providerCallId: input.providerCallId ?? `legacy-test-replay-${++replayAttempt}`,
    });
    return !hadIdentity && result.replayed === false ? { replayed: false as const } : result;
  }) as typeof service.replaySafeReadOutcome;
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
      const declaredTools =
        Array.isArray(toolsUsed) && toolsUsed.every((tool) => typeof tool === 'string')
          ? (toolsUsed as string[])
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
            clientId: session.clientId,
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
    revokeWall: () => {
      wallAllowed = false;
    },
    revokeSource: () => {
      sourceAllowed = false;
    },
    replaceSource: (result: unknown) => {
      currentSource = result;
    },
    changeSessionClientDuringExecute: (clientId: string | null) => {
      clientDuringExecute = clientId;
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
    reservationId: executionId,
    executionId,
    leaseEpoch: 1,
    providerCallId: `provider-${executionId}`,
    tool: 'search_memory',
    toolVersion: TOOL_VERSION,
    input: { query },
    result,
  };
}

function mailOutcome(result = completeMailThreadResult(), clientId?: string) {
  return {
    reservationId: 'mail-execution-1',
    executionId: 'mail-execution-1',
    leaseEpoch: 1,
    providerCallId: 'provider-mail-execution-1',
    tool: 'get_email_thread',
    toolVersion: MAIL_TOOL_VERSION,
    input: { threadId: result.threadId, ...(clientId ? { clientId } : {}) },
    result,
  };
}

function mailSearchOutcome(result = completeMailSearchResult()) {
  return {
    reservationId: 'mail-search-execution-1',
    executionId: 'mail-search-execution-1',
    leaseEpoch: 1,
    providerCallId: 'provider-mail-search-execution-1',
    tool: 'search_emails',
    toolVersion: MAIL_SEARCH_TOOL_VERSION,
    input: { query: 'Report' },
    result,
  };
}

function mappedMailSearchOutcome(
  tool: 'search_emails' | 'list_emails',
  result: Record<string, unknown>,
) {
  return {
    reservationId: `mail-${tool}-execution-1`,
    executionId: `mail-${tool}-execution-1`,
    leaseEpoch: 1,
    providerCallId: `provider-mail-${tool}-execution-1`,
    tool,
    toolVersion: MAIL_SEARCH_TOOL_VERSION,
    input: { query: 'Report', asOf: MAPPED_AS_OF.toISOString() },
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
      providerCallId: 'provider-replay-1',
      tool: 'search_memory',
      toolVersion: TOOL_VERSION,
      input: { query: 'radar' },
    });

    expect(replay.replayed).toBe(true);
    expect(replay.dispatchAllowed).toBe(false);
    expect((replay as { result: unknown }).result).toEqual(executed);
    expect(toolExecute).toHaveBeenCalledTimes(1);
    expect(h.tools.execute).toHaveBeenCalledTimes(1);
    expect(readResearchToolBudget(h.session.metadata)).toMatchObject({
      spent: 2,
      attempts: [
        { kind: 'dispatch', outcome: 'result_committed' },
        { kind: 'receipt_reauthorization', outcome: 'replay_authorized' },
      ],
    });
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
      ctx,
      'session-1',
      'run-1',
      outcome('execution-1', 'radar'),
    );
    revoked.resume();
    revoked.revokeSource();
    await expect(
      revoked.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toEqual({ replayed: false });

    const changed = harness();
    await changed.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-1', 'radar'),
    );
    changed.resume();
    changed.replaceSource(completeMemoryResult('execution-1', 'corrected body'));
    await expect(
      changed.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toEqual({ replayed: false });
  });

  it('reauthorizes an unchanged implicit-asOf mail search at its saved server window', async () => {
    const source = completeMailSearchResult();
    const h = harness({
      tool: 'search_emails',
      schema: MAIL_SEARCH_TOOL_SCHEMA,
      source,
    });
    await h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', mailSearchOutcome(source));
    h.resume();

    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
        leaseEpoch: 2,
        tool: 'search_emails',
        toolVersion: MAIL_SEARCH_TOOL_VERSION,
        input: { query: 'Report' },
      }),
    ).resolves.toMatchObject({ replayed: true, result: { asOf: source.asOf } });
    expect(h.tools.execute).toHaveBeenLastCalledWith(ctx, 'search_emails', {
      query: 'Report',
      asOf: source.asOf,
    });
  });

  it('does not release an omitted-client B thread envelope into a focused A session', async () => {
    const clientA = '33333333-3333-4333-8333-333333333333';
    const clientB = '55555555-5555-4555-8555-555555555555';
    const source = await mappedMailThread(clientB);
    const h = harness({
      tool: 'get_email_thread',
      schema: MAIL_TOOL_SCHEMA,
      source,
      clientId: clientA,
    });
    await h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', mailOutcome(source));
    h.resume();

    const replay = await h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
      leaseEpoch: 2,
      tool: 'get_email_thread',
      toolVersion: MAIL_TOOL_VERSION,
      input: { threadId: source.threadId },
    });

    expect(replay).toEqual({ replayed: false });
    expect(JSON.stringify(replay)).not.toContain('ACTUAL_MAPPED_MAIL_BODY');
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it.each(['search_emails', 'list_emails'] as const)(
    'binds omitted-client mixed %s results to focused scope and preserves authorized positives',
    async (tool) => {
      const clientA = '33333333-3333-4333-8333-333333333333';
      const clientB = '55555555-5555-4555-8555-555555555555';
      const request = {
        leaseEpoch: 2,
        tool,
        toolVersion: MAIL_SEARCH_TOOL_VERSION,
        input: { query: 'Report', asOf: MAPPED_AS_OF.toISOString() },
      };

      const mixedSource = await mappedMailSearch(tool, [clientA, clientB]);
      const mixed = harness({
        tool,
        schema: MAIL_SEARCH_TOOL_SCHEMA,
        source: mixedSource,
        clientId: clientA,
      });
      await mixed.service.commitSafeReadOutcome(
        ctx,
        'session-1',
        'run-1',
        mappedMailSearchOutcome(tool, mixedSource),
      );
      mixed.resume();
      await expect(
        mixed.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
      ).resolves.toEqual({ replayed: false });
      expect(mixed.tools.execute).not.toHaveBeenCalled();

      const focusedSource = await mappedMailSearch(tool, [clientA]);
      const focused = harness({
        tool,
        schema: MAIL_SEARCH_TOOL_SCHEMA,
        source: focusedSource,
        clientId: clientA,
      });
      await focused.service.commitSafeReadOutcome(
        ctx,
        'session-1',
        'run-1',
        mappedMailSearchOutcome(tool, focusedSource),
      );
      focused.resume();
      await expect(
        focused.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
      ).resolves.toMatchObject({ replayed: true });

      const unfocusedSource = await mappedMailSearch(tool, [clientB]);
      const unfocused = harness({ tool, schema: MAIL_SEARCH_TOOL_SCHEMA, source: unfocusedSource });
      await unfocused.service.commitSafeReadOutcome(
        ctx,
        'session-1',
        'run-1',
        mappedMailSearchOutcome(tool, unfocusedSource),
      );
      unfocused.resume();
      await expect(
        unfocused.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
      ).resolves.toMatchObject({ replayed: true });

      const revoked = harness({ tool, schema: MAIL_SEARCH_TOOL_SCHEMA, source: unfocusedSource });
      await revoked.service.commitSafeReadOutcome(
        ctx,
        'session-1',
        'run-1',
        mappedMailSearchOutcome(tool, unfocusedSource),
      );
      revoked.resume();
      revoked.revokeWall();
      await expect(
        revoked.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
      ).resolves.toEqual({ replayed: false });
      expect(revoked.tools.execute).not.toHaveBeenCalled();
    },
  );

  it('rechecks mail source scope after the owner await and preserves null-client personal mail', async () => {
    const clientA = '33333333-3333-4333-8333-333333333333';
    const clientB = '55555555-5555-4555-8555-555555555555';
    const sourceB = await mappedMailThread(clientB);
    const changed = harness({
      tool: 'get_email_thread',
      schema: MAIL_TOOL_SCHEMA,
      source: sourceB,
    });
    await changed.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', mailOutcome(sourceB));
    changed.resume();
    changed.changeSessionClientDuringExecute(clientA);
    await expect(
      changed.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
        leaseEpoch: 2,
        tool: 'get_email_thread',
        toolVersion: MAIL_TOOL_VERSION,
        input: { threadId: sourceB.threadId },
      }),
    ).rejects.toThrow('The originating conversation is no longer available in this client scope');
    expect(changed.tools.execute).toHaveBeenCalledTimes(1);

    const personalSource = await mappedMailThread(null);
    const personal = harness({
      tool: 'get_email_thread',
      schema: MAIL_TOOL_SCHEMA,
      source: personalSource,
      clientId: clientA,
    });
    await personal.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      mailOutcome(personalSource),
    );
    personal.resume();
    await expect(
      personal.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
        leaseEpoch: 2,
        tool: 'get_email_thread',
        toolVersion: MAIL_TOOL_VERSION,
        input: { threadId: personalSource.threadId },
      }),
    ).resolves.toMatchObject({ replayed: true });
  });

  it.each([
    ['positive to delete', completeMemoryResult('memory-1'), emptyMemoryResult(), false],
    [
      'positive to edit',
      completeMemoryResult('memory-1'),
      completeMemoryResult('memory-1', 'corrected body'),
      false,
    ],
    ['positive to source wall', completeMemoryResult('memory-1'), null, true],
    ['empty to source wall', emptyMemoryResult(), null, true],
    [
      'unchanged positive owner',
      completeMemoryResult('memory-1'),
      completeMemoryResult('memory-1'),
      false,
    ],
  ])(
    'withholds a repeated completed reauthorization identity: %s',
    async (_label, original, replacement, sourceWall) => {
      const h = harness();
      await h.service.commitSafeReadOutcome(
        ctx,
        'session-1',
        'run-1',
        outcome('execution-1', 'radar', original),
      );
      h.replaceSource(original);
      h.resume();
      const request = {
        leaseEpoch: 2,
        providerCallId: 'same-replay-request',
        tool: 'search_memory',
        toolVersion: TOOL_VERSION,
        input: { query: 'radar' },
      };

      await expect(
        h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
      ).resolves.toMatchObject({ replayed: true, result: original });
      if (replacement) h.replaceSource(replacement);
      if (sourceWall) h.revokeSource();

      const repeated = await h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request);

      expect(repeated).toEqual({
        replayed: false,
        dispatchAllowed: false,
        replayMiss: 'completed_reauthorization_identity',
      });
      expect(repeated).not.toHaveProperty('result');
      expect(repeated).not.toHaveProperty('durableSafeRead');
      expect(h.tools.execute).toHaveBeenCalledTimes(1);
      expect(readResearchToolBudget(h.session.metadata)).toMatchObject({ spent: 2 });
    },
  );

  it('uses a fresh budgeted owner read for a new reauthorization operation', async () => {
    const h = harness();
    const original = completeMemoryResult('memory-1');
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-1', 'radar', original),
    );
    h.replaceSource(original);
    h.resume();
    const request = {
      leaseEpoch: 2,
      providerCallId: 'replay-operation-1',
      tool: 'search_memory',
      toolVersion: TOOL_VERSION,
      input: { query: 'radar' },
    };
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toMatchObject({ replayed: true });

    h.replaceSource(emptyMemoryResult());
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
        ...request,
        providerCallId: 'replay-operation-2',
      }),
    ).resolves.toEqual({ replayed: false, dispatchAllowed: false });
    expect(h.tools.execute).toHaveBeenCalledTimes(2);
    expect(readResearchToolBudget(h.session.metadata)).toMatchObject({
      spent: 3,
      attempts: [
        { kind: 'dispatch', outcome: 'result_committed' },
        { kind: 'receipt_reauthorization', outcome: 'replay_authorized' },
        { kind: 'receipt_reauthorization', outcome: 'replay_denied' },
      ],
    });
  });

  it('treats an absent or corrupt private result as a replay miss', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-1', 'radar'),
    );
    h.resume();
    const request = {
      leaseEpoch: 2,
      tool: 'search_memory',
      toolVersion: TOOL_VERSION,
      input: { query: 'radar' },
    };
    h.artifacts.clear();
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toEqual({ replayed: false });
    h.artifacts.set('private-result-1', { bodyText: '{corrupt' });
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toEqual({ replayed: false });
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
    expect(replay.dispatchAllowed).toBe(false);
    expect(
      (replay as { durableSafeRead?: { executionId?: string } }).durableSafeRead?.executionId,
    ).toBe('execution-a');
    expect(
      (replay as { result?: { records: { recordId: string }[] } }).result?.records[0]?.recordId,
    ).toBe('execution-a');
    expect(h.artifacts.size).toBe(2);
  });

  it('does not commit HTTP-200 logical errors, and receipts a partial owner payload as partial', async () => {
    const h = harness();
    await expect(
      h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', {
        ...outcome('logical-error', 'radar'),
        result: { status: 'error', error: 'upstream logical failure' },
      }),
    ).rejects.toThrow('not a re-checkable');
    expect(h.artifacts.size).toBe(0);
    // The model saw the partial page, so the read-time re-check must cover it
    // (Neo, 2026-10-06); it is receipted as partial, never as a qualified read.
    await h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', {
      ...outcome('partial', 'radar'),
      result: {
        ...completeMemoryResult('partial'),
        nextCursor: 'next',
        coverage: {
          ...completeMemoryResult('partial').coverage,
          complete: false,
        },
      },
    });
    expect(h.artifacts.size).toBe(1);
    expect(h.session.metadata.durableStepReceipts.at(-1)).toMatchObject({
      executionId: 'partial',
      classifier: 'partial',
    });
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
      trustSteps: [
        { tool: 'search_memory', label: 'PRIVATE_LABEL', detail: 'PRIVATE_DETAIL', count: 1 },
      ],
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
    expect((response.metadata.durableStepReceipts as Array<{ summary: string }>)[0]?.summary).toBe(
      'Authorized read completed',
    );
  });

  it('projects recovery sources without returning persisted owner prose', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-current-run', 'radar'),
    );
    h.completeReport();
    h.session.sources = [
      {
        tool: 'search_memory',
        label: 'Memory',
        summary: 'private owner result text',
        confidence: 'high',
      },
    ];

    const response = await h.service.getSession(ctx, 'session-1');

    expect(JSON.stringify(response)).not.toContain('private owner result text');
    expect(response.sources).toEqual([
      {
        tool: 'search_memory',
        label: 'Research source',
        summary: 'Authorized read completed',
        confidence: 'high',
      },
    ]);
  });

  it('binds recovery and export to the delivered report metadata identity', async () => {
    const h = harness();
    await h.service.commitSafeReadOutcome(
      ctx,
      'session-1',
      'run-1',
      outcome('execution-current-run', 'radar'),
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
      ctx,
      'session-1',
      'run-1',
      outcome('execution-current-run', 'radar'),
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

  it('replays an old authorized transcript receipt only while current source bytes remain exact', async () => {
    const initial = completeMeetingSourceResult();
    const h = harness({
      tool: 'read_client_meetings',
      schema: MEETING_SCHEMA,
      source: initial,
      clientId: MEETING_CLIENT_ID,
    });
    await h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', {
      reservationId: 'meeting-source-execution-1',
      executionId: 'meeting-source-execution-1',
      leaseEpoch: 1,
      providerCallId: 'meeting-source-provider-1',
      tool: 'read_client_meetings',
      toolVersion: MEETING_VERSION,
      input: MEETING_INPUT,
      result: initial,
    });
    expect(readDurableResearchStepReceipts(h.session.metadata)).toEqual([
      expect.objectContaining({
        tool: 'read_client_meetings',
        classifier: 'complete',
        resultRef: expect.stringMatching(/^private-result-/),
      }),
    ]);

    h.resume();
    const request = {
      leaseEpoch: 2,
      tool: 'read_client_meetings',
      toolVersion: MEETING_VERSION,
      input: MEETING_INPUT,
    };
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toMatchObject({
      replayed: true,
      result: {
        tool: 'read_client_meetings',
        source: { body: 'PRIVATE EXACT AUTHORIZED TRANSCRIPT SOURCE' },
      },
    });

    h.replaceSource(completeMeetingSourceResult('EDITED TRANSCRIPT SOURCE', 'version-2'));
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toEqual({ replayed: false });
    h.revokeSource();
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toEqual({ replayed: false });
  });

  it('binds standalone meeting replay to selected and post-owner current client scope', async () => {
    const initial = completeMeetingSourceResult();
    const clientA = '55555555-5555-4555-8555-555555555555';
    const committed = {
      reservationId: 'meeting-scope-execution',
      executionId: 'meeting-scope-execution',
      leaseEpoch: 1,
      providerCallId: 'meeting-scope-provider',
      tool: 'read_client_meetings',
      toolVersion: MEETING_VERSION,
      input: MEETING_INPUT,
      result: initial,
    };
    const request = {
      leaseEpoch: 2,
      tool: 'read_client_meetings',
      toolVersion: MEETING_VERSION,
      input: MEETING_INPUT,
    };

    const selectedA = harness({
      tool: 'read_client_meetings',
      schema: MEETING_SCHEMA,
      source: initial,
      clientId: clientA,
    });
    await selectedA.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', committed);
    selectedA.resume();
    await expect(
      selectedA.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toEqual({ replayed: false });
    expect(selectedA.tools.execute).not.toHaveBeenCalled();

    const unscoped = harness({
      tool: 'read_client_meetings',
      schema: MEETING_SCHEMA,
      source: initial,
    });
    await unscoped.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', committed);
    unscoped.resume();
    await expect(
      unscoped.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toMatchObject({ replayed: true });
    expect(unscoped.tools.execute).toHaveBeenCalledTimes(1);

    const changedAfterOwner = harness({
      tool: 'read_client_meetings',
      schema: MEETING_SCHEMA,
      source: initial,
    });
    await changedAfterOwner.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', committed);
    changedAfterOwner.resume();
    changedAfterOwner.changeSessionClientDuringExecute(clientA);
    await expect(
      changedAfterOwner.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).rejects.toThrow('The originating conversation is no longer available in this client scope');
    expect(changedAfterOwner.tools.execute).toHaveBeenCalledTimes(1);
  });

  it('re-reads an identical owner read once for every receipt that rests on it', async () => {
    const initial = completeMeetingSourceResult();
    const h = harness({
      tool: 'read_client_meetings',
      schema: MEETING_SCHEMA,
      source: initial,
      clientId: MEETING_CLIENT_ID,
    });
    // T5 ca7158f1: the parent, its child and re-reads repeat the same read.
    for (const executionId of ['meeting-read-parent', 'meeting-read-child']) {
      await h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', {
        reservationId: executionId,
        executionId,
        leaseEpoch: 1,
        providerCallId: `${executionId}-provider`,
        tool: 'read_client_meetings',
        toolVersion: MEETING_VERSION,
        input: MEETING_INPUT,
        result: initial,
      });
    }
    h.completeReport(['read_client_meetings']);
    h.tools.execute.mockClear();

    await expect(h.service.getSession(ctx, 'session-1')).resolves.toMatchObject({
      report: { bodyText: 'REPORT_CITING_CURRENT_RUN_MEMORY' },
    });
    expect(h.tools.execute).toHaveBeenCalledTimes(1);
  });

  it('reauthorizes meeting-source report read, export and model input and withholds edited bytes', async () => {
    const initial = completeMeetingSourceResult();
    const h = harness({
      tool: 'read_client_meetings',
      schema: MEETING_SCHEMA,
      source: initial,
      clientId: MEETING_CLIENT_ID,
    });
    await h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', {
      reservationId: 'meeting-report-execution',
      executionId: 'meeting-report-execution',
      leaseEpoch: 1,
      providerCallId: 'meeting-report-provider',
      tool: 'read_client_meetings',
      toolVersion: MEETING_VERSION,
      input: MEETING_INPUT,
      result: initial,
    });
    h.completeReport(['read_client_meetings']);

    await expect(h.service.getSession(ctx, 'session-1')).resolves.toMatchObject({
      report: { bodyText: 'REPORT_CITING_CURRENT_RUN_MEMORY' },
    });
    await expect(h.service.getReportMarkdown(ctx, 'session-1')).resolves.toEqual({
      title: 'Durable report',
      markdown: 'REPORT_CITING_CURRENT_RUN_MEMORY',
    });
    const model = await h.service.authorizeModelContext(
      ctx,
      { conversationId: 'conversation-1', clientId: MEETING_CLIENT_ID },
      [
        {
          id: 'report-message',
          role: 'assistant',
          body: 'MEETING_SOURCE_REPORT',
          metadata: {
            researchReport: true,
            researchSessionId: 'session-1',
          },
        },
      ],
      'MEETING_SOURCE_SUMMARY',
    );
    expect(model.messages[0]?.body).toBe('MEETING_SOURCE_REPORT');
    expect(model.summary).toBe('MEETING_SOURCE_SUMMARY');

    h.replaceSource(completeMeetingSourceResult('EDITED TRANSCRIPT SOURCE', 'version-2'));
    await expect(h.service.getSession(ctx, 'session-1')).resolves.toMatchObject({
      report: { bodyText: expect.stringContaining('current source authorization') },
    });
    await expect(h.service.getReportMarkdown(ctx, 'session-1')).rejects.toThrow(
      'source version changed',
    );
    const deniedModel = await h.service.authorizeModelContext(
      ctx,
      { conversationId: 'conversation-1', clientId: MEETING_CLIENT_ID },
      [
        {
          id: 'report-message',
          role: 'assistant',
          body: 'MEETING_SOURCE_REPORT',
          metadata: {
            researchReport: true,
            researchSessionId: 'session-1',
          },
        },
      ],
      'MEETING_SOURCE_SUMMARY',
    );
    expect(deniedModel.messages[0]?.body).toContain('current source authorization');
    expect(deniedModel.summary).toBeNull();
  });

  it('commits the actual debrief owner page and replays an old lease only while current bytes remain exact', async () => {
    const h = harness({ tool: 'query_debriefs', schema: DEBRIEF_SCHEMA });
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
      reservationId: 'debrief-execution-1',
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
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toMatchObject({
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
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toEqual({ replayed: false });
    revoked = true;
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', request),
    ).resolves.toEqual({ replayed: false });
  });

  it('reauthorizes debrief-backed report read/export and withholds it after edit or revoke', async () => {
    const h = harness({ tool: 'query_debriefs', schema: DEBRIEF_SCHEMA });
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
      reservationId: 'debrief-report-execution',
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
  it('rejects legacy cross-client mail from replay, report export and restored model context', async () => {
    const clientA = '33333333-3333-4333-8333-333333333333';
    const clientB = '55555555-5555-4555-8555-555555555555';
    const source = completeMailThreadResult(
      'Exact cross-client body.',
      '2026-09-28T00:01:00.000Z',
      clientB,
    );
    const h = harness({
      tool: 'get_email_thread',
      schema: MAIL_TOOL_SCHEMA,
      source,
      clientId: clientA,
    });
    await h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', mailOutcome(source, clientA));
    h.resume();
    await expect(
      h.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
        leaseEpoch: 2,
        tool: 'get_email_thread',
        toolVersion: MAIL_TOOL_VERSION,
        input: { threadId: source.threadId, clientId: clientA },
      }),
    ).resolves.toEqual({ replayed: false });

    h.session.metadata = {
      ...h.session.metadata,
      run: { ...h.session.metadata.run, id: 'run-1', leaseEpoch: 1, status: 'running' },
    };
    h.completeReport();
    await expect(h.service.getSession(ctx, 'session-1')).resolves.toMatchObject({
      report: { bodyText: expect.stringContaining('current source authorization') },
    });
    await expect(h.service.getReportMarkdown(ctx, 'session-1')).rejects.toThrow(
      'authorization proof is unavailable',
    );
    const model = await h.service.authorizeModelContext(
      ctx,
      { conversationId: 'conversation-1', clientId: clientA },
      [
        {
          id: 'report-message',
          role: 'assistant',
          body: 'CROSS_CLIENT_REPORT',
          metadata: {
            researchReport: true,
            researchSessionId: 'session-1',
          },
        },
      ],
      'CROSS_CLIENT_SUMMARY',
    );
    expect(model.messages[0]?.body).toContain('current source authorization');
    expect(model.summary).toBeNull();
  });

  it('preserves explicitly matching and unscoped personal thread authority', async () => {
    const clientA = '33333333-3333-4333-8333-333333333333';
    for (const [source, explicitClient] of [
      [completeMailThreadResult(undefined, undefined, clientA), clientA],
      [completeMailThreadResult(), undefined],
    ] as const) {
      const h = harness({
        tool: 'get_email_thread',
        schema: MAIL_TOOL_SCHEMA,
        source,
        clientId: clientA,
      });
      await h.service.commitSafeReadOutcome(
        ctx,
        'session-1',
        'run-1',
        mailOutcome(source, explicitClient),
      );
      h.completeReport();
      await expect(h.service.getSession(ctx, 'session-1')).resolves.toMatchObject({
        report: { bodyText: 'REPORT_CITING_CURRENT_RUN_MEMORY' },
      });
    }
  });

  it('withholds matching client mail when the current ethical-wall grant is revoked', async () => {
    const clientA = '33333333-3333-4333-8333-333333333333';
    const source = completeMailThreadResult(undefined, undefined, clientA);
    const h = harness({
      tool: 'get_email_thread',
      schema: MAIL_TOOL_SCHEMA,
      source,
      clientId: clientA,
    });
    await h.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', mailOutcome(source, clientA));
    h.completeReport();
    h.revokeWall();
    await expect(h.service.getSession(ctx, 'session-1')).rejects.toThrow(
      'Research session not found',
    );
    await expect(h.service.getReportMarkdown(ctx, 'session-1')).rejects.toThrow(
      'Research session not found',
    );
  });

  it('reauthorizes canonical full mail through retained replay, report read and export, then denies mutation and mailbox revocation', async () => {
    const replay = harness({
      tool: 'get_email_thread',
      schema: MAIL_TOOL_SCHEMA,
      source: completeMailThreadResult(),
    });
    await replay.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', mailOutcome());
    replay.resume();
    await expect(
      replay.service.replaySafeReadOutcome(ctx, 'session-1', 'run-2', {
        leaseEpoch: 2,
        tool: 'get_email_thread',
        toolVersion: MAIL_TOOL_VERSION,
        input: { threadId: '11111111-1111-4111-8111-111111111111' },
      }),
    ).resolves.toMatchObject({ replayed: true, result: { totalMessages: 1 } });

    const report = harness({
      tool: 'get_email_thread',
      schema: MAIL_TOOL_SCHEMA,
      source: completeMailThreadResult(),
    });
    await report.service.commitSafeReadOutcome(ctx, 'session-1', 'run-1', mailOutcome());
    report.completeReport();
    await expect(report.service.getSession(ctx, 'session-1')).resolves.toMatchObject({
      report: { bodyText: 'REPORT_CITING_CURRENT_RUN_MEMORY' },
    });
    await expect(report.service.getReportMarkdown(ctx, 'session-1')).resolves.toEqual({
      title: 'Durable report',
      markdown: 'REPORT_CITING_CURRENT_RUN_MEMORY',
    });

    report.replaceSource(
      completeMailThreadResult('Corrected canonical mail body.', '2026-09-28T00:02:00.000Z'),
    );
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
