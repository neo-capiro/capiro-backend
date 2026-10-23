import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';

export type ConversationBinding =
  | { scopeKind: 'client'; clientId: string }
  | { scopeKind: 'general'; clientId: null };
export type BootstrapConversationInput = ConversationBinding & {
  schemaVersion: 1 | 2;
  requestId: string;
};

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Version 1 remains client-only. Null never implicitly creates a General chat. */
export function parseBootstrapConversationInput(value: unknown): BootstrapConversationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Invalid conversation bootstrap request');
  const body = value as Record<string, unknown>;
  const keys = body.schemaVersion === 1
    ? ['schemaVersion', 'requestId', 'clientId']
    : ['schemaVersion', 'requestId', 'scopeKind', 'clientId'];
  if ((body.schemaVersion !== 1 && body.schemaVersion !== 2) ||
      Object.keys(body).length !== keys.length || keys.some((key) => !Object.hasOwn(body, key)) ||
      typeof body.requestId !== 'string' || !UUID.test(body.requestId))
    throw new BadRequestException('Invalid conversation bootstrap request');
  const scopeKind = body.schemaVersion === 1 ? 'client' : body.scopeKind;
  if (scopeKind === 'general' && body.schemaVersion === 2 && body.clientId === null)
    return { schemaVersion: 2, requestId: body.requestId.toLowerCase(), scopeKind, clientId: null };
  if (scopeKind !== 'client' || typeof body.clientId !== 'string' || !UUID.test(body.clientId))
    throw new BadRequestException('Invalid conversation bootstrap scope');
  return { schemaVersion: body.schemaVersion, requestId: body.requestId.toLowerCase(),
    scopeKind, clientId: body.clientId.toLowerCase() };
}

function receipt(ctx: TenantContext, input: BootstrapConversationInput, conversationId: string) {
  return {
    schemaVersion: input.schemaVersion, requestId: input.requestId, conversationId,
    tenantId: ctx.tenantId, actorId: ctx.userId, clientId: input.clientId,
    ...(input.schemaVersion === 2 ? { scopeKind: input.scopeKind } : {}),
  };
}

async function currentClient(tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string | null) {
  if (clientId === null) return;
  const client = await tx.client.findFirst({
    where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' }, OR: [
      { memoryWall: false },
      { memoryAccessGrants: { some: { tenantId: ctx.tenantId, userId: ctx.userId } } },
    ] }, select: { id: true },
  });
  if (!client) throw new NotFoundException('Client not found');
}

/** A short-lived presentation hint; bootstrap always repeats the source check. */
export async function readBootstrapCapability(prisma: PrismaService, ctx: TenantContext, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new BadRequestException('Invalid conversation capability request');
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || body.schemaVersion !== 1 ||
      typeof body.clientId !== 'string' || !UUID.test(body.clientId))
    throw new BadRequestException('Invalid conversation capability request');
  const clientId = body.clientId.toLowerCase();
  await prisma.withTenant(ctx.tenantId, (tx) => currentClient(tx, ctx, clientId));
  const checkedAtMs = Date.now();
  return { schemaVersion: 1 as const, capability: 'conversation.bootstrap.v2' as const,
    tenantId: ctx.tenantId, actorId: ctx.userId, clientId,
    checkedAtMs, expiresAtMs: checkedAtMs + 30_000 };
}

async function replay(prisma: PrismaService, ctx: TenantContext, input: BootstrapConversationInput) {
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    const saved = await tx.clioConversationBootstrapReceipt.findFirst({
      where: { tenantId: ctx.tenantId, actorUserId: ctx.userId, requestId: input.requestId },
      select: { clientId: true, scopeKind: true, conversationId: true },
    });
    if (!saved) return null;
    if (saved.clientId !== input.clientId || saved.scopeKind !== input.scopeKind)
      throw new ConflictException('New Chat requestId is bound to a different scope');
    if (!saved.conversationId)
      throw new ConflictException('New Chat conversation is no longer available');
    const conversation = await tx.clioConversation.findFirst({
      where: { id: saved.conversationId, tenantId: ctx.tenantId, userId: ctx.userId,
        clientId: input.clientId, status: 'active', archivedAt: null }, select: { id: true },
    });
    if (!conversation) throw new ConflictException('New Chat conversation is no longer active in this scope');
    await currentClient(tx, ctx, input.clientId);
    return receipt(ctx, input, conversation.id);
  });
}

/** One transaction creates both native conversation and immutable request binding. */
export async function bootstrapConversation(
  prisma: PrismaService, ctx: TenantContext, raw: unknown,
  profile: () => Promise<{ email: string | null }>, metadata: { brand: string; runtime: string },
) {
  const input = parseBootstrapConversationInput(raw);
  const existing = await replay(prisma, ctx, input);
  if (existing) return existing;
  const actor = await profile();
  try {
    return await prisma.withTenant(ctx.tenantId, async (tx) => {
      await currentClient(tx, ctx, input.clientId);
      const conversation = await tx.clioConversation.create({
        data: { tenantId: ctx.tenantId, userId: ctx.userId, clientId: input.clientId,
          title: 'New Meri session', workspaceKey: 'workspace',
          metadata: { ...metadata, userEmail: actor.email } }, select: { id: true },
      });
      await tx.clioConversationBootstrapReceipt.create({ data: {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, requestId: input.requestId,
        scopeKind: input.scopeKind, clientId: input.clientId, conversationId: conversation.id,
      } });
      return receipt(ctx, input, conversation.id);
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const winner = await replay(prisma, ctx, input);
    if (winner) return winner;
    throw error;
  }
}
