import { ContextPacketPersistenceError } from '@capiro/meriv2-core';
import { MeriContextResolver } from './meri-context.resolver';
import type { OrchestratorContextCompilerService } from './context-compiler.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrchestratorTenantContext } from '../auth/tenant-context';

/**
 * ContextPacket v2 through the orchestrator resolver — the shared entry point for
 * ga-chat, in-editor, Strategy and Steward.
 */
const tc: OrchestratorTenantContext = {
  tenantId: 't1',
  clerkUserId: 'clerk_1',
  role: 'org:member',
};

function prismaWithUser(): PrismaService {
  return {
    user: { findUnique: async () => ({ id: 'user-9' }) },
    withTenant: async () => [],
  } as unknown as PrismaService;
}

function compilerReturning(
  packet: Record<string, unknown>,
): OrchestratorContextCompilerService & { compile: jest.Mock } {
  return {
    compile: jest.fn(async () => packet),
  } as unknown as OrchestratorContextCompilerService & { compile: jest.Mock };
}

function compilerThrowing(
  error: Error,
): OrchestratorContextCompilerService & { compile: jest.Mock } {
  return {
    compile: jest.fn(async () => {
      throw error;
    }),
  } as unknown as OrchestratorContextCompilerService & { compile: jest.Mock };
}

const V1_PACKET = {
  packetId: 'pkt-1',
  persistedPacketId: 'pkt-1',
  persisted: true,
  persistenceErrorCode: null,
  version: 1 as const,
  compiledAt: '2026-07-29T12:00:00.000Z',
  clientId: null,
  rendered: [],
  items: [
    {
      layer: 'firm-identity',
      id: 'mi-1',
      type: 'firm-soul',
      slug: 'firm',
      rationale: 'Firm soul steers drafting',
    },
  ],
  exclusions: [],
};

describe('MeriContextResolver — ContextPacket v2 switch', () => {
  const originalEnv = process.env.CONTEXT_PACKET_V2;
  beforeEach(() => {
    delete process.env.CONTEXT_PACKET_V2;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CONTEXT_PACKET_V2;
    else process.env.CONTEXT_PACKET_V2 = originalEnv;
  });

  it('requests NO v2 field while dark, on every surface it serves', async () => {
    for (const surface of ['ga-chat', 'workspace-editor', 'strategy', 'steward'] as const) {
      const compiler = compilerReturning(V1_PACKET);
      const resolver = new MeriContextResolver(prismaWithUser(), compiler);
      await resolver.resolve(tc, null, surface);
      const request = compiler.compile.mock.calls[0]![0] as Record<string, unknown>;
      expect(request).not.toHaveProperty('contractVersion');
      expect(request).not.toHaveProperty('traceId');
      expect(request).not.toHaveProperty('tokenBudget');
      expect(request).not.toHaveProperty('persistence');
      expect(request.surface).toBe(surface);
    }
  });

  it('a non-enforce value stays dark', async () => {
    for (const raw of ['true', '1', 'on', 'v2']) {
      process.env.CONTEXT_PACKET_V2 = raw;
      const compiler = compilerReturning(V1_PACKET);
      const resolver = new MeriContextResolver(prismaWithUser(), compiler);
      await resolver.resolve(tc, null, 'ga-chat');
      const request = compiler.compile.mock.calls[0]![0] as Record<string, unknown>;
      expect(request).not.toHaveProperty('contractVersion');
    }
  });

  it('uses best-effort persistence for chat and required persistence for deliverables', async () => {
    process.env.CONTEXT_PACKET_V2 = 'enforce';
    for (const [surface, expected] of [
      ['ga-chat', 'best-effort'],
      ['steward', 'best-effort'],
      ['workspace-editor', 'required'],
      ['strategy', 'required'],
    ] as const) {
      const compiler = compilerReturning(V1_PACKET);
      const resolver = new MeriContextResolver(prismaWithUser(), compiler);
      await resolver.resolve(tc, null, surface);
      const request = compiler.compile.mock.calls[0]![0] as Record<string, unknown>;
      expect(request.contractVersion).toBe(2);
      expect(request.traceId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
      expect(request.budgetUnit).toBe('tokens');
      expect(request.persistence).toBe(expected);
    }
  });

  it('attributes the packet to the surface that asked, not the ga-chat default', async () => {
    const compiler = compilerReturning(V1_PACKET);
    const resolver = new MeriContextResolver(prismaWithUser(), compiler);
    const ctx = await resolver.resolve(tc, null, 'steward');
    expect(ctx.contextPacket?.surface).toBe('steward');
    expect((compiler.compile.mock.calls[0]![0] as { surface: string }).surface).toBe('steward');
  });

  it('continues chat with truthful degraded provenance when persistence fails', async () => {
    process.env.CONTEXT_PACKET_V2 = 'enforce';
    const error = new ContextPacketPersistenceError(
      'context_packet_error',
      'generated-id',
      'ga-chat',
    );
    const resolver = new MeriContextResolver(prismaWithUser(), compilerThrowing(error));

    const ctx = await resolver.resolve(tc, null, 'ga-chat');

    expect(ctx.contextPacket).toEqual(
      expect.objectContaining({
        packetId: null,
        persisted: false,
        persistenceErrorCode: 'context_packet_error',
        degraded: true,
      }),
    );
  });

  it('propagates required persistence failure for strategy before deliverable release', async () => {
    process.env.CONTEXT_PACKET_V2 = 'enforce';
    const error = new ContextPacketPersistenceError(
      'context_packet_error',
      'generated-id',
      'strategy',
    );
    const resolver = new MeriContextResolver(prismaWithUser(), compilerThrowing(error));

    await expect(resolver.resolve(tc, null, 'strategy')).rejects.toBe(error);
  });
});

describe('MeriContextResolver — honest packet summary', () => {
  it('keeps the legacy label for a v1 item', async () => {
    const resolver = new MeriContextResolver(prismaWithUser(), compilerReturning(V1_PACKET));
    const ctx = await resolver.resolve(tc);
    expect(ctx.contextPacket?.items[0]).toEqual(
      expect.objectContaining({ authority: 'human-authored', selection: 'automatic' }),
    );
    expect(ctx.contextPacket?.degraded).toBe(false);
    expect(ctx.contextPacket?.packetId).toBe('pkt-1');
  });

  it("reports a v2 item's real authority and explicit selection", async () => {
    const resolver = new MeriContextResolver(
      prismaWithUser(),
      compilerReturning({
        ...V1_PACKET,
        version: 2,
        health: {
          status: 'healthy',
          missingRequiredLayers: [],
          conflictCount: 0,
          sourceFailureCount: 0,
          reasons: [],
        },
        items: [
          {
            layer: 'firm-identity',
            id: 'mi-1',
            type: 'firm-soul',
            slug: 'firm',
            authority: 'model_inferred',
            selectionTier: 'explicit',
            inclusionReason: 'Selected by user',
            asOf: '2026-07-01T00:00:00.000Z',
            lastConfirmedAt: null,
          },
        ],
      }),
    );
    const ctx = await resolver.resolve(tc);
    expect(ctx.contextPacket?.items[0]).toEqual(
      expect.objectContaining({
        authority: 'model_inferred',
        selection: 'explicit',
        rationale: 'Selected by user',
        asOf: '2026-07-01T00:00:00.000Z',
      }),
    );
    expect(ctx.contextPacket?.items[0]).not.toHaveProperty('lastConfirmedAt');
  });

  it('counts every identity-withheld reason and lists none of them', async () => {
    const resolver = new MeriContextResolver(
      prismaWithUser(),
      compilerReturning({
        ...V1_PACKET,
        version: 2,
        health: {
          status: 'degraded',
          missingRequiredLayers: ['client-steering'],
          conflictCount: 0,
          sourceFailureCount: 0,
          reasons: ['Missing required layers: client-steering'],
        },
        items: [],
        exclusions: [
          { layer: 'firm-identity', reason: 'unauthorized' },
          { layer: 'client-steering', reason: 'wrong-client' },
          { layer: 'firm-identity', reason: 'sensitivity-denied' },
          { layer: 'firm-identity', id: 'mi-9', type: 'firm-compass', reason: 'revoked' },
        ],
      }),
    );
    const ctx = await resolver.resolve(tc);
    expect(ctx.contextPacket?.unauthorizedCount).toBe(3);
    expect(ctx.contextPacket?.exclusions).toEqual([
      { id: 'mi-9', label: 'firm-compass', type: 'firm-compass', reason: 'revoked' },
    ]);
    expect(ctx.contextPacket?.degraded).toBe(true);
    expect(ctx.contextPacket?.degradedReason).toBe('Missing required layers: client-steering');
  });
});
