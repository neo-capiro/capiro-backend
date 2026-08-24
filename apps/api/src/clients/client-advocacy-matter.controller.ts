import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';

class UpdateAdvocacyMatterDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsIn(['open', 'monitoring', 'resolved', 'stalled'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;
}

class MergeAdvocacyMatterDto {
  @IsUUID()
  sourceMatterId!: string;
}

/**
 * Advocacy Matter read/manage surface (product spec: "the central
 * abstraction is an Advocacy Matter"). This is a thin API over
 * `ClientAdvocacyMatterService` — clustering and record/link assignment
 * happen as a side effect of `ClientProfileFillCompletionService.applyFindings`
 * (see that service's `applyAdvocacyRecord`), not here. This controller only
 * lists, reads, edits Matter metadata, and merges two Matters.
 */
@Controller('clients/:clientId/advocacy-matters')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientAdvocacyMatterController {
  constructor(private readonly matters: ClientAdvocacyMatterService) {}

  @Get()
  list(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.matters.listMatters(ctx, clientId);
  }

  @Get(':matterId')
  get(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
  ) {
    return this.matters.getMatter(ctx, clientId, matterId);
  }

  @Patch(':matterId')
  @Roles('user_admin')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
    @Body() body: UpdateAdvocacyMatterDto,
  ) {
    return this.matters.updateMatter(ctx, clientId, matterId, body);
  }

  @Post(':matterId/merge')
  @Roles('user_admin')
  merge(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('matterId') matterId: string,
    @Body() body: MergeAdvocacyMatterDto,
  ) {
    return this.matters.mergeMatters(ctx, clientId, matterId, body.sourceMatterId);
  }
}
