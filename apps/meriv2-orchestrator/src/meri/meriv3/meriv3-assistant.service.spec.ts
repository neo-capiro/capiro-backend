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
    const assistant = build(registry([{ name: 'search_memory', readOnly: true }], invoke), complete);
    global.fetch = jest.fn(async () =>
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

    const result = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
        assistant.run(context, {
          messages: [{ role: 'user', text: 'What nickname do you remember?' }],
        }),
    );
    expect(invoke).toHaveBeenCalledWith('search_memory', { query: 'Kestrel' }, context);
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
    global.fetch = jest.fn(async () =>
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

    const result = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () => assistant.run(context, { messages: [{ role: 'user', text: 'Send this email' }] }),
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
    global.fetch = jest.fn(async () =>
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

    const result = await RequestCredentialsStore.run(
      { bearerToken: 'bearer' },
      () =>
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
