import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsEmail, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';
import { MicrosoftOAuthService } from './microsoft-oauth.service.js';
import { EngagementRuntimeAction } from '../runtime/engagement-runtime-action.decorator.js';

class StartMicrosoftOAuthDto {
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

@Controller('engagement/integrations/microsoft')
export class MicrosoftIntegrationActionsController {
  constructor(
    private readonly oauth: MicrosoftOAuthService,
    private readonly graphSync: MicrosoftGraphSyncService,
  ) {}

  @Get('capabilities')
  @UseGuards(RolesGuard)
  @Roles('standard_user')
  capabilities() {
    return this.oauth.capabilities();
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
  start(@CurrentTenant() ctx: TenantContext, @Body() body: StartMicrosoftOAuthDto) {
    return this.oauth.start(ctx, body);
  }

  @Post(':connectionId/sync')
  @UseGuards(RolesGuard)
  @Roles('standard_user')
  @EngagementRuntimeAction('integration_sync')
  sync(
    @CurrentTenant() ctx: TenantContext,
    @Param('connectionId') connectionId: string,
    @Query('reset') reset: string | undefined,
    @Query('calendar') calendar: string | undefined,
    @Query('mail') mail: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ) {
    return this.graphSync.syncConnection(ctx, connectionId, {
      reset: reset === '1' || reset === 'true',
      calendar: calendar === undefined ? undefined : calendar !== '0' && calendar !== 'false',
      mail: mail === undefined ? undefined : mail !== '0' && mail !== 'false',
      from,
      to,
    });
  }

  @Post(':connectionId/calendar-window')
  @UseGuards(RolesGuard)
  @Roles('standard_user')
  @EngagementRuntimeAction('integration_sync')
  syncCalendarWindow(
    @CurrentTenant() ctx: TenantContext,
    @Param('connectionId') connectionId: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ) {
    if (!from || !to) throw new BadRequestException('from and to query parameters are required');
    return this.graphSync.syncCalendarWindow(ctx, connectionId, { from, to });
  }

  @Post(':connectionId/subscriptions')
  @UseGuards(RolesGuard)
  @Roles('standard_user')
  @EngagementRuntimeAction('integration_subscription')
  subscriptions(@CurrentTenant() ctx: TenantContext, @Param('connectionId') connectionId: string) {
    return this.graphSync.configureSubscriptions(ctx, connectionId);
  }
}
