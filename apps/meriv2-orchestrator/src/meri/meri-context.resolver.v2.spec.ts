import { MeriContextResolver } from './meri-context.resolver';
import type { OrchestratorContextCompilerService } from './context-compiler.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { OrchestratorTenantContext } from '../auth/tenant-context';

/**
 * ContextPacket v2 through the orchestrator resolver — the shared entry point for
 * ga-chat, in-editor, Strategy and Steward.
 *
 * Two things are pinned here:
 *   1. the request is byte-for-byte the pre-v2 one until CONTEXT_PACKET_V2=enforce;
 *   2. the summary reports the packet's REAL authority/selection/health rather than
 *      asserting 'human-authored' + 'automatic' + degraded:false over everything.
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

const V1_PACKET = {
  packetId: 'pkt-1',
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

  it('a non-"enforce" value stays dark', async () => {
    for (const raw of ['true', '1', 'on', 'v2']) {
      process.env.CONTEXT_PACKET_V2 = raw;
      const compiler = compilerReturning(V1_PACKET);
      const resolver = new MeriContextResolver(prismaWithUser(), compiler);
      await resolver.resolve(tc, null, 'ga-chat');
      const request = compiler.compile.mock.calls[0]![0] as Record<string, unknown>;
      expect(request).not.toHaveProperty('contractVersion');
    }
  });

  it('opts into v2 with a trace id and a token budget once armed', async () => {
    process.env.CONTEXT_PACKET_V2 = 'enforce';
    const compiler = compilerReturning(V1_PACKET);
    const resolver = new MeriContextResolver(prismaWithUser(), compiler);
    await resolver.resolve(tc, null, 'strategy');
    const request = compiler.compile.mock.calls[0]![0] as Record<string, unknown>;
    expect(request.contractVersion).toBe(2);
    expect(request.traceId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(request.tokenBudget).toBe(8_000);
    expect(request.budgetUnit).toBe('tokens');
    // A trace-write failure must never become a steering blackout.
    expect(request).not.toHaveProperty('persistence');
  });

  it('attributes the packet to the surface that asked, not the ga-chat default', async () => {
    const compiler = compilerReturning(V1_PACKET);
    const resolver = new MeriContextResolver(prismaWithUser(), compiler);
    const ctx = await resolver.resolve(tc, null, 'steward');
    expect(ctx.contextPacket?.surface).toBe('steward');
    expect((compiler.compile.mock.calls[0]![0] as { surface: string }).surface).toBe('steward');
  });
});

describe('MeriContextResolver — honest packet summary', () => {
  it('keeps the legacy label for a v1 item (it carries no provenance to report)', async () => {
    const resolver = new MeriContextResolver(prismaWithUser(), compilerReturning(V1_PACKET));
    const ctx = await resolver.resolve(tc);
    expect(ctx.contextPacket?.items[0]).toEqual(
      expect.objectContaining({ authority: 'human-authored', selection: 'automatic' }),
    );
    expect(ctx.contextPacket?.degraded).toBe(false);
  });

  it('reports a v2 item\'s real authority and explicit selection', async () => {
    const resolver = new MeriContextResolver(
      prismaWithUser(),
      compilerReturning({
        ...V1_PACKET,
        version: 2,
        health: { status: 'healthy', missingRequiredLayers: [], conflictCount: 0, sourceFailureCount: 0, reasons: [] },
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

  /**
   * All three of these mean the caller isn't authorized to know the item exists.
   * The compiler already strips id/type/slug for them; the summary must count all
   * three and list none.
   */
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
