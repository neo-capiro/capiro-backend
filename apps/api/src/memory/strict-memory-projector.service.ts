import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { MemoryItem, MemorySection } from './memory.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { embedAndUpsert, normalize } from '../embeddings/embedder.js';
import { clioMemoryToItem, type ClioMemoryRow } from './memory-clio-adapter.helpers.js';
import { MemoryStoreService } from './memory-store.service.js';

export type StrictProjectionOutcome = 'projected' | 'vanished' | 'superseded';

export interface StrictProjectionExpectation {
  sourceVersion: string;
  contentHash: string;
  memoryItemId?: string | null;
  idempotencyKey?: string;
}

export interface StrictProjectionReceipt {
  outcome: StrictProjectionOutcome;
  tenantId: string;
  clioMemoryId: string;
  sourceVersion: string | null;
  contentHash: string | null;
  idempotencyKey: string | null;
  memoryItemId: string | null;
  embeddingRequired: boolean;
}

export interface ProjectionMaterial {
  source: ClioMemoryRow;
  item: MemoryItem;
  text: string;
  sourceVersion: string;
  contentHash: string;
  idempotencyKey: string;
  embeddingRequired: boolean;
}

/** Single canonical text/hash contract shared by projection and verification. */
export function projectionTextForItem(
  item: Pick<MemoryItem, 'title' | 'sections'>,
): string {
  const sectionText = (item.sections ?? [])
    .filter((section) => section.owner === 'human' && section.body?.trim())
    .map((section) => `${section.heading}: ${section.body}`)
    .join('\n');
  return normalize([item.title, sectionText].filter(Boolean).join('\n'));
}

export function projectionContentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function normalizeClioProjectionRow(row: ClioMemoryRow): ClioMemoryRow {
  return {
    ...row,
    createdAt: new Date(row.createdAt as unknown as string).toISOString(),
    updatedAt: new Date(row.updatedAt as unknown as string).toISOString(),
  };
}

export function projectionMaterialForClioRow(row: ClioMemoryRow): ProjectionMaterial {
  const source = normalizeClioProjectionRow(row);
  const item = clioMemoryToItem(source);
  const text = projectionTextForItem(item);
  const sourceVersion = source.updatedAt;
  const contentHash = projectionContentHash(text);
  return {
    source,
    item,
    text,
    sourceVersion,
    contentHash,
    idempotencyKey: `index_memory_item:${source.id}:${sourceVersion}`,
    embeddingRequired: text.length >= 10,
  };
}

/**
 * Strict projection chokepoint for both request-time fast paths and the scheduled worker.
 *
 * The caller may bind the projection to an outbox expectation. A mismatch means the
 * source advanced and the old obligation is safely superseded; it is never treated as
 * completion of the newer obligation.
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
    expected?: StrictProjectionExpectation,
  ): Promise<StrictProjectionReceipt> {
    const source = await this.loadSource(tenantId, clioMemoryId);
    if (!source) {
      return this.receipt('vanished', tenantId, clioMemoryId, expected, null, false);
    }

    const material = projectionMaterialForClioRow(source);
    if (expected && !expectationMatches(expected, material)) {
      return this.receipt(
        'superseded',
        tenantId,
        clioMemoryId,
        expected,
        expected.memoryItemId ?? null,
        material.embeddingRequired,
      );
    }

    const itemId = await this.store.upsertSystem(material.item);
    if (expected?.memoryItemId && expected.memoryItemId !== itemId) {
      throw new Error('memory_projection_item_mismatch');
    }

    if (material.embeddingRequired) {
      await this.writeEmbedding({
        tenantId,
        clientId: material.item.clientId,
        ownerUserId: material.item.ownerUserId,
        sourceId: itemId,
        text: material.text,
      });
    }

    const currentSource = await this.loadSource(tenantId, clioMemoryId);
    if (!currentSource) {
      await this.removeExactProjection(tenantId, itemId);
      return this.receipt(
        'vanished',
        tenantId,
        clioMemoryId,
        material,
        itemId,
        material.embeddingRequired,
      );
    }

    const current = projectionMaterialForClioRow(currentSource);
    if (
      current.sourceVersion !== material.sourceVersion ||
      current.contentHash !== material.contentHash
    ) {
      return this.receipt(
        'superseded',
        tenantId,
        clioMemoryId,
        material,
        itemId,
        material.embeddingRequired,
      );
    }

    await this.verifyCanonicalProjection(tenantId, itemId, material);
    if (material.embeddingRequired) {
      await this.verifyExactEmbedding(tenantId, itemId, material.contentHash);
    }

    return this.receipt(
      'projected',
      tenantId,
      clioMemoryId,
      material,
      itemId,
      material.embeddingRequired,
    );
  }

  private async loadSource(
    tenantId: string,
    clioMemoryId: string,
  ): Promise<ClioMemoryRow | null> {
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
    return rows[0] ?? null;
  }

  private async verifyCanonicalProjection(
    tenantId: string,
    itemId: string,
    material: ProjectionMaterial,
  ): Promise<void> {
    const rows = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<
          Array<{
            id: string;
            title: string;
            sections_jsonb: unknown;
          }>
        >`
          SELECT id::text AS id, title, sections_jsonb
          FROM memory_items
          WHERE id = ${itemId}::uuid
            AND tenant_id = ${tenantId}::uuid
            AND type = ${material.item.type}
            AND slug = ${material.item.slug}
          LIMIT 1
        `,
    );
    const projected = rows[0];
    if (!projected) throw new Error('memory_projection_missing');

    const projectedText = projectionTextForItem({
      title: projected.title,
      sections: asSections(projected.sections_jsonb),
    });
    if (projectionContentHash(projectedText) !== material.contentHash) {
      throw new Error('memory_projection_content_mismatch');
    }
  }

  private async verifyExactEmbedding(
    tenantId: string,
    itemId: string,
    contentHash: string,
  ): Promise<void> {
    const rows = await this.prisma.withSystem(
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
    if (!rows[0]) throw new Error('memory_embedding_missing');
  }

  private async removeExactProjection(tenantId: string, itemId: string): Promise<void> {
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
  }

  private receipt(
    outcome: StrictProjectionOutcome,
    tenantId: string,
    clioMemoryId: string,
    expectation:
      | StrictProjectionExpectation
      | Pick<ProjectionMaterial, 'sourceVersion' | 'contentHash' | 'idempotencyKey'>
      | undefined,
    memoryItemId: string | null,
    embeddingRequired: boolean,
  ): StrictProjectionReceipt {
    const sourceVersion = expectation?.sourceVersion ?? null;
    const contentHash = expectation?.contentHash ?? null;
    return {
      outcome,
      tenantId,
      clioMemoryId,
      sourceVersion,
      contentHash,
      idempotencyKey:
        expectation?.idempotencyKey ??
        (sourceVersion ? `index_memory_item:${clioMemoryId}:${sourceVersion}` : null),
      memoryItemId,
      embeddingRequired,
    };
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

function expectationMatches(
  expected: StrictProjectionExpectation,
  actual: Pick<ProjectionMaterial, 'sourceVersion' | 'contentHash'>,
): boolean {
  return expected.sourceVersion === actual.sourceVersion && expected.contentHash === actual.contentHash;
}

function asSections(value: unknown): MemorySection[] {
  return Array.isArray(value) ? (value as MemorySection[]) : [];
}
