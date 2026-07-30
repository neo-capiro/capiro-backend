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

/**
 * Live request-time projection implementation.
 *
 * `projectClioMemory()` now uses the strict projector and closes only the exact
 * version/hash-bound outbox row described by its receipt. The inherited
 * best-effort method remains exposed under an explicit rollback name.
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
    const receipt = await this.projectClioMemoryStrict(tenantId, clioMemoryId);
    await this.completeExactFastPath(receipt);
  }

  /** Explicit Phase 6 rollback wrapper; never used by live MemoryModule injection. */
  async projectClioMemoryBestEffort(tenantId: string, clioMemoryId: string): Promise<void> {
    await super.projectClioMemory(tenantId, clioMemoryId);
  }

  private async completeExactFastPath(receipt: StrictProjectionReceipt): Promise<void> {
    const sourceVersion = receipt.sourceVersion;
    const contentHash = receipt.contentHash;
    const idempotencyKey = receipt.idempotencyKey;
    if (!sourceVersion || !contentHash || !idempotencyKey) {
      // Source disappeared before a request-time expectation could be established.
      // Leave the durable job untouched; the worker owns its exact expected version.
      return;
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
          WHERE tenant_id = ${receipt.tenantId}::uuid
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
