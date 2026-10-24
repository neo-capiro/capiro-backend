import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { GoogleOAuthService } from './google-oauth.service.js';
import { EngagementRuntimeAction } from '../runtime/engagement-runtime-action.decorator.js';

@Controller('engagement/integrations/google')
export class GoogleCallbacksController {
  constructor(private readonly oauth: GoogleOAuthService) {}

  @Get('callback')
  @EngagementRuntimeAction('integration_oauth_callback', { requiresCallbacks: true })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (error) {
      const reason = error === 'access_denied' ? 'access_denied'
        : error === 'cancelled' || error === 'user_cancelled' ? 'cancelled'
        : 'connection_failed';
      res.redirect(
        302,
        `${this.oauth.getSuccessRedirect()}?provider=google_workspace&error=${reason}`,
      );
      return;
    }
    if (!code || !state) {
      res.redirect(302, `${this.oauth.getSuccessRedirect()}?provider=google_workspace&error=connection_failed`);
      return;
    }
    let result: { tenantId: string; connectionId: string };
    try {
      result = await this.oauth.handleCallback({ code, state });
    } catch {
      // Never serialize provider errors, including token-endpoint response
      // bodies. The service's state and ownership refusal remains a failure.
      res.redirect(
        302,
        `${this.oauth.getSuccessRedirect()}?provider=google_workspace&error=connection_failed`,
      );
      return;
    }
    res.redirect(
      302,
      `${this.oauth.getSuccessRedirect()}?provider=google_workspace&connectionId=${encodeURIComponent(result.connectionId)}&connected=1`,
    );
  }
}
