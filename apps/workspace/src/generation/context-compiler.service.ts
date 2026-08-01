import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import {
  ContextPacketRolloutCompiler,
  type ContextPacketRolloutStoreAdapter,
  type ContextPacketShadowComparison,
} from '@capiro/meriv2-core/context/context-rollout';
import {
  MERIV2_CONTEXT_PACKET_V2_ENV,
  resolveContextPacketMode,
  resolveTenantContextPacketMode,
} from '@capiro/meriv2-core/context/context-release-switch';
import type {
  CompiledContextPacket,
  ContextRequest,
  SteeringRow,
  TruthfulCompiledContextPacket,
} from '@capiro/meriv2-core/context/contract';
import { typesForLayers } from '@capiro/meriv2-core/context/contract';
import { GOVERNED_STEERING_COLUMNS_SQL } from '@capiro/meriv2-core/context/governed-columns';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  clearContextPersistenceHold,
  markContextPersistenceHold,
} from './context-persistence-hold.js';

/** Workspace adapter and server-owned Phase 8 rollout resolver. */
@Injectable()
export class WorkspaceContextCompilerService {
  private readonly logger = new Logger(WorkspaceContextCompilerService.name);
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

  async compileForClerkOwner(
    req: Omit<ContextRequest, 'userId'>,
    clerkOwnerId?: string,
  ): Promise<CompiledContextPacket> {
    const draftId = typeof req.ref?.draftId === 'string' ? req.ref.draftId : null;
    if (draftId) clearContextPersistenceHold(req.tenantId, draftId);
    const userId = await this.resolveUserIdByClerkId(clerkOwnerId);
    const ethicalWallAllowed = await this.resolveEthicalWallAllowed(
      req.tenantId,
      userId,
      req.clientId ?? null,
    );
    const mode = await this.rolloutMode(req.tenantId, req.surface);
    try {
      return await this.compiler.compile({ ...req, userId, ethicalWallAllowed }, mode);
    } catch (error) {
      if (draftId && isPersistenceError(error)) {
        markContextPersistenceHold(req.tenantId, draftId, error.code);
      }
      throw error;
    }
  }

  private async rolloutMode(
    tenantId: string,
    surface: ContextRequest['surface'],
  ): Promise<ReturnType<typeof resolveContextPacketMode>> {
    const ceiling = resolveContextPacketMode(process.env[MERIV2_CONTEXT_PACKET_V2_ENV]);
    if (ceiling === 'off') return 'off';
    try {
      const rows = await this.prisma.$queryRaw<Array<{ settings: unknown }>>`
        SELECT settings_jsonb AS settings
        FROM tenants
        WHERE id = ${tenantId}::uuid
        LIMIT 1
      `;
      return resolveTenantContextPacketMode(
        process.env[MERIV2_CONTEXT_PACKET_V2_ENV],
        rows[0]?.settings,
        surface,
      );
    } catch {
      this.logger.warn(
        'Context Packet tenant canary lookup failed closed (context_packet_canary_lookup_failed)',
      );
      return 'off';
    }
  }

  private async resolveUserIdByClerkId(clerkOwnerId?: string): Promise<string | null> {
    if (!clerkOwnerId) return null;
    try {
      const users = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM users WHERE clerk_user_id = ${clerkOwnerId} LIMIT 1
      `;
      return users[0]?.id ?? null;
    } catch {
      this.logger.warn(
        'Workspace Clerk identity resolution failed (context_packet_user_resolution_failed)',
      );
      return null;
    }
  }

  async resolveEthicalWallAllowedForClerkOwner(
    tenantId: string,
    clerkOwnerId: string | undefined,
    clientId: string | null,
  ): Promise<boolean> {
    if (!clientId) return false;
    const userId = await this.resolveUserIdByClerkId(clerkOwnerId);
    return this.resolveEthicalWallAllowed(tenantId, userId, clientId);
  }

  async resolveClientIdByExactName(
    tenantId: string,
    clientName?: string | null,
  ): Promise<string | null> {
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
      return rows[0]?.allowed === true;
    } catch {
      this.logger.warn(
        'Workspace ethical-wall lookup failed closed (context_packet_wall_lookup_failed)',
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

  private async persistPacket(packet: TruthfulCompiledContextPacket): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${packet.tenantId}, true)`;
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
          (${packet.generatedPacketId}::uuid, ${packet.tenantId}::uuid,
           ${packet.effectiveTenantId}::uuid, ${packet.surface},
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
      const verified = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id
        FROM context_packet
        WHERE id = ${packet.generatedPacketId}::uuid
          AND tenant_id = ${packet.tenantId}::uuid
        LIMIT 1
      `;
      if (verified[0]?.id !== packet.generatedPacketId) {
        throw new Error('context_packet_read_after_write_missing');
      }
      return verified[0].id;
    });
  }

  private async persistShadowComparison(input: {
    tenantId: string;
    comparisonPacketId: string;
    comparison: ContextPacketShadowComparison;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${input.tenantId}, true)`;
      await tx.$executeRaw`
        UPDATE context_packet
        SET health_jsonb = COALESCE(health_jsonb, '{}'::jsonb)
            || jsonb_build_object('shadowComparison', ${JSON.stringify(input.comparison)}::jsonb)
        WHERE id = ${input.comparisonPacketId}::uuid AND tenant_id = ${input.tenantId}::uuid
      `;
    });
  }
}

function isPersistenceError(error: unknown): error is { code: string } {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (error as { name?: unknown }).name === 'ContextPacketPersistenceError' &&
    typeof (error as { code?: unknown }).code === 'string',
  );
}

function sanitizeRef(
  ref: Record<string, string | null | undefined>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(ref)) if (value !== undefined) out[key] = value;
  return out;
}
