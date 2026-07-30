import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { MeetingNotesCryptoService } from '../engagement/meeting-notes-crypto.service.js';
import { MemoryStoreService } from './memory-store.service.js';
import { MemoryIngestService } from './memory-ingest.service.js';
import {
  StrictMemoryProjectorService,
  type StrictProjectionExpectation,
  type StrictProjectionReceipt,
} from './strict-memory-projector.service.js';

interface ExactProjectionJob {
  id: string;
  memory_item_id: string | null;
  idempotency_key: string;
  expected_source_version: Date;
  expected_content_hash: string;
}

/**
 * Live request-time projection implementation.
 *
 * The fast path first resolves the exact durable job committed with the source
 * mutation. That job supplies the canonical item ID, source version, content hash,
 * and idempotency key. The inherited best-effort method remains available only as
 * an explicit rollback path.
 */
@Injectable()
export class GovernedMemoryIngestService extends MemoryIngestService {
  constructor(
    private readonly exactPrisma: PrismaService,
    store: MemoryStoreService,
    tenantContext: TenantContextStore,
    notesCrypto: MeetingNotesCryptoService,
    private readonly strictProjector: StrictMemoryProjectorService,
  ) {
    super(exactPrisma, store, tenantContext, notesCrypto);
  }

  async projectClioMemoryStrict(
    tenantId: string,
    clioMemoryId: string,
    expected?: StrictProjectionExpectation,
  ): Promise<StrictProjectionReceipt> {
    return this.strictProjector.projectClioMemoryStrict(tenantId, clioMemoryId, expected);
  }

  override async projectClioMemory(tenantId: string, clioMemoryId: string): Promise<void> {
    const job = await this.loadExactPendingJob(tenantId, clioMemoryId);
    if (!job) throw new Error('memory_projection_exact_job_unavailable');

    const expected: StrictProjectionExpectation = {
      sourceVersion: job.expected_source_version.toISOString(),
      contentHash: job.expected_content_hash,
      memoryItemId: job.memory_item_id,
      idempotencyKey: job.idempotency_key,
    };
    const receipt = await this.projectClioMemoryStrict(tenantId, clioMemoryId, expected);
    this.assertReceiptBinding(receipt, expected);
    await this.completeExactFastPath(job.id, receipt);
  }

  /** Explicit Phase 6 rollback wrapper; never used by live MemoryModule injection. */
  async projectClioMemoryBestEffort(tenantId: string, clioMemoryId: string): Promise<void> {
    await super.projectClioMemory(tenantId, clioMemoryId);
  }

  private async loadExactPendingJob(
    tenantId: string,
    clioMemoryId: string,
  ): Promise<ExactProjectionJob | null> {
    const rows = await this.exactPrisma.withSystem(
      (tx) =>
        tx.$queryRaw<ExactProjectionJob[]>`
          SELECT id::text AS id,
                 memory_item_id::text AS memory_item_id,
                 idempotency_key,
                 expected_source_version,
                 expected_content_hash
          FROM memory_cleanup_outbox
          WHERE tenant_id = ${tenantId}::uuid
            AND clio_memory_id = ${clioMemoryId}::uuid
            AND operation = 'index_memory_item'
            AND status IN ('pending', 'failed')
            AND expected_source_version IS NOT NULL
            AND expected_content_hash IS NOT NULL
          ORDER BY expected_source_version DESC, created_at DESC
          LIMIT 1
        `,
    );
    return rows[0] ?? null;
  }

  private assertReceiptBinding(
    receipt: StrictProjectionReceipt,
    expected: StrictProjectionExpectation,
  ): void {
    const itemMismatch =
      receipt.outcome !== 'vanished' && receipt.memoryItemId !== (expected.memoryItemId ?? null);
    if (
      receipt.sourceVersion !== expected.sourceVersion ||
      receipt.contentHash !== expected.contentHash ||
      receipt.idempotencyKey !== expected.idempotencyKey ||
      itemMismatch
    ) {
      throw new Error('memory_projection_receipt_binding_mismatch');
    }
  }

  private async completeExactFastPath(
    jobId: string,
    receipt: StrictProjectionReceipt,
  ): Promise<void> {
    const sourceVersion = receipt.sourceVersion;
    const contentHash = receipt.contentHash;
    const idempotencyKey = receipt.idempotencyKey;
    if (!sourceVersion || !contentHash || !idempotencyKey) {
      throw new Error('memory_projection_receipt_incomplete');
    }

    const status = receipt.outcome === 'superseded' ? 'superseded' : 'completed';
    await this.exactPrisma.withSystem(
      (tx) =>
        tx.$executeRaw`
          UPDATE memory_cleanup_outbox
          SET status = ${status},
              completed_at = ${status === 'completed' ? new Date() : null},
              superseded_at = ${status === 'superseded' ? new Date() : null},
              last_error = ${status === 'superseded' ? 'source_advanced' : null},
              lease_owner = NULL,
              lease_expires_at = NULL
          WHERE id = ${jobId}::uuid
            AND tenant_id = ${receipt.tenantId}::uuid
            AND clio_memory_id = ${receipt.clioMemoryId}::uuid
            AND operation = 'index_memory_item'
            AND idempotency_key = ${idempotencyKey}
            AND expected_source_version = ${new Date(sourceVersion)}
            AND expected_content_hash = ${contentHash}
            AND status IN ('pending', 'failed')
        `,
    );
  }
}
