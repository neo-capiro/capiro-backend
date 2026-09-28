import { describe, expect, it, jest } from '@jest/globals';
import { MeriV3ProxyService } from './meriv3-proxy.service.js';
import { scheduleMeriTurnMaintenance } from './meri-turn-maintenance.js';
import {
  buildProtocolCompactionState,
  MAX_REPLAY_HISTORY_CHARS,
  MERI_PROTOCOL_COMPACTION_METADATA_KEY,
} from './meri-compaction.helpers.js';

// These injected collaborators already use harness instances below. Avoid
// booting their unrelated tool/service graphs in this proxy unit suite.
jest.mock('../engagement/ai-credential-resolver.service.js', () => ({
  AiCredentialResolverService: class {},
}));
jest.mock('./meri-conversation-evidence.service.js', () => ({
  MeriConversationEvidenceService: class {},
}));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: class {} }));
jest.mock('./meri-firm-skills.service.js', () => ({ MeriFirmSkillsService: class {} }));
jest.mock('./meriv3-chat.client.js', () => ({ MeriV3ChatClient: class {} }));

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
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async (): Promise<any[]> => []),
      update: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({})),
    },
    clioAttachment: {
      findMany: jest.fn(async (): Promise<any[]> => []),
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
  const conversationEvidence = {
    load: jest.fn(async () => ({ citations: [], unavailable: 0, omitted: 0 })),
  };

  const service = new MeriV3ProxyService(
    prisma as never,
    flags as never,
    client as never,
    aiCredentials as never,
    clientKb as never,
    firmSkills as never,
    maintenance,
    conversationEvidence as never,
  );

  const writes: string[] = [];
  const sse = { write: (data: string) => writes.push(data) };
  const frames = () =>
    writes
      .filter((w) => w.startsWith('data: '))
      .map((w) => JSON.parse(w.slice(6)) as Record<string, unknown>);

  return { service, tx, prisma, flags, client, sse, frames, maintenance, conversationEvidence };
}

const CTX = { tenantId: TENANT, userId: USER } as never;

describe('MeriV3ProxyService — done frame carries the persisted message id', () => {
  it('persists and streams the same actual turn scope when the selected client differs', async () => {
    const { service, client, sse, tx, frames } = buildHarness();
    tx.clioConversation.findFirst.mockResolvedValue({
      id: CONVERSATION,
      clientId: 'l3',
      client: { id: 'l3', name: 'L3 Harris' },
    } as never);
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({
        type: 'done',
        reply: 'Anduril evidence.',
        citations: [],
        steps: [],
        retrieval: {
          plan: { subjectScope: 'external_entity', targetHint: 'Anduril' },
          coverage: { complete: true },
        },
        contextPacket: { packetId: 'packet-anduril', clientId: null },
        runtime: 'meriv3',
        model: 'configured-model',
        reasoningMode: 'fast',
        reasoningEffort: 'low',
      });
    });
    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Research Anduril',
      sse,
      undefined,
      'new',
      [],
      'token',
    );
    const saved = tx.clioMessage.create.mock.calls
      .map(([arg]: any) => arg.data)
      .find((data: any) => data.role === 'assistant');
    const expected = {
      kind: 'external_entity',
      targetHint: 'Anduril',
      clientId: null,
      clientName: null,
    };
    expect(saved.metadata.turnScope).toEqual(expected);
    expect(frames().find((frame) => frame.type === 'done')?.turnScope).toEqual(expected);
  });

  it('forwards reauthorized [56] and persists it on the new message after completion', async () => {
    const { service, client, conversationEvidence, sse, tx, frames } = buildHarness();
    const citation = {
      n: 56,
      id: 'doc-1:aaaaaaaaaaaaaaaa:22:0-840',
      title: 'Capiro 2.0.pdf',
      tool: 'read_client_documents',
      type: 'source',
      snippet: 'Exact excerpt',
      url: null,
    };
    conversationEvidence.load.mockResolvedValue({
      citations: [citation],
      unavailable: 0,
      omitted: 0,
    } as never);
    client.streamChat.mockImplementationOnce(async ({ input, onEvent }: any) => {
      expect(input.inheritedDocumentEvidence).toEqual([citation]);
      onEvent({
        type: 'done',
        reply: 'Briefing created.',
        citations: [citation],
        steps: [],
        runtime: 'meriv3',
        model: 'configured-model',
        reasoningMode: 'fast',
        reasoningEffort: 'low',
      });
    });
    await service.streamMessage(
      CTX,
      CONVERSATION,
      'Create the briefing',
      sse,
      undefined,
      'new',
      [],
      'token',
    );
    expect(frames().find((frame) => frame.type === 'citations')).toMatchObject({
      citations: [citation],
    });
    const saved = tx.clioMessage.create.mock.calls
      .map(([arg]: any) => arg.data)
      .find((data: any) => data.role === 'assistant');
    expect(JSON.parse(JSON.stringify(saved.metadata)).citations).toEqual([citation]);
  });

  it('emits an empty enforce citations map and persists the reload signal', async () => {
    const { service, client, sse, tx, frames } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({
        type: 'done',
        reply: 'No registered sources.',
        citations: [],
        evidenceAccuracy: 'enforce',
        steps: [],
        runtime: 'meriv3',
        model: 'configured-model',
        reasoningMode: 'fast',
        reasoningEffort: 'low',
      });
    });

    await service.streamMessage(CTX, CONVERSATION, 'Answer', sse, undefined, 'new', [], 'token');

    expect(frames().find((frame) => frame.type === 'citations')).toEqual({
      type: 'citations',
      citations: [],
      evidenceAccuracy: 'enforce',
    });
    const saved = tx.clioMessage.create.mock.calls
      .map(([arg]: any) => arg.data)
      .find((data: any) => data.role === 'assistant');
    expect(saved.metadata.evidenceAccuracy).toBe('enforce');
  });

  it('emits an empty enforce citations map when the answer is held', async () => {
    const { service, client, sse, frames } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({
        type: 'done',
        reply: 'Verification held this answer.',
        citations: [],
        evidenceAccuracy: 'enforce',
        held: true,
        steps: [],
        runtime: 'meriv3',
        model: 'configured-model',
        reasoningMode: 'fast',
        reasoningEffort: 'low',
      });
    });

    await service.streamMessage(CTX, CONVERSATION, 'Answer', sse, undefined, 'new', [], 'token');

    expect(frames().find((frame) => frame.type === 'citations')).toEqual({
      type: 'citations',
      citations: [],
      evidenceAccuracy: 'enforce',
    });
  });

  it('keeps the legacy empty-citation behavior when the enforce signal is absent', async () => {
    const { service, client, sse, frames } = buildHarness();
    client.streamChat.mockImplementationOnce(async ({ onEvent }: any) => {
      onEvent({
        type: 'done',
        reply: 'Legacy answer.',
        citations: [],
        steps: [],
        runtime: 'meriv3',
        model: 'configured-model',
        reasoningMode: 'fast',
        reasoningEffort: 'low',
      });
    });

    await service.streamMessage(CTX, CONVERSATION, 'Answer', sse, undefined, 'new', [], 'token');

    expect(frames().find((frame) => frame.type === 'citations')).toBeUndefined();
  });

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

describe('MeriV3 protocol-safe provider composition', () => {
  it('sends protected directives and handles, not compacted assistant/source bodies', async () => {
    const h = buildHarness();
    const protectedState = buildProtocolCompactionState({
      existingMetadata: {},
      previousBoundaryMessageId: null,
      boundaryMessageId: 'summary-end',
      clientId: null,
      messages: [
        { id: 'old-user', role: 'user', body: 'Prepare the client briefing.' },
        {
          id: 'summary-end',
          role: 'assistant',
          body: 'PRIVATE REVOKED SOURCE BODY',
          metadata: {
            finishReason: 'completed',
            citations: [
              { sourceId: 'source-9', sourceVersion: 'v9', snippet: 'REVOKED EXCERPT' },
            ],
            pendingApprovals: [
              { proposalId: 'proposal-9', tool: 'send_email', status: 'proposed' },
            ],
          },
        },
      ],
    });
    h.tx.clioConversation.findFirst.mockResolvedValue({
      id: CONVERSATION,
      clientId: null,
      summaryUpToMessageId: 'summary-end',
      summary: 'OLD MODEL SUMMARY WITH PRIVATE BODY',
      metadata: { [MERI_PROTOCOL_COMPACTION_METADATA_KEY]: protectedState },
      client: null,
    } as never);
    h.tx.clioMessage.findFirst.mockResolvedValue({ createdAt: new Date('2026-09-01') } as never);
    h.tx.clioMessage.findMany.mockImplementation(async (query?: any) =>
      query?.where?.metadata
        ? []
        : [
            { id: 'tail-user', role: 'user', body: 'Correction: use only enacted amounts.', metadata: {} },
            {
              id: 'tail-assistant',
              role: 'assistant',
              body: 'x'.repeat(100_000),
              metadata: {},
            },
          ],
    );
    let providerInput: any;
    h.client.streamChat.mockImplementationOnce(async ({ input, onEvent }: any) => {
      providerInput = input;
      onEvent({ type: 'done', reply: 'Current answer.', model: 'test', reasoningEffort: 'low' });
    });

    await h.service.streamMessage(CTX, CONVERSATION, 'Continue', h.sse, undefined, 'new', [], 'token');

    expect(providerInput.conversationSummary).toContain('Prepare the client briefing.');
    expect(providerInput.conversationSummary).toContain('source-9 version=v9');
    expect(providerInput.conversationSummary).toContain('proposal-9');
    expect(providerInput.conversationSummary).not.toContain('PRIVATE REVOKED SOURCE BODY');
    expect(providerInput.conversationSummary).not.toContain('OLD MODEL SUMMARY WITH PRIVATE BODY');
    expect(providerInput.conversationSummary).not.toContain('REVOKED EXCERPT');
    const boundedOutput = providerInput.messages.find((message: { text: string }) =>
      message.text.includes('SERVER REPLAY NOTICE'),
    );
    expect(boundedOutput).toBeDefined();
    expect(boundedOutput?.text.length).toBeLessThanOrEqual(12_000);
    expect(boundedOutput?.text).toContain('Ask the user to restate');
    expect(boundedOutput?.text).not.toContain('retrieve that message');
  });

  it('sends the long 81-message tail on a safe boundary under the aggregate history cap', async () => {
    const h = buildHarness();
    const chronological = Array.from({ length: 81 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 ? 'assistant' : 'user',
      body: `${index}:`.padEnd(60_000, 'x'),
      metadata: {},
    }));
    h.tx.clioMessage.findMany.mockResolvedValue([...chronological].reverse());
    let providerInput: any;
    h.client.streamChat.mockImplementationOnce(async ({ input, onEvent }: any) => {
      providerInput = input;
      onEvent({ type: 'done', reply: 'Bounded answer.', model: 'test', reasoningEffort: 'low' });
    });

    await h.service.streamMessage(CTX, CONVERSATION, 'Continue', h.sse, undefined, 'new', [], 'token');

    expect(providerInput.messages[0]?.role).toBe('user');
    expect(providerInput.messages.at(-1)?.role).toBe('user');
    expect(providerInput.messages.at(-1)?.text).toContain('80:');
    expect(
      providerInput.messages.reduce(
        (sum: number, message: { text: string }) => sum + message.text.length,
        providerInput.conversationSummary?.length ?? 0,
      ),
    ).toBeLessThanOrEqual(MAX_REPLAY_HISTORY_CHARS);
    expect(providerInput.messages.map((message: { text: string }) => message.text).join('\n')).toContain(
      'Ask the user to restate',
    );
  });

  it('fails closed when a historical summary has no matching protected-state receipt', async () => {
    const h = buildHarness();
    h.tx.clioConversation.findFirst.mockResolvedValue({
      id: CONVERSATION,
      clientId: null,
      summaryUpToMessageId: 'summary-end',
      summary: 'PRIVATE BODY FROM A NOW-REVOKED SOURCE',
      metadata: {},
      client: null,
    } as never);
    h.tx.clioMessage.findFirst.mockResolvedValue({ createdAt: new Date('2026-09-01') } as never);
    h.tx.clioMessage.findMany.mockImplementation(async (query?: any) =>
      query?.where?.metadata
        ? []
        : [{ id: 'tail-user', role: 'user', body: 'Continue safely.', metadata: {} }],
    );
    let providerInput: any;
    h.client.streamChat.mockImplementationOnce(async ({ input, onEvent }: any) => {
      providerInput = input;
      onEvent({ type: 'done', reply: 'Safe continuation.', model: 'test', reasoningEffort: 'low' });
    });

    await h.service.streamMessage(CTX, CONVERSATION, 'Continue', h.sse, undefined, 'new', [], 'token');

    expect(providerInput.conversationSummary).toContain('PARTIAL (fail closed)');
    expect(providerInput.conversationSummary).toContain('was not replayed');
    expect(providerInput.conversationSummary).not.toContain('PRIVATE BODY FROM A NOW-REVOKED SOURCE');
  });
});

describe('MeriV3 attachment source continuity', () => {
  const ref = { id: 'attachment-1', filename: 'TAG-letter.docx', kind: 'docx', status: 'parsed' };
  const document = {
    ...ref,
    textContent: 'FortressHUMS / UH-72 LUT. Requested evaluation in FY2027, not enacted.',
    reason: null,
    messageId: 'upload-turn',
    byteSize: 240,
  };
  const ctx = { tenantId: TENANT, userId: USER } as never;

  it('keeps a current image source ID beside its pixels so an explicit save can file the original', async () => {
    const h = buildHarness();
    const image = {
      id: 'image-source',
      filename: 'client-logo.png',
      kind: 'image',
      status: 'image',
      messageId: 'image-turn',
      reason: null,
      textContent: null,
      mediaType: 'image/png',
      data: Buffer.from('image-bytes'),
    };
    h.tx.clioMessage.findMany.mockResolvedValue([
      {
        id: 'image-turn',
        role: 'user',
        body: 'Save this under the selected client.',
        metadata: { attachments: [image] },
      },
    ]);
    h.tx.clioAttachment.findMany.mockResolvedValue([image]);
    const replay = await (h.service as any).buildReplay(ctx, CONVERSATION, null);
    expect(replay.history[0].text).toContain('"attachmentId":"image-source"');
    expect(replay.history[0].text).toContain('image is included for this turn');
    expect(replay.history[0].text).not.toContain(image.data.toString('base64'));
    expect(replay.currentTurnImages).toEqual([
      { mediaType: image.mediaType, dataBase64: image.data.toString('base64') },
    ]);
    for (const [query] of h.tx.clioAttachment.findMany.mock.calls as unknown as Array<[any]>) {
      expect(query.where).toMatchObject({ tenantId: TENANT, userId: USER });
      if (query.select.data) expect(query.where.messageId).toEqual({ in: ['image-turn'] });
      else expect(query.select.messageId).toBe(true);
    }
  });

  it('preserves an earlier image filing ID on follow-up without loading or claiming to read old pixels', async () => {
    const h = buildHarness();
    const image = {
      id: 'image-source',
      filename: 'client-logo.png',
      kind: 'image',
      status: 'image',
      messageId: 'image-turn',
      reason: null,
      textContent: null,
    };
    h.tx.clioMessage.findMany.mockResolvedValue([
      { id: 'followup', role: 'user', body: 'Send the logo to the client profile.', metadata: {} },
      {
        id: 'image-turn',
        role: 'user',
        body: 'Here is the logo.',
        metadata: { attachments: [image] },
      },
    ]);
    h.tx.clioAttachment.findMany.mockResolvedValue([image]);
    const replay = await (h.service as any).buildReplay(ctx, CONVERSATION, null);
    expect(replay.history[0].text).toContain('"attachmentId":"image-source"');
    expect(replay.history[0].text).toContain('image pixels are not included');
    expect(replay.currentTurnImages).toEqual([]);
    expect(h.tx.clioAttachment.findMany).toHaveBeenCalledTimes(1);
    const query = (h.tx.clioAttachment.findMany.mock.calls as unknown as Array<[any]>)[0]![0];
    expect(query).toMatchObject({ select: { id: true, kind: true } });
    expect(query.select.data).toBeUndefined();
  });

  it('reauthorizes image references older than the summary boundary for later filing', async () => {
    const h = buildHarness();
    const image = {
      id: 'image-source',
      filename: 'client-logo.png',
      kind: 'image',
      status: 'image',
      messageId: 'image-turn',
      reason: null,
      textContent: null,
    };
    (h.tx.clioMessage as any).findFirst = jest.fn(async () => ({
      createdAt: new Date('2026-09-09'),
    }));
    h.tx.clioMessage.findMany.mockImplementation(async (query?: any) =>
      query?.where?.metadata
        ? [{ id: 'image-turn', metadata: { attachments: [image] } }]
        : [{ id: 'followup', role: 'user', body: 'Save the logo to the client.', metadata: {} }],
    );
    h.tx.clioAttachment.findMany.mockResolvedValue([image]);
    const replay = await (h.service as any).buildReplay(ctx, CONVERSATION, 'summary-end');
    expect(replay.history[0].text).toContain('"attachmentId":"image-source"');
    expect(replay.history[0].text).toContain('retained after chat summary');
    expect(replay.history[0].text).toContain('image pixels are not included');
    expect(h.tx.clioAttachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ['image-source'] }, tenantId: TENANT, userId: USER },
      }),
    );
    expect(replay.currentTurnImages).toEqual([]);
  });

  it('does not authorize a guessed image source or assistant metadata as a filing reference', async () => {
    const h = buildHarness();
    const image = {
      id: 'unavailable-image',
      filename: 'hidden.png',
      kind: 'image',
      status: 'image',
    };
    h.tx.clioMessage.findMany.mockResolvedValue([
      { id: 'request', role: 'user', body: 'Save it.', metadata: { attachments: [image] } },
      {
        id: 'assistant',
        role: 'assistant',
        body: 'Previous answer',
        metadata: { attachments: [{ ...image, id: 'invented-by-assistant' }] },
      },
    ]);
    const replay = await (h.service as any).buildReplay(ctx, CONVERSATION, null);
    expect(replay.history[1].text).toContain('unavailable for this turn');
    expect(replay.history[1].text).not.toContain('Source:');
    expect(replay.history[0].text).toBe('Previous answer');
    for (const [query] of h.tx.clioAttachment.findMany.mock.calls as unknown as Array<[any]>) {
      expect(query.where.id.in).not.toContain('invented-by-assistant');
      expect(query.select.data).toBeUndefined();
    }
  });

  it.each([true, false])(
    'reauthorizes the original message when an image is reused outside visible history (authorized=%s)',
    async (authorized) => {
      const h = buildHarness();
      const image = {
        id: 'reused-image',
        filename: 'logo.png',
        kind: 'image',
        status: 'image',
        reason: null,
        textContent: null,
        messageId: 'original-message',
        mediaType: 'image/png',
        data: Buffer.from('pixels'),
      };
      h.tx.clioMessage.findMany.mockImplementation(async (query?: any) =>
        query.where.id?.in
          ? authorized
            ? [{ id: 'original-message' }]
            : []
          : [
              {
                id: 'current-message',
                role: 'user',
                body: 'Save the logo.',
                metadata: { attachments: [image] },
              },
            ],
      );
      h.tx.clioAttachment.findMany.mockResolvedValue([image]);
      const replay = await (h.service as any).buildReplay(ctx, CONVERSATION, null);
      expect(h.tx.clioMessage.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['original-message'] },
          conversationId: CONVERSATION,
          tenantId: TENANT,
          userId: USER,
          role: 'user',
        },
        select: { id: true },
      });
      if (authorized) {
        expect(replay.history[0].text).toContain('"attachmentId":"reused-image"');
        expect(replay.currentTurnImages).toHaveLength(1);
      } else {
        expect(replay.history[0].text).toContain('unavailable for this turn');
        expect(replay.history[0].text).not.toContain('Source:');
        expect(replay.currentTurnImages).toEqual([]);
        expect(h.tx.clioAttachment.findMany).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each([true, false])(
    'reauthorizes a compacted reused image whose original is outside the older-message window (authorized=%s)',
    async (authorized) => {
      const h = buildHarness();
      const image = {
        id: 'reused-image',
        filename: 'logo.png',
        kind: 'image',
        status: 'image',
        reason: null,
        textContent: null,
        messageId: 'oldest-original',
      };
      (h.tx.clioMessage as any).findFirst = jest.fn(async () => ({
        createdAt: new Date('2026-09-09'),
      }));
      h.tx.clioMessage.findMany.mockImplementation(async (query?: any) =>
        query.where.id?.in
          ? authorized
            ? [{ id: 'oldest-original' }]
            : []
          : query.where.metadata
            ? [{ id: 'recent-copy', metadata: { attachments: [image] } }]
            : [
                {
                  id: 'current-message',
                  role: 'user',
                  body: 'Save the earlier logo.',
                  metadata: {},
                },
              ],
      );
      h.tx.clioAttachment.findMany.mockResolvedValue([image]);
      const replay = await (h.service as any).buildReplay(ctx, CONVERSATION, 'summary-end');
      expect(h.tx.clioMessage.findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['oldest-original'] },
          conversationId: CONVERSATION,
          tenantId: TENANT,
          userId: USER,
          role: 'user',
        },
        select: { id: true },
      });
      if (authorized) expect(replay.history[0].text).toContain('"attachmentId":"reused-image"');
      else expect(replay.history[0].text).not.toContain('Source:');
      expect(replay.currentTurnImages).toEqual([]);
    },
  );

  it('does not mark an older in-window message as including a reused image only the current turn actually carries', async () => {
    const h = buildHarness();
    const image = {
      id: 'reused-image',
      filename: 'logo.png',
      kind: 'image',
      status: 'image',
      reason: null,
      textContent: null,
      messageId: 'original-message',
      mediaType: 'image/png',
      data: Buffer.from('pixels'),
    };
    h.tx.clioMessage.findMany.mockResolvedValue([
      {
        id: 'current-message',
        role: 'user',
        body: 'Save that logo again.',
        metadata: { attachments: [image] },
      },
      {
        id: 'original-message',
        role: 'user',
        body: 'Here is the logo.',
        metadata: { attachments: [image] },
      },
    ]);
    h.tx.clioAttachment.findMany.mockResolvedValue([image]);
    const replay = await (h.service as any).buildReplay(ctx, CONVERSATION, null);
    expect(replay.history[0].text).toContain('"attachmentId":"reused-image"');
    expect(replay.history[0].text).toContain('image pixels are not included');
    expect(replay.history[0].text).not.toContain('image is included for this turn');
    expect(replay.history[1].text).toContain('image is included for this turn');
    expect(replay.currentTurnImages).toHaveLength(1);
  });

  it('replays the same attachment text and ID on a follow-up and a fresh service reload', async () => {
    for (let reload = 0; reload < 2; reload += 1) {
      const h = buildHarness();
      h.tx.clioMessage.findMany.mockResolvedValue([
        {
          id: 'followup',
          role: 'user',
          body: 'Draft the letter from that attachment.',
          metadata: {},
        },
        {
          id: 'upload-turn',
          role: 'user',
          body: 'Read this file.',
          metadata: { attachments: [ref] },
        },
      ]);
      h.tx.clioAttachment.findMany.mockResolvedValue([document]);
      const replay = await (h.service as any).buildReplay(ctx, CONVERSATION, null);
      expect(replay.history[0].text).toContain(document.textContent);
      expect(replay.history[0].text).toContain('"attachmentId":"attachment-1"');
      expect(replay.history[0].text).toContain('Reading this attachment does not save');
      expect(h.tx.clioAttachment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: TENANT, userId: USER }),
        }),
      );
    }
  });

  it('retains original attachment metadata during regeneration and passes the source text to the provider', async () => {
    const h = buildHarness();
    const user = {
      id: 'upload-turn',
      role: 'user',
      body: 'Draft from the attachment.',
      metadata: { attachments: [ref] },
    };
    h.tx.clioMessage.findMany.mockResolvedValue([user]);
    h.tx.clioAttachment.findMany.mockResolvedValue([document]);
    await h.service.streamMessage(
      ctx,
      CONVERSATION,
      '',
      h.sse,
      undefined,
      'regenerate',
      [],
      'token',
    );
    expect(h.tx.clioMessage.update).not.toHaveBeenCalled();
    expect(h.tx.clioAttachment.updateMany).not.toHaveBeenCalled();
    expect(h.client.streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          messages: [
            expect.objectContaining({ text: expect.stringContaining(document.textContent) }),
          ],
        }),
      }),
    );
  });

  it('rehydrates an attachment older than the summary boundary without treating the summary as the original', async () => {
    const h = buildHarness();
    (h.tx.clioMessage as any).findFirst = jest.fn(async () => ({
      createdAt: new Date('2026-09-09'),
    }));
    h.tx.clioMessage.findMany.mockImplementation(async (query?: any) =>
      query?.where?.metadata
        ? [{ id: 'upload-turn', metadata: { attachments: [ref] } }]
        : [
            {
              id: 'followup',
              role: 'user',
              body: 'What exact program was in the letter?',
              metadata: {},
            },
          ],
    );
    h.tx.clioAttachment.findMany.mockResolvedValue([document]);
    const replay = await (h.service as any).buildReplay(ctx, CONVERSATION, 'summary-end');
    expect(replay.history[0].text).toContain(document.textContent);
    expect(replay.history[0].text).toContain('retained after chat summary');
    expect(h.tx.clioAttachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: TENANT, userId: USER, id: { in: [ref.id] } }),
      }),
    );
  });

  it('discloses a missing attachment instead of silently omitting it from the provider input', async () => {
    const h = buildHarness();
    h.tx.clioMessage.findMany.mockResolvedValue([
      { id: 'upload-turn', role: 'user', body: 'Read the file.', metadata: { attachments: [ref] } },
    ]);
    const replay = await (h.service as any).buildReplay(ctx, CONVERSATION, null);
    expect(replay.history[0].text).toContain('TAG-letter.docx');
    expect(replay.history[0].text).toContain('unavailable for this turn');
  });

  it('rejects a foreign-chat source before persisting a user turn and never moves the attachment', async () => {
    const h = buildHarness();
    h.tx.clioAttachment.findMany.mockResolvedValue([
      { ...document, messageId: 'other-chat-message' },
    ]);
    await expect(
      (h.service as any).persistUserMessage(ctx, { id: CONVERSATION, clientId: null }, 'Read it', [
        ref.id,
      ]),
    ).rejects.toThrow('another chat');
    expect(h.tx.clioMessage.create).not.toHaveBeenCalled();
    expect(h.tx.clioAttachment.updateMany).not.toHaveBeenCalled();
  });

  it('claims an unattached upload atomically and refuses a lost concurrent claim', async () => {
    for (const count of [1, 0]) {
      const h = buildHarness();
      h.tx.clioAttachment.findMany.mockResolvedValue([{ ...document, messageId: null }]);
      h.tx.clioAttachment.updateMany.mockResolvedValue({ count });
      const persisted = (h.service as any).persistUserMessage(
        ctx,
        { id: CONVERSATION, clientId: null },
        'Read it',
        [ref.id],
      );
      if (count === 1) await expect(persisted).resolves.toEqual(expect.any(String));
      else await expect(persisted).rejects.toThrow('used in another chat');
      expect(h.tx.clioAttachment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ messageId: null, tenantId: TENANT, userId: USER }),
        }),
      );
    }
  });
});
