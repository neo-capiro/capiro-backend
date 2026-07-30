import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ContextPacketRolloutCompiler,
  GOVERNED_STEERING_COLUMNS_SQL,
  MERIV2_CONTEXT_PACKET_V2_ENV,
  STEERING_ORDER_COLUMNS_SQL,
  governedMemoryLifecycleEnabled,
  governedRecallSuppressionSql,
  resolveContextPacketMode,
  resolveTenantContextPacketMode,
  typesForLayers,
  type CompiledContextPacket,
  type ContextPacketRolloutStoreAdapter,
  type ContextPacketShadowComparison,
  type ContextRequest,
  type SteeringLayer,
  type SteeringRow,
  type TruthfulCompiledContextPacket,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';

/** The orchestrator's tenant-scoped Context Compiler and Phase 8 rollout owner. */
@Injectable()
export class OrchestratorContextCompilerService {
  private readonly logger = new Logger(OrchestratorContextCompilerService.name);
  private readonly compiler: ContextPacketRolloutCompiler;

  constructor(private readonly prisma: PrismaService) {
    const adapter: ContextPacketRolloutStoreAdapter = {
      loadSteeringRows: (req) => this.loadSteeringRows(req),
      loadGovernedSteeringRows: (req) => this.loadSteeringRows(req, { governed: true }),
      persistPacket: (packet) => this.persistPacket(packet),
      persistShadowComparison: (input) => this.persistShadowComparison(input),
    };
    this.compiler = new ContextPacketRolloutCompiler(adapter);
  }

  async compile(req: ContextRequest): Promise<CompiledContextPacket> {
    const mode = await this.rolloutMode(req.tenantId, req.surface);
    const ethicalWallAllowed = await this.ethicalWallAllowed(req);
    return this.compiler.compile({ ...req, ethicalWallAllowed }, mode);
  }

  private async rolloutMode(
    tenantId: string,
    surface: ContextRequest['surface'],
  ): Promise<ReturnType<typeof resolveContextPacketMode>> {
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
      this.logger.warn('Context Packet tenant canary lookup failed closed (context_packet_canary_lookup_failed)');
      return 'off';
    }
  }

  private async ethicalWallAllowed(req: ContextRequest): Promise<boolean> {
    if (!req.clientId || !req.userId) return false;
    try {
      const rows = await this.prisma.withTenantUser(req.tenantId, req.userId, (tx) =>
        tx.$queryRaw<Array<{ allowed: boolean }>>`
          SELECT (NOT c.memory_wall
                  OR EXISTS (
                    SELECT 1 FROM client_memory_access a
                    WHERE a.tenant_id = c.tenant_id
                      AND a.client_id = c.id
                      AND a.user_id = ${req.userId}::uuid
                  )) AS allowed
          FROM clients c
          WHERE c.tenant_id = ${req.tenantId}::uuid AND c.id = ${req.clientId}::uuid
        `,
      );
      return rows[0]?.allowed === true;
    } catch {
      this.logger.warn('Context Packet ethical-wall lookup failed closed (context_packet_wall_lookup_failed)');
      return false;
    }
  }

  private async loadSteeringRows(
    req: ContextRequest,
    opts: { governed?: boolean } = {},
  ): Promise<SteeringRow[]> {
    const wantsUser = hasLayer(req.layers, 'user-voice') && !!req.userId;
    const wantsClient =
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

    const sql = Prisma.sql`
      SELECT id, type, slug, title, client_id AS "clientId", status,
             expires_at AS "expiresAt", sections_jsonb AS sections
             ${Prisma.raw(
               opts.governed ? `${GOVERNED_STEERING_COLUMNS_SQL}${STEERING_ORDER_COLUMNS_SQL}` : '',
             )}
      FROM memory_items
      WHERE (
        (${wantsFirm} AND type = ANY(${firmTypes}) AND slug = 'firm')
        OR (${wantsUser} AND type = ANY(${userTypes})
            AND owner_user_id = ${req.userId ?? null}::uuid)
        OR (${wantsClient} AND type = ANY(${clientTypes})
            AND client_id = ${req.clientId ?? null}::uuid)
      )
      ${Prisma.raw(
        governedRecallSuppressionSql(
          governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE),
        ),
      )}
    `;

    return req.userId
      ? this.prisma.withTenantUser(req.tenantId, req.userId, (tx) =>
          tx.$queryRaw<SteeringRow[]>(sql),
        )
      : this.prisma.withTenant(req.tenantId, (tx) => tx.$queryRaw<SteeringRow[]>(sql));
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
