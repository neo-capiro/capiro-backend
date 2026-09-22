import type { MeriContext, ToolRegistry } from '@capiro/meriv2-core';
import { MERI_GOVERNMENT_AFFAIRS_OUTPUT_CONTRACT } from '@capiro/meriv2-core';
import { runWithGovernedMeriContext } from '../meri-governed-context.runtime.js';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';
import { MeriV3AssistantService } from './meriv3-assistant.service.js';

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

function build(registry: ToolRegistry, complete: jest.Mock, createProposal = jest.fn()) {
  const registryService = {
    registry,
    llm: {
      completeJson: jest.fn(),
      completeWithSchema: jest.fn(async () => ({
        input: { refuted: false, confidence: 'high', reason: 'Supported.' },
        usage: { inputTokens: 10, outputTokens: 2 },
      })),
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
    invoke,
  } as unknown as ToolRegistry;
}

describe('MeriV3AssistantService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.MERI_AUDITOR_MODE;
    delete process.env.MERI_RELEASE_GATE;
    delete process.env.MERI_CLAIM_ASSESSMENT_MODE;
    delete process.env.MERI_CLAIM_ASSESSMENT_TENANTS;
    delete process.env.MERI_CLAIM_ASSESSMENT_SURFACES;
    delete process.env.MERI_JEV_PROVIDER_MODE;
    delete process.env.MERI_JEV_PROVIDER_TENANTS;
    delete process.env.MERI_JEV_PROVIDER_SURFACES;
    delete process.env.MERI_JEV_TASKS;
    delete process.env.MERI_CHAT_EVIDENCE_JUDGE;
    delete process.env.TYPESAFE_API_KEY;
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
    expect(claimLog).not.toHaveBeenCalledWith('meri.claim_inventory', expect.anything());
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
      if (message === 'meri.evidence_shadow') order.push('provider');
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
