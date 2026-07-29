import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { resolveContextPacketMode } from '@capiro/meriv2-core';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { contextPacketView } from './meri-context-packet-view.js';

/**
 * Surfaces that answer the "what context steered this conversation?" question.
 *
 * `ga-chat` is what the MeriV2 orchestrator writes; `chat` is what the in-process
 * legacy path writes. Only tenants on `meriv2.fullChat` take the first, so keying
 * the lookup on `ga-chat` alone meant every other tenant got `degraded: true` and a
 * "Context degraded" banner on every answer — while the context had in fact been
 * compiled and used.
 */
const CONVERSATION_SURFACES = ['ga-chat', 'chat'] as const;

/**
 * Two labels for the SAME in-editor surface: apps/api's own route writes
 * `in-editor`, the orchestrator's writes `workspace-editor`. Both are accepted so
 * this endpoint works whichever path served the turn.
 */
const DOCUMENT_SURFACES = ['workspace-editor', 'in-editor'] as const;

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
    // Workspace ids are service-owned strings in some legacy rows, so do not
    // force UUID parsing here. Ownership is still enforced by the packet's user.
    const bounded = documentId.trim().slice(0, 200);
    if (!bounded) throw new NotFoundException('Document context packet not found');
    return this.latest(ctx, DOCUMENT_SURFACES, 'documentId', bounded);
  }

  private async latest(
    ctx: TenantContext,
    surfaces: readonly string[],
    refKey: 'conversationId' | 'documentId',
    refValue: string,
  ) {
    // ContextPacket v2 columns (`packet_version`, `health_jsonb`, …) are added by
    // 20260729010000_memory_governance_context_v2. Selecting them before that
    // migration is applied would fail the whole request with 42703, so the v2
    // projection rides the SAME dark switch that produces v2 packets in the first
    // place. Dark ⇒ this endpoint returns exactly what it returned before.
    const v2 = resolveContextPacketMode(process.env.CONTEXT_PACKET_V2) === 'v2';
    const row = await this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.contextPacket.findFirst({
        where: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          surface: { in: [...surfaces] },
          // Match on the ref key itself instead of scanning a fixed window of
          // recent rows: a run of packets from another conversation (or from a
          // mislabelled surface) could otherwise push the real one out of view.
          ref: { path: [refKey], equals: refValue },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          surface: true,
          clientId: true,
          ref: true,
          items: true,
          exclusions: true,
          createdAt: true,
          ...(v2
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
        },
      }),
    );
    if (!row) {
      return {
        surface: surfaces[0],
        items: [],
        exclusions: [],
        unauthorizedCount: 0,
        degraded: true,
        degradedReason: 'The context packet for this record is unavailable.',
      };
    }
    // The client's display name is what `ContextInspector` renders as
    // "Client · Acme"; the packet itself only stores the id.
    const clientName = row.clientId
      ? await this.prisma
          .withTenant(ctx.tenantId, (tx) =>
            tx.client.findFirst({
              where: { id: row.clientId as string, tenantId: ctx.tenantId },
              select: { name: true },
            }),
          )
          .then((client) => client?.name ?? null)
          .catch(() => null)
      : null;
    return contextPacketView(row, clientName);
  }
}
