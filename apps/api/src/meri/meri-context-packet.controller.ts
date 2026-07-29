import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { contextPacketView } from './meri-context-packet-view.js';

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
    return this.latest(ctx, 'ga-chat', 'conversationId', conversationId);
  }

  @Get('document/:id/latest')
  latestForDocument(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') documentId: string,
  ) {
    // Workspace ids are service-owned strings in some legacy rows, so do not
    // force UUID parsing here. Ownership is still enforced by the packet's user.
    const bounded = documentId.trim().slice(0, 200);
    if (!bounded) throw new NotFoundException('Document context packet not found');
    return this.latest(ctx, 'workspace-editor', 'documentId', bounded);
  }

  private async latest(
    ctx: TenantContext,
    surface: 'ga-chat' | 'workspace-editor',
    refKey: 'conversationId' | 'documentId',
    refValue: string,
  ) {
    const rows = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.contextPacket.findMany({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          surface,
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          surface: true,
          clientId: true,
          ref: true,
          items: true,
          exclusions: true,
          createdAt: true,
        },
      }),
    );
    const row = rows.find((candidate) => {
      const ref = candidate.ref;
      return Boolean(
        ref &&
          typeof ref === 'object' &&
          !Array.isArray(ref) &&
          (ref as Record<string, unknown>)[refKey] === refValue,
      );
    });
    if (!row) {
      return {
        surface,
        items: [],
        exclusions: [],
        unauthorizedCount: 0,
        degraded: true,
        degradedReason: 'The context packet for this record is unavailable.',
      };
    }
    return contextPacketView(row);
  }
}
