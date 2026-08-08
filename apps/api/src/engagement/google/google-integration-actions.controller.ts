import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsEmail, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { GoogleOAuthService } from './google-oauth.service.js';
import { GoogleSyncService } from './google-sync.service.js';
import { EngagementRuntimeAction } from '../runtime/engagement-runtime-action.decorator.js';

class StartGoogleOAuthDto {
  @IsOptional()
  @IsUUID()
  connectionId?: string;
  @IsOptional()
  @IsEmail()
  accountEmail?: string;
  @IsOptional()
  @IsString()
  @Length(1, 120)
  displayName?: string;
}

@Controller('engagement/integrations/google')
export class GoogleIntegrationActionsController {
  constructor(
    private readonly oauth: GoogleOAuthService,
    private readonly sync: GoogleSyncService,
  ) {}

  @Get('capabilities')
  @UseGuards(RolesGuard)
  @Roles('standard_user')
  capabilities() {
    return this.oauth.capabilities();
  }

  @Post(':connectionId/sync')
  @UseGuards(RolesGuard)
  @Roles('standard_user')
  @EngagementRuntimeAction('integration_sync')
  syncConnection(
    @CurrentTenant() ctx: TenantContext,
    @Param('connectionId') connectionId: string,
    @Query('reset') reset: string | undefined,
    @Query('calendar') calendar: string | undefined,
    @Query('mail') mail: string | undefined,
  ) {
    return this.sync.syncConnection(ctx, connectionId, {
      reset: reset === '1' || reset === 'true',
      calendar: calendar === undefined ? undefined : calendar !== '0' && calendar !== 'false',
      mail: mail === undefined ? undefined : mail !== '0' && mail !== 'false',
    });
  }

  @Delete(':connectionId')
  @UseGuards(RolesGuard)
  @Roles('standard_user')
  @EngagementRuntimeAction('integration_disconnect')
  disconnect(@CurrentTenant() ctx: TenantContext, @Param('connectionId') connectionId: string) {
    return this.oauth.disconnect(ctx, connectionId);
  }

  @Post('start')
  @UseGuards(RolesGuard)
  @Roles('standard_user')
  @EngagementRuntimeAction('integration_oauth_start')
  start(@CurrentTenant() ctx: TenantContext, @Body() body: StartGoogleOAuthDto) {
    return this.oauth.start(ctx, body);
  }
}
