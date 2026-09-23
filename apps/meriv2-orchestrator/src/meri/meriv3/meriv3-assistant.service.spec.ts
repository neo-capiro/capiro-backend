import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MeriContext, ToolRegistry } from '@capiro/meriv2-core';
import {
  MERI_GOVERNMENT_AFFAIRS_OUTPUT_CONTRACT,
  readCanaryEvents,
  readShadowEvents,
} from '@capiro/meriv2-core';
import { runWithGovernedMeriContext } from '../meri-governed-context.runtime.js';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import * as passageSelector from '../jev/passage-selector.js';
import type { PassageCandidate } from '../jev/passage-selector.js';
import * as liveRepair from '../repair/live-repair.service.js';
import type { MeriV3ChatStreamEvent } from './meriv3.types.js';
import {
  MeriV3AssistantService,
  resetMeriV3RolloutDiagnosticsForTest,
} from './meriv3-assistant.service.js';

const context = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  firmMemory: null,
  userVoice: null,
  clientSteering: null,
  clientRoster: [],
} as unknown as MeriContext;

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

const clientDocumentSchemas = [
  {
    name: 'read_client_documents',
    description: 'Read client files',
    input_schema: {
      type: 'object',
      properties: {
        clientId: { type: 'string' },
        documentId: { type: 'string' },
        cursor: { type: 'string' },
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['clientId'],
    },
  },
  {
    name: 'get_research_evidence',
    description: 'Read a research snapshot',
    input_schema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'find_contacts',
    description: 'Find contacts',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
    },
  },
];

function documentFixture(text: string) {
  return jest.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'find_contacts')
      return { contacts: [{ id: 'person-1', name: 'Alex Carter', title: 'Director' }] };
    if (name !== 'read_client_documents') throw new Error('Research session not found');
    if (args.clientId !== 'client-1') throw new Error('Client access denied');
    if (!args.documentId)
      return {
        tool: name,
        clientId: 'client-1',
        documents: [
          { id: 'transcript-1', fileName: 'September meeting transcript.txt', usable: true },
        ],
        coverage: { total: 1, complete: true, paginationComplete: true, nextCursor: null },
      };
    const start = args.cursor ? Number(String(args.cursor).split(':')[1]) : 0;
    const end = Math.min(start + 5000, text.length);
    return {
      tool: name,
      clientId: 'client-1',
      document: {
        id: 'transcript-1',
        fileName: 'September meeting transcript.txt',
        contentHash: 'a'.repeat(64),
      },
      coverage: {
        section: 1,
        sectionCount: 1,
        sectionCharacters: text.length,
        characterStart: start,
        characterEnd: end,
        complete: start === 0 && end === text.length,
        truncated: end < text.length,
        nextCursor: end < text.length ? `page:${end}` : null,
        query: null,
      },
      records: [
        {
          recordId: `transcript-1:${start}-${end}`,
          payload: {
            id: `transcript-1:${start}-${end}`,
            documentId: 'transcript-1',
            title: 'September meeting transcript.txt',
            text: text.slice(start, end),
            section: 1,
            characterStart: start,
            characterEnd: end,
          },
        },
      ],
    };
  });
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: 'resp-1',
    status: 'completed',
    output: [],
    outputText: 'Final answer.',
    functionCalls: [],
    usage,
    model: 'gpt-5.1',
    usedTenantKey: false,
    incompleteReason: null,
    telemetry: {
      requestedModel: 'gpt-5.1',
      effectiveModel: 'gpt-5.1',
      requestedReasoningEffort: 'medium',
      effectiveReasoningEffort: 'medium',
      reasoningFallbackReasons: [],
      finishReason: 'completed',
      partial: false,
    },
    ...overrides,
  };
}

function build(
  registry: ToolRegistry,
  complete: jest.Mock,
  createProposal = jest.fn(),
  llmOverrides: Record<string, jest.Mock> = {},
) {
  const registryService = {
    registry,
    llm: {
      completeJson: jest.fn(),
      completeWithSchema: jest.fn(async () => ({
        input: { refuted: false, confidence: 'high', reason: 'Supported.' },
        usage: { inputTokens: 10, outputTokens: 2 },
      })),
      ...llmOverrides,
    },
  };
  const openai = { complete };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, callback: (tx: unknown) => unknown) =>
      callback({
        aiUsageEvent: { create: jest.fn(async () => ({})) },
        meriAuditLedger: { create: jest.fn(async () => ({})) },
      }),
    ),
  };
  const config = { get: jest.fn(() => 'http://api.test') };
  return new MeriV3AssistantService(
    registryService as never,
    openai as never,
    { create: createProposal } as never,
    prisma as never,
    config as never,
  );
}

function registry(definitions: Array<{ name: string; readOnly: boolean }>, invoke = jest.fn()) {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  return {
    list: () => definitions.map((definition) => definition.name),
    get: (name: string) => byName.get(name),
    executionMetadata: (name: string) => {
      const definition = byName.get(name);
      return definition
        ? {
            name,
            readOnly: definition.readOnly,
            executionMode: definition.readOnly ? 'read' : 'approval_required',
            externalEffect: definition.readOnly ? 'none' : 'external_send',
            reversible: definition.readOnly,
            riskTier: definition.readOnly ? 'low' : 'high',
            displayVerb: name,
          }
        : undefined;
    },
    invoke,
  } as unknown as ToolRegistry;
}

/** The `event` field of a structured (single JSON line) log message, or null for any other message. */
function eventNameOf(message: unknown): string | null {
  if (typeof message !== 'string' || !message.startsWith('{')) return null;
  try {
    const event = (JSON.parse(message) as { event?: unknown }).event;
    return typeof event === 'string' ? event : null;
  } catch {
    return null;
  }
}

const SHADOW_EVENTS = new Set(['meri.evidence_shadow', 'meri.evidence_shadow.turn']);

describe('MeriV3AssistantService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.MERI_AUDITOR_MODE;
    delete process.env.MERI_RELEASE_GATE;
    delete process.env.MERI_CLAIM_ASSESSMENT_MODE;
    delete process.env.MERI_CLAIM_ASSESSMENT_TENANTS;
    delete process.env.MERI_CLAIM_ASSESSMENT_SURFACES;
    delete process.env.MERI_COVERAGE_RETRIEVAL_MODE;
    delete process.env.MERI_COVERAGE_RETRIEVAL_TENANTS;
    delete process.env.MERI_COVERAGE_RETRIEVAL_SURFACES;
    delete process.env.MERI_JEV_PROVIDER_MODE;
    delete process.env.MERI_JEV_PROVIDER_TENANTS;
    delete process.env.MERI_JEV_PROVIDER_SURFACES;
    delete process.env.MERI_JEV_TASKS;
    delete process.env.MERI_CHAT_EVIDENCE_JUDGE;
    delete process.env.TYPESAFE_API_KEY;
    resetMeriV3RolloutDiagnosticsForTest();
    jest.restoreAllMocks();
  });

  test('off mode emits the identical reply without scheduling claim inventory work', async () => {
    const complete = jest.fn().mockResolvedValue(response({ outputText: 'H.R. 1 passed.' }));
    const assistant = build(registry([]), complete);
    const claimLog = jest.spyOn((assistant as unknown as { logger: { log: (...args: unknown[]) => void } }).logger, 'log');
    const events: unknown[] = [];
    const result = await assistant.run(context, {
      conversationId: 'thread-off',
      messages: [{ role: 'user', text: 'What happened?' }],
    }, { onEvent: (event) => events.push(event) });
    expect(result.reply).toBe('H.R. 1 passed.');
    expect(events).toContainEqual({ type: 'text', text: 'H.R. 1 passed.' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(claimLog.mock.calls.map(([message]) => eventNameOf(message))).not.toContain('meri.claim_inventory');
  });

  test('emits the reply before legacy-only shadow provider work begins', async () => {
    const tenantId = '17b63099-bc0f-4ac5-b596-496161e9481e';
    process.env.MERI_CLAIM_ASSESSMENT_MODE = 'shadow';
    process.env.MERI_CLAIM_ASSESSMENT_TENANTS = tenantId;
    process.env.MERI_CLAIM_ASSESSMENT_SURFACES = 'chat';
    process.env.MERI_CHAT_EVIDENCE_JUDGE = 'llm';
    const complete = jest.fn().mockResolvedValue(response({ outputText: 'H.R. 1 passed.' }));
    const assistant = build(registry([]), complete);
    const order: string[] = [];
    const logger = (assistant as unknown as { logger: { log: (...args: unknown[]) => void } }).logger;
    jest.spyOn(logger, 'log').mockImplementation((message: unknown) => {
      if (eventNameOf(message) === 'meri.evidence_shadow') order.push('provider');
    });
    await assistant.run({ ...context, tenantId } as MeriContext, {
      conversationId: 'thread-shadow',
      messages: [{ role: 'user', text: 'What happened?' }],
    }, { onEvent: (event) => { if (event.type === 'text') order.push('reply'); } });
    expect(order).toEqual(['reply']);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order[0]).toBe('reply');
    expect(order).toContain('provider');
  });

  test('does not emit or persist a client note success before any write ran', async () => {
    const complete = jest
      .fn()
      .mockResolvedValue(response({ outputText: 'I have saved your notes under Sightline.' }));
    const createProposal = jest.fn();
    const assistant = build(registry([]), complete, createProposal);
    const onEvent = jest.fn();
    const result = await assistant.run(
      context,
      {
        toolPolicy: 'none',
        clientId: 'client-1',
        messages: [
          {
            role: 'user',
            text: 'How do I log Sen Wyden engagement notes under Sightline? I have not provided the notes yet.',
          },
        ],
      },
      { onEvent },
    );
    expect(createProposal).not.toHaveBeenCalled();
    expect(result.reply).toContain('I have not saved');
    expect(
      onEvent.mock.calls
        .filter(([event]) => event.type === 'text')
        .map(([event]) => event.text)
        .join(''),
    ).not.toContain('I have saved');
    expect(complete.mock.calls[0][0].instructions).toContain('does not supply note content');
  });

  describe('reasoning mode auto-detection', () => {
    test('escalates an audit-everything request past the default Standard mode', async () => {
      const complete = jest.fn().mockResolvedValue(response({ outputText: 'Audit complete.' }));
      const assistant = build(registry([]), complete);
      const result = await assistant.run(context, {
        toolPolicy: 'none',
        clientId: 'client-1',
        messages: [
          {
            role: 'user',
            text:
              'Audit every commitment we have made. List each commitment with status. ' +
              'Do not mark anything complete without evidence, and identify sources you could not check.',
          },
        ],
      });
      expect(result.reasoningMode).toBe('deep');
    });

    test('leaves an ordinary lookup on the default Standard mode', async () => {
      const complete = jest.fn().mockResolvedValue(response({ outputText: 'It is at 3pm.' }));
      const assistant = build(registry([]), complete);
      const result = await assistant.run(context, {
        toolPolicy: 'none',
        clientId: 'client-1',
        messages: [{ role: 'user', text: 'What time is the meeting with Senator Wyden?' }],
      });
      expect(result.reasoningMode).toBe('standard');
    });

    test('never downgrades a mode the user explicitly selected', async () => {
      const complete = jest.fn().mockResolvedValue(response({ outputText: 'On it.' }));
      const assistant = build(registry([]), complete);
      const result = await assistant.run(context, {
        toolPolicy: 'none',
        clientId: 'client-1',
        reasoningMode: 'max',
        messages: [{ role: 'user', text: 'What time is the meeting?' }],
      });
      expect(result.reasoningMode).toBe('max');
    });
  });

  test('saves inherited document evidence used only in the generated artifact, preserving [56]', async () => {
    const citation = {
      n: 56,
      type: 'source',
      id: 'doc-page-22',
      title: 'Capiro 2.0.pdf',
      url: null,
      snippet: 'Meeting preparation',
      tool: 'read_client_documents',
      documentEvidence: {
        clientId: 'client-1',
        documentId: 'doc-1',
        contentHash: 'a'.repeat(64),
        observedAt: '2026-09-07T00:00:00Z',
        record: {
          recordId: 'doc-page-22',
          payload: { title: 'Capiro 2.0.pdf', text: 'Meeting preparation', section: 22 },
        },
        coverage: { complete: false, truncated: true, disclosure: 'Visual page extraction only' },
      },
    };
    const governed = {
      inheritedDocumentEvidence: [citation],
      contextPacket: { packetId: 'packet-1' },
    } as unknown as MeriGovernedTurnContext;
    const call = {
      type: 'function_call',
      call_id: 'word-call',
      name: 'create_word',
      arguments: '{}',
    };
    const complete = jest
      .fn()
      .mockResolvedValueOnce(response({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValueOnce(response({ outputText: 'Your briefing is ready.' }));
    const artifact = {
      id: 'artifact-1',
      kind: 'docx',
      title: 'QA Briefing',
      bodyText: JSON.stringify({
        title: 'QA Briefing',
        sections: [{ paragraphs: ['Page 22 observation [56]. Visual extraction only.'] }],
      }),
    };
    const createProposal = jest
      .fn()
      .mockResolvedValue({ disposition: 'executed', executionResult: { artifact } });
    const assistant = build(
      registry([{ name: 'create_word', readOnly: false }]),
      complete,
      createProposal,
    );
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemas: [
              {
                name: 'create_word',
                description: 'Create a Word document',
                input_schema: { type: 'object', properties: {} },
              },
            ],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;
    const result = await RequestCredentialsStore.run({ bearerToken: 'test-token' }, () =>
      runWithGovernedMeriContext(governed, () =>
        assistant.run(context, {
          clientId: 'client-1',
          conversationId: 'thread-1',
          messages: [
            { role: 'user', text: 'Create a Word briefing from the earlier page observation.' },
          ],
        }),
      ),
    );
    expect(result.reply).toBe('Your briefing is ready.');
    expect(result.artifacts).toEqual([artifact]);
    expect(result.citations).toEqual([citation]);
    const saved = JSON.parse(JSON.stringify(result));
    expect(saved.citations[0].documentEvidence.coverage.disclosure).toBe(
      'Visual page extraction only',
    );
    expect(saved.evidenceManifest.sources[0]).toMatchObject({
      id: 'doc-page-22',
      origin: 'conversation',
      truncated: true,
    });
    expect(complete.mock.calls[0]?.[0].instructions).toContain('[56]');
  });

  test('retains the professional answer contract and client constraints in forced synthesis', async () => {
    const complete = jest
      .fn()
      .mockResolvedValueOnce(response({ outputText: '' }))
      .mockResolvedValueOnce(
        response({ outputText: 'The source gap prevents a verified recommendation.' }),
      );
    const assistant = build(registry([]), complete);
    await assistant.run(context, {
      clientId: 'client-1',
      messages: [{ role: 'user', text: 'Prepare a decision briefing.' }],
      conversationSummary: 'The client cannot meet a mandatory domestic production condition.',
      toolPolicy: 'none',
    });

    expect(complete).toHaveBeenCalledTimes(2);
    for (const [request] of complete.mock.calls) {
      expect(request.instructions).toContain(MERI_GOVERNMENT_AFFAIRS_OUTPUT_CONTRACT);
      expect(request.instructions).toContain('client-1');
      expect(request.instructions).toContain(
        'cannot meet a mandatory domestic production condition',
      );
    }
    const synthesis = complete.mock.calls[1][0];
    expect(synthesis.toolChoice).toBe('none');
    expect(synthesis.instructions).toContain('admitted governed context evidence');
    expect(synthesis.instructions).toContain('Preserve their source references');
    expect(synthesis.instructions).toContain('label any remaining material gap');
  });

  test('uses only the model-visible tool projection for citation and grounding evidence', async () => {
    const call = {
      type: 'function_call',
      call_id: 'memory-call',
      name: 'search_memory',
      arguments: '{"query":"client","k":8}',
    };
    const complete = jest
      .fn()
      .mockResolvedValueOnce(response({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValueOnce(response({ outputText: 'The first preference applies [1].' }));
    const records = Array.from({ length: 8 }, (_, index) => ({
      id: `memory-${index}`,
      title: `Preference ${index}`,
      text: 'Approved fact '.repeat(300) + `unseen-tail-${index}`,
    }));
    const invoke = jest.fn().mockResolvedValue({ data: records, total: 8, nextCursor: 'offset:8' });
    const assistant = build(
      registry([{ name: 'search_memory', readOnly: true }], invoke),
      complete,
    );
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemas: [
              {
                name: 'search_memory',
                description: 'Search approved memory',
                input_schema: {
                  type: 'object',
                  properties: { query: { type: 'string' }, k: { type: 'number' } },
                },
              },
            ],
          }),
        ),
    ) as typeof fetch;
    const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      assistant.run(context, {
        messages: [{ role: 'user', text: 'Retrieve the client preferences.' }],
        toolPolicy: 'read-only',
      }),
    );
    expect(complete).toHaveBeenCalledTimes(2);
    const modelInput = JSON.stringify(complete.mock.calls[1]![0].input);
    expect(modelInput).toContain('model_tool_evidence_budget');
    expect(modelInput).not.toContain('unseen-tail-7');
    expect(JSON.stringify(result.ledgerEntries)).not.toContain('unseen-tail-7');
    expect(result.citations?.some((citation) => citation.id === 'memory-7')).not.toBe(true);
    expect(result.evidenceManifest).toMatchObject({
      truncated: true,
      sources: [expect.objectContaining({ tool: 'search_memory', truncated: true })],
    });
    expect((result.ledgerEntries?.[0]?.result as Record<string, unknown>).nextCursor).toBeNull();
    expect(result.toolCoverage).toEqual([
      expect.objectContaining({
        source: 'institutional_knowledge',
        tool: 'search_memory',
        status: 'partial',
        truncated: true,
      }),
    ]);
  });

  test('stops the remaining tool batch and synthesis after cancellation', async () => {
    const abort = new AbortController();
    const calls = ['search_memory', 'send_email'].map((name, i) => ({
      type: 'function_call',
      call_id: `call-${i}`,
      name,
      arguments: '{}',
    }));
    const complete = jest
      .fn()
      .mockResolvedValue(response({ output: calls, outputText: '', functionCalls: calls }));
    const invoke = jest.fn(async (_name, _input, _ctx, control) => {
      expect(control.signal).toBe(complete.mock.calls[0][0].signal);
      expect(control.deadlineAt).toBe(complete.mock.calls[0][0].deadlineAt);
      abort.abort();
      return { records: [] };
    });
    const proposals = jest.fn();
    const assistant = build(
      registry(
        [
          { name: 'search_memory', readOnly: true },
          { name: 'send_email', readOnly: false },
        ],
        invoke,
      ),
      complete,
      proposals,
    );
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemas: calls.map((call) => ({
              name: call.name,
              description: call.name,
              input_schema: { type: 'object', properties: {} },
            })),
          }),
        ),
    ) as typeof fetch;
    const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      assistant.run(
        context,
        { messages: [{ role: 'user', text: 'Review memory and prepare outreach.' }] },
        { signal: abort.signal },
      ),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(proposals).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe('');
    expect(result.telemetry).toMatchObject({ finishReason: 'cancelled', partial: true });
  });

  test('expired deadline schedules neither a provider request nor a tool', async () => {
    const complete = jest.fn();
    const invoke = jest.fn();
    const result = await build(registry([], invoke), complete).run(
      context,
      { messages: [{ role: 'user', text: 'Read the brief.' }], toolPolicy: 'none' },
      { deadlineAt: Date.now() - 1 },
    );
    expect(complete).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(result.telemetry).toMatchObject({
      finishReason: 'deadline_exceeded',
      partial: true,
      effectiveModel: null,
    });
  });

  test('recovers from a mid-turn deadline_exceeded error using already-gathered evidence', async () => {
    const call = { type: 'function_call', call_id: 'one', name: 'search_memory', arguments: '{}' };
    const deadlineError = Object.assign(new Error('OpenAI Responses turn deadline exceeded'), {
      telemetry: {
        requestedModel: 'gpt-5.1',
        effectiveModel: null,
        requestedReasoningEffort: 'medium',
        effectiveReasoningEffort: null,
        reasoningFallbackReasons: [],
        finishReason: 'deadline_exceeded',
        partial: true,
      },
    });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(response({ output: [call], outputText: '', functionCalls: [call] }))
      .mockRejectedValueOnce(deadlineError)
      .mockResolvedValueOnce(response({ outputText: 'Recovered answer from gathered evidence.' }));
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemas: [
              {
                name: call.name,
                description: call.name,
                input_schema: { type: 'object', properties: {} },
              },
            ],
          }),
        ),
    ) as typeof fetch;
    const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      build(
        registry(
          [{ name: 'search_memory', readOnly: true }],
          jest.fn(async () => ({ records: [] })),
        ),
        complete,
      ).run(context, { messages: [{ role: 'user', text: 'Read memory.' }] }),
    );
    expect(complete).toHaveBeenCalledTimes(3);
    expect(result.reply).toBe('Recovered answer from gathered evidence.');
    expect(result.reply).not.toContain('reasoning runtime was unavailable');
  });

  test('records effective effort and retains fallback history across rounds', async () => {
    const call = { type: 'function_call', call_id: 'one', name: 'search_memory', arguments: '{}' };
    const first = {
      requestedModel: 'requested',
      effectiveModel: 'actual',
      requestedReasoningEffort: 'max',
      effectiveReasoningEffort: 'high',
      reasoningFallbackReasons: ['max_rejected', 'xhigh_rejected'],
      finishReason: 'completed',
      partial: false,
    };
    const second = {
      ...first,
      effectiveReasoningEffort: null,
      reasoningFallbackReasons: ['reasoning_unsupported'],
    };
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          model: 'actual',
          telemetry: first,
          output: [call],
          functionCalls: [call],
          outputText: '',
        }),
      )
      .mockResolvedValueOnce(response({ model: 'actual', telemetry: second }));
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemas: [
              {
                name: call.name,
                description: call.name,
                input_schema: { type: 'object', properties: {} },
              },
            ],
          }),
        ),
    ) as typeof fetch;
    const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      build(
        registry(
          [{ name: 'search_memory', readOnly: true }],
          jest.fn(async () => ({ records: [] })),
        ),
        complete,
      ).run(context, { messages: [{ role: 'user', text: 'Read memory.' }], reasoningMode: 'max' }),
    );
    expect(result.model).toBe('actual');
    expect(result.reasoningMode).toBe('max');
    expect(result.reasoningEffort).toBeNull();
    expect(result.providerCalls).toEqual([first, second]);
    expect(result.telemetry).toMatchObject({
      effectiveReasoningEffort: null,
      reasoningFallbackReasons: ['max_rejected', 'xhigh_rejected', 'reasoning_unsupported'],
    });
  });

  test('preserves a partial finalization even when the completed draft is usable', async () => {
    const completed = response().telemetry;
    const complete = jest.fn().mockResolvedValue(
      response({
        telemetry: { ...completed, partial: true, finishReason: 'finalization_skipped' },
        providerCalls: [completed],
      }),
    );
    const result = await build(registry([]), complete).run(context, {
      messages: [{ role: 'user', text: 'Prepare a report.' }],
      toolPolicy: 'none',
    });
    expect(result.reply).toBe('Final answer.');
    expect(result.telemetry).toMatchObject({ partial: true, finishReason: 'finalization_skipped' });
  });

  test('returns a reasoned answer without exposing provider reasoning items', async () => {
    const complete = jest.fn(async () =>
      response({
        output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'private' }] }],
        outputText: 'Grounded conclusion.',
      }),
    );
    const assistant = build(registry([]), complete);
    const events: Array<Record<string, unknown>> = [];
    const result = await assistant.run(
      context,
      { messages: [{ role: 'user', text: 'What matters?' }], reasoningMode: 'deep' },
      { onEvent: (event) => events.push(event as unknown as Record<string, unknown>) },
    );
    expect(result.reply).toBe('Grounded conclusion.');
    expect(result.reasoningMode).toBe('deep');
    expect(events.some((event) => event.type === 'reasoning' || event.type === 'thinking')).toBe(
      false,
    );
    expect(JSON.stringify(events)).not.toContain('private');
  });

  test('passes all API-selected unsummarized messages beyond forty into the provider', async () => {
    const complete = jest.fn(async (_params: { input: Array<Record<string, unknown>> }) =>
      response(),
    );
    const assistant = build(registry([]), complete);
    const constraint = 'Treat the FY2027 request as proposed funding, never enacted.';
    const messages = Array.from({ length: 61 }, (_, index) => ({
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      text: index === 0 ? constraint : `Short exchange ${index}`,
    }));
    await assistant.run(context, {
      messages,
      conversationSummary: 'Client scope: Acme. Open work: prepare the briefing.',
    });
    const providerInput = complete.mock.calls[0]?.[0].input as Array<Record<string, unknown>>;
    expect(providerInput).toHaveLength(61);
    expect(providerInput[0]).toMatchObject({ role: 'user', content: constraint });
    expect(providerInput.at(-1)).toMatchObject({ content: 'Short exchange 60' });
  });

  test.each([
    { toolPolicy: 'read-only' as const, name: 'send_email', readOnly: false },
    { toolPolicy: 'none' as const, name: 'search_memory', readOnly: true },
    { toolPolicy: undefined, name: 'unreviewed_api_write', readOnly: false },
  ])(
    'blocks unadvertised $name under $toolPolicy before any execution or approval',
    async ({ toolPolicy, name, readOnly }) => {
      const call = { type: 'function_call', call_id: 'unadvertised-call', name, arguments: '{}' };
      const complete = jest
        .fn()
        .mockResolvedValueOnce(response({ output: [call], outputText: '', functionCalls: [call] }))
        .mockResolvedValueOnce(response({ outputText: 'The operation was blocked.' }));
      const invoke = jest.fn();
      const proposal = jest.fn();
      const assistant = build(registry([{ name, readOnly }], invoke), complete, proposal);
      global.fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              schemas: [
                {
                  name,
                  description: 'Test tool',
                  input_schema: { type: 'object', properties: {} },
                },
              ],
            }),
            { status: 200 },
          ),
      ) as typeof fetch;
      const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        assistant.run(context, {
          messages: [{ role: 'user', text: 'Summarize the notes.' }],
          toolPolicy,
        }),
      );
      expect(complete.mock.calls[0]?.[0].tools).toEqual([]);
      expect(invoke).not.toHaveBeenCalled();
      expect(proposal).not.toHaveBeenCalled();
      expect(result.steps).toEqual(
        expect.arrayContaining([expect.objectContaining({ tool: name, status: 'blocked' })]),
      );
      expect(JSON.stringify(complete.mock.calls[1]?.[0].input)).toContain(
        'not available for this operation',
      );
    },
  );

  test('continues after a read-tool call and feeds the exact result back', async () => {
    const call = {
      type: 'function_call',
      call_id: 'call-1',
      name: 'search_memory',
      arguments: '{"query":"Kestrel"}',
    };
    const complete = jest
      .fn()
      .mockResolvedValueOnce(response({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValueOnce(response({ outputText: 'The stored name is Kestrel.' }));
    const invoke = jest.fn(async () => ({ rows: [{ key: 'nickname', value: 'Kestrel' }] }));
    const assistant = build(
      registry([{ name: 'search_memory', readOnly: true }], invoke),
      complete,
    );
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemas: [
              {
                name: 'search_memory',
                description: 'Search governed memory',
                input_schema: {
                  type: 'object',
                  properties: { query: { type: 'string' } },
                },
              },
            ],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      assistant.run(context, {
        messages: [{ role: 'user', text: 'What nickname do you remember?' }],
      }),
    );
    expect(invoke).toHaveBeenCalledWith(
      'search_memory',
      { query: 'Kestrel' },
      context,
      expect.objectContaining({ signal: expect.any(AbortSignal), deadlineAt: expect.any(Number) }),
    );
    const secondInput = complete.mock.calls[1]?.[0].input as Array<Record<string, unknown>>;
    expect(secondInput).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call_output', call_id: 'call-1' }),
      ]),
    );
    expect(JSON.stringify(secondInput)).toContain('Kestrel');
    expect(result.reply).toBe('The stored name is Kestrel.');
  });

  // The chamber comparison template routes each chamber through `chamber`; a
  // schema that declares it keeps House and Senate as distinct follow-ups.
  const chamberBudgetSchema = {
    name: 'get_pe_budget_timeline',
    description: 'Read budget marks',
    input_schema: {
      type: 'object',
      properties: { peCode: { type: 'string' }, chamber: { type: 'string' } },
      required: ['peCode'],
    },
  };
  const chamberMark = (chamber: unknown) => ({
    data: [
      chamber === 'house'
        ? { id: '0603851F-house', title: 'HAC-D mark for PE 0603851F', description: 'House mark: $412.6 million.' }
        : { id: '0603851F-senate', title: 'SAC-D mark for PE 0603851F', description: 'Senate mark: $400.0 million.' },
    ],
  });
  const structuredLogEvents = (spy: jest.SpyInstance, name: string) =>
    spy.mock.calls.flatMap(([message]) => {
      if (typeof message !== 'string' || !message.startsWith('{')) return [];
      const parsed = JSON.parse(message) as Record<string, unknown>;
      return parsed.event === name ? [parsed] : [];
    });

  test('coverage shadow logs both routed chamber gaps as one JSON line without executing a follow-up', async () => {
    process.env.MERI_COVERAGE_RETRIEVAL_MODE = 'shadow';
    process.env.MERI_COVERAGE_RETRIEVAL_TENANTS = '11111111-1111-4111-8111-111111111111';
    process.env.MERI_COVERAGE_RETRIEVAL_SURFACES = 'chat';
    const complete = jest.fn().mockResolvedValue(response({ outputText: 'Senate position only.' }));
    const invoke = jest.fn();
    const assistant = build(registry([{ name: 'get_pe_budget_timeline', readOnly: true }], invoke), complete);
    const log = jest.spyOn((assistant as unknown as { logger: { log: (...args: unknown[]) => void } }).logger, 'log');
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ schemas: [chamberBudgetSchema] }), { status: 200 })) as typeof fetch;

    const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () => assistant.run(
      { ...context, tenantId: '11111111-1111-4111-8111-111111111111' },
      { conversationId: 'coverage-shadow', messages: [{ role: 'user', text: 'Compare House vs Senate positions on PE 0603851F.' }] },
    ));
    expect(invoke).not.toHaveBeenCalled();
    expect(result.reply).toBe('Senate position only.');
    const event = structuredLogEvents(log, 'meri.coverage.turn')[0]!;
    expect(event).toMatchObject({ mode: 'shadow', executed: 0, followUpPlanned: 2 });
    expect((event.gaps as Array<{ requirementId: string }>).map((gap) => gap.requirementId)).toEqual([
      'house-senate-comparison.house',
      'house-senate-comparison.senate',
    ]);
  });

  test('coverage enforce executes one read-only follow-up per chamber and re-synthesizes over both', async () => {
    process.env.MERI_COVERAGE_RETRIEVAL_MODE = 'enforce';
    process.env.MERI_COVERAGE_RETRIEVAL_TENANTS = '11111111-1111-4111-8111-111111111111';
    process.env.MERI_COVERAGE_RETRIEVAL_SURFACES = 'chat';
    const complete = jest.fn()
      .mockResolvedValueOnce(response({ outputText: 'Senate position only.' }))
      .mockResolvedValueOnce(response({ outputText: 'House [1] and Senate [2] marks compared.' }));
    const invoke = jest.fn(async (_name: string, args: Record<string, unknown>) => chamberMark(args.chamber));
    const assistant = build(registry([{ name: 'get_pe_budget_timeline', readOnly: true }], invoke), complete);
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ schemas: [chamberBudgetSchema] }), { status: 200 })) as typeof fetch;

    const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () => assistant.run(
      { ...context, tenantId: '11111111-1111-4111-8111-111111111111' },
      { conversationId: 'coverage-enforce', messages: [{ role: 'user', text: 'Compare House vs Senate positions on PE 0603851F.' }] },
    ));
    expect(invoke.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ['get_pe_budget_timeline', { peCode: '0603851F', chamber: 'house' }],
      ['get_pe_budget_timeline', { peCode: '0603851F', chamber: 'senate' }],
    ]);
    expect(complete).toHaveBeenCalledTimes(2);
    // Both chambers reach the re-synthesis as distinct tool outputs and citations.
    const synthesisInput = complete.mock.calls[1][0].input as Array<Record<string, unknown>>;
    const outputs = synthesisInput.filter((item) => item.type === 'function_call_output');
    expect(outputs.map((item) => item.call_id)).toEqual(['coverage_follow_up_0', 'coverage_follow_up_1']);
    expect(String(outputs[0]!.output)).toContain('0603851F-house');
    expect(String(outputs[0]!.output)).not.toContain('0603851F-senate');
    expect(String(outputs[1]!.output)).toContain('0603851F-senate');
    expect(result.reply).toBe('House [1] and Senate [2] marks compared.');
    expect(result.citations?.map((citation) => citation.id)).toEqual(['0603851F-house', '0603851F-senate']);
  });

  test('holds a governed write as an opaque proposal instead of invoking it', async () => {
    const call = {
      type: 'function_call',
      call_id: 'call-send',
      name: 'send_email',
      arguments: '{"to":"person@example.com","subject":"Hello","body":"Draft"}',
    };
    const complete = jest
      .fn()
      .mockResolvedValueOnce(response({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValueOnce(response({ outputText: 'I proposed the email for your approval.' }));
    const invoke = jest.fn();
    const createProposal = jest.fn(async () => ({
      disposition: 'pending_approval',
      proposal: {
        proposalId: 'proposal-opaque-1',
        status: 'proposed',
        reason: 'External send requires approval',
        expiresAt: '2026-08-08T00:00:00.000Z',
        riskTier: 'restricted',
        policyCode: 'EXTERNAL_SEND',
        ruleId: 'external-send',
        policy: {
          source: 'pack',
          mode: 'enforce',
          packKey: 'default',
          packVersion: '1',
          binding: 'hash',
          decisionHash: 'decision',
          contextHash: 'context',
          decision: 'WARN',
          jurisdiction: 'federal',
          channel: 'email',
          recipientType: 'external',
        },
        preview: {
          label: 'Send email',
          riskTier: 'restricted',
          leavesFirm: true,
          reversible: false,
          fields: { to: 'person@example.com' },
          counts: {},
          reason: 'External send requires approval',
        },
      },
    }));
    const assistant = build(
      registry([{ name: 'send_email', readOnly: false }], invoke),
      complete,
      createProposal,
    );
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemas: [
              {
                name: 'send_email',
                description: 'Send email',
                input_schema: { type: 'object', properties: {} },
              },
            ],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      assistant.run(context, { messages: [{ role: 'user', text: 'Send this email' }] }),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(createProposal).toHaveBeenCalledTimes(1);
    expect(result.pendingApprovals).toEqual([
      expect.objectContaining({ proposalId: 'proposal-opaque-1', tool: 'send_email' }),
    ]);
  });

  test('blocks a tool request that attempts to escape the pinned client', async () => {
    const call = {
      type: 'function_call',
      call_id: 'call-client',
      name: 'get_client_context',
      arguments: '{"clientId":"client-b"}',
    };
    const complete = jest
      .fn()
      .mockResolvedValueOnce(response({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValueOnce(response({ outputText: 'I did not cross the client boundary.' }));
    const invoke = jest.fn();
    const assistant = build(
      registry([{ name: 'get_client_context', readOnly: true }], invoke),
      complete,
    );
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            schemas: [
              {
                name: 'get_client_context',
                description: 'Get client context',
                input_schema: {
                  type: 'object',
                  properties: { clientId: { type: 'string' } },
                },
              },
            ],
          }),
          { status: 200 },
        ),
    ) as typeof fetch;

    const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
      assistant.run(context, {
        clientId: 'client-a',
        messages: [{ role: 'user', text: 'Tell me about client B' }],
      }),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(result.steps).toEqual([
      expect.objectContaining({ tool: 'get_client_context', status: 'blocked' }),
    ]);
  });

  test.each(['list_emails', 'search_emails'])(
    '%s preserves a provider-selected personal inbox date range without injecting the UI client',
    async (name) => {
      const input = { withinDays: 14, folder: 'inbox', limit: 50 };
      const call = {
        type: 'function_call',
        call_id: 'inbox-call',
        name,
        arguments: JSON.stringify(input),
      };
      const complete = jest
        .fn()
        .mockResolvedValueOnce(response({ output: [call], outputText: '', functionCalls: [call] }))
        .mockResolvedValueOnce(
          response({ outputText: 'You received a meeting invitation for September 8. [1]' }),
        );
      const invoke = jest.fn().mockResolvedValue({
        messages: [
          {
            id: 'personal-mail-1',
            threadId: 'thread-1',
            subject: 'Meeting invitation',
            preview: 'Can we meet on September 8?',
            clientId: null,
            folder: 'inbox',
          },
        ],
        totalMatches: 1,
        returned: 1,
        hasMore: false,
        asOf: '2026-09-07T12:00:00Z',
        searchedMailboxes: [],
      });
      const assistant = build(registry([{ name, readOnly: true }], invoke), complete);
      global.fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              schemas: [
                {
                  name,
                  description: 'Read authenticated mail',
                  input_schema: {
                    type: 'object',
                    properties: {
                      clientId: { type: 'string' },
                      withinDays: { type: 'number' },
                      folder: { type: 'string' },
                      limit: { type: 'number' },
                    },
                  },
                },
              ],
            }),
          ),
      ) as typeof fetch;
      const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        assistant.run(context, {
          clientId: 'client-a',
          messages: [
            {
              role: 'user',
              text: 'what activities do i have in my email inbox for the last two weeks',
            },
          ],
        }),
      );
      expect(invoke).toHaveBeenCalledWith(name, input, context, expect.any(Object));
      expect(JSON.stringify(complete.mock.calls[1][0].input)).toContain('personal-mail-1');
      expect(complete.mock.calls[0][0].instructions).toContain('withinDays=14 and omit clientId');
      expect(result.steps).toEqual([expect.objectContaining({ tool: name, status: 'done' })]);
    },
  );

  test.each(['list_emails', 'search_emails'])(
    '%s still refuses an explicit different client filter',
    async (name) => {
      const call = {
        type: 'function_call',
        call_id: 'inbox-call',
        name,
        arguments: '{"clientId":"client-b","withinDays":14,"folder":"inbox"}',
      };
      const complete = jest
        .fn()
        .mockResolvedValueOnce(response({ output: [call], outputText: '', functionCalls: [call] }))
        .mockResolvedValueOnce(response({ outputText: 'I did not read another client.' }));
      const invoke = jest.fn();
      const assistant = build(registry([{ name, readOnly: true }], invoke), complete);
      global.fetch = jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              schemas: [
                {
                  name,
                  description: 'Read mail',
                  input_schema: { type: 'object', properties: { clientId: { type: 'string' } } },
                },
              ],
            }),
          ),
      ) as typeof fetch;
      const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        assistant.run(context, {
          clientId: 'client-a',
          messages: [{ role: 'user', text: 'Read client B mail.' }],
        }),
      );
      expect(invoke).not.toHaveBeenCalled();
      expect(result.steps).toEqual([expect.objectContaining({ tool: name, status: 'blocked' })]);
    },
  );
});

describe('Durable research cancellation across API replicas', () => {
  const savedFetch = global.fetch;
  afterEach(() => {
    global.fetch = savedFetch;
  });

  test('checks the authenticated run before each tool and stops the batch after durable cancellation', async () => {
    let active = true;
    const calls = ['search_memory', 'search_memory'].map((name, i) => ({
      type: 'function_call',
      call_id: `call-${i}`,
      name,
      arguments: '{}',
    }));
    const complete = jest
      .fn()
      .mockResolvedValue(response({ output: calls, outputText: '', functionCalls: calls }));
    const invoke = jest.fn(async () => {
      active = false;
      return { records: [] };
    });
    const assistant = build(
      registry([{ name: 'search_memory', readOnly: true }], invoke),
      complete,
    );
    const checks: any[] = [];
    global.fetch = jest.fn(async (url, init) => {
      if (String(url).includes('/runs/')) {
        checks.push({ url, headers: init?.headers });
        return new Response(JSON.stringify({ active }), { status: active ? 200 : 409 });
      }
      return new Response(
        JSON.stringify({
          schemas: [
            {
              name: 'search_memory',
              description: 'Memory',
              input_schema: { type: 'object', properties: {} },
            },
          ],
        }),
      );
    }) as typeof fetch;
    const result = await RequestCredentialsStore.run(
      { bearerToken: 'user-token', impersonateTenantId: 'effective-tenant' },
      () =>
        assistant.run(context, {
          messages: [{ role: 'user', text: 'Research the client' }],
          toolPolicy: 'read-only',
          researchRun: { sessionId: 'session-a', runId: 'run-a' },
        }),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(checks).toHaveLength(3); // provider round + first and second dispatch
    expect(checks[0]).toMatchObject({
      url: 'http://api.test/api/clio/research/session-a/runs/run-a/active',
      headers: {
        authorization: 'Bearer user-token',
        'x-capiro-impersonate-tenant': 'effective-tenant',
      },
    });
    expect(result.telemetry).toMatchObject({ finishReason: 'cancelled', partial: true });
    expect(result.reply).toBe('');
  });

  test('a missing or revoked run schedules no provider request', async () => {
    const complete = jest.fn();
    const invoke = jest.fn();
    const assistant = build(registry([], invoke), complete);
    global.fetch = jest.fn(
      async (url) =>
        new Response(JSON.stringify(String(url).includes('/runs/') ? {} : { schemas: [] }), {
          status: String(url).includes('/runs/') ? 404 : 200,
        }),
    ) as typeof fetch;
    await RequestCredentialsStore.run({ bearerToken: 'user-token' }, () =>
      assistant.run(context, {
        messages: [{ role: 'user', text: 'Research' }],
        toolPolicy: 'read-only',
        researchRun: { sessionId: 'other-user-session', runId: 'run-a' },
      }),
    );
    expect(complete).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
  test.each([401, 503])(
    'run-status HTTP %s stays a runtime error rather than reporting a user cancellation',
    async (status) => {
      const complete = jest.fn();
      const assistant = build(registry([]), complete);
      global.fetch = jest.fn(
        async (url) =>
          new Response(JSON.stringify(String(url).includes('/runs/') ? {} : { schemas: [] }), {
            status: String(url).includes('/runs/') ? status : 200,
          }),
      ) as typeof fetch;
      const result = await RequestCredentialsStore.run({ bearerToken: 'user-token' }, () =>
        assistant.run(context, {
          messages: [{ role: 'user', text: 'Research' }],
          toolPolicy: 'read-only',
          researchRun: { sessionId: 'session-a', runId: 'run-a' },
        }),
      );
      expect(complete).not.toHaveBeenCalled();
      expect(result.telemetry).toMatchObject({ finishReason: 'runtime_error', partial: true });
    },
  );
});

describe('MeriV3 client transcript task completion', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = jest.fn(
      async () => new Response(JSON.stringify({ schemas: clientDocumentSchemas }), { status: 200 }),
    ) as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const call = (name: string, args: Record<string, unknown>, id: string) => ({
    type: 'function_call' as const,
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  });
  const toolResponse = (item: ReturnType<typeof call>) =>
    response({ outputText: '', output: [item], functionCalls: [item] });
  const task =
    'I uploaded the transcripts from our last meetings. Make a list of the meetings and find exact names, positions and contact information.';

  test('replays a location clarification, reads beyond 35k characters, and continues contact research after premature prose', async () => {
    const text =
      'Introductory discussion.\n'.repeat(1600) +
      '\nSeptember 21-24: arrange meetings with Alex Carter and Dana Smith.\n' +
      'Closing discussion.\n'.repeat(700);
    const invoke = documentFixture(text);
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        toolResponse(call('get_research_evidence', { sessionId: 'guessed-chat-id' }, 'wrong-tool')),
      )
      .mockResolvedValueOnce(
        toolResponse(
          call(
            'read_client_documents',
            { clientId: 'client-1', documentId: 'transcript-1' },
            'read',
          ),
        ),
      )
      .mockResolvedValueOnce(
        response({ outputText: 'Would you like me to find names and contact details?' }),
      )
      .mockResolvedValueOnce(
        toolResponse(call('find_contacts', { query: 'Alex Carter Dana Smith' }, 'contacts')),
      )
      .mockResolvedValueOnce(
        response({
          outputText:
            'September 21-24: Alex Carter, Director. Dana Smith: identity and contact details remain unverified.',
        }),
      );
    const assistant = build(
      registry(
        clientDocumentSchemas.map(({ name }) => ({ name, readOnly: true })),
        invoke,
      ),
      complete,
    );
    const onEvent = jest.fn();
    const result = await RequestCredentialsStore.run({ bearerToken: 'test-token' }, () =>
      assistant.run(
        context,
        {
          clientId: 'client-1',
          conversationId: 'thread-1',
          messages: [
            { role: 'user', text: 'What should I know about Acme?' },
            { role: 'assistant', text: 'Client overview.' },
            { role: 'user', text: task },
            { role: 'assistant', text: 'Where are the files?' },
            { role: 'user', text: 'I uploaded the transcript into the Acme files.' },
          ],
        },
        { onEvent },
      ),
    );
    expect(
      complete.mock.calls[0][0].tools.map((tool: { name: string }) => tool.name),
    ).not.toContain('get_research_evidence');
    expect(invoke.mock.calls.some(([name]) => name === 'get_research_evidence')).toBe(false);
    expect(invoke.mock.calls[0]?.slice(0, 2)).toMatchObject([
      'read_client_documents',
      { clientId: 'client-1' },
    ]);
    expect(
      invoke.mock.calls.some(
        ([name, args]) => name === 'read_client_documents' && args.cursor === 'page:40000',
      ),
    ).toBe(true);
    expect(invoke.mock.calls.some(([name]) => name === 'find_contacts')).toBe(true);
    const modelInput = JSON.stringify(complete.mock.calls[2][0].input);
    expect(modelInput).toContain('arrange meetings with Alex Carter and Dana Smith');
    expect(complete.mock.calls[0][0].instructions).toContain(task);
    expect(result.telemetry).toMatchObject({ partial: false, finishReason: 'completed' });
    expect(result.reply).toContain('September 21-24');
    expect(
      onEvent.mock.calls
        .filter(([event]) => event.type === 'text')
        .map(([event]) => event.text)
        .join(''),
    ).not.toContain('Would you like');
  });

  test('a file listing alone cannot release made-up content or claim an upload failure', async () => {
    const invoke = documentFixture('Real document.');
    const complete = jest.fn().mockResolvedValue(
      response({
        outputText: 'Your upload failed. The transcript says to meet Fictional Person.',
      }),
    );
    const assistant = build(
      registry(
        clientDocumentSchemas.map(({ name }) => ({ name, readOnly: true })),
        invoke,
      ),
      complete,
    );
    const result = await RequestCredentialsStore.run({ bearerToken: 'test-token' }, () =>
      assistant.run(context, {
        clientId: 'client-1',
        messages: [{ role: 'user', text: task }],
      }),
    );
    expect(complete).toHaveBeenCalledTimes(3);
    expect(result.telemetry).toMatchObject({ partial: true, finishReason: 'incomplete_evidence' });
    expect(result.reply).toContain('contents have not been read');
    expect(result.reply).not.toContain('Fictional Person');
    expect(result.reply).not.toContain('Your upload failed');
  });

  test('bounds automatic reads and discloses an unfinished document instead of reporting completion', async () => {
    const invoke = documentFixture('Discussion.\n'.repeat(20000));
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        toolResponse(
          call(
            'read_client_documents',
            { clientId: 'client-1', documentId: 'transcript-1' },
            'read',
          ),
        ),
      )
      .mockResolvedValue(
        response({ outputText: 'Here is a partial summary of the text reviewed.' }),
      );
    const assistant = build(
      registry(
        clientDocumentSchemas.map(({ name }) => ({ name, readOnly: true })),
        invoke,
      ),
      complete,
    );
    const result = await RequestCredentialsStore.run({ bearerToken: 'test-token' }, () =>
      assistant.run(context, {
        clientId: 'client-1',
        messages: [
          { role: 'user', text: 'Review the uploaded meeting transcript and list the meetings.' },
        ],
      }),
    );
    expect(invoke.mock.calls.filter(([name]) => name === 'read_client_documents')).toHaveLength(25);
    expect(result.reply).toContain('not been fully reviewed');
    expect(result.telemetry?.partial).toBe(true);
  });

  test('checks access again for each page and stops after a revoked read', async () => {
    const source = documentFixture('Discussion.\n'.repeat(1000));
    const invoke = jest.fn(async (name, args) => {
      if (args.cursor) throw new Error('Attachment not found');
      return source(name, args);
    });
    const complete = jest
      .fn()
      .mockResolvedValueOnce(
        toolResponse(
          call(
            'read_client_documents',
            { clientId: 'client-1', documentId: 'transcript-1' },
            'read',
          ),
        ),
      )
      .mockResolvedValue(response({ outputText: 'Only the first passage was available.' }));
    const assistant = build(
      registry(
        clientDocumentSchemas.map(({ name }) => ({ name, readOnly: true })),
        invoke,
      ),
      complete,
    );
    const result = await RequestCredentialsStore.run({ bearerToken: 'test-token' }, () =>
      assistant.run(context, {
        clientId: 'client-1',
        messages: [{ role: 'user', text: 'Review the uploaded meeting transcript.' }],
      }),
    );
    expect(invoke.mock.calls.filter(([, args]) => args.cursor)).toHaveLength(1);
    expect(result.telemetry?.partial).toBe(true);
    expect(result.reply).toContain('not been fully reviewed');
  });

  test('binds research evidence to the authenticated run instead of a model-supplied session', async () => {
    const call = {
      type: 'function_call' as const,
      call_id: 'evidence-1',
      name: 'get_research_evidence',
      arguments: JSON.stringify({ sessionId: 'guessed-chat-id' }),
    };
    const complete = jest
      .fn()
      .mockResolvedValueOnce(response({ outputText: '', output: [call], functionCalls: [call] }))
      .mockResolvedValueOnce(response());
    const invoke = jest.fn(async () => ({ records: [] }));
    const assistant = build(
      registry([{ name: 'get_research_evidence', readOnly: true }], invoke),
      complete,
    );
    global.fetch = jest.fn(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes('/runs/')
              ? { active: true }
              : {
                  schemas: clientDocumentSchemas.filter(
                    (schema) => schema.name === 'get_research_evidence',
                  ),
                },
          ),
          { status: 200 },
        ),
    ) as typeof fetch;
    await RequestCredentialsStore.run({ bearerToken: 'user-token' }, () =>
      assistant.run(context, {
        messages: [{ role: 'user', text: 'Review the research evidence.' }],
        toolPolicy: 'read-only',
        researchRun: { sessionId: 'session-a', runId: 'run-a' },
      }),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]?.slice(0, 2)).toEqual([
      'get_research_evidence',
      { sessionId: 'session-a' },
    ]);
  });

  test('cancellation stops automatic reads before another page or model call', async () => {
    const controller = new AbortController();
    const source = documentFixture('Discussion.\n'.repeat(1000));
    const invoke = jest.fn(async (name, args) => {
      const result = await source(name, args);
      if (args.documentId) controller.abort();
      return result;
    });
    const complete = jest.fn().mockResolvedValueOnce(
      toolResponse(
        call(
          'read_client_documents',
          {
            clientId: 'client-1',
            documentId: 'transcript-1',
          },
          'read',
        ),
      ),
    );
    const assistant = build(
      registry(
        clientDocumentSchemas.map(({ name }) => ({ name, readOnly: true })),
        invoke,
      ),
      complete,
    );
    const result = await RequestCredentialsStore.run({ bearerToken: 'test-token' }, () =>
      assistant.run(
        context,
        {
          clientId: 'client-1',
          messages: [{ role: 'user', text: 'Review the uploaded meeting transcript.' }],
        },
        { signal: controller.signal },
      ),
    );
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result.telemetry).toMatchObject({ partial: true, finishReason: 'cancelled' });
    expect(result.reply).toBe('');
  });
});

describe('Stage 2 orchestrator hardening', () => {
  const PILOT = '11111111-1111-4111-8111-111111111111';
  const pilotContext = { ...context, tenantId: PILOT } as MeriContext;
  const originalFetch = global.fetch;
  const CAPABILITIES = [
    'COVERAGE_RETRIEVAL',
    'PASSAGE_SELECTION',
    'AUTO_CORRECTION',
    'JEV_PROVIDER',
    'CLAIM_ASSESSMENT',
    'EVIDENCE_ACCURACY',
  ] as const;
  type Capability = (typeof CAPABILITIES)[number];

  function enroll(
    capability: Capability,
    mode: 'off' | 'shadow' | 'enforce',
    options: { tenants?: string; surfaces?: string } = {},
  ): void {
    process.env[`MERI_${capability}_MODE`] = mode;
    process.env[`MERI_${capability}_TENANTS`] = options.tenants ?? PILOT;
    process.env[`MERI_${capability}_SURFACES`] = options.surfaces ?? 'chat';
  }

  afterEach(() => {
    global.fetch = originalFetch;
    for (const capability of CAPABILITIES) {
      for (const suffix of ['MODE', 'TENANTS', 'SURFACES']) {
        delete process.env[`MERI_${capability}_${suffix}`];
      }
    }
    delete process.env.MERI_AUTO_CORRECTION_CATEGORIES;
    delete process.env.MERI_RELEASE_GATE;
    delete process.env.MERI_RELEASE_GATE_TENANTS;
    delete process.env.MERI_RELEASE_GATE_SURFACES;
    delete process.env.MERI_CHAT_EVIDENCE_JUDGE;
    delete process.env.TYPESAFE_API_KEY;
    resetMeriV3RolloutDiagnosticsForTest();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const schemaOf = (name: string, properties: Record<string, unknown>, required: string[] = []) => ({
    name,
    description: name,
    input_schema: { type: 'object', properties, ...(required.length ? { required } : {}) },
  });
  const BUDGET_SCHEMA = schemaOf(
    'get_pe_budget_timeline',
    { peCode: { type: 'string' }, chamber: { type: 'string' } },
    ['peCode'],
  );
  const BILLS_SCHEMA = schemaOf('search_congress_bills', { query: { type: 'string' } });
  const BILL_STATUS_SCHEMA = schemaOf('get_bill_status', { billId: { type: 'string' } });

  function fetchWith(schemas: unknown[], runsActive = true): typeof fetch {
    return jest.fn(async (url: unknown) =>
      String(url).includes('/runs/')
        ? new Response(JSON.stringify({ active: runsActive }), { status: runsActive ? 200 : 409 })
        : new Response(JSON.stringify({ schemas }), { status: 200 }),
    ) as unknown as typeof fetch;
  }
  const fnCall = (name: string, args: Record<string, unknown>, callId: string) => ({
    type: 'function_call',
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
  });
  const toolRound = (...calls: ReturnType<typeof fnCall>[]) =>
    response({ output: calls, outputText: '', functionCalls: calls });
  /** A budget row whose citation snippet (description) never repeats the figure. */
  const budgetResult = (peCode: string, amountText: string) => ({
    data: [
      {
        id: `${peCode}-fy27-hacd`,
        title: `PE ${peCode} FY2027 HAC-D mark`,
        description: 'Program description; the mark appears in the amount field.',
        amountText,
      },
    ],
  });
  function logSpies(assistant: MeriV3AssistantService) {
    const logger = (
      assistant as unknown as {
        logger: { log: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
      }
    ).logger;
    return {
      log: jest.spyOn(logger, 'log').mockImplementation(() => undefined),
      warn: jest.spyOn(logger, 'warn').mockImplementation(() => undefined),
    };
  }
  const structuredEvents = (spy: jest.SpyInstance): Array<Record<string, unknown>> =>
    spy.mock.calls.flatMap(([message]) => {
      if (typeof message !== 'string' || !message.startsWith('{')) return [];
      try {
        return [JSON.parse(message) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  const eventsNamed = (spy: jest.SpyInstance, name: string) =>
    structuredEvents(spy).filter((event) => event.event === name);
  const firstEvent = (spy: jest.SpyInstance, name: string): Record<string, unknown> => {
    const [event] = eventsNamed(spy, name);
    if (!event) throw new Error(`no ${name} event was logged`);
    return event;
  };
  const textFrames = (events: MeriV3ChatStreamEvent[]) => events.filter((event) => event.type === 'text');
  const callIds = (input: Array<Record<string, unknown>>, type: string) =>
    input.filter((item) => item.type === type).map((item) => item.call_id);
  const answersFor = (candidates: readonly PassageCandidate[], score: number) => ({
    probabilities: Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        { relevant: score, usable: score, contradicts: 0.01, requiredTopic: score },
      ]),
    ),
    inputTokens: 12,
    latencyMs: 3,
    model: 'jev-1.13.0',
    questionVersion: 'passage_selection.v1' as const,
    fallback: false,
  });
  const repairResult = (
    overrides: Partial<Awaited<ReturnType<typeof liveRepair.applyLiveRepair>>> = {},
  ): Awaited<ReturnType<typeof liveRepair.applyLiveRepair>> => ({
    reply: '',
    citations: [],
    changed: false,
    outcomes: {},
    toolCalls: 0,
    passes: 0,
    metrics: {
      repairs: { attempted: 1, corrected: 1, qualified: 0, omitted: 0, documentRequested: 0, budgetExhausted: 0 },
      wouldAttempt: 0,
      unresolved: 0,
      claimOutcomes: [],
      assessmentMs: 5,
      repairMs: 5,
      inputTokens: 40,
      jevInputTokens: 0,
      legacyInputTokens: 40,
      revisionInputTokens: 0,
      revisionOutputTokens: 0,
      recheckInputTokens: 0,
      estimatedCostUsd: 0,
      sampled: false,
    },
    ...overrides,
  });
  const fakeTimers = () =>
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });

  describe('passage selection (S2-B)', () => {
    const budgetCall = fnCall('get_pe_budget_timeline', { peCode: '0603851F' }, 'budget-call');
    const billsCall = fnCall('search_congress_bills', { query: 'PE 0603851F' }, 'bills-call');
    const PROSE = 'HAC-D marked PE 0603851F at $412.6 million. [1]';
    const REWRITTEN = 'HAC-D marked PE 0603851F at $412.6 million for FY2027. [1]';
    const budgetRegistry = (invoke: jest.Mock) =>
      registry(
        [
          { name: 'get_pe_budget_timeline', readOnly: true },
          { name: 'search_congress_bills', readOnly: true },
        ],
        invoke,
      );
    const budgetInvoke = () =>
      jest.fn(async (name: string) =>
        name === 'get_pe_budget_timeline'
          ? budgetResult('0603851F', '$412.6 million')
          : { data: [{ id: 'hr-1', title: 'H.R. 1', description: 'An unrelated bill.' }] },
      );
    const runBudgetTurn = (assistant: MeriV3AssistantService, events: MeriV3ChatStreamEvent[] = []) =>
      RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        assistant.run(
          pilotContext,
          {
            conversationId: 'passage-turn',
            messages: [{ role: 'user', text: 'What did HAC-D mark for PE 0603851F?' }],
          },
          { onEvent: (event) => events.push(event) },
        ),
      );

    test('enforce keeps a plan-required family passage while coverage retrieval is on', async () => {
      enroll('COVERAGE_RETRIEVAL', 'shadow');
      enroll('PASSAGE_SELECTION', 'enforce');
      const complete = jest
        .fn()
        .mockResolvedValueOnce(toolRound(budgetCall, billsCall))
        .mockResolvedValueOnce(response({ outputText: PROSE }))
        .mockResolvedValueOnce(response({ outputText: REWRITTEN }));
      const assistant = build(budgetRegistry(budgetInvoke()), complete);
      const spies = logSpies(assistant);
      // Jev scores every passage below both thresholds; only a retention pin keeps one.
      jest
        .spyOn(passageSelector, 'askPassageQuestions')
        .mockImplementation(async ({ candidates }) => answersFor(candidates, 0.05));
      global.fetch = fetchWith([BUDGET_SCHEMA, BILLS_SCHEMA]);

      const result = await runBudgetTurn(assistant);
      expect(complete).toHaveBeenCalledTimes(3);
      const synthesisInput = complete.mock.calls[2][0].input as Array<Record<string, unknown>>;
      expect(callIds(synthesisInput, 'function_call_output')).toEqual(['budget-call']);
      expect(callIds(synthesisInput, 'function_call')).toEqual(['budget-call']);
      expect(JSON.stringify(synthesisInput)).toContain('$412.6 million');
      const canary = firstEvent(spies.log, 'meri.canary.turn');
      expect(canary.passageSelection).toMatchObject({
        candidates: 2, kept: 1, dropped: 1, requiredCandidates: 1, requiredRetained: 1, fallback: false,
      });
      expect(eventsNamed(spies.log, 'meri.passage_selection')[0]).toMatchObject({
        mode: 'enforce', applied: true, removedCalls: 1, evidenceRecall: 1,
      });
      expect(result.reply).toBe(REWRITTEN);
    });

    test('enforce keeps the completed prose without a second synthesis when nothing is dropped', async () => {
      enroll('PASSAGE_SELECTION', 'enforce');
      const complete = jest
        .fn()
        .mockResolvedValueOnce(toolRound(budgetCall, billsCall))
        .mockResolvedValueOnce(response({ outputText: PROSE }));
      const assistant = build(budgetRegistry(budgetInvoke()), complete);
      const spies = logSpies(assistant);
      jest
        .spyOn(passageSelector, 'askPassageQuestions')
        .mockImplementation(async ({ candidates }) => answersFor(candidates, 0.9));
      global.fetch = fetchWith([BUDGET_SCHEMA, BILLS_SCHEMA]);

      const events: MeriV3ChatStreamEvent[] = [];
      const result = await runBudgetTurn(assistant, events);
      expect(complete).toHaveBeenCalledTimes(2);
      expect(result.reply).toBe(PROSE);
      expect(textFrames(events)).toEqual([{ type: 'text', text: PROSE }]);
      const canary = firstEvent(spies.log, 'meri.canary.turn');
      expect(canary.passageSelection).toMatchObject({ candidates: 2, kept: 2, dropped: 0, fallback: false });
      expect(eventsNamed(spies.log, 'meri.passage_selection')[0]).toMatchObject({ applied: false, removedCalls: 0 });
    });

    test.each([
      ['rejects', () => Promise.reject(new Error('synthesis provider unavailable'))],
      ['returns empty prose', () => Promise.resolve(response({ outputText: '' }))],
    ])('enforce releases the completed prose when the forced re-synthesis %s', async (_label, thirdCall) => {
      enroll('PASSAGE_SELECTION', 'enforce');
      const complete = jest
        .fn()
        .mockResolvedValueOnce(toolRound(budgetCall, billsCall))
        .mockResolvedValueOnce(response({ outputText: PROSE }))
        .mockImplementationOnce(thirdCall);
      const assistant = build(budgetRegistry(budgetInvoke()), complete);
      const spies = logSpies(assistant);
      jest
        .spyOn(passageSelector, 'askPassageQuestions')
        .mockImplementation(async ({ candidates }) => answersFor(candidates, 0.05));
      global.fetch = fetchWith([BUDGET_SCHEMA, BILLS_SCHEMA]);

      const events: MeriV3ChatStreamEvent[] = [];
      const result = await runBudgetTurn(assistant, events);
      expect(complete).toHaveBeenCalledTimes(3);
      expect(result.reply).toBe(PROSE);
      expect(result.reply).not.toContain('reasoning runtime was unavailable');
      expect(textFrames(events)).toEqual([{ type: 'text', text: PROSE }]);
      expect(result.telemetry).toMatchObject({ finishReason: 'completed' });
      expect(eventsNamed(spies.warn, 'meri.passage_selection.failed')).toEqual([
        expect.objectContaining({ keptCompletedProse: true }),
      ]);
    });

    test('selection time is charged to the turn deadline instead of extending the synthesis timeout', async () => {
      fakeTimers();
      const startedAt = new Date('2026-09-22T12:00:00.000Z').getTime();
      jest.setSystemTime(startedAt);
      enroll('PASSAGE_SELECTION', 'shadow');
      const complete = jest
        .fn()
        .mockResolvedValueOnce(toolRound(budgetCall))
        .mockResolvedValueOnce(response({ outputText: '' }))
        .mockResolvedValueOnce(response({ outputText: PROSE }));
      const assistant = build(budgetRegistry(budgetInvoke()), complete);
      logSpies(assistant);
      const ask = jest
        .spyOn(passageSelector, 'askPassageQuestions')
        .mockImplementation(async ({ candidates }) => {
          jest.setSystemTime(Date.now() + 3_000);
          return answersFor(candidates, 0.9);
        });
      global.fetch = fetchWith([BUDGET_SCHEMA]);

      const result = await runBudgetTurn(assistant);
      expect(result.reply).toBe(PROSE);
      expect(complete).toHaveBeenCalledTimes(3);
      const synthesis = complete.mock.calls[2][0] as { timeoutMs: number; deadlineAt: number };
      expect(synthesis.deadlineAt - startedAt).toBeGreaterThan(3_000);
      // The 3 s spent in Jev came out of the synthesis window, not on top of it.
      expect(synthesis.timeoutMs).toBe(synthesis.deadlineAt - (startedAt + 3_000));
      const askInput = ask.mock.calls[0]![0];
      expect(askInput.signal).toBeInstanceOf(AbortSignal);
      expect(askInput.deadlineAt).toBeLessThanOrEqual(synthesis.deadlineAt - 1_000);
    });

    test('shadow reports the prompt-size metric from text lengths and leaves the synthesis request untouched', async () => {
      enroll('PASSAGE_SELECTION', 'shadow');
      const complete = jest
        .fn()
        .mockResolvedValueOnce(toolRound(budgetCall, billsCall))
        .mockResolvedValueOnce(response({ outputText: '' }))
        .mockResolvedValueOnce(response({ outputText: PROSE }));
      const assistant = build(budgetRegistry(budgetInvoke()), complete);
      const spies = logSpies(assistant);
      jest
        .spyOn(passageSelector, 'askPassageQuestions')
        .mockImplementation(async ({ candidates }) => answersFor(candidates, 0.05));
      global.fetch = fetchWith([BUDGET_SCHEMA, BILLS_SCHEMA]);

      await runBudgetTurn(assistant);
      const event = firstEvent(spies.log, 'meri.passage_selection');
      const gather = complete.mock.calls[0][0] as { instructions: string };
      const synthesis = complete.mock.calls[2][0] as { input: Array<Record<string, unknown>> };
      const chars = (items: Array<Record<string, unknown>>) =>
        items.reduce(
          (sum, item) =>
            sum +
            (typeof item.content === 'string' ? item.content.length : 0) +
            (typeof item.output === 'string' ? item.output.length : 0) +
            (typeof item.arguments === 'string' ? item.arguments.length : 0),
          0,
        );
      // The plan-required budget passage is pinned; only the unrelated bill passage drops.
      expect(event).toMatchObject({ mode: 'shadow', applied: false, candidates: 2, dropped: 1 });
      expect(event.promptCharsBefore).toBe(gather.instructions.length + chars(synthesis.input));
      expect(event.promptCharsAfter).toBeLessThan(event.promptCharsBefore as number);
      // Shadow never changes the request: both tool calls are still replayed.
      expect(callIds(synthesis.input, 'function_call_output')).toEqual(['budget-call', 'bills-call']);
    });
  });

  describe('canary event (S2-E)', () => {
    test('emits one JSON line that readCanaryEvents parses back to the same event', async () => {
      const complete = jest.fn().mockResolvedValue(response({ outputText: 'H.R. 1 passed.' }));
      const assistant = build(registry([]), complete);
      const spies = logSpies(assistant);
      await assistant.run(context, {
        conversationId: 'canary-line',
        messages: [{ role: 'user', text: 'What happened?' }],
        toolPolicy: 'none',
      });
      const lines = spies.log.mock.calls
        .map(([message]) => message)
        .filter((message): message is string => typeof message === 'string' && message.includes('"meri.canary.turn"'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toMatch(/\n/);
      const dir = mkdtempSync(join(tmpdir(), 'meri-canary-'));
      try {
        const file = join(dir, 'canary.jsonl');
        writeFileSync(file, `${lines[0]}\n`, 'utf8');
        const parsed = readCanaryEvents(file);
        expect(parsed).toMatchObject({ rejected: 0, unrelated: 0 });
        expect(parsed.events).toEqual([JSON.parse(lines[0]!)]);
        expect(parsed.events[0]).toMatchObject({
          event: 'meri.canary.turn', tenantId: 'tenant-1', surface: 'chat', outcome: 'released',
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('emits the text frame before the canary event and measures time-to-text at that frame', async () => {
      const complete = jest.fn().mockResolvedValue(response({ outputText: 'H.R. 1 passed.' }));
      const assistant = build(registry([]), complete);
      const order: string[] = [];
      const spies = logSpies(assistant);
      spies.log.mockImplementation((message: unknown) => {
        if (typeof message === 'string' && message.includes('"event":"meri.canary.turn"')) order.push('canary');
      });
      await assistant.run(
        context,
        { conversationId: 'order', messages: [{ role: 'user', text: 'What happened?' }], toolPolicy: 'none' },
        { onEvent: (event) => { if (event.type === 'text') order.push('text'); } },
      );
      expect(order).toEqual(['text', 'canary']);
      const canary = firstEvent(spies.log, 'meri.canary.turn');
      const latency = canary.latencyMs as { timeToText: number; total: number };
      expect(latency.timeToText).toBeLessThanOrEqual(latency.total);
    });

    test('records the tenant-resolved Jev provider mode and the resolved routing', async () => {
      enroll('JEV_PROVIDER', 'enforce');
      const complete = jest.fn().mockResolvedValue(response({ outputText: 'H.R. 1 passed.' }));
      const assistant = build(registry([]), complete);
      const spies = logSpies(assistant);
      const dto = { messages: [{ role: 'user' as const, text: 'What happened?' }], toolPolicy: 'none' as const };
      await assistant.run(context, dto);
      await assistant.run(pilotContext, dto);
      const canaries = eventsNamed(spies.log, 'meri.canary.turn');
      expect(canaries).toHaveLength(2);
      expect(canaries[0]!.modes).toMatchObject({ jevProvider: 'off', routing: 'llm' });
      expect(canaries[1]!.modes).toMatchObject({ jevProvider: 'enforce', routing: 'llm' });
    });
  });

  describe('shadow events (Stage 1)', () => {
    test('emits meri.evidence_shadow and meri.evidence_shadow.turn as JSON lines that readShadowEvents parses back', async () => {
      const tenantId = '17b63099-bc0f-4ac5-b596-496161e9481e';
      process.env.MERI_CLAIM_ASSESSMENT_MODE = 'shadow';
      process.env.MERI_CLAIM_ASSESSMENT_TENANTS = tenantId;
      process.env.MERI_CLAIM_ASSESSMENT_SURFACES = 'chat';
      process.env.MERI_CHAT_EVIDENCE_JUDGE = 'llm';
      const complete = jest.fn().mockResolvedValue(response({ outputText: 'H.R. 1 passed.' }));
      const assistant = build(registry([]), complete);
      const spies = logSpies(assistant);
      // The payloads exactly as the shadow assessor handed them to the service's structured logger.
      const structured = jest.spyOn(
        assistant as unknown as {
          logStructured: (level: 'log' | 'warn', event: string, fields: Record<string, unknown>) => void;
        },
        'logStructured',
      );
      await assistant.run({ ...context, tenantId } as MeriContext, {
        conversationId: 'thread-shadow-jsonl',
        messages: [{ role: 'user', text: 'What happened?' }],
      });
      // Shadow assessment is scheduled after the text emission; the turn summary is its last event.
      const shadowLines = () =>
        spies.log.mock.calls
          .map(([message]) => message)
          .filter((message): message is string => SHADOW_EVENTS.has(eventNameOf(message) ?? ''));
      const deadline = Date.now() + 5_000;
      while (
        !shadowLines().some((line) => eventNameOf(line) === 'meri.evidence_shadow.turn') &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const lines = shadowLines();
      const payloads = structured.mock.calls
        .filter(([level, event]) => level === 'log' && SHADOW_EVENTS.has(event))
        .map(([, event, fields]) => ({ event, ...fields }));
      expect(lines.map((line) => eventNameOf(line))).toContain('meri.evidence_shadow');
      expect(eventNameOf(lines[lines.length - 1])).toBe('meri.evidence_shadow.turn');
      expect(lines).toHaveLength(payloads.length);
      lines.forEach((line, index) => {
        // One JSON object on one line, carrying the event name as a field.
        expect(line).not.toMatch(/\n/);
        expect(JSON.parse(line)).toEqual(payloads[index]);
      });
      const dir = mkdtempSync(join(tmpdir(), 'meri-shadow-'));
      try {
        const file = join(dir, 'shadow.jsonl');
        writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
        const parsed = readShadowEvents(file);
        expect(parsed).toMatchObject({ rejected: 0, unrelated: 0 });
        expect(parsed.events.map((event) => event.event)).toEqual(payloads.map((payload) => payload.event));
        parsed.events.forEach((event, index) => {
          // Every field the report reads back is the field the service emitted;
          // `source: 'live'` is the parser's default for an exported event.
          expect({ ...payloads[index], source: 'live' }).toEqual(expect.objectContaining(event));
        });
        expect(parsed.events[0]).toMatchObject({
          event: 'meri.evidence_shadow',
          conversationId: 'thread-shadow-jsonl',
          claimId: expect.any(String),
          envelopeHash: expect.any(String),
          agreement: expect.any(Boolean),
        });
        expect(parsed.events[parsed.events.length - 1]).toMatchObject({
          event: 'meri.evidence_shadow.turn',
          conversationId: 'thread-shadow-jsonl',
          selected: expect.any(Number),
          skipped: expect.any(Number),
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('surface and rollout scoping', () => {
    test('a Deep Research run resolves every Stage 0-2 mode as off under a chat-only enrollment', async () => {
      for (const capability of CAPABILITIES) enroll(capability, 'enforce');
      process.env.MERI_AUTO_CORRECTION_CATEGORIES = 'bill_status';
      const complete = jest.fn().mockResolvedValue(response({ outputText: 'Research summary.' }));
      const assistant = build(registry([]), complete);
      const spies = logSpies(assistant);
      global.fetch = fetchWith([]);
      await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        assistant.run(pilotContext, {
          conversationId: 'research-run',
          messages: [{ role: 'user', text: 'Research the status of H.R. 1.' }],
          toolPolicy: 'read-only',
          researchRun: { sessionId: 'session-a', runId: 'run-a' },
        }),
      );
      const research = firstEvent(spies.log, 'meri.canary.turn');
      expect(research.surface).toBe('research');
      expect(research.modes).toEqual({
        evidenceAccuracy: 'off', claimAssessment: 'off', coverageRetrieval: 'off',
        passageSelection: 'off', autoCorrection: 'off', jevProvider: 'off', routing: 'llm',
      });
      expect(eventsNamed(spies.log, 'meri.coverage.turn')).toHaveLength(0);

      // The same enrollment still governs a chat turn for the pilot tenant.
      await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        assistant.run(pilotContext, {
          conversationId: 'chat-turn',
          messages: [{ role: 'user', text: 'Research the status of H.R. 1.' }],
          toolPolicy: 'none',
        }),
      );
      const chat = eventsNamed(spies.log, 'meri.canary.turn')[1]!;
      expect(chat.surface).toBe('chat');
      expect(chat.modes).toMatchObject({
        coverageRetrieval: 'enforce', passageSelection: 'enforce', autoCorrection: 'enforce', jevProvider: 'enforce',
      });
    });

    test('warns once about unknown MERI_AUTO_CORRECTION_CATEGORIES tokens even when every token is unknown', async () => {
      enroll('AUTO_CORRECTION', 'shadow');
      process.env.MERI_AUTO_CORRECTION_CATEGORIES = 'bill-status,member-vote';
      const complete = jest.fn().mockResolvedValue(response({ outputText: 'H.R. 1 passed.' }));
      const assistant = build(registry([]), complete);
      const spies = logSpies(assistant);
      const dto = { messages: [{ role: 'user' as const, text: 'What happened?' }], toolPolicy: 'none' as const };
      await assistant.run(pilotContext, dto);
      await assistant.run(pilotContext, dto);
      expect(eventsNamed(spies.warn, 'meri.auto_correction.unknown_categories')).toEqual([
        expect.objectContaining({ tokens: ['bill-status', 'member-vote'] }),
      ]);
    });

    test('logs meri.rollout.invalid_config once when a Stage 2 control carries a malformed token', async () => {
      enroll('COVERAGE_RETRIEVAL', 'shadow', { tenants: 'capiro-internal' });
      const complete = jest.fn().mockResolvedValue(response({ outputText: 'Senate position only.' }));
      const assistant = build(registry([]), complete);
      const spies = logSpies(assistant);
      const dto = {
        messages: [{ role: 'user' as const, text: 'Compare House vs Senate positions on PE 0603851F.' }],
        toolPolicy: 'none' as const,
      };
      await assistant.run(pilotContext, dto);
      await assistant.run(pilotContext, dto);
      expect(eventsNamed(spies.warn, 'meri.rollout.invalid_config')).toEqual([
        expect.objectContaining({ capability: 'COVERAGE_RETRIEVAL', issues: ['invalid_tenant:capiro-internal'] }),
      ]);
      expect(eventsNamed(spies.log, 'meri.coverage.turn')).toHaveLength(0);
    });
  });

  describe('release gate interplay', () => {
    const armReleaseGate = () => {
      process.env.MERI_RELEASE_GATE = 'enforce';
      process.env.MERI_RELEASE_GATE_TENANTS = PILOT;
      process.env.MERI_RELEASE_GATE_SURFACES = 'chat';
    };

    test('never appends the coverage disclosure to a held refusal', async () => {
      armReleaseGate();
      enroll('COVERAGE_RETRIEVAL', 'enforce');
      const complete = jest.fn().mockResolvedValue(
        response({ outputText: 'The House marked PE 0603851F at $412.6 million and the Senate at $400 million.' }),
      );
      const assistant = build(registry([]), complete);
      logSpies(assistant);
      const events: MeriV3ChatStreamEvent[] = [];
      const result = await assistant.run(
        pilotContext,
        {
          conversationId: 'held-coverage',
          toolPolicy: 'none',
          messages: [{ role: 'user', text: 'Compare House vs Senate budget marks for PE 0603851F.' }],
        },
        { onEvent: (event) => events.push(event) },
      );
      expect(result.reply).toMatch(/^I could not safely release/);
      expect(result.reply).not.toContain('Evidence limitation');
      expect(result.held).toBe(true);
      expect(textFrames(events)).toEqual([{ type: 'text', text: result.reply }]);
    });

    test('skips live repair on a held turn and emits the hold unchanged', async () => {
      armReleaseGate();
      enroll('AUTO_CORRECTION', 'enforce');
      process.env.MERI_AUTO_CORRECTION_CATEGORIES = 'bill_status';
      const repairSpy = jest.spyOn(liveRepair, 'applyLiveRepair');
      const complete = jest.fn().mockResolvedValue(response({ outputText: 'H.R. 1 passed the House.' }));
      const assistant = build(registry([]), complete);
      const spies = logSpies(assistant);
      const events: MeriV3ChatStreamEvent[] = [];
      const result = await assistant.run(
        pilotContext,
        { conversationId: 'held', toolPolicy: 'none', messages: [{ role: 'user', text: 'What is the status of H.R. 1?' }] },
        { onEvent: (event) => events.push(event) },
      );
      expect(result.reply).toMatch(/^I could not safely release/);
      expect(repairSpy).not.toHaveBeenCalled();
      expect(textFrames(events)).toEqual([{ type: 'text', text: result.reply }]);
      expect(eventsNamed(spies.log, 'meri.auto_correction.skipped')).toEqual([
        expect.objectContaining({ reason: 'held' }),
      ]);
      const canary = firstEvent(spies.log, 'meri.canary.turn');
      expect(canary.outcome).toBe('held');
    });

    test('falls back to the finalized reply when the repaired text would be held by the release gate', async () => {
      armReleaseGate();
      enroll('AUTO_CORRECTION', 'enforce');
      process.env.MERI_AUTO_CORRECTION_CATEGORIES = 'bill_status';
      const statusCall = fnCall('get_bill_status', { billId: 'hr1-119' }, 'status-call');
      const complete = jest
        .fn()
        .mockResolvedValueOnce(toolRound(statusCall))
        .mockResolvedValueOnce(response({ outputText: 'H.R. 1 passed the House [1].' }));
      const invoke = jest.fn(async () => ({
        data: [{ id: 'hr1-119', title: 'H.R. 1', latestAction: 'Passed House on September 10, 2026.' }],
      }));
      const assistant = build(registry([{ name: 'get_bill_status', readOnly: true }], invoke), complete);
      const spies = logSpies(assistant);
      jest
        .spyOn(liveRepair, 'applyLiveRepair')
        .mockResolvedValue(repairResult({ reply: 'H.R. 1 was signed into law.', changed: true }));
      global.fetch = fetchWith([BILL_STATUS_SCHEMA]);
      const events: MeriV3ChatStreamEvent[] = [];
      const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        assistant.run(
          pilotContext,
          { conversationId: 'rewrite-held', messages: [{ role: 'user', text: 'What is the status of H.R. 1?' }] },
          { onEvent: (event) => events.push(event) },
        ),
      );
      expect(result.reply).toBe('H.R. 1 passed the House [1].');
      expect(textFrames(events)).toEqual([{ type: 'text', text: 'H.R. 1 passed the House [1].' }]);
      expect(eventsNamed(spies.warn, 'meri.auto_correction.rewrite_rejected')).toEqual([
        expect.objectContaining({ reason: 'release_gate' }),
      ]);
    });
  });

  describe('bounded auto-correction (S2-C)', () => {
    const BILL_REPLY = 'H.R. 1 passed the House.';
    const billDto = (conversationId: string) => ({
      conversationId,
      toolPolicy: 'none' as const,
      messages: [{ role: 'user' as const, text: 'Did H.R. 1 pass?' }],
    });
    const promote = (mode: 'shadow' | 'enforce', categories: string) => {
      enroll('AUTO_CORRECTION', mode);
      process.env.MERI_AUTO_CORRECTION_CATEGORIES = categories;
    };

    test('a throwing repair stage releases the finalized reply with exactly one text frame', async () => {
      promote('enforce', 'bill_status');
      jest.spyOn(liveRepair, 'applyLiveRepair').mockRejectedValue(new Error('revision_malformed'));
      const complete = jest.fn().mockResolvedValue(response({ outputText: BILL_REPLY }));
      const assistant = build(registry([]), complete);
      const spies = logSpies(assistant);
      const events: MeriV3ChatStreamEvent[] = [];
      const result = await assistant.run(pilotContext, billDto('repair-throws'), {
        onEvent: (event) => events.push(event),
      });
      expect(result.reply).toBe(BILL_REPLY);
      expect(textFrames(events)).toEqual([{ type: 'text', text: BILL_REPLY }]);
      expect(eventsNamed(spies.warn, 'meri.auto_correction.failed')).toEqual([
        expect.objectContaining({ mode: 'enforce', reason: 'revision_malformed' }),
      ]);
      const canary = firstEvent(spies.log, 'meri.canary.turn');
      expect(canary.outcome).toBe('released');
    });

    test('a hanging judge provider cannot delay the text frame past the repair deadline', async () => {
      fakeTimers();
      promote('shadow', 'current_role');
      const reply = 'The committee chair promised action on the measure.';
      const complete = jest.fn().mockResolvedValue(response({ outputText: reply }));
      const assistant = build(registry([]), complete, jest.fn(), {
        completeWithSchema: jest.fn(() => new Promise(() => undefined)),
      });
      const spies = logSpies(assistant);
      const events: MeriV3ChatStreamEvent[] = [];
      const pending = assistant.run(
        pilotContext,
        { conversationId: 'judge-hangs', toolPolicy: 'none', messages: [{ role: 'user', text: 'Who chairs the committee?' }] },
        { onEvent: (event) => events.push(event) },
      );
      await jest.advanceTimersByTimeAsync(8_500);
      const result = await pending;
      expect(result.reply).toBe(reply);
      expect(textFrames(events)).toEqual([{ type: 'text', text: reply }]);
      expect(eventsNamed(spies.warn, 'meri.auto_correction.failed')).toEqual([
        expect.objectContaining({ mode: 'shadow', reason: 'deadline' }),
      ]);
      const canary = firstEvent(spies.log, 'meri.canary.turn');
      expect(canary.repair).toMatchObject({ budgetExhausted: 1 });
      expect((canary.latencyMs as { timeToText: number }).timeToText).toBeGreaterThanOrEqual(8_000);
      expect((canary.latencyMs as { timeToText: number }).timeToText).toBeLessThan(9_000);
    });

    test('a hung repair is abandoned when the request aborts and the finalized reply is still released once', async () => {
      promote('enforce', 'bill_status');
      const controller = new AbortController();
      jest.spyOn(liveRepair, 'applyLiveRepair').mockImplementation(() => {
        setTimeout(() => controller.abort(new DOMException('Client disconnected', 'AbortError')), 0);
        return new Promise(() => undefined);
      });
      const complete = jest.fn().mockResolvedValue(response({ outputText: BILL_REPLY }));
      const assistant = build(registry([]), complete);
      const spies = logSpies(assistant);
      const events: MeriV3ChatStreamEvent[] = [];
      const result = await assistant.run(pilotContext, billDto('repair-abort'), {
        onEvent: (event) => events.push(event),
        signal: controller.signal,
      });
      expect(result.reply).toBe(BILL_REPLY);
      expect(textFrames(events)).toEqual([{ type: 'text', text: BILL_REPLY }]);
      expect(eventsNamed(spies.warn, 'meri.auto_correction.failed')).toEqual([
        expect.objectContaining({ reason: 'aborted' }),
      ]);
    });

    test('an empty rewrite is rejected and the finalized reply is emitted once', async () => {
      promote('enforce', 'bill_status');
      jest
        .spyOn(liveRepair, 'applyLiveRepair')
        .mockResolvedValue(repairResult({ reply: '   ', changed: true }));
      const complete = jest.fn().mockResolvedValue(response({ outputText: BILL_REPLY }));
      const assistant = build(registry([]), complete);
      const spies = logSpies(assistant);
      const events: MeriV3ChatStreamEvent[] = [];
      const result = await assistant.run(pilotContext, billDto('repair-empty'), {
        onEvent: (event) => events.push(event),
      });
      expect(result.reply).toBe(BILL_REPLY);
      expect(textFrames(events)).toEqual([{ type: 'text', text: BILL_REPLY }]);
      expect(eventsNamed(spies.warn, 'meri.auto_correction.rewrite_rejected')).toEqual([
        expect.objectContaining({ reason: 'empty' }),
      ]);
    });

    test('caps the promoted claims assessed in one turn', async () => {
      promote('shadow', 'bill_status');
      const repairSpy = jest.spyOn(liveRepair, 'applyLiveRepair');
      const reply = Array.from({ length: 15 }, (_, index) => `H.R. ${index + 1} passed the House.`).join(' ');
      const complete = jest.fn().mockResolvedValue(response({ outputText: reply }));
      const assistant = build(registry([]), complete);
      const spies = logSpies(assistant);
      await assistant.run(pilotContext, billDto('repair-cap'));
      expect(repairSpy.mock.calls[0]![0].claims).toHaveLength(12);
      expect(eventsNamed(spies.log, 'meri.auto_correction.claims_capped')).toEqual([
        expect.objectContaining({ promoted: 15, assessed: 12 }),
      ]);
    });

    // The legacy skeptic can only answer refuted / not refuted, so the observable
    // effect of a correct passage binding is that the deterministic exact check
    // finds the cited figure and hands the claim to the judge (`cascaded`),
    // instead of declaring it absent and short-circuiting to insufficient evidence.
    test.each([
      ['inside the sentence', 'HAC-D marked PE 0604858F at $412.6 million for FY2027 [2].'],
      ['after the period', 'HAC-D marked PE 0604858F at $412.6 million for FY2027. [2]'],
    ])(
      'binds exact comparison to the ledger entry that produced the citation (marker %s), with its full text',
      async (_label, reply) => {
        promote('shadow', 'budget_amount');
        const first = fnCall('get_pe_budget_timeline', { peCode: '0603851F' }, 'budget-a');
        const second = fnCall('get_pe_budget_timeline', { peCode: '0604858F' }, 'budget-b');
        const complete = jest
          .fn()
          .mockResolvedValueOnce(toolRound(first, second))
          .mockResolvedValueOnce(response({ outputText: reply }));
        const invoke = jest.fn(async (_name: string, args: Record<string, unknown>) =>
          budgetResult(String(args.peCode), args.peCode === '0603851F' ? '$300.0 million' : '$412.6 million'),
        );
        const assistant = build(registry([{ name: 'get_pe_budget_timeline', readOnly: true }], invoke), complete);
        const spies = logSpies(assistant);
        const repairSpy = jest.spyOn(liveRepair, 'applyLiveRepair');
        global.fetch = fetchWith([BUDGET_SCHEMA]);
        const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
          assistant.run(pilotContext, {
            conversationId: 'per-entry',
            messages: [{ role: 'user', text: 'What did HAC-D mark for PE 0604858F?' }],
          }),
        );
        expect(result.reply).toBe(reply);
        const passages = repairSpy.mock.calls[0]![0].passages;
        const cited = passages['citation:2:get_pe_budget_timeline:0604858F-fy27-hacd']!.text;
        expect(cited).toContain('$412.6 million');
        expect(cited).not.toContain('$300.0 million');
        expect(passages['get_pe_budget_timeline:0604858F-fy27-hacd']!.text).toBe(cited);
        expect(eventsNamed(spies.log, 'meri.auto_correction.claim')).toEqual([
          expect.objectContaining({ category: 'budget_amount', cascaded: true }),
        ]);
      },
    );

    test('passes truthful document references so a claim read from the document is judged rather than turned into an attachment request', async () => {
      promote('shadow', 'current_role');
      const text = 'The chair promised action on the measure at the September meeting.';
      const read = fnCall('read_client_documents', { clientId: 'client-1', documentId: 'transcript-1' }, 'read-call');
      const reply = 'The transcript says the chair promised action [1].';
      const invoke = documentFixture(text);
      const complete = jest
        .fn()
        .mockResolvedValueOnce(toolRound(read))
        .mockResolvedValueOnce(response({ outputText: reply }));
      const assistant = build(
        registry(clientDocumentSchemas.map(({ name }) => ({ name, readOnly: true })), invoke),
        complete,
      );
      const spies = logSpies(assistant);
      const repairSpy = jest.spyOn(liveRepair, 'applyLiveRepair');
      global.fetch = fetchWith(clientDocumentSchemas);
      const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () =>
        assistant.run(pilotContext, {
          clientId: 'client-1',
          conversationId: 'doc-readable',
          messages: [{ role: 'user', text: 'What did the chair commit to at the September meeting?' }],
        }),
      );
      expect(result.reply).toBe(reply);
      const references = repairSpy.mock.calls[0]![0].documentReferences ?? [];
      expect(references).toEqual([
        expect.objectContaining({
          kind: 'client_document',
          id: 'transcript-1',
          filename: 'September meeting transcript.txt',
          readable: true,
          contentState: expect.stringMatching(/^(?:ready|partial|indexed_or_extracted)$/),
          clientId: 'client-1',
          requestedClientId: 'client-1',
        }),
      ]);
      expect(references[0]!.relevantPassageIds).toContain(`transcript-1:0-${text.length}`);
      // The claim reaches the judge; it is never short-circuited to `document_unavailable`.
      const [claim] = eventsNamed(spies.log, 'meri.auto_correction.claim');
      expect(claim).toMatchObject({ cascaded: true });
      expect(claim!.outcome).not.toBe('document_unavailable');
      const canary = firstEvent(spies.log, 'meri.canary.turn');
      expect(canary.repair).toMatchObject({ documentRequested: 0 });
      expect(canary.clarificationRequested).toBe(false);
    });

    test('passes no document references when the turn touched no document', async () => {
      promote('shadow', 'current_role');
      const repairSpy = jest.spyOn(liveRepair, 'applyLiveRepair');
      const reply = 'The committee chair promised action on the measure.';
      const complete = jest.fn().mockResolvedValue(response({ outputText: reply }));
      const assistant = build(registry([]), complete);
      const spies = logSpies(assistant);
      await assistant.run(pilotContext, {
        conversationId: 'no-doc',
        toolPolicy: 'none',
        messages: [{ role: 'user', text: 'Who chairs the committee?' }],
      });
      expect(repairSpy.mock.calls[0]![0].documentReferences).toEqual([]);
      const [claim] = eventsNamed(spies.log, 'meri.auto_correction.claim');
      expect(claim).toMatchObject({ cascaded: true });
      expect(claim!.outcome).not.toBe('document_unavailable');
    });
  });
});
