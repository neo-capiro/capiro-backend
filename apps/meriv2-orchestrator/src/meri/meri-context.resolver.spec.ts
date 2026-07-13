import { UnauthorizedException } from '@nestjs/common';
import { MeriContextResolver } from './meri-context.resolver';
import type { OrchestratorContextCompilerService } from './context-compiler.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrchestratorTenantContext } from '../auth/tenant-context';

function prismaWithUser(user: { id: string } | null): PrismaService {
  return { user: { findUnique: async () => user } } as unknown as PrismaService;
}

function compilerWith(
  rendered: Array<{ layer: string; type: string; body: string }>,
): OrchestratorContextCompilerService & { compile: jest.Mock } {
  return {
    compile: jest.fn(async () => ({
      packetId: 'pkt-1',
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
    });
  });

  it('maps an admin org role to user_admin (conservative, never escalates)', async () => {
    const r = new MeriContextResolver(prismaWithUser({ id: 'u' }), compilerWith([]));
    expect((await r.resolve({ ...tc, role: 'org:admin' })).role).toBe('user_admin');
    expect((await r.resolve({ ...tc, role: null })).role).toBe('standard_user');
  });

  it('fails closed (401) when the verified identity has no Capiro user', async () => {
    const r = new MeriContextResolver(prismaWithUser(null), compilerWith([]));
    await expect(r.resolve(tc)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // G1-b: firm identity + user voice load through the shared Context Compiler
  // with the RESOLVED Capiro userId. The withTenantUser/1C tenancy discipline
  // — whose absence silently zeroed GA-chat voice on 2026-07-12 — lives in the
  // adapter now (locked by context-compiler.service.spec); what this resolver
  // must guarantee is that it asks for the right layers with the right
  // identity and maps the packet onto MeriContext.
  it('compiles firm-identity + user-voice with the resolved Capiro userId', async () => {
    const compiler = compilerWith([
      { layer: 'firm-identity', type: 'firm-soul', body: 'Who: Us.' },
      { layer: 'firm-identity', type: 'firm-compass', body: 'Where: Up.' },
      { layer: 'user-voice', type: 'user-voice', body: 'Tone: Direct and concise.' },
    ]);
    const r = new MeriContextResolver(prismaWithUser({ id: 'user-9' }), compiler);
    const ctx = await r.resolve(tc);

    expect(compiler.compile).toHaveBeenCalledWith({
      tenantId: 't1',
      userId: 'user-9', // the RESOLVED Capiro uuid, never the Clerk id
      surface: 'ga-chat',
      layers: ['firm-identity', 'user-voice'],
    });
    expect(ctx.firmMemory).toEqual({ soul: 'Who: Us.', compass: 'Where: Up.' });
    expect(ctx.userVoice).toContain('Direct and concise.');
  });

  it('a compile failure is non-fatal: context resolves without firm/voice blocks', async () => {
    const compiler = {
      compile: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as OrchestratorContextCompilerService;
    const r = new MeriContextResolver(prismaWithUser({ id: 'user-9' }), compiler);
    const ctx = await r.resolve(tc);
    expect(ctx.userId).toBe('user-9');
    expect(ctx.firmMemory).toBeUndefined();
    expect(ctx.userVoice).toBeUndefined();
  });
});
