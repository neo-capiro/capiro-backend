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
  const registryService = { registry };
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
    jest.restoreAllMocks();
  });

  test('does not emit or persist a client note success before any write ran', async () => {
    const complete = jest.fn().mockResolvedValue(response({ outputText: 'I have saved your notes under Sightline.' }));
    const createProposal = jest.fn();
    const assistant = build(registry([]), complete, createProposal);
    const onEvent = jest.fn();
    const result = await assistant.run(context, { toolPolicy: 'none', clientId: 'client-1',
      messages: [{ role: 'user', text: 'How do I log Sen Wyden engagement notes under Sightline? I have not provided the notes yet.' }],
    }, { onEvent });
    expect(createProposal).not.toHaveBeenCalled();
    expect(result.reply).toContain('I have not saved');
    expect(onEvent.mock.calls.filter(([event]) => event.type === 'text').map(([event]) => event.text).join('')).not.toContain('I have saved');
    expect(complete.mock.calls[0][0].instructions).toContain('does not supply note content');
  });

  test('saves inherited document evidence used only in the generated artifact, preserving [56]', async () => {
    const citation = { n: 56, type: 'source', id: 'doc-page-22', title: 'Capiro 2.0.pdf', url: null,
      snippet: 'Meeting preparation', tool: 'read_client_documents', documentEvidence: {
        clientId: 'client-1', documentId: 'doc-1', contentHash: 'a'.repeat(64), observedAt: '2026-09-07T00:00:00Z',
        record: { recordId: 'doc-page-22', payload: { title: 'Capiro 2.0.pdf', text: 'Meeting preparation', section: 22 } },
        coverage: { complete: false, truncated: true, disclosure: 'Visual page extraction only' },
      } };
    const governed = { inheritedDocumentEvidence: [citation], contextPacket: { packetId: 'packet-1' } } as unknown as MeriGovernedTurnContext;
    const call = { type: 'function_call', call_id: 'word-call', name: 'create_word', arguments: '{}' };
    const complete = jest.fn().mockResolvedValueOnce(response({ output: [call], outputText: '', functionCalls: [call] }))
      .mockResolvedValueOnce(response({ outputText: 'Your briefing is ready.' }));
    const artifact = { id: 'artifact-1', kind: 'docx', title: 'QA Briefing',
      bodyText: JSON.stringify({ title: 'QA Briefing', sections: [{ paragraphs: ['Page 22 observation [56]. Visual extraction only.'] }] }) };
    const createProposal = jest.fn().mockResolvedValue({ disposition: 'executed', executionResult: { artifact } });
    const assistant = build(registry([{ name: 'create_word', readOnly: false }]), complete, createProposal);
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ schemas: [{ name: 'create_word', description: 'Create a Word document', input_schema: { type: 'object', properties: {} } }] }), { status: 200 })) as typeof fetch;
    const result = await RequestCredentialsStore.run({ bearerToken: 'test-token' }, () => runWithGovernedMeriContext(governed, () => assistant.run(context, {
      clientId: 'client-1', conversationId: 'thread-1', messages: [{ role: 'user', text: 'Create a Word briefing from the earlier page observation.' }],
    })));
    expect(result.reply).toBe('Your briefing is ready.');
    expect(result.artifacts).toEqual([artifact]);
    expect(result.citations).toEqual([citation]);
    const saved = JSON.parse(JSON.stringify(result));
    expect(saved.citations[0].documentEvidence.coverage.disclosure).toBe('Visual page extraction only');
    expect(saved.evidenceManifest.sources[0]).toMatchObject({ id: 'doc-page-22', origin: 'conversation', truncated: true });
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
      const call = { type: 'function_call', call_id: 'inbox-call', name, arguments: JSON.stringify(input) };
      const complete = jest.fn()
        .mockResolvedValueOnce(response({ output: [call], outputText: '', functionCalls: [call] }))
        .mockResolvedValueOnce(response({ outputText: 'You received a meeting invitation for September 8. [1]' }));
      const invoke = jest.fn().mockResolvedValue({
        messages: [{ id: 'personal-mail-1', threadId: 'thread-1', subject: 'Meeting invitation',
          preview: 'Can we meet on September 8?', clientId: null, folder: 'inbox' }],
        totalMatches: 1, returned: 1, hasMore: false,
        asOf: '2026-09-07T12:00:00Z', searchedMailboxes: [],
      });
      const assistant = build(registry([{ name, readOnly: true }], invoke), complete);
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ schemas: [{
        name, description: 'Read authenticated mail', input_schema: { type: 'object', properties: {
          clientId: { type: 'string' }, withinDays: { type: 'number' }, folder: { type: 'string' }, limit: { type: 'number' },
        } },
      }] }))) as typeof fetch;
      const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () => assistant.run(context, {
        clientId: 'client-a',
        messages: [{ role: 'user', text: 'what activities do i have in my email inbox for the last two weeks' }],
      }));
      expect(invoke).toHaveBeenCalledWith(name, input, context, expect.any(Object));
      expect(JSON.stringify(complete.mock.calls[1][0].input)).toContain('personal-mail-1');
      expect(complete.mock.calls[0][0].instructions).toContain('withinDays=14 and omit clientId');
      expect(result.steps).toEqual([expect.objectContaining({ tool: name, status: 'done' })]);
    },
  );

  test.each(['list_emails', 'search_emails'])(
    '%s still refuses an explicit different client filter',
    async (name) => {
      const call = { type: 'function_call', call_id: 'inbox-call', name,
        arguments: '{"clientId":"client-b","withinDays":14,"folder":"inbox"}' };
      const complete = jest.fn()
        .mockResolvedValueOnce(response({ output: [call], outputText: '', functionCalls: [call] }))
        .mockResolvedValueOnce(response({ outputText: 'I did not read another client.' }));
      const invoke = jest.fn();
      const assistant = build(registry([{ name, readOnly: true }], invoke), complete);
      global.fetch = jest.fn(async () => new Response(JSON.stringify({ schemas: [{
        name, description: 'Read mail', input_schema: { type: 'object', properties: { clientId: { type: 'string' } } },
      }] }))) as typeof fetch;
      const result = await RequestCredentialsStore.run({ bearerToken: 'bearer' }, () => assistant.run(context, {
        clientId: 'client-a', messages: [{ role: 'user', text: 'Read client B mail.' }],
      }));
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
