import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriContextPacketController } from './meri-context-packet.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const CANARY_SETTINGS = {
  clioFeatureFlags: {
    'meriv2.contextPacketV2': true,
    'meriv2.contextPacketV2.ga-chat': true,
    'meriv2.contextPacketV2.chat': true,
    'meriv2.contextPacketV2.workspace-editor': true,
    'meriv2.contextPacketV2.in-editor': true,
  },
};

describe('MeriContextPacketController', () => {
  const ctx = { tenantId: 't1', userId: 'u1' } as TenantContext;
  const ROW = {
    id: '11111111-1111-4111-8111-111111111111',
    surface: 'chat',
    packetVersion: 1,
    clientId: null,
    ref: { conversationId: 'c1' },
    items: [],
    exclusions: [],
    createdAt: new Date('2026-07-29T12:00:00.000Z'),
  };

  function makePrisma(
    row: unknown = ROW,
    options: { settings?: unknown; conversation?: unknown } = {},
  ) {
    const calls: Array<Record<string, unknown>> = [];
    const tx = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue({ settings: options.settings ?? CANARY_SETTINGS }),
      },
      clioConversation: {
        findFirst: jest.fn().mockResolvedValue(options.conversation === undefined ? { id: 'c1' } : options.conversation),
      },
      client: { findFirst: jest.fn().mockResolvedValue({ name: 'Acme Corp' }) },
      contextPacket: {
        findFirst: jest.fn(async (args: Record<string, unknown>) => {
          calls.push(args);
          return row;
        }),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, fn: (value: typeof tx) => unknown) => fn(tx)),
      withTenantUser: jest.fn(
        async (_tenantId: string, _userId: string, fn: (value: typeof tx) => unknown) => fn(tx),
      ),
    } as unknown as PrismaService;
    return { prisma, tx, calls };
  }

  const originalNewEnv = process.env.MERIV2_CONTEXT_PACKET_V2;
  const originalLegacyEnv = process.env.CONTEXT_PACKET_V2;
  beforeEach(() => {
    delete process.env.MERIV2_CONTEXT_PACKET_V2;
    delete process.env.CONTEXT_PACKET_V2;
  });
  afterEach(() => {
    if (originalNewEnv === undefined) delete process.env.MERIV2_CONTEXT_PACKET_V2;
    else process.env.MERIV2_CONTEXT_PACKET_V2 = originalNewEnv;
    if (originalLegacyEnv === undefined) delete process.env.CONTEXT_PACKET_V2;
    else process.env.CONTEXT_PACKET_V2 = originalLegacyEnv;
  });

  it('accepts both chat aliases while selecting only the visible v1 packet when off', async () => {
    const { prisma, calls } = makePrisma();
    const view = await new MeriContextPacketController(prisma).latestForConversation(ctx, 'c1');
    expect(view.degraded).toBe(false);
    expect(view.persisted).toBe(true);
    expect(view.packetId).toBe(ROW.id);
    const where = calls[0]!.where as Record<string, unknown>;
    expect(where.OR).toEqual([
      { surface: 'ga-chat', packetVersion: 1 },
      { surface: 'chat', packetVersion: 1 },
    ]);
  });

  it('accepts both in-editor aliases and selects their visible v1 packets when off', async () => {
    const { prisma, calls } = makePrisma({
      ...ROW,
      surface: 'in-editor',
      ref: { documentId: 'd1' },
    });
    await new MeriContextPacketController(prisma).latestForDocument(ctx, 'd1');
    const where = calls[0]!.where as Record<string, unknown>;
    expect(where.OR).toEqual([
      { surface: 'workspace-editor', packetVersion: 1 },
      { surface: 'in-editor', packetVersion: 1 },
    ]);
  });

  it('matches on the ref key itself rather than scanning a recent window', async () => {
    const { prisma, calls } = makePrisma();
    await new MeriContextPacketController(prisma).latestForConversation(ctx, 'c1');
    const args = calls[0]!;
    expect((args.where as Record<string, unknown>).ref).toEqual({
      path: ['conversationId'],
      equals: 'c1',
    });
    expect(args).not.toHaveProperty('take');
  });

  it('reloads the exact displayed packet id under tenant and user scope', async () => {
    const { prisma, calls } = makePrisma();
    const view = await new MeriContextPacketController(prisma).getById(ctx, ROW.id);
    expect(view).toEqual(expect.objectContaining({ packetId: ROW.id, persisted: true }));
    expect(calls[0]!.where).toEqual({ id: ROW.id, tenantId: 't1', userId: 'u1' });
    expect(calls[1]!.where).toEqual({ id: ROW.id, tenantId: 't1', userId: 'u1' });
  });

  it('404s an exact packet id that is not durably retrievable', async () => {
    const { prisma } = makePrisma(null);
    await expect(new MeriContextPacketController(prisma).getById(ctx, ROW.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('selects no migration-added v2 metadata while the global ceiling is off', async () => {
    process.env.CONTEXT_PACKET_V2 = 'enforce';
    const { prisma, calls } = makePrisma();
    await new MeriContextPacketController(prisma).latestForConversation(ctx, 'c1');
    const select = calls[0]!.select as Record<string, unknown>;
    for (const column of [
      'health',
      'traceId',
      'requiredLayers',
      'usedTokens',
      'totalTokenBudget',
      'truncated',
      'incomplete',
    ]) {
      expect(select).not.toHaveProperty(column);
    }
  });

  it('shadow keeps the v1 packet visible and does not expose shadow metadata', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'shadow';
    const { prisma, calls } = makePrisma();
    await new MeriContextPacketController(prisma).latestForConversation(ctx, 'c1');
    const where = calls[0]!.where as Record<string, unknown>;
    expect(where.OR).toEqual([
      { surface: 'ga-chat', packetVersion: 1 },
      { surface: 'chat', packetVersion: 1 },
    ]);
    const select = calls[0]!.select as Record<string, unknown>;
    expect(select).not.toHaveProperty('health');
    expect(select).not.toHaveProperty('traceId');
  });

  it('enforce selects only visible v2 packets and their trace metadata', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    const { prisma, calls } = makePrisma({
      ...ROW,
      packetVersion: 2,
      health: { status: 'healthy', reasons: [] },
    });
    await new MeriContextPacketController(prisma).latestForConversation(ctx, 'c1');
    const where = calls[0]!.where as Record<string, unknown>;
    expect(where.OR).toEqual([
      { surface: 'ga-chat', packetVersion: 2 },
      { surface: 'chat', packetVersion: 2 },
    ]);
    const select = calls[0]!.select as Record<string, unknown>;
    expect(select.packetVersion).toBe(true);
    expect(select.health).toBe(true);
    expect(select.traceId).toBe(true);
  });

  it('rejects exact reload of a shadow-only v2 packet', async () => {
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'shadow';
    const { prisma, calls } = makePrisma({ ...ROW, packetVersion: 2 });
    await expect(new MeriContextPacketController(prisma).getById(ctx, ROW.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(calls).toHaveLength(1);
  });

  it('honestly reports an unavailable visible packet with no fabricated id', async () => {
    const { prisma } = makePrisma(null);
    const view = await new MeriContextPacketController(prisma).latestForConversation(ctx, 'c1');
    expect(view).toEqual(
      expect.objectContaining({
        packetId: null,
        persisted: false,
        degraded: true,
        items: [],
        unauthorizedCount: 0,
      }),
    );
  });

  it('404s a conversation the caller does not own before touching any packet', async () => {
    const { prisma, tx } = makePrisma(ROW, { conversation: null });
    await expect(
      new MeriContextPacketController(prisma).latestForConversation(ctx, 'c1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.contextPacket.findFirst).not.toHaveBeenCalled();
  });

  it('resolves the client display name for a client-scoped packet', async () => {
    const { prisma } = makePrisma({
      ...ROW,
      clientId: 'client-1',
      items: [{ layer: 'client-steering', id: 'mi-1', type: 'client-compass', scope: 'client' }],
    });
    const view = await new MeriContextPacketController(prisma).latestForConversation(ctx, 'c1');
    expect(view.items?.[0]).toEqual(expect.objectContaining({ clientName: 'Acme Corp' }));
  });
});
