import { randomUUID } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { TenantRole } from '@capiro/shared';
import {
  contextPacketV2Overrides,
  contextSurfacePolicy,
  durableContextPacketId,
  isContextPacketPersistenceError,
  renderedBody,
  type CompiledContextPacket,
  type ContextSurface,
  type MeriContext,
  type MeriContextPacketSummary,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import { OrchestratorContextCompilerService } from './context-compiler.service.js';
import type { OrchestratorTenantContext } from '../auth/tenant-context.js';

function packetSummary(
  packet: CompiledContextPacket,
  requestedSurface: ContextSurface,
): MeriContextPacketSummary {
  const renderedById = new Map(packet.rendered.map((item) => [item.id, item]));
  const identityWithheldReasons = new Set(['unauthorized', 'wrong-client', 'sensitivity-denied']);
  const unauthorized = packet.exclusions.filter((item) => identityWithheldReasons.has(item.reason));
  const persistenceFailed = packet.persisted !== true;
  const healthReasons = packet.version === 2 ? packet.health.reasons : [];
  const degradedReasons = [
    ...healthReasons,
    ...(persistenceFailed
      ? [`Context packet persistence unavailable (${packet.persistenceErrorCode ?? 'unknown'})`]
      : []),
  ];
  return {
    packetId: durableContextPacketId(packet),
    persisted: packet.persisted,
    persistenceErrorCode: packet.persistenceErrorCode ?? null,
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
        authority: 'authority' in item ? item.authority : 'human-authored',
        userScoped: scope === 'personal',
        rationale: 'rationale' in item ? item.rationale : item.inclusionReason,
        selection:
          'selectionTier' in item && item.selectionTier === 'explicit' ? 'explicit' : 'automatic',
        ...('asOf' in item && item.asOf ? { asOf: item.asOf } : {}),
        ...('lastConfirmedAt' in item && item.lastConfirmedAt
          ? { lastConfirmedAt: item.lastConfirmedAt }
          : {}),
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
    degraded:
      persistenceFailed || (packet.version === 2 ? packet.health.status !== 'healthy' : false),
    ...(degradedReasons.length ? { degradedReason: degradedReasons.join('; ') } : {}),
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
    surface: ContextSurface = 'ga-chat',
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
      const ethicalWallAllowed = await this.resolveEthicalWallAllowed(
        tenant.tenantId,
        user.id,
        clientId ?? null,
      );
      const packet = await this.contextCompiler.compile({
        tenantId: tenant.tenantId,
        userId: user.id,
        surface,
        layers: [...layers],
        ref,
        ...(clientId ? { clientId } : {}),
        ...contextPacketV2Overrides(process.env.CONTEXT_PACKET_V2, {
          surface,
          traceId: randomUUID(),
          ethicalWallAllowed,
        }),
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
      if (isContextPacketPersistenceError(error) && contextSurfacePolicy(surface).externalDeliverable) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : 'Context compilation failed';
      this.logger.warn(`context compile failed (non-fatal): ${reason}`);
      contextPacket = {
        packetId: null,
        persisted: false,
        persistenceErrorCode: isContextPacketPersistenceError(error) ? error.code : null,
        surface,
        clientId: clientId ?? null,
        items: [],
        exclusions: [],
        unauthorizedCount: 0,
        degraded: true,
        degradedReason: isContextPacketPersistenceError(error)
          ? 'Context was compiled, but its durable provenance trace could not be saved.'
          : 'Required firm or client context could not be loaded.',
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

  private async resolveEthicalWallAllowed(
    tenantId: string,
    userId: string,
    clientId: string | null,
  ): Promise<boolean> {
    if (!clientId) return false;
    try {
      const rows = await this.prisma.withTenant(
        tenantId,
        (tx) =>
          tx.$queryRaw<Array<{ allowed: boolean }>>`
          SELECT (NOT c.memory_wall
                  OR EXISTS (
                        SELECT 1 FROM client_memory_access a
                        WHERE a.tenant_id = c.tenant_id
                          AND a.client_id = c.id
                          AND a.user_id = ${userId}::uuid)) AS allowed
            FROM clients c
           WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ${clientId}::uuid
        `,
      );
      return rows[0]?.allowed === true;
    } catch (error) {
      this.logger.warn(
        `Ethical-wall resolution failed; denying client context: ${(error as Error).message}`,
      );
      return false;
    }
  }
}

function mapRole(role: string | null): TenantRole {
  if (role && /admin/i.test(role)) return 'user_admin';
  return 'standard_user';
}
