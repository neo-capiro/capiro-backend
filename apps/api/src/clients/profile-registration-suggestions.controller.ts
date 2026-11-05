import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantContext } from '@capiro/shared';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { ProfileRegistrationSuggestionsService } from './profile-registration-suggestions.service.js';
import { withProfilePreviewAbort } from './profile-preview-abort.js';

@Controller('clients/profile-build')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ProfileRegistrationSuggestionsController {
  constructor(private readonly suggestions: ProfileRegistrationSuggestionsService) {}
  @Post('registration-suggestions')
  @HttpCode(200)
  suggest(@CurrentTenant() ctx: TenantContext, @Body() body: unknown, @Req() request: Request) {
    return withProfilePreviewAbort(request, (signal) =>
      this.suggestions.suggest(ctx, body, signal),
    );
  }
}
