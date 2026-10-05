import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { KrispNotetakerService } from './krisp-notetaker.service.js';

class KrispPreferenceDto {
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsString() @MaxLength(128) folderId?: string | null;
}
class KrispMatchDto {
  @IsUUID() meetingId!: string;
}

@Controller('clio/krisp-notetaker')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class KrispNotetakerController {
  constructor(private readonly service: KrispNotetakerService) {}

  @Get()
  status(@CurrentTenant() ctx: TenantContext) {
    return this.service.status(ctx);
  }

  @Get('folders')
  folders(@CurrentTenant() ctx: TenantContext) {
    return this.service.folders(ctx);
  }

  @Post('preferences')
  configure(@CurrentTenant() ctx: TenantContext, @Body() body: KrispPreferenceDto) {
    return this.service.configure(ctx, body);
  }

  @Get('imports/:id/candidates')
  candidates(@CurrentTenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.candidates(ctx, id);
  }

  @Post('imports/:id/match')
  assign(
    @CurrentTenant() ctx: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: KrispMatchDto,
  ) {
    return this.service.assign(ctx, id, body.meetingId);
  }
}
