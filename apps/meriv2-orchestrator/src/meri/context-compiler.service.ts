import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ContextCompiler,
  GOVERNED_STEERING_COLUMNS_SQL,
  STEERING_ORDER_COLUMNS_SQL,
  governedMemoryLifecycleEnabled,
  governedRecallSuppressionSql,
  typesForLayers,
  type CompiledContextPacket,
  type ContextRequest,
  type ContextStoreAdapter,
  type SteeringLayer,
  type SteeringRow,
} from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The orchestrator's Context Compiler v1 adapter (G1-b) — the GA-chat twin of
 * apps/api's ContextCompilerService. Same contract, same discipline, this
 * app's PrismaService (which shares apps/api's generated client + DB, exactly
 * like the meriAuditLedger writes):
 *
 *  - user-scoped layers ride `withTenantUser` (both GUCs — the 1C owner-aware
 *    RLS policy hides private user-voice rows otherwise; this is the exact
 *    drift that broke GA-chat voice on 2026-07-12);
 *  - the query does NOT filter on status: superseded/revoked rows must reach
 *    the compiler so the withholding is RECORDED as an exclusion;
 *  - the packet trace persists to `context_packet` fire-and-forget, fail-open.
 */
@Injectable()
export class OrchestratorContextCompilerService {
  private readonly logger = new Logger(OrchestratorContextCompilerService.name);
  private readonly compiler: ContextCompiler;

  constructor(private readonly prisma: PrismaService) {
    const adapter: ContextStoreAdapter = {
      loadSteeringRows: (req) => this.loadSteeringRows(req),
      // v2 only (compileV2 is the sole caller), which is what keeps the governed
      // columns — all added by the UNAPPLIED
      // 20260729010000_memory_governance_context_v2 — off the v1 read path.
      loadGovernedSteeringRows: (req) => this.loadSteeringRows(req, { governed: true }),
      persistPacket: (packet) => this.persistPacket(packet),
    };
    this.compiler = new ContextCompiler(adapter);
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
               opts.governed
                 ? `${GOVERNED_STEERING_COLUMNS_SQL}${STEERING_ORDER_COLUMNS_SQL}`
                 : '',
             )}
      FROM memory_items
      WHERE (
        (${wantsFirm} AND type = ANY(${firmTypes}) AND slug = 'firm')
        OR (${wantsUser} AND type = ANY(${userTypes})
            AND owner_user_id = ${req.userId ?? null}::uuid)
        OR (${wantsClient} AND type = ANY(${clientTypes})
            AND client_id = ${req.clientId ?? null}::uuid)
      )
      -- Governed suppression, dark by default (MEMORY_GOVERNANCE_LIFECYCLE). Like
      -- apps/api's twin this SELECT has no status predicate of its own; terminal
      -- filtering happens in JS in meriv2-core's compiler and only for the LEGACY
      -- 'revoked'/'superseded' values. The predicate is the SHARED one from
      -- meriv2-core so the two adapters cannot drift apart.
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

  private async persistPacket(packet: CompiledContextPacket): Promise<void> {
    try {
      await this.prisma.withTenant(packet.tenantId, (tx) =>
        tx.contextPacket.create({
          data: {
            id: packet.packetId,
            tenantId: packet.tenantId,
            // context_packet.effective_tenant_id is NOT NULL with no DB default
            // (20260729010000_memory_governance_context_v2). This trace write is
            // fire-and-forget, so a NOT NULL violation here would be swallowed
            // into a warn log and silently cost every packet trace.
            effectiveTenantId: packet.tenantId,
            surface: packet.surface,
            userId: packet.userId,
            clientId: packet.clientId,
            ref: sanitizeRef(packet.ref) as Prisma.InputJsonValue,
            items: packet.items as unknown as Prisma.InputJsonValue,
            exclusions: packet.exclusions as unknown as Prisma.InputJsonValue,
            itemCount: packet.items.length,
            exclusionCount: packet.exclusions.length,
            blockChars: packet.rendered.reduce((n, r) => n + r.body.length, 0),
            ...contextPacketVersionColumns(packet),
          },
        }),
      );
    } catch (e) {
      this.logger.warn(`context_packet trace write failed: ${(e as Error).message}`);
    }
  }
}

/**
 * The v2 provenance columns, written ONLY for a genuinely compiled v2 packet — the
 * exact twin of apps/api's `contextPacketVersionColumns`.
 *
 * `packet_version` is owned by `20260803010000_engagement_generation_gateway`
 * (1 = legacy steering-only trace, 2 = complete Evidence Packet) and defaults to 2,
 * so every steering trace has been stored claiming to be a complete packet. Writing
 * it explicitly per compiled contract makes each row honest. No existing row is
 * rewritten.
 */
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

/** Drop undefined values (Prisma Json columns reject them). */
function sanitizeRef(
  ref: Record<string, string | null | undefined>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(ref)) if (v !== undefined) out[k] = v;
  return out;
}
