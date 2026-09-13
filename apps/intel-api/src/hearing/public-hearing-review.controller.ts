import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { HearingPublicationService } from './hearing-publication.service.js';
import { object } from '../tracker/reports/report-domain.js';

@Controller('public-hearings/:hearingId/review-context')
@UseGuards(TenantGuard)
export class PublicHearingReviewController {
  constructor(private readonly publications: HearingPublicationService) {}
  @Post()
  open(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('hearingId') hearingId: string,
    @Body() body: unknown,
  ) {
    return this.publications.openPublicReview(
      ctx,
      hearingId,
      String(object(body).kind ?? 'live_update'),
    );
  }
}
