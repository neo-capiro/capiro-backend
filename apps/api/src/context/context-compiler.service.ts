import { Injectable, Logger } from '@nestjs/common';
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

/**
 * apps/api's Context Compiler v1 (G1, blueprint §4.6.4): the ONE steering-
 * context loader for this app's Meri surfaces (legacy chat, outreach,
 * alert-memo, research), replacing the per-surface memory_items loader copies
 * whose drift caused three production bugs. Pure assembly/tracing lives in
 * @capiro/meriv2-core; this service supplies the app's tenancy discipline:
 *
 *  - user-scoped layers ride `withTenantUser` (BOTH GUCs — the 1C owner-aware
 *    RLS policy hides private user-voice rows without `app.current_user`);
 *    requests with no userId ride `withTenant`.
 *  - the query deliberately does NOT filter on status: the compiler must SEE
 *    superseded/revoked rows to record them as exclusions in the packet trace
 *    (that record is the point of G1).
 *  - the packet trace persists to `context_packet` fire-and-forget; a trace
 *    failure never blocks generation.
 */
@Injectable()
export class ContextCompilerService {
  private readonly logger = new Logger(ContextCompilerService.name);
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
      req.layers.filter((l) => l === 'firm-identity' || l === 'firm-playbook'),
    );
    const userTypes = typesForLayers(req.layers.filter((l) => l === 'user-voice'));
    const clientTypes = typesForLayers(
      req.layers.filter((l) => l === 'client-steering' || l === 'client-people'),
    );

    // The wall check + query run in ONE transaction so the ethical-wall gate is
    // applied app-side here too (defense in depth alongside the wall-aware RLS
    // policy; and the sole enforcement in an env whose capiro_app RLS is not yet
    // hardened, e.g. prod pre-remediation). Client steering loads only when this
    // user may see the client; fail-closed for a walled client / unknown user.
    const run = async (tx: Prisma.TransactionClient): Promise<SteeringRow[]> => {
      const wantsClient =
        wantsClientReq &&
        (await clientMemoryAllowed(tx, req.tenantId, req.userId ?? null, req.clientId as string));
      const sql = Prisma.sql`
        SELECT id, type, slug, title, client_id AS "clientId", status,
               expires_at AS "expiresAt", sections_jsonb AS sections
        FROM memory_items
        WHERE (
          (${wantsFirm} AND type = ANY(${firmTypes}) AND slug = 'firm')
          OR (${wantsUser} AND type = ANY(${userTypes})
              AND owner_user_id = ${req.userId ?? null}::uuid)
          OR (${wantsClient} AND type = ANY(${clientTypes})
              AND client_id = ${req.clientId ?? null}::uuid)
        )
      `;
      return tx.$queryRaw<SteeringRow[]>(sql);
    };

    // withTenantUser whenever a user is known (harmless for tenant-visible
    // rows, required for private ones); withTenant otherwise.
    return req.userId
      ? this.prisma.withTenantUser(req.tenantId, req.userId, run)
      : this.prisma.withTenant(req.tenantId, run);
  }

  private async persistPacket(packet: CompiledContextPacket): Promise<void> {
    try {
      await this.prisma.withTenant(packet.tenantId, (tx) =>
        tx.contextPacket.create({
          data: {
            id: packet.packetId,
            tenantId: packet.tenantId,
            surface: packet.surface,
            userId: packet.userId,
            clientId: packet.clientId,
            ref: sanitizeRef(packet.ref) as Prisma.InputJsonValue,
            items: packet.items as unknown as Prisma.InputJsonValue,
            exclusions: packet.exclusions as unknown as Prisma.InputJsonValue,
            itemCount: packet.items.length,
            exclusionCount: packet.exclusions.length,
            blockChars: packet.rendered.reduce((n, r) => n + r.body.length, 0),
          },
        }),
      );
    } catch (e) {
      // Fail-open by contract: the trace is diagnostics, not the product.
      this.logger.warn(`context_packet trace write failed: ${(e as Error).message}`);
    }
  }
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
