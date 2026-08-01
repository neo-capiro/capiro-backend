import { forwardRef, Inject, HttpException, HttpStatus, Injectable } from '@nestjs/common';
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
 * truth. Pending review and exact-duplicate outcomes are emitted as typed internal
 * signals that the governed Meri-tools adapter converts into honest tool results.
 */
@Injectable()
export class GovernedMemoryStoreService extends MemoryStoreService {
  constructor(
    prisma: PrismaService,
    tenantCtx: TenantContextStore,
    authz: MemoryAuthorizationService,
    transitionAudit: MemoryTransitionAuditService,
    @Inject(forwardRef(() => MemoryCleanupOutboxService))
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
    if (result.status === 'activated') {
      return { found: true, title: result.title, newItemId: result.memoryItemId };
    }
    if (result.status === 'duplicate') {
      throw new HttpException(
        {
          statusCode: 208,
          code: 'memory_duplicate',
          status: 'duplicate',
          message: `No correction was applied to "${result.title}" because the proposed content already controls this scope.`,
          title: result.title,
          memoryItemId: result.memoryItemId,
        },
        208,
      );
    }

    throw new HttpException(
      {
        statusCode: HttpStatus.ACCEPTED,
        code: 'memory_pending_review',
        status: 'pending_review',
        message: `Correction to "${result.title}" was submitted for independent review. The active memory is unchanged.`,
        title: result.title,
        candidateId: result.candidateId,
        activeItemUnchanged: true,
      },
      HttpStatus.ACCEPTED,
    );
  }
}
