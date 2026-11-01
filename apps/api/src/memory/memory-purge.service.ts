import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { lockMemoryRetentionInTx, retainedMemoryInTx } from './memory-retention-selection.js';

import { memoryReceiptsAreContentFreeInTx } from './memory-receipt-retention.js';

/**
 * Phase 6 — retention / right-to-be-forgotten EXECUTION (master plan gap #7).
 *
 * Client offboarding must remove a client's institutional memory end-to-end
 * across every store that holds it: memory_items (+ their context_embeddings and
 * memory_edges), the clio_memory client-scope rows that project into them,
 * memory_candidate proposals, client_memory_access wall grants and
 * memory_access_grant permissions.
 * The original Meri submission receipt can retain candidate JSONB even after
 * its pending memory_candidate has gone. Its receipt has no client_id, so a
 * client purge cannot safely attribute every retained payload to a client.
 * Execution remains held until the receipt matches the exact content-free
 * shape: removing or renaming candidate alone cannot release the purge. Once
 * a reviewed forward migration establishes that shape, the receipt remains
 * as a suppression marker.
 *
 * Invariants:
 *  - LEGAL HOLD preserves candidates, canonical items and their provenance;
 *    retained items and candidates are reported separately. Revision dependencies
 *    outside this client also retain their sources.
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
      const receiptPayloadDispositionHold = !await memoryReceiptsAreContentFreeInTx(tx, tenantId);
      if (!dryRun && receiptPayloadDispositionHold) {
        throw new ServiceUnavailableException(
          'Client memory purge is held until the Meri receipt has the verified content-free shape.',
        );
      }

      // Row locks cannot prevent a new legal-held item or candidate from being
      // inserted after the held-set read. Serialize source writes for this short
      // offboarding transaction so its clio source and projection cannot be
      // swept while the new held item survives. EXCLUSIVE also waits for an
      // existing SELECT FOR UPDATE before taking the table lock: allowing that
      // writer's ROW SHARE lock would deadlock its later UPDATE against our
      // row-lock wait. Plain reads remain available. The existing transaction
      // timeout bounds lock waits and releases the lock on failure.
      if (!dryRun) await lockMemoryRetentionInTx(tx);

      // Match embedding writers: source rows first, then their projections.
      // Execute deletes only this locked set; dry-run remains read-only.
      const lockedItems = dryRun ? null : await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM memory_items
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
        ORDER BY id FOR UPDATE
      `;
      const lockedIds = lockedItems?.map((row) => row.id);
      const retained = await retainedMemoryInTx(tx, tenantId, clientId);
      const heldItemIds = retained.itemIds;
      const heldClioIds = retained.clioIds;
      const withheld = await tx.$queryRaw<Array<{ items: bigint; candidates: bigint }>>`
        SELECT
          (SELECT count(*) FROM memory_items WHERE tenant_id = ${tenantId}::uuid
            AND client_id = ${clientId}::uuid AND id = ANY(${heldItemIds}::uuid[])) AS items,
          (SELECT count(*) FROM memory_candidate WHERE tenant_id = ${tenantId}::uuid
            AND client_id = ${clientId}::uuid AND id = ANY(${retained.candidateIds}::uuid[])) AS candidates
      `;
      const heldBack = Number(withheld[0]?.items ?? 0);
      const retainedCandidates = Number(withheld[0]?.candidates ?? 0);

      // Selection counts (what a purge would remove) — computed the same way for
      // dry-run and execute so the report is truthful.
      const counts = await this.selectionCounts(tx, tenantId, clientId, retained, lockedIds);
      const result: MemoryPurgeResult = {
        tenantId,
        clientId,
        dryRun,
        heldBack,
        retainedCandidates,
        deleted: counts,
        receiptPayloadDispositionHold,
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
                AND legal_hold = false AND id <> ALL(${heldItemIds}::uuid[])
                AND id = ANY(${lockedIds!}::uuid[])
            )
        `;
        await tx.$executeRaw`
          DELETE FROM memory_items
          WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid AND legal_hold = false
            AND id <> ALL(${heldItemIds}::uuid[])
            AND id = ANY(${lockedIds!}::uuid[])
        `;
        await tx.$executeRaw`
          DELETE FROM clio_memory
          WHERE tenant_id = ${tenantId}::uuid AND scope = 'client' AND client_id = ${clientId}::uuid
            AND id <> ALL(${heldClioIds}::uuid[])
        `;
        await tx.$executeRaw`
          DELETE FROM memory_candidate
          WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
            AND legal_hold = false AND id <> ALL(${retained.candidateIds}::uuid[])
        `;
        await tx.$executeRaw`
          DELETE FROM client_memory_access
          WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
        `;
        await tx.$executeRaw`
          DELETE FROM memory_access_grant
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
            heldBack,
            retainedCandidates,
            selection: { ...counts },
            receiptPayloadDispositionHold,
          } as Prisma.InputJsonObject,
        },
      });

      this.logger.log(
        `memory purge ${dryRun ? '(dry-run) ' : ''}${JSON.stringify(counts)} ` +
          `heldBack=${heldBack} retainedCandidates=${retainedCandidates}`,
      );
      return result;
    });
  }

  private async selectionCounts(
    tx: Prisma.TransactionClient,
    tenantId: string,
    clientId: string,
    retained: Awaited<ReturnType<typeof retainedMemoryInTx>>,
    lockedIds?: string[],
  ): Promise<MemoryPurgeCounts> {
    const { itemIds: heldItemIds, clioIds: heldClioIds, candidateIds } = retained;
    const one = async (sql: Promise<Array<{ n: bigint }>>): Promise<number> =>
      Number((await sql)[0]?.n ?? 0);
    const [memoryItems, embeddings, edges, clioMemory, candidates, grants, accessGrants] = await Promise.all([
      one(tx.$queryRaw`SELECT count(*) AS n FROM memory_items
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid AND legal_hold = false
          AND id <> ALL(${heldItemIds}::uuid[])
          ${lockedIds ? Prisma.sql`AND id = ANY(${lockedIds}::uuid[])` : Prisma.empty}`),
      one(tx.$queryRaw`SELECT count(*) AS n FROM context_embeddings
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
          AND (source_type <> 'memory_item' OR source_id <> ALL(${heldItemIds}::text[]))`),
      one(tx.$queryRaw`SELECT count(*) AS n FROM memory_edges
        WHERE tenant_id = ${tenantId}::uuid AND src_item_id IN (
          SELECT id FROM memory_items WHERE tenant_id = ${tenantId}::uuid
            AND client_id = ${clientId}::uuid AND legal_hold = false
            AND id <> ALL(${heldItemIds}::uuid[])
            ${lockedIds ? Prisma.sql`AND id = ANY(${lockedIds}::uuid[])` : Prisma.empty})`),
      one(tx.$queryRaw`SELECT count(*) AS n FROM clio_memory
        WHERE tenant_id = ${tenantId}::uuid AND scope = 'client' AND client_id = ${clientId}::uuid
          AND id <> ALL(${heldClioIds}::uuid[])`),
      one(tx.$queryRaw`SELECT count(*) AS n FROM memory_candidate
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid
          AND legal_hold = false AND id <> ALL(${candidateIds}::uuid[])`),
      one(tx.$queryRaw`SELECT count(*) AS n FROM client_memory_access
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid`),
      one(tx.$queryRaw`SELECT count(*) AS n FROM memory_access_grant
        WHERE tenant_id = ${tenantId}::uuid AND client_id = ${clientId}::uuid`),
    ]);
    return { memoryItems, embeddings, edges, clioMemory, candidates, grants, accessGrants };
  }
}

export interface MemoryPurgeCounts {
  memoryItems: number;
  embeddings: number;
  edges: number;
  clioMemory: number;
  candidates: number;
  grants: number;
  accessGrants: number;
}

export interface MemoryPurgeResult {
  tenantId: string;
  clientId: string;
  dryRun: boolean;
  /** Canonical items retained for holds or retained candidate provenance. */
  heldBack: number;
  /** Candidate rows retained for holds or dependencies of retained revisions. */
  retainedCandidates: number;
  deleted: MemoryPurgeCounts;
  /** True unless the receipt has the verified content-free table shape. */
  receiptPayloadDispositionHold: boolean;
}
