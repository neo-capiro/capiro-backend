import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriContextPacketController } from './meri-context-packet.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The Context Inspector endpoint.
 *
 * What this controller owns:
 *   1. which surfaces answer "what context steered this conversation?" — the
 *      legacy in-process chat path writes surface='chat', only meriv2.fullChat
 *      tenants write 'ga-chat', and keying on 'ga-chat' alone told every other
 *      tenant "Context degraded" on every answer;
 *   2. finding the packet BY REF rather than scanning a fixed recent window;
 *   3. keeping the v2 column projection behind the dark switch — those columns come
 *      from an unapplied migration, so selecting them early fails the request.
 */
describe('MeriContextPacketController', () => {
  const ctx = { tenantId: 't1', userId: 'u1' } as TenantContext;
  const ROW = {
    id: 'packet-1',
    surface: 'chat',
    clientId: null,
    ref: { conversationId: 'c1' },
    items: [],
    exclusions: [],
    createdAt: new Date('2026-07-29T12:00:00.000Z'),
  };

  function makePrisma(row: unknown = ROW) {
    const calls: Array<Record<string, unknown>> = [];
    const tx = {
      clioConversation: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) },
      client: { findFirst: jest.fn().mockResolvedValue({ name: 'Acme Corp' }) },
      contextPacket: {
        findFirst: jest.fn(async (args: Record<string, unknown>) => {
          calls.push(args);
          return row;
        }),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_t: string, fn: (t: unknown) => unknown) => fn(tx)),
      withTenantUser: jest.fn(async (_t: string, _u: string, fn: (t: unknown) => unknown) =>
        fn(tx),
      ),
    } as unknown as PrismaService;
    return { prisma, tx, calls };
  }

  const originalEnv = process.env.CONTEXT_PACKET_V2;
  beforeEach(() => {
    delete process.env.CONTEXT_PACKET_V2;
  });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CONTEXT_PACKET_V2;
    else process.env.CONTEXT_PACKET_V2 = originalEnv;
  });

  it('accepts BOTH chat surfaces, so the legacy path is no longer reported degraded', async () => {
    const { prisma, calls } = makePrisma();
    const controller = new MeriContextPacketController(prisma);
    const view = await controller.latestForConversation(ctx, 'c1');
    expect(view.degraded).toBe(false);
    const where = calls[0]!.where as Record<string, unknown>;
    expect(where.surface).toEqual({ in: ['ga-chat', 'chat'] });
  });

  it('accepts BOTH in-editor surface labels for a document', async () => {
    const { prisma, calls } = makePrisma({ ...ROW, surface: 'in-editor', ref: { documentId: 'd1' } });
    const controller = new MeriContextPacketController(prisma);
    await controller.latestForDocument(ctx, 'd1');
    const where = calls[0]!.where as Record<string, unknown>;
    expect(where.surface).toEqual({ in: ['workspace-editor', 'in-editor'] });
  });

  it('matches on the ref key itself rather than scanning a recent window', async () => {
    const { prisma, calls } = makePrisma();
    const controller = new MeriContextPacketController(prisma);
    await controller.latestForConversation(ctx, 'c1');
    const args = calls[0]!;
    expect((args.where as Record<string, unknown>).ref).toEqual({
      path: ['conversationId'],
      equals: 'c1',
    });
    expect(args).not.toHaveProperty('take');
  });

  it('selects NO v2 column while the switch is dark (they come from an unapplied migration)', async () => {
    const { prisma, calls } = makePrisma();
    const controller = new MeriContextPacketController(prisma);
    await controller.latestForConversation(ctx, 'c1');
    const select = calls[0]!.select as Record<string, unknown>;
    for (const column of [
      'packetVersion',
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

  it('selects the v2 columns only once CONTEXT_PACKET_V2=enforce', async () => {
    process.env.CONTEXT_PACKET_V2 = 'enforce';
    const { prisma, calls } = makePrisma();
    const controller = new MeriContextPacketController(prisma);
    await controller.latestForConversation(ctx, 'c1');
    const select = calls[0]!.select as Record<string, unknown>;
    expect(select.packetVersion).toBe(true);
    expect(select.health).toBe(true);
    expect(select.traceId).toBe(true);
  });

  it('honestly reports an unavailable packet instead of inventing an empty healthy one', async () => {
    const { prisma } = makePrisma(null);
    const controller = new MeriContextPacketController(prisma);
    const view = await controller.latestForConversation(ctx, 'c1');
    expect(view).toEqual(
      expect.objectContaining({ degraded: true, items: [], unauthorizedCount: 0 }),
    );
  });

  it('404s a conversation the caller does not own before touching any packet', async () => {
    const { prisma, tx } = makePrisma();
    (tx.clioConversation.findFirst as jest.Mock).mockResolvedValue(null);
    const controller = new MeriContextPacketController(prisma);
    await expect(controller.latestForConversation(ctx, 'c1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.contextPacket.findFirst).not.toHaveBeenCalled();
  });

  it('resolves the client display name for a client-scoped packet', async () => {
    const { prisma } = makePrisma({
      ...ROW,
      clientId: 'client-1',
      items: [{ layer: 'client-steering', id: 'mi-1', type: 'client-compass', scope: 'client' }],
    });
    const controller = new MeriContextPacketController(prisma);
    const view = await controller.latestForConversation(ctx, 'c1');
    expect(view.items?.[0]).toEqual(expect.objectContaining({ clientName: 'Acme Corp' }));
  });
});
