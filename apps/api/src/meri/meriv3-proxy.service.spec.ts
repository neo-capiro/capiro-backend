import { describe, expect, it, jest } from '@jest/globals';
import { MeriV3ProxyService } from './meriv3-proxy.service.js';
import { scheduleMeriTurnMaintenance } from './meri-turn-maintenance.js';

// These injected collaborators already use harness instances below. Avoid
// booting their unrelated tool/service graphs in this proxy unit suite.
jest.mock('../engagement/ai-credential-resolver.service.js', () => ({
  AiCredentialResolverService: class {},
}));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: class {} }));
jest.mock('./meri-firm-skills.service.js', () => ({ MeriFirmSkillsService: class {} }));

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';

/**
 * Phase 27 post-launch P1 (MeriV3 front) — found live in the Capiro-internal
 * canary: this tenant is routed through MeriV3ProxyService.streamMessage
 * (meriv3-runtime.proxy.ts's Proxy dispatches here whenever
 * MeriFeatureFlagsService.isMeriV3ChatEnabled is true), a completely separate
 * implementation from MeriService.streamMessage. The PR #1214 fix only
 * patched the latter, so feedback rated immediately after a MeriV3 turn
 * still posted the client's stale optimistic id and 400'd — reproduced
 * against the live capiro-dev-api right after #1214 deployed. These tests
 * pin the same contract here: every `done` frame this service ever emits
 * must carry the persisted assistant message id whenever one was written.
 */
function buildHarness() {
  const tx = {
    clioConversation: {
      findFirst: jest.fn(async () => ({
        id: CONVERSATION,
        clientId: null,
        summaryUpToMessageId: null,
        summary: null,
        metadata: null,
        client: null,
      })),
    },
    clioMessage: {
      create: jest.fn(async ({ data }: any) => ({ id: `msg-${data.role}-${Math.random()}` })),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({})),
    },
    clioAttachment: {
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({})),
    },
    clioArtifact: {
      updateMany: jest.fn(async () => ({})),
    },
  };
  const prisma = { withTenant: jest.fn((_t: string, cb: (tx: unknown) => unknown) => cb(tx)) };
  const flags = {
    isMeriV3ChatEnabled: jest.fn(async () => true),
    // compliance-block / deepResearchPromote off by default
    isEnabled: jest.fn(async (_tenantId: string, _key: string) => false),
  };
  const client = {
    configured: true,
    streamChat: jest.fn(async (_args: any) => {}),
  };
  const aiCredentials = { resolveProvider: jest.fn(async () => null) };
  const clientKb = { buildSnapshot: jest.fn(async () => null) };
  const firmSkills = { skillsForTenant: jest.fn(async () => []) };
  const maintenance = { scheduleAfterTurnMaintenance: jest.fn() };

  const service = new MeriV3ProxyService(
    prisma as never,
    flags as never,
    client as never,
    aiCredentials as never,
    clientKb as never,
    firmSkills as never,
    maintenance,
  );

  const writes: string[] = [];
  const sse = { write: (data: string) => writes.push(data) };
  const frames = () =>
    writes
      .filter((w) => w.startsWith('data: '))
      .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);

  return { service, tx, prisma, flags, client, sse, frames, maintenance };
}

const CTX = { tenantId: TENANT, userId: USER } as never;

describe('MeriV3ProxyService — done frame carries the persisted message id', () => {
  it.each(['runtime-url', 'bearer'])(
    'explicitly rejects %s setup failure before accepting or persisting a turn',
    async (missing) => {
      const { service, client, sse, frames, tx } = buildHarness();
      if (missing === 'runtime-url') client.configured = false;
      await service.streamMessage(
        CTX,
        CONVERSATION,
        'Keep my draft',
        sse,
        undefined,
        'new',
        [],
        missing === 'bearer' ? undefined : 'token',
      );
      expect(frames()[0]).toMatchObject({ type: 'error', accepted: false });
      expect(frames()[1]).toEqual({ type: 'done' });
      expect(tx.clioMessage.create).not.toHaveBeenCalled();
      expect(client.streamChat).not.toHaveBeenCalled();
    },
  );

  it('emits a provider failure as accepted work followed by canonical completion metadata', async () => {
    const { service, client, sse, frames, tx } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({ type: 'tool_call', tool: 'search_memory', label: 'Client memory' });
      onEvent({
        type: 'tool_done',
        tool: 'search_memory',
        label: 'Client memory',
        status: 'done',
        detail: 'Found three approved facts',
      });
      onEvent({ type: 'error', message: 'The provider could not finish.' });
    });
    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Prepare a brief',
      sse,
      undefined,
      'new',
      [],
      'token',
    );
    const events = frames();
    const failure = events.find((frame) => frame.type === 'error');
    const done = events.find((frame) => frame.type === 'done');
    expect(failure).toMatchObject({ message: 'The provider could not finish.' });
    expect(failure).not.toHaveProperty('accepted', false);
    expect(done).toMatchObject({
      partial: true,
      finishReason: 'error',
      messageId: expect.any(String),
    });
    expect(events.indexOf(done!)).toBeGreaterThan(events.indexOf(failure!));
    const saved = tx.clioMessage.create.mock.calls
      .map(([arg]: any) => arg.data)
      .find((data: any) => data.role === 'assistant');
    expect(saved.metadata.trustSteps).toEqual([
      expect.objectContaining({
        tool: 'search_memory',
        status: 'done',
        detail: 'Found three approved facts',
      }),
    ]);
  });

  it('persists effective provider effort and fallback history without relabeling the requested mode', async () => {
    const { service, client, sse, frames, tx } = buildHarness();
    const telemetry = {
      requestedModel: 'requested-model',
      effectiveModel: 'served-model',
      requestedReasoningEffort: 'max',
      effectiveReasoningEffort: null,
      reasoningFallbackReasons: ['max_unsupported', 'reasoning_unsupported'],
      finishReason: 'completed',
      partial: false,
    };
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({ type: 'text', text: 'A sourced answer.' });
      onEvent({
        type: 'done',
        reply: 'A sourced answer.',
        model: 'served-model',
        reasoningEffort: null,
        telemetry,
        providerCalls: [telemetry],
      });
    });
    await service.streamMessage(CTX, CONVERSATION, 'Hi', sse, undefined, 'new', [], 'token');
    const saved = tx.clioMessage.create.mock.calls
      .map(([arg]: any) => arg.data)
      .find((data: any) => data.role === 'assistant');
    expect(saved.metadata).toMatchObject({
      model: 'served-model',
      reasoningMode: 'standard',
      reasoningEffort: null,
      telemetry,
      providerCalls: [telemetry],
      finishReason: 'completed',
      partial: false,
    });
    expect(frames().find((frame) => frame.type === 'done')).toMatchObject({
      telemetry,
      reasoningEffort: null,
      finishReason: 'completed',
      partial: false,
    });
  });

  it('preserves provider incomplete status in the saved message and completion event', async () => {
    const { service, client, sse, frames, tx } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({ type: 'text', text: 'Only part of the answer.' });
      onEvent({
        type: 'done',
        reply: 'Only part of the answer.',
        model: 'test',
        reasoningEffort: 'high',
        telemetry: {
          requestedModel: 'test',
          effectiveModel: 'test',
          requestedReasoningEffort: 'high',
          effectiveReasoningEffort: 'high',
          reasoningFallbackReasons: [],
          finishReason: 'max_output_tokens',
          partial: true,
        },
      });
    });
    await service.streamMessage(CTX, CONVERSATION, 'Hi', sse, undefined, 'new', [], 'token');
    const saved = tx.clioMessage.create.mock.calls
      .map(([arg]: any) => arg.data)
      .find((data: any) => data.role === 'assistant');
    expect(saved.metadata).toMatchObject({ finishReason: 'max_output_tokens', partial: true });
    expect(frames().find((frame) => frame.type === 'done')).toMatchObject({
      finishReason: 'max_output_tokens',
      partial: true,
    });
  });

  it('records a stream ending without a done frame as partial, with unknown effective effort', async () => {
    const { service, client, sse, frames, tx } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({ type: 'text', text: 'Interrupted answer.' });
    });
    await service.streamMessage(CTX, CONVERSATION, 'Hi', sse, undefined, 'new', [], 'token');
    const saved = tx.clioMessage.create.mock.calls
      .map(([arg]: any) => arg.data)
      .find((data: any) => data.role === 'assistant');
    expect(saved.metadata).toMatchObject({
      finishReason: 'stream_interrupted',
      partial: true,
      reasoningEffort: null,
    });
    expect(frames().find((frame) => frame.type === 'done')).toMatchObject({
      finishReason: 'stream_interrupted',
      partial: true,
    });
  });

  it('preserves an internal deadline finish reason instead of relabeling it as user Stop', async () => {
    const { service, client, sse, frames } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({
        type: 'done',
        model: 'test',
        reasoningEffort: null,
        reply: 'The turn reached its time limit.',
        aborted: true,
        telemetry: {
          requestedModel: 'test',
          effectiveModel: null,
          requestedReasoningEffort: 'max',
          effectiveReasoningEffort: null,
          reasoningFallbackReasons: [],
          finishReason: 'deadline_exceeded',
          partial: true,
        },
      });
    });
    await service.streamMessage(CTX, CONVERSATION, 'Hi', sse, undefined, 'new', [], 'token');
    expect(frames().find((frame) => frame.type === 'done')).toMatchObject({
      finishReason: 'deadline_exceeded',
      partial: true,
    });
  });

  it('marks cancellation after a completed provider round as a partial aborted turn', async () => {
    const { service, client, sse, tx } = buildHarness();
    const abort = new AbortController();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({
        type: 'runtime',
        model: 'served',
        reasoningEffort: 'high',
        telemetry: {
          requestedModel: 'requested',
          effectiveModel: 'served',
          requestedReasoningEffort: 'max',
          effectiveReasoningEffort: 'high',
          reasoningFallbackReasons: ['max_unsupported'],
          finishReason: 'completed',
          partial: false,
        },
      });
      onEvent({ type: 'text', text: 'Progress before Stop.' });
      abort.abort();
    });
    await service.streamMessage(CTX, CONVERSATION, 'Hi', sse, abort.signal, 'new', [], 'token');
    const saved = tx.clioMessage.create.mock.calls
      .map(([arg]: any) => arg.data)
      .find((data: any) => data.role === 'assistant');
    expect(saved.metadata).toMatchObject({
      finishReason: 'aborted',
      partial: true,
      telemetry: { finishReason: 'aborted', partial: true, effectiveReasoningEffort: 'high' },
    });
  });

  it.each([0, 1])(
    'persists an honest empty Stop receipt after %i completed tools for later replay',
    async (toolCount) => {
      const { service, client, sse, tx, frames } = buildHarness();
      const abort = new AbortController();
      client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
        if (toolCount) {
          onEvent({ type: 'tool_call', tool: 'get_client_context', label: 'Client context' });
          onEvent({
            type: 'tool_done',
            tool: 'get_client_context',
            label: 'Client context',
            status: 'done',
            detail: 'Read client capabilities',
          });
        }
        abort.abort();
        throw abort.signal.reason;
      });
      await service.streamMessage(
        CTX,
        CONVERSATION,
        'Read client context',
        sse,
        abort.signal,
        'new',
        [],
        'token',
      );
      const saved = tx.clioMessage.create.mock.calls
        .map(([arg]: any) => arg.data)
        .find((data: any) => data.role === 'assistant');
      expect(saved).toMatchObject({
        body: 'Stopped before an answer was generated.',
        metadata: { finishReason: 'aborted', partial: true },
      });
      expect(saved.metadata.trustSteps).toHaveLength(toolCount);
      expect(frames().some((frame) => frame.type === 'error')).toBe(false);
      expect(frames().find((frame) => frame.type === 'done')).toMatchObject({
        messageId: expect.any(String),
        finishReason: 'aborted',
        partial: true,
      });
    },
  );

  it('persists a deadline receipt without inventing a provider failure or user Stop', async () => {
    const { service, client, sse, tx, frames } = buildHarness();
    const abort = new AbortController();
    client.streamChat.mockImplementationOnce(async () => {
      abort.abort(new DOMException('Deadline expired', 'TimeoutError'));
      throw abort.signal.reason;
    });
    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Read client context',
      sse,
      abort.signal,
      'new',
      [],
      'token',
    );
    const saved = tx.clioMessage.create.mock.calls
      .map(([arg]: any) => arg.data)
      .find((data: any) => data.role === 'assistant');
    expect(saved).toMatchObject({
      body: 'The turn reached its time limit before an answer was generated.',
      metadata: { finishReason: 'deadline_exceeded', partial: true },
    });
    expect(frames().some((frame) => frame.type === 'error')).toBe(false);
  });

  it('a summary provider failure stays off the completed V3 response', async () => {
    const { service, client, sse, frames, maintenance } = buildHarness();
    const failure = new Error('summary provider unavailable');
    const onError = jest.fn();
    maintenance.scheduleAfterTurnMaintenance.mockImplementation(() =>
      scheduleMeriTurnMaintenance(async () => {
        throw failure;
      }, onError),
    );
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({ type: 'text', text: 'Persisted answer.' });
      onEvent({ type: 'done', reply: 'Persisted answer.', model: 'test', usage: {} });
    });
    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Hi',
      sse,
      undefined,
      'new',
      [],
      'test-bearer-token',
    );
    expect(frames()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'done', messageId: expect.any(String) }),
      ]),
    );
    expect(onError).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onError).toHaveBeenCalledWith(failure);
    expect(frames().some((frame) => frame.type === 'error')).toBe(false);
  });
  it('main completion path: done frame includes the real persisted assistant message id', async () => {
    const { service, client, sse, frames, maintenance, tx } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({ type: 'text', text: 'Hello from MeriV3.' });
      onEvent({
        type: 'done',
        model: 'gpt-test',
        reasoningEffort: 'medium',
        reply: 'Hello from MeriV3.',
        usage: {},
        citations: [],
      });
    });

    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Hi Meri',
      sse,
      undefined,
      'new',
      [],
      'test-bearer-token',
    );

    const done = frames().find((f) => f.type === 'done');
    expect(done).toBeDefined();
    expect(typeof done!.messageId).toBe('string');
    expect(done!.messageId).toMatch(/^msg-assistant-/);
    expect(maintenance.scheduleAfterTurnMaintenance).toHaveBeenCalledTimes(1);
    expect(maintenance.scheduleAfterTurnMaintenance).toHaveBeenCalledWith(CTX, CONVERSATION);
    expect(maintenance.scheduleAfterTurnMaintenance.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.clioMessage.create.mock.invocationCallOrder.at(-1)!,
    );
    // The stale-optimistic-id bug this pins: a client-generated id like
    // `mt4nmadw-siemgnk5ck` must never be what the frontend has to fall back
    // to — the server-persisted id must always be present when content or
    // tool steps were produced.
  });

  it('compliance-block short-circuit: done frame includes the refusal message id', async () => {
    const { service, flags, sse, frames } = buildHarness();
    flags.isEnabled.mockImplementation(
      async (_t: string, key: string) => key === 'complianceBlock',
    );

    await service.streamMessage(
      CTX,
      CONVERSATION,
      'please help me launder money through a shell PAC',
      sse,
      undefined,
      'new',
      [],
      'test-bearer-token',
    );

    const done = frames().find((f) => f.type === 'done');
    expect(done).toBeDefined();
    expect(typeof done!.messageId).toBe('string');
    expect(done!.messageId).toMatch(/^msg-assistant-/);
  });

  it('research-promote short-circuit: done frame includes the offer message id', async () => {
    const { service, flags, sse, frames } = buildHarness();
    flags.isEnabled.mockImplementation(
      async (_t: string, key: string) => key === 'deepResearchPromote',
    );

    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Build me a full sourced deliverable report on this program with every citation verified',
      sse,
      undefined,
      'new',
      [],
      'test-bearer-token',
    );

    const done = frames().find((f) => f.type === 'done');
    expect(done).toBeDefined();
    expect(typeof done!.messageId).toBe('string');
    expect(done!.messageId).toMatch(/^msg-assistant-/);
  });

  it('nothing persisted (empty reply, no tool steps, no error): done frame omits messageId rather than fabricating one', async () => {
    const { service, client, sse, frames, maintenance } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({ type: 'done', model: 'gpt-test', reasoningEffort: 'low', reply: '', usage: {} });
    });

    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Hi Meri',
      sse,
      undefined,
      'new',
      [],
      'test-bearer-token',
    );

    const done = frames().find((f) => f.type === 'done');
    expect(done).toBeDefined();
    expect(done!.messageId).toBeUndefined();
    expect(maintenance.scheduleAfterTurnMaintenance).not.toHaveBeenCalled();
  });

  it('contextPacketId/retrieval fields survive alongside messageId when both are present', async () => {
    const { service, client, sse, frames } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({ type: 'text', text: 'Answer.' });
      onEvent({
        type: 'done',
        model: 'gpt-test',
        reasoningEffort: 'medium',
        reply: 'Answer.',
        usage: {},
        citations: [],
        contextPacket: { packetId: 'packet-1' },
        evidenceManifest: {
          version: 1,
          packetId: 'packet-1',
          sourceRecordCount: 1,
          projectedRecordCount: 1,
          truncated: false,
          sources: [
            {
              id: 'record-1',
              tool: 'search_capiro_data',
              origin: 'initial_context',
              truncated: false,
            },
          ],
        },
        retrieval: { plan: { version: 1 }, coverage: { version: 1, complete: true } },
      });
    });

    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Hi Meri',
      sse,
      undefined,
      'new',
      [],
      'test-bearer-token',
    );

    const done = frames().find((f) => f.type === 'done');
    expect(done).toMatchObject({
      contextPacketId: 'packet-1',
      evidenceManifest: expect.objectContaining({
        packetId: 'packet-1',
        sources: [expect.objectContaining({ id: 'record-1', origin: 'initial_context' })],
      }),
      retrieval: expect.objectContaining({ plan: expect.anything() }),
    });
    expect(typeof done!.messageId).toBe('string');
  });
});

describe('MeriV3 public work receipt persistence', () => {
  it('saves the same completed/held tool details shown live under the canonical message', async () => {
    const { service, client, sse, frames, tx } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({ type: 'tool_call', tool: 'search_memory', label: 'Client memory' });
      onEvent({
        type: 'tool_done',
        tool: 'search_memory',
        label: 'Client memory',
        status: 'done',
        detail: 'Three approved facts',
      });
      onEvent({ type: 'tool_call', tool: 'send_message', label: 'Send message' });
      onEvent({
        type: 'tool_done',
        tool: 'send_message',
        label: 'Send message',
        status: 'pending_approval',
      });
      onEvent({ type: 'text', text: 'Draft prepared.' });
      onEvent({ type: 'done', reply: 'Draft prepared.', intent: 'client_brief', model: 'test' });
    });
    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Prepare a brief',
      sse,
      undefined,
      'new',
      [],
      'token',
    );
    const calls = tx.clioMessage.create.mock.calls;
    const index = calls.findIndex(([arg]: any) => arg.data.role === 'assistant');
    const saved = (calls[index]![0] as any).data;
    const persisted = await tx.clioMessage.create.mock.results[index]!.value;
    expect(saved.metadata).toMatchObject({
      intent: 'client_brief',
      tier: 'deep',
      trustSteps: [
        {
          tool: 'search_memory',
          label: 'Client memory',
          status: 'done',
          detail: 'Three approved facts',
          confidence: 'high',
        },
        {
          tool: 'send_message',
          label: 'Send message',
          status: 'error',
          detail: 'Held for your approval',
          confidence: 'low',
        },
      ],
    });
    expect(saved.metadata.trace).toHaveLength(2);
    expect(frames().filter((frame) => frame.type === 'sources')).toMatchObject([
      { sources: [{ summary: 'Three approved facts' }] },
      { sources: [{ summary: 'Held for your approval' }] },
    ]);
    expect(persisted).toMatchObject({
      id: frames().find((frame) => frame.type === 'done')?.messageId,
    });
  });
});
