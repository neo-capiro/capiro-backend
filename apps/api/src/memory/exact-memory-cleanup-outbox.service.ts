import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryIngestService } from './memory-ingest.service.js';
import {
  MemoryCleanupOutboxService,
  type CleanupEnqueueInput,
  type DrainableCleanupOperation,
} from './memory-cleanup-outbox.service.js';
import {
  projectionMaterialForClioRow,
  type ProjectionMaterial,
} from './strict-memory-projector.service.js';
import type { ClioMemoryRow } from './memory-clio-adapter.helpers.js';

/**
 * Phase 6 live outbox implementation.
 *
 * Index jobs are bound to the source version and content hash captured in the
 * caller's transaction. The inherited service remains available as the rollback
 * implementation, but the MemoryModule token resolves to this exact implementation.
 */
@Injectable()
export class ExactMemoryCleanupOutboxService extends MemoryCleanupOutboxService {
  private readonly exactLogger = new Logger(ExactMemoryCleanupOutboxService.name);

  constructor(
    private readonly exactPrisma: PrismaService,
    ingest: MemoryIngestService,
  ) {
    super(exactPrisma, ingest);
  }

  override async enqueue(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: CleanupEnqueueInput,
  ): Promise<void> {
    if (input.operation !== 'index_memory_item') {
      await super.enqueue(tx, tenantId, input);
      return;
    }
    if (!input.clioMemoryId) {
      throw new Error('index_memory_item requires clioMemoryId');
    }

    const material = await this.loadExpectedMaterial(tx, tenantId, input.clioMemoryId);
    await tx.$executeRaw`
      INSERT INTO memory_cleanup_outbox (
        tenant_id, memory_item_id, clio_memory_id, operation, idempotency_key,
        expected_source_version, expected_content_hash
      ) VALUES (
        ${tenantId}::uuid,
        ${input.memoryItemId ?? null}::uuid,
        ${input.clioMemoryId}::uuid,
        'index_memory_item',
        ${material.idempotencyKey.slice(0, 192)},
        ${new Date(material.sourceVersion)},
        ${material.contentHash}
      )
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    `;
  }

  /**
   * Index completion is owned by the strict projector receipt and therefore no-ops
   * here. Deletion fast paths retain compatibility but close only the one exact
   * idempotency key; they can no longer complete every job for a Clio row.
   */
  override async markIndexedOnFastPath(
    tenantId: string,
    clioMemoryId: string,
    operation: DrainableCleanupOperation = 'index_memory_item',
  ): Promise<void> {
    if (operation === 'index_memory_item') return;

    const idempotencyKey = `${operation}:${clioMemoryId}`;
    try {
      await this.exactPrisma.withSystem(
        (tx) =>
          tx.$executeRaw`
            UPDATE memory_cleanup_outbox
            SET status = 'completed', completed_at = now(), last_error = NULL
            WHERE tenant_id = ${tenantId}::uuid
              AND clio_memory_id = ${clioMemoryId}::uuid
              AND operation = ${operation}
              AND idempotency_key = ${idempotencyKey}
              AND status IN ('pending', 'failed')
          `,
      );
    } catch (error) {
      this.exactLogger.warn(
        JSON.stringify({
          event: 'memory_cleanup_outbox.fast_path_bookkeeping_failed',
          tenant_id: tenantId,
          clio_memory_id: clioMemoryId,
          operation,
          error_code: boundedErrorCode(error),
        }),
      );
    }
  }

  private async loadExpectedMaterial(
    tx: Prisma.TransactionClient,
    tenantId: string,
    clioMemoryId: string,
  ): Promise<ProjectionMaterial> {
    const rows = await tx.$queryRaw<ClioMemoryRow[]>`
      SELECT id, tenant_id AS "tenantId", scope, owner_user_id AS "ownerUserId",
             client_id AS "clientId", expires_at AS "expiresAt",
             key, value, source, metadata_jsonb AS metadata,
             created_at AS "createdAt", updated_at AS "updatedAt"
      FROM clio_memory
      WHERE id = ${clioMemoryId}::uuid AND tenant_id = ${tenantId}::uuid
      LIMIT 1
    `;
    const source = rows[0];
    if (!source) throw new Error('memory_projection_source_missing_before_enqueue');
    return projectionMaterialForClioRow(source);
  }
}

function boundedErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.name : 'ProjectionBookkeepingError';
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 80) || 'projection_error';
}
