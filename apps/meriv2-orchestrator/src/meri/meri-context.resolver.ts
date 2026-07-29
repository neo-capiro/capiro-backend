import { randomUUID } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { TenantRole } from '@capiro/shared';
import {
  contextPacketV2Overrides,
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
        // A v2 item knows its real governed authority and whether the user picked
        // it. Hardcoding 'human-authored'/'automatic' over a v2 packet would print
        // "Authority · human-authored" above a model_inferred item. v1 items have
        // no provenance to report, so they keep the legacy label.
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
    // v1 packets have no health concept to be degraded in; v2 packets must
    // actually report their compiled health rather than claim success blindly.
    degraded: packet.version === 2 ? packet.health.status !== 'healthy' : false,
    ...(packet.version === 2 && packet.health.reasons.length
      ? { degradedReason: packet.health.reasons.join('; ') }
      : {}),
  };
}

@Injectable()
export class MeriContextResolver {
  private readonly logger = new Logger(MeriContextResolver.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contextCompiler: OrchestratorContextCompilerService,
  ) {}

  /**
   * @param surface the surface asking for context. It is written verbatim to
   *   `context_packet.surface`, so passing the wrong one mislabels the trace. It
   *   used to be typed as only `'ga-chat' | 'workspace-editor'`, which meant
   *   Strategy and Steward silently fell through to the `'ga-chat'` default and
   *   their rows both mis-attributed themselves and competed with real chat
   *   packets in the chat Context Inspector's lookup.
   */
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
      // Server-derived ethical-wall decision for the v2 compile (closeout §6),
      // resolved from the database for the REAL authenticated user — never from
      // anything the caller sent. Only consumed when v2 is armed for this
      // surface; contextPacketV2Overrides drops it entirely otherwise.
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
        // ContextPacket v2, dark by default: `contextPacketV2Overrides` returns {}
        // unless CONTEXT_PACKET_V2=enforce arms this surface, so the compiled
        // request is byte-for-byte the pre-v2 one until it is.
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

  /**
   * Server-derived ethical-wall decision: may `userId` be shown `clientId`'s
   * confidential memory? (closeout §6, contract change 4.)
   *
   * Fail-closed on every uncertain input — no client, a client id that does not
   * resolve inside this tenant, or a query error all return `false`. `compileV2`
   * admits client-scope rows only on a literal `true`, so a wrong answer here is
   * the difference between withholding context and rendering a walled client's
   * material into the model prompt.
   *
   * Duplicated in SHAPE, not by import, from the canonical `clientMemoryAllowed`
   * in apps/api/src/memory/memory-wall.helpers.ts: this is a separate Nest app
   * that cannot import apps/api, but it reads the SAME physical tables
   * (`clients.memory_wall`, `client_memory_access`) through the same generated
   * Prisma client. The api-side helper is authoritative if they ever diverge.
   */
  private async resolveEthicalWallAllowed(
    tenantId: string,
    userId: string,
    clientId: string | null,
  ): Promise<boolean> {
    if (!clientId) return false;
    try {
      const rows = await this.prisma.withTenant(tenantId, (tx) =>
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
      // No row = the client does not resolve in this tenant: deny.
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
