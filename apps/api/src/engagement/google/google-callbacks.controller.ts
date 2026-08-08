import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
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
      res.redirect(
        302,
        `${this.oauth.getSuccessRedirect()}?provider=google_workspace&error=${encodeURIComponent(error)}`,
      );
      return;
    }
    if (!code || !state) throw new BadRequestException('Missing code or state');
    try {
      const result = await this.oauth.handleCallback({ code, state });
      res.redirect(
        302,
        `${this.oauth.getSuccessRedirect()}?provider=google_workspace&connectionId=${encodeURIComponent(result.connectionId)}&connected=1`,
      );
    } catch (errorValue) {
      const reason =
        errorValue instanceof Error ? errorValue.message : 'Google connection failed';
      res.redirect(
        302,
        `${this.oauth.getSuccessRedirect()}?provider=google_workspace&error=${encodeURIComponent(reason)}`,
      );
    }
  }
}
