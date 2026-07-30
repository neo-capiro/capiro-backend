import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { embedAndUpsert } from '../embeddings/embedder.js';
import { clioMemoryToItem, type ClioMemoryRow } from './memory-clio-adapter.helpers.js';
import { embeddableText } from './memory-ingest.service.js';
import { MemoryStoreService } from './memory-store.service.js';

export type StrictProjectionResult = 'projected' | 'vanished';

/**
 * Strict projection chokepoint for the scheduled worker.
 *
 * Request-time projection intentionally keeps its historical best-effort contract
 * until Phase 6. The scheduled worker cannot accept swallowed failures or raw
 * provider-error logging, so this service performs the same canonical projection
 * with awaited writes, verifies the exact durable item + embedding hash, and throws
 * only to the worker's bounded/sanitized failure path.
 */
@Injectable()
export class StrictMemoryProjectorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: MemoryStoreService,
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
    const itemId = await this.store.upsertSystem(item);

    if (text.length >= 10) {
      await this.writeEmbedding({
        tenantId,
        clientId: item.clientId,
        ownerUserId: item.ownerUserId,
        sourceId: itemId,
        text,
      });
    }

    // The source can be edited/deleted while network embedding is in flight. Never
    // report an old version complete. A deletion removes the projection this worker
    // just created; an edit retries and lets the newer version's idempotency job win.
    const current = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<Array<{ updated_at: Date }>>`
          SELECT updated_at
          FROM clio_memory
          WHERE id = ${clioMemoryId}::uuid AND tenant_id = ${tenantId}::uuid
          LIMIT 1
        `,
    );
    if (!current[0]) {
      await this.prisma.withSystem(async (tx) => {
        await tx.$executeRaw`
          DELETE FROM context_embeddings
          WHERE source_type = 'memory_item' AND source_id = ${itemId}
        `;
        await tx.$executeRaw`
          DELETE FROM memory_items
          WHERE id = ${itemId}::uuid AND tenant_id = ${tenantId}::uuid
        `;
      });
      return 'vanished';
    }
    if (current[0].updated_at.toISOString() !== normalized.updatedAt) {
      throw new Error('memory_source_changed_during_projection');
    }

    const projected = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id
          FROM memory_items
          WHERE id = ${itemId}::uuid
            AND tenant_id = ${tenantId}::uuid
            AND type = ${item.type}
            AND slug = ${item.slug}
          LIMIT 1
        `,
    );
    if (!projected[0]) throw new Error('memory_projection_missing');

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

  private async writeEmbedding(input: {
    tenantId: string;
    clientId: string | null;
    ownerUserId: string | null;
    sourceId: string;
    text: string;
  }): Promise<void> {
    await embedAndUpsert(this.prisma as never, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      ownerUserId: input.ownerUserId,
      sourceType: 'memory_item',
      sourceId: input.sourceId,
      text: input.text,
      bypassRls: true,
    });
  }
}
