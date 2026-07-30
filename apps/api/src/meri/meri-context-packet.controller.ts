import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  MERIV2_CONTEXT_PACKET_V2_ENV,
  resolveContextPacketMode,
  resolveTenantContextPacketMode,
  type ContextPacketMode,
  type ContextSurface,
} from '@capiro/meriv2-core';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { contextPacketView } from './meri-context-packet-view.js';

const CONVERSATION_SURFACES = ['ga-chat', 'chat'] as const satisfies readonly ContextSurface[];
const DOCUMENT_SURFACES = ['workspace-editor', 'in-editor'] as const satisfies readonly ContextSurface[];

@Controller('clio/context-packets')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MeriContextPacketController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('conversation/:id/latest')
  async latestForConversation(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', new ParseUUIDPipe()) conversationId: string,
  ) {
    const conversation = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.findFirst({
        where: {
          id: conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
        },
        select: { id: true },
      }),
    );
    if (!conversation) throw new NotFoundException('Meri conversation not found');
    return this.latest(ctx, CONVERSATION_SURFACES, 'conversationId', conversationId);
  }

  @Get('document/:id/latest')
  latestForDocument(@CurrentTenant() ctx: TenantContext, @Param('id') documentId: string) {
    const bounded = documentId.trim().slice(0, 200);
    if (!bounded) throw new NotFoundException('Document context packet not found');
    return this.latest(ctx, DOCUMENT_SURFACES, 'documentId', bounded);
  }

  /** Exact reload for the durable ID displayed by Context Inspector. */
  @Get(':id')
  async getById(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', new ParseUUIDPipe()) packetId: string,
  ) {
    const identity = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.contextPacket.findFirst({
        where: { id: packetId, tenantId: ctx.tenantId, userId: ctx.userId },
        select: { id: true, surface: true, packetVersion: true },
      }),
    );
    if (!identity || !isContextSurface(identity.surface)) {
      throw new NotFoundException('Context packet not found');
    }

    const mode = await this.rolloutMode(ctx.tenantId, identity.surface);
    if (identity.packetVersion !== visiblePacketVersion(mode)) {
      throw new NotFoundException('Context packet not found');
    }

    const row = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.contextPacket.findFirst({
        where: { id: packetId, tenantId: ctx.tenantId, userId: ctx.userId },
        select: this.packetSelect(mode === 'enforce'),
      }),
    );
    if (!row) throw new NotFoundException('Context packet not found');
    return contextPacketView(row, await this.clientName(ctx, row.clientId));
  }

  private async latest(
    ctx: TenantContext,
    surfaces: readonly ContextSurface[],
    refKey: 'conversationId' | 'documentId',
    refValue: string,
  ) {
    const modes = await Promise.all(
      surfaces.map(async (surface) => [surface, await this.rolloutMode(ctx.tenantId, surface)] as const),
    );
    const includeV2Columns = modes.some(([, mode]) => mode === 'enforce');
    const row = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.contextPacket.findFirst({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          OR: modes.map(([surface, mode]) => ({
            surface,
            packetVersion: visiblePacketVersion(mode),
          })),
          ref: { path: [refKey], equals: refValue },
        },
        orderBy: { createdAt: 'desc' },
        select: this.packetSelect(includeV2Columns),
      }),
    );
    if (!row) {
      return {
        packetId: null,
        persisted: false,
        persistenceErrorCode: 'context_packet_unavailable',
        surface: surfaces[0],
        items: [],
        exclusions: [],
        unauthorizedCount: 0,
        degraded: true,
        degradedReason: 'The context packet for this record is unavailable.',
      };
    }
    return contextPacketView(row, await this.clientName(ctx, row.clientId));
  }

  private async rolloutMode(tenantId: string, surface: ContextSurface): Promise<ContextPacketMode> {
    const globalMode = resolveContextPacketMode(process.env[MERIV2_CONTEXT_PACKET_V2_ENV]);
    if (globalMode === 'off') return 'off';
    try {
      const tenant = await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenant.findFirst({ where: { id: tenantId }, select: { settings: true } }),
      );
      return resolveTenantContextPacketMode(
        process.env[MERIV2_CONTEXT_PACKET_V2_ENV],
        tenant?.settings,
        surface,
      );
    } catch {
      return 'off';
    }
  }

  private packetSelect(includeV2Columns: boolean) {
    return {
      id: true,
      surface: true,
      clientId: true,
      ref: true,
      items: true,
      exclusions: true,
      createdAt: true,
      ...(includeV2Columns
        ? {
            packetVersion: true,
            health: true,
            traceId: true,
            requiredLayers: true,
            usedTokens: true,
            totalTokenBudget: true,
            truncated: true,
            incomplete: true,
          }
        : {}),
    } as const;
  }

  private async clientName(ctx: TenantContext, clientId: string | null): Promise<string | null> {
    if (!clientId) return null;
    return this.prisma
      .withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: clientId, tenantId: ctx.tenantId },
          select: { name: true },
        }),
      )
      .then((client) => client?.name ?? null)
      .catch(() => null);
  }
}

function visiblePacketVersion(mode: ContextPacketMode): number {
  return mode === 'enforce' ? 2 : 1;
}

function isContextSurface(value: string): value is ContextSurface {
  return [
    'chat',
    'ga-chat',
    'tool-invoke',
    'in-editor',
    'workspace-editor',
    'strategy',
    'steward',
    'outreach',
    'memo',
    'district-brief',
    'research',
    'workspace-gen',
  ].includes(value);
}
