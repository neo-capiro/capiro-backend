import { Body, Controller, Get, Header, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../auth/tenant.guard.js';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { HearingWatchFeatureGuard } from '../../feature-flags/hearing-watch-feature.guard.js';
import { PublicHearingAudioAccessService } from './public-hearing-audio-access.service.js';

@Controller('public-hearings/:hearingId/audio')
@UseGuards(TenantGuard, HearingWatchFeatureGuard)
export class PublicHearingAudioController {
  constructor(private readonly audio: PublicHearingAudioAccessService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  manifest(@CurrentTenant() ctx: WorkspaceTenantContext, @Param('hearingId') id: string) {
    return this.audio.manifest(ctx, id);
  }
  @Post('epochs/:epochId/playback')
  @Header('Cache-Control', 'private, no-store')
  playback(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('hearingId') id: string,
    @Param('epochId') epoch: string,
    @Body() body: { positionMs?: unknown },
  ) {
    return this.audio.playback(ctx, id, epoch, Number(body.positionMs));
  }
}
