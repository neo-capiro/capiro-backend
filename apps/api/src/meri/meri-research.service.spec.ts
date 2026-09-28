import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TextEncoder } from 'node:util';
import type { TenantContext } from '@capiro/shared';
import { MeriResearchService } from './meri-research.service.js';
import {
  ACTIVE_RESEARCH_RUN_FENCE_SQL,
  ACTIVE_RESEARCH_RUN_UPDATE_SQL,
} from './meri-research-run-state.js';
import { MeriV3ResearchRunner } from './meri-v3-research-runner.js';
import type { MeriV3ChatStreamEvent } from './meriv3-chat.client.js';

// These dependencies are supplied explicitly by this service unit harness.
jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../reviews/reviews.service.js', () => ({ ReviewsService: class {} }));
jest.mock('../engagement/ai-credential-resolver.service.js', () => ({
  AiCredentialResolverService: class {},
}));

/**
 * Unit test for the FORCED-SYNTHESIS fallback in MeriResearchService.
 *
 * Regression guard for the "Deep Research only shows the sources it searched,
 * never writes a report" bug. With 22 tools, the agentic loop can burn every
 * round calling tools (gathering) and exit on the round cap WITHOUT ever
 * streaming report prose. The fix: after the loop, if no report text was
 * produced, make one final Anthropic call with the `tools` key OMITTED so the
 * model physically cannot call tools and must write prose.
 *
 * This test mocks the Anthropic streaming endpoint (global.fetch) to return
 * tool-only rounds for every tools-enabled call, then asserts that:
 *   1. A final fetch is made with NO `tools` key (the forced-synthesis call).
 *   2. That call streams `text_delta`s which surface as `text` SSE events.
 *   3. A `report` SSE event with a non-empty body is emitted before `done`.
 *
 * No network, no DB, no Anthropic key required — fully CI-runnable.
 */

// ── SSE stream builders ──────────────────────────────────────────────────────

/**
 * Encode an array of Anthropic stream events as an async-iterable body of
 * Uint8Array chunks. We deliberately do NOT use the web `ReadableStream` global
 * here: jest's `node` test environment does not expose it, but the service only
 * relies on `response.body` being `AsyncIterable<Uint8Array>` — which is exactly
 * what undici's real fetch body is. An async generator satisfies that contract.
 */
function sseBody(events: Array<Record<string, unknown>>): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  // Split mid-stream to exercise the buffer/record-boundary reassembly path.
  const mid = Math.floor(lines.length / 2);
  const chunks = [lines.slice(0, mid), lines.slice(mid)];
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        yield enc.encode(c);
      }
    },
  };
}

/** A round where the model only calls one tool and stops with stop_reason=tool_use. */
function toolOnlyRound(toolName: string, index = 0): Array<Record<string, unknown>> {
  return [
    { type: 'message_start', message: { role: 'assistant' } },
    {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: `tool_${index}_${toolName}`, name: toolName },
    },
    {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' },
    },
    { type: 'content_block_stop', index },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    { type: 'message_stop' },
  ];
}

/** A round of pure prose (the forced-synthesis answer). */
function proseRound(text: string): Array<Record<string, unknown>> {
  // Stream the prose as several deltas to mimic real token streaming.
  const parts = text.match(/.{1,40}/gs) ?? [text];
  return [
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...parts.map((t) => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: t },
    })),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
}

function thinkingProseRound(text: string, privateThinking: string): Array<Record<string, unknown>> {
  const events = proseRound(text);
  return [
    events[0]!,
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: privateThinking },
    },
    ...events
      .slice(1)
      .map((event) =>
        typeof event.index === 'number' ? { ...event, index: event.index + 1 } : event,
      ),
  ];
}

function failingThinkingBody(privateThinking: string): AsyncIterable<Uint8Array> {
  const enc = new TextEncoder();
  const events = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: privateThinking },
    },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      yield enc.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
      throw new Error('provider stopped before report authorization');
    },
  };
}

function okResponse(body: AsyncIterable<Uint8Array>): Response {
  return {
    ok: true,
    status: 200,
    body: body as unknown as ReadableStream<Uint8Array>,
    text: async () => '',
  } as unknown as Response;
}

// ── Dep stubs ────────────────────────────────────────────────────────────────

const CTX: TenantContext = {
  tenantId: 'tenant-1',
  userId: 'user-1',
} as unknown as TenantContext;

const SESSION = {
  id: 'sess-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
  clientId: null,
  title: 'Test research',
  topic: 'Defense appropriations outlook',
  status: 'researching',
  plan: ['Scan recent markups', 'Identify divergence'],
  clarifyingQuestions: [],
  clarifyingAnswers: {},
  sources: null,
  reportArtifactId: null,
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeConfig(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    ANTHROPIC_API_KEY: 'test-key',
    // Provider-budget tests must use a model in the production pricing table;
    // unknown models intentionally reserve the full remaining cost envelope.
    CLIO_RESEARCH_MODEL: 'claude-sonnet-5',
    CLIO_RESEARCH_MAX_TOKENS: 8000,
    // This legacy synthesis harness exercises control flow rather than cap
    // exhaustion and repeats the full system prompt across several fake rounds.
    CLIO_RESEARCH_MAX_TOTAL_TOKENS: 1_000_000,
    CLIO_REQUEST_TIMEOUT_MS: 60_000,
    CLIO_RESEARCH_TIMEOUT_MS: 60_000, // research uses its own (longer) per-call timeout
    CLIO_RESEARCH_MAX_TOOL_ROUNDS: 2, // small cap so the loop exhausts fast
    // Generous wall-clock budget so the existing specs exercise the round cap,
    // not the budget gate (the budget specs override these).
    CLIO_RESEARCH_TOTAL_BUDGET_MS: 1_800_000,
    CLIO_RESEARCH_SYNTHESIS_RESERVE_MS: 480_000,
    CLIO_RESEARCH_PROGRESS_INTERVAL_MS: 5_000,
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConstructorParameters<
    typeof MeriResearchService
  >[1];
}

/**
 * AI-credential resolver stub (BYOK): both resolve* methods return the global
 * test key, mirroring the pre-BYOK behavior where the key came from
 * config.get('ANTHROPIC_API_KEY'). usedTenantKey=false = global fallback path.
 */
function makeAiCredentials() {
  const resolved = {
    provider: 'anthropic' as const,
    apiKey: ['test', 'key'].join('-'),
    // Use the configured production pricing authority: an invented model is
    // intentionally treated as unknown and conservatively consumes the cost cap.
    model: 'claude-sonnet-5',
    usedTenantKey: false,
    modelOverridden: false,
  };
  return {
    resolveProvider: async () => resolved,
    resolveProviderByTenantId: async () => resolved,
  } as unknown as ConstructorParameters<typeof MeriResearchService>[3];
}

/** Transaction fixture for the live-run fence and report publication contract. */
function makePrisma(
  capturedArtifacts?: Array<Record<string, any>>,
  tenantId = SESSION.tenantId,
  planCapability = 'searchBills',
  authority: Record<string, any> = {},
) {
  const artifacts = capturedArtifacts ?? [];
  const backingConversation = {
    id: 'conv-1',
    tenantId,
    userId: SESSION.userId,
    clientId: SESSION.clientId,
    archivedAt: null,
  };
  let session = {
    ...SESSION,
    tenantId,
    // These legacy-path specs begin after the standalone session's backing
    // thread exists. Public legislative reads require no owner-result proof,
    // but report publication still reauthorizes this exact thread scope.
    metadata: {
      backingConversationId: backingConversation.id,
      researchPlan: {
        version: 1,
        title: 'Test research',
        scope: {
          sessionId: SESSION.id,
          tenantId,
          actorId: SESSION.userId,
          clientId: null,
          conversationId: authority.handoff?.conversationId ?? null,
        },
        budget: { toolCalls: 2, tokens: 4_000 },
        steps: [
          {
            id: 'gather-evidence',
            objective: 'Gather authorized evidence for the requested report.',
            dependsOn: [],
            requiredEvidenceDomains: ['legislative'],
            allowedCapabilities: [planCapability],
            effect: 'read',
            completionCondition: 'Available evidence is gathered and gaps are explicit.',
            budget: { toolCalls: 2, tokens: 4_000 },
          },
        ],
        clarifyingQuestions: [],
      },
      ...structuredClone(authority),
    },
  };
  let reportRunFenced = false;
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql: string, ...values: unknown[]) => {
      const run = (session.metadata as { run?: Record<string, unknown> }).run;
      expect(values.slice(0, 7)).toEqual([
        session.id,
        session.tenantId,
        session.userId,
        session.status,
        run?.id,
        run?.leaseEpoch,
        run?.phase,
      ]);
      expect(run?.status).toBe('running');
      expect(values[7]).toBeInstanceOf(Date);
      expect(Date.parse(String(run?.heartbeatAt))).toBeGreaterThanOrEqual(
        (values[7] as Date).getTime(),
      );
      if (sql === ACTIVE_RESEARCH_RUN_UPDATE_SQL) {
        expect(values.slice(0, 7)).toEqual([
          session.id,
          session.tenantId,
          session.userId,
          session.status,
          run?.id,
          run?.leaseEpoch,
          run?.phase,
        ]);
        expect(values[7]).toBeInstanceOf(Date);
        expect(values[8]).toBe(JSON.stringify(session.metadata));
        session = {
          ...session,
          metadata: JSON.parse(String(values[9])),
          status: values[10] as string,
          updatedAt: values[11] as Date,
        };
        return [{ metadata_jsonb: structuredClone(session.metadata) }];
      }
      expect(sql).toBe(ACTIVE_RESEARCH_RUN_FENCE_SQL);
      expect(values[8]).toBeInstanceOf(Date);
      reportRunFenced = true;
      session = { ...session, updatedAt: values[8] as Date };
      return [{ metadata_jsonb: structuredClone(session.metadata) }];
    }),
    clioResearchSession: {
      findFirst: async ({ where }: any) => {
        expect(where).toEqual({
          id: session.id,
          tenantId: session.tenantId,
          userId: session.userId,
        });
        return structuredClone(session);
      },
      update: async ({ where, data }: any) => {
        expect(where).toEqual({ id: session.id });
        session = { ...session, ...structuredClone(data) };
        return structuredClone(session);
      },
      updateMany: async ({ where, data }: any) => {
        const currentMetadata = structuredClone(session.metadata);
        expect(where).toEqual({
          id: session.id,
          tenantId: session.tenantId,
          userId: session.userId,
          metadata: { equals: currentMetadata },
          reportArtifactId: null,
        });
        session = { ...session, ...structuredClone(data) };
        return { count: 1 };
      },
    },
    clioConversation: {
      findFirst: async ({ where, select }: any) => {
        expect(where).toEqual({
          id: backingConversation.id,
          tenantId: session.tenantId,
          userId: session.userId,
          clientId: session.clientId,
          archivedAt: null,
        });
        expect(select).toEqual({ id: true });
        return { id: backingConversation.id };
      },
      create: async ({ data, select }: any) => {
        expect(data).toMatchObject({
          tenantId: session.tenantId,
          userId: session.userId,
          clientId: session.clientId,
        });
        expect(select).toEqual({ id: true });
        return { id: backingConversation.id };
      },
    },
    clioArtifact: {
      create: async ({ data }: any) => {
        expect(reportRunFenced).toBe(true);
        artifacts.push(data);
        return { id: data.id };
      },
      findFirst: async ({ where }: any) =>
        artifacts.find((artifact) => !where?.id || artifact.id === where.id) ?? null,
    },
    client: {
      findFirst: async () => null,
    },
    meriAuditLedger: {
      create: jest.fn(async ({ data }: any) => ({ id: 'audit-1', ...data })),
    },
  };
  return {
    withTenant: async (tenantId: string, cb: (t: typeof tx) => unknown) => {
      expect(tenantId).toBe(session.tenantId);
      return cb(tx);
    },
  } as unknown as ConstructorParameters<typeof MeriResearchService>[0];
}

// Mirror of apps/api/src/meri/meri-tools.service.ts SIDE_EFFECTING_TOOLS — the
// write/send/docgen tools that must never be offered to (or run by) the
// read-only Deep Research gather loop.
const SIDE_EFFECTING_TEST = new Set([
  'create_meeting_brief',
  'draft_policy_memo',
  'save_note',
  'save_chat_attachments',
  'send_email',
  'reply_email',
  'save_memory',
  'create_word',
  'create_excel',
  'create_powerpoint',
  'schedule_task',
  'cancel_scheduled_task',
  'create_task',
  'update_task',
  'update_client_profile',
]);

function makeTools(capability = 'searchBills') {
  return {
    anthropicToolSchemas: () => [
      {
        name: capability,
        description: 'x',
        input_schema:
          capability === 'search_memory'
            ? {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
              }
            : { type: 'object', properties: {} },
      },
    ],
    isConcurrencySafe: (name: string) => !SIDE_EFFECTING_TEST.has(name),
    isSideEffecting: (name: string) => SIDE_EFFECTING_TEST.has(name),
    execute: async () => {
      throw new Error('No qualified owner result in this source-free synthesis fixture.');
    },
  } as unknown as ConstructorParameters<typeof MeriResearchService>[2];
}

function makeActualV3Runner(events: MeriV3ChatStreamEvent[]) {
  const client = {
    configured: true,
    streamChat: jest.fn(
      async ({
        onEvent,
      }: {
        input: Record<string, unknown>;
        onEvent: (event: MeriV3ChatStreamEvent) => void;
      }) => {
        for (const event of events) onEvent(event);
      },
    ),
  };
  const flags = { isMeriV3ChatEnabled: jest.fn(async () => true) };
  const credentials = {
    resolveProvider: jest.fn(async () => ({
      provider: 'openai' as const,
      apiKey: ['test', 'credential'].join('-'),
      model: 'configured-chat-model',
    })),
  };
  const prisma = {
    withTenantUser: jest.fn(
      async (_tenant: string, _user: string, callback: (tx: unknown) => unknown) =>
        callback({ clioAttachment: { findMany: async () => [] } }),
    ),
  };
  const evidence = {
    load: jest.fn(async () => ({ citations: [], unavailable: 0, omitted: 0 })),
  };
  const runner = new MeriV3ResearchRunner(
    client as never,
    flags as never,
    credentials as never,
    prisma as never,
    evidence as never,
  );
  return Object.assign(runner, { streamChatSpy: client.streamChat });
}

// ── Test ─────────────────────────────────────────────────────────────────────

function makeReviews() {
  // G4: held reports emit a review_request; the service owns the held body.
  const reviews = { createSystem: jest.fn(async () => 'rr-1') };
  return reviews as unknown as typeof reviews &
    ConstructorParameters<typeof MeriResearchService>[4];
}

describe('MeriResearchService — forced synthesis', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let fetchBodies: Array<Record<string, unknown>>;

  beforeEach(() => {
    fetchBodies = [];
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function captureBody(init?: RequestInit) {
    try {
      fetchBodies.push(JSON.parse(String(init?.body ?? '{}')));
    } catch {
      fetchBodies.push({});
    }
  }

  it('withholds typed V3 content through the actual runner and service callback before authorization', async () => {
    const privateBody = 'RAW_PRIVATE_OWNER_DETAIL_IN_TYPED_FRAME';
    const reportBody = 'UNAUTHORIZED_PROVIDER_REPORT';
    const runner = makeActualV3Runner([
      { type: 'reasoning', text: privateBody } as unknown as MeriV3ChatStreamEvent,
      { type: 'progress', note: privateBody } as unknown as MeriV3ChatStreamEvent,
      {
        type: 'start',
        runtime: 'meriv3',
        privateExtra: privateBody,
      } as unknown as MeriV3ChatStreamEvent,
      {
        type: 'runtime',
        runtime: 'meriv3',
        model: privateBody,
        reasoningMode: 'deep',
        reasoningEffort: privateBody,
        privateExtra: privateBody,
      } as unknown as MeriV3ChatStreamEvent,
      {
        type: 'tool_call',
        tool: 'private_lowercase_owner',
        label: privateBody,
      } as MeriV3ChatStreamEvent,
      {
        type: 'pending_approval',
        tool: 'send_email',
        label: privateBody,
        proposalId: privateBody,
        status: privateBody,
        reason: privateBody,
        expiresAt: privateBody,
        riskTier: null,
        policyCode: null,
        ruleId: null,
        policy: { source: privateBody },
        preview: { reason: privateBody },
      } as unknown as MeriV3ChatStreamEvent,
      { type: 'page_write', target: 'draft', body: privateBody },
      {
        type: 'artifact',
        artifact: { id: 'draft-1', title: 'Draft', kind: 'text', bodyText: privateBody },
      },
      {
        type: 'grounding_caveat',
        topSeverity: 'low',
        findings: [{ check: 'test', severity: 'low', detail: privateBody }],
      },
      { type: 'text', text: reportBody },
      {
        type: 'done',
        reply: reportBody,
        runtime: 'meriv3',
        model: 'test',
        reasoningMode: 'deep',
        reasoningEffort: 'high',
        steps: [],
        ledgerEntries: [],
        citations: [],
      },
    ]);
    const handoff = {
      version: 1,
      capturedAt: '2026-09-28T00:00:00Z',
      conversationId: 'conv-1',
      clientId: null,
      reasoningMode: 'deep',
      summary: 'other owner summary',
      messages: [],
      attachments: [],
    };
    const run = {
      id: 'actual-v3-private-run',
      leaseEpoch: 1,
      eventSequence: 0,
      phase: 'research',
      status: 'running',
      stage: 'Gathering evidence',
      startedAt: '2026-09-28T00:00:00.000Z',
      heartbeatAt: new Date().toISOString(),
    };
    const service = new MeriResearchService(
      makePrisma(undefined, SESSION.tenantId, 'search_memory', { handoff, run }),
      makeConfig(),
      makeTools('search_memory'),
      makeAiCredentials(),
      makeReviews(),
      runner,
    );
    const runSpy = jest.spyOn(runner, 'run');
    const observed: Array<Record<string, unknown>> = [];
    const sse = {
      write: (data: string) => observed.push(JSON.parse(data.slice(6)) as Record<string, unknown>),
    };
    const progress = {
      set: (note: string) => observed.push({ type: 'progress', note }),
      stop: () => undefined,
    };

    await expect(
      (service as any).runResearchStream(CTX, 'sess-1', sse, progress, {
        bearerToken: 'local-placeholder',
        governedContext: { contextPacket: { items: [] } },
        run,
      }),
    ).rejects.toThrow('private producer inputs');

    expect(JSON.stringify(observed)).not.toContain(privateBody);
    expect(JSON.stringify(observed)).not.toContain(reportBody);
    expect(
      observed.some((frame) =>
        [
          'text',
          'report',
          'done',
          'artifact',
          'page_write',
          'grounding_caveat',
          'pending_approval',
        ].includes(String(frame.type)),
      ),
    ).toBe(false);
    expect(observed).toEqual(
      expect.arrayContaining([
        { type: 'progress', note: 'Reviewing evidence and preparing the report…' },
        { type: 'progress', note: 'Starting the research runtime…' },
        { type: 'progress', note: 'Reading an authorized research source…' },
        { type: 'progress', note: 'Research is continuing in read-only mode.' },
      ]),
    );
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runner.streamChatSpy).toHaveBeenCalledTimes(1);
    expect(runner.streamChatSpy.mock.calls[0]?.[0].input).toMatchObject({
      toolPolicy: 'read-only',
      researchRun: { sessionId: 'sess-1', runId: run.id, leaseEpoch: run.leaseEpoch },
      researchPlanExecution: {
        version: 1,
        planVersion: 1,
        allowedReadCapabilities: ['search_memory'],
        scope: { conversationId: handoff.conversationId },
      },
    });
  });

  it('publishes the actual V3 report body only after durable save', async () => {
    const privateBody = 'RAW_PRIVATE_TYPED_DRAFT';
    const reportBody =
      '# Executive Summary\n\nAuthorized source-free report.\n\n## Recommended Actions\n\n1. Review the conclusion.';
    const runner = makeActualV3Runner([
      {
        type: 'start',
        runtime: 'meriv3',
        privateExtra: privateBody,
      } as unknown as MeriV3ChatStreamEvent,
      { type: 'page_write', target: 'draft', body: privateBody },
      {
        type: 'artifact',
        artifact: { id: 'draft-1', title: 'Draft', kind: 'text', bodyText: privateBody },
      },
      { type: 'text', text: reportBody },
      {
        type: 'done',
        reply: reportBody,
        runtime: 'meriv3',
        model: 'configured-chat-model',
        reasoningMode: 'deep',
        reasoningEffort: 'high',
        steps: [],
        ledgerEntries: [],
        citations: [],
      },
    ]);
    const artifacts: Array<Record<string, any>> = [];
    const runSpy = jest.spyOn(runner, 'run');
    const service = new MeriResearchService(
      makePrisma(artifacts, SESSION.tenantId, 'search_memory'),
      makeConfig(),
      makeTools('search_memory'),
      makeAiCredentials(),
      makeReviews(),
      runner,
    );
    const observed: Array<Record<string, unknown>> = [];
    let bodyDeliveredBeforeSave = false;
    const sse = {
      write: (data: string) => {
        const event = JSON.parse(data.replace(/^data: /, '').trim()) as Record<string, unknown>;
        if (
          artifacts.length === 0 &&
          ((event.type === 'text' && String(event.text).includes(reportBody)) ||
            (event.type === 'report' && String(event.body).includes(reportBody)))
        )
          bodyDeliveredBeforeSave = true;
        observed.push(event);
      },
    };

    await service.streamResearch(CTX, 'sess-1', sse, {
      bearerToken: 'caller-token',
      governedContext: {
        version: 1,
        operationId: 'research.generate-report',
        contextPacket: { items: [] },
      } as never,
    });

    expect(bodyDeliveredBeforeSave).toBe(false);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.bodyText).toContain(reportBody);
    expect(JSON.stringify(observed)).not.toContain(privateBody);
    expect(observed.find((event) => event.type === 'text')?.text).toContain(reportBody);
    expect(observed.find((event) => event.type === 'report')?.body).toContain(reportBody);
    expect(observed.at(-1)).toEqual({ type: 'done' });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runner.streamChatSpy).toHaveBeenCalledTimes(1);
    expect(runner.streamChatSpy.mock.calls[0]?.[0].input).toMatchObject({
      toolPolicy: 'read-only',
      researchPlanExecution: {
        version: 1,
        planVersion: 1,
        allowedReadCapabilities: ['search_memory'],
      },
    });
  });

  it.each([
    [
      'provider failure',
      [{ type: 'error', message: 'RAW_PRIVATE_PROVIDER_ERROR' } as MeriV3ChatStreamEvent],
      'Research provider failed before report publication.',
    ],
    [
      'cancellation',
      [
        {
          type: 'done',
          reply: 'RAW_PRIVATE_CANCELLED_BODY',
          runtime: 'meriv3',
          model: 'configured-chat-model',
          reasoningMode: 'deep',
          reasoningEffort: 'high',
          steps: [],
          ledgerEntries: [],
          citations: [],
          aborted: true,
        } as MeriV3ChatStreamEvent,
      ],
      'Research was cancelled.',
    ],
  ])(
    'keeps actual V3 %s terminal ordering fixed and content-free',
    async (_case, frames, expected) => {
      const runner = makeActualV3Runner(frames);
      const runSpy = jest.spyOn(runner, 'run');
      const service = new MeriResearchService(
        makePrisma(undefined, SESSION.tenantId, 'search_memory'),
        makeConfig(),
        makeTools('search_memory'),
        makeAiCredentials(),
        makeReviews(),
        runner,
      );
      const observed: Array<Record<string, unknown>> = [];

      await service.streamResearch(
        CTX,
        'sess-1',
        {
          write: (data: string) =>
            observed.push(
              JSON.parse(data.replace(/^data: /, '').trim()) as Record<string, unknown>,
            ),
        },
        {
          bearerToken: 'caller-token',
          governedContext: {
            version: 1,
            operationId: 'research.generate-report',
            contextPacket: { items: [] },
          } as never,
        },
      );

      expect(JSON.stringify(observed)).not.toContain('RAW_PRIVATE');
      expect(observed.some((event) => event.type === 'text' || event.type === 'report')).toBe(
        false,
      );
      const errorIndex = observed.findIndex(
        (event) => event.type === 'error' && event.message === expected,
      );
      const doneIndex = observed.findIndex((event) => event.type === 'done');
      expect(errorIndex).toBeGreaterThanOrEqual(0);
      expect(doneIndex).toBeGreaterThan(errorIndex);
      expect(observed.at(-1)).toEqual({ type: 'done' });
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(runner.streamChatSpy).toHaveBeenCalledTimes(1);
      expect(runner.streamChatSpy.mock.calls[0]?.[0].input).toMatchObject({
        toolPolicy: 'read-only',
        researchPlanExecution: {
          version: 1,
          planVersion: 1,
          allowedReadCapabilities: ['search_memory'],
        },
      });
    },
  );

  it('withholds unknown legacy provider tool names and unqualified sources on the actual service path', async () => {
    const privateTool = 'private_lowercase_owner_token';
    fetchMock = jest.fn(async () => okResponse(sseBody(toolOnlyRound(privateTool)))) as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
    const tools = makeTools('search_memory');
    const executeSpy = jest.spyOn(tools, 'execute');
    const service = new MeriResearchService(
      makePrisma(undefined, SESSION.tenantId, 'search_memory'),
      makeConfig({ CLIO_RESEARCH_MAX_TOOL_ROUNDS: 1 }),
      tools,
      makeAiCredentials(),
      makeReviews(),
    );
    const observed: Array<Record<string, unknown>> = [];

    await service.streamResearch(CTX, 'sess-1', {
      write: (data: string) => observed.push(JSON.parse(data.slice(6))),
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(observed)).not.toContain(privateTool);
    expect(observed.some((event) => event.type === 'step' || event.type === 'source')).toBe(false);
    expect(observed.some((event) => event.type === 'text' || event.type === 'report')).toBe(false);
    expect(JSON.stringify(observed)).not.toContain('Tool error');
    expect(observed).toContainEqual({
      type: 'error',
      message:
        'Research did not complete; partial provider output has not been released as a report.',
    });
    expect(observed.at(-1)).toEqual({ type: 'done' });
  });

  it.each([
    ['provider error', false, 'Research provider failed before report publication.'],
    ['cancellation', true, 'Research was cancelled.'],
  ])(
    'keeps legacy %s terminal frames fixed and content-free',
    async (_case, cancelled, expected) => {
      const privateError = 'RAW_PRIVATE_LEGACY_PROVIDER_ERROR';
      fetchMock = jest.fn(async () => {
        throw new Error(privateError);
      }) as jest.Mock;
      global.fetch = fetchMock as unknown as typeof fetch;
      const controller = new AbortController();
      if (cancelled) controller.abort(new Error(privateError));
      const service = new MeriResearchService(
        makePrisma(),
        makeConfig(),
        makeTools(),
        makeAiCredentials(),
        makeReviews(),
      );
      const observed: Array<Record<string, unknown>> = [];

      await service.streamResearch(
        CTX,
        'sess-1',
        {
          write: (data: string) =>
            observed.push(
              JSON.parse(data.replace(/^data: /, '').trim()) as Record<string, unknown>,
            ),
        },
        { signal: controller.signal },
      );

      expect(JSON.stringify(observed)).not.toContain(privateError);
      expect(observed.some((event) => event.type === 'text' || event.type === 'report')).toBe(
        false,
      );
      expect(observed).toContainEqual({ type: 'error', message: expected });
      expect(observed.at(-1)).toEqual({ type: 'done' });
    },
  );

  it('emits a report after the tool loop exhausts without prose', async () => {
    const PRIVATE_THINKING = 'RAW_PRIVATE_OWNER_DETAIL_IN_FORCED_SYNTHESIS';
    const REPORT =
      '# Executive Summary\n\nThe FY26 defense markup shows meaningful divergence ' +
      'between the House and Senate on shipbuilding accounts, creating a window for ' +
      'client engagement. [searchBills]\n\n## Recommended Actions\n\n1. Brief the client.\n\n' +
      '## Open Questions\n\nConference timing remains uncertain.';

    // Every tools-enabled call returns a tool-only round; the first call with NO
    // `tools` key returns the report prose.
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      captureBody(init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools) {
        return okResponse(sseBody(toolOnlyRound('searchBills')));
      }
      return okResponse(sseBody(thinkingProseRound(REPORT, PRIVATE_THINKING)));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const artifacts: Array<Record<string, any>> = [];
    const svc = new MeriResearchService(
      makePrisma(artifacts),
      makeConfig(),
      makeTools(),
      makeAiCredentials(),
      makeReviews(),
    );

    const events: Array<Record<string, unknown>> = [];
    let bodyDeliveredBeforeSave = false;
    const sse = {
      write: (data: string) => {
        // Service writes "data: <json>\n\n"; parse the JSON payload back out.
        const line = data.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'text' && artifacts.length === 0) bodyDeliveredBeforeSave = true;
            events.push(event);
          } catch {
            /* ignore */
          }
        }
      },
    };

    await svc.streamResearch(CTX, 'sess-1', sse);

    // 1. The tool loop ran (cap=2) and then a forced-synthesis call was made.
    //    => total fetches = 2 tool rounds + 1 synthesis = 3.
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 2. Exactly one fetch omitted the `tools` key — the forced-synthesis call.
    const toolless = fetchBodies.filter((b) => !('tools' in b) || !b.tools);
    expect(toolless).toHaveLength(1);
    // ...and it carried the explicit "write the report NOW" nudge as the last msg.
    const synthBody = toolless[0] ?? {};
    const synthMsgs = (synthBody.messages as Array<{ role: string; content: unknown }>) ?? [];
    const lastMsg = synthMsgs[synthMsgs.length - 1];
    expect(String(lastMsg?.content ?? '')).toMatch(/write the decision-grade.*report now/i);

    // 3. Report prose surfaced only after durable save.
    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
    const streamedText = textEvents.map((e) => String(e.text)).join('');
    expect(streamedText).toContain('Executive Summary');
    expect(bodyDeliveredBeforeSave).toBe(false);

    // 4. A single `report` event with a non-empty body fired, before `done`.
    const reportIdx = events.findIndex((e) => e.type === 'report');
    const doneIdx = events.findIndex(
      (e) => e.type === 'done' && reportIdx >= 0 && events.indexOf(e) > reportIdx,
    );
    expect(reportIdx).toBeGreaterThanOrEqual(0);
    const reportEvt = events[reportIdx] ?? {};
    expect(String(reportEvt.body ?? '')).toContain('Executive Summary');
    expect(String(reportEvt.artifactId ?? '')).toMatch(/^[0-9a-f-]{36}$/);
    expect(doneIdx).toBeGreaterThan(reportIdx);

    // Provider reasoning is never an observer frame; liveness remains a fixed,
    // source-independent progress status while the authorized body is buffered.
    expect(events.some((event) => event.type === 'thinking')).toBe(false);
    expect(JSON.stringify(events)).not.toContain(PRIVATE_THINKING);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'progress', note: 'Writing the report…' }),
    );

    // 5. A synthesize phase was announced.
    expect(events.some((e) => e.type === 'phase' && e.phase === 'synthesize')).toBe(true);
  });

  it('replaces gather thinking with fixed progress and preserves failure terminal ordering', async () => {
    const PRIVATE_THINKING = 'RAW_PRIVATE_OWNER_DETAIL_IN_REASONING';
    fetchMock = jest.fn(async () =>
      okResponse(failingThinkingBody(PRIVATE_THINKING)),
    ) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
    const svc = new MeriResearchService(
      makePrisma(),
      makeConfig({
        CLIO_EXTENDED_THINKING: true,
        CLIO_THINKING_MODE: 'adaptive',
        CLIO_RESEARCH_THINKING_BUDGET_TOKENS: 2_000,
      }),
      makeTools(),
      makeAiCredentials(),
      makeReviews(),
    );
    const { events, sse } = collectSse();

    await svc.streamResearch(CTX, 'sess-1', sse);

    expect(JSON.stringify(events)).not.toContain(PRIVATE_THINKING);
    expect(events.some((event) => event.type === 'thinking')).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'progress',
        note: 'Reviewing evidence and planning the next research step…',
      }),
    );
    expect(events.some((event) => event.type === 'text' || event.type === 'report')).toBe(false);
    const doneIndex = events.findIndex((event) => event.type === 'done');
    const errorIndexes = events.flatMap((event, index) => (event.type === 'error' ? [index] : []));
    expect(errorIndexes.length).toBeGreaterThan(0);
    expect(errorIndexes.every((index) => index < doneIndex)).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it.each([
    ['off', 'Supported prose with an orphan [53].'],
    ['enforce', 'Supported prose with an orphan .'],
  ])('persists FORM A markers according to %s mode', async (mode, expected) => {
    const prior = {
      mode: process.env.MERI_EVIDENCE_ACCURACY_MODE,
      tenants: process.env.MERI_EVIDENCE_ACCURACY_TENANTS,
      surfaces: process.env.MERI_EVIDENCE_ACCURACY_SURFACES,
    };
    const tenantId = '11111111-1111-4111-8111-111111111111';
    process.env.MERI_EVIDENCE_ACCURACY_MODE = mode;
    process.env.MERI_EVIDENCE_ACCURACY_TENANTS = tenantId;
    process.env.MERI_EVIDENCE_ACCURACY_SURFACES = 'research';
    const artifacts: Array<Record<string, any>> = [];
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools) return okResponse(sseBody(toolOnlyRound('searchBills')));
      return okResponse(sseBody(proseRound('# Findings\n\nSupported prose with an orphan [53].')));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
    const svc = new MeriResearchService(
      makePrisma(artifacts, tenantId),
      makeConfig(),
      makeTools(),
      makeAiCredentials(),
      makeReviews(),
    );
    const logger = { warn: jest.fn() };
    Object.assign(svc as object, { logger });

    try {
      await svc.streamResearch({ ...CTX, tenantId } as TenantContext, 'sess-1', {
        write: jest.fn(),
      });
      expect(artifacts[0]?.bodyText).toContain(expected);
      if (mode === 'off') {
        expect(logger.warn).not.toHaveBeenCalledWith('meri.citation_integrity', expect.anything());
      } else {
        expect(logger.warn).toHaveBeenCalledWith('meri.citation_integrity', {
          conversationId: null,
          turnId: 'sess-1',
          surface: 'research_report',
          dropped: [53],
          registered: 0,
          mode: 'enforce',
        });
      }
    } finally {
      if (prior.mode === undefined) delete process.env.MERI_EVIDENCE_ACCURACY_MODE;
      else process.env.MERI_EVIDENCE_ACCURACY_MODE = prior.mode;
      if (prior.tenants === undefined) delete process.env.MERI_EVIDENCE_ACCURACY_TENANTS;
      else process.env.MERI_EVIDENCE_ACCURACY_TENANTS = prior.tenants;
      if (prior.surfaces === undefined) delete process.env.MERI_EVIDENCE_ACCURACY_SURFACES;
      else process.env.MERI_EVIDENCE_ACCURACY_SURFACES = prior.surfaces;
    }
  });

  it('does not publish a report whose unsupported tool result lacks current owner authority', async () => {
    // FORM B tool names are lowercase snake_case (grammar [a-z][a-z0-9_]*), so use
    // a lowercase-named tool here. search_bills IS called this turn and its result
    // serializes "hr1234", so [S:search_bills:hr1234] resolves → kept. The other
    // two don't resolve (record_id absent / tool never called) → stripped.
    const toolsLc = {
      anthropicToolSchemas: () => [
        {
          name: 'search_bills',
          description: 'x',
          input_schema: { type: 'object', properties: {} },
        },
      ],
      isConcurrencySafe: () => true,
      isSideEffecting: () => false,
      execute: async () => ({ items: [{ id: 'hr1234' }], count: 1 }),
    } as unknown as ConstructorParameters<typeof MeriResearchService>[2];
    const REPORT =
      '# Findings\n\nShipbuilding accounts diverge this cycle [S:search_bills:hr1234]. ' +
      'A fabricated markup figure [S:search_bills:nonesuch] and a ghost-tool cite ' +
      '[S:ghost_tool:42] must not survive.';
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      captureBody(init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools) return okResponse(sseBody(toolOnlyRound('search_bills')));
      return okResponse(sseBody(proseRound(REPORT)));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new MeriResearchService(
      makePrisma(undefined, SESSION.tenantId, 'search_bills'),
      makeConfig(),
      toolsLc,
      makeAiCredentials(),
      makeReviews(),
    );
    const events: Array<Record<string, unknown>> = [];
    const sse = {
      write: (data: string) => {
        const line = data.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* ignore */
          }
        }
      },
    };

    await svc.streamResearch(CTX, 'sess-1', sse);

    expect(events.some((event) => event.type === 'report')).toBe(false);
    expect(events.filter((event) => event.type === 'text')).toHaveLength(0);
    expect(events).toContainEqual({
      type: 'error',
      message: 'Research failed before report publication.',
    });
    expect(JSON.stringify(events)).not.toContain('Shipbuilding accounts diverge');
    expect(JSON.stringify(events)).not.toContain('[S:search_bills:hr1234]');
    expect(JSON.stringify(events)).not.toContain('ghost_tool');
  });

  it('forces synthesis (never sources-only) when a gather round times out', async () => {
    // Regression guard for the production "only the research sources" bug: a
    // gather round exceeded CLIO_RESEARCH_TIMEOUT_MS, the AbortController fired,
    // and the old code let that abort kill the whole run — persisting just the
    // sources. Now an aborted round must fall through to forced synthesis.
    const REPORT = '# Executive Summary\n\nForced after a gather-round timeout. [searchBills]';

    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      captureBody(init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools) {
        // Wait for the actual per-round controller rather than trusting an
        // arbitrary provider error that merely uses the AbortError name.
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error('Missing gather signal'));
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      // The no-tools forced-synthesis call writes the report.
      return okResponse(sseBody(proseRound(REPORT)));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new MeriResearchService(
      makePrisma(),
      makeConfig({ CLIO_RESEARCH_TIMEOUT_MS: 10 }),
      makeTools(),
      makeAiCredentials(),
      makeReviews(),
    );
    const events: Array<Record<string, unknown>> = [];
    const sse = {
      write: (data: string) => {
        const line = data.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* ignore */
          }
        }
      },
    };

    await svc.streamResearch(CTX, 'sess-1', sse);

    // The aborted tool round did NOT end the run on sources alone — a single
    // forced (no-tools) synthesis call ran and produced the report.
    const toolless = fetchBodies.filter((b) => !('tools' in b) || !b.tools);
    expect(toolless).toHaveLength(1);
    const report = events.find((e) => e.type === 'report');
    expect(report).toBeTruthy();
    expect(String(report?.body ?? '')).toContain('Executive Summary');
    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThan(0);
  });

  it('does NOT make a forced-synthesis call when the model already wrote prose', async () => {
    const REPORT = '# Executive Summary\n\nMeri produced this report inline during the loop.';

    // First (and only) tools-enabled call streams BOTH a tool_use stop AND prose?
    // No — to represent "the model wrote the report", the very first call returns
    // prose and stops with end_turn, so the loop breaks immediately.
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      captureBody(init);
      return okResponse(sseBody(proseRound(REPORT)));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new MeriResearchService(
      makePrisma(),
      makeConfig(),
      makeTools(),
      makeAiCredentials(),
      makeReviews(),
    );
    const events: Array<Record<string, unknown>> = [];
    const sse = {
      write: (data: string) => {
        const line = data.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* ignore */
          }
        }
      },
    };

    await svc.streamResearch(CTX, 'sess-1', sse);

    // Only the first tools-enabled call should happen — no forced synthesis,
    // because reportBody was already populated.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchBodies[0]?.tools).toBeTruthy();
    const report = events.find((e) => e.type === 'report');
    expect(report).toBeTruthy();
    expect(String(report?.body ?? '')).toContain('Executive Summary');
  });

  it('excludes side-effecting tools from the gather schema and blocks them if called (B5)', async () => {
    const REPORT = '# Executive Summary\n\nRead-only research report.';
    const executeSpy = jest.fn(async () => ({ ok: true }));
    // Offers BOTH a read-only tool and a write tool; the service must filter the
    // write tool out of the schema it sends to the model.
    const tools = {
      anthropicToolSchemas: () => [
        { name: 'searchBills', description: 'x', input_schema: { type: 'object', properties: {} } },
        { name: 'send_email', description: 'x', input_schema: { type: 'object', properties: {} } },
      ],
      isConcurrencySafe: (name: string) => !SIDE_EFFECTING_TEST.has(name),
      isSideEffecting: (name: string) => SIDE_EFFECTING_TEST.has(name),
      execute: executeSpy,
    } as unknown as ConstructorParameters<typeof MeriResearchService>[2];

    // Every tools-enabled call FORCES a send_email tool_use (simulating a
    // schema-filter regression / model hallucination) to exercise the
    // defense-in-depth execution guard; the no-tools call returns the report.
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      captureBody(init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools) {
        return okResponse(sseBody(toolOnlyRound('send_email')));
      }
      return okResponse(sseBody(proseRound(REPORT)));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new MeriResearchService(
      makePrisma(),
      makeConfig(),
      tools,
      makeAiCredentials(),
      makeReviews(),
    );
    const events: Array<Record<string, unknown>> = [];
    const sse = {
      write: (data: string) => {
        const line = data.split('\n').find((l) => l.startsWith('data: '));
        if (line) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {
            /* ignore */
          }
        }
      },
    };

    await svc.streamResearch(CTX, 'sess-1', sse);

    // (1) Schema filter: the tools offered to the model exclude the write tool.
    const firstToolsCall = fetchBodies.find((b) => Array.isArray(b.tools));
    const offered = ((firstToolsCall?.tools as Array<{ name: string }>) ?? []).map((t) => t.name);
    expect(offered).toContain('searchBills');
    expect(offered).not.toContain('send_email');

    // (2) Defense-in-depth: even though the mock forced a send_email tool_use,
    //     execute() was never invoked (the guard blocked it before execution).
    expect(executeSpy).not.toHaveBeenCalled();
  });

  // ── Wall-clock budget + liveness ──────────────────────────────────────────
  //
  // Two production complaints, one root pair: a research run had no wall-clock
  // ceiling (maxRounds × per-round timeout = 10 × 600s ≈ 100 minutes) and, under
  // MERI_AUDITOR_MODE=enforce, streamed no report text at all until the audit
  // cleared it. A live run and a hung one were indistinguishable in the drawer.

  function collectSse() {
    const events: Array<Record<string, unknown>> = [];
    return {
      events,
      sse: {
        write: (data: string) => {
          const line = data.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {
              /* ignore */
            }
          }
        },
      },
    };
  }

  it('stops opening gather rounds once the wall-clock budget is spent, and still reports', async () => {
    const REPORT = '# Executive Summary\n\nWritten after the budget cut gathering short.';

    // Make the wall-clock budget test deterministic by using fake timers and
    // advancing time on each provider call. The fake provider (fetchMock) will
    // simulate realistic time passage, ensuring the gather deadline is met at
    // a predictable round count while still using the actual production streamResearch path.
    jest.useFakeTimers();
    // Seed Date.now() to a known value so we control the absolute timeline.
    const START_TIME = 1700000000000; // Arbitrary stable timestamp
    jest.setSystemTime(START_TIME);
    try {
      fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
        captureBody(init);
        const body = JSON.parse(String(init?.body ?? '{}'));
        // Advance clock by 10ms on each provider call to simulate real time passage.
        // This makes the test deterministic: with 50ms gather budget and 10ms per round,
        // we expect ~5 gather rounds (budget elapsed after 5 rounds at 50ms).
        jest.advanceTimersByTime(10);
        if (body.tools) return okResponse(sseBody(toolOnlyRound('searchBills')));
        return okResponse(sseBody(proseRound(REPORT)));
      }) as unknown as jest.Mock;
      global.fetch = fetchMock as unknown as typeof fetch;

      const svc = new MeriResearchService(
        makePrisma(),
        makeConfig({
          CLIO_RESEARCH_MAX_TOOL_ROUNDS: 50,
          CLIO_RESEARCH_TOTAL_BUDGET_MS: 100,
          CLIO_RESEARCH_SYNTHESIS_RESERVE_MS: 50,
        }),
        makeTools(),
        makeAiCredentials(),
        makeReviews(),
      );
      const { events, sse } = collectSse();

      await svc.streamResearch(CTX, 'sess-1', sse);

      // The budget gate — not the round cap — ended gathering.
      // With 50ms available to gathering and ~10ms simulated per provider call,
      // we expect exactly 5 gather rounds before the budget is exhausted.
      // The invariant: no new gather call starts after the gather deadline.
      const toolRounds = fetchBodies.filter((b) => Array.isArray(b.tools));
      expect(toolRounds.length).toBe(5);
      // Cutting gathering short must never mean shipping sources with no report:
      // the forced-synthesis pass still completes within the remaining durable deadline.
      const toolless = fetchBodies.filter((b) => !b.tools);
      expect(toolless).toHaveLength(1);
      // Verify no extra provider calls after budget exhausted (only gather rounds + 1 synthesis).
      expect(fetchBodies.length).toBe(6); // 5 gather + 1 synthesis
      const report = events.find((e) => e.type === 'report');
      expect(String(report?.body ?? '')).toContain('Executive Summary');
    } finally {
      jest.useRealTimers();
    }
  });

  it('emits progress heartbeats naming the current stage', async () => {
    const REPORT = '# Executive Summary\n\nProgress-instrumented run.';
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      captureBody(init);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (body.tools) return okResponse(sseBody(toolOnlyRound('searchBills')));
      return okResponse(sseBody(proseRound(REPORT)));
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const svc = new MeriResearchService(
      makePrisma(),
      makeConfig(),
      makeTools(),
      makeAiCredentials(),
      makeReviews(),
    );
    const { events, sse } = collectSse();

    await svc.streamResearch(CTX, 'sess-1', sse);

    const progress = events.filter((e) => e.type === 'progress');
    expect(progress.length).toBeGreaterThan(0);
    const notes = progress.map((p) => String(p.note));
    expect(notes.some((n) => /Gathering evidence/i.test(n))).toBe(true);
    expect(notes.some((n) => /Writing the report/i.test(n))).toBe(true);
    // Every heartbeat carries elapsed time so the client can render a live timer
    // and treat prolonged silence as a stall.
    expect(progress.every((p) => typeof p.elapsedMs === 'number')).toBe(true);
  });

  it('explains up front that enforce mode withholds the body until checks pass', async () => {
    const prevMode = process.env.MERI_AUDITOR_MODE;
    process.env.MERI_AUDITOR_MODE = 'enforce';
    try {
      const REPORT = '# Executive Summary\n\nEnforced-delivery run.';
      fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
        captureBody(init);
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tools) return okResponse(sseBody(toolOnlyRound('searchBills')));
        return okResponse(sseBody(proseRound(REPORT)));
      }) as unknown as jest.Mock;
      global.fetch = fetchMock as unknown as typeof fetch;

      const reviews = makeReviews();
      const svc = new MeriResearchService(
        makePrisma(),
        makeConfig(),
        makeTools(),
        makeAiCredentials(),
        reviews,
      );
      const { events, sse } = collectSse();

      await svc.streamResearch(CTX, 'sess-1', sse);

      // The reader is told WHY nothing is streaming, rather than being left to
      // read an empty bubble as a broken run.
      const notice = events.find((e) => e.type === 'notice');
      expect(String(notice?.message ?? '')).toMatch(/grounding checks/i);
      // The buffering guarantee itself is unchanged: no report prose streams
      // token-by-token ahead of the audit, only the single post-audit delivery.
      const deliveredBodies = events.filter((e) => e.type === 'text');
      expect(deliveredBodies).toHaveLength(1);
      expect(String(deliveredBodies[0]?.text)).toContain(REPORT);
      expect(reviews.createSystem).not.toHaveBeenCalled();
    } finally {
      if (prevMode === undefined) delete process.env.MERI_AUDITOR_MODE;
      else process.env.MERI_AUDITOR_MODE = prevMode;
    }
  });

  it('delays report text until durable save even when grounding enforcement is off', async () => {
    const prevMode = process.env.MERI_AUDITOR_MODE;
    delete process.env.MERI_AUDITOR_MODE;
    try {
      const REPORT =
        '# Executive Summary\n\nUnenforced run with publication-gated delivery. [searchBills]';
      fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
        captureBody(init);
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.tools) return okResponse(sseBody(toolOnlyRound('searchBills')));
        return okResponse(sseBody(proseRound(REPORT)));
      }) as unknown as jest.Mock;
      global.fetch = fetchMock as unknown as typeof fetch;

      const artifacts: Array<Record<string, any>> = [];
      const svc = new MeriResearchService(
        makePrisma(artifacts),
        makeConfig(),
        makeTools(),
        makeAiCredentials(),
        makeReviews(),
      );
      const { events, sse } = collectSse();

      await svc.streamResearch(CTX, 'sess-1', sse);

      expect(events.find((e) => e.type === 'notice')).toBeUndefined();
      const deliveredBodies = events.filter((e) => e.type === 'text');
      expect(deliveredBodies).toHaveLength(1);
      expect(String(deliveredBodies[0]?.text)).toContain(REPORT);
      expect(artifacts).toHaveLength(1);
    } finally {
      if (prevMode !== undefined) process.env.MERI_AUDITOR_MODE = prevMode;
    }
  });
});
