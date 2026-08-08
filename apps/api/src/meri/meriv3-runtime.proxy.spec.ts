import { createMeriRuntimeService } from './meriv3-runtime.proxy.js';
import type { MeriService } from './meri.service.js';
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
  } as unknown as MeriService;
  const meriv3 = {
    shouldHandle: jest.fn(async () => false),
    streamMessage: jest.fn(async () => undefined),
  } as unknown as MeriV3ProxyService;
  const visualAnalysis = {
    getArtifactImage: jest.fn(async () => ({
      buffer: Buffer.from('user-scoped-result'),
      contentType: 'image/png',
    })),
  } as unknown as MeriV3VisualAnalysisService;
  return {
    raw,
    meriv3,
    visualAnalysis,
    service: createMeriRuntimeService(raw, meriv3, visualAnalysis),
  };
}

describe('Meri runtime proxy', () => {
  test('delegates a non-canary turn to the existing MeriService', async () => {
    const { raw, meriv3, service } = make();
    await service.streamMessage(ctx as never, 'conversation', 'hello', { write: jest.fn() });
    expect(meriv3.shouldHandle).toHaveBeenCalledWith(ctx);
    expect(meriv3.streamMessage).not.toHaveBeenCalled();
    expect(raw.streamMessage).toHaveBeenCalledTimes(1);
  });

  test('routes an allowed turn to MeriV3 and never also calls V2', async () => {
    const { raw, meriv3, service } = make();
    (meriv3.shouldHandle as jest.Mock).mockResolvedValue(true);
    const writer = { write: jest.fn() };
    await service.streamMessage(ctx as never, 'conversation', 'hello', writer);
    expect(meriv3.streamMessage).toHaveBeenCalledWith(ctx, 'conversation', 'hello', writer);
    expect(raw.streamMessage).not.toHaveBeenCalled();
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
