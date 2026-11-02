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

  listItems(
    ctx: TenantContext,
    bucket: MemoryGovernanceBucket,
    limit?: number,
    query?: string,
    cursor?: string,
  ) {
    return this.reads.listItems(ctx, bucket, limit, query, cursor);
  }

  getItem(ctx: TenantContext, itemId: string) {
    return this.reads.getItem(ctx, itemId);
  }

  listTransitions(ctx: TenantContext, limit?: number, cursor?: string) {
    return this.reads.listTransitions(ctx, limit, cursor);
  }

  projectionHealth(ctx: TenantContext) {
    return this.reads.projectionHealth(ctx);
  }

  getProjectionJob(ctx: TenantContext, jobId: string) {
    return this.actions.getProjectionJob(ctx, jobId);
  }

  listClients(ctx: TenantContext) {
    return this.reads.listClients(ctx);
  }

  approve(ctx: TenantContext, itemId: string, reason: string, expectedVersion: string) {
    return this.actions.approve(ctx, itemId, reason, expectedVersion);
  }

  confirm(ctx: TenantContext, itemId: string, expectedVersion: string) {
    return this.actions.confirm(ctx, itemId, expectedVersion);
  }

  markStale(ctx: TenantContext, itemId: string, reason: string, expectedVersion: string) {
    return this.actions.markStale(ctx, itemId, reason, expectedVersion);
  }

  revoke(ctx: TenantContext, itemId: string, reason: string, expectedVersion: string) {
    return this.actions.revoke(ctx, itemId, reason, expectedVersion);
  }

  secondApprove(ctx: TenantContext, itemId: string, expectedVersion: string) {
    return this.actions.secondApprove(ctx, itemId, expectedVersion);
  }

  retryProjection(ctx: TenantContext, jobId: string, expectedVersion: string) {
    return this.actions.retryProjection(ctx, jobId, expectedVersion);
  }
}

export type { MemoryGovernanceBucket } from './memory-governance-read.service.js';
