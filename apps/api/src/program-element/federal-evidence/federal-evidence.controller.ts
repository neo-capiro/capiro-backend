import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { FederalEvidenceReadService } from './federal-evidence-read.service.js';

@Controller('federal-evidence')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class FederalEvidenceController {
  constructor(private readonly reads: FederalEvidenceReadService) {}

  @Get('mentions/:peCode')
  currentMentions(
    @Param('peCode') peCode: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('knownAt') knownAt?: string,
  ) {
    return this.reads.currentQualifiedMentions(peCode, {
      limit: limit === undefined ? undefined : Number(limit),
      cursor,
      knownAt,
    });
  }

  @Get('timeline')
  timeline(
    @Query('peCode') peCode?: string,
    @Query('billId') billId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('knownAt') knownAt?: string,
  ) {
    return this.reads.lifecycleTimeline(
      { peCode, billId },
      { limit: limit === undefined ? undefined : Number(limit), cursor, knownAt },
    );
  }
}
