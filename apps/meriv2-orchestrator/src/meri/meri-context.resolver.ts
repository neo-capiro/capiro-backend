import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { TenantRole } from '@capiro/shared';
import {
  renderedBody,
  type CompiledContextPacket,
  type MeriContext,
  type MeriContextPacketSummary,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import { OrchestratorContextCompilerService } from './context-compiler.service.js';
import type { OrchestratorTenantContext } from '../auth/tenant-context.js';

function packetSummary(
  packet: CompiledContextPacket,
  requestedSurface: 'ga-chat' | 'workspace-editor',
): MeriContextPacketSummary {
  const renderedById = new Map(packet.rendered.map((item) => [item.id, item]));
  // These three reasons mean the caller isn't authorized to know the item
  // exists at all, so they're withheld from the visible list and only ever
  // surfaced as an aggregate count — never by id/type (matches compiler.ts's
  // exclusionFor(), which already strips identity for the same three reasons).
  const identityWithheldReasons = new Set(['unauthorized', 'wrong-client', 'sensitivity-denied']);
  const unauthorized = packet.exclusions.filter((item) => identityWithheldReasons.has(item.reason));
  return {
    packetId: packet.packetId,
    compiledAt: packet.compiledAt,
    surface: requestedSurface,
    clientId: packet.clientId,
    items: packet.items.map((item) => {
      const rendered = renderedById.get(item.id);
      const scope =
        item.layer === 'user-voice'
          ? 'personal'
          : item.layer.startsWith('client-')
            ? 'client'
            : 'firm';
      return {
        id: item.id,
        label: rendered?.title || item.type,
        type: item.type,
        scope,
        authority: 'human-authored',
        userScoped: scope === 'personal',
        rationale: 'rationale' in item ? item.rationale : item.inclusionReason,
        selection: 'automatic',
      };
    }),
    exclusions: packet.exclusions
      .filter((item) => !identityWithheldReasons.has(item.reason))
      .map((item) => ({
        id: item.id,
        label: item.type,
        type: item.type,
        reason: item.reason,
      })),
    unauthorizedCount: unauthorized.length,
    // v1 packets have no health concept to be degraded in; v2 packets must
    // actually report their compiled health rather than claim success blindly.
    degraded: packet.version === 2 ? packet.health.status !== 'healthy' : false,
  };
}

@Injectable()
export class MeriContextResolver {
  private readonly logger = new Logger(MeriContextResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contextCompiler: OrchestratorContextCompilerService,
  ) {}

  async resolve(
    tenant: OrchestratorTenantContext,
    clientId?: string | null,
    surface: 'ga-chat' | 'workspace-editor' = 'ga-chat',
    ref: Record<string, string | null | undefined> = {},
  ): Promise<MeriContext> {
    const user = await this.prisma.user.findUnique({
      where: { clerkUserId: tenant.clerkUserId },
      select: { id: true },
    });
    if (!user) {
      throw new UnauthorizedException('No Capiro user for the authenticated identity');
    }

    let firmMemory: MeriContext['firmMemory'] | undefined;
    let userVoice: string | undefined;
    let clientSteering: MeriContext['clientSteering'] | undefined;
    let contextPacket: MeriContextPacketSummary | undefined;
    try {
      const layers = clientId
        ? (['firm-identity', 'user-voice', 'client-steering', 'client-people'] as const)
        : (['firm-identity', 'user-voice'] as const);
      const packet = await this.contextCompiler.compile({
        tenantId: tenant.tenantId,
        userId: user.id,
        surface: surface as never,
        layers: [...layers],
        ref,
        ...(clientId ? { clientId } : {}),
      });
      contextPacket = packetSummary(packet, surface);
      const soul = renderedBody(packet, 'firm-soul');
      const compass = renderedBody(packet, 'firm-compass');
      firmMemory =
        soul || compass
          ? { ...(soul ? { soul } : {}), ...(compass ? { compass } : {}) }
          : undefined;
      userVoice = renderedBody(packet, 'user-voice') || undefined;
      if (clientId) {
        const clientSoul = renderedBody(packet, 'client-soul');
        const clientCompass = renderedBody(packet, 'client-compass');
        const clientPeople = renderedBody(packet, 'client-people');
        clientSteering =
          clientSoul || clientCompass || clientPeople
            ? {
                ...(clientSoul ? { soul: clientSoul } : {}),
                ...(clientCompass ? { compass: clientCompass } : {}),
                ...(clientPeople ? { people: clientPeople } : {}),
              }
            : undefined;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Context compilation failed';
      this.logger.warn(`context compile failed (non-fatal): ${reason}`);
      contextPacket = {
        surface,
        clientId: clientId ?? null,
        items: [],
        exclusions: [],
        unauthorizedCount: 0,
        degraded: true,
        degradedReason: 'Required firm or client context could not be loaded.',
      };
    }

    let clientRoster: MeriContext['clientRoster'] | undefined;
    try {
      const rows = await this.prisma.withTenant(tenant.tenantId, (tx) =>
        tx.client.findMany({
          where: { tenantId: tenant.tenantId },
          select: { name: true, status: true },
          orderBy: { name: 'asc' },
          take: 500,
        }),
      );
      if (rows.length) clientRoster = rows.map((row) => ({ name: row.name, status: row.status }));
    } catch (error) {
      this.logger.warn(
        `client roster load failed (non-fatal): ${error instanceof Error ? error.message : error}`,
      );
    }

    return {
      tenantId: tenant.tenantId,
      userId: user.id,
      clerkUserId: tenant.clerkUserId,
      role: mapRole(tenant.role),
      ...(firmMemory ? { firmMemory } : {}),
      ...(userVoice ? { userVoice } : {}),
      ...(clientRoster ? { clientRoster } : {}),
      ...(clientSteering ? { clientSteering } : {}),
      ...(contextPacket ? { contextPacket } : {}),
    };
  }
}

function mapRole(role: string | null): TenantRole {
  if (role && /admin/i.test(role)) return 'user_admin';
  return 'standard_user';
}
