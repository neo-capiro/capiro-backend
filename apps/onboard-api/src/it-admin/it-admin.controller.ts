/**
 * IT-admin routes (/onboard-api/it/*). Token-authenticated (the emailed link
 * IS the credential — no Clerk account exists for IT admins, per the Gherkin),
 * except the Microsoft callback which is signed-state-authenticated.
 */
import { Body, Controller, Get, Param, Post, Query, Redirect } from '@nestjs/common';
import { IsIn, IsString } from 'class-validator';
import { ItAdminService } from './it-admin.service.js';

class ConsentUrlDto {
  @IsString()
  @IsIn(['microsoft', 'google'])
  provider!: 'microsoft' | 'google';
}

@Controller('it')
export class ItAdminController {
  constructor(private readonly service: ItAdminService) {}

  @Get('invite/:token')
  invite(@Param('token') token: string) {
    return this.service.getInvite(token);
  }

  @Post('invite/:token/consent-url')
  consentUrl(@Param('token') token: string, @Body() body: ConsentUrlDto) {
    return this.service.buildConsentUrl(token, body.provider);
  }

  /** Entra admin-consent redirect target (registered on the Capiro app). */
  @Get('microsoft/callback')
  @Redirect()
  async microsoftCallback(
    @Query()
    query: {
      state?: string;
      admin_consent?: string;
      tenant?: string;
      error?: string;
      error_description?: string;
    },
  ) {
    const url = await this.service.handleMicrosoftCallback(query);
    return { url, statusCode: 302 };
  }
}
