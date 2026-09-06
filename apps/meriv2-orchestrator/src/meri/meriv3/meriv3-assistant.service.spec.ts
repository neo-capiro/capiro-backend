import type { MeriContext, ToolRegistry } from '@capiro/meriv2-core';
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
});
