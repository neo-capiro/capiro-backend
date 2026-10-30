import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { canonicalWorkspaceSnapshot, WorkspaceRevisionUnavailable } from '@capiro/shared';
import {
  WORKSPACE_PROSPECT_GENERATION, parseWorkspaceProspectGenerationSource,
  workspaceGenerationConversationId, workspaceProspectGenerationSourceWithinTx,
} from '@capiro/shared/workspace-prospect-generation-source';

/** The same Core conversation/receipt owner registers the native leaf's derived
 * identity. Current source authority is checked before creation and every replay;
 * deleting the conversation leaves the existing bootstrap tombstone in force. */
export async function bootstrapWorkspaceGenerationConversation(
  prisma: PrismaService, ctx: TenantContext, raw: unknown,
  metadata: { brand: string; runtime: string },
) {
  let source;
  try { source = parseWorkspaceProspectGenerationSource(raw); }
  catch { throw new BadRequestException('Invalid Workspace generation source'); }
  const conversationId = workspaceGenerationConversationId(source.requestId);
  const run = () => prisma.withTenant(ctx.tenantId, async tx => {
    try {
      await workspaceProspectGenerationSourceWithinTx(tx, ctx.tenantId, { userId: ctx.userId }, source, { edit: true });
    } catch (error) {
      if (error instanceof WorkspaceRevisionUnavailable) throw new NotFoundException('Workspace source not found');
      throw error;
    }
    const saved = await tx.clioConversationBootstrapReceipt.findFirst({ where: {
      tenantId: ctx.tenantId, actorUserId: ctx.userId, requestId: conversationId,
    } });
    if (saved) {
      if (saved.conversationId !== conversationId || saved.clientId !== null || saved.scopeKind !== 'general')
        throw new ConflictException('Workspace generation request is no longer available');
      const row = await tx.clioConversation.findFirst({ where: {
        id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId,
        clientId: null, status: 'active', archivedAt: null,
      } });
      if (!row || canonicalWorkspaceSnapshot((row.metadata as Record<string, unknown>)[WORKSPACE_PROSPECT_GENERATION] ?? null) !== canonicalWorkspaceSnapshot(source))
        throw new ConflictException('Workspace generation source changed');
    } else {
      await tx.clioConversation.create({ data: {
        id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId, clientId: null,
        title: 'Prospect draft generation', workspaceKey: 'workspace',
        metadata: { ...metadata, [WORKSPACE_PROSPECT_GENERATION]: { ...source } },
      } });
      await tx.clioConversationBootstrapReceipt.create({ data: {
        tenantId: ctx.tenantId, actorUserId: ctx.userId, requestId: conversationId,
        scopeKind: 'general', clientId: null, conversationId,
      } });
    }
    return { schemaVersion: 1 as const, tenantId: ctx.tenantId, actorId: ctx.userId, conversationId, source };
  });
  try { return await run(); }
  catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    return run();
  }
}

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

async function replay(prisma: PrismaService, ctx: TenantContext, input: BootstrapConversationInput,
  purpose?: 'outreach_generation') {
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
        clientId: input.clientId, status: 'active', archivedAt: null }, select: { id: true, metadata: true },
    });
    if (!conversation) throw new ConflictException('New Chat conversation is no longer active in this scope');
    const savedPurpose = conversation.metadata && typeof conversation.metadata === 'object' &&
      !Array.isArray(conversation.metadata) ? conversation.metadata.purpose ?? undefined : undefined;
    if (savedPurpose !== purpose)
      throw new ConflictException('New Chat requestId is bound to a different purpose');
    await currentClient(tx, ctx, input.clientId);
    return receipt(ctx, input, conversation.id);
  });
}

/** One transaction creates both native conversation and immutable request binding. */
export async function bootstrapConversation(
  prisma: PrismaService, ctx: TenantContext, raw: unknown,
  profile: () => Promise<{ email: string | null }>, metadata: { brand: string; runtime: string; purpose?: 'outreach_generation' },
) {
  const input = parseBootstrapConversationInput(raw);
  const existing = await replay(prisma, ctx, input, metadata.purpose);
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
    const winner = await replay(prisma, ctx, input, metadata.purpose);
    if (winner) return winner;
    throw error;
  }
}

/** Internal operation sessions do not belong to ordinary Meri history or editors. */
export function isOutreachGenerationConversation(conversation: { metadata: unknown }): boolean {
  const metadata = conversation.metadata;
  return !!metadata && typeof metadata === 'object' && !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).purpose === 'outreach_generation';
}
