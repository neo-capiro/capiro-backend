import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import {
  ImmutableMemoryVersionService,
  type MemoryVersionResult,
} from './immutable-memory-version.service.js';

interface VersionContentBody {
  /** Canonical immutable-version API field. */
  newContent?: string;
  /** Governance Center compatibility field. */
  content?: string;
}

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
    @Body() body: VersionContentBody,
  ) {
    const content = versionContent(body);
    return this.present(await this.versions.proposeCorrection(ctx, id, content));
  }

  @Post('items/:id/restores')
  async proposeRestore(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.present(await this.versions.proposeRestore(ctx, id));
  }

  @Post('items/:id/contradictions')
  async proposeContradiction(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: VersionContentBody,
  ) {
    const content = versionContent(body);
    return this.present(await this.versions.proposeContradiction(ctx, id, content));
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
    if (result.status === 'not_found') {
      throw new NotFoundException('Memory item not found.');
    }
    if (result.status === 'legal_hold') {
      throw new ForbiddenException('Memory operation denied: legal_hold');
    }
    if (result.status === 'pending_review') {
      return {
        found: true,
        status: result.status,
        outcome: result.status,
        title: result.title,
        candidateId: result.candidateId,
        activeItemUnchanged: result.activeItemUnchanged,
      };
    }
    return {
      found: true,
      status: result.status,
      outcome: result.status,
      title: result.title,
      memoryItemId: result.memoryItemId,
    };
  }
}

/**
 * The historical API uses `newContent`; the Phase 15 Governance Center shipped
 * `content`. Accept both at the controller boundary and pass one normalized value
 * into the immutable-version service. `newContent` remains authoritative when a
 * caller supplies both, so browser aliases can never override the canonical field.
 */
export function versionContent(body: VersionContentBody | null | undefined): string {
  const value =
    typeof body?.newContent === 'string'
      ? body.newContent
      : typeof body?.content === 'string'
        ? body.content
        : null;
  if (value === null) throw new BadRequestException('newContent is required.');
  return value;
}
