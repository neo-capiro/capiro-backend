import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { clioMemorySlug, clioMemoryToItem, type ClioMemoryRow } from './memory-clio-adapter.helpers.js';
import { embeddableText, MemoryIngestService } from './memory-ingest.service.js';

export type StrictProjectionResult = 'projected' | 'vanished';

/**
 * Failure-aware adapter for the scheduled projection worker.
 *
 * MemoryIngestService.projectClioMemory intentionally preserves the historical
 * request-path contract: it is best effort and never throws. The scheduled worker
 * cannot use a swallowed error as proof of completion, so this adapter invokes that
 * ONE projector and then verifies the exact durable item + expected embedding hash.
 * Phase 6 may migrate request-time callers to a strict method; Phase 5 only gives the
 * out-of-band worker an honest completion signal.
 */
@Injectable()
export class StrictMemoryProjectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: MemoryIngestService,
  ) {}

  async projectClioMemoryStrict(
    tenantId: string,
    clioMemoryId: string,
  ): Promise<StrictProjectionResult> {
    const rows = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<ClioMemoryRow[]>`
          SELECT id, tenant_id AS "tenantId", scope, owner_user_id AS "ownerUserId",
                 client_id AS "clientId", expires_at AS "expiresAt",
                 key, value, source, metadata_jsonb AS metadata,
                 created_at AS "createdAt", updated_at AS "updatedAt"
          FROM clio_memory
          WHERE id = ${clioMemoryId}::uuid AND tenant_id = ${tenantId}::uuid
          LIMIT 1
        `,
    );
    const source = rows[0];
    if (!source) return 'vanished';

    const normalized: ClioMemoryRow = {
      ...source,
      createdAt: new Date(source.createdAt as unknown as string).toISOString(),
      updatedAt: new Date(source.updatedAt as unknown as string).toISOString(),
    };
    const item = clioMemoryToItem(normalized);
    const text = embeddableText(item);

    await this.ingest.projectClioMemory(tenantId, clioMemoryId);

    const projected = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id
          FROM memory_items
          WHERE tenant_id = ${tenantId}::uuid
            AND type = ${item.type}
            AND slug = ${clioMemorySlug(clioMemoryId)}
          LIMIT 1
        `,
    );
    const itemId = projected[0]?.id;
    if (!itemId) throw new Error('memory_projection_missing');

    if (text.length >= 10) {
      const contentHash = createHash('sha256').update(text).digest('hex');
      const embedded = await this.prisma.withSystem(
        (tx) =>
          tx.$queryRaw<Array<{ source_id: string }>>`
            SELECT source_id
            FROM context_embeddings
            WHERE tenant_id = ${tenantId}::uuid
              AND source_type = 'memory_item'
              AND source_id = ${itemId}
              AND content_hash = ${contentHash}
            LIMIT 1
          `,
      );
      if (!embedded[0]) throw new Error('memory_embedding_missing');
    }

    return 'projected';
  }
}
