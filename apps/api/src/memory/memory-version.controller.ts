import { BadRequestException, Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import {
  ImmutableMemoryVersionService,
  type MemoryVersionResult,
} from './immutable-memory-version.service.js';

/**
 * Dedicated immutable-version routes. They intentionally do not share the generic
 * /memory/candidates/:id/approve handler, whose canonical upsert is the behavior
 * Phase 4 must prevent for corrections and restores.
 */
@Controller('memory')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class MemoryVersionController {
  constructor(private readonly versions: ImmutableMemoryVersionService) {}

  @Post('items/:id/corrections')
  async proposeCorrection(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { newContent?: string },
  ) {
    if (typeof body?.newContent !== 'string') {
      throw new BadRequestException('newContent is required.');
    }
    return this.present(await this.versions.proposeCorrection(ctx, id, body.newContent));
  }

  @Post('items/:id/restores')
  async proposeRestore(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.present(await this.versions.proposeRestore(ctx, id));
  }

  @Post('items/:id/contradictions')
  async proposeContradiction(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { newContent?: string },
  ) {
    if (typeof body?.newContent !== 'string') {
      throw new BadRequestException('newContent is required.');
    }
    return this.present(await this.versions.proposeContradiction(ctx, id, body.newContent));
  }

  @Post('version-candidates/:id/approve')
  async approve(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return { ok: true, ...(await this.versions.approveCandidate(ctx, id)) };
  }

  @Post('version-candidates/:id/reject')
  async reject(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return {
      ok: true,
      ...(await this.versions.rejectCandidate(ctx, id, body?.reason ?? '')),
    };
  }

  private present(result: MemoryVersionResult) {
    if (result.status === 'not_found') return { found: false };
    if (result.status === 'legal_hold') {
      return { found: true, blockedByLegalHold: true, title: result.title };
    }
    if (result.status === 'pending_review') {
      return {
        found: true,
        status: result.status,
        title: result.title,
        candidateId: result.candidateId,
        activeItemUnchanged: result.activeItemUnchanged,
      };
    }
    return {
      found: true,
      status: result.status,
      title: result.title,
      memoryItemId: result.memoryItemId,
    };
  }
}
