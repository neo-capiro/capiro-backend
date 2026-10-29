import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { PublishProspectDraftDto } from './dto/prospect-publication.dto.js';
import { ProspectPublicationService } from './prospect-publication.service.js';

@Controller('drafts/:draftId/prospect-publication')
@UseGuards(TenantGuard)
export class ProspectPublicationController {
  constructor(private readonly publications: ProspectPublicationService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  read(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Query('prospectId', ParseUUIDPipe) prospectId: string,
  ) {
    return this.publications.read(ctx.tenantId, draftId, prospectId, ctx.clerkUserId);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  publish(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Body() input: PublishProspectDraftDto,
  ) {
    return this.publications.publish(ctx.tenantId, draftId, ctx.clerkUserId, input);
  }
}
