import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Phase 6 — retention / right-to-be-forgotten EXECUTION (master plan gap #7).
 *
 * Client offboarding must remove a client's institutional memory end-to-end
 * across every store that holds it: memory_items (+ their context_embeddings and
 * memory_edges), the clio_memory client-scope rows that project into them,
 * pending memory_candidate proposals, and the client_memory_access wall grants.
 *
 * Invariants:
 *  - LEGAL HOLD is absolute: a memory_item with legal_hold=true (and its
 *    clio source, if any) is NEVER deleted; it is reported as heldBack.
 *  - TENANT-SCOPED: every statement filters tenant_id — a purge in tenant A
 *    can never touch tenant B's identically-keyed client (covered by the spec).
 *  - AUDITED: an audit_logs row records actor, client, dryRun, and counts.
 *  - DRY-RUN FIRST: purgeClient defaults to dryRun (counts only, zero deletes).
 *
 * Runs under withSystem (RLS-bypass, cross-store) like forgetMemory + the
 * nightly cron — the only safe way to touch multiple tenant-scoped tables in
 * one transaction; isolation is enforced by the explicit tenant_id predicates.
 */
@Injectable()
export class MemoryPurgeService {
  private readonly logger = new Logger(MemoryPurgeService.name);

  constructor(private readonly prisma: PrismaService) {}

  async purgeClient(
    tenantId: string,
    clientId: string,
    actor: { userId: string | null; role: string | null },
    opts: { dryRun?: boolean; reason: string },
  ): Promise<MemoryPurgeResult> {
    const dryRun = opts.dryRun !== false; // default TRUE — never delete unless explicit
    return this.prisma.withSystem(async (tx) => {
      // Legal-held memory_items for this client are excluded from every delete;
      // their clio: sources are preserved too.
      const held = await tx.$queryRaw<Array<{ id: string; slug: string }>>`
        SELECT id, slug FROM memory_items
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid AND legal_hold = true
      `;
      const heldItemIds = held.map((h) => h.id);
      const heldClioIds = held
        .map((h) => (h.slug.startsWith('clio:') ? h.slug.slice('clio:'.length) : null))
        .filter((v): v is string => v !== null);

      // Selection counts (what a purge would remove) — computed the same way for
      // dry-run and execute so the report is truthful.
      const counts = await this.selectionCounts(tx, tenantId, clientId, heldItemIds, heldClioIds);
      const result: MemoryPurgeResult = {
        tenantId,
        clientId,
        dryRun,
        heldBack: held.length,
        deleted: counts,
      };

      if (!dryRun) {
        // Order respects FK dependencies (embeddings/edges before items).
        await tx.$executeRaw`
          DELETE FROM context_embeddings
          WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
            AND (source_type <> 'memory_item' OR source_id <> ALL(${heldItemIds}::text[]))
        `;
        await tx.$executeRaw`
          DELETE FROM memory_edges
          WHERE tenant_id = ${tenantId}::uuid
            AND src_item_id IN (
              SELECT id FROM memory_items
              WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
                AND legal_hold = false
            )
        `;
        await tx.$executeRaw`
          DELETE FROM memory_items
          WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid AND legal_hold = false
        `;
        await tx.$executeRaw`
          DELETE FROM clio_memory
          WHERE tenant_id = ${tenantId}::uuid AND scope = 'client' AND client_id = ${clientId}::uuid
            AND id <> ALL(${heldClioIds}::uuid[])
        `;
        await tx.$executeRaw`
          DELETE FROM memory_candidate
          WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
        `;
        await tx.$executeRaw`
          DELETE FROM client_memory_access
          WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
        `;
      }

      await tx.auditLog.create({
        data: {
          tenantId,
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: dryRun ? 'memory.purge_client.dry_run' : 'memory.purge_client',
          entityType: 'client',
          entityId: clientId,
          before: {
            reason: opts.reason,
            heldBack: held.length,
            selection: { ...counts },
          } as Prisma.InputJsonObject,
        },
      });

      this.logger.log(
        `memory purge ${dryRun ? '(dry-run) ' : ''}client ${clientId} tenant ${tenantId}: ` +
          `${JSON.stringify(counts)} heldBack=${held.length}`,
      );
      return result;
    });
  }

  private async selectionCounts(
    tx: Prisma.TransactionClient,
    tenantId: string,
    clientId: string,
    heldItemIds: string[],
    heldClioIds: string[],
  ): Promise<MemoryPurgeCounts> {
    const one = async (sql: Promise<Array<{ n: bigint }>>): Promise<number> =>
      Number((await sql)[0]?.n ?? 0);
    const [memoryItems, embeddings, edges, clioMemory, candidates, grants] = await Promise.all([
      one(tx.$queryRaw`SELECT count(*) AS n FROM memory_items
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid AND legal_hold = false`),
      one(tx.$queryRaw`SELECT count(*) AS n FROM context_embeddings
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
          AND (source_type <> 'memory_item' OR source_id <> ALL(${heldItemIds}::text[]))`),
      one(tx.$queryRaw`SELECT count(*) AS n FROM memory_edges
        WHERE tenant_id = ${tenantId}::uuid AND src_item_id IN (
          SELECT id FROM memory_items WHERE tenant_id = ${tenantId}::uuid
            AND client_id = ${clientId}::uuid AND legal_hold = false)`),
      one(tx.$queryRaw`SELECT count(*) AS n FROM clio_memory
        WHERE tenant_id = ${tenantId}::uuid AND scope = 'client' AND client_id = ${clientId}::uuid
          AND id <> ALL(${heldClioIds}::uuid[])`),
      one(tx.$queryRaw`SELECT count(*) AS n FROM memory_candidate
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid`),
      one(tx.$queryRaw`SELECT count(*) AS n FROM client_memory_access
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid`),
    ]);
    return { memoryItems, embeddings, edges, clioMemory, candidates, grants };
  }
}

export interface MemoryPurgeCounts {
  memoryItems: number;
  embeddings: number;
  edges: number;
  clioMemory: number;
  candidates: number;
  grants: number;
}

export interface MemoryPurgeResult {
  tenantId: string;
  clientId: string;
  dryRun: boolean;
  /** memory_items withheld because legal_hold=true (and their clio sources). */
  heldBack: number;
  deleted: MemoryPurgeCounts;
}
