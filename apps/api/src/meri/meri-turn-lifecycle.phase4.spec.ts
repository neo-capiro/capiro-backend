import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';

// These injected ports use the fixture implementations below; loading their
// unrelated client/learning/embedding graphs is unnecessary for turn receipts.
jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('../engagement/ai-credential-resolver.service.js', () => ({ AiCredentialResolverService: class {} }));
jest.mock('../context/context-compiler.service.js', () => ({ ContextCompilerService: class {} }));

const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' } as TenantContext;

function harness() {
  const writes: string[] = [];
  const rows: Array<{ id: string; role: string; body: string; metadata: Record<string, unknown> }> = [];
  const tx = {
    clioConversation: { findFirst: jest.fn(async () => ({ id: 'conversation', clientId: null })) },
    clioMessage: {
      create: jest.fn(async ({ data }: { data: Omit<(typeof rows)[number], 'id'> }) => {
        const row = { id: `saved-${data.role}`, ...data }; rows.push(row); return row;
      }),
      findMany: jest.fn(async () => [...rows].reverse()),
    },
    aiUsageEvent: { create: jest.fn(async () => ({})) },
  };
  const settings: Record<string, unknown> = {
    CLIO_MODEL: 'fixture-model', CLIO_MAX_TOKENS: 1024,
    CLIO_REQUEST_TIMEOUT_MS: 30000, CLIO_MAX_TOOL_ROUNDS: 2,
    CLIO_TURN_BUDGET_MS: 30000, CLIO_HISTORY_CHAR_BUDGET: 10000,
    CLIO_EXTENDED_THINKING: false,
  };
  // Context construction and ports are bounded fixture inputs. The real native
  // provider SSE parser, failure/abort handling, persistence and done frame run.
  const service = Object.assign(Object.create(MeriService.prototype), {
    prisma: { withTenant: jest.fn(async (_id: string, fn: (db: typeof tx) => unknown) => fn(tx)) },
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    config: { get: (key: string) => settings[key] ?? false },
    meriV2Chat: { configured: false }, meriFlags: { isEnabled: async () => false },
    extractStreamControl: (content: string) => ({ cleanContent: content, traceEnabled: false, pageWriteEnabled: false }),
    classifyIntent: async () => 'general_question',
    orchestrateContext: async () => ({ policy: { tier: 'fast' }, sources: [], trace: [], context: '', activeClient: null }),
    buildSystemBlocks: () => [], skillsEnabled: () => false, suggestionsEnabled: () => false,
    aiCredentials: { resolveProvider: async () => ({ apiKey: 'fixture', usedTenantKey: false }) },
    tools: { analysisSandboxEnabled: async () => false, anthropicToolSchemas: () => [] },
    mcp: { bridgedSchemasFor: async () => [] },
    scheduleAfterTurnMaintenance: jest.fn(), maybeLearnFromConversation: jest.fn(async () => undefined),
  }) as MeriService;
  const abort = new AbortController();
  return {
    service, tx, rows, abort,
    run: () => service.streamMessage(ctx, 'conversation', 'Read this fact', { write: (value: string) => { writes.push(value); } }, abort.signal),
    frames: () => writes.filter((value) => value.startsWith('data: ')).map((value) => JSON.parse(value.slice(6)) as Record<string, unknown>),
  };
}

function providerResponse(stopReason: string | null): Response {
  const events = [
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Observed fixture fact.' } },
    ...(stopReason ? [{ type: 'message_delta', delta: { stop_reason: stopReason } }] : []),
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 });
}

describe('archived Meri thread deep-link recovery', () => {
  function archivedHarness() {
    const row = { id: 'conversation', tenantId: ctx.tenantId, userId: ctx.userId,
      archivedAt: new Date('2026-09-10T10:00:00Z'), status: 'archived', clientId: null };
    const tx = {
      clioConversation: {
        findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
          where.tenantId === row.tenantId && where.userId === row.userId &&
          where.id === row.id && (!('archivedAt' in where) || row.archivedAt === where.archivedAt) ? row : null),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(row, data)),
      },
      clioMessage: { findMany: jest.fn(async () => [{ id: 'saved-answer', body: 'Saved before archive.' }]) },
    };
    const service = Object.assign(Object.create(MeriService.prototype), {
      prisma: { withTenant: jest.fn(async (_id: string, fn: (db: typeof tx) => unknown) => fn(tx)) },
    }) as MeriService;
    return { service, tx, row };
  }

  it('discovers the owned archived row without restoring or reading its messages, then restores the saved conversation', async () => {
    const h = archivedHarness();
    await expect(h.service.getConversation(ctx, 'conversation')).resolves.toMatchObject({ status: 'archived' });
    expect(h.tx.clioConversation.update).not.toHaveBeenCalled();
    expect(h.tx.clioMessage.findMany).not.toHaveBeenCalled();
    await expect(h.service.listMessages(ctx, 'conversation')).rejects.toThrow('Meri conversation not found');
    await h.service.restoreConversation(ctx, 'conversation');
    expect(h.row).toMatchObject({ archivedAt: null, status: 'active' });
    await expect(h.service.listMessages(ctx, 'conversation')).resolves.toEqual([{ id: 'saved-answer', body: 'Saved before archive.' }]);
  });

  it.each([{ tenantId: 'other-tenant' }, { userId: 'other-user' }])('rejects archive discovery and restore outside the owner (%j)', async (scope) => {
    const h = archivedHarness();
    const foreign = { ...ctx, ...scope };
    await expect(h.service.getConversation(foreign, 'conversation')).rejects.toThrow('Meri conversation not found');
    await expect(h.service.restoreConversation(foreign, 'conversation')).rejects.toThrow('Meri conversation not found');
    expect(h.tx.clioConversation.update).not.toHaveBeenCalled();
  });
});

describe('native Meri V1 lifecycle persistence matches the final stream receipt', () => {
  afterEach(() => jest.restoreAllMocks());

  it('records an in-band provider error as failed even after text and before a later completion frame', async () => {
    const h = harness();
    const events = [
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Partial observed fact.' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Private provider failure details' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' Must not be appended.' } },
    ];
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 },
    ));
    await h.run();
    expect(h.rows.find((row) => row.role === 'assistant')).toMatchObject({
      body: 'Partial observed fact.', metadata: { finishReason: 'error', partial: true },
    });
    expect(h.frames().filter((frame) => frame.type === 'error')).toEqual([{
      type: 'error', message: 'The model provider could not complete this response. Please try again.',
    }]);
    expect(h.frames().at(-1)).toMatchObject({ type: 'done', finishReason: 'error', partial: true });
    expect(JSON.stringify(h.frames())).not.toContain('Private provider failure details');
  });

  it('retains a Stop racing the final provider round instead of persisting success', async () => {
    const h = harness();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      h.abort.abort();
      return providerResponse('end_turn');
    });
    await h.run();
    expect(h.rows.find((row) => row.role === 'assistant')).toMatchObject({
      body: 'Observed fixture fact.', metadata: { finishReason: 'aborted', partial: true },
    });
    expect(h.frames().at(-1)).toMatchObject({ type: 'done', finishReason: 'aborted', partial: true });
  });

  it.each([
    ['end_turn', 'stop', false], ['max_tokens', 'max_tokens', true],
    [null, 'stream_interrupted', true],
  ] as const)('records provider finish %s and raw V1 runtime identity faithfully', async (providerFinish, finishReason, partial) => {
    const h = harness();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(providerResponse(providerFinish));
    await h.run();
    expect(h.rows.find((row) => row.role === 'assistant')?.metadata).toMatchObject({
      servedBy: 'legacy-v1', finishReason, partial,
    });
    expect(h.frames().at(-1)).toMatchObject({
      type: 'done', servedBy: 'legacy-v1', messageId: 'saved-assistant', finishReason, partial,
    });
  });

  it.each(['provider_failure', 'user_stop', 'provider_timeout'] as const)('keeps %s distinct on stream and reload', async (failure) => {
    const h = harness();
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (failure === 'user_stop') h.abort.abort();
      if (failure !== 'provider_failure') throw new DOMException('Request aborted', 'AbortError');
      throw new Error('Provider unavailable');
    });
    await h.run();
    const finishReason = failure === 'user_stop' ? 'aborted' : 'error';
    expect(h.rows.find((row) => row.role === 'assistant')?.metadata).toMatchObject({ finishReason, partial: true });
    expect(h.frames().at(-1)).toMatchObject({ type: 'done', messageId: 'saved-assistant', finishReason, partial: true });
    expect(h.frames().some((frame) => frame.type === 'error')).toBe(failure !== 'user_stop');
  });
});
