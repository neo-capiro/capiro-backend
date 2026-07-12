import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { GoogleOAuthService } from './google-oauth.service.js';
import { GoogleSyncService } from './google-sync.service.js';

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

@Controller('engagement/integrations/google')
export class GoogleOAuthController {
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

  // Mailbox + calendar sync. Like the Microsoft equivalent, a reset-sync can run
  // longer than the default axios timeout; the client gives this call generous
  // headroom and the API returns hasMore so it can be re-run to completion.
  @Post(':connectionId/sync')
  @UseGuards(RolesGuard)
  @Roles('standard_user')
  syncConnection(
    @CurrentTenant() ctx: TenantContext,
    @Param('connectionId') connectionId: string,
    @Query('reset') reset: string | undefined,
    @Query('calendar') calendar: string | undefined,
    @Query('mail') mail: string | undefined,
  ): Promise<unknown> {
    return this.sync.syncConnection(ctx, connectionId, {
      reset: reset === '1' || reset === 'true',
      calendar: calendar === undefined ? undefined : calendar !== '0' && calendar !== 'false',
      mail: mail === undefined ? undefined : mail !== '0' && mail !== 'false',
    });
  }

  // Returns an authorization URL the browser should navigate to. Called from
  // the integrations UI when the user clicks "Connect Google Workspace".
  @Post('start')
  @UseGuards(RolesGuard)
  @Roles('standard_user')
  start(@CurrentTenant() ctx: TenantContext, @Body() body: StartOAuthDto) {
    return this.oauth.start(ctx, body);
  }

  // Google redirects the browser here with ?code&state (or ?error). We exchange
  // the code for tokens, persist them, and bounce the user back to the UI. This
  // route bypasses the Clerk-aware tenant middleware (see bypassPaths in
  // tenant-context.middleware.ts + .exclude() in app.module.ts) because the
  // top-level redirect carries no bearer token — it authenticates via the
  // HMAC-signed `state`, exactly like the Microsoft callback.
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (error) {
      const target = `${this.oauth.getSuccessRedirect()}?provider=google_workspace&error=${encodeURIComponent(
        error,
      )}`;
      res.redirect(302, target);
      return;
    }
    if (!code || !state) {
      throw new BadRequestException('Missing code or state');
    }

    const result = await this.oauth.handleCallback({ code, state });
    const target = `${this.oauth.getSuccessRedirect()}?provider=google_workspace&connectionId=${encodeURIComponent(
      result.connectionId,
    )}&connected=1`;
    res.redirect(302, target);
  }
}
