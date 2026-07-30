import { UnauthorizedException } from '@nestjs/common';
import { MeriContextResolver } from './meri-context.resolver';
import type { OrchestratorContextCompilerService } from './context-compiler.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrchestratorTenantContext } from '../auth/tenant-context';

function prismaWithUser(user: { id: string } | null): PrismaService {
  return {
    user: { findUnique: async () => user },
    withTenant: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({ client: { findMany: async () => [] } }),
  } as unknown as PrismaService;
}

function compilerWith(
  rendered: Array<{ layer: string; type: string; body: string }>,
): OrchestratorContextCompilerService & { compile: jest.Mock } {
  return {
    compile: jest.fn(async () => ({
      packetId: 'pkt-1',
      generatedPacketId: 'pkt-1',
      persistedPacketId: 'pkt-1',
      persisted: true,
      persistenceErrorCode: null,
      compiledAt: '2026-07-29T12:00:00.000Z',
      version: 1,
      surface: 'ga-chat',
      tenantId: 't1',
      effectiveTenantId: 't1',
      actorUserId: 'user-9',
      userId: 'user-9',
      clientId: null,
      ref: {},
      traceHash: 'hash-1',
      rendered: rendered.map((r, i) => ({ id: `mi-${i}`, slug: 'x', title: null, ...r })),
      items: [],
      exclusions: [],
    })),
  } as unknown as OrchestratorContextCompilerService & { compile: jest.Mock };
}

const tc: OrchestratorTenantContext = {
  tenantId: 't1',
  clerkUserId: 'clerk_1',
  role: 'org:member',
};

describe('MeriContextResolver', () => {
  it('resolves the Capiro userId and builds a full MeriContext', async () => {
    const r = new MeriContextResolver(prismaWithUser({ id: 'user-9' }), compilerWith([]));
    const ctx = await r.resolve(tc);
    expect(ctx).toEqual({
      tenantId: 't1',
      userId: 'user-9',
      clerkUserId: 'clerk_1',
      role: 'standard_user',
      contextPacket: {
        packetId: 'pkt-1',
        persisted: true,
        persistenceErrorCode: null,
        compiledAt: '2026-07-29T12:00:00.000Z',
        surface: 'ga-chat',
        clientId: null,
        items: [],
        exclusions: [],
        unauthorizedCount: 0,
        degraded: false,
      },
    });
  });

  it('maps an admin org role to user_admin conservatively', async () => {
    const r = new MeriContextResolver(prismaWithUser({ id: 'u' }), compilerWith([]));
    expect((await r.resolve({ ...tc, role: 'org:admin' })).role).toBe('user_admin');
    expect((await r.resolve({ ...tc, role: null })).role).toBe('standard_user');
  });

  it('fails closed when the verified identity has no Capiro user', async () => {
    const r = new MeriContextResolver(prismaWithUser(null), compilerWith([]));
    await expect(r.resolve(tc)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('compiles firm identity and user voice with the resolved Capiro userId', async () => {
    const compiler = compilerWith([
      { layer: 'firm-identity', type: 'firm-soul', body: 'Who: Us.' },
      { layer: 'firm-identity', type: 'firm-compass', body: 'Where: Up.' },
      { layer: 'user-voice', type: 'user-voice', body: 'Tone: Direct and concise.' },
    ]);
    const r = new MeriContextResolver(prismaWithUser({ id: 'user-9' }), compiler);
    const ctx = await r.resolve(tc);

    expect(compiler.compile).toHaveBeenCalledWith({
      tenantId: 't1',
      userId: 'user-9',
      surface: 'ga-chat',
      layers: ['firm-identity', 'user-voice'],
      ref: {},
    });
    expect(ctx.firmMemory).toEqual({ soul: 'Who: Us.', compass: 'Where: Up.' });
    expect(ctx.userVoice).toContain('Direct and concise.');
  });

  it('a compile failure is non-fatal on chat and returns degraded provenance', async () => {
    const compiler = {
      compile: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as OrchestratorContextCompilerService;
    const r = new MeriContextResolver(prismaWithUser({ id: 'user-9' }), compiler);
    const ctx = await r.resolve(tc);
    expect(ctx.userId).toBe('user-9');
    expect(ctx.firmMemory).toBeUndefined();
    expect(ctx.userVoice).toBeUndefined();
    expect(ctx.contextPacket).toEqual(
      expect.objectContaining({ packetId: null, persisted: false, degraded: true }),
    );
  });
});
