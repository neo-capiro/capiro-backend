import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { ContextCompiler } from '@capiro/meriv2-core/context/compiler';
import type {
  CompiledContextPacket,
  ContextRequest,
  ContextStoreAdapter,
  SteeringRow,
} from '@capiro/meriv2-core/context/contract';
import { typesForLayers } from '@capiro/meriv2-core/context/contract';
import { GOVERNED_STEERING_COLUMNS_SQL } from '@capiro/meriv2-core/context/governed-columns';
import { PrismaService } from '../prisma/prisma.service.js';

/** Workspace adapter for the shared deterministic Context Compiler. */
@Injectable()
export class WorkspaceContextCompilerService {
  private readonly logger = new Logger(WorkspaceContextCompilerService.name);
  private readonly compiler: ContextCompiler;

  constructor(private readonly prisma: PrismaService) {
    const adapter: ContextStoreAdapter = {
      loadSteeringRows: (req) => this.loadSteeringRows(req),
      // v2 only. The governed columns come from the UNAPPLIED migration
      // 20260729010000_memory_governance_context_v2, so they must never appear on
      // the v1 read path.
      loadGovernedSteeringRows: (req) => this.loadSteeringRows(req, { governed: true }),
      persistPacket: (packet) => this.persistPacket(packet),
    };
    this.compiler = new ContextCompiler(adapter);
  }

  async compileForClerkOwner(
    req: Omit<ContextRequest, 'userId'>,
    clerkOwnerId?: string,
  ): Promise<CompiledContextPacket> {
    const userId = await this.resolveUserIdByClerkId(clerkOwnerId);
    return this.compiler.compile({ ...req, userId });
  }

  /** Clerk subject → Capiro users.id. Null (not a throw) when it cannot resolve. */
  private async resolveUserIdByClerkId(clerkOwnerId?: string): Promise<string | null> {
    if (!clerkOwnerId) return null;
    try {
      const users = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE clerk_user_id = ${clerkOwnerId} LIMIT 1
      `;
      return users[0]?.id ?? null;
    } catch (error) {
      this.logger.warn(`clerk→user resolution failed (non-fatal): ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Wall decision for a Workspace caller, who is identified by a Clerk subject
   * rather than a Capiro user id. An unresolvable Clerk subject denies, matching
   * `fetchDeniedClientIds`'s treatment of a null user.
   */
  async resolveEthicalWallAllowedForClerkOwner(
    tenantId: string,
    clerkOwnerId: string | undefined,
    clientId: string | null,
  ): Promise<boolean> {
    if (!clientId) return false;
    const userId = await this.resolveUserIdByClerkId(clerkOwnerId);
    return this.resolveEthicalWallAllowed(tenantId, userId, clientId);
  }

  /**
   * Workspace persists the display name, not a client UUID. Resolve an exact,
   * tenant-scoped match before compiling client steering. Zero or ambiguous
   * matches return null rather than guessing a client.
   */
  async resolveClientIdByExactName(tenantId: string, clientName?: string | null): Promise<string | null> {
    const name = clientName?.trim();
    if (!name) return null;
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM clients
        WHERE tenant_id = ${tenantId}::uuid
          AND lower(trim(name)) = lower(trim(${name}))
        ORDER BY id ASC
        LIMIT 2
      `;
    });
    if (rows.length !== 1) {
      this.logger.warn(
        `Workspace client context skipped: exact tenant-scoped name match count was ${rows.length}`,
      );
      return null;
    }
    return rows[0]!.id;
  }

  /**
   * Server-derived ethical-wall decision: may `userId` be shown `clientId`'s
   * confidential memory? (closeout §6, contract change 4.)
   *
   * Fail-closed on every uncertain input — no client, no resolved user, a client
   * id that does not exist in this tenant, or a query error all return `false`.
   * `compileV2` only admits client-scope rows on a literal `true`, so a wrong
   * answer here is the difference between withholding context and leaking a
   * walled client's material into a generated deliverable.
   *
   * The predicate is duplicated in SHAPE, not by import, from the canonical
   * `clientMemoryAllowed` in apps/api/src/memory/memory-wall.helpers.ts —
   * apps/workspace is a separate Nest app with its own Prisma client and cannot
   * import from apps/api. It reads the SAME physical tables (`clients.memory_wall`,
   * `client_memory_access`). Keep the two in sync; the api-side helper is
   * authoritative if they ever disagree.
   */
  async resolveEthicalWallAllowed(
    tenantId: string,
    userId: string | null,
    clientId: string | null,
  ): Promise<boolean> {
    if (!clientId || !userId) return false;
    try {
      const rows = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return tx.$queryRaw<Array<{ allowed: boolean }>>`
          SELECT (NOT c.memory_wall
                  OR EXISTS (
                        SELECT 1 FROM client_memory_access a
                        WHERE a.tenant_id = c.tenant_id
                          AND a.client_id = c.id
                          AND a.user_id = ${userId}::uuid)) AS allowed
            FROM clients c
           WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ${clientId}::uuid
        `;
      });
      // No row = the client does not resolve in this tenant: deny.
      return rows[0]?.allowed === true;
    } catch (error) {
      this.logger.warn(
        `Ethical-wall resolution failed; denying client context: ${(error as Error).message}`,
      );
      return false;
    }
  }

  private async loadSteeringRows(
    req: ContextRequest,
    opts: { governed?: boolean } = {},
  ): Promise<SteeringRow[]> {
    const wantsUser = req.layers.includes('user-voice') && !!req.userId;
    const wantsClient =
      (req.layers.includes('client-steering') || req.layers.includes('client-people')) &&
      !!req.clientId;
    const wantsFirm = req.layers.includes('firm-identity') || req.layers.includes('firm-playbook');

    const firmTypes = typesForLayers(
      req.layers.filter((layer) => layer === 'firm-identity' || layer === 'firm-playbook'),
    );
    const userTypes = typesForLayers(req.layers.filter((layer) => layer === 'user-voice'));
    const clientTypes = typesForLayers(
      req.layers.filter((layer) => layer === 'client-steering' || layer === 'client-people'),
    );

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${req.tenantId}, true)`;
      if (req.userId) {
        await tx.$executeRaw`SELECT set_config('app.current_user', ${req.userId}, true)`;
      }
      return tx.$queryRaw<SteeringRow[]>`
        SELECT id, type, slug, title, client_id AS "clientId", status,
               expires_at AS "expiresAt", updated_at AS "updatedAt",
               last_confirmed_at AS "confirmedAt", provenance::text AS authority,
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
    });
  }

  private async persistPacket(packet: CompiledContextPacket): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${packet.tenantId}, true)`;
      // effective_tenant_id is NOT NULL with no DB default once
      // 20260729010000_memory_governance_context_v2 is applied; this raw INSERT
      // is not typechecked, so omitting it would only fail at runtime. The
      // effective tenant IS the packet tenant here (set_config above), which is
      // the same equality the migration's own backfill uses.
      // packet_version is written EXPLICITLY. It is owned by
      // 20260803010000_engagement_generation_gateway (1 = legacy steering-only
      // trace, 2 = complete Evidence Packet) and its DB default is 2, so omitting
      // it stored every steering trace claiming to be a complete packet. The v2
      // columns below are only non-null for a genuinely compiled v2 packet.
      const v2 = packet.version === 2 ? packet : null;
      await tx.$executeRaw`
        INSERT INTO context_packet
          (id, tenant_id, effective_tenant_id, surface, user_id, client_id,
           ref_jsonb, items_jsonb,
           exclusions_jsonb, item_count, exclusion_count, block_chars, packet_hash,
           packet_version, actor_user_id, trace_id, prompt_version, policy_version,
           compiler_version, required_layers, health_jsonb, total_token_budget,
           used_tokens, truncated, incomplete)
        VALUES
          (${packet.packetId}::uuid, ${packet.tenantId}::uuid,
           ${packet.tenantId}::uuid, ${packet.surface},
           ${packet.userId}::uuid, ${packet.clientId}::uuid,
           ${JSON.stringify(sanitizeRef(packet.ref))}::jsonb,
           ${JSON.stringify(packet.items)}::jsonb,
           ${JSON.stringify(packet.exclusions)}::jsonb,
           ${packet.items.length}, ${packet.exclusions.length},
           ${packet.rendered.reduce((sum, item) => sum + item.body.length, 0)},
           ${packet.traceHash},
           ${v2 ? 2 : 1}, ${packet.actorUserId}::uuid, ${v2?.traceId ?? null},
           ${v2?.promptVersion ?? null}, ${v2?.policyVersion ?? null},
           ${v2?.compilerVersion ?? null},
           ${v2 ? [...v2.requiredLayers] : []}::text[],
           ${JSON.stringify(v2?.health ?? {})}::jsonb,
           ${v2?.totalTokenBudget ?? null}, ${v2?.usedTokens ?? 0},
           ${v2?.truncated ?? false}, ${v2?.incomplete ?? false})
      `;
    });
  }
}

function sanitizeRef(
  ref: Record<string, string | null | undefined>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(ref)) if (value !== undefined) out[key] = value;
  return out;
}
