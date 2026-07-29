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

/** Workspace adapter for the shared deterministic Context Compiler. */
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
      } catch (error) {
        this.logger.warn(`clerk→user resolution failed (non-fatal): ${(error as Error).message}`);
      }
    }
    return this.compiler.compile({ ...req, userId });
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

  private async loadSteeringRows(req: ContextRequest): Promise<SteeringRow[]> {
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
      await tx.$executeRaw`
        INSERT INTO context_packet
          (id, tenant_id, effective_tenant_id, surface, user_id, client_id,
           ref_jsonb, items_jsonb,
           exclusions_jsonb, item_count, exclusion_count, block_chars, packet_hash)
        VALUES
          (${packet.packetId}::uuid, ${packet.tenantId}::uuid,
           ${packet.tenantId}::uuid, ${packet.surface},
           ${packet.userId}::uuid, ${packet.clientId}::uuid,
           ${JSON.stringify(sanitizeRef(packet.ref))}::jsonb,
           ${JSON.stringify(packet.items)}::jsonb,
           ${JSON.stringify(packet.exclusions)}::jsonb,
           ${packet.items.length}, ${packet.exclusions.length},
           ${packet.rendered.reduce((sum, item) => sum + item.body.length, 0)},
           ${packet.traceHash})
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
