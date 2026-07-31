import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import {
  MemoryGovernanceService,
  type MemoryGovernanceBucket,
} from './memory-governance.service.js';

const BUCKETS = new Set<MemoryGovernanceBucket>([
  'all',
  'active',
  'review_due',
  'conflicts',
  'history',
]);

/** Administrator-only Phase 15 Governance Center API. */
@Controller('memory/governance')
@UseGuards(RolesGuard)
@Roles('user_admin')
export class MemoryGovernanceController {
  constructor(private readonly governance: MemoryGovernanceService) {}

  @Get()
  overview(@CurrentTenant() ctx: TenantContext) {
    return this.governance.overview(ctx);
  }

  @Get('items')
  listItems(
    @CurrentTenant() ctx: TenantContext,
    @Query('bucket') rawBucket?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const bucket = normalizeBucket(rawBucket);
    return this.governance.listItems(ctx, bucket, normalizeLimit(rawLimit));
  }

  @Get('items/:id')
  getItem(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.governance.getItem(ctx, id);
  }

  @Get('transitions')
  listTransitions(@CurrentTenant() ctx: TenantContext, @Query('limit') rawLimit?: string) {
    return this.governance.listTransitions(ctx, normalizeLimit(rawLimit));
  }

  @Get('projection-health')
  projectionHealth(@CurrentTenant() ctx: TenantContext) {
    return this.governance.projectionHealth(ctx);
  }

  @Post('projection-jobs/:id/retry')
  async retryProjection(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return { ok: true, ...(await this.governance.retryProjection(ctx, id)) };
  }

  @Get('clients')
  listClients(@CurrentTenant() ctx: TenantContext) {
    return this.governance.listClients(ctx);
  }

  @Post('items/:id/confirm')
  async confirm(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return { ok: true, ...(await this.governance.confirm(ctx, id)) };
  }

  @Post('items/:id/mark-stale')
  async markStale(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return { ok: true, ...(await this.governance.markStale(ctx, id, body?.reason ?? '')) };
  }

  @Post('items/:id/revoke')
  async revoke(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return { ok: true, ...(await this.governance.revoke(ctx, id, body?.reason ?? '')) };
  }

  @Post('items/:id/second-approve')
  async secondApprove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return { ok: true, ...(await this.governance.secondApprove(ctx, id)) };
  }
}

export function normalizeMemoryGovernanceBucket(raw: string | undefined): MemoryGovernanceBucket {
  return normalizeBucket(raw);
}

function normalizeBucket(raw: string | undefined): MemoryGovernanceBucket {
  const value = String(raw ?? 'all').trim() as MemoryGovernanceBucket;
  if (!BUCKETS.has(value)) {
    throw new BadRequestException(
      'bucket must be one of: all, active, review_due, conflicts, history.',
    );
  }
  return value;
}

function normalizeLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 100;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 250) {
    throw new BadRequestException('limit must be an integer between 1 and 250.');
  }
  return value;
}
