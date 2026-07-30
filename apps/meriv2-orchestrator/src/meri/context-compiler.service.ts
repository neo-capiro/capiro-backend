import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  TruthfulContextCompiler,
  GOVERNED_STEERING_COLUMNS_SQL,
  STEERING_ORDER_COLUMNS_SQL,
  governedMemoryLifecycleEnabled,
  governedRecallSuppressionSql,
  typesForLayers,
  type CompiledContextPacket,
  type ContextRequest,
  type SteeringLayer,
  type SteeringRow,
  type TruthfulCompiledContextPacket,
  type TruthfulContextStoreAdapter,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';

/** The orchestrator's tenant-scoped Context Compiler adapter. */
@Injectable()
export class OrchestratorContextCompilerService {
  private readonly compiler: TruthfulContextCompiler;

  constructor(private readonly prisma: PrismaService) {
    const adapter: TruthfulContextStoreAdapter = {
      loadSteeringRows: (req) => this.loadSteeringRows(req),
      loadGovernedSteeringRows: (req) => this.loadSteeringRows(req, { governed: true }),
      persistPacket: (packet) => this.persistPacket(packet),
    };
    this.compiler = new TruthfulContextCompiler(adapter);
  }

  compile(req: ContextRequest): Promise<CompiledContextPacket> {
    return this.compiler.compile(req);
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
      req.layers.filter((l) => l === 'firm-identity' || l === 'firm-playbook'),
    );
    const userTypes = typesForLayers(req.layers.filter((l) => l === 'user-voice'));
    const clientTypes = typesForLayers(
      req.layers.filter((l) => l === 'client-steering' || l === 'client-people'),
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
          blockChars: packet.rendered.reduce((n, r) => n + r.body.length, 0),
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
  for (const [k, v] of Object.entries(ref)) if (v !== undefined) out[k] = v;
  return out;
}
