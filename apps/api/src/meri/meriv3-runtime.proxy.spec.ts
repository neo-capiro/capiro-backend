import { createMeriRuntimeService } from './meriv3-runtime.proxy.js';
import type { MeriService } from './meri.service.js';
import type { MeriContextPlaneRuntimeService } from './meri-context-plane-runtime.js';
import type { MeriV3ProxyService } from './meriv3-proxy.service.js';
import type { MeriV3VisualAnalysisService } from './meri-v3-visual-analysis.service.js';

const ctx = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro-internal',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as const;

function make() {
  const raw = {
    streamMessage: jest.fn(async () => undefined),
    listConversations: jest.fn(async () => ['raw']),
    getArtifactImage: jest.fn(async () => ({
      buffer: Buffer.from('legacy-tenant-only-result'),
      contentType: 'image/png',
    })),
    orchestrateContext: jest.fn(async () => ({})),
    loadRelevantMemories: jest.fn(async () => []),
    policyForIntent: jest.fn(() => ({})),
    templateForIntent: jest.fn(() => null),
    meriV2Chat: { streamChat: jest.fn(async () => undefined) },
    clientKb: { buildSnapshot: jest.fn(async () => 'legacy-kb') },
  } as unknown as MeriService;
  const meriv3 = {
    shouldHandle: jest.fn(async () => false),
    streamMessage: jest.fn(async () => undefined),
    client: { streamChat: jest.fn(async () => undefined) },
    clientKb: { buildSnapshot: jest.fn(async () => 'v3-kb') },
  } as unknown as MeriV3ProxyService;
  const visualAnalysis = {
    getArtifactImage: jest.fn(async () => ({
      buffer: Buffer.from('user-scoped-result'),
      contentType: 'image/png',
    })),
  } as unknown as MeriV3VisualAnalysisService;
  const governedRuntime = {
    runChatTurn: jest.fn(
      async (_valueCtx: unknown, _input: unknown, execute: () => Promise<unknown>) => execute(),
    ),
  } as unknown as MeriContextPlaneRuntimeService;
  const hermes = {
    shouldHandle: jest.fn(async () => false),
    streamMessage: jest.fn(async () => undefined),
  };
  return {
    raw,
    meriv3,
    visualAnalysis,
    governedRuntime,
    hermes,
    service: createMeriRuntimeService(raw, meriv3, visualAnalysis, governedRuntime, hermes),
  };
}

describe('Meri runtime proxy Phase 19', () => {
  test('resolves governed context before delegating a non-canary turn to the existing MeriService', async () => {
    const { raw, meriv3, governedRuntime, service } = make();
    await service.streamMessage(ctx as never, 'conversation', 'hello', { write: jest.fn() });

    expect(governedRuntime.runChatTurn).toHaveBeenCalledWith(
      ctx,
      { conversationId: 'conversation', body: 'hello', mode: 'new', signal: undefined },
      expect.any(Function),
    );
    expect(meriv3.shouldHandle).toHaveBeenCalledWith(ctx);
    expect(meriv3.streamMessage).not.toHaveBeenCalled();
    expect(raw.streamMessage).toHaveBeenCalledTimes(1);
  });

  test('resolves governed context once before routing an allowed turn to MeriV3', async () => {
    const { raw, meriv3, governedRuntime, service } = make();
    (meriv3.shouldHandle as jest.Mock).mockResolvedValue(true);
    const writer = { write: jest.fn() };

    await service.streamMessage(ctx as never, 'conversation', 'hello', writer);

    expect(governedRuntime.runChatTurn).toHaveBeenCalledTimes(1);
    expect(meriv3.streamMessage).toHaveBeenCalledWith(ctx, 'conversation', 'hello', {
      write: expect.any(Function),
    });
    const forwarded = (meriv3.streamMessage as jest.Mock).mock.calls[0]![3];
    forwarded.write('data: {"type":"text","text":"hello"}\n\n');
    expect(writer.write).toHaveBeenCalledWith('data: {"type":"text","text":"hello"}\n\n');
    expect(raw.streamMessage).not.toHaveBeenCalled();
  });

  test('preserves regenerate mode when preparing the governed turn', async () => {
    const { governedRuntime, service } = make();

    await service.streamMessage(
      ctx as never,
      'conversation',
      '',
      { write: jest.fn() },
      undefined,
      'regenerate',
    );

    expect(governedRuntime.runChatTurn).toHaveBeenCalledWith(
      ctx,
      { conversationId: 'conversation', body: '', mode: 'regenerate', signal: undefined },
      expect.any(Function),
    );
  });

  test('routes the legacy image endpoint through the tenant + user scoped reader', async () => {
    const { raw, visualAnalysis, service } = make();
    await expect(service.getArtifactImage(ctx as never, 'chart-1')).resolves.toEqual({
      buffer: Buffer.from('user-scoped-result'),
      contentType: 'image/png',
    });
    expect(visualAnalysis.getArtifactImage).toHaveBeenCalledWith(ctx, 'chart-1');
    expect(raw.getArtifactImage).not.toHaveBeenCalled();
  });

  test('binds every other non-stream method to the original service', async () => {
    const { raw, service } = make();
    await expect(service.listConversations(ctx as never)).resolves.toEqual(['raw']);
    expect(raw.listConversations).toHaveBeenCalledWith(ctx);
  });
});

describe('Meri runtime proxy Hermes pilot route (Phase 0)', () => {
  test('a non-pilot tenant never touches Hermes and keeps its existing runtime', async () => {
    const { raw, meriv3, hermes, service } = make();
    await service.streamMessage(ctx as never, 'conversation', 'hello', { write: jest.fn() });
    expect(hermes.shouldHandle).toHaveBeenCalledWith(ctx);
    expect(hermes.streamMessage).not.toHaveBeenCalled();
    expect(meriv3.shouldHandle).toHaveBeenCalledWith(ctx);
    expect(raw.streamMessage).toHaveBeenCalledTimes(1);
  });

  test('a pilot tenant routes to Hermes before V3 is consulted, inside the governed turn', async () => {
    const { raw, meriv3, hermes, governedRuntime, service } = make();
    hermes.shouldHandle.mockResolvedValue(true);
    (meriv3.shouldHandle as jest.Mock).mockResolvedValue(true);
    const writer = { write: jest.fn() };
    await service.streamMessage(ctx as never, 'conversation', 'hello', writer);
    expect(governedRuntime.runChatTurn).toHaveBeenCalledTimes(1);
    expect(hermes.streamMessage).toHaveBeenCalledWith(ctx, 'conversation', 'hello', {
      write: expect.any(Function),
    });
    expect(meriv3.shouldHandle).not.toHaveBeenCalled();
    expect(meriv3.streamMessage).not.toHaveBeenCalled();
    expect(raw.streamMessage).not.toHaveBeenCalled();
  });

  test('a Hermes failure surfaces to the caller and never falls back to V3 or legacy', async () => {
    const { raw, meriv3, hermes, service } = make();
    hermes.shouldHandle.mockResolvedValue(true);
    hermes.streamMessage.mockRejectedValue(new Error('Hermes runtime unavailable'));
    await expect(
      service.streamMessage(ctx as never, 'conversation', 'hello', { write: jest.fn() }),
    ).rejects.toThrow('Hermes runtime unavailable');
    expect(meriv3.streamMessage).not.toHaveBeenCalled();
    expect(raw.streamMessage).not.toHaveBeenCalled();
  });

  test('the factory still works without a Hermes adapter (other deployments)', async () => {
    const { raw, meriv3, visualAnalysis, governedRuntime } = make();
    const service = createMeriRuntimeService(raw, meriv3, visualAnalysis, governedRuntime);
    await service.streamMessage(ctx as never, 'conversation', 'hello', { write: jest.fn() });
    expect(raw.streamMessage).toHaveBeenCalledTimes(1);
  });
});
