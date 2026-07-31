import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { memoryGovernanceCenterEnabled } from './memory-governance-center.switch.js';
import {
  MemoryGovernanceReadService,
  type MemoryGovernanceBucket,
} from './memory-governance-read.service.js';
import { MemoryGovernanceActionService } from './memory-governance-action.service.js';

/**
 * Phase 15 Governance Center facade.
 *
 * Read and mutation responsibilities are split so the administration projection
 * cannot become a second writer of canonical memory. Every mutation delegates to
 * the action service, which reloads and locks the canonical row and uses the same
 * authorization and audit collaborators as the existing governed paths.
 */
@Injectable()
export class MemoryGovernanceService {
  constructor(
    private readonly reads: MemoryGovernanceReadService,
    private readonly actions: MemoryGovernanceActionService,
  ) {}

  enabled(): boolean {
    return memoryGovernanceCenterEnabled();
  }

  overview(ctx: TenantContext) {
    return this.reads.overview(ctx);
  }

  listItems(ctx: TenantContext, bucket: MemoryGovernanceBucket, limit?: number) {
    return this.reads.listItems(ctx, bucket, limit);
  }

  getItem(ctx: TenantContext, itemId: string) {
    return this.reads.getItem(ctx, itemId);
  }

  listTransitions(ctx: TenantContext, limit?: number) {
    return this.reads.listTransitions(ctx, limit);
  }

  projectionHealth(ctx: TenantContext) {
    return this.reads.projectionHealth(ctx);
  }

  listClients(ctx: TenantContext) {
    return this.reads.listClients(ctx);
  }

  confirm(ctx: TenantContext, itemId: string) {
    return this.actions.confirm(ctx, itemId);
  }

  markStale(ctx: TenantContext, itemId: string, reason: string) {
    return this.actions.markStale(ctx, itemId, reason);
  }

  revoke(ctx: TenantContext, itemId: string, reason: string) {
    return this.actions.revoke(ctx, itemId, reason);
  }

  secondApprove(ctx: TenantContext, itemId: string) {
    return this.actions.secondApprove(ctx, itemId);
  }

  retryProjection(ctx: TenantContext, jobId: string) {
    return this.actions.retryProjection(ctx, jobId);
  }
}

export type { MemoryGovernanceBucket } from './memory-governance-read.service.js';
