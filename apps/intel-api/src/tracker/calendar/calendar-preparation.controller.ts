import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentTenant } from '../../auth/current-tenant.decorator.js';
import { TenantGuard } from '../../auth/tenant.guard.js';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { CalendarPreparationService } from './calendar-preparation.service.js';

class CalendarScopeDto {
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) folderIds?: string[];
  @IsOptional() @IsString() @MaxLength(100) clientId?: string;
  @IsOptional() @IsIn(['US', 'FL', 'ALL']) jurisdiction?: string;
  @IsOptional() @IsString() @MaxLength(60) session?: string;
}

@Controller('legiwatch/calendar')
@UseGuards(TenantGuard)
export class CalendarPreparationController {
  constructor(private readonly service: CalendarPreparationService) {}
  @Post('scope') async scope(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Body() input: CalendarScopeDto,
  ) {
    const scoped = await this.service.scope(ctx, input);
    return {
      folders: scoped.folders,
      billIds: scoped.billIds,
      matches: scoped.assignments.map((a) => ({ billId: a.billId, folderId: a.folderId })),
    };
  }
  @Post('events/:id/preparation') prepare(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() input: CalendarScopeDto,
  ) {
    return this.service.prepare(ctx, id, input);
  }
  @Get('preparations/:id/status') status(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.service.snapshotStatus(ctx, id);
  }
}
