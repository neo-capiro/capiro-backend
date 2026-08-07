import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsEmail, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../../auth/roles.decorator.js';
import { RolesGuard } from '../../auth/roles.guard.js';
import { CurrentTenant } from '../../tenant/current-tenant.decorator.js';
import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';
import { MicrosoftOAuthService } from './microsoft-oauth.service.js';
import { EngagementRuntimeAction } from '../runtime/engagement-runtime-action.decorator.js';

class StartOAuthDto {
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
export class MicrosoftOAuthController {
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

  // Tear down Graph subscriptions and remove the connection + stored tokens.
  // Ownership (own connections only) is enforced in the service. Mirrors the
  // Google DELETE route; see the service docstring for why it does NOT revoke
  // the Microsoft app grant.
  @Delete(':connectionId')
  @UseGuards(RolesGuard)
  @Roles('standard_user')
  @EngagementRuntimeAction('integration_disconnect')
  disconnect(
    @CurrentTenant() ctx: TenantContext,
    @Param('connectionId') connectionId: string,
  ): Promise<unknown> {
    return this.oauth.disconnect(ctx, connectionId);
  }

  // Returns an authorization URL the browser should navigate to. Called from
  // the integrations UI in response to the user clicking "Connect Microsoft".
  @Post('start')
  @UseGuards(RolesGuard)
  @Roles('standard_user')
  @EngagementRuntimeAction('integration_oauth_start')
  start(@CurrentTenant() ctx: TenantContext, @Body() body: StartOAuthDto) {
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
  ): Promise<unknown> {
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
  ): Promise<unknown> {
    if (!from || !to) {
      throw new BadRequestException('from and to query parameters are required');
    }
    return this.graphSync.syncCalendarWindow(ctx, connectionId, { from, to });
  }

  @Post(':connectionId/subscriptions')
  @UseGuards(RolesGuard)
  @Roles('standard_user')
  @EngagementRuntimeAction('integration_subscription')
  subscriptions(
    @CurrentTenant() ctx: TenantContext,
    @Param('connectionId') connectionId: string,
  ): Promise<unknown> {
    return this.graphSync.configureSubscriptions(ctx, connectionId);
  }

  @Get('notifications')
  @EngagementRuntimeAction('integration_notification', { requiresCallbacks: true })
  validateGet(@Query('validationToken') validationToken: string | undefined, @Res() res: Response) {
    if (validationToken) {
      res.type('text/plain').status(200).send(validationToken);
      return;
    }
    res.status(200).json({ ok: true });
  }

  @Post('notifications')
  @HttpCode(202)
  @EngagementRuntimeAction('integration_notification', { requiresCallbacks: true })
  async notifications(
    @Query('validationToken') validationToken: string | undefined,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    if (validationToken) {
      res.type('text/plain').status(200).send(validationToken);
      return;
    }
    const result = await this.graphSync.handleNotifications(
      body && typeof body === 'object' ? (body as { value?: never[] }) : {},
    );
    res.status(202).json(result);
  }

  // Microsoft redirects the browser here with ?code&state. We exchange the
  // code for tokens, persist them, and bounce the user back to the UI.
  // The route stays under the `/api/engagement/...` global prefix and goes
  // through the same Clerk-aware tenant middleware as every other endpoint.
  @Get('callback')
  @EngagementRuntimeAction('integration_oauth_callback', { requiresCallbacks: true })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Query('admin_consent') adminConsent: string | undefined,
    @Query('tenant') msTenant: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (error) {
      const target = `${this.oauth.getSuccessRedirect()}?provider=microsoft_365&error=${encodeURIComponent(
        errorDescription || error,
      )}`;
      res.redirect(302, target);
      return;
    }
    // Admin-consent return: Microsoft redirects the org admin back here after a
    // tenant-wide admin consent grant with ?admin_consent=True&tenant=<id> and
    // NO code/state (it's not a user auth-code flow). Land on the integrations
    // page with a friendly status instead of throwing "Missing code or state".
    if (adminConsent !== undefined || (!code && !state && msTenant)) {
      const granted = adminConsent === 'True' || adminConsent === 'true';
      const target = `${this.oauth.getSuccessRedirect()}?provider=microsoft_365&admin_consent=${
        granted ? '1' : '0'
      }`;
      res.redirect(302, target);
      return;
    }
    if (!code || !state) {
      throw new BadRequestException('Missing code or state');
    }

    const result = await this.oauth.handleCallback({ code, state });
    const target = `${this.oauth.getSuccessRedirect()}?provider=microsoft_365&connectionId=${encodeURIComponent(
      result.connectionId,
    )}&connected=1`;
    res.redirect(302, target);
  }
}
