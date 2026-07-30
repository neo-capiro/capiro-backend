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

export interface CanonicalProjectionSnapshot {
  id: string;
  clientId: string | null;
  ownerUserId: string | null;
  title: string;
  sections: MemorySection[];
  text: string;
  contentHash: string;
  embeddingRequired: boolean;
}

/** Single canonical text/hash contract shared by producers, projection, and verification. */
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

export function canonicalProjectionSnapshot(input: {
  id: string;
  clientId: string | null;
  ownerUserId: string | null;
  title: string;
  sections: unknown;
}): CanonicalProjectionSnapshot {
  const sections = asSections(input.sections);
  const text = projectionTextForItem({ title: input.title, sections });
  return {
    id: input.id,
    clientId: input.clientId,
    ownerUserId: input.ownerUserId,
    title: input.title,
    sections,
    text,
    contentHash: projectionContentHash(text),
    embeddingRequired: text.length >= 10,
  };
}

/**
 * Strict projection chokepoint for both request-time fast paths and the scheduled worker.
 *
 * Governed activations bind to their already-created authoritative memory_item ID;
 * compatibility saves without one project the stable clio:<id> item. In both cases,
 * completion requires the exact source version, canonical content hash, item ID, and
 * embedding hash represented by the outbox job.
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

    const clioMaterial = projectionMaterialForClioRow(source);
    if (expected && expected.sourceVersion !== clioMaterial.sourceVersion) {
      return this.receipt(
        'superseded',
        tenantId,
        clioMemoryId,
        expected,
        expected.memoryItemId ?? null,
        false,
      );
    }

    const target = expected?.memoryItemId
      ? await this.loadCanonicalSnapshot(tenantId, expected.memoryItemId)
      : null;
    if (expected?.memoryItemId && !target) {
      throw new Error('memory_projection_missing');
    }

    const contentHash = target?.contentHash ?? clioMaterial.contentHash;
    const text = target?.text ?? clioMaterial.text;
    const embeddingRequired = target?.embeddingRequired ?? clioMaterial.embeddingRequired;
    if (expected && expected.contentHash !== contentHash) {
      return this.receipt(
        'superseded',
        tenantId,
        clioMemoryId,
        expected,
        expected.memoryItemId ?? null,
        embeddingRequired,
      );
    }

    const itemId = target ? target.id : await this.store.upsertSystem(clioMaterial.item);
    if (expected?.memoryItemId && expected.memoryItemId !== itemId) {
      throw new Error('memory_projection_item_mismatch');
    }

    if (embeddingRequired) {
      await this.writeEmbedding({
        tenantId,
        clientId: target?.clientId ?? clioMaterial.item.clientId,
        ownerUserId: target?.ownerUserId ?? clioMaterial.item.ownerUserId,
        sourceId: itemId,
        text,
      });
    }

    const currentSource = await this.loadSource(tenantId, clioMemoryId);
    if (!currentSource) {
      if (!expected?.memoryItemId) {
        await this.removeExactProjection(tenantId, itemId);
      }
      return this.receipt(
        'vanished',
        tenantId,
        clioMemoryId,
        expected ?? clioMaterial,
        itemId,
        embeddingRequired,
      );
    }

    const currentVersion = normalizeClioProjectionRow(currentSource).updatedAt;
    if (currentVersion !== clioMaterial.sourceVersion) {
      return this.receipt(
        'superseded',
        tenantId,
        clioMemoryId,
        expected ?? clioMaterial,
        itemId,
        embeddingRequired,
      );
    }

    const projected = await this.loadCanonicalSnapshot(tenantId, itemId);
    if (!projected) throw new Error('memory_projection_missing');
    if (projected.contentHash !== contentHash) {
      if (expected) {
        return this.receipt(
          'superseded',
          tenantId,
          clioMemoryId,
          expected,
          itemId,
          embeddingRequired,
        );
      }
      throw new Error('memory_projection_content_mismatch');
    }

    if (embeddingRequired) {
      await this.verifyExactEmbedding(tenantId, itemId, contentHash);
    }

    return this.receipt(
      'projected',
      tenantId,
      clioMemoryId,
      expected ?? clioMaterial,
      itemId,
      embeddingRequired,
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

  private async loadCanonicalSnapshot(
    tenantId: string,
    itemId: string,
  ): Promise<CanonicalProjectionSnapshot | null> {
    const rows = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<
          Array<{
            id: string;
            client_id: string | null;
            owner_user_id: string | null;
            title: string;
            sections_jsonb: unknown;
          }>
        >`
          SELECT id::text AS id, client_id::text AS client_id,
                 owner_user_id::text AS owner_user_id, title, sections_jsonb
          FROM memory_items
          WHERE id = ${itemId}::uuid AND tenant_id = ${tenantId}::uuid
          LIMIT 1
        `,
    );
    const row = rows[0];
    return row
      ? canonicalProjectionSnapshot({
          id: row.id,
          clientId: row.client_id,
          ownerUserId: row.owner_user_id,
          title: row.title,
          sections: row.sections_jsonb,
        })
      : null;
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

function asSections(value: unknown): MemorySection[] {
  return Array.isArray(value) ? (value as MemorySection[]) : [];
}
