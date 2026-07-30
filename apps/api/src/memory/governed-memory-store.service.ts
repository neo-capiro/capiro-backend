import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { governedMemoryLifecycleEnabled } from './memory-governance-lifecycle.helpers.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import { MemoryStoreService, type MemoryVerbResult } from './memory-store.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';

/**
 * Live MemoryStoreService replacement inside MemoryModule.
 *
 * The inherited implementation remains the rollback path while governed memory is
 * dark. Once armed, correct_memory cannot directly replace shared institutional
 * truth: it returns an honest 202 pending-review response instead.
 */
@Injectable()
export class GovernedMemoryStoreService extends MemoryStoreService {
  constructor(
    prisma: PrismaService,
    tenantCtx: TenantContextStore,
    authz: MemoryAuthorizationService,
    transitionAudit: MemoryTransitionAuditService,
    cleanupOutbox: MemoryCleanupOutboxService,
    private readonly versions: ImmutableMemoryVersionService,
  ) {
    super(prisma, tenantCtx, authz, transitionAudit, cleanupOutbox);
  }

  override async correctMemory(itemId: string, newContent: string): Promise<MemoryVerbResult> {
    if (!governedMemoryLifecycleEnabled(process.env.MEMORY_GOVERNANCE_LIFECYCLE)) {
      return super.correctMemory(itemId, newContent);
    }

    const result = await this.versions.correctForCurrentUser(itemId, newContent);
    if (result.status === 'not_found') return { found: false };
    if (result.status === 'legal_hold') {
      return { found: true, blockedByLegalHold: true, title: result.title };
    }
    if (result.status === 'activated' || result.status === 'duplicate') {
      return { found: true, title: result.title, newItemId: result.memoryItemId };
    }

    throw new HttpException(
      {
        statusCode: HttpStatus.ACCEPTED,
        code: 'memory_pending_review',
        status: 'pending_review',
        message: `Correction to "${result.title}" was submitted for independent review. The active memory is unchanged.`,
        candidateId: result.candidateId,
        activeItemUnchanged: true,
      },
      HttpStatus.ACCEPTED,
    );
  }
}
