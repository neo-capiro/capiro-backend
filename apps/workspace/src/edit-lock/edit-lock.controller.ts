import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { EditLockService } from './edit-lock.service.js';
import { LockActorDto } from './dto/edit-lock.dto.js';

/**
 * Two-sided concurrent-edit lock (Phase 6b, Q-ED-2). DB + polling. All
 * tenant-scoped via TenantGuard; holderId = ctx.clerkUserId. The caller's
 * display name is supplied in the body (the engine doesn't own the user table).
 */
@Controller('drafts/:draftId/lock')
@UseGuards(TenantGuard)
export class EditLockController {
  constructor(private readonly lock: EditLockService) {}

  private nameOf(ctx: WorkspaceTenantContext, dto?: LockActorDto): string {
    return dto?.name?.trim() || ctx.clerkUserId;
  }

  @Get()
  status(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.lock.status(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Post('acquire')
  acquire(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: LockActorDto,
  ) {
    return this.lock.acquire(ctx.tenantId, draftId, ctx.clerkUserId, this.nameOf(ctx, dto));
  }

  @Post('heartbeat')
  heartbeat(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.lock.heartbeat(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Post('release')
  release(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('draftId') draftId: string) {
    return this.lock.release(ctx.tenantId, draftId, ctx.clerkUserId);
  }

  @Post('request')
  request(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: LockActorDto,
  ) {
    return this.lock.request(ctx.tenantId, draftId, ctx.clerkUserId, this.nameOf(ctx, dto));
  }

  @Post('take-over')
  takeOver(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId') draftId: string,
    @Body() dto: LockActorDto,
  ) {
    return this.lock.takeOver(ctx.tenantId, draftId, ctx.clerkUserId, this.nameOf(ctx, dto));
  }
}
