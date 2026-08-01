import { ForbiddenException, Injectable } from '@nestjs/common';
// Value import, not `import type`: Nest reads the emitted design:paramtypes
// metadata to inject this constructor parameter. A type-only import is erased at
// compile time, leaving index [2] as a bare Function that MemoryModule cannot
// resolve — which fails the AppModule DI graph and would break API boot. The
// parent GovernedMemoryCandidateService imports it the same way.
import { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import { governedMemoryModeEnabledForTenant } from '@capiro/meriv2-core';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GovernedMemoryCandidateService } from './governed-memory-candidate.service.js';
import { ImmutableMemoryVersionService } from './immutable-memory-version.service.js';
import { MemoryAuthorizationService } from './memory-authorization.service.js';
import type {
  PendingSettingsCandidate,
  SettingsMemoryCandidateInput,
} from './memory-candidate.service.js';
import { MemoryCleanupOutboxService } from './memory-cleanup-outbox.service.js';
import { MemoryIngestService } from './memory-ingest.service.js';
import { SettingsMemoryVersionCandidateService } from './settings-memory-version-candidate.service.js';
import { MemoryTransitionAuditService } from './memory-transition-audit.service.js';
import type { MemoryItemType } from './memory.types.js';

type CandidateActorContext = Pick<TenantContext, 'tenantId' | 'userId' | 'role'>;

/**
 * Final MemoryCandidateService implementation used by MemoryModule.
 *
 * It retains the governed withdrawal/rejection behavior and adds one missing
 * routing rule: edits to an existing shared Settings file are immutable version
 * candidates. Compatibility approval/rejection routes are also redirected so an
 * administrator cannot accidentally send such a candidate through the generic
 * canonical-upsert path. Every new branch remains dark unless the exact tenant is
 * selected by MEMORY_GOVERNANCE_TENANTS.
 */
@Injectable()
export class SettingsAwareMemoryCandidateService extends GovernedMemoryCandidateService {
  constructor(
    prisma: PrismaService,
    memoryIngest: MemoryIngestService,
    config: ConfigService<AppConfig, true>,
    transitionAudit: MemoryTransitionAuditService,
    cleanupOutbox: MemoryCleanupOutboxService,
    authorization: MemoryAuthorizationService,
    private readonly settingsVersions: SettingsMemoryVersionCandidateService,
    private readonly immutableVersions: ImmutableMemoryVersionService,
  ) {
    super(prisma, memoryIngest, config, transitionAudit, cleanupOutbox, authorization);
  }

  override async proposeSettingsSections(
    ctx: CandidateActorContext,
    input: SettingsMemoryCandidateInput,
  ): Promise<PendingSettingsCandidate> {
    if (!settingsVersioningEnabled(ctx.tenantId)) {
      return super.proposeSettingsSections(ctx, input);
    }
    const correction = await this.settingsVersions.proposeExistingCorrection(
      ctx as TenantContext,
      input,
    );
    return correction ?? super.proposeSettingsSections(ctx, input);
  }

  override async findPendingSettingsCandidate(
    tenantId: string,
    viewerUserId: string,
    type: MemoryItemType,
    slug: string,
  ): Promise<PendingSettingsCandidate | null> {
    if (!settingsVersioningEnabled(tenantId)) {
      return super.findPendingSettingsCandidate(tenantId, viewerUserId, type, slug);
    }
    const correction = await this.settingsVersions.findPendingSettingsCorrection(
      tenantId,
      viewerUserId,
      type,
      slug,
    );
    return correction ?? super.findPendingSettingsCandidate(tenantId, viewerUserId, type, slug);
  }

  override async approve(
    tenantId: string,
    candidateId: string,
    approverUserId: string,
    actorContext?: CandidateActorContext,
  ): Promise<{ memoryId: string }> {
    if (
      settingsVersioningEnabled(tenantId) &&
      (await this.settingsVersions.isImmutableVersionCandidate(
        tenantId,
        approverUserId,
        candidateId,
      ))
    ) {
      const ctx = requireActorContext(tenantId, approverUserId, actorContext);
      const result = await this.immutableVersions.approveCandidate(
        ctx as TenantContext,
        candidateId,
      );
      const memoryId = result.memoryItemId ?? result.controllingItemId;
      if (!memoryId) {
        throw new Error('Immutable candidate approval returned no canonical memory item.');
      }
      return { memoryId };
    }
    return super.approve(tenantId, candidateId, approverUserId, actorContext);
  }

  override async reject(
    tenantId: string,
    candidateId: string,
    reviewerUserId: string,
    actorContext?: CandidateActorContext,
  ): Promise<void> {
    if (
      settingsVersioningEnabled(tenantId) &&
      (await this.settingsVersions.isImmutableVersionCandidate(
        tenantId,
        reviewerUserId,
        candidateId,
      ))
    ) {
      const ctx = requireActorContext(tenantId, reviewerUserId, actorContext);
      await this.immutableVersions.rejectCandidate(
        ctx as TenantContext,
        candidateId,
        'Rejected by an independent reviewer through the compatibility review route.',
      );
      return;
    }
    return super.reject(tenantId, candidateId, reviewerUserId, actorContext);
  }
}

function settingsVersioningEnabled(tenantId: string): boolean {
  return governedMemoryModeEnabledForTenant(
    tenantId,
    process.env.MEMORY_GOVERNANCE_LIFECYCLE,
    process.env.MEMORY_GOVERNANCE_TENANTS,
  );
}

function requireActorContext(
  tenantId: string,
  userId: string,
  ctx: CandidateActorContext | undefined,
): CandidateActorContext {
  if (!ctx || ctx.tenantId !== tenantId || ctx.userId !== userId) {
    throw new ForbiddenException('Server-resolved actor context is required for memory review.');
  }
  return ctx;
}
