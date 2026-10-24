import { BadRequestException, Body, Controller, Get, HttpCode, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MicrosoftGraphSyncService } from './microsoft-graph-sync.service.js';
import { MicrosoftOAuthService } from './microsoft-oauth.service.js';
import { EngagementRuntimeAction } from '../runtime/engagement-runtime-action.decorator.js';

@Controller('engagement/integrations/microsoft')
export class MicrosoftCallbacksController {
  constructor(
    private readonly oauth: MicrosoftOAuthService,
    private readonly graphSync: MicrosoftGraphSyncService,
  ) {}

  @Get('notifications')
  @EngagementRuntimeAction('integration_notification', { requiresCallbacks: true })
  validateGet(@Query('validationToken') validationToken: string | undefined, @Res() res: Response) {
    if (validationToken) return void res.type('text/plain').status(200).send(validationToken);
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

  @Get('callback')
  @EngagementRuntimeAction('integration_oauth_callback', { requiresCallbacks: true })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') _errorDescription: string | undefined,
    @Query('admin_consent') adminConsent: string | undefined,
    @Query('tenant') msTenant: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (error) {
      const reason = error === 'access_denied' ? 'access_denied'
        : error === 'cancelled' || error === 'user_cancelled' ? 'cancelled'
        : 'connection_failed';
      res.redirect(
        302,
        `${this.oauth.getSuccessRedirect()}?provider=microsoft_365&error=${reason}`,
      );
      return;
    }
    if (adminConsent !== undefined || (!code && !state && msTenant)) {
      const granted = adminConsent === 'True' || adminConsent === 'true';
      res.redirect(
        302,
        `${this.oauth.getSuccessRedirect()}?provider=microsoft_365&admin_consent=${granted ? '1' : '0'}`,
      );
      return;
    }
    if (!code || !state) throw new BadRequestException('Missing code or state');
    let result: { tenantId: string; connectionId: string };
    try {
      result = await this.oauth.handleCallback({ code, state });
    } catch {
      // State, ownership and token admission still belong to the service. A
      // refusal is a failure hint only; provider details never enter the URL.
      res.redirect(302, `${this.oauth.getSuccessRedirect()}?provider=microsoft_365&error=connection_failed`);
      return;
    }
    res.redirect(
      302,
      `${this.oauth.getSuccessRedirect()}?provider=microsoft_365&connectionId=${encodeURIComponent(result.connectionId)}&connected=1`,
    );
  }
}
