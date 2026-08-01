import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ContextPacketRolloutCompiler,
  GOVERNED_STEERING_COLUMNS_SQL,
  MERIV2_CONTEXT_PACKET_V2_ENV,
  emitMeriV2ControlMetrics,
  isContextPacketPersistenceError,
  resolveContextPacketMode,
  resolveTenantContextPacketMode,
  type CompiledContextPacket,
  type ContextPacketMode,
  type ContextPacketRolloutStoreAdapter,
  type ContextPacketShadowComparison,
  type ContextRequest,
  type SteeringLayer,
  type SteeringRow,
  type TruthfulCompiledContextPacket,
  typesForLayers,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import {
  governedRecallSuppressionEnabled,
  governedRecallSuppressionSql,
} from '../memory/memory-recall-suppression.helpers.js';
import { ContextPersistenceBoundaryService } from './context-persistence-boundary.service.js';

/** apps/api adapter and server-owned Phase 8 rollout resolver. */
@Injectable()
export class ContextCompilerService {
  private readonly logger = new Logger(ContextCompilerService.name);
  private readonly compiler: ContextPacketRolloutCompiler;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly persistenceBoundary?: ContextPersistenceBoundaryService,
  ) {
    const adapter: ContextPacketRolloutStoreAdapter = {
      loadSteeringRows: (req) => this.loadSteeringRows(req),
      loadGovernedSteeringRows: (req) => this.loadSteeringRows(req, { governed: true }),
      persistPacket: (packet) => this.persistPacket(packet),
      persistShadowComparison: (input) => this.persistShadowComparison(input),
    };
    this.compiler = new ContextPacketRolloutCompiler(adapter);
  }

  async compile(req: ContextRequest): Promise<CompiledContextPacket> {
    const mode = await this.modeFor(req.tenantId, req.surface);
    const ethicalWallAllowed = await this.ethicalWallAllowed(req);
    try {
      return await this.compiler.compile({ ...req, ethicalWallAllowed }, mode);
    } catch (error) {
      // Preserve the exact bounded persistence error even when a legacy caller
      // catches ordinary context failures and continues. The global boundary
      // interceptor checks this request-local record before releasing output.
      this.persistenceBoundary?.record(error);
      if (isContextPacketPersistenceError(error)) {
        emitMeriV2ControlMetrics({ ContextPacketPersistenceFailures: 1 });
      }
      throw error;
    }
  }

  /** Server-owned rollout resolution for adapters that must preserve off/shadow output. */
  modeFor(tenantId: string, surface: ContextRequest['surface']): Promise<ContextPacketMode> {
    return this.rolloutMode(tenantId, surface);
  }

  private async rolloutMode(
    tenantId: string,
    surface: ContextRequest['surface'],
  ): Promise<ContextPacketMode> {
    const ceiling = resolveContextPacketMode(process.env[MERIV2_CONTEXT_PACKET_V2_ENV]);
    if (ceiling === 'off') return 'off';
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
      this.logger.warn(
        'Context Packet tenant canary lookup failed closed (context_packet_canary_lookup_failed)',
      );
      return 'off';
    }
  }

  private async ethicalWallAllowed(req: ContextRequest): Promise<boolean> {
    if (!req.clientId) return false;
    try {
      const run = (tx: Prisma.TransactionClient) =>
        clientMemoryAllowed(tx, req.tenantId, req.userId ?? null, req.clientId as string);
      return req.userId
        ? await this.prisma.withTenantUser(req.tenantId, req.userId, run)
        : await this.prisma.withTenant(req.tenantId, run);
    } catch {
      this.logger.warn(
        'Context Packet ethical-wall lookup failed closed (context_packet_wall_lookup_failed)',
      );
      return false;
    }
  }

  private async loadSteeringRows(
    req: ContextRequest,
    opts: { governed?: boolean } = {},
  ): Promise<SteeringRow[]> {
    const wantsUser = hasLayer(req.layers, 'user-voice') && !!req.userId;
    const wantsClientReq =
      (hasLayer(req.layers, 'client-steering') || hasLayer(req.layers, 'client-people')) &&
      !!req.clientId;
    const wantsFirm =
      hasLayer(req.layers, 'firm-identity') || hasLayer(req.layers, 'firm-playbook');

    const firmTypes = typesForLayers(
      req.layers.filter((layer) => layer === 'firm-identity' || layer === 'firm-playbook'),
    );
    const userTypes = typesForLayers(req.layers.filter((layer) => layer === 'user-voice'));
    const clientTypes = typesForLayers(
      req.layers.filter((layer) => layer === 'client-steering' || layer === 'client-people'),
    );

    const run = async (tx: Prisma.TransactionClient): Promise<SteeringRow[]> => {
      const wantsClient =
        wantsClientReq &&
        (await clientMemoryAllowed(tx, req.tenantId, req.userId ?? null, req.clientId as string));
      const sql = Prisma.sql`
        SELECT id, type, slug, title, client_id AS "clientId", status,
               expires_at AS "expiresAt", updated_at AS "updatedAt",
               last_confirmed_at AS "confirmedAt", provenance AS authority,
               sections_jsonb AS sections
               ${Prisma.raw(opts.governed ? GOVERNED_STEERING_COLUMNS_SQL : '')}
        FROM memory_items
        WHERE (
          (${wantsFirm} AND type = ANY(${firmTypes}) AND slug = 'firm')
          OR (${wantsUser} AND type = ANY(${userTypes})
              AND owner_user_id = ${req.userId ?? null}::uuid)
          OR (${wantsClient} AND type = ANY(${clientTypes})
              AND client_id = ${req.clientId ?? null}::uuid)
        )
        ${Prisma.raw(governedRecallSuppressionSql(governedRecallSuppressionEnabled()))}
        ORDER BY
          CASE type
            WHEN 'firm-soul' THEN 10
            WHEN 'firm-compass' THEN 20
            WHEN 'playbook' THEN 30
            WHEN 'user-voice' THEN 40
            WHEN 'user-profile' THEN 50
            WHEN 'client-soul' THEN 60
            WHEN 'client-compass' THEN 70
            WHEN 'client-people' THEN 80
            ELSE 999
          END ASC,
          CASE status WHEN 'active' THEN 0 WHEN 'superseded' THEN 1 WHEN 'revoked' THEN 2 ELSE 3 END ASC,
          last_confirmed_at DESC NULLS LAST,
          updated_at DESC,
          type ASC,
          slug ASC,
          id ASC
      `;
      return tx.$queryRaw<SteeringRow[]>(sql);
    };

    return req.userId
      ? this.prisma.withTenantUser(req.tenantId, req.userId, run)
      : this.prisma.withTenant(req.tenantId, run);
  }

  private async persistPacket(packet: TruthfulCompiledContextPacket): Promise<string> {
    return this.prisma.withTenant(packet.tenantId, async (tx) => {
      await tx.contextPacket.create({
        data: {
          id: packet.generatedPacketId,
          tenantId: packet.tenantId,
          effectiveTenantId: packet.effectiveTenantId,
          surface: packet.surface,
          userId: packet.userId,
          clientId: packet.clientId,
          ref: sanitizeRef(packet.ref) as Prisma.InputJsonValue,
          items: packet.items as unknown as Prisma.InputJsonValue,
          exclusions: packet.exclusions as unknown as Prisma.InputJsonValue,
          itemCount: packet.items.length,
          exclusionCount: packet.exclusions.length,
          blockChars: packet.rendered.reduce((sum, item) => sum + item.body.length, 0),
          packetHash: packet.traceHash,
          ...contextPacketVersionColumns(packet),
        },
      });
      const verified = await tx.contextPacket.findFirst({
        where: { id: packet.generatedPacketId, tenantId: packet.tenantId },
        select: { id: true },
      });
      if (verified?.id !== packet.generatedPacketId) {
        throw new Error('context_packet_read_after_write_missing');
      }
      return verified.id;
    });
  }

  private async persistShadowComparison(input: {
    tenantId: string;
    comparisonPacketId: string;
    comparison: ContextPacketShadowComparison;
  }): Promise<void> {
    await this.prisma.withTenant(input.tenantId, (tx) =>
      tx.$executeRaw`
        UPDATE context_packet
        SET health_jsonb = COALESCE(health_jsonb, '{}'::jsonb)
            || jsonb_build_object('shadowComparison', ${JSON.stringify(input.comparison)}::jsonb)
        WHERE id = ${input.comparisonPacketId}::uuid AND tenant_id = ${input.tenantId}::uuid
      `,
    );
  }
}

export function contextPacketVersionColumns(
  packet: CompiledContextPacket,
): Partial<Prisma.ContextPacketUncheckedCreateInput> {
  if (packet.version !== 2) return { packetVersion: 1 };
  return {
    packetVersion: 2,
    actorUserId: packet.actorUserId,
    traceId: packet.traceId,
    promptVersion: packet.promptVersion,
    policyVersion: packet.policyVersion,
    compilerVersion: packet.compilerVersion,
    requiredLayers: [...packet.requiredLayers],
    health: packet.health as unknown as Prisma.InputJsonValue,
    totalTokenBudget: packet.totalTokenBudget,
    usedTokens: packet.usedTokens,
    truncated: packet.truncated,
    incomplete: packet.incomplete,
  };
}

function hasLayer(layers: readonly SteeringLayer[], layer: SteeringLayer): boolean {
  return layers.includes(layer);
}

function sanitizeRef(
  ref: Record<string, string | null | undefined>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(ref)) if (value !== undefined) out[key] = value;
  return out;
}
