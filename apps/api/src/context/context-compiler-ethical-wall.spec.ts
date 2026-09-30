import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ContextRequest } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ContextCompilerService } from './context-compiler.service.js';
import { ContextLayerService } from './context-layer.service.js';
import { ContextPacketV2Service } from './context-packet-v2.service.js';
import type { ContextRetrievalResult } from './context-resolver.types.js';

/**
 * The ethical wall on the ContextPlaneGatewayService compile path is decided by
 * ContextCompilerService from the packet's own tenant, actor and client — never
 * by the product adapter that built the ContextRequest.
 *
 * This is the property that kept three Phase 22/23/26 adapters (LegiWatch, CRM
 * Fill with Meri, Strategies) from being live ethical-wall bypasses while they
 * hard-coded `ethicalWallAllowed: true` (d8a97dfec). If the compiler ever starts
 * trusting the caller's value, every adapter that still sends a literal becomes
 * a bypass, so the invariant is pinned here against the real layer bridge and
 * the real compiler rather than against a mocked compiler.
 */
describe('Context Plane compile path — ethical wall is server-derived', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const ACTOR = '22222222-2222-4222-8222-222222222222';
  const CLIENT = '33333333-3333-4333-8333-333333333333';
  const APPROVER = '44444444-4444-4444-8444-444444444444';
  const WALLED_TEXT = 'WALLED CLIENT STRATEGY: settlement ceiling is $4.2M.';

  const approved = {
    status: 'active',
    legacyStatus: 'active',
    governedStatus: 'active',
    expiresAt: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    confirmedAt: '2026-09-01T00:00:00.000Z',
    authority: 'human',
    approvedByUserId: APPROVER,
    approvedAt: '2026-09-01T00:00:00.000Z',
    asOf: '2026-09-01T00:00:00.000Z',
    conflictStatus: 'none',
    sensitivity: 'normal',
    instructionsAllowed: false,
  };
  const FIRM_ROW = {
    ...approved,
    id: '55555555-5555-4555-8555-555555555555',
    type: 'firm-soul',
    slug: 'firm',
    title: 'Firm Soul',
    clientId: null,
    ownerUserId: null,
    visibility: 'tenant',
    memoryClass: 'institutional_authoritative',
    governedAuthority: 'firm_approved',
    sourceType: 'firm_playbook',
    sourceId: 'firm-src',
    sections: [{ owner: 'human', heading: 'Who', body: 'We are a GA firm.' }],
  };
  const WALLED_CLIENT_ROW = {
    ...approved,
    id: '66666666-6666-4666-8666-666666666666',
    type: 'client-compass',
    slug: CLIENT,
    title: 'Client Compass',
    clientId: CLIENT,
    ownerUserId: null,
    visibility: 'tenant',
    memoryClass: 'client_steering',
    governedAuthority: 'client_approved',
    sourceType: 'client_record',
    sourceId: 'client-src',
    sections: [{ owner: 'human', heading: 'Position', body: WALLED_TEXT }],
  };

  type WallLookup = { allowed: boolean } | 'throws';

  /**
   * `$queryRaw` deliberately returns the client row whatever the SQL asked for,
   * so these tests isolate the compiler's own wall filter: the row reaches the
   * governed-memory filter, and only the server-derived decision keeps it out.
   */
  function harness(wall: WallLookup) {
    const wallLookups: unknown[][] = [];
    const tx = {
      tenant: {
        findFirst: jest.fn(async () => ({
          settings: {
            clioFeatureFlags: {
              'meriv2.contextPacketV2': true,
              'meriv2.contextPacketV2.memo': true,
              'meriv2.contextPacketV2.research': true,
            },
          },
        })),
      },
      $queryRawUnsafe: jest.fn(async (...args: unknown[]) => {
        wallLookups.push(args);
        if (wall === 'throws') throw new Error('wall lookup unavailable');
        return [wall];
      }),
      $queryRaw: jest.fn(async () => [FIRM_ROW, WALLED_CLIENT_ROW]),
      $executeRaw: jest.fn(async () => 1),
      contextPacket: {
        create: jest.fn(async (args: unknown) => args),
        findFirst: jest.fn(async (args: { where: { id: string } }) => ({ id: args.where.id })),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (t: unknown) => unknown) => fn(tx)),
      withTenantUser: jest.fn(async (_t: string, _u: string, fn: (t: unknown) => unknown) =>
        fn(tx),
      ),
    } as unknown as PrismaService;
    const compiler = new ContextCompilerService(prisma);
    const packets = new ContextPacketV2Service(compiler, new ContextLayerService(), prisma);
    return { packets, wallLookups };
  }

  function resolvedToClient(): ContextRetrievalResult {
    return {
      resolution: {
        status: 'ready',
        stopReason: 'context_resolved_for_retrieval',
        securityScope: {
          tenantId: TENANT,
          actorUserId: ACTOR,
          authorizedClientIds: [CLIENT],
          authorizedMailboxConnectionIds: [],
          graphPartitions: [],
          allowExternalLookup: false,
        },
        subjectScope: { kind: 'client', source: 'explicit', clientIds: [CLIENT] },
        focusEntityRefs: [],
        canonicalEntityIds: [],
        uiContext: { clientId: CLIENT },
        retrievalAllowed: true,
      },
    } as unknown as ContextRetrievalResult;
  }

  /** The request shape the LegiWatch adapter sent before this fix. */
  function adapterRequest(over: Partial<ContextRequest> = {}): ContextRequest {
    return {
      tenantId: TENANT,
      effectiveTenantId: TENANT,
      userId: ACTOR,
      actorUserId: ACTOR,
      clientId: CLIENT,
      surface: 'memo',
      layers: ['firm-identity', 'firm-playbook', 'client-steering', 'client-people'],
      render: 'all',
      tokenBudget: 8_000,
      budgetUnit: 'tokens',
      persistence: 'required',
      contractVersion: 2,
      ref: { operationId: 'legiwatch.generate-report' },
      ...over,
    };
  }

  function renderedText(packet: unknown): string {
    return JSON.stringify((packet as { rendered?: unknown }).rendered ?? []);
  }

  const original = process.env.MERIV2_CONTEXT_PACKET_V2;
  beforeEach(() => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MERIV2_CONTEXT_PACKET_V2;
    else process.env.MERIV2_CONTEXT_PACKET_V2 = original;
  });

  it('a caller-supplied ethicalWallAllowed: true cannot admit a walled client to an actor without a grant', async () => {
    const { packets, wallLookups } = harness({ allowed: false });

    const packet = await packets.compile(
      adapterRequest({ ethicalWallAllowed: true }),
      resolvedToClient(),
    );

    expect(packet.version).toBe(2);
    if (packet.version !== 2) throw new Error('expected v2');
    expect(renderedText(packet)).not.toContain(WALLED_TEXT);
    expect(packet.items.map((item) => item.id)).not.toContain(WALLED_CLIENT_ROW.id);
    // Withheld without naming the row: authorization exclusions carry no identity.
    expect(packet.exclusions).toContainEqual({ layer: 'client-steering', reason: 'unauthorized' });
    // The decision came from the wall helper, keyed on the packet's own tenant,
    // client and actor (clientMemoryAllowed binds $1 tenant, $2 client, $3 user).
    expect(wallLookups.length).toBeGreaterThan(0);
    for (const lookup of wallLookups) {
      expect(String(lookup[0])).toContain('client_memory_access');
      expect(lookup.slice(1)).toEqual([TENANT, CLIENT, ACTOR]);
    }
  });

  it('a failed wall lookup releases no packet even when the caller claims the wall allows the client', async () => {
    const { packets } = harness('throws');

    // The flag pre-check fails closed to false; the steering read re-checks the
    // wall itself and propagates the failure, so nothing is compiled at all.
    await expect(
      packets.compile(adapterRequest({ ethicalWallAllowed: true }), resolvedToClient()),
    ).rejects.toThrow('wall lookup unavailable');
  });

  it('an actor who holds a grant receives the client memory without the caller asserting anything', async () => {
    const { packets } = harness({ allowed: true });

    const packet = await packets.compile(adapterRequest(), resolvedToClient());

    if (packet.version !== 2) throw new Error('expected v2');
    expect(renderedText(packet)).toContain(WALLED_TEXT);
    expect(packet.items.map((item) => item.id)).toContain(WALLED_CLIENT_ROW.id);
  });
});
