import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ContextCompiler,
  type CompiledContextPacket,
  type ContextRequest,
  type ContextStoreAdapter,
  type SteeringLayer,
  type SteeringRow,
  typesForLayers,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import {
  governedRecallSuppressionEnabled,
  governedRecallSuppressionSql,
} from '../memory/memory-recall-suppression.helpers.js';

/** apps/api adapter for the shared deterministic Context Compiler. */
@Injectable()
export class ContextCompilerService {
  private readonly compiler: ContextCompiler;

  constructor(private readonly prisma: PrismaService) {
    const adapter: ContextStoreAdapter = {
      loadSteeringRows: (req) => this.loadSteeringRows(req),
      persistPacket: (packet) => this.persistPacket(packet),
    };
    this.compiler = new ContextCompiler(adapter);
  }

  compile(req: ContextRequest): Promise<CompiledContextPacket> {
    return this.compiler.compile(req);
  }

  private async loadSteeringRows(req: ContextRequest): Promise<SteeringRow[]> {
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
        FROM memory_items
        WHERE (
          (${wantsFirm} AND type = ANY(${firmTypes}) AND slug = 'firm')
          OR (${wantsUser} AND type = ANY(${userTypes})
              AND owner_user_id = ${req.userId ?? null}::uuid)
          OR (${wantsClient} AND type = ANY(${clientTypes})
              AND client_id = ${req.clientId ?? null}::uuid)
        )
        -- This SELECT has no status predicate: terminal filtering happens in JS in
        -- packages/meriv2-core/src/context/compiler.ts, and only for the LEGACY
        -- 'revoked'/'superseded' values. Pushing governed suppression into SQL is
        -- dark by default (the column does not exist pre-migration).
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

  private async persistPacket(packet: CompiledContextPacket): Promise<void> {
    await this.prisma.withTenant(packet.tenantId, (tx) =>
      tx.contextPacket.create({
        data: {
          id: packet.packetId,
          tenantId: packet.tenantId,
          // context_packet.effective_tenant_id is NOT NULL with no DB default
          // (20260729010000_memory_governance_context_v2). The compiler always
          // runs inside withTenant(packet.tenantId), so the effective tenant IS
          // the packet tenant — the same equality the migration's backfill uses.
          effectiveTenantId: packet.tenantId,
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
        },
      }),
    );
  }
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
