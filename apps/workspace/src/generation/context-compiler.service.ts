import { Injectable, Logger } from '@nestjs/common';
import { ContextCompiler } from '@capiro/meriv2-core/context/compiler';
import type {
  CompiledContextPacket,
  ContextRequest,
  ContextStoreAdapter,
  SteeringRow,
} from '@capiro/meriv2-core/context/contract';
import { typesForLayers } from '@capiro/meriv2-core/context/contract';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The workspace's Context Compiler v1 adapter (G1-c) — same shared contract as
 * apps/api and the orchestrator, with THIS app's constraints:
 *
 *  - the workspace Prisma client covers only ws_* models, so both the steering
 *    query and the context_packet trace write are raw SQL against the shared
 *    Aurora DB;
 *  - there is no withTenant()/withTenantUser() helper here — the transaction
 *    sets BOTH GUCs itself (`app.current_tenant` always, `app.current_user`
 *    when an owner is known). Missing the user GUC silently hides private
 *    user-voice rows under the 1C owner-aware RLS policy, and casting a Clerk
 *    id to ::uuid killed this app's whole steering query until PR #442 — both
 *    failure modes are exactly why the query now lives in ONE place;
 *  - ws_* stores CLERK identities, so `compileForClerkOwner` resolves
 *    clerk_user_id → users.id before building the ContextRequest (the contract
 *    carries only Capiro uuids).
 *
 * Imports use the zod-free `@capiro/meriv2-core/context/*` SUBPATHS — the
 * package barrel pulls zod, which this app's jest resolver cannot handle
 * (same discipline as the Phase 3.1 grounding imports).
 */
@Injectable()
export class WorkspaceContextCompilerService {
  private readonly logger = new Logger(WorkspaceContextCompilerService.name);
  private readonly compiler: ContextCompiler;

  constructor(private readonly prisma: PrismaService) {
    const adapter: ContextStoreAdapter = {
      loadSteeringRows: (req) => this.loadSteeringRows(req),
      persistPacket: (packet) => this.persistPacket(packet),
    };
    this.compiler = new ContextCompiler(adapter);
  }

  /**
   * Compile with a CLERK owner id (ws_draft.ownerId). Resolves the Capiro
   * users.id first; an unknown/absent owner simply compiles without
   * user-scoped layers (firm identity still loads).
   */
  async compileForClerkOwner(
    req: Omit<ContextRequest, 'userId'>,
    clerkOwnerId?: string,
  ): Promise<CompiledContextPacket> {
    let userId: string | null = null;
    if (clerkOwnerId) {
      try {
        const users = await this.prisma.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM users WHERE clerk_user_id = ${clerkOwnerId} LIMIT 1
        `;
        userId = users[0]?.id ?? null;
      } catch (e) {
        this.logger.warn(`clerk→user resolution failed (non-fatal): ${(e as Error).message}`);
      }
    }
    return this.compiler.compile({ ...req, userId });
  }

  private async loadSteeringRows(req: ContextRequest): Promise<SteeringRow[]> {
    const wantsUser = req.layers.includes('user-voice') && !!req.userId;
    const wantsClient =
      (req.layers.includes('client-steering') || req.layers.includes('client-people')) &&
      !!req.clientId;
    const wantsFirm = req.layers.includes('firm-identity') || req.layers.includes('firm-playbook');

    const firmTypes = typesForLayers(
      req.layers.filter((l) => l === 'firm-identity' || l === 'firm-playbook'),
    );
    const userTypes = typesForLayers(req.layers.filter((l) => l === 'user-voice'));
    const clientTypes = typesForLayers(
      req.layers.filter((l) => l === 'client-steering' || l === 'client-people'),
    );

    return this.prisma.$transaction(async (tx) => {
      // Parameterized set_config — never string-interpolate GUC values.
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${req.tenantId}, true)`;
      if (req.userId) {
        await tx.$executeRaw`SELECT set_config('app.current_user', ${req.userId}, true)`;
      }
      // No status filter — the compiler must SEE superseded/revoked rows to
      // record them as exclusions (same lock as the other two adapters).
      return tx.$queryRaw<SteeringRow[]>`
        SELECT id, type, slug, title, client_id AS "clientId", status,
               sections_jsonb AS sections
        FROM memory_items
        WHERE (
          (${wantsFirm} AND type = ANY(${firmTypes}) AND slug = 'firm')
          OR (${wantsUser} AND type = ANY(${userTypes})
              AND owner_user_id = ${req.userId ?? null}::uuid)
          OR (${wantsClient} AND type = ANY(${clientTypes})
              AND client_id = ${req.clientId ?? null}::uuid)
        )
      `;
    });
  }

  private async persistPacket(packet: CompiledContextPacket): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        // context_packet is FORCE-RLS'd; the INSERT policy requires the tenant
        // GUC to match the row.
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${packet.tenantId}, true)`;
        await tx.$executeRaw`
          INSERT INTO context_packet
            (id, tenant_id, surface, user_id, client_id, ref_jsonb, items_jsonb,
             exclusions_jsonb, item_count, exclusion_count, block_chars)
          VALUES
            (${packet.packetId}::uuid, ${packet.tenantId}::uuid, ${packet.surface},
             ${packet.userId}::uuid, ${packet.clientId}::uuid,
             ${JSON.stringify(sanitizeRef(packet.ref))}::jsonb,
             ${JSON.stringify(packet.items)}::jsonb,
             ${JSON.stringify(packet.exclusions)}::jsonb,
             ${packet.items.length}, ${packet.exclusions.length},
             ${packet.rendered.reduce((n, r) => n + r.body.length, 0)})
        `;
      });
    } catch (e) {
      // Fail-open by contract: the trace is diagnostics, not the product.
      this.logger.warn(`context_packet trace write failed: ${(e as Error).message}`);
    }
  }
}

/** Drop undefined values before serializing the ref payload. */
function sanitizeRef(
  ref: Record<string, string | null | undefined>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(ref)) if (v !== undefined) out[k] = v;
  return out;
}
