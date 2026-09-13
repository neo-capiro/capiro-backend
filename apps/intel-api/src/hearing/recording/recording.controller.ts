import { Controller, Get, Param, Post, UseGuards, Header } from '@nestjs/common';
import { TenantGuard } from '../../auth/tenant.guard.js';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { HearingWatchFeatureGuard } from '../../feature-flags/hearing-watch-feature.guard.js';
import { HearingRecordingService } from './recording.service.js';

@Controller('hearings/:sessionId/recording')
@UseGuards(TenantGuard, HearingWatchFeatureGuard)
export class HearingRecordingController {
  constructor(private readonly recordings: HearingRecordingService) {}

  @Get('capability')
  capability(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('sessionId') id: string) {
    return this.recordings.capability(ctx.tenantId, id, ctx.clerkUserId);
  }

  @Post('enable')
  enable(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('sessionId') id: string) {
    return this.recordings.enable(ctx.tenantId, id, ctx.clerkUserId);
  }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  manifest(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('sessionId') id: string) {
    return this.recordings.manifest(ctx.tenantId, id, ctx.clerkUserId);
  }

  @Post('epochs/:epochId/playback')
  @Header('Cache-Control', 'private, no-store')
  playback(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('sessionId') id: string,
    @Param('epochId') epochId: string,
  ) {
    return this.recordings.playback(ctx.tenantId, id, ctx.clerkUserId, epochId);
  }
}
