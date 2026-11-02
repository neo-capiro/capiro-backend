import { Controller, Get, Logger, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { GoogleOAuthService } from './google-oauth.service.js';
import { EngagementRuntimeAction } from '../runtime/engagement-runtime-action.decorator.js';
import { oauthFailureLogDetail } from '../oauth-callback-failure.js';

@Controller('engagement/integrations/google')
export class GoogleCallbacksController {
  private readonly logger = new Logger(GoogleCallbacksController.name);

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
      // A refused consent used to leave no trace at all. The provider's code is
      // the only way to tell a user cancellation from a blocked OAuth client.
      this.logger.warn(`google workspace oauth callback returned provider error=${error} (${reason})`);
      res.redirect(
        302,
        `${this.oauth.getSuccessRedirect()}?provider=google_workspace&error=${reason}`,
      );
      return;
    }
    if (!code || !state) {
      this.logger.warn(
        `google workspace oauth callback arrived without ${!code ? 'a code' : 'state'}; connection not attempted`,
      );
      res.redirect(302, `${this.oauth.getSuccessRedirect()}?provider=google_workspace&error=connection_failed`);
      return;
    }
    let result: { tenantId: string; connectionId: string };
    try {
      result = await this.oauth.handleCallback({ code, state });
    } catch (err) {
      // Never serialize provider errors, including token-endpoint response
      // bodies. The service's state and ownership refusal remains a failure; the
      // scrubbed detail goes to the log so the next attempt is diagnosable.
      this.logger.warn(`google workspace oauth callback failed: ${oauthFailureLogDetail(err)}`);
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
